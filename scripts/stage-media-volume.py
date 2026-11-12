"""Stage selected local media for a separate public media volume.

Usage (from any directory):
  py -3.12 scripts/stage-media-volume.py --catalog <prepared-catalog.json>
    --only <song-id> [--only <song-id> ...] --volume-root <public-directory>
    --base-url https://example.com/karaoke-media-1/
    --output-entries <new-entries.json> --report <new-report.json>

Sources resolve against this script's repository, not the catalog location.
Only reachable media/ and audio/ files are copied: entry video/audio URLs and
HLS playlists, their relative URI attributes, initialization files and segments.
Posters and lyrics remain unchanged on the main site. Unreferenced master MP4s,
rendition metadata and source manifests are not copied. No network requests,
credentials, environment variables or third-party packages are required.

Source/destination symlinks and junctions, external dependencies, unsafe paths
and nonidentical existing destinations are rejected. Identical files are reused.
Nothing is deleted or overwritten. Interrupted copies remain for inspection;
use a fresh destination or resolve them manually before retrying. Output JSON
must stay outside the public volume and cannot replace the input catalog.
"""
import argparse
from collections import deque
import copy
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import stat
from urllib.parse import quote, unquote, urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
URI_ATTRIBUTES = re.compile(r'(?:^|,)\s*([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))\s*(?=,|$)', re.I)
PLAYLIST_SUFFIXES = {'.m3u8', '.m3u'}
MEDIA_SUFFIXES = PLAYLIST_SUFFIXES | {'.mp4', '.m4s', '.m4a', '.aac', '.ts', '.vtt', '.key'}
UNSAFE = re.compile(r'[\x00-\x1f\x7f\\]')


def absolute(value):
    return Path(os.path.abspath(value))


def no_links(path):
    for part in [*reversed(path.parents), path]:
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise ValueError(f'Symlink/junction not allowed: {part}')
        if part != path and part.exists() and not part.is_dir():
            raise ValueError(f'Parent path is not a directory: {part}')


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def snapshot(path):
    no_links(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f'Expected a regular file: {path}')
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def media_path(value, playlist=None, directory=None):
    if not isinstance(value, str) or not value.strip() or UNSAFE.search(value) or '{$' in value:
        raise ValueError(f'Unsafe media reference: {value!r}')
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        raise ValueError(f'External media dependencies are not staged: {value}')
    decoded = unquote(parsed.path, errors='strict')
    if not decoded or UNSAFE.search(decoded) or ':' in decoded:
        raise ValueError(f'Unsafe decoded media path: {value}')
    if playlist and decoded.startswith('/'):
        raise ValueError(f'HLS dependencies must be relative to their playlist: {value}')
    relative = posixpath.normpath(posixpath.join(posixpath.dirname(playlist) if playlist else '', decoded.lstrip('/')))
    parts = relative.split('/')
    if len(parts) < 2 or parts[0] not in ({directory} if directory else {'media', 'audio'}):
        raise ValueError(f'Media reference leaves allowed source directories: {value}')
    path = ROOT.joinpath(*parts)
    no_links(path)
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(ROOT / parts[0]) or resolved.suffix.lower() not in MEDIA_SUFFIXES:
        raise ValueError(f'Unsupported or escaping media dependency: {value}')
    snapshot(resolved)
    return relative, parsed.query, parsed.fragment


def base_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment or UNSAFE.search(value)):
        raise ValueError('--base-url must be an HTTPS directory URL without credentials, query or fragment.')
    decoded = unquote(parsed.path, errors='strict')
    if UNSAFE.search(decoded) or '..' in decoded.split('/'):
        raise ValueError('Unsafe base URL directory.')
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/') + '/', '', ''))


def checked_destination(path, expected=None):
    no_links(path)
    if path.exists():
        snapshot(path)
        if expected is not None and fingerprint(path) != expected:
            raise ValueError(f'Existing destination differs; nothing will overwrite it: {path}')


def save_new(path, content):
    expected = hashlib.sha256(content).hexdigest()
    checked_destination(path, expected)
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    no_links(path)
    with path.open('xb') as stream:
        stream.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--catalog', required=True, type=absolute)
    parser.add_argument('--only', required=True, action='append', help='Catalog ID to stage; repeat for multiple songs')
    parser.add_argument('--volume-root', required=True, type=absolute)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--output-entries', required=True, type=absolute)
    parser.add_argument('--report', required=True, type=absolute)
    args = parser.parse_args()
    public_base = base_url(args.base_url)
    for path in [args.catalog, args.volume_root, args.output_entries, args.report]:
        no_links(path)
    volume = args.volume_root.resolve()
    if volume == Path(volume.anchor) or volume == ROOT or volume.is_relative_to(ROOT) or ROOT.is_relative_to(volume):
        raise ValueError('The public volume must be outside this repository, not its ancestor or a filesystem root.')
    for path in [args.output_entries, args.report]:
        if path.resolve().is_relative_to(volume) or path.resolve() == args.catalog.resolve():
            raise ValueError('Output JSON must be outside the public volume and cannot replace the input catalog.')
    if args.output_entries.resolve() == args.report.resolve():
        raise ValueError('Output entries and report must use different paths.')
    snapshot(args.catalog)
    catalog_bytes = args.catalog.read_bytes()
    catalog = json.loads(catalog_bytes.decode('utf-8-sig'))
    videos = catalog.get('videos') if isinstance(catalog, dict) else None
    if not isinstance(videos, list):
        raise ValueError('Catalog must contain a videos array.')
    if any(not isinstance(entry, dict) or not isinstance(entry.get('id'), str) for entry in videos):
        raise ValueError('Each catalog entry must be an object with a string ID.')
    wanted = set(args.only)
    if any(not re.fullmatch(r'[A-Za-z0-9_-]+', value) for value in wanted):
        raise ValueError('Invalid requested catalog ID.')
    selected = [copy.deepcopy(entry) for entry in videos if entry['id'] in wanted]
    if len(selected) != len(wanted) or {entry['id'] for entry in selected} != wanted:
        raise ValueError('Each requested catalog ID must exist exactly once.')
    pending = deque()

    def rewrite(value, directory):
        relative, query, fragment = media_path(value, directory=directory)
        pending.append(relative)
        return public_base + quote(relative, safe='/') + ('?' + query if query else '') + ('#' + fragment if fragment else '')

    def descriptor(value):
        if not isinstance(value, dict):
            raise ValueError('Streaming descriptors must be objects.')
        value['url'] = rewrite(value.get('url'), 'media')
        variants = value.get('variants', [])
        if not isinstance(variants, list):
            raise ValueError('Streaming variants must be an array.')
        for variant in variants:
            if not isinstance(variant, dict):
                raise ValueError('Invalid streaming variant.')
            variant['url'] = rewrite(variant.get('url'), 'media')
        if 'videoOnly' in value:
            descriptor(value['videoOnly'])

    for entry in selected:
        entry['url'] = rewrite(entry.get('url'), 'media')
        if 'audio' in entry:
            if not isinstance(entry['audio'], dict):
                raise ValueError('Entry audio must be an object of local soundtrack URLs.')
            entry['audio'] = {name: rewrite(value, 'audio') for name, value in entry['audio'].items()}
        if 'streaming' in entry:
            descriptor(entry['streaming'])

    files = {}
    while pending:
        relative = pending.popleft()
        if relative in files:
            continue
        path = ROOT / relative
        before = snapshot(path)
        digest = fingerprint(path)
        if snapshot(path) != before:
            raise ValueError(f'Source changed while planning: {relative}')
        files[relative] = {'snapshot': before, 'sha256': digest}
        if path.suffix.lower() in PLAYLIST_SUFFIXES:
            text = path.read_text(encoding='utf-8-sig')
            if not text.lstrip().startswith('#EXTM3U'):
                raise ValueError(f'Invalid HLS playlist: {relative}')
            for raw in text.splitlines():
                line = raw.strip()
                if not line:
                    continue
                if not line.startswith('#'):
                    pending.append(media_path(line, playlist=relative)[0])
                elif ':' in line:
                    for match in URI_ATTRIBUTES.finditer(line.split(':', 1)[1]):
                        if match[1].upper() == 'URI' or match[1].upper().endswith('-URI'):
                            pending.append(media_path(match[2] if match[2] is not None else match[3].strip(), playlist=relative)[0])

    manifest = '\n'.join(f'{name}\t{item["snapshot"][2]}\t{item["sha256"]}' for name, item in sorted(files.items()))
    report = {'volumeRoot': str(volume), 'baseUrl': public_base, 'entryIds': [entry['id'] for entry in selected],
              'files': len(files), 'bytes': sum(item['snapshot'][2] for item in files.values()),
              'audioFiles': sum(name.startswith('audio/') for name in files),
              'manifestSha256': hashlib.sha256(manifest.encode('utf-8')).hexdigest(),
              'catalogSha256': hashlib.sha256(catalog_bytes).hexdigest(),
              'scope': 'Reachable media/audio only; posters and lyrics remain on the main site. No network access.'}
    output_bytes = (json.dumps(selected, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    report_bytes = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    # Preflight all destinations before any copy or output write.
    for relative, item in files.items():
        target = volume / relative
        if not target.resolve().is_relative_to(volume):
            raise ValueError(f'Destination escapes the public volume: {relative}')
        checked_destination(target, item['sha256'])
    checked_destination(args.output_entries, hashlib.sha256(output_bytes).hexdigest())
    checked_destination(args.report, hashlib.sha256(report_bytes).hexdigest())
    copied = reused = 0
    volume.mkdir(parents=True, exist_ok=True)
    no_links(volume)
    for relative, item in files.items():
        source, target = ROOT / relative, volume / relative
        if snapshot(source) != item['snapshot']:
            raise ValueError(f'Source changed before copying: {relative}')
        checked_destination(target, item['sha256'])
        if target.exists():
            reused += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        no_links(target)
        with source.open('rb') as src, target.open('xb') as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        if snapshot(source) != item['snapshot'] or fingerprint(target) != item['sha256']:
            raise ValueError(f'Source/copy changed during staging; inspect partial output: {relative}')
        copied += 1
    save_new(args.output_entries, output_bytes)
    save_new(args.report, report_bytes)
    print(json.dumps({**report, 'copiedFiles': copied, 'reusedFiles': reused}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, UnicodeError) as error:
        raise SystemExit(f'Media staging stopped: {error}') from error
