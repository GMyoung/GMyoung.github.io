"""Attach local recognition anchors to lyrics supplied by the user.

Never fetches lyrics or replaces their words with recognition text. Unmatched
words receive explicit interpolated timing. When no vocal reference exists,
--estimated-windows-only requires an explicit window for every supplied line
and labels every word estimated. User listening review is required.
"""
import argparse
from difflib import SequenceMatcher
import importlib.util
import json
import math
from pathlib import Path
import re
import unicodedata


def normalized(text):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", text).lower())


def supplied_lines(text):
    lines = []
    for value in text.splitlines():
        value = value.strip()
        value = re.sub(r"^\[(?:verse|chorus|pre-chorus|post-chorus|refrain|bridge|intro|outro)\b[^\]}]*[\]}]\s*", "", value, flags=re.I)
        if not value:
            continue
        backing = re.findall(r"\([^)]*\)", value)
        primary = re.sub(r"\([^)]*\)", "", value).strip()
        if not primary:
            if lines and backing:
                lines[-1]["backing"] += backing
                continue
            primary, backing = value, []
        # Long rap lines become readable phrases, retaining every supplied word.
        chunks, chunk = [], []
        for word in primary.split():
            if chunk and len(" ".join(chunk + [word])) > 58:
                chunks.append(chunk)
                chunk = []
            chunk.append(word)
        if chunk:
            chunks.append(chunk)
        if len(chunks) > 1 and len(chunks[-1]) < 3:
            tail = chunks[-2] + chunks[-1]
            candidates = [index for index in range(2, len(tail) - 1)
                          if len(" ".join(tail[:index])) <= 58 and len(" ".join(tail[index:])) <= 58]
            if candidates:
                split = min(candidates, key=lambda index: abs(len(" ".join(tail[:index])) - len(" ".join(tail[index:]))))
                chunks[-2:] = [tail[:split], tail[split:]]
        for index, chunk in enumerate(chunks):
            lines.append({"tokens": chunk, "backing": backing if index == len(chunks) - 1 else []})
    if not lines:
        raise ValueError("No supplied lyric lines")
    return lines


def repair_collapsed_words(source):
    """Share a neighboring word's span when forced alignment collapses a word.

    All affected words are marked estimated; never pretend zero-duration model
    output is a usable phonetic boundary. Repairs stay inside one lyric line.
    """
    groups = {}
    for item in source:
        groups.setdefault(item["line"], []).append(dict(item))
    result = []
    for group in groups.values():
        index = 0
        while index < len(group):
            if group[index]["end"] > group[index]["start"]:
                index += 1
                continue
            right = index
            while right < len(group) and group[right]["end"] <= group[right]["start"]:
                right += 1
            if index:
                left, stop = index - 1, right
                start, end = group[left]["start"], group[left]["end"]
            elif right < len(group):
                left, stop = 0, right + 1
                start, end = group[right]["start"], group[right]["end"]
            else:
                raise ValueError("A complete forced-alignment line has no duration; refine its input window")
            weights = [max(1, len(normalized(item["word"]))) for item in group[left:stop]]
            cursor, total = 0, sum(weights)
            for item, weight in zip(group[left:stop], weights):
                item["start"] = start + (end - start) * cursor / total
                cursor += weight
                item["end"] = start + (end - start) * cursor / total
                item["estimated"] = True
            index = stop
        result.extend(group)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lyrics", type=Path, required=True)
    parser.add_argument("--timings", type=Path, help="Local recognition or forced-alignment word JSON")
    parser.add_argument("--name", required=True)
    parser.add_argument("--catalog-id", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--singing-start", type=float, help="Explicit lower bound if recognition missed opening words")
    parser.add_argument("--singing-end", type=float, help="Explicit upper bound if recognition missed closing words")
    parser.add_argument("--cue-windows", type=Path, help="Explicit estimated cue windows when acoustic alignment is unreliable")
    parser.add_argument("--estimated-windows-only", action="store_true", help="Use complete explicit cue windows without pretending vocal anchors exist")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--url-prefix", default="assets/lyrics-v4")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]+", args.name) or not math.isfinite(args.duration) or args.duration <= 0:
        parser.error("Use a safe song name and positive finite duration")
    if args.estimated_windows_only:
        if not args.cue_windows or args.timings or args.singing_start is not None or args.singing_end is not None:
            parser.error("--estimated-windows-only requires --cue-windows and excludes --timings and singing bounds")
    elif not args.timings:
        parser.error("Provide --timings, or --estimated-windows-only with complete --cue-windows")
    for bound in (args.singing_start, args.singing_end):
        if bound is not None and (not math.isfinite(bound) or not 0 <= bound <= args.duration):
            parser.error("Singing bounds must be finite and inside the media duration")
    lines = supplied_lines(args.lyrics.read_text(encoding="utf-8-sig"))
    words = [{"text": token, "line": index, "estimated": True} for index, line in enumerate(lines) for token in line["tokens"]]
    forced = False
    if not args.estimated_windows_only:
        source = json.loads(args.timings.read_text(encoding="utf-8-sig"))
        forced = isinstance(source, list)
        if forced:
            source = repair_collapsed_words(source)
        raw = [word for word in (source if forced else source["words"]) if normalized(word["word"]) and
               0 <= word["start"] < word["end"] <= args.duration]
        if not raw:
            raise ValueError("No usable local word anchors")
        matcher = SequenceMatcher(None, [normalized(word["word"]) for word in raw],
                                  [normalized(word["text"]) for word in words], autojunk=False)
        for block in matcher.get_matching_blocks():
            for offset in range(block.size):
                anchor = raw[block.a + offset]
                words[block.b + offset].update(start=anchor["start"], end=anchor["end"], estimated=bool(anchor.get("estimated", False)))
        index = 0
        while index < len(words):
            if "start" in words[index]:
                index += 1
                continue
            right = index
            while right < len(words) and "start" not in words[right]:
                right += 1
            start = words[index - 1]["end"] if index else (args.singing_start if args.singing_start is not None else raw[0]["start"])
            end = words[right]["start"] if right < len(words) else (args.singing_end if args.singing_end is not None else raw[-1]["end"])
            if end <= start:
                raise ValueError("Nonpositive interpolation window; refine anchors or provide --singing-start/--singing-end for missing edge words")
            weights = [max(1, len(normalized(word["text"]))) for word in words[index:right]]
            cursor, total = 0, sum(weights)
            for word, weight in zip(words[index:right], weights):
                word["start"] = start + (end - start) * cursor / total
                cursor += weight
                word["end"] = start + (end - start) * cursor / total
            index = right
    overrides = {}
    if args.cue_windows:
        for item in json.loads(args.cue_windows.read_text(encoding="utf-8-sig")):
            line, start, end = item["line"], item["start"], item["end"]
            if type(line) is not int or not 0 <= line < len(lines) or item["text"] != " ".join(lines[line]["tokens"]):
                raise ValueError("Estimated cue window must match the current supplied line")
            if line in overrides:
                raise ValueError("Duplicate estimated window for one supplied line")
            if not all(isinstance(value, (float, int)) and math.isfinite(value) for value in (start, end)) or not 0 <= start < end <= args.duration:
                raise ValueError("Invalid estimated cue window")
            group = [word for word in words if word["line"] == line]
            weights = [max(1, len(normalized(word["text"]))) for word in group]
            cursor, total = 0, sum(weights)
            for word, weight in zip(group, weights):
                word["start"] = start + (end - start) * cursor / total
                cursor += weight
                word["end"] = start + (end - start) * cursor / total
                word["estimated"] = True
            overrides[line] = item
    if args.estimated_windows_only:
        if set(overrides) != set(range(len(lines))):
            raise ValueError("Estimated-only mode requires one window for every supplied line")
        for index in range(1, len(lines)):
            if overrides[index - 1]["end"] > overrides[index]["start"]:
                raise ValueError("Estimated-only cue windows must follow lyric order without overlap")
    for index, word in enumerate(words):
        if index + 1 < len(words):
            word["end"] = min(word["end"], words[index + 1]["start"])
        word["start"], word["end"] = round(word["start"], 3), round(word["end"], 3)
        if word["end"] <= word["start"]:
            raise ValueError("Collapsed word timing; refine local word anchors")
    cues = []
    for index, line in enumerate(lines):
        group = [word for word in words if word["line"] == index]
        cue = {"start": group[0]["start"], "end": min(args.duration, group[-1]["end"] + .25),
               "text": " ".join(line["tokens"]),
               "words": [{key: word[key] for key in ("text", "start", "end", "estimated")} for word in group],
               "wordTiming": {"method": "manual-window-estimate" if index in overrides else "supplied-text-forced-alignment" if forced else "supplied-text-asr-anchors", "source": args.cue_windows.name if index in overrides else args.timings.name,
                              "matchedWords": sum(not word["estimated"] for word in group),
                              "estimatedWords": sum(word["estimated"] for word in group)}}
        if line["backing"]:
            cue["backing"] = " ".join(line["backing"])
        cues.append(cue)
    for cue, following in zip(cues, cues[1:]):
        cue["end"] = round(min(cue["end"], following["start"]), 3)
        if cue.get("backing") and following["start"] - cue["end"] <= 5:
            cue["end"] = following["start"]
    args.output.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("existing_lyrics", Path(__file__).with_name("prepare-lyrics.py"))
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)
    (args.output / f"{args.name}.json").write_text(json.dumps({"version": 1, "language": "en", "cues": cues}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.output / f"{args.name}-current.vtt").write_text(exporter.native_vtt(cues, show_current=True), encoding="utf-8")
    report = {"source_lyrics": str(args.lyrics), "local_recognition": str(args.timings) if args.timings else None,
              "timing_review": ("All word times estimated from complete explicit cue windows; no vocal recognition or phonetic alignment. User listening review required."
                                if args.estimated_windows_only else "Unreviewed local anchors and explicit interpolation; user listening review required."),
              "cues": len(cues), "matchedWords": sum(not word["estimated"] for word in words),
              "estimatedWords": sum(word["estimated"] for word in words),
              "entry": {"id": args.catalog_id, "lyrics": {"url": f"{args.url_prefix}/{args.name}.json",
                        "vtt": f"{args.url_prefix}/{args.name}-current.vtt", "language": "en", "showCurrent": True, "placement": "bottom"}},
              "cue_bounds": [{"start": cue["start"], "end": cue["end"], "text": cue["text"], **cue["wordTiming"]} for cue in cues]}
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("cues", "matchedWords", "estimatedWords", "entry")}))


if __name__ == "__main__":
    main()
