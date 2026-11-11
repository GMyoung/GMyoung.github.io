"""Export next-line lyric data from the existing final, reviewed cue files.

This does not recognize, rewrite, retime, or render music. Hamantha and Nice
Boys may be supplied as separately reviewed, visually recovered caption JSON.
Never pass their discarded ASR drafts as recovered captions.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
from difflib import SequenceMatcher
import html
import json
import math
from pathlib import Path
import re


def seconds(value: str) -> float:
    hours, minutes, rest = value.replace(",", ".").split(":")
    return round(int(hours) * 3600 + int(minutes) * 60 + float(rest), 3)


def read_srt(path: Path) -> list[dict]:
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", path.read_text(encoding="utf-8-sig").strip()):
        lines = block.splitlines()
        marker = next((i for i, line in enumerate(lines) if " --> " in line), None)
        if marker is None:
            continue
        start, end = lines[marker].split(" --> ")
        cues.append({"start": seconds(start), "end": seconds(end), "text": "\n".join(lines[marker + 1:]).strip()})
    return cues


def read_json(path: Path) -> list[dict] | dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_data_picard(path: Path) -> list[dict]:
    cues = read_json(path)
    for cue in cues:
        lines = cue["text"].splitlines()
        if len(lines) > 1 and all(line.startswith("(") and line.endswith(")") for line in lines[1:]):
            cue["text"] = lines[0]
            cue["backing"] = "\n".join(lines[1:])
    return cues


def read_odoriko(path: Path) -> list[dict]:
    result = []
    for cue in read_json(path):
        primary = cue["romaji"].strip()
        translation = cue["english"].strip()
        text = primary if translation == primary or not translation else primary + "\n" + translation
        item = {"start": cue["start"], "end": cue["end"], "text": text, "kind": cue["kind"]}
        if cue.get("backing"):
            item["backing"] = "(Tu-ru-ru-ru, tu-ru-ru-ru, tu-ru-ru)"
        result.append(item)
    return result


def checked(cues: list[dict]) -> list[dict]:
    result = []
    for cue in cues:
        start, end, text = cue["start"], cue["end"], cue["text"]
        if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in (start, end)):
            raise ValueError("Cue times must be finite numbers")
        if start < 0 or end <= start or not isinstance(text, str) or not text.strip():
            raise ValueError("Invalid lyric cue")
        item = {"start": round(start, 3), "end": round(end, 3), "text": text.strip()}
        for key in ("kind", "backing"):
            value = cue.get(key)
            if value is not None:
                if not isinstance(value, str):
                    raise ValueError(f"Cue {key} must be text")
                if value.strip():
                    item[key] = value.strip()
        result.append(item)
    result.sort(key=lambda cue: cue["start"])
    if not result:
        raise ValueError("No lyrics found")
    return result


def estimated_words(cue: dict, primary: str) -> list[dict]:
    tokens = primary.split()
    weights = [max(1, len(re.sub(r"[^\w]", "", token))) for token in tokens]
    total = sum(weights)
    cursor = 0
    words = []
    for token, weight in zip(tokens, weights):
        start = cue["start"] + (cue["end"] - cue["start"]) * cursor / total
        cursor += weight
        end = cue["start"] + (cue["end"] - cue["start"]) * cursor / total
        words.append({"text": token, "start": round(start, 3), "end": round(end, 3), "estimated": True})
    return words


def add_word_timing(name: str, cues: list[dict], root: Path, odoriko_source: Path | None) -> None:
    groups = {}
    source_cues = None
    method, source = "weighted-estimate", "reviewed cue bounds; no word alignment"
    if name == "die-for-you":
        folder = root / "die-for-you-karaoke-20261029/lyrics-v1"
        edited = read_json(folder / "edited-word-timestamps.json")
        raw = read_json(folder / "word-timestamps.json")["words"]
        normalize = lambda word: re.sub(r"[^a-z0-9]", "", word.lower())
        matcher = SequenceMatcher(None, [normalize(word["word"]) for word in raw],
                                  [normalize(word["word"]) for word in edited], autojunk=False)
        matched = {index for block in matcher.get_matching_blocks() for index in range(block.b, block.b + block.size)}
        for index, word in enumerate(edited):
            groups.setdefault(word["line"], []).append((word, index not in matched))
        method, source = "asr-aligned-edited", "edited-word-timestamps.json"
    elif name == "shes-a-big-boy":
        for word in read_json(root / "shes-a-big-boy-karaoke-20261029/forced-word-timestamps.json"):
            groups.setdefault(word["line"], []).append((word, False))
        method, source = "forced-alignment", "forced-word-timestamps.json"
    elif name == "odoriko":
        source_cues = read_json(odoriko_source or root / "odoriko-bilingual-karaoke-20261029/bilingual-cues.json")
        for word in read_json(root / "odoriko-bilingual-karaoke-20261029/forced-word-timestamps.json"):
            groups.setdefault(word["line"], []).append((word, False))
        method, source = "romanized-forced-alignment", "forced-word-timestamps.json"
    elif name != "data-and-picard":
        return

    for index, cue in enumerate(cues):
        primary = cue["text"].splitlines()[0] if name == "odoriko" else cue["text"]
        tokens = primary.split()
        if name == "data-and-picard" and cue["text"].strip() == "(Klingon singing)":
            cue["kind"] = "stage-direction"
            cue["words"] = []
            cue["wordTiming"] = {"method": "stage-direction", "source": "cue text", "matchedWords": 0, "estimatedWords": 0}
            continue
        line = source_cues[index].get("alignment_line") if source_cues is not None else index
        candidates = groups.get(line, [])
        matches = len(candidates) == len(tokens) and bool(candidates)
        if matches and name != "odoriko":
            matches = [word["word"] for word, _ in candidates] == tokens
        words = []
        if matches:
            # Preserve known vocal ends, including pauses. Clip only to the
            # accepted cue and next word so adjacent highlights never overlap.
            starts = [max(cue["start"], min(cue["end"], word["start"])) for word, _ in candidates]
            for position, (token, (word, inferred)) in enumerate(zip(tokens, candidates)):
                start = starts[position]
                limit = starts[position + 1] if position + 1 < len(starts) else cue["end"]
                end = min(cue["end"], limit, word["end"])
                if not math.isfinite(start) or not math.isfinite(end) or end <= start:
                    words = []
                    break
                words.append({"text": token, "start": round(start, 3), "end": round(end, 3), "estimated": inferred})
        if not words:
            words = estimated_words(cue, primary)
            cue_method, cue_source = "weighted-estimate", "reviewed cue bounds; no word alignment"
        else:
            cue_method, cue_source = method, source
        cue["words"] = words
        inferred_count = sum(word["estimated"] for word in words)
        cue["wordTiming"] = {"method": cue_method, "source": cue_source,
                             "matchedWords": len(words) - inferred_count, "estimatedWords": inferred_count}


def preview_index(cues: list[dict], starts: list[float], time: float) -> int | None:
    index = bisect_right(starts, time)
    if index == len(cues):
        return None
    current = cues[index - 1] if index else None
    following = cues[index]
    if current and time < current["end"] and following["start"] - current["end"] <= 8:
        return index
    return index if following["start"] - time <= 5 else None


def vtt_time(time: float) -> str:
    milliseconds = round(time * 1000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds_part, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds_part:02}.{milliseconds:03}"


def cue_text(cue: dict) -> str:
    parts = cue["text"].split("\n")
    if cue.get("backing"):
        parts.insert(1, cue["backing"])
    return "\n".join(parts)


def native_vtt(cues: list[dict], show_current: bool = False) -> str:
    """The same preview windows as the DOM, for iPhone's native fullscreen.

    Current+next exports keep the page's two alternating bottom rows. These
    are static native captions; word color is animated only by the web player.
    """
    starts = [cue["start"] for cue in cues]
    boundaries = sorted({0.0, *(cue[key] for cue in cues for key in ("start", "end")),
                         *(max(0.0, cue["start"] - 5) for cue in cues)})
    spans = []
    for start, end in zip(boundaries, boundaries[1:]):
        time = (start + end) / 2
        index = preview_index(cues, starts, time)
        current = bisect_right(starts, time) - 1
        if not show_current or current < 0 or time >= cues[current]["end"]:
            current = None
        state = (current, index)
        if (index is None and current is None) or end <= start:
            continue
        if spans and spans[-1][2] == state and spans[-1][1] == start:
            spans[-1] = (spans[-1][0], end, state)
        else:
            spans.append((start, end, state))
    lines = ["WEBVTT", ""]
    for number, (start, end, (current, index)) in enumerate(spans, 1):
        if show_current:
            rows = ["\u00a0", "\u00a0"]
            if index is not None:
                rows[index % 2] = cues[index]["text"].splitlines()[0]
            if current is not None:
                rows[current % 2] = cue_text(cues[current])
            lines.extend([str(number), f"{vtt_time(start)} --> {vtt_time(end)} line:-1 position:50% size:88% align:center",
                          html.escape("\n".join(rows), quote=False), ""])
            continue
        if index is not None:
            lines.extend([f"{number}-next", f"{vtt_time(start)} --> {vtt_time(end)} line:10% position:50% size:88% align:center",
                          "Next: " + html.escape(cue_text(cues[index]), quote=False), ""])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True, help="Existing production output directory")
    parser.add_argument("--output", type=Path, default=Path("assets/lyrics-v1"))
    parser.add_argument("--url-prefix", default="assets/lyrics-v1", help="Public relative URL for output files")
    parser.add_argument("--recovered-root", type=Path, help="Reviewed Hamantha/Nice Boys burned-caption JSON directory")
    parser.add_argument("--only", action="append", help="Export only this lyric source name; repeat to select multiple sources")
    parser.add_argument("--odoriko-source", type=Path, help="Versioned, reviewed Odoriko bilingual cue JSON; defaults to the original production cues")
    parser.add_argument("--show-current", action="append", default=[], help="Catalog ID whose clean video needs current and next lyrics; repeat as needed")
    parser.add_argument("--word-timing", action="store_true", help="Attach existing word anchors or explicitly estimated spans; never retime cues")
    args = parser.parse_args()
    root = args.source_root
    sources = [
        ("die-for-you", ["die-for-you", "die-for-you-karaoke"], "en",
         lambda: read_srt(root / "die-for-you-karaoke-20261029/lyrics-v1/karaoke.srt")),
        ("data-and-picard", ["data-and-picard-lyrics"], "en",
         lambda: read_data_picard(root / "data-picard-lyrics-20261029/lyrics-cues.json")),
        ("shes-a-big-boy", ["shes-a-big-boy-karaoke"], "en",
         lambda: read_srt(root / "shes-a-big-boy-karaoke-20261029/karaoke.srt")),
        ("odoriko", ["odoriko-bilingual-karaoke"], "ja-Latn",
         lambda: read_odoriko(args.odoriko_source or root / "odoriko-bilingual-karaoke-20261029/bilingual-cues.json")),
    ]
    if args.recovered_root:
        for name in ("hamantha", "nice-boys"):
            path = args.recovered_root / f"{name}.lyrics.json"
            sources.append((name, [name], "en", lambda path=path: read_json(path)["cues"]))
    if args.only:
        missing = set(args.only) - {source[0] for source in sources}
        if missing:
            parser.error("Unavailable lyric sources: " + ", ".join(sorted(missing)))
        sources = [source for source in sources if source[0] in args.only]
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "manifest.json"
    manifest = read_json(manifest_path) if args.only and manifest_path.is_file() else {"version": 1, "entries": {}}
    counts = {}
    timing_counts = {}
    for name, ids, language, load in sources:
        cues = checked(load())
        if args.word_timing:
            add_word_timing(name, cues, root, args.odoriko_source)
            timing_counts[name] = {"matchedWords": sum(cue.get("wordTiming", {}).get("matchedWords", 0) for cue in cues),
                                   "estimatedWords": sum(cue.get("wordTiming", {}).get("estimatedWords", 0) for cue in cues)}
        (args.output / f"{name}.json").write_text(
            json.dumps({"version": 1, "language": language, "cues": cues}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (args.output / f"{name}.vtt").write_text(native_vtt(cues), encoding="utf-8")
        entry = {"url": f"{args.url_prefix.rstrip('/')}/{name}.json",
                 "vtt": f"{args.url_prefix.rstrip('/')}/{name}.vtt", "language": language}
        for catalog_id in ids:
            manifest["entries"][catalog_id] = entry.copy()
            if catalog_id == "die-for-you" or catalog_id in args.show_current:
                (args.output / f"{name}-current.vtt").write_text(native_vtt(cues, show_current=True), encoding="utf-8")
                manifest["entries"][catalog_id].update({"showCurrent": True,
                    "vtt": f"{args.url_prefix.rstrip('/')}/{name}-current.vtt"})
        counts[name] = len(cues)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), "cue_counts": counts, "word_timing": timing_counts,
                      "catalog_entries": len(manifest["entries"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
