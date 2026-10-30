"""Build AAC soundtrack assets from an explicit local source manifest.

The config is kept outside the public repository. No source paths or credentials
are written into the website catalog. This command does not modify video files.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-existing", action="store_true")
    args = parser.parse_args()
    jobs = json.loads(args.config.read_text(encoding="utf-8"))
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    results = []
    for job in jobs:
        target = (root / job["file"]).resolve()
        if not target.is_relative_to(root) or target.suffix != ".m4a":
            raise ValueError("Audio outputs must be .m4a files inside the destination.")
        if not (args.skip_existing and target.exists()):
            filters = ["aresample=44100"]
            if job.get("trim", 0):
                filters += [f"atrim=start={job['trim']}", "asetpts=PTS-STARTPTS"]
            if job.get("gain", 1) != 1:
                filters.append(f"volume={job['gain']}")
            if job.get("delay", 0):
                filters.append(f"adelay={round(job['delay'] * 44100)}S:all=1")
            filters += ["apad", f"atrim=duration={job['duration']}"]
            if job.get("limit"):
                filters.append("alimiter=limit=0.98:level=0:latency=1")
            command = ["ffmpeg", "-y", "-v", "error", "-i", job["source"], "-vn",
                       "-map", "0:a:0", "-af", ",".join(filters), "-c:a", "aac",
                       "-b:a", "160k", "-movflags", "+faststart", str(target)]
            subprocess.run(command, check=True)
        metadata = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,sample_rate,channels",
            "-of", "json", str(target)
        ], text=True))
        result = {"file": job["file"], "expected_duration": job["duration"], "metadata": metadata}
        results.append(result)
        print(json.dumps({"file": job["file"], "seconds": metadata["format"]["duration"]}), flush=True)
    report = args.config.parent / "audio-export-report.json"
    report.write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
