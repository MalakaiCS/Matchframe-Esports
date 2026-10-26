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

### Fixed
- Oversize uploads now get a 413 response instead of a connection reset; per-route upload limits.
- Replay queue state errors return 4xx; nested database transactions use savepoints.
- Match creation keeps the stage; the broadcast report's cut rate uses the correct window.
