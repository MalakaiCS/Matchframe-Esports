# Replay bridge contract (for the owner's existing replay tool)

**Status: blocked.** The existing replay tool's source/API was not available. Matchframe therefore defines this small HTTP contract; a thin shim next to the replay tool implements it. Nothing here describes the tool's real endpoints.

Base URL configured in Settings (`PUT /api/v1/settings/replay.provider` → `{ "kind": "bridge", "bridgeUrl": "http://…" }`); optional bearer token stored as `replay.bridgeToken`.

| Method | Path | Response |
|---|---|---|
| GET | `/v1/health` | `{ ok: boolean, detail: string }` |
| GET | `/v1/capabilities` | `{ health, listSources, bufferRange, capture, prepare, preview, playout, cancel, export: boolean, limitations: string[] }` |
| GET | `/v1/sources` | `{ sources: [{ id, name, angle: "program"|"recorded_angle"|"delayed_observer"|"offline_render", available }] }` |
| GET | `/v1/buffer` | `{ range: { fromMs, toMs } | null }` (wall-clock ms) |
| POST | `/v1/captures` | body `CaptureRequest` `{ bookmarkId, preRollMs, postRollMs, sourceIds, matchTimeMs, timeUncertaintyMs, epoch, roundNumber }` → `{ clips: ClipRecord[] }` |
| POST | `/v1/clips/:id/cancel` | `{}` |
| POST | `/v1/clips/:id/export` | body `{ destDir }` → `{ path }` |

`ClipRecord`: `{ clipId, providerId, sourceId, angle, matchTimeFromMs, matchTimeToMs, timeUncertaintyMs, epoch, roundNumber, media: { path, durationMs, frameRate, timebase, startPts, hasAudio, width, height }, createdAt }`. Only angles that were actually recorded may be returned; a demo file is not a clip.

Until a shim exists, the built-in **OBS replay-buffer provider** supplies program-angle replays.
