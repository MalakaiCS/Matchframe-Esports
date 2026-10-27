# Contracts

All data crossing a process, network or storage boundary is defined once in `packages/contracts` (zod 4) and validated at the boundary. JSON Schemas are generated into `packages/contracts/schema/` (`pnpm schemas`); the HTTP API is described by `docs/architecture/openapi.json` (`pnpm openapi`), generated from the same route schemas.

| Contract | File | Used at |
|---|---|---|
| `MatchState` (+ players, teams, bomb, observer, sources, utility items) | `state.ts` | engine state, operator WebSocket, delay buffers |
| `SourceCapabilities` (per field and per grenade type: `supported` / `partial` / `unsupported` / `unverified`, with build and sample time) | `capabilities.ts` | `/api/v1/capabilities`, director gates, coverage matrix |
| `ObserverCommand`, `CommandContext`, `CommandResult`, `ObservedCameraState` | `commands.ts` | control arbiter ↔ observer adapters |
| `DirectorDecision` (+ candidates, reason codes, control health) | `director.ts` | decision log, operator UI, broadcast report |
| `MapPack`, `Region`, `CameraRecord`, `CameraPath`, `RadarCalibration`, `UtilityCoverageCell` | `maps.ts` | map packs (`assets/map-packs`), camera authoring, coverage |
| `HudManifest`, `OverlayOutput` | `hud.ts` | HUD package import, outputs |
| `Team`, `Player`, `RosterMembership`, `EventRecord`, `EventStage`, `Match`, `MatchFormat`, `MapInstance`, `VetoDecision`, `StatCorrection` | `domain.ts` | SQLite documents, event packages |
| `DemoJob` states and transitions, `RetentionPolicy` | `jobs.ts` | demo library state machine |
| `EventEnvelope<T>` (`schemaVersion`, `topic`, `sessionId`, `epoch`, `sequence`, `sourceId`, match time + uncertainty) | `envelope.ts` | operator WebSocket messages |
| `HudState` (public projection) | `packages/hud-sdk/src/state.ts` | overlay socket, HUD packages |

## Rules

- **Versioning.** Every persisted or streamed top-level object carries `schemaVersion`. Changes are additive within a version; a breaking change adds a new version and a migration (database migrations are append-only and back up the database first). HUD packages declare the `HudState` versions they support.
- **Unknown is not zero.** Absent, empty and null are distinguished (e.g. no `grenades` component vs an empty one); unknown numbers stay `null` (or NaN in model vectors), never 0; SteamID64 is an exact string.
- **Evidence.** Derived events and utility facts carry an evidence level (`EvidenceType`, `common.ts`) — `measured` (reported by the source), `derived` (deterministic from measured data), `estimated` (model/heuristic), `operator` (manual correction) or `unknown`. Predictions are separate objects and are never promoted to confirmations.
- **Time.** Observations carry ingest monotonic time; canonical match time carries its uncertainty; see `overview.md` § Clocks.
- **Simulation.** Every state and HUD snapshot carries `simulated`; simulated data cannot be recorded as setup or camera evidence.
- **Public vs operator.** Only `HudState` leaves through the overlay server; everything else requires an authenticated operator token with the needed permission.
