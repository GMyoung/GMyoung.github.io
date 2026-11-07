# Harvey — Spaces

A browseable homepage with three destinations: the existing Instrumental and Karaoke library, Harvey · 墨间, and MODARIS / Car Game. The library keeps its inline HTML5 player and direct GitHub Pages media hosting.

## Pages

- `/` is the visual Spaces gallery with three original SVG covers, essential title labels and no marketing copy. It does not load a video player or autoplay audio.
- `/karaoke.html` is the existing music library, including search, filters, theater mode and the original/karaoke audio switch. Its header links back to Spaces.
- `/ink/` contains Harvey · 墨间, including its animated introduction, brush writing and lessons. The car icon enters `/car-game/?edition=world`.
- `/car-game/?edition=world` contains MODARIS / Car Game. The Tour edition remains available at `/car-game/?edition=tour`.

All three applications are served directly by public GitHub Pages and require no ChatGPT or GitHub login. The former ChatGPT Site URLs are retained only as historical origins in the project records. Browser-local progress and settings remain local to the site's origin; data previously saved under a ChatGPT Site domain does not automatically transfer to this domain.

The portal uses only local HTML, CSS and SVG. Edit `index.template.html` and `portal.css` for the gallery; edit `karaoke.template.html`, `style.css`, `app.js` and `player.js` for the music library. Root-level `karaoke.html` keeps the existing relative catalog, media and audio URLs valid.

## Publishing

GitHub Pages serves `https://gmyoung.github.io/` through the **Publish Harvey Spaces** workflow in `.github/workflows/pages.yml`. Pages must use the **GitHub Actions** publishing source. Every push to `main` builds and stages the public HTML, scripts, styles, catalog, icon, assets, audio, media, `ink/` and `car-game/`, then uploads and deploys the Pages artifact. Source templates and development files are not included in that artifact. The workflow can also be started from Actions with **Run workflow** (or `gh workflow run pages.yml --ref main`); deployments are serialized without canceling a running release.

No third-party runtime dependencies, stored deployment secrets, or server are required. The workflow uses Node 24, official GitHub actions pinned to commit IDs, and the job's short-lived GitHub token/OIDC permissions (`contents: read`, `pages: write`, `id-token: write`). Run `node build.mjs` after changing the source files or catalog and before committing. JavaScript and CSS use content-hashed filenames to prevent layout/script mismatches. The mutable video catalog is fetched without cache on page load and window focus, so new videos appear without waiting for page cache expiry. Hashed catalog copies are archival snapshots.

`index.html` and `karaoke.html` are generated together by the build. Portal CSS also uses a content-hashed filename. Old hashed assets remain available for visitors with cached pages; source media, audio and `videos.json` stay at their existing root-relative locations.

`ink/` and `car-game/` are self-contained published application snapshots, with source provenance and license notices in each directory. Keep their relative/subdirectory asset paths when refreshing them from the original local projects. Never copy a source checkout, `.git`, `.openai`, environment files, private records or credentials into the public application folders. The root build only regenerates the portal and Karaoke pages; it does not overwrite either application snapshot.

## Add a video

Add an entry to `videos.json` with `id`, `title`, `artist`, `type` (`instrumental` or `karaoke`), `duration`, `label`, and a relative MP4 `url` such as `media/example.mp4`. Add `karaoke: true` when an instrumental video already includes synchronized on-screen lyrics. Files must be complete before a playable entry is published. External HTTPS video links can also be used.

For audio switching, add `audio: { "original": "audio/song-original-v1.m4a", "karaoke": "audio/song-karaoke-v1.m4a" }` and `defaultAudio: "original"` or `"karaoke"`. Both files must already be aligned to the video's timeline and padded/trimmed to its length. Entries without these fields retain the native video player, including when a cached catalog predates this feature.

## Theater and audio switching

Open any video. The single button directly below the picture shows the current audio and switches to **original vocals** or **karaoke** with one tap, in both the normal player and **Theater mode**. It switches between synchronized audio elements while retaining the same video element, source, frame stream, and playback position. The unused audio remains silent and ready; switching applies a short audio fade. Play/pause, seeking, volume, mute, playback speed and ending are synchronized. Escape exits theater without stopping playback. The theater dialog traps keyboard focus; closing returns focus to the song link.

The player uses no third-party runtime or external player service. If alternate audio cannot load, the current audio continues; if the active audio fails, native playback of the MP4 remains available. Keep the original MP4 audio as this fallback. Data & Picard's karaoke track is a locally separated accompaniment and may retain separation artifacts.

The website only loads a song's audio after that song is opened. Do not replace a video's source merely to select audio. Version audio filenames and retain older hashed scripts, styles and media so cached pages remain usable during deployment.

## Development and requested verification

Work on a feature branch/worktree and keep the published `main` available. `npm ci` installs the development-only browser driver; `npm run dev` serves a loopback preview with HTTP Range support at `http://127.0.0.1:8780`. Runtime pages have no npm dependency. Audio assets can be prepared with `py -3.12 scripts/prepare-audio.py --config <local-source-manifest.json> --output audio`; source manifests stay outside the public repository.

When the user explicitly requests functional verification, run `npm test` against the preview with installed Google Chrome. It covers every catalog item, continuous video frames while switching, rapid switches, seeking, paused switches, volume/mute/rate, theater focus and responsive layout, full screen, end of playback, unavailable alternate audio, and cached legacy catalogs. Reports and desktop/mobile screenshots are written to ignored `test-results/`. `--core-only` is a development subset, not a release pass. Do not run functional tests by default without user authorization.

After the requested edits, run the necessary syntax checks and `npm run build`, then commit the source and generated asset hashes and merge/push `main`. Functional and playback testing is performed by the user unless explicitly requested. Verify the exact GitHub Pages deployment. Preserve the previous commit as a rollback reference; a later issue can be reverted without rewriting history.

`playlistUrl` retains the optional YouTube playlist URL; `showPlaylist: false` hides it while it is empty. The page, source repository, and direct MP4 files are public. Anyone with a link can watch or reshare them. Robots directives request that search engines do not index this page; they do not provide access control.

Keep each MP4 below GitHub's 100 MiB file limit and the full published site below 1 GB. Web copies use 720p or 1080p H.264/AAC with faststart metadata; full-resolution masters are preserved locally. Guide-vocal and original-vocal sing-along editions are identified in each entry's note. Do not repeatedly replace large video files in Git history. Larger collections should move their media to object storage while retaining this list UI.

All music and video rights belong to their respective creators. Do not put private credentials or source media in this repository.

## Local preview

From this directory, run `py -3.12 -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765`. User performs manual interaction and playback checks.
