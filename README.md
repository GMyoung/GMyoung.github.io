# Harvey — Spaces

A browseable homepage with three destinations: the existing Instrumental and Karaoke library, Harvey · 墨间, and MODARIS / Car Game. The library keeps its inline HTML5 player and direct GitHub Pages media hosting.

## Pages

- `/` is the visual Spaces gallery with three original SVG covers, essential title labels and no marketing copy. It does not load a video player or autoplay audio.
- `/karaoke.html` is the music library, including search, filters, adaptive quality, full screen and an adjustable original-vocals mix. Its header links back to Spaces.
- `/ink/` contains Harvey · 墨间, including its animated introduction, brush writing and lessons.
- `/car-game/?edition=world` contains MODARIS / Car Game. The Tour edition remains available at `/car-game/?edition=tour`.

All three applications are served directly by public GitHub Pages and require no ChatGPT or GitHub login. The former ChatGPT Site URLs are retained only as historical origins in the project records. Browser-local progress and settings remain local to the site's origin; data previously saved under a ChatGPT Site domain does not automatically transfer to this domain.

The portal uses only local HTML, CSS and SVG. Edit `index.template.html` and `portal.css` for the gallery; edit `karaoke.template.html`, `style.css`, `app.js`, `player.js`, `streaming.js`, `fullscreen.js` and `lyrics.js` for the music library. Root-level `karaoke.html` keeps the existing relative catalog, media and audio URLs valid.

## Publishing

GitHub Pages serves `https://gmyoung.github.io/` through the **Publish Harvey Spaces** workflow in `.github/workflows/pages.yml`. Pages must use the **GitHub Actions** publishing source. Every push to `main` builds and stages the public HTML, scripts, styles, catalog, icon, assets, audio, active media, `ink/` and `car-game/`, then uploads and deploys the Pages artifact. `scripts/stage-site.mjs` follows the current catalog's video and HLS references, including variant playlists, audio playlists and initialization/media segments. Unreferenced media and source/development files are not included. The workflow can also be started from Actions with **Run workflow** (or `gh workflow run pages.yml --ref main`); deployments are serialized without canceling a running release.

No stored deployment secrets or server are required. Karaoke serves the pinned, locally vendored hls.js 1.7.4 player; its Apache-2.0 license is alongside it in `assets/vendor/`. The workflow uses Node 24, official GitHub actions pinned to commit IDs, and the job's short-lived GitHub token/OIDC permissions (`contents: read`, `pages: write`, `id-token: write`). Run `node build.mjs` after changing the source files or catalog and before committing. JavaScript and CSS use content-hashed filenames to prevent layout/script mismatches. The mutable video catalog is fetched without cache on page load and window focus, so new videos appear without waiting for page cache expiry. Hashed catalog copies are archival snapshots.

`index.html` and `karaoke.html` are generated together by the build. Portal CSS also uses a content-hashed filename. Old hashed assets remain available for visitors with cached pages; the app fetches the current `videos.json`. Replaced media remains in the repository/local archives, but unreferenced old media URLs are no longer included in Pages. Reload an old open player after this migration so it reads the active catalog.

To produce the public artifact locally after building, run `node scripts/stage-site.mjs --output <new-empty-directory-outside-checkout>`. The helper does not fetch remote files, delete directories or overwrite existing files. It rejects missing media, local media references outside `media/`, symlinks, nonempty destinations and an artifact of 1,000,000,000 bytes or more. Its JSON output records file count and size. The same artifact construction runs in Actions; it is not a playback test.

The build normalizes text to LF before hashing, so Windows checkouts and the Linux Pages workflow publish identical resource names.

`ink/` and `car-game/` are self-contained published application snapshots, with source provenance and license notices in each directory. Keep their relative/subdirectory asset paths when refreshing them from the original local projects. Never copy a source checkout, `.git`, `.openai`, environment files, private records or credentials into the public application folders. The root build only regenerates the portal and Karaoke pages; it does not overwrite either application snapshot.

## Add a video

Add an entry to `videos.json` with `id`, `title`, `artist`, `type` (`instrumental` or `karaoke`), `duration`, `label`, and a relative MP4 `url` such as `media/example.mp4`. Add `karaoke: true` when an instrumental video already includes synchronized on-screen lyrics. Files must be complete before a playable entry is published. External HTTPS video links can also be used.

For vocal mixing, add `audio: { "original": "audio/song-original-v1.m4a", "karaoke": "audio/song-karaoke-v1.m4a" }` and `defaultAudio: "original"` or `"karaoke"`. Both files must already be aligned to the video's timeline and padded/trimmed to its length. The original file contains the complete original soundtrack, including its backing music. Entries without separate audio use their video's included audio and do not offer the mix slider.

## Vocal mix and volume

The **Vocals** slider sits after the master volume control. At 0% it plays karaoke; at 100% it plays the original soundtrack. Intermediate values use a complementary linear blend: 40% means 60% karaoke plus 40% original. This blends two complete soundtracks rather than adjusting an isolated vocal stem. Master volume and mute apply independently to the resulting mix. The button below the picture remains a shortcut to the 0% and 100% endpoints.

Both HLS and Original MP4 playback use the same external M4A audio elements. Web Audio creates one cached source/gain-node pair per audio element and reuses it across songs; gain changes are smoothed briefly to avoid clicks. Browsers without usable Web Audio fall back to media-element volume where supported. The slider is unavailable when the browser cannot independently control both tracks, or when a required track is unavailable.

Only tracks needed by the current or requested mix are loaded: one at an endpoint, both for an intermediate blend. A new track is prepared before replacing the current mix; returning to an endpoint releases the unused track. Audio selection does not replace the picture source. Playback, seeking and rate changes follow the video's clock with drift corrections, but separate media-element clocks are not sample-accurate. Track alignment, separation artifacts, phase differences and the perceived balance need the user's listening review. Data & Picard's karaoke file is a locally separated accompaniment and may retain artifacts.

Original MP4 playback remains available after streaming errors or through the Original quality option. Its embedded audio is retained as a final fallback if separate audio cannot load. Version audio filenames and preserve older scripts, styles and media so cached pages remain usable during deployment.

## Adaptive delivery and full screen

`streaming.js` manages HLS picture quality, bounded recovery and playback statistics. Catalog `streaming.videoOnly` contains a master `url` and single-level `variants` without an HLS audio group. These reuse the existing video fragments and avoid downloading an embedded soundtrack while the external M4A mix plays. Legacy `streaming.url` and `streaming.variants` remain for older clients; the new player prefers `videoOnly`.

Default Auto chooses between 360p and 720p using actual segment delivery and buffer availability. Original selects the retained 720p/1080p MP4 and can require substantially more bandwidth. Native HLS manual quality changes and transitions to/from Original reload the picture source while restoring the playback position and mix.

The statistics show actual media download estimates and playable buffer seconds. **Check connection** is an optional, bounded request to the selected media host, not a general internet speed test. A result cannot guarantee future bandwidth. This change reduces bandwidth needs and tolerates fluctuations; GitHub Pages reachability, venue Wi-Fi outages and very slow links can still interrupt playback.

`fullscreen.js` requests fullscreen for the entire player, preserving the vocal slider and other controls. The picture uses the viewport with its original aspect ratio; controls overlay it and hide after inactivity. There is no theater mode. A browser must support element fullscreen to use this feature. The player does not fall back to native video-only fullscreen, which would omit the mix controls and cannot reliably preserve separate audio playback.

Generate streaming assets with Python 3.12 and FFmpeg/FFprobe via `py -3.12 scripts/prepare-streaming.py --skip-existing --jobs 2 --threads 4`. The helper creates aligned four-second fragmented MP4 HLS renditions in versioned `media/streams-v1/` and updates the catalog. `--only <catalog-id>` limits a run to one entry; repeat it for several entries. `--ffmpeg`/`--ffprobe` select executable paths and `--logs` selects the log directory. Low-bitrate source videos receive lower bitrate targets so simple artwork is not needlessly enlarged. Do not overwrite a published stream version when changing its encoding or content: use `--output media/streams-v2` (or the next version). Preserve recognized masters, original MP4s, audio, and older asset hashes. Keep the complete published site below GitHub Pages' size limit.

For already prepared renditions, run `py -3.12 scripts/prepare-streaming.py --manifests-only`. It reads each saved `renditions.json`, adds `video-only.m3u8` and the single-level video-only masters, then updates `streaming.videoOnly` in the catalog. It does not transcode, duplicate fragments or replace the legacy audio-group masters.

The hls.js bundle is from the official npm `hls.js@1.7.4` package; SHA-256: `cfc70cc9e9fc63d071919e087670abc760c8fd1bc889b88588026e4d22193bbe`. No API key, persistent environment variable or new authentication is required.

## Upcoming lyrics

`lyrics.js` reads versioned cue JSON from `entry.lyrics.url`, preserving the accepted timing of the current sung line. Both Die For You entries, Data & Picard, She's a Big Boy and Odoriko use clean source pictures with one external subtitle layer at the bottom: a larger current line and a smaller next line. Set `lyrics.showCurrent: true` and `lyrics.placement: "bottom"` for this layout. Fullscreen captions move above visible controls. **Lyrics** toggles the entire overlay. Other entries retain their previous burned-in current captions and upper **Next lyric** preview; during long instrumental gaps the preview appears only in the final five seconds before singing.

The overlay uses stable, balanced typography, a soft dark scrim and clear current/next hierarchy. Odoriko's current English translation is visually secondary to its romaji; the next-line preview prioritizes the upcoming romanization. Line changes do not bounce, slide or add delays. Identical current/next refrains appear once in the bottom layout.

The five converted entries use `assets/lyrics-v2/`. Odoriko's eight post-chorus backing responses belong to the same timed cue as the lead and appear beneath it, before the English translation. Refrains and ad-libs with identical romaji/English text appear once. Its second line follows the user's supplied display text, `Koto wa hitotsu tatsu uiteiru kedo`, in the versioned local cue source. Keep the existing primary-line timeline: the source caption and acoustic word timings disagree at some boundaries and are not sufficient evidence to retime the song automatically.

Regenerate the active external subtitles with `py -3.12 scripts/prepare-lyrics.py --source-root E:\CodeX\outputs --odoriko-source E:\CodeX\outputs\odoriko-lyrics-20261111\bilingual-cues.json --output assets/lyrics-v2 --url-prefix assets/lyrics-v2 --only odoriko --only die-for-you --only data-and-picard --only shes-a-big-boy --show-current odoriko-bilingual-karaoke --show-current die-for-you --show-current die-for-you-karaoke --show-current data-and-picard-lyrics --show-current shes-a-big-boy-karaoke`. `--only` selects source names and loads only those sources; `--show-current` selects catalog IDs for current-plus-next WebVTT. Update catalog URLs from the generated manifest and retain `placement: "bottom"`.

`py -3.12 scripts/prepare-lyrics.py --source-root E:\CodeX\outputs --recovered-root E:\CodeX\outputs\karaoke-adaptive-20261111\lyric-recovery --output assets/lyrics-v1` exports the existing finalized SRT/JSON cues, visually recovered captions, and a mapping in `assets/lyrics-v1/manifest.json`. Each catalog `lyrics` field uses the corresponding mapping. Element fullscreen retains the HTML lyric preview. Optional WebVTT files remain as compatibility assets for native video fullscreen entered outside the custom fullscreen control; browser support for their positioning varies.

Bad Bad Water retains its original frame-integrated lyrics as requested. The other seven catalog entries have previews. Hamantha (68 cues, including spoken dialogue) and Nice Boys (18 English cues) were visually recovered from the existing burned captions, not their discarded ASR drafts. Their half-second frame sampling gives approximate line boundaries (about ±0.25s around clear transitions, with more uncertainty during fades), not word timings. Hamantha's captionless video-only insert ranges use the retained base animation's captions on the same timeline. Keep review evidence and original source files local; only compact final cue data is published. User playback remains the final synchronization check.

## Development and requested verification

Work on a feature branch/worktree and keep the published `main` available. `npm ci` installs the development-only browser driver; `npm run dev` serves a loopback preview with HTTP Range support at `http://127.0.0.1:8780`. Runtime pages have no npm dependency. Audio assets can be prepared with `py -3.12 scripts/prepare-audio.py --config <local-source-manifest.json> --output audio`; source manifests stay outside the public repository.

The existing `npm test` scripts target the historical direct-MP4 implementation and are retained as prior evidence; they have not been updated or executed for the current HLS, lyric-preview and vocal-mix architecture. Only run functional tests when the user explicitly requests them, and scope the run to that request. Existing reports and desktop/mobile screenshots are retained in ignored `test-results/`. Do not treat old results as validation of current behavior. Playback, vocal balance, synchronization, fullscreen and lyric timing are reviewed manually by the user by default.

After the requested edits, run the necessary syntax checks and `npm run build`, then commit the source and generated asset hashes and merge/push `main`. Functional and playback testing is performed by the user unless explicitly requested. Verify the exact GitHub Pages deployment. Preserve the previous commit as a rollback reference; a later issue can be reverted without rewriting history.

`playlistUrl` retains the optional YouTube playlist URL; `showPlaylist: false` hides it while it is empty. The page, source repository, and direct MP4 files are public. Anyone with a link can watch or reshare them. Robots directives request that search engines do not index this page; they do not provide access control.

Keep each MP4 below GitHub's 100 MiB file limit and the full published site below 1 GB. Web copies use 720p or 1080p H.264/AAC with faststart metadata; full-resolution masters are preserved locally. Guide-vocal and original-vocal sing-along editions are identified in each entry's note. Do not repeatedly replace large video files in Git history. Larger collections should move their media to object storage while retaining this list UI.

All music and video rights belong to their respective creators. Do not put private credentials or source media in this repository.

## Local preview

From this directory, run `py -3.12 -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765`. User performs manual interaction and playback checks.
