# Instrumental Room

A compact English list of Instrumental and Karaoke videos with an inline HTML5 player. Videos are hosted directly by GitHub Pages.

## Publishing

GitHub Pages serves the repository root at `https://gmyoung.github.io/`. No third-party dependencies, secrets, or server are required. Run `node build.mjs` after changing the source files or catalog and before committing. It creates content-hashed JS, CSS, and catalog files so a browser cannot mix an old cached script with a newer page layout.

Edit `index.template.html` for layout changes. `index.html` is generated. Old hashed assets remain available for visitors with cached pages.

## Add a video

Add an entry to `videos.json` with `id`, `title`, `artist`, `type` (`instrumental` or `karaoke`), `duration`, `label`, and a relative MP4 `url` such as `media/example.mp4`. Add `karaoke: true` when an instrumental video already includes synchronized on-screen lyrics. Files must be complete before a playable entry is published. External HTTPS video links can also be used.

`playlistUrl` retains the optional YouTube playlist URL; `showPlaylist: false` hides it while it is empty. The page, source repository, and direct MP4 files are public. Anyone with a link can watch or reshare them. Robots directives request that search engines do not index this page; they do not provide access control.

Keep each MP4 below GitHub's 100 MiB file limit and the full published site below 1 GB. The current web copies use 720p H.264/AAC with faststart metadata; high-quality originals are preserved locally. Do not repeatedly replace large video files in Git history. Larger collections should move their media to object storage while retaining this list UI.

All music and video rights belong to their respective creators. Do not put private credentials or source media in this repository.

## Local preview

From this directory, run `py -3.12 -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765`. User performs manual interaction and playback checks.
