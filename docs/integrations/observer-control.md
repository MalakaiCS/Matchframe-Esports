# Observer control

Matchframe controls the observer through semantic operations (`selectPlayer`, `setObserverMode`, `activateStaticCamera`, `playCameraPath`, `cancelPath`) implemented by adapters. Only the control arbiter writes to the observer.

## The Auto Director (one button)

**Start Auto Director** (HUD Library and Live Control, or `POST /api/v1/director/auto/start`) runs every check below by itself, fixes what it can, and directs the match. You don't need to type commands or run setup tests. The card lists the checks:

| Check | What happens |
|---|---|
| CS2 console | Uses the console of the CS2 that **Start CS2** started (Tools mode) and selects the Direct (console) adapter by itself. If the launch mode was Standard, it switches it to Tools and asks you to restart CS2 with Start CS2. It sends `spec_autodirector 0` so the game's own auto director doesn't fight Matchframe's cuts. |
| Game data | Waits for live GSI data with a map loaded. |
| Account | The account gate for the chosen mode (ADR-021). Nade cams fall back to cinematic cameras on plans without Full Action Observer. A running match is never cut off: the gate is checked at Start only. |
| Player switching | If player selection isn't confirmed on this CS2 build yet, it switches to an alive player and waits for the game data to show that player (3.5 s). It retries every 10 s, for example while CS2 isn't spectating yet. |
| Cinematic cameras | If static cameras aren't confirmed yet, it shows one camera and asks the game where the camera is (`getpos`). If the answer doesn't match, it tries `spec_mode 4` (see below), then `cl_demo_freecam 0` for demo playback. If that fails too, it directs with player POVs only and says why. |
| Auto Director | Arms automatic direction in Observer, Observer & Cinematics or Full Action Observer, depending on the toggles and what works. |

While it runs:

- When you pick a player yourself (in CS2, in Live Control or on a control surface), it pauses and takes the camera back after 8 s. The delay can be 5, 8, 15 or 30 s, or "only when I press Start".
- **Take over** in the top bar keeps the camera yours until you press **Resume automation** or Start.
- After a gap in the game data, it takes the camera back as soon as data flows again.
- **Stop**, the emergency stop, or switching the Observer to Off stops it. It also stops when the hours run out at a map change.
- `GET /api/v1/director/auto` returns the status and checks, and `PUT /api/v1/director/auto/settings` sets `cinematic`, `nadeCams` and `returnAfterSec`.

## Adapters

| Adapter | Mechanism | Status |
|---|---|---|
| None | No game control; advisory/manual only. | Supported |
| Simulation | Drives the labelled simulation source only. Simulates players, cameras and camera paths. | Supported (does not certify real control) |
| Direct (console) | CS2 TCP console via the `-tools -netconport <port>` launch options, loopback only. CS2 opens the console only with `-tools`, which needs the free CS2 Workshop Tools. **Start CS2** in the Observer tools mode starts CS2 this way. The Auto Director (or Start CS2) selects this adapter when none was chosen. Command templates are configurable (Settings → Setup → Command templates); an empty field uses the built-in command. | Confirmed per CS2 build from the game's own feedback (see below) |
| Keyboard | Windows SendInput of the observer-slot number key, only to the focused window whose title matches (default `^Counter-Strike 2$`); needs the optional `koffi` package. No free cameras. | **Unverified** — not testable on this project's Linux CI |

### Console commands

| Operation | Built-in command |
|---|---|
| Select player | `spec_player "{name}"`, with the player's in-game name from the game data. CS2 has no `spec_player_by_accountid` (CS:GO only). Names containing `"`, `;`, `\` or line breaks, and names two players share, are refused rather than sent. Other placeholders: `{slot}` (number key), `{steamId}`, `{accountId}`. When the camera is free, the in-eye mode is sent first: `spec_player` alone only moves a free camera. |
| In-eye / chase / free camera | `spec_mode 4` / `5` / `6` (CS:GO numbering). On a build where `getpos` shows that this numbering doesn't move the camera, the adapter tries CS2's enum numbering (`2` / `3` / `4`). It keeps whichever works and saves it to the templates. The in-eye command is checked the same way: when leaving the free camera for a player, if the game data still shows the free camera, the adapter tries the other numbering's in-eye command once and keeps it if the player then shows. |
| Static camera | `{roaming}; spec_goto {x} {y} {z} {pitch} {yaw}` (`{roaming}` is the free-camera command), then `getpos`. |
| Camera path | The first pose as a static camera, then `spec_goto {x} {y} {z} {pitch} {yaw}` 60 times a second along the path (Catmull-Rom positions, eased timing, the shorter way round for yaw), then `getpos` at the end. |
| Pose readback | `getpos` → `setpos x y z;setang pitch yaw roll`. |

Since the CS2 update of 2026-10-15, demo playback ignores `spec_goto`'s position while the demo free camera is on. `cl_demo_freecam 0` is the workaround reported by players (Valve issue #4660). Live servers and GOTV are not affected.

The console channel is a documented Valve launch option, not memory reading or injection. Because the console accepts arbitrary commands, Matchframe only connects to loopback and fills templates with validated values. Do not expose the netcon port on a network. If a workshop/observer-only server setup is needed for cameras, the server operator must configure it deliberately; Matchframe never changes competitive server settings.

## How control is confirmed

Each kind of control is recorded per CS2 build in `observer.verifiedControl`, from the game's own feedback, never from test data or simulation. Evidence is never downgraded.

| Capability | Confirmed when |
|---|---|
| Player selection | The game data shows the requested player after a request, from the Auto Director's check, a click in Live Control or the setup test. |
| Static cameras | `getpos` answers with the camera's pose (within 16 units across, 72 up or down, 3° of pitch and yaw). |
| Camera readback | Same as static cameras. |
| Observer mode | `partial`, with the first confirmed free camera. |
| Camera paths | `partial` once static cameras are confirmed (the same command, streamed), then `supported` when `getpos` confirms the end of the first path. |

Automatic POV cuts need player selection confirmed. Cinematic shots need static cameras confirmed, and paths need camera paths at least `partial`. Manual requests (player cards, camera requests) are allowed before that, because each one is itself the check.

The setup tests remain available: `POST /api/v1/setup/test-player-selection`, `test-static-camera` with `confirm-static-camera` (operator-confirmed, `partial`), and `reset-verification`.

## Cameras

- **Built-in cameras and paths** for all nine active-duty maps (Ancient, Anubis, Dust II, Inferno, Mirage, Nuke, Overpass, Train, Vertigo) ship in the map packs. They were placed from the maps' navigation meshes by `scripts/generate-map-cameras.py` (ADR-024). They are used without validation unless switched off (Maps & Cameras → **Built-in cameras**, or `PUT /api/v1/cameras/built-in`). They were not checked by eye in CS2; validate or invalidate each one after a look.
- **Your own cameras** from `getpos` (Maps & Cameras → Add camera) are used once validated (`/maps/:map/cameras/:id/validation`). An invalidated camera is never used, built-in or not.
- In freeze time, Observer & Cinematics flies one camera path per round, taking turns through the map's paths, when it fits in the time left. Paths and establishing shots don't count against the round's cinematic budget.

## Confirmation semantics

Writing bytes or sending a key is `transport_only`. A command is `confirmed` when the game data shows the requested player (`observed_exact`) or the console's `getpos` matches the camera pose (`observed_exact`). A free-camera state in the game data that is consistent with a camera or path gives `observed_consistent`. If feedback keeps arriving but never shows the target, the command fails with `confirmation_timeout`. One bounded retry is allowed, for transport errors only.
