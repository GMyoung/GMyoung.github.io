# MODARIS GitHub Pages distribution

- Snapshot: the published mobile-v9 Site distribution, source commit `6fea568a262fe21565f6346b8b84ae4a901653c7`.
- Migration date: 2026-11-07.
- Public entry: `https://gmyoung.github.io/car-game/?edition=world`; the same page also accepts `?edition=tour`.
- This directory contains the published static distribution. No original working-tree changes, private Site metadata, development environment files, keys, test evidence or recordings are included.
- The HTML favicon and preload paths, and the web manifest icon/start paths, were made relative for `/car-game/`. Page metadata now describes MODARIS and its GitHub Pages URL. Game scripts, shaders, models, textures, sounds, mobile controls and historical hashed resources are retained from the published snapshot.
- The compiled multiplayer server start method is empty, matching the source build's disabled server URL. Gameplay does not require a ChatGPT login or application server. Scores and achievements remain browser-local; data on the old Site origin does not automatically transfer to GitHub Pages.
- Runtime asset URLs, decoder paths and model texture references remain relative to this page or their respective resource files. Model libraries retain their licenses and source manifests; see `THIRD_PARTY_NOTICES.md` and `LICENSE.txt`.
- Verification for this migration is limited to saved-file, syntax and static dependency/path checks. No browser, driving or touch functionality was automatically tested.

To update this copy, start with the intended published static snapshot, retain the original licenses and complete dependent assets, adapt the HTML/manifest paths for `/car-game/`, and publish it through the parent repository's Pages workflow. Do not copy `.openai`, `.git`, environment files, raw recordings or private development records into this public directory.
