# Architecture decision records

Each record states the decision, the evidence behind it and what would make us revisit it. Versions listed are the ones actually installed and tested in this repository's environment (Linux container, Node 22.22.0, pnpm 10.28.0, Python 3.13) unless stated otherwise.

## ADR-001 — Modular monolith with isolated workers
**Decision.** One local engine process (Node/TypeScript) owns match state, the director, the control arbiter, persistence and all APIs. Demo parsing and training run in separate Python worker processes. Electron is only a shell. No distributed queue or container orchestration is required to run a match.
**Why.** Spec §5.1; a single authoritative writer per observer is far easier to make safe in one process. Workers cannot stall the live loop.
**Revisit if.** Multi-observer production needs a second engine per observer (supported by design: one engine per match session).

## ADR-002 — pnpm workspace, TypeScript source packages, esbuild/Vite for builds
**Decision.** Packages export TypeScript source (`exports: ./src/index.ts`); dev uses `tsx`, tests use Vitest; production bundles with esbuild (engine, Electron main/preload) and Vite (operator UI, HUD). TypeScript 6.0.3 (TypeScript 7.0.2 exists but is outside typescript-eslint 8.72's supported range).
**Why.** No per-package build step; one bundle for the packaged engine.

## ADR-003 — Contracts in zod 4, JSON Schema generated
**Decision.** All boundary types (`packages/contracts`) are zod 4.6.7 schemas; `pnpm schemas` writes JSON Schema; `pnpm openapi` writes OpenAPI 3.1 from the router and route body schemas.
**Note.** zod 4 `z.record(enum, …)` is exhaustive; use `z.partialRecord` when keys are optional (found and fixed for HUD manifest entry points).

## ADR-004 — Metadata in Node's built-in SQLite (`node:sqlite`)
**Decision.** Use `node:sqlite` (no native addon) behind `services/local-engine/src/db`. Ordered, append-only migrations; the database file is copied to `backups/` before migrating an existing database. WAL mode, short transactions.
**Evidence (Phase 0).** Works on Node 22.22.0 (SQLite 3.50.4) and inside Electron 44.9.3 under `ELECTRON_RUN_AS_NODE` (Node 24.22.0, SQLite 3.53.4); the bundled engine was run under Electron's runtime with the API and simulation working. The module is still flagged experimental by Node (prints a warning).
**Revisit if.** Node changes the `node:sqlite` API incompatibly; the repository layer isolates the impact.

## ADR-005 — Ports, binding and authentication
**Decision.** GSI 37210, operator API 37211, overlays 37212 (configurable via env/settings; collisions fail loudly). Loopback by default. Every API route except `/health` and `/openapi.json` requires a bearer token mapped to a role; mutations are refused from foreign browser origins; the overlay server is read-only with a per-output token and a strict CSP.

## ADR-006 — Observer control through semantic adapters and one arbiter
**Decision.** `ObserverControlAdapter` (director-policy) with implementations in `services/observer-agent`: `NoControlAdapter`, labelled `SimulationObserverAdapter`, candidate `NetconObserverAdapter` (CS2 `-netconport` console channel, configurable command templates, loopback only, injection-safe), and `KeyboardObserverAdapter` (Windows SendInput via optional `koffi`, only to the focused observer window). The `ControlArbiter` is the single writer: ownership generations, sticky manual takeover, epoch/expiry checks, at most one automated command in flight, bounded retry, confirmation from observed telemetry distinct from transport acknowledgement.
**Status.** Direct and keyboard channels are **unverified**: no CS2 client was available in this environment. Their capabilities stay "unverified" until the setup tests record observed confirmation. No memory reading, injection or anti-cheat evasion is used or planned.

## ADR-007 — GSI field knowledge from public documentation; no GPL code
**Decision.** GSI parsing follows the publicly documented field layout. CounterStrike2GSI (GPL-3.0) was consulted only as documentation; no code or fixtures were copied. All GSI fixtures in this repository are synthetic and labelled as such.

## ADR-008 — Demo parsing with demoparser2 behind an adapter
**Decision.** Python worker with demoparser2 0.42.0 (MIT) behind a `ParserAdapter`; Parquet via pyarrow 26.0.0, queries via DuckDB 2.0.0, Polars 2.1.0, LightGBM 4.7.0, scikit-learn 1.9.1.
**Evidence (Phase 0).** demoparser2 parsed all five available real CS2 demos (2023 builds 13914–14000; Overpass, Anubis, Inferno ×2, Ancient). Grenade entity classes differ by build (shared `CBaseCSGrenadeProjectile` / `CMolotovProjectile` in older builds); event coverage differs by demo (MM/Esportal demos lack most utility/damage events). See `docs/models/phase0-demo-pipeline-report.md`.

## ADR-009 — Live model execution in TypeScript
**Decision.** Trained tree ensembles are exported with LightGBM `dump_model()` and evaluated by a dependency-free TypeScript evaluator (`packages/director-policy/src/model/gbdt.ts`). Unsupported models are rejected and the deterministic baseline policy stays in charge. Parity with Python predictions is checked against exported parity vectors.

## ADR-010 — Region maps from real positions, not invented coordinates
**Decision.** Map packs are built from real parsed positions: per-place voxel cells from demo `last_place_name` samples and floor grids from player Z samples. Sub-regions such as Inferno Bottom/Top Banana are derived splits marked `requires_operator_validation`. Cameras are authored only from captured coordinates (`getpos`). Radar image mode requires an operator-supplied calibrated image; otherwise the HUD draws a schematic outline using the same transform as its markers. No radar calibration values were invented.

## ADR-011 — Public vs operator projections
**Decision.** Browser-source HUDs receive only `HudState` (packages/hud-sdk) for their output's presentation timeline. Director candidates, predictions, lookahead data and operator telemetry exist only on the authenticated operator socket. Delayed outputs read from a per-output delay buffer and show nothing until the buffer has filled.

## ADR-012 — Electron shell hardening
**Decision.** Electron 44.9.3; context isolation, sandbox, no Node integration; the window may only display the loopback engine origin; the preload bridge exposes a few invoke calls and hands the operator token only to frames from the engine origin. Stored credentials are encrypted with a key protected by Electron `safeStorage` (OS credential store). The engine is a supervised child process; restarts never issue camera or scene commands.

## ADR-013 — Original HUD design and fonts
**Decision.** Built-in HUD with three original presets (Classic, Minimal, Arena) over one widget system; fonts Inter and Barlow Condensed (OFL-1.1) bundled via @fontsource 5.3.0 (no remote fonts). No LHM designs, names or assets are used; LHM's manager is under a proprietary EULA and was used only as a functional reference for workflow breadth.

## ADR-014 — Replay: provider interface, honest angles
**Decision.** `ReplayProvider` (services/replay-agent) with an OBS replay-buffer provider (program angle only; save confirmed by OBS's `ReplayBufferSaved` event; clip facts from ffprobe) and a client for a documented bridge contract for the owner's existing replay tool. The tool's real API was not available, so that integration is **blocked**, not simulated.

## ADR-015 — Simulation is a separate, labelled source
**Decision.** The simulation source produces synthetic GSI on a synthetic test map (`de_synthetic`) through the normal ingest path. Every state and HUD snapshot carries `simulated: true`; HUDs and the operator UI show a SIMULATION badge; setup tests and camera validation refuse to record evidence while simulating; real GSI packets are not mixed into simulated state.

## ADR-016 — Hosted website and cloud API for accounts, billing and auto-director hours
**Context.** Matchframe is sold as a downloaded desktop app plus a website that handles signup, billing and auto-director hours.
**Decision.** One TypeScript service (`services/cloud-api`) serves the API and the website (`apps/cloud-web`) from one origin, on Postgres via node-postgres (PGlite in tests and trials). Billing through Stripe Checkout, the customer portal and signed webhooks (applied once per event id); Stripe is the source of truth for subscription state. Computers link with an RFC 8628 device-code flow and receive a revocable device token. The website issues Ed25519-signed licences (24 h validity, 7-day offline grace) that the desktop verifies offline against keys pinned into release builds. The desktop meters automatic direction locally and uploads idempotent usage records; the server keeps the allowance and debits credits under a per-organisation lock. Prices, plans and included hours are editable placeholders.
**Product rules.** Everything except automatic direction on live telemetry works without an account or internet. A billable second requires automation to own a real camera on live, non-simulated telemetry. Hours never run out mid-map: arming is gated, and when hours are used up automation hands back to manual at the next map change. No overage billing.
**Consequences.** The gate is a client-side licensing control, not DRM; the server-side usage record is authoritative for billing. Real Stripe, SMTP and hosting need the owner's accounts; they were exercised with the real Stripe SDK against a local API stub, the email outbox, and a real Postgres 16 server. Details: `docs/architecture/cloud.md`, `docs/operations/cloud-deployment.md`.

## ADR-017 — The operator console runs only inside the Matchframe program
**Context.** The owner wants a physical program downloaded as an `.exe` that holds everything app-related, and a website limited to payments, subscriptions, auto-director hours usage, account management and staff management.
**Decision.** The Electron program bundles the operator console and shows it from its own privileged `app://matchframe` scheme; the main process forwards `/api` and `/assets` requests to the engine (only an allowlist of headers; Chromium refuses forwarded `Origin`/`Host`). The engine no longer serves the console: its HTTP address serves the API (program, control surfaces), a separate captain veto page build for scoped captain links, and — on the overlay port — HUD outputs for OBS browser sources. Remote operator positions use the same program in remote mode (address + role token, stored encrypted) instead of a browser. The installer is built and smoke-tested on a Windows CI runner and distributed from the website (`MF_DOWNLOAD_DIR` or an external URL) and attached to published GitHub releases.
**Consequences.** One supported way to operate (the program); captains and OBS still use plain URLs by design; the website contains no app features. Development uses `pnpm dev` (launches the program) or the Vite dev server with a pasted token.

## ADR-018 — The program signs in with the website account and requires it to open
**Context.** The owner wants the program to have its own email-and-password sign-in, the same account as the website, required before the program can be used.
**Decision.** `POST /v1/device/login` checks the website's email and password (same scrypt hash, rate limits shared with the website sign-in, disabled accounts refused, confirmed email required), asks which organisation when there are several, checks the role and the plan's computer limit, and issues the same per-computer credential as the device-code flow (kept as "sign in with a code"). The password passes through the local engine to the pinned website once and is never stored. The licence names the signed-in person. Computers are signed out when the person's password is changed or reset, the account is disabled, staff sign them out everywhere, or they leave the organisation. Release builds open on a sign-in screen; the program is usable while signed in with a valid or offline-grace licence (7 days). The gate applies when the program opens: being signed out during a session only shows a notice, so a broadcast is never interrupted, and the next start asks to sign in. Remote operator positions use the production computer's sign-in. CI pins each build to the live website's address and licence keys.
**Consequences.** Every production computer needs an account and a computer slot on the plan; LAN events without internet work for 7 days after the last check. The sign-in gate is in the program's console (the engine keeps serving HUD outputs and the captain page), so like the licence it is a licensing control, not DRM. Development builds skip it (`MATCHFRAME_SIGN_IN=off`, the default for `pnpm dev`).
