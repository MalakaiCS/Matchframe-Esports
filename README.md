# Matchframe Esports

Matchframe is two products:

- **The Matchframe program for Windows** — a downloadable program (`MatchframeEsports-Setup-<version>.exe`) that does everything app-related: CS2 Game State Integration ingest, browser-source HUDs for OBS, match/event/veto/sponsor administration, the auto director — the **Observer**, with Off, Observer, Observer & Cinematics and Full Action Observer modes (anticipation/readiness director with a single-writer control arbiter), observer camera control, universal grenade tracking for all six types, OBS control, replays, player cameras, and an offline demo pipeline that trains models. Its operator console exists only inside the program.
- **The website** — only for payments, subscription management, auto-director hours usage, account and team management, and staff administration. It also hosts the program download for signed-in accounts. See [docs/architecture/cloud.md](docs/architecture/cloud.md).

The program opens with a **sign-in screen**: the same email and password as the website (or a code approved on the website). Once signed in it works offline for up to 7 days after each check, and being signed out on the website mid-broadcast never stops a running show — it only asks to sign in again at the next start. Automatic direction on live matches uses auto-director hours from the organisation's Matchframe plan.

**Read this first — what is verified.** Everything below runs and is tested in a Linux development environment with synthetic GSI, a labelled simulation, real OBS 30.0.2 and five real CS2 demos; the Windows program is built and smoke-tested on GitHub's Windows runners (see [BUILD_PROGRESS.md](BUILD_PROGRESS.md) for the latest run). **No CS2 client, replay tool or MatchFrame service was available**, so real GSI ingest and real observer control (POV cuts and static cameras) are **unverified**, and real Stripe payments, email delivery and hosting need the owner's accounts. Details: [CAPABILITIES.md](CAPABILITIES.md), [FEATURE_COVERAGE.md](FEATURE_COVERAGE.md), [docs/acceptance.md](docs/acceptance.md).

## Installing the program

1. Sign in on the website and open **Download the program** (dashboard or account page), or take `MatchframeEsports-Setup-<version>.exe` from the **Windows program (.exe)** GitHub Actions run (artifact `matchframe-windows-<commit>`). Check the SHA-256 shown next to the download (`Get-FileHash .\MatchframeEsports-Setup-0.1.0.exe`).
2. Run the installer (per-user, choose a folder). Development builds are unsigned, so Windows SmartScreen asks for confirmation.
3. Start **Matchframe Esports** and **sign in** with your website account (create one on the website first; the email must be confirmed). It then opens on **Overview** with the 12-step **Setup** checklist. Everything stays on this computer; the engine listens on loopback unless you choose otherwise.

Data folder: `%APPDATA%\Matchframe Esports` (override with `MATCHFRAME_DATA_DIR`). Ports: GSI 37210, engine API 37211, HUD outputs 37212 (`MATCHFRAME_GSI_PORT`, `MATCHFRAME_API_PORT`, `MATCHFRAME_OVERLAY_PORT`). Overlays for OBS browser sources are under **HUDs & Composer → Outputs** (`http://127.0.0.1:37212/overlay/<output>/<variant>?t=<output token>`). Simulated data is marked SIMULATION everywhere.

**Account & Hours** (in the program) shows who the program is signed in as, the organisation's plan, hours left and usage uploads, and signs out. Payments, plans, hour packs and team members are managed on the website. Each signed-in production computer counts towards the plan's computer limit; extra operator positions in remote mode use the production computer's sign-in.

**Multi-PC:** install the program on each extra operator computer and use **File → Connection settings → Connect to the production computer** with the production computer's address and a role token issued there (**Devices & Integrations → Tokens**). See [docs/operations/multi-pc.md](docs/operations/multi-pc.md).

## Connecting a real CS2 observer (unverified path)

Follow the **Setup** checklist in the program (`Overview → Open Setup`):

1. Steps 2–3 — **Detect CS2** and **Write the GSI config** (`gamestate_integration_matchframe.cfg`, with a token), then restart CS2.
2. Steps 4–5 — start CS2 as an observer/spectator; **Wait for a real payload** and read the **Capability report** (what the feed actually delivers).
3. Steps 6–8 — choose the **Observer control adapter**: direct console (`-netconport <port>` launch option) or keyboard (focused window only). Run the **Player-selection test**; automatic POV cuts stay blocked until it passes from observed feedback. Static cinematics additionally need the **Static camera test** and operator-validated cameras captured with `getpos` (**Maps & Cameras**).
4. Steps 9–11 — **Connect OBS**, set the **Program scene mapping** and add the main HUD browser source.
5. Choose the **Observer** mode in **Live Control** and arm it with **Resume automation** (the engine always starts and restarts disarmed, with the Observer Off):
   - **Off**: never moves the camera; shot suggestions only.
   - **Observer**: player POV cuts.
   - **Observer & Cinematics**: POV cuts plus cinematic static cameras (establishing shot in freeze time, the bomb at plant/defuse, big-fight overviews).
   - **Full Action Observer**: all of that plus nade cameras; a plan feature (Studio by default).

   Static shots use operator-validated cameras from **Maps & Cameras**. Every mode except Off uses auto-director hours on live telemetry at the same rate; automation is never cut mid-map. Stopping: EMERGENCY STOP, STOP AUTOMATION (`F8`/`Pause`, ignored while typing), `Ctrl+Shift+F12` anywhere in Windows, or **Automation → Emergency stop** in the menu.

Guides: [one PC](docs/operations/one-pc.md), [multi-PC](docs/operations/multi-pc.md), [preflight](docs/operations/preflight.md), [takeover and recovery](docs/operations/takeover-and-recovery.md), [GSI](docs/integrations/cs2-gsi.md), [observer control](docs/integrations/observer-control.md), [OBS](docs/integrations/obs.md), [replay bridge](docs/integrations/replay-bridge.md), [MatchFrame bridge](docs/integrations/matchframe-bridge.md), [Companion/Stream Deck](docs/integrations/companion-streamdeck.md).

## Production topology

```
CS2 observer client ──GSI (HTTP POST, token)──▶ Matchframe program (engine) ◀── console inside the program (app://matchframe)
        ▲                                         │   │   │                 ◀── program on other PCs (role tokens) / Companion (HTTP API)
        └── observer control adapter (console/keyboard; single writer via control arbiter)
                                                  │   │   └──obs-websocket v5──▶ OBS (program, replay buffer, media)
                                                  │   └──overlay WS (public projection only)──▶ OBS browser sources (HUD)
                                                  └──HTTPS (device token)──▶ website: licence, auto-director usage
```

GSI carries telemetry only — it does not control the camera; observer control is a separate, verified channel. HUD player cards are graphics, not video feeds. See [docs/architecture/overview.md](docs/architecture/overview.md) and [decisions](docs/architecture/decisions.md).

## Development

Prerequisites: Node.js ≥ 22.12 (developed on 22.22.0) and pnpm 10 (`corepack enable`); for the demo pipeline, Python ≥ 3.11 with the worker dependencies ([workers/README.md](workers/README.md)), pointed to with `MATCHFRAME_PYTHON` or `workers/.venv`.

```sh
pnpm install
pnpm dev --sim          # builds what is missing, starts the Matchframe program (engine from source) and the labelled simulation
```

| Task | Command |
|---|---|
| Start the program from source | `pnpm dev` (`--sim` simulation, `--build` rebuild, `--engine-only` headless engine without the program, `--sign-in` show the sign-in screen as release builds do; development opens without signing in) |
| Engine only, from source | `pnpm engine` (API, HUD outputs and captain page; no console) |
| Type check, lint, tests | `pnpm check` (or `pnpm typecheck`, `pnpm lint`, `pnpm test`) |
| Python worker tests | `pnpm test:py` (with `MF_TEST_DEMOS=<demo folder>` to include real-demo tests) |
| Real-integration tests | `MF_TEST_DEMOS=<demos> MATCHFRAME_PYTHON=<python> pnpm test:integration` (OBS tests also need `MF_OBS_URL`, `MF_OBS_PASSWORD`; Postgres test needs `MF_TEST_DATABASE_URL`) |
| Build all apps | `pnpm build` |
| Windows program (.exe) | `pnpm package:win` locally, or the **Windows program (.exe)** workflow (builds, installs and smoke-tests on Windows; publishing a GitHub release attaches the installer to it) |
| Program smoke tests | `pnpm smoke:desktop` (dev program: sign-in against a local website, local + remote mode); `node scripts/packaged-smoke.cjs <program exe>` (packaged/installed program, also signs in against a local website) |
| Website + cloud API locally | `pnpm --filter @matchframe/cloud-web build && MF_DEV_LOG_EMAILS=1 pnpm cloud` |
| Deploy the website | [docs/operations/cloud-deployment.md](docs/operations/cloud-deployment.md) (Docker image, Postgres, Stripe, signing key, SMTP, installer downloads) |
| Demo batch import and validation | program **Demo Library**, or `POST /api/v1/demos/import {"paths":[…]}`; directly: `pnpm worker extract --input demo.dem --dataset-root DATA --validate` |
| Feature building, dataset freezing | `pnpm worker build-features --dataset <dir>`, `pnpm worker freeze-dataset --datasets DATA --out frozen.json`, `pnpm worker audit-split --manifest frozen.json` |
| Training, evaluation, export | program **Training & Evaluation**, or `POST /api/v1/training/runs`; directly: `pnpm worker train …`, `pnpm worker evaluate …`, `pnpm worker export-model …` ([docs/models](docs/models/README.md)) |
| Event export / restore | `GET /api/v1/export/event-package`; `POST /api/v1/import/event-package {"package":…, "mode":"preview"|"commit"}` |
| Diagnostics | `GET /api/v1/diagnostics/bundle` (secrets redacted) |
| API reference / schemas | `pnpm openapi` → `docs/architecture/openapi.json`, `pnpm cloud:openapi` → `docs/architecture/cloud-openapi.json`, `pnpm schemas` → `packages/contracts/schema/` |
| Map coverage report | `pnpm coverage:maps` |
| Simulated soak | `pnpm soak --minutes 20 --out soak.json` |

Engine API calls from scripts need `Authorization: Bearer <token>`: the owner token is in `operator-token.txt` in the data folder; issue role tokens in **Devices & Integrations → Tokens**.

## Repository layout

`packages/` shared libraries (contracts, CS2 state + utility tracker, map runtime, director policy + control arbiter, automation, OBS adapter, game adapters, HUD SDK, MatchFrame bridge, cloud contracts) · `services/` local engine, observer adapters, replay providers, cloud API · `apps/` the Matchframe program (`desktop`), its operator console (`operator-web`), HUD renderer, website (`cloud-web`) · `workers/` Python demo pipeline · `assets/` demo-derived map packs and measured utility profiles · `docs/` architecture, operations, integrations, models, maps, security, storage.

## Licence and provenance

Original Matchframe code and designs. Third-party components and reference material: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No Lexogrine HUD Manager code, assets, account or licence is used or required.
