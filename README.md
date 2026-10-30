# Instrumental Room

A compact English list of Instrumental and Karaoke videos with an inline HTML5 player. Videos are hosted directly by GitHub Pages.

## Publishing

GitHub Pages serves the repository root at `https://gmyoung.github.io/`. No third-party dependencies, secrets, or server are required. Run `node build.mjs` after changing the source files or catalog and before committing. JavaScript and CSS use content-hashed filenames to prevent layout/script mismatches. The mutable video catalog is fetched without cache on page load and window focus, so new videos appear without waiting for page cache expiry. Hashed catalog copies are archival snapshots.

Edit `index.template.html` for layout changes. `index.html` is generated. Old hashed assets remain available for visitors with cached pages.

## Add a video

Add an entry to `videos.json` with `id`, `title`, `artist`, `type` (`instrumental` or `karaoke`), `duration`, `label`, and a relative MP4 `url` such as `media/example.mp4`. Add `karaoke: true` when an instrumental video already includes synchronized on-screen lyrics. Files must be complete before a playable entry is published. External HTTPS video links can also be used.

For audio switching, add `audio: { "original": "audio/song-original-v1.m4a", "karaoke": "audio/song-karaoke-v1.m4a" }` and `defaultAudio: "original"` or `"karaoke"`. Both files must already be aligned to the video's timeline and padded/trimmed to its length. Entries without these fields retain the native video player, including when a cached catalog predates this feature.

## Theater and audio switching

Open any video, then choose **Theater mode**. **Original vocals** and **Karaoke** switch between synchronized audio elements while retaining the same video element, source, frame stream, and playback position. The unused audio remains silent and ready; switching applies a short audio fade. Play/pause, seeking, volume, mute, playback speed and ending are synchronized. Escape exits theater without stopping playback. The theater dialog traps keyboard focus; closing returns focus to the song link.

The player uses no third-party runtime or external player service. If alternate audio cannot load, the current audio continues; if the active audio fails, native playback of the MP4 remains available. Keep the original MP4 audio as this fallback. Data & Picard's karaoke track is a locally separated accompaniment and may retain separation artifacts.

The website only loads a song's audio after that song is opened. Do not replace a video's source merely to select audio. Version audio filenames and retain older hashed scripts, styles and media so cached pages remain usable during deployment.

## Development and requested verification

Work on a feature branch/worktree and keep the published `main` available. `npm ci` installs the development-only browser driver; `npm run dev` serves a loopback preview with HTTP Range support at `http://127.0.0.1:8780`. Runtime pages have no npm dependency. Audio assets can be prepared with `py -3.12 scripts/prepare-audio.py --config <local-source-manifest.json> --output audio`; source manifests stay outside the public repository.

When the user explicitly requests functional verification, run `npm test` against the preview with installed Google Chrome. It covers every catalog item, continuous video frames while switching, rapid switches, seeking, paused switches, volume/mute/rate, theater focus and responsive layout, full screen, end of playback, unavailable alternate audio, and cached legacy catalogs. Reports and desktop/mobile screenshots are written to ignored `test-results/`. `--core-only` is a development subset, not a release pass. Do not run functional tests by default without user authorization.

After the complete release pass succeeds, run `npm run build`, commit the tested source and generated asset hashes, then merge/push `main`. Verify the exact GitHub Pages deployment and published catalog. Preserve the previous commit as a rollback reference; a later issue can be reverted without rewriting history.

`playlistUrl` retains the optional YouTube playlist URL; `showPlaylist: false` hides it while it is empty. The page, source repository, and direct MP4 files are public. Anyone with a link can watch or reshare them. Robots directives request that search engines do not index this page; they do not provide access control.

Keep each MP4 below GitHub's 100 MiB file limit and the full published site below 1 GB. Web copies use 720p or 1080p H.264/AAC with faststart metadata; full-resolution masters are preserved locally. Guide-vocal and original-vocal sing-along editions are identified in each entry's note. Do not repeatedly replace large video files in Git history. Larger collections should move their media to object storage while retaining this list UI.

All music and video rights belong to their respective creators. Do not put private credentials or source media in this repository.

## Local preview

From this directory, run `py -3.12 -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765`. User performs manual interaction and playback checks.
