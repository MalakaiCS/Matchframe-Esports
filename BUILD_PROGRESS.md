# Build progress

Last updated: 2026-10-27. Branch: `claude/inspiring-newton-it4omx`. For a resumed session: read this file, `docs/architecture/decisions.md`, `FEATURE_COVERAGE.md`, `docs/acceptance.md` and `docs/backlog.md`, then continue with "Next".

## Completed

**Phase 0 — feasibility (real checks).** node:sqlite under Node 22.22 and Electron 44.9.3; demoparser2 0.42.0 on five real 2023 CS2 demos (throughput, memory, coverage, grenade entity findings, capacity vs 2 TB — `docs/models/phase0-demo-pipeline-report.md`); OBS 30.0.2 over obs-websocket v5; bundled engine under the Electron runtime. Decision records: `docs/architecture/decisions.md`.

**Phases 1–3 — live slice, HUD, director.** Contracts; GSI ingest and reconciliation (epochs, round attempts, duplicates/out-of-order, pause-aware clock, derived events with evidence levels); universal utility tracker (6 types, both teams, whole map) using measured profiles with uncertainty floors; map runtime with four demo-derived packs; baseline-1 director (anticipation, readiness, interactions, utility opportunities incl. flash entries/smoke executes/volleys, Inferno Bottom Banana scenario on synthetic and real geometry, hysteresis, cinematic budget/interruption); control arbiter (single writer, generations, sticky takeover, emergency stop, confirmation from feedback); observer adapters (simulation; console and keyboard — unverified); local engine (SQLite with re-entrant transactions, REST/WS, roles, audit, overlays, delay buffers); built-in HUD (3 presets × 9 variants, standings/bracket panels, composer offsets); veto, series, sponsors, automation, program state machine, replays (playback confirmed from OBS), player cameras with consent, statistics, broadcast report, event packages, device actions/tally, stages/standings/brackets.

**Phases 4–5 — demos and learning.** Python workers (extract, validate, verify, map packs, utility profiles, causal features/labels, leakage checks, splits, LightGBM training, evaluation with match-level bootstrap, export, registry); engine Demo Library and Training Service over the worker CLI (quarantine causes, crash adoption, verified retention, below-normal worker priority); live contact-model runtime in shadow with rejection rules; TypeScript/LightGBM parity.

**Operator console.** `apps/operator-web`: 17 screens (incl. Account & Hours), bundled into the program; captain veto page as a separate build — top bar (SIMULATION, telemetry, director, OBS, program, ownership, resume countdown, EMERGENCY STOP, STOP AUTOMATION F8/Pause), Live Control (roster POV requests with transport vs confirmed feedback, number keys, hold/pin/follow/cinematic/return live, decision explanation), 12-step Setup checklist, Events, Teams & Players (CSV import), Matches & Veto (captain links), HUDs & Composer, Director, Maps & Cameras (getpos authoring, validation, coverage), Replays, Player Cameras, Studio & Rundown, Sponsors & Automation, Demo Library, Training & Evaluation, Devices & Integrations, Settings & Diagnostics. Screenshots: `docs/screenshots/operator/`.

**The Matchframe program (desktop) and packaging.** The program is the only place the operator console runs: it is shown from the program's own `app://matchframe` origin and API requests are forwarded to the engine; the engine's HTTP address serves the API, the separate captain veto page and (on the overlay port) HUD outputs, never the console. Extra operator positions connect from the program to the production computer with a role token (File → Connection settings). `pnpm dev` launches the program. Windows installer and zip are built locally and on Windows CI (below).

**Website and cloud (ADR-016).** `services/cloud-api` + `apps/cloud-web`: the website only handles payments, subscriptions, auto-director hours usage, account and team management (incl. name and email changes) and staff administration, plus the program download (`MF_DOWNLOAD_DIR`). Postgres (node-postgres; PGlite in tests), Stripe Checkout/portal/webhooks, device-code linking, Ed25519-signed licences with 7-day offline grace, idempotent usage upload, per-organisation credit locking. In the program: Account & Hours screen, auto-director meter (billable only when automation owns a real camera on live telemetry of a linked computer), arming gate (HTTP 402 with a reason), never cut mid-map (handback at the next map change). Deployment: root `Dockerfile`, `docker-compose.cloud.yml`, `docs/operations/cloud-deployment.md`.

**HUD Library and the transparent desktop HUD (0.2.0, ADR-020/021).** The program opens into the HUD Library (no sign-in; Settings → Account for the Auto Director). Engine: `hud_library` table and `HudLibraryService` (import ZIP/folder with fail/replace/copy, duplicate, export, remove, rollback, per-HUD settings validated against the manifest form, stop/reload/hide-all, tokens), output pages `/hud/<id>/<variant>` with a transparent scaling wrapper (obs, desktop with edit outline, preview with checkerboard) and a control socket counted as outputs. Program: `apps/desktop/src/hud/` (overlay manager: transparent, frameless, always-on-top, click-through, non-focusable windows in their own session, per-HUD placement across monitors and DPI, edit mode, lock, previews; hotkeys; IPC bridge), tray, close to tray, bounded quit. Console: new layout (sidebar, toolbar, status bar, charcoal theme), library screen and details panel. Bundled HUDs: the Sample CS2 HUD and the Pro CS2 HUD (`apps/hud-template`, adapted from Lexogrine's MIT CS2 React HUD). `scripts/overlay-check.cjs` checks the installed program on Windows CI. Guide: `docs/operations/hud-library.md`.

**Documentation.** README, CAPABILITIES, COMPATIBILITY_MATRIX, FEATURE_COVERAGE, docs/acceptance.md, docs/backlog.md (backlog + risk register), architecture (overview, decisions, contracts, API routes, OpenAPI), operations, integrations, models (+ model card), maps coverage (generated table), security, storage, extensions (+ `examples/hud-minimal`), THIRD_PARTY_NOTICES, CHANGELOG.

## Checks (final run, this environment)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` (unit, fixture, e2e with real HTTP/WS servers, console and website component tests, staff/admin and program sign-in API suites, Observer-mode director tests, engine ↔ website e2e incl. password sign-in and the Full Action Observer plan feature, HUD Library engine e2e, library screen, bundled HUD packages, desktop placement) | 564 passed, 10 skipped (the opt-in real-integration files) |
| `pnpm test:py` without demos / with `MF_TEST_DEMOS` | 56 passed, 9 skipped / 65 passed (unchanged since the last run) |
| `pnpm test:integration` (real demos + Python workers; real OBS 30.0.2) | 8 passed (last run before the cloud work; not affected by it) |
| Cloud API on a real Postgres 16 server (`MF_TEST_DATABASE_URL`) | 2 passed: migrations v1→v4, rollback, catalogue price fill-in, six concurrent computers debit credits exactly once; the staff/admin suite (6 tests) also passed against the same server |
| `pnpm smoke:desktop` (Linux, Xvfb), 0.2.0 | pass — local website started from source; local mode: opens into the HUD Library without signing in (full sidebar), bundled Sample and Pro CS2 HUDs installed, Launch Transparent HUD from the card opens a transparent, always-on-top, click-through, non-focusable window, signs in under Settings → Account with a website account's email and password, console from `app://matchframe`, API forwarding, live WebSocket, hardened window, engine HTTP address serves no console (404), captain page served, navigation lock; remote mode: connected to a second engine with an observer token, no local engine started, desktop HUDs unavailable, HUD thumbnails load from the production computer |
| `scripts/overlay-check.cjs` (Linux, Xvfb, development build), 0.2.0 | 19 passed, 4 skipped (Windows-only screen pixels, click-through, focus; one display): window settings, transparent pixels, edit mode, scale/position, live settings, updates with the manager minimised, OBS output rendered offscreen and transparent, independent outputs, hide-all, recovery after an engine restart, Stop, clean quit |
| Pro CS2 HUD with the labelled simulation through the real HUD server (Chromium, OBS URL) | renders with live data, transparent background, schematic radar; settings (CT colour, radar off) applied live without a reload; no page errors |
| Console cleanup (0.1.3): all 18 screens with the labelled simulation running, 1440×900 | every screen rendered without page errors; Setup 4098 → 2181 px, Live Control 2684 → 1582 px, Maps & Cameras 3325 → 986 px tall
| Packaged program smoke test (`scripts/packaged-smoke.cjs`, Linux unpacked build, 0.1.1) | pass — sign-in screen, real sign-in against a local website, then the checks below |
| **Windows program (.exe) workflow, 0.2.0 with the HUD Library** ([run 40473845631](https://github.com/MalakaiCS/Matchframe-Esports/actions/runs/40473845631)) | **pass** — installed program opened into the HUD Library without signing in, bundled Sample and Pro CS2 HUDs installed, signed in under Settings → Account against a local website, engine 0.2.0 healthy. `scripts/overlay-check.cjs` on the installed program: **23 passed**, 1 skipped (one display) — window settings; real screen pixels over a stand-in game window (game shows through empty HUD areas, not through panels); real mouse clicks pass through to the game, which keeps keyboard focus; edit mode catches the mouse and gives it back; scale/position without stretching; live settings; updates with the manager minimised; OBS source offscreen and transparent; hiding the desktop HUD leaves OBS alone; emergency hide via the real `Ctrl+Shift+F9` hotkey; recovery after an engine restart; Stop; quit with no process left. `MatchframeEsports-Setup-0.2.0.exe` SHA-256 `94b78477…7e4d8` |
| Windows program (.exe) workflow, 0.1.2 with the Observer modes ([run 40444326932](https://github.com/MalakaiCS/Matchframe-Esports/actions/runs/40444326932)) | **pass** — built, pinned to the live website, installed, signed in through the sign-in screen, smoke-tested, uninstalled |
| **Windows program (.exe) workflow on `windows-latest`, 0.1.1 with sign-in** ([run 40439797010](https://github.com/MalakaiCS/Matchframe-Esports/actions/runs/40439797010)) | **pass** — build pinned to the live website (`https://matchframe-esports-production.up.railway.app`, licence key `c3410a1069cd740a` read from it); installed program opened on the sign-in screen and signed in with a website account's email and password against a local website (`signed_in`, method `password`); engine 0.1.1 healthy, console, captain 200, HUD output 200, no console errors; `MatchframeEsports-Setup-0.1.1.exe` SHA-256 `a7b25801…bd56d` |
| Windows program (.exe) workflow, 0.1.0 ([run 40408121752](https://github.com/MalakaiCS/Matchframe-Esports/actions/runs/40408121752), again on the final commit in [run 40409354285](https://github.com/MalakaiCS/Matchframe-Esports/actions/runs/40409354285)) | **pass** — installer built, silent per-user install to `%LOCALAPPDATA%\Programs\Matchframe Esports`, installed program: bundled engine healthy, console from `app://matchframe` (18 nav items), owner API via forwarding, engine root 404, captain 200, HUD output 200, no console errors; program settings in `<data folder>\program`; uninstalled; installer + zip + SHA256SUMS uploaded as an artifact |
| Website container | runtime image (bundle + built website, non-root, health check) on Postgres 16: healthy; website, API and installer download served; downloaded installer byte-identical (SHA-256 `b9ad1c8d…45a2`). The full multi-stage Dockerfile build was **not** run: build containers cannot reach the network through this environment's proxy, and passing the proxy and its CA into the build was refused by the permission classifier |
| Website walkthrough (Playwright against `pnpm cloud`) | public site, account, organisation and staff console pages at 1440×900 and 390×844 (and dark mode), including the support-role view; no console errors, failed requests or horizontal scroll; 105 screenshots in `docs/screenshots/cloud/` |
| `pnpm soak --minutes 20` (simulated) | RSS 150 → 188 MB, flat over the last 12 min; 75/75 automated cuts confirmed; p95 ingest 1.0 ms, evaluation 0.43 ms; logs capped (earlier run) |

Not run here: the official `stripe-mock` binary (running the downloaded binary was refused by the permission classifier; Stripe is exercised with the real SDK against a local stub with real webhook signatures), real Stripe, real SMTP, a public deployment.

Lesson recorded: the two OBS replay tests share one OBS replay buffer, so `test:integration` runs files sequentially (`--no-file-parallelism`).

## Packaging

| Artifact | Built on | Size | SHA-256 |
|---|---|---|---|
| `MatchframeEsports-Setup-0.1.0.exe` (NSIS, per-user, choose directory) | Windows CI, latest ([run 40409354285](https://github.com/MalakaiCS/Matchframe-Esports/actions/runs/40409354285); artifact `matchframe-windows-4c3f5eb…`) | 122 MB | `da2cd5c86c67a7e59d74358b32b398d56c4635a72375b2f6a15562aeccf28c0a` |
| `Matchframe Esports-0.1.0-win.zip` (portable) | Windows CI (same run) | 155 MB | `10341a83f581f9e305723951772f76481ad3fb4d57d45d2ace737df461cbfff2` |
| `MatchframeEsports-Setup-0.1.0.exe` | Linux + Wine (`pnpm package:win`) | 122 MB | `b9ad1c8d4cf58366572fee4354c8b1544b5056be3be24ee82cbcde22512e45a2` |

Contents: Electron 44.9.3 program, bundled engine, operator console (`operator-web`), connection settings page, captain veto page (`captain-web`), HUD renderer, map packs, measured utility profiles, Python worker sources, THIRD_PARTY_NOTICES, optional `cloud.json`. All unsigned (configure `CSC_LINK`/`CSC_KEY_PASSWORD` secrets to sign). Artifacts are not committed; CI artifacts are kept 30 days, and publishing a GitHub release attaches the installer, zip and checksums to it.

## Known gaps in the console (from its review against the engine)

- HUD Composer: visibility, reduced motion and position offsets work on air; resize, new layers, bindings, per-variant layouts, undo and draft preview are not built.
- Player Cameras: routing works; remote intake/mixer has no engine support yet.
- Setup "demo playback" source: guidance only.
- OBS audio: no level metering (the engine does not expose it).

## Exact blockers

| Blocker | Blocks | Needed from the owner |
|---|---|---|
| No CS2 client / observer environment | real GSI ingest, POV cut and static-camera verification, real Bottom Banana shot, real HUD tracking (A02/A03/A11/A22 real parts), live/demo feature parity | an observer PC with CS2 |
| No Windows production desktop | OBS browser sources on Windows, keyboard adapter, a full production (B064) — installation itself passes on a Windows CI runner | a Windows 10/11 machine with CS2 and OBS |
| Stripe, SMTP, hosting | live payments, email delivery, the public website | Stripe account (prices, webhook secret), SMTP credentials, a host with Postgres and TLS |
| Replay tool API not available | replay tool adapter (F19/F20) | its source or integration documentation |
| MatchFrame service API not available | F33 bridge | API/assets documentation and credentials |
| Training corpus not supplied | 1,000/map programme, beta, model promotion | demo corpus (current builds) |
| Code-signing certificate | signed releases (no SmartScreen warning) | certificate as repository secrets |

## Next

1. Owner setup for the website: Stripe products/prices and webhook, SMTP, Postgres host with TLS, `config/cloud.json` from `https://<website>/v1/keys` (the signing key is created and stored in the database), then publish a GitHub release (the workflow attaches the installer) and point the website at it (`MF_DOWNLOAD_WINDOWS_URL`) or place it in `MF_DOWNLOAD_DIR` (docs/operations/cloud-deployment.md).
2. With a CS2 observer environment: run the Setup checklist (real payload → capability report; player-selection test; static-camera test), then `docs/operations/preflight.md`; record results in CAPABILITIES.md and docs/acceptance.md.
3. Capture and validate cameras (Bottom Banana first) with `getpos`; enable automatic cinematics per map only after the static-camera test passes on that map.
4. Build map packs for Mirage, Dust II, Nuke, Train and Vertigo from current-build demos; validate derived regions; author levels.
5. Windows production desktop: OBS browser sources, the keyboard adapter and a real full-match soak; sign the release.
6. Start the 1,000-demos-per-map programme when the corpus arrives; keep models in shadow until release gates are met.
7. Open backlog items: F17 lookahead, the rest of F08 (layers/bindings), Companion module, predictions, cloud asset sync, program auto-update, remote camera intake.
