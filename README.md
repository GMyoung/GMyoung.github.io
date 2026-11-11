# Harvey — Spaces

A browseable homepage with three destinations: the existing Instrumental and Karaoke library, Harvey · 墨间, and MODARIS / Car Game. The library keeps its inline HTML5 player and direct GitHub Pages media hosting.

## Pages

- `/` is the visual Spaces gallery with three original SVG covers, essential title labels and no marketing copy. It does not load a video player or autoplay audio.
- `/karaoke.html` is the existing music library, including search, filters, theater mode and the original/karaoke audio switch. Its header links back to Spaces.
- `/ink/` contains Harvey · 墨间, including its animated introduction, brush writing and lessons.
- `/car-game/?edition=world` contains MODARIS / Car Game. The Tour edition remains available at `/car-game/?edition=tour`.

All three applications are served directly by public GitHub Pages and require no ChatGPT or GitHub login. The former ChatGPT Site URLs are retained only as historical origins in the project records. Browser-local progress and settings remain local to the site's origin; data previously saved under a ChatGPT Site domain does not automatically transfer to this domain.

The portal uses only local HTML, CSS and SVG. Edit `index.template.html` and `portal.css` for the gallery; edit `karaoke.template.html`, `style.css`, `app.js` and `player.js` for the music library. Root-level `karaoke.html` keeps the existing relative catalog, media and audio URLs valid.

## Publishing

GitHub Pages serves `https://gmyoung.github.io/` through the **Publish Harvey Spaces** workflow in `.github/workflows/pages.yml`. Pages must use the **GitHub Actions** publishing source. Every push to `main` builds and stages the public HTML, scripts, styles, catalog, icon, assets, audio, media, `ink/` and `car-game/`, then uploads and deploys the Pages artifact. Source templates and development files are not included in that artifact. The workflow can also be started from Actions with **Run workflow** (or `gh workflow run pages.yml --ref main`); deployments are serialized without canceling a running release.

No stored deployment secrets or server are required. Karaoke serves the pinned, locally vendored hls.js 1.7.4 player; its Apache-2.0 license is alongside it in `assets/vendor/`. The workflow uses Node 24, official GitHub actions pinned to commit IDs, and the job's short-lived GitHub token/OIDC permissions (`contents: read`, `pages: write`, `id-token: write`). Run `node build.mjs` after changing the source files or catalog and before committing. JavaScript and CSS use content-hashed filenames to prevent layout/script mismatches. The mutable video catalog is fetched without cache on page load and window focus, so new videos appear without waiting for page cache expiry. Hashed catalog copies are archival snapshots.

`index.html` and `karaoke.html` are generated together by the build. Portal CSS also uses a content-hashed filename. Old hashed assets remain available for visitors with cached pages; source media, audio and `videos.json` stay at their existing root-relative locations.

The build normalizes text to LF before hashing, so Windows checkouts and the Linux Pages workflow publish identical resource names.

`ink/` and `car-game/` are self-contained published application snapshots, with source provenance and license notices in each directory. Keep their relative/subdirectory asset paths when refreshing them from the original local projects. Never copy a source checkout, `.git`, `.openai`, environment files, private records or credentials into the public application folders. The root build only regenerates the portal and Karaoke pages; it does not overwrite either application snapshot.

## Add a video

Add an entry to `videos.json` with `id`, `title`, `artist`, `type` (`instrumental` or `karaoke`), `duration`, `label`, and a relative MP4 `url` such as `media/example.mp4`. Add `karaoke: true` when an instrumental video already includes synchronized on-screen lyrics. Files must be complete before a playable entry is published. External HTTPS video links can also be used.

For audio switching, add `audio: { "original": "audio/song-original-v1.m4a", "karaoke": "audio/song-karaoke-v1.m4a" }` and `defaultAudio: "original"` or `"karaoke"`. Both files must already be aligned to the video's timeline and padded/trimmed to its length. Entries without these fields retain the native video player, including when a cached catalog predates this feature.

## Theater and audio switching

Open any video. The single button directly below the picture shows the current audio and switches to **original vocals** or **karaoke** with one tap. HLS uses alternate audio renditions in the same media timeline; only the selected rendition downloads. Original MP4 playback uses the existing synchronized audio elements, loading an alternate track on demand and retaining the current track while the replacement prepares. Audio selection does not replace the video source. Play/pause, seeking, volume, mute, playback speed and ending remain synchronized. Escape exits theater without stopping playback. The theater dialog traps keyboard focus; closing returns focus to the song link.

The player uses locally hosted hls.js with native HLS support as a browser fallback; it does not use an external player service. Original MP4 playback remains available after streaming errors or through the Original quality option. Keep the original MP4 audio as the final fallback. Data & Picard's karaoke track is a locally separated accompaniment and may retain separation artifacts.

The website only loads a song's audio after that song is opened. Do not replace a video's source merely to select audio. Version audio filenames and retain older hashed scripts, styles and media so cached pages remain usable during deployment.

## Adaptive delivery and full screen

`streaming.js` manages HLS quality, audio selection, bounded recovery and playback statistics. Catalog `streaming.url` selects the master playlist; `streaming.variants` contains single-level masters for native-browser manual quality selection. Default Auto chooses between 360p and 720p using actual segment delivery and buffer availability. Original selects the retained 720p/1080p MP4 and can require substantially more bandwidth. Native HLS manual quality changes and transitions to/from Original reload the source while restoring the playback position.

The statistics show actual media download estimates and playable buffer seconds. **Check connection** is an optional, bounded request to the selected media host, not a general internet speed test. A result cannot guarantee future bandwidth. This change reduces bandwidth needs and tolerates fluctuations; GitHub Pages reachability, venue Wi-Fi outages and very slow links can still interrupt playback.

`fullscreen.js` requests real browser fullscreen. The picture uses the entire viewport with its original aspect ratio; controls overlay the picture and hide after inactivity. Theater remains a separate in-page layout. Native iPhone video fullscreen may not display custom HTML controls; exit fullscreen to access them.

Generate streaming assets with Python 3.12 and FFmpeg/FFprobe via `py -3.12 scripts/prepare-streaming.py --skip-existing --jobs 2 --threads 4`. The helper creates aligned four-second fragmented MP4 HLS renditions in versioned `media/streams-v1/` and updates the catalog. `--only <catalog-id>` limits a run to one entry; repeat it for several entries. `--ffmpeg`/`--ffprobe` select executable paths and `--logs` selects the log directory. Low-bitrate source videos receive lower bitrate targets so simple artwork is not needlessly enlarged. Do not overwrite a published stream version when changing its encoding or content: use `--output media/streams-v2` (or the next version). Preserve recognized masters, original MP4s, audio, and older asset hashes. Keep the complete published site below GitHub Pages' size limit.

The hls.js bundle is from the official npm `hls.js@1.7.4` package; SHA-256: `cfc70cc9e9fc63d071919e087670abc760c8fd1bc889b88588026e4d22193bbe`. No API key, persistent environment variable or new authentication is required.

## Upcoming lyrics

`lyrics.js` reads versioned cue JSON from `entry.lyrics.url`, preserving the accepted timing of the current sung line. The next lyric appears above the picture's burned-in current lyric; during long instrumental gaps it appears only in the final five seconds before singing. **Next lyric** turns the preview on or off. Odoriko retains both romaji and English. The Die For You instrumental edition also shows the current line, because its original music video has no burned-in karaoke caption.

The preview uses stable, balanced typography, a soft dark scrim and clear current/next hierarchy. Odoriko's English translation is visually secondary to its romaji. Line changes do not bounce, slide or add delays; readable timing takes priority over decorative animation. Burned-in captions remain part of the original picture.

`py -3.12 scripts/prepare-lyrics.py --source-root E:\CodeX\outputs --recovered-root E:\CodeX\outputs\karaoke-adaptive-20261111\lyric-recovery --output assets/lyrics-v1` exports the existing finalized SRT/JSON cues, visually recovered captions, and a mapping in `assets/lyrics-v1/manifest.json`. Each catalog `lyrics` field uses the corresponding mapping. Optional WebVTT files supply the preview in iPhone native video fullscreen, where HTML overlays cannot appear. Browser support for native caption positioning varies.

Bad Bad Water retains its original frame-integrated lyrics as requested. The other seven catalog entries have previews. Hamantha (68 cues, including spoken dialogue) and Nice Boys (18 English cues) were visually recovered from the existing burned captions, not their discarded ASR drafts. Their half-second frame sampling gives approximate line boundaries (about ±0.25s around clear transitions, with more uncertainty during fades), not word timings. Hamantha's captionless video-only insert ranges use the retained base animation's captions on the same timeline. Keep review evidence and original source files local; only compact final cue data is published. User playback remains the final synchronization check.

## Development and requested verification

Work on a feature branch/worktree and keep the published `main` available. `npm ci` installs the development-only browser driver; `npm run dev` serves a loopback preview with HTTP Range support at `http://127.0.0.1:8780`. Runtime pages have no npm dependency. Audio assets can be prepared with `py -3.12 scripts/prepare-audio.py --config <local-source-manifest.json> --output audio`; source manifests stay outside the public repository.

The existing `npm test` scripts target the historical direct-MP4 implementation and are retained as prior evidence; they have not been updated or executed for the HLS/lyric-preview release. Only run functional tests when the user explicitly requests them, and scope the run to that request. Existing reports and desktop/mobile screenshots are retained in ignored `test-results/`. Do not treat old results as validation of current behavior. Playback, soundtrack switching, fullscreen and lyric timing are reviewed manually by the user by default.

After the requested edits, run the necessary syntax checks and `npm run build`, then commit the source and generated asset hashes and merge/push `main`. Functional and playback testing is performed by the user unless explicitly requested. Verify the exact GitHub Pages deployment. Preserve the previous commit as a rollback reference; a later issue can be reverted without rewriting history.

`playlistUrl` retains the optional YouTube playlist URL; `showPlaylist: false` hides it while it is empty. The page, source repository, and direct MP4 files are public. Anyone with a link can watch or reshare them. Robots directives request that search engines do not index this page; they do not provide access control.

Keep each MP4 below GitHub's 100 MiB file limit and the full published site below 1 GB. Web copies use 720p or 1080p H.264/AAC with faststart metadata; full-resolution masters are preserved locally. Guide-vocal and original-vocal sing-along editions are identified in each entry's note. Do not repeatedly replace large video files in Git history. Larger collections should move their media to object storage while retaining this list UI.

All music and video rights belong to their respective creators. Do not put private credentials or source media in this repository.

## Local preview

From this directory, run `py -3.12 -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765`. User performs manual interaction and playback checks.
