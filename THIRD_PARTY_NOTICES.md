# Third-party notices and provenance

Matchframe Esports is original software. This file lists third-party components that are shipped or used, with their licences, and the provenance of reference material. Regenerate the JavaScript runtime list with `pnpm licenses list --prod` after dependency changes; Python worker dependencies are listed in `workers/pyproject.toml` (versions below are those installed in the test virtual environment).

## Shipped JavaScript runtime dependencies (production tree)

| Package | Version | Licence | Used by |
|---|---|---|---|
| zod | 4.6.7 | MIT | contracts, engine |
| ws | 8.22.0 | MIT | engine WebSockets |
| fflate | 0.8.2 | MIT | HUD package archive import |
| obs-websocket-js | 5.0.8 | MIT | OBS adapter |
| ↳ @msgpack/msgpack | 2.8.0 | ISC | obs-websocket-js |
| ↳ crypto-js | 4.2.0 | MIT | obs-websocket-js |
| ↳ debug, ms | 4.4.3, 2.1.3 | MIT | obs-websocket-js |
| ↳ eventemitter3 | 5.0.4 | MIT | obs-websocket-js |
| ↳ isomorphic-ws | 5.0.0 | MIT | obs-websocket-js |
| ↳ type-fest | 3.13.1 | MIT OR CC0-1.0 | obs-websocket-js (types) |
| socket.io | 4.8.1 | MIT | LHM-format HUDs (the LHM compatibility layer's socket) |
| ↳ engine.io, engine.io-parser | 6.6.11, 5.2.3 | MIT | socket.io |
| ↳ socket.io-adapter, socket.io-parser, @socket.io/component-emitter | 2.5.8, 4.2.7, 3.1.2 | MIT | socket.io |
| ↳ accepts, mime-types, mime-db, negotiator | 1.3.8, 2.1.35, 1.52.0, 0.6.3 | MIT | socket.io |
| ↳ base64id, cookie, cors, object-assign, vary | 2.0.0, 0.7.2, 2.8.6, 4.1.1, 1.1.2 | MIT | socket.io, engine.io |
| ↳ debug, ws | 4.3.7, 8.21.3 | MIT | socket.io, engine.io |
| react, react-dom, scheduler | 19.3.1, 19.3.1, 0.28.0 | MIT | HUD renderer, operator UI |
| @fontsource/inter | 5.3.0 | OFL-1.1 (font: Inter, © The Inter Project Authors) | HUD renderer; Vector and Lineup HUDs |
| @fontsource/barlow-condensed | 5.3.0 | OFL-1.1 (font: Barlow, © The Barlow Project Authors) | HUD renderer (Arena preset); operator console (match thumbnails and stingers); Vector and Lineup HUDs |
| Electron | 44.9.3 | MIT (bundles Chromium and Node.js; their licences ship in `LICENSES.chromium.html` / `LICENSE` inside the Electron distribution) | Desktop shell |
| koffi (optional, Windows keyboard adapter) | not bundled by default | MIT | Observer keyboard fallback |
| grandi | 2.0.2 | Apache-2.0 (`NOTICE`: derived from Streampunk's Grandiose, © 2018 Streampunk Media Ltd., and community forks) | Replay feed: receiving the replay PC's screen over NDI (in the feed's own process) |
| ↳ @grandi/win32-x64 (prebuilt addon) | 2.0.2 | Apache-2.0; the NDI runtime inside it (`Processing.NDI.Lib.x64.dll`) under the NDI SDK licence (https://ndi.link/ndisdk_license; `libndi_licenses.txt` ships beside it) | grandi |
| ↳ node-gyp-build | 4.8.4 | MIT | grandi (loads the addon) |

**NDI®** is a registered trademark of Vizrt NV. The program ships the NDI runtime only as part of the grandi addon, unmodified, with its licence files, for receiving NDI sources. More about NDI: https://ndi.video.

**ffmpeg** is not shipped. For the replay feed, the program downloads one fixed build on request (Windows): ffmpeg 7.1, the essentials build by gyan.dev (https://www.gyan.dev/ffmpeg/builds/, from https://github.com/GyanD/codexffmpeg/releases/tag/7.1), checked against its SHA-256 before use, and keeps it with its licence (GPL v3) in the data folder (`tools/ffmpeg`). Its source: https://github.com/FFmpeg/FFmpeg/commit/b08d7969c5. An ffmpeg already on the PATH is used instead when there is no download.

Operator UI dependencies are listed in `apps/operator-web/package.json` and included in `pnpm licenses list --prod` output.

## Bundled HUD packages

| Package | Contents and origin | Licence |
|---|---|---|
| Matchframe Sample CS2 HUD (`assets/hud-packages/matchframe-sample-cs2`) | Original code and artwork; weapon icons from Lexogrine's CS2 React HUD (`images/weapons`); Inter font files | Code MIT; weapon icons MIT (`images/weapons/LICENSE-lexogrine.txt`, see the note below); Inter SIL OFL 1.1 (`fonts/OFL.txt`) |
| Matchframe Pro CS2 HUD (`apps/hud-template`) | Adapted from Lexogrine's CS2 React HUD (https://github.com/lexogrine/cs2-react-hud, © 2021 Lexogrine); Montserrat font files | Lexogrine code MIT (`LICENSE-lexogrine.txt`); Montserrat SIL OFL 1.1 (© 2011 The Montserrat Project Authors) |
| Matchframe Vector and Lineup HUDs (`apps/hud-designs`) | Original code and design; weapon icons from Lexogrine's CS2 React HUD (shared with the HUD renderer); Barlow Condensed and Inter font files | Code MIT; weapon icons MIT (`LICENSE-lexogrine.txt` in each package); fonts SIL OFL 1.1 (`OFL-fonts.txt` in each package) |

The weapon and equipment icons in the Pro CS2 HUD (also used by the Matchframe Broadcast HUD's killfeed and the Sample CS2 HUD) come with Lexogrine's template and originate from Counter-Strike 2 game files (© Valve Corporation). Lexogrine's MIT licence covers their code, not Valve's artwork. Counter-Strike broadcast HUDs commonly use these icons; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons.

## Built-in radar images (minimaps)

`assets/radars`: flat radar drawings of eight CS2 maps (Ancient, Dust II, Inferno, Mirage, Nuke, Overpass, Train, Vertigo) with their world-to-image calibration, from Lexogrine's CS2 React HUD (https://github.com/lexogrine/cs2-react-hud, commit `4ec8eea`, © 2021 Lexogrine), MIT licence (`assets/radars/LICENSE-lexogrine.txt`). They are Lexogrine's own drawings of the map layouts; the maps themselves are Valve's. Every HUD's minimap shows them.

## Built-in camera positions (map navigation and collision data)

- **Cameras and camera paths:** the built-in cameras and camera paths in `assets/map-packs` were computed by `scripts/generate-map-cameras.py`.
  - **Data:** CS2's navigation meshes and collision meshes, as extracted from the game files by awpy-data (https://github.com/pnxenopoulos/awpy-data, release for CS2 build 26144732 / ClientVersion 2000935, scripts © 2025 Peter Xenopoulos, MIT licence).
  - **Reader:** awpy 3.1.1 (https://github.com/pnxenopoulos/awpy, MIT licence).
  - **Ownership:** the meshes are Valve's game assets. Neither the meshes nor the extracted files are committed or shipped; only the derived camera poses and paths are.
- **Free-space grids:** `assets/map-packs/<map>.grid` (which 12-unit cells collision geometry passes through) were computed by `scripts/generate-map-grids.py` from the same awpy-data meshes, read directly. Only the derived grids are committed and shipped.
- **Region cells and floor grids:** the region cells and floor grids of the Dust II, Mirage, Nuke, Train and Vertigo packs, and some regions in other packs, came from the navigation areas in awpy 1.3.1 (`awpy/data/nav/nav_info.csv`, © 2020-2023 Peter Xenopoulos, MIT licence), built by `scripts/generate-map-regions-csgo-nav.py`.
- **The maps are Valve's.**

## Python worker dependencies (installed into a local virtual environment; not bundled)

| Package | Tested version | Licence |
|---|---|---|
| demoparser2 | 0.42.0 | MIT |
| polars | 2.1.0 | MIT |
| pyarrow | 26.0.0 | Apache-2.0 |
| duckdb | 2.0.0 | MIT |
| lightgbm | 4.7.0 | MIT |
| scikit-learn | 1.9.1 | BSD-3-Clause |
| numpy | 2.5.4 | BSD-3-Clause (with bundled 0BSD/MIT/Zlib/CC0-1.0 components) |
| pandas | 3.1.0 | BSD-3-Clause |
| scipy (via scikit-learn/lightgbm) | 1.18.1 | BSD-3-Clause |
| pytest (dev) | 9.1.1 | MIT |

## Development tooling (not shipped)

TypeScript 6.0.3 (Apache-2.0), Vitest 5.0.5 (MIT), ESLint 10.13.0 (MIT), typescript-eslint 8.72.0 (MIT), tsx 4.23.15 (MIT), esbuild 0.28.2 (MIT), Vite 8.3.5 (MIT), @vitejs/plugin-react 6.1.2 (MIT), electron-builder 26.18.0 (MIT), Playwright/Chromium (pre-installed in the test environment, Apache-2.0), OBS Studio 30.0.2 (GPL-2.0; used only as an external test target over its WebSocket API, not linked or shipped), FFmpeg/ffprobe (external tools invoked as processes for clip probing/trimming; not shipped).

## Test data (not redistributed)

- CS2 demo files from the `cs-demos-2` test corpus (gitlab.com/markus-wa/cs-demos-2, MIT licence, © Markus Walther) were downloaded into a temporary directory for parser feasibility and pipeline tests. Demo files, player names and SteamIDs are not committed. Derived aggregate data (region cells built from positions and place names, timing statistics) is committed under `assets/`.

## Reference material (not used as code or assets)

- Lexogrine HUD Manager: functional reference for workflow breadth only. Its manager repository is under a proprietary EULA; no LHM code, designs, assets, models or services are used, and no LHM account or licence is required. "LHM-format HUD" is used only to describe which HUD packages Matchframe can import.
- LHM compatibility layer (`services/local-engine/src/hud/lhm.ts`, `lhm-runtime.ts`): written from the HUD side of the protocol as Lexogrine's MIT-licensed HUD templates use it (https://github.com/lexogrine/cs2-react-hud: `hud.json`, `panel.json`, the socket events and the `/api` paths they call). No code was copied from the manager. Imported LHM-format HUDs belong to their authors and keep their own licences; none are bundled.
- CounterStrike2GSI (GPL-3.0): consulted as documentation of the public GSI field layout; no code or fixtures copied.
- demoinfocs-golang (MIT): consulted for the location of its public test-demo corpus.
- obs-websocket protocol documentation: request/event names.
- Valve GSI/console behaviour: public documentation and launch options; command mappings are marked unverified until tested.

## Original Matchframe assets

The HUD designs (Classic, Minimal, Arena), icons (simple geometric glyphs in `apps/hud-renderer/src/components/Icons.tsx`) and the operator console design are original to this project.
