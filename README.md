# Instrumental Room

A lightweight, responsive YouTube video library for Instrumental and Karaoke editions.

## Publishing

GitHub Pages serves the repository root. No build tools, dependencies, secrets, or server are required. The intended address is `https://gmyoung.github.io/`.

## Add a video

Add an entry to `videos.json` with `id`, `title`, `artist`, `type` (`instrumental` or `karaoke`), `duration`, `label`, `poster`, and the final HTTPS YouTube `url`. Place its poster in `assets/`. Keep a null URL until the upload is complete; the page displays an honest pending status.

`playlistUrl` is the shared YouTube playlist URL. Unlisted videos are accessible to anyone with the link and may be reshared. The page and source repository are public; neither provides access control. Robots directives request that search engines do not index this navigation page.

All music and video rights belong to their respective creators. Do not put private credentials or source media in this repository.

## Local preview

From this directory, run `py -3.12 -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765`. User performs manual interaction and playback checks.
