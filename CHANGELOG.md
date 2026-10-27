# Changelog

All notable changes to Matchframe Esports. Versions follow semantic versioning once releases start; this is the pre-release development line.

## [0.1.0-dev] — unreleased

### Added
- Shared zod contracts with JSON Schema and OpenAPI generation.
- CS2 GSI ingest with token authentication, absent/empty/null distinction, epochs and round attempts, duplicate and out-of-order rejection, pause-aware match clock, derived events with explicit evidence levels, capability sampling.
- Universal utility tracker for HE, flashbang, smoke, Molotov, incendiary and decoy from both teams anywhere on the map, with per-type profiles, prediction kept separate from confirmation, fire-area linking, inventory-based Molotov/incendiary resolution, entity-ID reuse handling.
- Map runtime: data-derived regions and floor grids, level separation, calibrated-only radar, schematic radar transform, camera coverage and authoring from `getpos`, revision invalidation.
- Director baseline-1: anticipation/readiness/information features, interaction clusters, crossfires, isolated aggressors, utility opportunities with the Inferno Bottom Banana rule as configuration, explainable weighted candidates, hysteresis planner, cinematic budget and interruption.
- Control arbiter: single writer, ownership generations, sticky manual takeover, emergency stop, confirmation from observed feedback, bounded retry, leases.
- Observer adapters (none, simulation, direct console — unverified, keyboard — unverified).
- Local engine: SQLite persistence with migrations/backups, REST + WebSocket APIs with roles and audit, read-only overlay server, HUD packages and outputs with draft/publish/rollback, veto with captain links, series rules, sponsors with delivery acknowledgements, automation rules, program state machine, replay queue (OBS replay buffer provider; bridge contract), demo library with safe retention, setup tests, statistics, broadcast report, player-camera routing, MatchFrame bridge client, event package export/import, labelled simulation.
- Broadcast HUD renderer with Classic, Minimal and Arena presets and nine variants.
- Electron desktop shell with engine supervision, hardened renderer, safeStorage-protected credentials and global emergency stop; `pnpm smoke:desktop`.
- Operator console (16 screens + captain page) with live control, setup checklist, production, demo and training screens.
- Python demo pipeline (extract/validate/verify, map packs, measured utility profiles, causal features and labels, leakage checks, match-level splits, LightGBM training, evaluation, export, registry) and its engine integration (Demo Library, Training Service).
- Live contact-model runtime in shadow with rejection of live-incompatible or corrupt models; TypeScript/LightGBM parity test.
- Measured utility profiles in the live tracker with uncertainty floors.
- Device control-surface API and tally; event stages with standings and single-elimination brackets on studio HUD panels; HUD Composer offsets applied on air.
- Replay playout confirmed from OBS media status (falls back to LIVE when OBS does not report playback).
- Extension guide and example HUD package; map coverage generator; simulated soak script; Windows NSIS installer and portable zip build.

- **The Matchframe program for Windows** is the only place the operator console runs: shown from `app://matchframe` inside the program with API forwarding; the engine serves no console to browsers (only the API, the captain veto page and HUD outputs). Connection settings let extra operator positions connect to the production computer with a role token. `pnpm dev` launches the program.
- Windows CI workflow: builds the `.exe` installer and portable zip, installs silently, smoke-tests the installed program, uninstalls, uploads artifacts with checksums; publishing a GitHub release attaches the installer, zip and checksums to it.
- **Website** (`apps/cloud-web`) limited to payments, subscriptions, auto-director hours usage, account and team management and staff administration; program download in the signed-in area.
- **Cloud API** (`services/cloud-api`): accounts (incl. name and email changes), organisations and roles, Stripe Checkout/portal/webhooks, plans and hour packs, device-code linking, Ed25519-signed licences with offline grace, idempotent auto-director usage with per-organisation credit locking, staff admin, installer downloads; Dockerfile, compose with Postgres, deployment guide.
- **Staff and user management** on the website: support and admin staff roles (bootstrap admins from `MF_STAFF_EMAILS`), user search and detail, verify emails, resend verification, send reset links, sign users out, give staff roles, disable/enable accounts, edit names and emails; organisation detail; support inbox for the contact form; email log with resend; overview figures. Accounts: signed-in browsers (sign out one or all others) and data export. Public contact form and business details for the legal pages (`MF_COMPANY_NAME`, `MF_SUPPORT_EMAIL`, `MF_LEGAL_*`). Database migration 4.
- **The Observer** (auto director) with four modes: Off (suggestions only), Observer (POV cuts), Observer & Cinematics (adds an establishing shot in freeze time, bomb plant/defuse shots and big-fight overviews from captured cameras) and Full Action Observer (adds nade cameras), which is a plan feature (`fullActionObserver`, Studio by default). Chosen in Live Control, from control surfaces (`observer_mode` action) or `POST /api/v1/director/observer-mode`. Version 0.1.2.
- **Program sign-in** with the website account: the program opens on a sign-in screen (email and password, or a code approved on the website), required in release builds; organisation choice for accounts in several; works offline for 7 days after each check; never locks a program that is already open. Computers are signed out when the password is changed or reset, the account is disabled, staff sign the person out, or they leave the organisation. Windows builds are pinned to the live website's address and licence keys at build time. Version 0.1.1.
- In the program: Account & Hours screen, auto-director meter, arming gate (no account → manual/advisory only; never cut mid-map), auto-director chip in the top bar.

### Changed
- **A cleaner program** (version 0.1.3): sentence-case headings and labels, fewer boxes and badges, disabled-button reasons on hover, a compact top bar (connection, Observer, hours, OBS) and a grouped sidebar with short names. Every screen was tidied, with technical detail and rarely used options folded under disclosures (nothing removed). Live Control has one Camera and one Observer panel; its duplicate Stop automation button is gone (the top bar's stays).
- **The Matchframe Esports logo** (`assets/brand`): program top bar and sign-in screen, Windows program and installer icon (`apps/desktop/build/icon.ico`), website header, footer, favicons and social preview image (`og:image`, filled with `MF_CLOUD_PUBLIC_URL` when the website is served). Website colours retuned from violet to the logo's blues; website product screenshots retaken from the 0.1.3 program.

### Fixed
- Oversize uploads now get a 413 response instead of a connection reset; per-route upload limits.
- Replay queue state errors return 4xx; nested database transactions use savepoints.
- Match creation keeps the stage; the broadcast report's cut rate uses the correct window.
