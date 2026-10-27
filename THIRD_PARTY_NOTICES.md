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
| react, react-dom, scheduler | 19.3.1, 19.3.1, 0.28.0 | MIT | HUD renderer, operator UI |
| @fontsource/inter | 5.3.0 | OFL-1.1 (font: Inter, © The Inter Project Authors) | HUD renderer |
| @fontsource/barlow-condensed | 5.3.0 | OFL-1.1 (font: Barlow, © The Barlow Project Authors) | HUD renderer (Arena preset) |
| Electron | 44.9.3 | MIT (bundles Chromium and Node.js; their licences ship in `LICENSES.chromium.html` / `LICENSE` inside the Electron distribution) | Desktop shell |
| koffi (optional, Windows keyboard adapter) | not bundled by default | MIT | Observer keyboard fallback |

Operator UI dependencies are listed in `apps/operator-web/package.json` and included in `pnpm licenses list --prod` output.

## Bundled HUD packages

| Package | Contents and origin | Licence |
|---|---|---|
| Matchframe Sample CS2 HUD (`assets/hud-packages/matchframe-sample-cs2`) | Original code and artwork; Inter font files | Code MIT; Inter SIL OFL 1.1 (`fonts/OFL.txt`) |
| Matchframe Pro CS2 HUD (`apps/hud-template`) | Adapted from Lexogrine's CS2 React HUD (https://github.com/lexogrine/cs2-react-hud, © 2021 Lexogrine); Montserrat font files | Lexogrine code MIT (`LICENSE-lexogrine.txt`); Montserrat SIL OFL 1.1 (© 2011 The Montserrat Project Authors) |

The weapon and equipment icons in the Pro CS2 HUD come with Lexogrine's template and originate from Counter-Strike 2 game files (© Valve Corporation). Lexogrine's MIT licence covers their code, not Valve's artwork. Counter-Strike broadcast HUDs commonly use these icons; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons.

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

- Lexogrine HUD Manager: functional reference for workflow breadth only. Its manager repository is under a proprietary EULA; no LHM code, designs, names, assets, models or services are used, and no LHM account or licence is required.
- CounterStrike2GSI (GPL-3.0): consulted as documentation of the public GSI field layout; no code or fixtures copied.
- demoinfocs-golang (MIT): consulted for the location of its public test-demo corpus.
- obs-websocket protocol documentation: request/event names.
- Valve GSI/console behaviour: public documentation and launch options; command mappings are marked unverified until tested.

## Original Matchframe assets

The HUD designs (Classic, Minimal, Arena), icons (simple geometric glyphs in `apps/hud-renderer/src/components/Icons.tsx`) and the operator console design are original to this project.
