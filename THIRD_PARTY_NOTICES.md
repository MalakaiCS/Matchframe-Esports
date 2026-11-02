# Third-party notices and provenance

MatchFrame Esports is original software. This file lists third-party components that are shipped or used, with their licences, and the provenance of reference material. Regenerate the JavaScript runtime list with `pnpm licenses list --prod` after dependency changes; Python worker dependencies are listed in `workers/pyproject.toml` (versions below are those installed in the test virtual environment).

## Shipped JavaScript runtime dependencies (production tree)

| Package | Version | Licence | Used by |
|---|---|---|---|
| zod | 4.6.7 | MIT | contracts, engine |
| ws | 8.22.0 | MIT | engine WebSockets |
| fflate | 0.8.2 | MIT | HUD package archive import; .xlsx team and player imports and templates |
| obs-websocket-js | 5.0.8 | MIT | OBS adapter |
| ↳ @msgpack/msgpack | 2.8.0 | ISC | obs-websocket-js |
| ↳ crypto-js | 4.2.0 | MIT | obs-websocket-js |
| ↳ debug, ms | 4.4.3, 2.1.3 | MIT | obs-websocket-js |
| ↳ eventemitter3 | 5.0.4 | MIT | obs-websocket-js |
| ↳ isomorphic-ws | 5.0.0 | MIT | obs-websocket-js |
| ↳ type-fest | 3.13.1 | MIT OR CC0-1.0 | obs-websocket-js (types) |
| socket.io | 4.8.1 | MIT | Imported hud.json-format HUDs (the HUD compatibility layer's socket) |
| ↳ engine.io, engine.io-parser | 6.6.11, 5.2.3 | MIT | socket.io |
| ↳ socket.io-adapter, socket.io-parser, @socket.io/component-emitter | 2.5.8, 4.2.7, 3.1.2 | MIT | socket.io |
| ↳ accepts, mime-types, mime-db, negotiator | 1.3.8, 2.1.35, 1.52.0, 0.6.3 | MIT | socket.io |
| ↳ base64id, cookie, cors, object-assign, vary | 2.0.0, 0.7.2, 2.8.6, 4.1.1, 1.1.2 | MIT | socket.io, engine.io |
| ↳ debug, ws | 4.3.7, 8.21.3 | MIT | socket.io, engine.io |
| react, react-dom, scheduler | 19.3.1, 19.3.1, 0.28.0 | MIT | HUD renderer, operator UI |
| country-flag-icons | 1.5.21 | MIT (© 2020 @catamphetamine) | Operator console: country flags (SVG files) in the team and player lists and country pickers |
| @fontsource/inter | 5.3.0 | OFL-1.1 (font: Inter, © The Inter Project Authors) | HUD renderer; Vector HUD |
| @fontsource/barlow-condensed | 5.3.0 | OFL-1.1 (font: Barlow, © The Barlow Project Authors) | HUD renderer (Arena preset); operator console (match thumbnails and stingers); Lineup HUD |
| Electron | 44.9.3 | MIT (bundles Chromium and Node.js; their licences ship in `LICENSES.chromium.html` / `LICENSE` inside the Electron distribution) | Desktop shell |
| koffi (optional, Windows keyboard adapter) | not bundled by default | MIT | Observer keyboard fallback |
| grandi | 2.0.2 | Apache-2.0 (`NOTICE`: derived from Streampunk's Grandiose, © 2018 Streampunk Media Ltd., and community forks) | Replay feed: receiving the replay PC's screen over NDI (in the feed's own process); Team Comms: sending two audio-only NDI sources, "MatchFrame Comms" and "MatchFrame Comms Recording" (in their own process) |
| ↳ @grandi/win32-x64 (prebuilt addon) | 2.0.2 | Apache-2.0; the NDI runtime inside it (`Processing.NDI.Lib.x64.dll`) under the NDI SDK licence (https://ndi.link/ndisdk_license; `libndi_licenses.txt` ships beside it) | grandi |
| ↳ node-gyp-build | 4.8.4 | MIT | grandi (loads the addon) |

**NDI®** is a registered trademark of Vizrt NV. The program ships the NDI runtime only as part of the grandi addon, unmodified, with its licence files, for receiving NDI sources (the replay feed) and sending audio-only NDI sources (Team Comms). More about NDI: https://ndi.video.

**ffmpeg** is not shipped. For the replay feed, the program downloads one fixed build on request (Windows): ffmpeg 7.1, the essentials build by gyan.dev (https://www.gyan.dev/ffmpeg/builds/, from https://github.com/GyanD/codexffmpeg/releases/tag/7.1), checked against its SHA-256 before use, and keeps it with its licence (GPL v3) in the data folder (`tools/ffmpeg`). Its source: https://github.com/FFmpeg/FFmpeg/commit/b08d7969c5. An ffmpeg already on the PATH is used instead when there is no download.

Operator UI dependencies are listed in `apps/operator-web/package.json` and included in `pnpm licenses list --prod` output.

## TeamSpeak 3 plugin (Team Comms)

The program ships MatchFrame's own TeamSpeak 3 client plugin (`native/ts3-matchframe-plugin`, original code), built in CI with the compiler's static runtime (MSVC; mingw-w64's libstdc++/libgcc/winpthreads when cross-compiled, under their runtime-library exceptions).

- **TeamSpeak 3 Client Plugin SDK** headers (https://github.com/TeamSpeak-Systems/ts3client-pluginsdk, commit `4aa90a5`, plugin API 26): Copyright TeamSpeak Systems GmbH, all rights reserved. **Not in this repository and not shipped as source:** `scripts/fetch-sdk.mjs` downloads them at build time and checks their SHA-256. The plugin is compiled against them, which is what TeamSpeak publishes them for (building plugins for its client). "TeamSpeak" is a trademark of TeamSpeak Systems GmbH; the plugin is not made or endorsed by TeamSpeak.

## Bundled HUD packages

| Package | Contents and origin | Licence |
|---|---|---|
| MatchFrame Sample CS2 HUD (`assets/hud-packages/matchframe-sample-cs2`) | Original code and artwork; weapon icons from the CS2 HUD template below (`images/weapons`); Inter font files | Code MIT; weapon icons MIT (`third-party-licenses/weapon-icons-MIT.txt`); Inter SIL OFL 1.1 (`fonts/OFL.txt`) |
| MatchFrame Pro CS2 HUD (`apps/hud-template`) | Adapted from the CS2 HUD template below; Montserrat font files | Template code MIT (`third-party-licenses/hud-template-MIT.txt`); MatchFrame's changes MIT; Montserrat SIL OFL 1.1 (© 2011 The Montserrat Project Authors) |
| MatchFrame Vector and Lineup HUDs (`apps/hud-designs`) | Original MatchFrame code; weapon icons from the CS2 HUD template below (shared with the HUD renderer); Montserrat and Inter font files (Vector), Barlow Condensed font files (Lineup) | Code MIT; weapon icons MIT (`third-party-licenses/weapon-icons-MIT.txt` in each package); fonts SIL OFL 1.1 (`OFL-fonts.txt` in each package; Vector also `OFL-Montserrat.txt`) |

## CS2 React HUD template (MIT): HUD code, weapon icons and radar images

**cs2-react-hud** by Lexogrine (https://github.com/lexogrine/cs2-react-hud), Copyright (c) 2021 Lexogrine, MIT licence. MatchFrame uses:

- **HUD code and styles:** the Pro CS2 HUD (`apps/hud-template`) is adapted from it.
- **Weapon and equipment icons:** the template's icon set, in the Pro CS2 HUD, the Vector and Lineup HUDs, the Sample CS2 HUD (`images/weapons`) and the MatchFrame Broadcast HUD's killfeed (HUD renderer).
- **Radar images:** `assets/radars`, flat radar drawings of eight CS2 maps (Ancient, Dust II, Inferno, Mirage, Nuke, Overpass, Train, Vertigo) with their world-to-image calibration, from commit `4ec8eea6f0935193b44ec5a000f230fccdaa1c15`, `src/HUD/Radar/LexoRadar/maps/<map>/radar.png` and `index.ts`. They are the template author's own drawings of the map layouts; the maps themselves are Valve's. Every HUD's minimap shows them.

The licence text, unchanged and with its copyright line, ships in a `third-party-licenses` folder next to the files it covers:

| Shipped location (installed program) | Source in this repository | Covers |
|---|---|---|
| `sample-huds/matchframe-pro-cs2/third-party-licenses/hud-template-MIT.txt` | `apps/hud-template/package-files/third-party-licenses/` | The Pro CS2 HUD's code, styles and icons |
| `sample-huds/matchframe-vector/third-party-licenses/weapon-icons-MIT.txt`, `sample-huds/matchframe-lineup/third-party-licenses/weapon-icons-MIT.txt` | `apps/hud-designs/package-files/third-party-licenses/` | The weapon icons in Vector and Lineup |
| `sample-huds/matchframe-sample-cs2/third-party-licenses/weapon-icons-MIT.txt` | `assets/hud-packages/matchframe-sample-cs2/third-party-licenses/` | `images/weapons` |
| `hud-renderer/third-party-licenses/weapon-icons-MIT.txt` | `apps/hud-renderer/public/third-party-licenses/` | The Broadcast HUD's killfeed icons |
| `radars/third-party-licenses/radar-images-MIT.txt` | `assets/radars/third-party-licenses/` | The radar images and `radars.json` calibration |

An installed HUD package keeps its `third-party-licenses` folder in the HUD Library (`huds/<id>/<version>/`) and in exported HUD ZIPs.

The weapon and equipment icons originate from Counter-Strike 2 game files (© Valve Corporation). The template's MIT licence covers its code, not Valve's artwork. Counter-Strike broadcast HUDs commonly use these icons; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons.

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

Team Comms tests (ADR-065), used here only, never shipped or committed: TeamSpeak 3 Server 3.13.8 and TeamSpeak 3 Client 3.6.2 for Linux (proprietary, TeamSpeak Systems GmbH; downloaded from TeamSpeak, the server's free licence accepted with `TS3SERVER_LICENSE=accept` and the client's terms through its installer, for testing; `native/ts3-matchframe-plugin/test/real/ts3-rig.sh` expects them already downloaded); Source Record 0.4.8 by exeldro (GPL-2.0; built from https://github.com/exeldro/obs-source-record for an OBS test; the program does not include or link it, the operator installs it into OBS); DistroAV 6.2.2 (GPL-2.0; evaluated, not built); PulseAudio 16.1, Xvfb, mingw-w64 13 (GCC runtime-library exception), Wine 9.0, CMake (test and build tools).

## Test data (not redistributed)

- CS2 demo files from the `cs-demos-2` test corpus (gitlab.com/markus-wa/cs-demos-2, MIT licence, © Markus Walther) were downloaded into a temporary directory for parser feasibility and pipeline tests. Demo files, player names and SteamIDs are not committed. Derived aggregate data (region cells built from positions and place names, timing statistics) is committed under `assets/`.

## Reference material (not used as code or assets)

- The template author's commercial HUD program (proprietary EULA): a functional reference for workflow breadth only. None of its code, designs, assets, models or services are used, and none of its accounts or licences are needed.
- HUD compatibility layer (`services/local-engine/src/hud/compat.ts`, `compat-runtime.ts`): written from the HUD side of the hud.json template protocol as the MIT-licensed template above uses it (`hud.json`, `panel.json`, the socket events and the `/api` paths they call). No code was copied from that program. Imported hud.json-format HUDs belong to their authors and keep their own licences; none are bundled.
- CounterStrike2GSI (GPL-3.0): consulted as documentation of the public GSI field layout; no code or fixtures copied.
- demoinfocs-golang (MIT): consulted for the location of its public test-demo corpus.
- obs-websocket protocol documentation: request/event names.
- Valve GSI/console behaviour: public documentation and launch options; command mappings are marked unverified until tested.

## Original MatchFrame assets

The HUD designs (Classic, Minimal, Arena), icons (simple geometric glyphs in `apps/hud-renderer/src/components/Icons.tsx`) and the operator console design are original to this project.
