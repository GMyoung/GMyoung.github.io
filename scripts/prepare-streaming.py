"""Prepare versioned HLS VOD video and alternate audio for the karaoke catalog.

Only generated files under --output and streaming metadata in --catalog change.
Original MP4s and aligned M4A soundtracks are never modified. Requires FFmpeg
with libx264 and AAC plus FFprobe; no credentials or environment variables.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import threading


RECIPE = "hls-fmp4-v1-30fps-4sec-aac128"
LEVELS = ((360, 300000, 450000), (720, 850000, 1100000))
AUDIO_NAMES = {"original": "Original vocals", "karaoke": "Karaoke"}
ACTIVE_ENCODERS = set()
ENCODER_LOCK = threading.Lock()
CANCELLED = threading.Event()


@contextmanager
def production_lock(root, output):
    """Prevent two preparation processes from writing the same fragments."""
    folder = root / ".local"
    folder.mkdir(exist_ok=True)
    name = hashlib.sha256(str(output).encode()).hexdigest()[:16]
    with (folder / f"streaming-{name}.lock").open("a+b") as lock:
        lock.seek(0)
        lock.write(b"0")
        lock.flush()
        lock.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def probe(executable, path):
    return json.loads(subprocess.check_output([
        executable, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ], text=True))


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def levels_for(video):
    """Do not inflate already efficient, low-motion source videos."""
    source_bitrate = int(video.get("bit_rate") or 0)
    if 0 < source_bitrate < 220000:
        low = max(120000, round(source_bitrate * 0.8 / 1000) * 1000)
        high = max(160000, round(source_bitrate / 1000) * 1000)
        return ((360, low, round(low * 1.5)), (720, high, round(high * 1.5)))
    return LEVELS


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def playlist_metadata(path):
    text = path.read_text(encoding="utf-8")
    if "#EXT-X-ENDLIST" not in text or "#EXT-X-MAP:" not in text:
        raise ValueError(f"Incomplete fragmented MP4 VOD playlist: {path}")
    segments = []
    duration = None
    for line in text.splitlines():
        if line.startswith("#EXTINF:"):
            duration = float(line.split(":", 1)[1].split(",", 1)[0])
        elif line and not line.startswith("#"):
            segment = path.parent / line
            if duration is None or duration <= 0 or not segment.is_file():
                raise ValueError(f"Missing segment or duration in {path}")
            segments.append((segment, duration))
            duration = None
    init_name = re.search(r'#EXT-X-MAP:URI="([^"]+)"', text).group(1)
    init = path.parent / init_name
    if not init.is_file() or not segments:
        raise ValueError(f"Missing initialization or media segments in {path}")
    seconds = sum(seconds for _, seconds in segments)
    byte_count = sum(segment.stat().st_size for segment, _ in segments)
    return {
        "duration": round(seconds, 6), "segments": len(segments),
        "bytes": byte_count + init.stat().st_size,
        "averageBandwidth": math.ceil(byte_count * 8 / seconds),
        "peakBandwidth": math.ceil(max(segment.stat().st_size * 8 / seconds for segment, seconds in segments)),
        "files": [init.name] + [segment.name for segment, _ in segments],
    }


def encode(args, command, log_path, folder):
    with log_path.open("w", encoding="utf-8") as log:
        with ENCODER_LOCK:
            if CANCELLED.is_set():
                raise RuntimeError("Preparation cancelled")
            process = subprocess.Popen([args.ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "warning"]
                                       + command, cwd=folder, stdout=log, stderr=subprocess.STDOUT)
            ACTIVE_ENCODERS.add(process)
        try:
            result = process.wait()
            if result:
                raise subprocess.CalledProcessError(result, process.args)
        finally:
            with ENCODER_LOCK:
                ACTIVE_ENCODERS.discard(process)


def complete_playlist(path):
    try:
        playlist_metadata(path)
        return True
    except (OSError, ValueError, AttributeError):
        return False


def same_input(folder, signature):
    marker = folder / "source.json"
    try:
        return json.loads(marker.read_text(encoding="utf-8")) == signature
    except (OSError, ValueError):
        return False


def remove_stale_fragments(folder, metadata):
    expected = set(metadata["files"])
    for fragment in folder.glob("segment-*.m4s"):
        if fragment.name not in expected:
            fragment.unlink()


def hls_options(folder):
    return ["-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
            "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_flags", "independent_segments", "-start_number", "0",
            "-hls_segment_filename", str(folder / "segment-%04d.m4s"), str(folder / "index.m3u8")]


def prepare(args, root, entry):
    song_id = entry["id"]
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", song_id):
        raise ValueError(f"Unsafe catalog ID: {song_id}")
    source = (root / entry["url"]).resolve()
    audio_sources = {name: (root / entry["audio"][name]).resolve() for name in AUDIO_NAMES}
    for path in [source, *audio_sources.values()]:
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f"Source must be a local file within the repository: {path}")
    source_info = probe(args.ffprobe, source)
    video = next(stream for stream in source_info["streams"] if stream["codec_type"] == "video")
    duration = float(source_info["format"]["duration"])
    levels = levels_for(video)
    target = args.output / song_id
    target.mkdir(parents=True, exist_ok=True)
    marker = target / "renditions.json"
    signature = {"recipe": RECIPE, "source": fingerprint(source),
                 "audio": {name: fingerprint(path) for name, path in audio_sources.items()},
                 "defaultAudio": entry.get("defaultAudio", "karaoke")}
    if levels != LEVELS:
        signature["lowBitrateLevels"] = [list(level) for level in levels]
    if args.skip_existing and marker.is_file():
        saved = json.loads(marker.read_text(encoding="utf-8"))
        if saved.get("signature") == signature:
            expected = saved.get("outputFiles", {})
            if expected and all((target / name).is_file() and (target / name).stat().st_size == size
                                for name, size in expected.items()):
                print(f"Skipped complete {song_id}", flush=True)
                return song_id, saved
    preparation = target / "preparation.json"
    write_json(preparation, signature)
    print(f"Preparing {song_id}", flush=True)
    metadata = {"signature": signature, "sourceHeight": video["height"], "video": {}, "audio": {},
                "sourceVideoBitrate": int(video.get("bit_rate") or 0),
                "encodingLevels": [{"height": h, "target": b, "maxrate": m} for h, b, m in levels]}
    for height, bitrate, maximum in levels:
        folder = target / str(height)
        folder.mkdir(exist_ok=True)
        if not (args.skip_existing and same_input(folder, signature) and complete_playlist(folder / "index.m3u8")):
            encode(args, ["-i", str(source), "-map", "0:v:0", "-an",
                      "-vf", f"fps=30,scale=-2:{height}:flags=lanczos,setsar=1",
                      "-c:v", "libx264", "-preset", "veryfast", "-threads", str(args.threads),
                      "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "3.1",
                      "-b:v", str(bitrate), "-maxrate", str(maximum), "-bufsize", str(maximum * 2),
                      "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
                      "-force_key_frames", "expr:gte(t,n_forced*4)", "-map_metadata", "-1"]
                         + hls_options(folder), args.logs / f"{song_id}-{height}.log", folder)
        saved_video = probe(args.ffprobe, folder / "init.mp4")["streams"][0]
        if saved_video["codec_name"] != "h264" or saved_video["height"] != height:
            raise ValueError(f"Unexpected video stream for {song_id} / {height}")
        metadata["video"][str(height)] = {**playlist_metadata(folder / "index.m3u8"),
                                           "width": saved_video["width"], "height": height}
        remove_stale_fragments(folder, metadata["video"][str(height)])
        write_json(folder / "source.json", signature)
        print(f"Saved {song_id} {height}p", flush=True)
    for name, audio_source in audio_sources.items():
        folder = target / name
        folder.mkdir(exist_ok=True)
        if not (args.skip_existing and same_input(folder, signature) and complete_playlist(folder / "index.m3u8")):
            encode(args, ["-i", str(audio_source), "-map", "0:a:0", "-vn",
                      "-af", f"apad,atrim=duration={duration:.6f},asetpts=PTS-STARTPTS",
                      "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                      "-threads", str(args.threads), "-map_metadata", "-1"]
                         + hls_options(folder), args.logs / f"{song_id}-{name}.log", folder)
        audio_stream = probe(args.ffprobe, folder / "init.mp4")["streams"][0]
        if audio_stream["codec_name"] != "aac" or audio_stream["channels"] != 2:
            raise ValueError(f"Unexpected audio codec for {song_id} / {name}")
        metadata["audio"][name] = playlist_metadata(folder / "index.m3u8")
        remove_stale_fragments(folder, metadata["audio"][name])
        write_json(folder / "source.json", signature)
    # Both playlists use the same GOP cadence. Only the final segment may be short.
    if metadata["video"]["360"]["segments"] != metadata["video"]["720"]["segments"]:
        raise ValueError(f"Video variants have different segment counts: {song_id}")
    header = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for name, label in AUDIO_NAMES.items():
        default = "YES" if name == entry.get("defaultAudio", "karaoke") else "NO"
        header.append(f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="{label}",'
                      f'DEFAULT={default},AUTOSELECT=YES,CHANNELS="2",URI="{name}/index.m3u8"')
    variants = []
    variant_lines = []
    audio_peak = max(value["peakBandwidth"] for value in metadata["audio"].values())
    audio_average = max(value["averageBandwidth"] for value in metadata["audio"].values())
    for height, _, maximum in levels:
        info = metadata["video"][str(height)]
        # 15% margin above measured segment peak or configured video maxrate, plus audio.
        bandwidth = math.ceil((max(maximum, info["peakBandwidth"]) + audio_peak) * 1.15 / 1000) * 1000
        average = info["averageBandwidth"] + audio_average
        line = (f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},AVERAGE-BANDWIDTH={average},'
                f'RESOLUTION={info["width"]}x{height},FRAME-RATE=30.000,'
                'CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"')
        variant_lines += [line, f"{height}/index.m3u8"]
        (target / f"{height}p.m3u8").write_text("\n".join(header + [line, f"{height}/index.m3u8"]) + "\n", encoding="utf-8")
        variants.append({"height": height, "bandwidth": bandwidth,
                         "url": (target / f"{height}p.m3u8").relative_to(root).as_posix()})
    (target / "master.m3u8").write_text("\n".join(header + variant_lines) + "\n", encoding="utf-8")
    metadata["streaming"] = {"url": (target / "master.m3u8").relative_to(root).as_posix(), "variants": variants}
    metadata["outputFiles"] = {path.relative_to(target).as_posix(): path.stat().st_size
                                for path in target.rglob("*") if path.is_file() and path != marker}
    metadata["totalBytes"] = sum(metadata["outputFiles"].values())
    write_json(marker, metadata)
    print(f"Completed {song_id}: {metadata['totalBytes'] / 1e6:.2f} MB", flush=True)
    return song_id, metadata


def prepare_catalog(args, root):
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    selected = [entry for entry in catalog["videos"] if not args.only or entry["id"] in args.only]
    if args.only and set(args.only) - {entry["id"] for entry in selected}:
        raise ValueError("--only contains a song ID not found in the catalog")
    results = {}
    pool = ThreadPoolExecutor(max_workers=args.jobs)
    try:
        futures = [pool.submit(prepare, args, root, entry) for entry in selected]
        for future in as_completed(futures):
            song_id, metadata = future.result()
            results[song_id] = metadata
    except BaseException:
        CANCELLED.set()
        with ENCODER_LOCK:
            active = list(ACTIVE_ENCODERS)
            for process in active:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
        for process in active:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)
    for entry in catalog["videos"]:
        if entry["id"] not in results:
            continue
        entry["sourceHeight"] = results[entry["id"]]["sourceHeight"]
        entry["streaming"] = results[entry["id"]]["streaming"]
    write_json(args.catalog, catalog)
    total = sum(result["totalBytes"] for result in results.values())
    write_json(args.logs / "preparation-summary.json", {"recipe": RECIPE, "totalBytes": total,
               "songs": {song_id: {"totalBytes": value["totalBytes"], "streaming": value["streaming"]}
                         for song_id, value in results.items()}})
    print(f"Catalog saved. {len(results)} songs, {total / 1e6:.2f} MB generated.", flush=True)


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=root / "videos.json")
    parser.add_argument("--output", type=Path, default=root / "media" / "streams-v1")
    parser.add_argument("--logs", type=Path, default=root / ".local" / "streaming-logs")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--only", action="append", help="Prepare only this catalog ID; repeat to select multiple songs")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.logs = args.logs.resolve()
    if not args.output.is_relative_to(root / "media") or args.output == root / "media":
        parser.error("--output must be a versioned subdirectory of the repository's media folder")
    if not 1 <= args.jobs <= 4 or not 1 <= args.threads <= 16:
        parser.error("Use 1–4 jobs and 1–16 threads")
    args.logs.mkdir(parents=True, exist_ok=True)
    with production_lock(root, args.output):
        prepare_catalog(args, root)


if __name__ == "__main__":
    main()
