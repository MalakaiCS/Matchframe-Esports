# Bitfocus Companion / Stream Deck / hotkeys

Matchframe exposes stable, authenticated HTTP actions on the local API. Issue a role-scoped token for each device (Devices & Integrations → Tokens, or `POST /api/v1/tokens` with role `observer` or `producer`), then configure Companion "Generic HTTP" buttons with header `Authorization: Bearer <token>` and `Content-Type: application/json`.

| Button | Request |
|---|---|
| Emergency stop | `POST /api/v1/observer/emergency-stop` |
| Take manual control | `POST /api/v1/observer/takeover` |
| Resume automation (3 s) | `POST /api/v1/observer/resume` `{"countdownMs":3000}` |
| Cancel resume | `POST /api/v1/observer/cancel-resume` |
| Hold 10 s | `POST /api/v1/director/hold` `{"durationMs":10000}` |
| Release hold | `POST /api/v1/director/release-hold` |
| Follow action | `POST /api/v1/director/follow-action` |
| Select player | `POST /api/v1/observer/commands` `{"kind":"select_player","steamId":"7656…"}` |
| Bookmark replay | `POST /api/v1/replays/bookmarks` `{"label":"Deck bookmark"}` |
| Approve / play clip | `POST /api/v1/replays/:id/approve`, `POST /api/v1/replays/:id/play` |
| Return live | `POST /api/v1/program/return-live` |
| Show cue | `POST /api/v1/hud/cues` `{"kind":"timeout","title":"Tactical timeout"}` |

Every response contains the resulting state or an `{error, message}` explanation (e.g. 409 when not allowed in the current program mode). For tally, poll `GET /api/v1/status` / `GET /api/v1/director/status` (mode, ownership, current shot). Device commands go through the same control arbiter as the UI; a device holding control with a lease reverts to the local operator when the lease expires.

The desktop app registers a global emergency-stop hotkey (default `Ctrl+Shift+F12`, `MATCHFRAME_STOP_HOTKEY` to change); the operator UI also has a stop shortcut that is ignored while typing.

**Status:** HTTP actions are implemented and covered by engine tests; a packaged Companion module and native Stream Deck plugin are **not yet built** and are not verified with hardware.
