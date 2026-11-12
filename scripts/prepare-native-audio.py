"""Prepare single-player HLS with pre-mixed vocals for desktop and mobile.

Reuses published video segments; creates 4-second audio-only fMP4 HLS and small
masters in a fresh media volume directory. Endpoints are lossless AAC remuxes;
20/40/60/80% mixes use the same complementary gains as the legacy player.
Only local files are read. No network, credentials or functional tests.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
from urllib.parse import urljoin, urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
SITE = 'https://gmyoung.github.io/'
VOLUME_URL = SITE + 'karaoke-media-1/'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--volume', type=Path, required=True, help='Existing media repository public directory')
    parser.add_argument('--version', default='native-audio-v2')
    parser.add_argument('--reuse-audio-version', help='Reuse an immutable audio release; generate only new masters')
    parser.add_argument('--report-dir', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=2)
    args = parser.parse_args()
    volume = args.volume.resolve(strict=True)
    if not re.fullmatch(r'[a-z0-9-]+', args.version):
        raise ValueError('Invalid output version')
    if args.reuse_audio_version and not re.fullmatch(r'[a-z0-9-]+', args.reuse_audio_version):
        raise ValueError('Invalid audio reuse version')
    target = volume/'media'/args.version
    if target.exists():
        raise FileExistsError('Use a fresh output version; published audio is immutable')
    args.report_dir.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location('hls_media', ROOT/'scripts/prepare-streaming.py')
    media = importlib.util.module_from_spec(spec); spec.loader.exec_module(media)
    catalog = json.loads((ROOT/'videos.json').read_text(encoding='utf-8-sig'))

    def local(url):
        if url.startswith(VOLUME_URL):
            base, relative = volume, unquote(url[len(VOLUME_URL):])
        elif url.startswith(SITE):
            base, relative = ROOT, unquote(url[len(SITE):])
        else:
            raise ValueError(f'Unexpected media origin: {url}')
        path = (base/relative).resolve(strict=True)
        if not path.is_relative_to(base) or path.is_symlink() or not path.is_file():
            raise ValueError(f'Unsafe media source: {url}')
        return path

    def public(path):
        return VOLUME_URL + path.relative_to(volume).as_posix()

    # Equal source URLs share one set of mixes (including both Die For You rows).
    groups = {}
    for entry in catalog['videos']:
        sources = {name:urljoin(SITE,url) for name,url in entry['audio'].items()}
        key = tuple(sorted(sources.items()))
        if key not in groups:
            groups[key] = {'id':entry['id'], 'sources':sources, 'entries':[]}
        groups[key]['entries'].append(entry)
    target.mkdir(parents=True)
    reports = []

    def prepare(group):
        sources = {name:local(url) for name,url in group['sources'].items()}
        hashes = {name:media.fingerprint(path) for name,path in sources.items()}
        durations = {name:float(media.probe('ffprobe',path)['format']['duration']) for name,path in sources.items()}
        duration = max(durations.values())
        if max(durations.values())-min(durations.values()) > .1:
            raise ValueError(f'Audio timelines differ: {group["id"]}')
        values = [0,20,40,60,80,100] if len(sources)==2 else [0 if 'karaoke' in sources else 100]
        renditions = []
        commands = []
        for value in values:
            if args.reuse_audio_version:
                path = volume/'media'/args.reuse_audio_version/'audio'/group['id']/str(value)/'index.m3u8'
                info = media.playlist_metadata(path)
                if abs(info['duration']-duration) > .15:
                    raise ValueError('Reused audio timeline does not match its source')
                renditions.append({'value':value,'url':public(path),**info})
                continue
            folder = target/'audio'/group['id']/str(value)
            folder.mkdir(parents=True)
            command = ['ffmpeg','-hide_banner','-nostdin','-n','-loglevel','error']
            if value in (0,100):
                name = 'karaoke' if value==0 else 'original'
                command += ['-i',str(sources[name]),'-map','0:a:0','-vn','-c:a','copy']
            else:
                gain = value/100
                command += ['-i',str(sources['karaoke']),'-i',str(sources['original']),
                    '-filter_complex',f'[0:a]volume={1-gain:.2f}[k];[1:a]volume={gain:.2f}[o];[k][o]amix=inputs=2:normalize=0:duration=longest[a]',
                    '-map','[a]','-vn','-c:a','aac','-b:a','160k','-ar','44100','-ac','2','-threads','2']
            command += ['-map_metadata','-1','-t',str(duration),'-f','hls','-hls_time','4',
                '-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4',
                '-hls_segment_filename','segment-%04d.m4s','index.m3u8']
            with (args.report_dir/f'{group["id"]}-{value}.log').open('w',encoding='utf-8') as log:
                subprocess.run(command,cwd=folder,check=True,stdout=log,stderr=subprocess.STDOUT)
            info = media.playlist_metadata(folder/'index.m3u8')
            if abs(info['duration']-duration) > .15:
                raise ValueError('Unexpected audio timeline after packaging')
            renditions.append({'value':value,'url':public(folder/'index.m3u8'),**info})
            commands.append(command)
        if hashes != {name:media.fingerprint(path) for name,path in sources.items()}:
            raise ValueError('A source changed during production')
        print(f'Prepared {group["id"]}: {len(values)} native audio levels',flush=True)
        return group,renditions,{'id':group['id'],'sources':group['sources'],'sourceHashes':hashes,'duration':duration,'audio':renditions,'commands':commands}

    mappings = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for group, audio, report in pool.map(prepare, groups.values()):
            reports.append(report)
            for entry in group['entries']:
                # Follow each existing single-quality master to its media playlist.
                videos = []
                for variant in entry['streaming']['videoOnly']['variants']:
                    master_url = urljoin(SITE,variant['url'])
                    text = local(master_url).read_text(encoding='utf-8-sig')
                    line = next(x for x in text.splitlines() if x.startswith('#EXT-X-STREAM-INF:'))
                    leaf = next(x for x in text.splitlines() if x and not x.startswith('#'))
                    leaf_url = urljoin(master_url,leaf)
                    info = media.playlist_metadata(local(leaf_url))
                    init_name = re.search(r'URI="([^"]+)"',local(leaf_url).read_text(encoding='utf-8')).group(1)
                    codec = media.avc_configuration(local(urljoin(leaf_url,init_name)))['codec']
                    size = re.search(r'RESOLUTION=([0-9]+x[0-9]+)',line).group(1)
                    fps = re.search(r'FRAME-RATE=([0-9.]+)',line).group(1)
                    videos.append({'url':leaf_url,'height':variant['height'],'resolution':size,'fps':fps,'codec':codec,**info})
                mixes = []
                for sound in audio:
                    folder = target/entry['id']/str(sound['value']);folder.mkdir(parents=True)
                    header = ['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-INDEPENDENT-SEGMENTS']
                    for alternate in audio:
                        selected = 'YES' if alternate['value']==sound['value'] else 'NO'
                        header.append(f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Vocals {alternate["value"]}%",DEFAULT={selected},AUTOSELECT={selected},CHANNELS="2",URI="{alternate["url"]}"')
                    lines, variants = [], []
                    for video in videos:
                        bandwidth = math.ceil((video['peakBandwidth']+max(x['peakBandwidth'] for x in audio))*1.05/1000)*1000
                        average = video['averageBandwidth']+max(x['averageBandwidth'] for x in audio)
                        line = f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},AVERAGE-BANDWIDTH={average},RESOLUTION={video["resolution"]},FRAME-RATE={video["fps"]},CODECS="{video["codec"]},mp4a.40.2",AUDIO="sound"'
                        pair = [line,video['url']];lines.extend(pair)
                        path = folder/f'{video["height"]}p.m3u8';path.write_text('\n'.join(header+pair)+'\n',encoding='utf-8')
                        variants.append({'height':video['height'],'bandwidth':bandwidth,'url':public(path)})
                    path = folder/'master.m3u8';path.write_text('\n'.join(header+lines)+'\n',encoding='utf-8')
                    mixes.append({'value':sound['value'],'url':public(path),'variants':variants})
                mappings.append({'id':entry['id'],'integrated':{'mixStep':20,'switching':'alternate-audio','mixes':mixes}})
    files = [p for p in target.rglob('*') if p.is_file()]
    receipt = {'output':str(target),'entries':len(mappings),'audioGroups':len(groups),'files':len(files),
        'bytes':sum(p.stat().st_size for p in files),'sources':reports,
        'scope':'Actual audio production and saved metadata only; no functional or playback tests.'}
    (args.report_dir/'native-audio-production.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    (args.report_dir/'integrated-entries.json').write_text(json.dumps(mappings,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:receipt[k] for k in ('entries','audioGroups','files','bytes')}),flush=True)


if __name__=='__main__':
    main()
