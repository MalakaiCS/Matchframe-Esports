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
- Electron desktop shell with engine supervision, hardened renderer, safeStorage-protected credentials and global emergency stop.
