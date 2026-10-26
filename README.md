# Matchframe Esports

Windows-first CS2 broadcast production suite: a local engine that ingests CS2 Game State Integration, browser-source HUDs, match/event/veto/sponsor administration, an anticipation/readiness CS2 director with a single-writer control arbiter, universal grenade tracking for all six types, OBS control, replays, an offline demo pipeline that trains models, and an Electron desktop shell.

**Read this first — what is verified.** Everything below runs and is tested in a Linux development environment with synthetic GSI, a labelled simulation, real OBS 30.0.2 and five real CS2 demos. **No CS2 client, Windows machine, replay tool or MatchFrame service was available**, so real GSI ingest, real observer control (POV cuts and static cameras) and Windows installation are **unverified**. Details: [CAPABILITIES.md](CAPABILITIES.md), [FEATURE_COVERAGE.md](FEATURE_COVERAGE.md), [docs/acceptance.md](docs/acceptance.md), [BUILD_PROGRESS.md](BUILD_PROGRESS.md).

## Prerequisites

- Node.js ≥ 22.12 (developed on 22.22.0) and pnpm 10 (`corepack enable`).
- For the demo pipeline: Python ≥ 3.11 with the worker dependencies (see [workers/README.md](workers/README.md)). Point the engine at it with `MATCHFRAME_PYTHON=/path/to/python`, or create `workers/.venv`.
- For production: CS2 on the observer PC, OBS Studio 30+ with obs-websocket enabled.

## Quick start

```sh
pnpm install
pnpm dev --sim          # builds the HUD and operator console if needed, starts the engine, runs the labelled simulation
```

The engine prints its addresses and writes the operator URL (which contains the operator token) to `<data dir>/operator-url.txt`. Open it in a browser for the operator console. Overlays for OBS browser sources are under **HUD → Outputs** (`http://127.0.0.1:37212/overlay/<output>/<variant>?t=<output token>`). Simulated data is marked SIMULATION everywhere.

Data directory: `%APPDATA%\Matchframe Esports` on Windows, `~/.local/share/matchframe-esports` on Linux (override with `MATCHFRAME_DATA_DIR`). Ports: GSI 37210, operator API 37211, overlays 37212 (`MATCHFRAME_GSI_PORT`, `MATCHFRAME_API_PORT`, `MATCHFRAME_OVERLAY_PORT`). The engine binds to loopback unless `MATCHFRAME_HOST` is set.

## Connecting a real CS2 observer (unverified path)

1. **Setup → Game**: detect CS2 and write the GSI config (`gamestate_integration_matchframe.cfg`, with a token) — or `POST /api/v1/setup/write-gsi-config`.
2. Start CS2 as an observer/spectator; **Setup → Capabilities** shows what the feed actually delivers.
3. Choose an observer control adapter (**Setup → Observer**): direct console (`-netconport <port>` launch option) or keyboard (Windows, focused window only). Run the **player selection** setup test; automatic POV cuts stay blocked until it passes from observed feedback. Static cinematics additionally need the **static camera** test and operator-validated cameras captured with `getpos`.
4. Connect OBS (**Production → OBS**) and map program scenes.
5. Arm automation explicitly (the engine always starts and restarts disarmed). Emergency stop: the console button, `Ctrl+Shift+F12` in the desktop app, or `POST /api/v1/observer/emergency-stop`.

Guides: [one PC](docs/operations/one-pc.md), [multi-PC](docs/operations/multi-pc.md), [preflight](docs/operations/preflight.md), [takeover and recovery](docs/operations/takeover-and-recovery.md), [GSI](docs/integrations/cs2-gsi.md), [observer control](docs/integrations/observer-control.md), [OBS](docs/integrations/obs.md), [replay bridge](docs/integrations/replay-bridge.md), [MatchFrame bridge](docs/integrations/matchframe-bridge.md), [Companion/Stream Deck](docs/integrations/companion-streamdeck.md).

## Production topology

```
CS2 observer client ──GSI (HTTP POST, token)──▶ Matchframe engine ◀──REST/WS──▶ operator console / devices
        ▲                                         │   │
        └── observer control adapter (console/keyboard; single writer via control arbiter)
                                                  │   └──obs-websocket v5──▶ OBS (program, replay buffer, media)
                                                  └──overlay WS (public projection only)──▶ OBS browser sources (HUD)
```

GSI carries telemetry only — it does not control the camera; observer control is a separate, verified channel. HUD player cards are graphics, not video feeds. See [docs/architecture/overview.md](docs/architecture/overview.md) and [decisions](docs/architecture/decisions.md).

## Commands

| Task | Command |
|---|---|
| Development startup | `pnpm dev` (`--sim` to start the simulation, `--build` to rebuild the browser apps) |
| Engine only, from source | `pnpm engine` |
| Type check, lint, tests | `pnpm check` (or `pnpm typecheck`, `pnpm lint`, `pnpm test`) |
| Python worker tests | `pnpm test:py` (with `MF_TEST_DEMOS=<demo folder>` to include real-demo tests) |
| Real-integration tests | `MF_TEST_DEMOS=<demos> MATCHFRAME_PYTHON=<python> pnpm test:integration` (OBS tests also need `MF_OBS_URL`, `MF_OBS_PASSWORD`) |
| Build all apps | `pnpm build` |
| Windows packaging | `pnpm package:win` (unpacked folder via `pnpm package:dir`) — see BUILD_PROGRESS.md for the current result |
| Demo batch import and validation | console **Demos**, or `POST /api/v1/demos/import {"paths":[…]}`; directly: `pnpm worker extract --input demo.dem --dataset-root DATA --validate` |
| Feature building, dataset freezing | `pnpm worker build-features --dataset <dir>`, `pnpm worker freeze-dataset --datasets DATA --out frozen.json`, `pnpm worker audit-split --manifest frozen.json` |
| Training, evaluation, export | console **Training**, or `POST /api/v1/training/runs`; directly: `pnpm worker train …`, `pnpm worker evaluate …`, `pnpm worker export-model …` ([docs/models](docs/models/README.md)) |
| Shadow-run comparison | `POST /api/v1/models/<id>/shadow`, then `GET /api/v1/models/shadow` |
| Event export / restore | `GET /api/v1/export/event-package`; `POST /api/v1/import/event-package {"package":…, "mode":"preview"|"commit"}` |
| Diagnostics | `GET /api/v1/diagnostics/bundle` (secrets redacted) |
| API reference / schemas | `pnpm openapi` → `docs/architecture/openapi.json`, `pnpm schemas` → `packages/contracts/schema/` |
| Map coverage report | `pnpm coverage:maps` |
| Simulated soak | `pnpm soak --minutes 20 --out soak.json` |

API calls need `Authorization: Bearer <token>` (operator token from `operator-url.txt`, or a role token from **Settings → Tokens**).

## Repository layout

`packages/` shared libraries (contracts, CS2 state + utility tracker, map runtime, director policy + control arbiter, automation, OBS adapter, game adapters, HUD SDK, MatchFrame bridge) · `services/` local engine, observer adapters, replay providers · `apps/` HUD renderer, operator console, Electron desktop · `workers/` Python demo pipeline · `assets/` demo-derived map packs and measured utility profiles · `docs/` architecture, operations, integrations, models, maps, security, storage.

## Licence and provenance

Original Matchframe code and designs. Third-party components and reference material: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No Lexogrine HUD Manager code, assets, account or licence is used or required.
