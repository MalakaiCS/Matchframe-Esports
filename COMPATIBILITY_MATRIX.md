# Compatibility matrix

Versions actually used in this repository's environment and what was exercised on each. Anything not listed was not tested.

## Operating systems

| OS | Engine (Node) | Desktop (Electron) | HUD/browser sources | Observer keyboard adapter | Status |
|---|---|---|---|---|---|
| Windows 10/11 x64 (target) | – | – | – | – | **not tested** — NSIS installer and portable zip built from Linux (BUILD_PROGRESS.md); no Windows machine available |
| Linux x64 (Ubuntu 24.04.5 container, kernel 6.18) | Node 22.22.0 ✔ | Electron 44.9.3: shell + supervised engine + console under Xvfb ✔ (`pnpm smoke:desktop`) | Chromium (Playwright) ✔ | n/a (Windows only) | development and CI environment |
| macOS | – | – | – | n/a | not tested |

## Runtimes and libraries

| Component | Version | Notes |
|---|---|---|
| Node.js | 22.22.0 (min 22.12) | `node:sqlite` (SQLite 3.50.4) — experimental flag warning |
| Electron | 44.9.3 (Node 24.22.0, SQLite 3.53.4) | engine bundle runs under its runtime |
| pnpm | 10.28.0 | |
| TypeScript | 6.0.3 | 7.x outside typescript-eslint 8.72's range |
| Python (workers) | 3.13.17 (min 3.11) | demoparser2 0.42.0, polars 2.1.0, pyarrow 26.0.0, duckdb 2.0.0, lightgbm 4.7.0, numpy 2.5.4, pandas 3.1.0, scikit-learn 1.9.1 |

## CS2

| Item | Status |
|---|---|
| CS2 client / GSI on a current build | **not tested** (no client available) |
| GSI field layout | public documentation; synthetic fixtures only |
| Demo builds parsed | 13914, 13916, 13926 (SourceTV), 14000 (client POV) — 2023 builds; no current-build demo tested |
| Grenade entity classes | build-dependent (shared `CBaseCSGrenadeProjectile`/`CMolotovProjectile` in 13914–13926; split HE/flash classes in 14000) |
| Console control templates (`spec_player_by_accountid`, `spec_mode`, `spec_goto`, `getpos`) | candidate mappings, **unverified** |

## Map packs

| Map | Pack | Built from |
|---|---|---|
| de_inferno, de_ancient, de_anubis, de_overpass | yes | one 2023 demo each (`pnpm coverage:maps` for details) |
| de_mirage, de_dust2, de_nuke, de_train, de_vertigo | no | no usable demo (Nuke refused: insufficient data) |
| de_synthetic | built in | synthetic geometry for simulation and logic tests |

## Mixer / transports

| Item | Version | Status |
|---|---|---|
| OBS Studio | 30.0.2, obs-websocket 5.3.4, Linux headless | **verified** (integration tests) |
| OBS on Windows | – | not tested |
| obs-websocket-js | 5.0.8 | |
| vMix / other mixers | – | not implemented |
| HTTP/WebSocket (engine) | Node `http` + ws 8.22.0 | loopback default; LAN opt-in |
| Bitfocus Companion / Stream Deck | – | HTTP actions documented; not tested with the products |
| Replay tool bridge | contract v1 | blocked (tool API not available) |
| MatchFrame bridge | contract v1 | blocked (service API not available) |

## Website and cloud API

| Item | Version | Status |
|---|---|---|
| Postgres (production database) | 16 (local server), node-postgres 8.23.1 | **verified** — migrations, rollback, six concurrent computers debiting credits exactly once (`MF_TEST_DATABASE_URL` integration test); bundled server run against it |
| PGlite (tests, trials) | 0.5.8 | verified in every cloud test |
| Stripe API | SDK 23.0.0, API 2026-09-30.endive | real SDK against a local Stripe API stub with real webhook signatures; **no real Stripe account** used; the official `stripe-mock` binary could not be run here |
| SMTP | nodemailer 10.1.0 | not tested against a real mail server (outbox table and console logging tested) |
| Container | Docker 29.9.2, `node:22.22.0-bookworm-slim` | see BUILD_PROGRESS.md for the image build and run result |
| Desktop ↔ website | licence format `mfe1`, Ed25519 | verified with both real servers in one test (link, licence, gate, usage upload, credits, map-change handback, revocation) |

