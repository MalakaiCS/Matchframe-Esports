# Bitfocus Companion / Stream Deck / hotkeys

Matchframe exposes a control-surface API on the local engine (`services/local-engine/src/routes/devices.ts`). Every action goes through the same control arbiter and program arbiter as the operator UI, is permission-checked per action, and is written to the audit log as `device.<action>`.

## Tokens

Issue one token per device with the narrowest role that covers its buttons: `observer` (camera and director actions), `replay` (the replay actions only) or `producer` (director, program and replay actions). Use `POST /api/v1/tokens` `{"role":"observer","label":"Deck A"}` (requires an owner token) or **Devices & Integrations → Tokens** in the console. Revoke with `DELETE /api/v1/tokens/:id`.

## Actions

`GET /api/v1/devices/actions` lists every action with its permission, whether the calling token may use it, and a JSON Schema for its parameters. Run one with `POST /api/v1/devices/actions/<id>` and a JSON body (headers `Authorization: Bearer <token>`, `Content-Type: application/json`). The response is `{action, result, tally}`; errors are `{error, message}` with 400 (bad parameters), 403 (role lacks the action's permission), 404 (unknown action, empty slot) or 409 (not allowed in the current program state).

| Action id | Body | Permission |
|---|---|---|
| `emergency_stop` | `{}` | camera.control |
| `takeover` | `{}` | camera.control |
| `resume` | `{"countdownMs":3000}` | director.control |
| `cancel_resume` | `{}` | director.control |
| `hold` | `{"durationMs":10000}` (`null` = until released) | director.control |
| `release_hold` | `{}` | director.control |
| `follow_action` | `{}` | director.control |
| `observer_mode` | `{"mode":"observer"}` (`off`, `observer`, `observer_cinematics`, `full_action`; Full Action Observer needs a plan that includes it) | director.control |
| `director_mode` | `{"mode":"advisory"}` (editorial mode: `off`, `advisory`, `assisted`, `automatic`, `shadow`, `demo_review`, `delayed_lookahead`; `automatic`/`assisted` keep the current Observer mode, or choose Observer when it is Off) | director.control |
| `select_slot` | `{"slot":1}` (observer slot as reported by GSI) | camera.control |
| `cinematics_round` | `{"disabled":true}` | director.control |
| `bookmark_replay` | `{"label":"Deck bookmark"}` | replay.control |
| `replay_skip` | `{}`: the replay on air ends, the next comes in (or back to live after the last) | replay.control |
| `replay_hold` | `{}` toggles; `{"held":true}` holds the replay on air, `{"held":false}` resumes it (the round clock still cuts back to live) | replay.control |
| `replay_stop` | `{}`: the break's replays end, back to live with Replay out | replay.control |
| `replay_exclude` | `{"next":true}`, `{"rank":1}` (place in the round's list, best first) or `{"id":"rp_…"}`; toggles unless `"excluded"` is given | replay.control |
| `replay_pin` | `{"rank":2}` or `{"id":"rp_…"}`: plays first in its break if it fits; toggles unless `"pinned"` is given | replay.control |
| `return_live` | `{}` | program.control |
| `program_mode` | `{"mode":"BREAK"}` (`STUDIO`, `BREAK`, `MANUAL`) | program.control |

A device that selects a player becomes the manual owner (sticky takeover); automation stays off until someone resumes it. Slot selection is refused when no player occupies the slot.

## Tally

`GET /api/v1/devices/tally` returns a compact object for button feedback: telemetry (`live` / `stale` / `none`), program mode and active replay, automatic replays (`replay`: `state`, `running`, `held`, `onAir` (the clip's label), `position` (`{"n":2,"of":3}`), `waiting`, `pinned`), OBS program/preview scene and stream/record state, director mode/hold/active cinematic, control owner/holder/automation/emergency stop/resume countdown, the on-air POV, and one entry per observer slot (`slot`, `name`, `side`, `alive`, `onAir`). The same object is included as `tally` in the operator WebSocket `state.snapshot` messages.

## Companion setup (Generic HTTP module)

Configure each button as an HTTP POST to `http://127.0.0.1:37211/api/v1/devices/actions/<id>` with the headers above and the body from the table. For feedback, poll `GET /api/v1/devices/tally` and map fields to button colours (e.g. `control.emergencyStopped`, `slots[n].onAir`). If Companion runs on another machine, the engine must be bound to the LAN (see `docs/security.md`), and the token travels in clear text unless the network is trusted.

## Elgato Stream Deck

With a web-request plugin that sends a POST with headers (for example BarRaider's *API Ninja*): URL `http://127.0.0.1:37211/api/v1/devices/actions/<id>`, method POST, content type `application/json`, header `Authorization: Bearer <token>`, the body from the table. A plugin that only opens a URL (GET) can't run actions. Recipes for the replay buttons: [replay-pc.md → Stream Deck and Bitfocus Companion](../operations/replay-pc.md#stream-deck-and-bitfocus-companion).

## Hotkeys

The desktop app registers a global emergency-stop hotkey (default `Ctrl+Shift+F12`; set `MATCHFRAME_STOP_HOTKEY` to change). In the operator console, `F8` or `Pause` triggers STOP AUTOMATION (ignored while typing in a field).

Replays: in the console `Ctrl+Shift+F5` Skip, `Ctrl+Shift+F6` Hold / Resume, `Ctrl+Shift+F7` Stop and go live; and global hotkeys for the same, off until set under Automatic replays → Hotkeys and Stream Deck (a key another program holds is reported, not silently ignored).

## Status

- Device action API and tally: **implemented, tested with fixtures** (engine end-to-end test with real HTTP servers and role tokens).
- Generic HTTP use from Companion: documented, **not tested with Companion or Stream Deck hardware** in this environment.
- A packaged Companion module and a native Stream Deck plugin: **planned** (not built).
