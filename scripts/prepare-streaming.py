"""Prepare versioned HLS VOD video and alternate audio for the karaoke catalog.

Only generated files under --output and streaming metadata in --catalog change.
Original MP4s and aligned M4A soundtracks are never modified. Requires FFmpeg
with libx264 and AAC plus FFprobe; no credentials or environment variables.
Use --manifests-only to add video-only masters from saved rendition metadata
without invoking FFmpeg or changing the existing media and legacy masters.
Use --video-only --reuse-existing with a new --output version to retain matching
lower renditions, add native-resolution 1080p, and omit duplicate HLS audio.
--estimate reports expected additional bytes without writing media or catalog.
--compact-fallbacks also remuxes the lowest rendition plus default audio into a
small compatibility MP4. Use --output-catalog to preserve an input source snapshot.
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


RECIPE = "hls-fmp4-v2-30fps-4sec-1080"
LEVELS = ((360, 300000, 450000), (720, 850000, 1100000), (1080, 1350000, 1750000))
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


def levels_for(video, high_bitrate=1350000):
    """Do not upscale source pixels or inflate already efficient source video."""
    source_bitrate = int(video.get("bit_rate") or 0)
    source_height = int(video["height"])
    result = []
    for height, bitrate, maximum in LEVELS:
        if height > source_height:
            continue
        if height == 1080:
            bitrate = min(bitrate, high_bitrate)
            maximum = round(bitrate * 1.3)
        if source_bitrate > 0:
            ratio = {360: .65, 720: .85, 1080: 1.05}[height]
            bitrate = min(bitrate, max(80000, round(source_bitrate * ratio / 1000) * 1000))
            maximum = min(maximum, round(bitrate * 1.5))
        result.append((height, bitrate, maximum))
    if not result:
        raise ValueError("Source must have at least 360 native vertical pixels")
    return tuple(result)


def video_codec(info):
    # All generated renditions use High profile. 1080p requires AVC level 4.0.
    return f"avc1.6400{int(info.get('level', 40 if info['height'] > 720 else 31)):02x}"


def reusable_video(root, target, entry, signature):
    """Read a previous version's matching video renditions without mutating them."""
    value = entry.get("streaming", {}).get("videoOnly", {}).get("url", "")
    if not value or ":" in value:
        return {}
    previous = (root / value).resolve().parent
    if previous == target or not previous.is_relative_to(root / "media"):
        return {}
    marker = previous / "renditions.json"
    if not marker.is_file():
        return {}
    saved = json.loads(marker.read_text(encoding="utf-8"))
    if saved.get("signature", {}).get("source") != signature["source"]:
        return {}
    result = {}
    for height, info in saved.get("video", {}).items():
        playlist = (previous / info.get("playlist", f"{height}/index.m3u8")).resolve()
        if not playlist.is_relative_to(root / "media") or not complete_playlist(playlist):
            continue
        # Persist the relative source link in the new manifest metadata. No copy.
        result[int(height)] = {**info, "playlist": Path(os.path.relpath(playlist, target)).as_posix()}
    return result


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def publish_catalog(args, catalog, changed_ids):
    # A source snapshot may feed several --only batches. Preserve already
    # published entries outside this batch instead of restoring their inputs.
    if args.output_catalog != args.catalog and args.output_catalog.is_file():
        previous = json.loads(args.output_catalog.read_text(encoding="utf-8-sig"))
        entries = {entry["id"]: entry for entry in previous.get("videos", [])}
        catalog["videos"] = [entry if entry["id"] in changed_ids else entries.get(entry["id"], entry)
                             for entry in catalog["videos"]]
    write_json(args.output_catalog, catalog)


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


def write_video_only_manifests(root, target, metadata):
    header = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    configured = metadata.get("encodingLevels")
    if configured:
        maximums = {str(level["height"]): level["maxrate"] for level in configured}
    else:
        levels = metadata.get("signature", {}).get("lowBitrateLevels", LEVELS)
        maximums = {str(height): maximum for height, _, maximum in levels}
    lines = []
    variants = []
    for key, info in sorted(metadata["video"].items(), key=lambda item: int(item[0])):
        height = int(key)
        rendition = info.get("playlist", f"{height}/index.m3u8")
        if not (target / rendition).is_file():
            raise ValueError(f"Missing saved video rendition: {target / key}")
        bandwidth = math.ceil(max(maximums.get(key, 0), info["peakBandwidth"]) * 1.15 / 1000) * 1000
        line = (f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},AVERAGE-BANDWIDTH={info["averageBandwidth"]},'
                f'RESOLUTION={info["width"]}x{height},FRAME-RATE=30.000,CODECS="{video_codec(info)}"')
        path = target / f"{height}p-video-only.m3u8"
        path.write_text("\n".join(header + [line, rendition]) + "\n", encoding="utf-8")
        lines += [line, rendition]
        variants.append({"height": height, "bandwidth": bandwidth, "url": path.relative_to(root).as_posix()})
    master = target / "video-only.m3u8"
    master.write_text("\n".join(header + lines) + "\n", encoding="utf-8")
    return {"url": master.relative_to(root).as_posix(), "variants": variants}


def update_video_only_catalog(args, root):
    catalog = json.loads(args.catalog.read_text(encoding="utf-8-sig"))
    selected = [entry for entry in catalog["videos"] if not args.only or entry["id"] in args.only]
    if args.only and set(args.only) - {entry["id"] for entry in selected}:
        raise ValueError("--only contains a song ID not found in the catalog")
    for entry in selected:
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", entry["id"]):
            raise ValueError(f"Unsafe catalog ID: {entry['id']}")
        target = args.output / entry["id"]
        metadata = json.loads((target / "renditions.json").read_text(encoding="utf-8"))
        entry.setdefault("streaming", {})["videoOnly"] = write_video_only_manifests(root, target, metadata)
    publish_catalog(args, catalog, {entry["id"] for entry in selected})
    print(f"Saved video-only masters for {len(selected)} songs; existing media and legacy masters retained.", flush=True)


def compact_fallback(args, root, target, metadata, entry, source, audio_sources, duration):
    """Copy existing low-resolution H.264 and default AAC into a faststart MP4."""
    height = min(int(value) for value in metadata["video"])
    info = metadata["video"][str(height)]
    playlist = (target / info.get("playlist", f"{height}/index.m3u8")).resolve()
    if not playlist.is_relative_to(root / "media"):
        raise ValueError("Compatibility source playlist must remain inside local media")
    name = entry.get("defaultAudio", "karaoke")
    if name not in audio_sources and audio_sources:
        name = next(iter(audio_sources))
    audio_source = audio_sources.get(name, source)
    audio = next((stream for stream in probe(args.ffprobe, audio_source)["streams"]
                  if stream["codec_type"] == "audio"), None)
    if audio is None:
        raise ValueError(f"No default audio available for compatibility MP4: {entry['id']}")
    output = target / f"compatibility-{height}p.mp4"
    command = ["-i", str(playlist), "-i", str(audio_source), "-map", "0:v:0", "-map", "1:a:0",
               "-c", "copy", "-t", f"{duration:.6f}", "-movflags", "+faststart", "-map_metadata", "-1"]
    if audio["codec_name"] != "aac":
        command += ["-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2"]
    encode(args, command + [str(output)], args.logs / f"{entry['id']}-compatibility.log", target)
    saved = probe(args.ffprobe, output)
    streams = saved["streams"]
    saved_video = next((stream for stream in streams if stream["codec_type"] == "video"), {})
    saved_audio = next((stream for stream in streams if stream["codec_type"] == "audio"), {})
    if saved_video.get("codec_name") != "h264" or saved_video.get("height") != height or saved_audio.get("codec_name") != "aac":
        raise ValueError(f"Unexpected compatibility MP4 streams: {entry['id']}")
    saved_duration = float(saved["format"]["duration"])
    if not math.isfinite(saved_duration) or abs(saved_duration - duration) > 1:
        raise ValueError(f"Compatibility MP4 duration differs from source: {entry['id']}")
    metadata["fallback"] = {"url": output.relative_to(root).as_posix(), "height": height,
                            "bytes": output.stat().st_size, "duration": saved_duration,
                            "audio": name if name in audio_sources else "embedded"}


def prepare(args, root, entry):
    song_id = entry["id"]
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", song_id):
        raise ValueError(f"Unsafe catalog ID: {song_id}")
    if entry.get("fallbackHeight"):
        raise ValueError(f"{song_id} uses a compatibility MP4; prepare from the retained source catalog instead")
    source = (root / entry["url"]).resolve()
    audio_sources = {name: (root / value).resolve() for name, value in entry.get("audio", {}).items()
                     if name in AUDIO_NAMES}
    if not args.video_only and not audio_sources:
        raise ValueError(f"No separate audio for {song_id}; use --video-only")
    for path in [source, *audio_sources.values()]:
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f"Source must be a local file within the repository: {path}")
    source_info = probe(args.ffprobe, source)
    video = next(stream for stream in source_info["streams"] if stream["codec_type"] == "video")
    duration = float(source_info["format"]["duration"])
    levels = levels_for(video, args.max_1080_bitrate)
    target = args.output / song_id
    target.mkdir(parents=True, exist_ok=True)
    marker = target / "renditions.json"
    signature = {"recipe": RECIPE, "source": fingerprint(source),
                 "audio": {name: fingerprint(path) for name, path in audio_sources.items()},
                 "defaultAudio": entry.get("defaultAudio", "karaoke"), "videoOnly": args.video_only,
                 "compactFallbacks": args.compact_fallbacks}
    if levels != LEVELS:
        signature["lowBitrateLevels"] = [list(level) for level in levels]
    if args.skip_existing and marker.is_file():
        saved = json.loads(marker.read_text(encoding="utf-8"))
        if saved.get("signature") == signature:
            expected = saved.get("outputFiles", {})
            if expected and all((target / name).is_file() and (target / name).stat().st_size == size
                                for name, size in expected.items()) and all(
                                    complete_playlist(target / info.get("playlist", f"{height}/index.m3u8"))
                                    for height, info in saved["video"].items()):
                saved["streaming"]["videoOnly"] = write_video_only_manifests(root, target, saved)
                print(f"Skipped complete {song_id}", flush=True)
                return song_id, saved
    preparation = target / "preparation.json"
    write_json(preparation, signature)
    print(f"Preparing {song_id}", flush=True)
    metadata = {"signature": signature, "sourceHeight": video["height"], "video": {}, "audio": {},
                "sourceVideoBitrate": int(video.get("bit_rate") or 0),
                "encodingLevels": [{"height": h, "target": b, "maxrate": m} for h, b, m in levels]}
    reused = reusable_video(root, target, entry, signature) if args.reuse_existing else {}
    for height, bitrate, maximum in levels:
        if height in reused:
            metadata["video"][str(height)] = reused[height]
            print(f"Reused {song_id} {height}p", flush=True)
            continue
        folder = target / str(height)
        folder.mkdir(exist_ok=True)
        if not (args.skip_existing and same_input(folder, signature) and complete_playlist(folder / "index.m3u8")):
            encode(args, ["-i", str(source), "-map", "0:v:0", "-an",
                      "-vf", f"fps=30,scale=-2:{height}:flags=lanczos,setsar=1",
                      "-c:v", "libx264", "-preset", "veryfast", "-threads", str(args.threads),
                      "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.0" if height > 720 else "3.1",
                      "-b:v", str(bitrate), "-maxrate", str(maximum), "-bufsize", str(maximum * 2),
                      "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
                      "-force_key_frames", "expr:gte(t,n_forced*4)", "-map_metadata", "-1"]
                         + hls_options(folder), args.logs / f"{song_id}-{height}.log", folder)
        saved_video = probe(args.ffprobe, folder / "init.mp4")["streams"][0]
        if saved_video["codec_name"] != "h264" or saved_video["height"] != height:
            raise ValueError(f"Unexpected video stream for {song_id} / {height}")
        metadata["video"][str(height)] = {**playlist_metadata(folder / "index.m3u8"),
                                           "width": saved_video["width"], "height": height,
                                           "level": saved_video["level"]}
        remove_stale_fragments(folder, metadata["video"][str(height)])
        write_json(folder / "source.json", signature)
        print(f"Saved {song_id} {height}p", flush=True)
    for name, audio_source in ([] if args.video_only else audio_sources.items()):
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
    if len({info["segments"] for info in metadata["video"].values()}) != 1:
        raise ValueError(f"Video variants have different segment counts: {song_id}")
    if args.compact_fallbacks:
        compact_fallback(args, root, target, metadata, entry, source, audio_sources, duration)
    if args.video_only:
        descriptor = write_video_only_manifests(root, target, metadata)
        metadata["streaming"] = {**descriptor, "videoOnly": descriptor}
        metadata["outputFiles"] = {path.relative_to(target).as_posix(): path.stat().st_size
                                  for path in target.rglob("*") if path.is_file() and path != marker}
        metadata["totalBytes"] = sum(metadata["outputFiles"].values())
        write_json(marker, metadata)
        print(f"Completed {song_id}: {metadata['totalBytes'] / 1e6:.2f} MB newly saved", flush=True)
        return song_id, metadata
    header = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for name in audio_sources:
        label = AUDIO_NAMES[name]
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
                f'CODECS="{video_codec(info)},mp4a.40.2",AUDIO="audio"')
        variant_lines += [line, f"{height}/index.m3u8"]
        (target / f"{height}p.m3u8").write_text("\n".join(header + [line, f"{height}/index.m3u8"]) + "\n", encoding="utf-8")
        variants.append({"height": height, "bandwidth": bandwidth,
                         "url": (target / f"{height}p.m3u8").relative_to(root).as_posix()})
    (target / "master.m3u8").write_text("\n".join(header + variant_lines) + "\n", encoding="utf-8")
    metadata["streaming"] = {"url": (target / "master.m3u8").relative_to(root).as_posix(), "variants": variants}
    metadata["streaming"]["videoOnly"] = write_video_only_manifests(root, target, metadata)
    metadata["outputFiles"] = {path.relative_to(target).as_posix(): path.stat().st_size
                                for path in target.rglob("*") if path.is_file() and path != marker}
    metadata["totalBytes"] = sum(metadata["outputFiles"].values())
    write_json(marker, metadata)
    print(f"Completed {song_id}: {metadata['totalBytes'] / 1e6:.2f} MB", flush=True)
    return song_id, metadata


def prepare_catalog(args, root):
    catalog = json.loads(args.catalog.read_text(encoding="utf-8-sig"))
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
        fallback = results[entry["id"]].get("fallback")
        if fallback:
            entry["url"] = fallback["url"]
            entry["fallbackHeight"] = fallback["height"]
        else:
            entry.pop("fallbackHeight", None)
    publish_catalog(args, catalog, set(results))
    total = sum(result["totalBytes"] for result in results.values())
    write_json(args.logs / "preparation-summary.json", {"recipe": RECIPE, "totalBytes": total,
               "songs": {song_id: {"totalBytes": value["totalBytes"], "streaming": value["streaming"],
                                    "fallback": value.get("fallback")}
                         for song_id, value in results.items()}})
    print(f"Catalog saved. {len(results)} songs, {total / 1e6:.2f} MB generated.", flush=True)


def estimate_catalog(args, root):
    """Report a production size estimate; do not encode or rewrite the catalog."""
    catalog = json.loads(args.catalog.read_text(encoding="utf-8-sig"))
    selected = [entry for entry in catalog["videos"] if not args.only or entry["id"] in args.only]
    if args.only and set(args.only) - {entry["id"] for entry in selected}:
        raise ValueError("--only contains a song ID not found in the catalog")
    result = []
    retired_sources = {}
    for entry in selected:
        if entry.get("fallbackHeight"):
            raise ValueError(f"{entry['id']} uses a compatibility MP4; estimate from the retained source catalog instead")
        source = (root / entry["url"]).resolve()
        if not source.is_relative_to(root / "media") or not source.is_file():
            raise ValueError(f"Source must be a local media file: {source}")
        info = probe(args.ffprobe, source)
        video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
        duration = float(info["format"]["duration"])
        levels = levels_for(video, args.max_1080_bitrate)
        reused = reusable_video(root, args.output / entry["id"], entry, {"source": fingerprint(source)}) if args.reuse_existing else {}
        new_rate = sum(bitrate for height, bitrate, _ in levels if height not in reused)
        if not args.video_only:
            new_rate += 128000 * len([key for key in entry.get("audio", {}) if key in AUDIO_NAMES])
        fallback_bytes = 0
        if args.compact_fallbacks:
            low_height, low_rate, _ = levels[0]
            if low_height in reused:
                low_rate = reused[low_height]["averageBandwidth"]
            fallback_bytes = math.ceil(duration * (low_rate + 160000) / 8 * 1.03)
            retired_sources[str(source)] = source.stat().st_size
        result.append({"id": entry["id"], "duration": duration, "sourceHeight": video["height"],
                       "levels": [{"height": height, "target": bitrate, "maxrate": maximum,
                                   "reused": height in reused} for height, bitrate, maximum in levels],
                       "estimatedFallbackBytes": fallback_bytes,
                       "estimatedNewBytes": math.ceil(duration * new_rate / 8 * 1.03) + fallback_bytes})
    print(json.dumps({"songs": result, "estimatedNewBytes": sum(song["estimatedNewBytes"] for song in result),
                      "retiredSourceBytes": sum(retired_sources.values()),
                      "note": "Target bitrate plus 3% container allowance; actual encoder output can differ."}, indent=2))


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=root / "videos.json")
    parser.add_argument("--output-catalog", type=Path, help="Write published entries here while preserving the input source catalog")
    parser.add_argument("--output", type=Path, default=root / "media" / "streams-v1")
    parser.add_argument("--logs", type=Path, default=root / ".local" / "streaming-logs")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--video-only", action="store_true", help="Generate only picture streams; aligned external audio remains in the catalog")
    parser.add_argument("--reuse-existing", action="store_true", help="Reference matching existing video renditions from a new versioned master")
    parser.add_argument("--compact-fallbacks", action="store_true", help="Use remuxed lowest-resolution MP4s as lightweight compatibility fallbacks")
    parser.add_argument("--max-1080-bitrate", type=int, default=1350000, help="Maximum target bitrate in bits/s for 1080p (default: 1350000)")
    parser.add_argument("--estimate", action="store_true", help="Print estimated new production size without encoding or changing the catalog")
    parser.add_argument("--manifests-only", action="store_true", help="Add video-only masters using saved metadata; never encode media")
    parser.add_argument("--only", action="append", help="Prepare only this catalog ID; repeat to select multiple songs")
    args = parser.parse_args()
    args.catalog = args.catalog.resolve()
    args.output_catalog = args.output_catalog.resolve() if args.output_catalog else args.catalog
    args.output = args.output.resolve()
    args.logs = args.logs.resolve()
    if not args.output.is_relative_to(root / "media") or args.output == root / "media":
        parser.error("--output must be a versioned subdirectory of the repository's media folder")
    if not 1 <= args.jobs <= 4 or not 1 <= args.threads <= 16:
        parser.error("Use 1–4 jobs and 1–16 threads")
    if not 300000 <= args.max_1080_bitrate <= 5000000:
        parser.error("--max-1080-bitrate must be between 300000 and 5000000 bits/s")
    if args.compact_fallbacks and args.manifests_only:
        parser.error("--compact-fallbacks requires media production, not --manifests-only")
    if args.estimate:
        estimate_catalog(args, root)
        return
    args.logs.mkdir(parents=True, exist_ok=True)
    with production_lock(root, args.output):
        if args.manifests_only:
            update_video_only_catalog(args, root)
        else:
            prepare_catalog(args, root)


if __name__ == "__main__":
    main()
