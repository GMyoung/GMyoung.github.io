# MODARIS GitHub Pages distribution

- Snapshot: MODARIS portal-court edition, built on 2026-11-16 with `npm run build` from the working tree of `harvey-yang-cargame-portfolio` (its Modaris changes are not committed there, so there is no source commit hash for this build). It replaces the 2026-11-07 snapshot of Site source commit `6fea568a262fe21565f6346b8b84ae4a901653c7`.
- What changed on 2026-11-16: `index.html` and three new hashed files in `assets/` (`index-CJmaIVOd.js`, `index-DoJHr0mP.css`, `rapier-wNuLqA88.js`). Models, textures, sounds, fonts and all earlier hashed files are unchanged and retained. The game now has ten portals in one court beside the spawn, shorter themed circuits with lesson cards, and English text throughout.
- Migration date: 2026-11-07.
- Public entry: `https://gmyoung.github.io/car-game/?edition=world`; the same page also accepts `?edition=tour`.
- This directory contains the published static distribution. No original working-tree changes, private Site metadata, development environment files, keys, test evidence or recordings are included.
- The HTML favicon and preload paths, and the web manifest icon/start paths, were made relative for `/car-game/`. Page metadata now describes MODARIS and its GitHub Pages URL. Game scripts, shaders, models, textures, sounds, mobile controls and historical hashed resources are retained from the published snapshot.
- The compiled multiplayer server start method is empty, matching the source build's disabled server URL. Gameplay does not require a ChatGPT login or application server. Scores and achievements remain browser-local; data on the old Site origin does not automatically transfer to GitHub Pages.
- Runtime asset URLs, decoder paths and model texture references remain relative to this page or their respective resource files. Model libraries retain their licenses and source manifests; see `THIRD_PARTY_NOTICES.md` and `LICENSE.txt`.
- Verification for this migration is limited to saved-file, syntax and static dependency/path checks. No browser, driving or touch functionality was automatically tested.
- Verification for the 2026-11-16 update: the same source was driven on localhost with an input-only test driver (all ten circuits finished and returned to the portal court; nine laps valid) and this production build was loaded once on localhost without console errors. Phones, gamepads and a full Tour were not tested.

To update this copy, start with the intended published static snapshot, retain the original licenses and complete dependent assets, adapt the HTML/manifest paths for `/car-game/`, and publish it through the parent repository's Pages workflow. Do not copy `.openai`, `.git`, environment files, raw recordings or private development records into this public directory.
