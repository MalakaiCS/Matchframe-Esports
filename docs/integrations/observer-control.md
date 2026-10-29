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
- **Chase cam** (on unless unticked): while the spectated player plants or defuses the bomb, and when their team wins the round with them alive, the camera goes behind them (CS2's third-person chase view). It goes back to first person when the moment ends. Each view is held at least 1.5 s, and never during a cinematic shot (ADR-026).
- **Clutch mode** (on unless unticked): when one player is left alone against two or more (any 1vX), the director stays with them.
  - Their score gets +0.45 and each opponent's −0.25.
  - No cuts to cameras until the clutch ends.
  - The chase view while no opponent is within 1800 units, first person again from 1400.
  - With automatic replays on, a won 1v2+ is replayed first in the break (ADR-028).
- **Freeze time** (Observer & Cinematics and up): a shot of each team where it stands, for the whole freeze time (ADR-033, ADR-034).
  - **Team shots:** with the map's free-space grid, the camera is placed for the team's players as they stand (`frameTeam`, packages/director-policy/src/framing.ts). It is 75–300 units above their floor and a few hundred units away (the middle player about 380 units from the lens), looking gently down at them. All of them are in the picture and seen (chest or eyes), from the side they face where possible. It has room round it and floor below it, nobody else stands in the foreground, and no wall stands between the lens and them. It then glides about 10° round them, a little closer, over the shot, still looking at them; the whole glide is checked the same way. A player who walked off or stands on another floor is left out. When the whole team would only fit from far away (one standing well apart), or no spot shows everyone, the one furthest out is left out (down to three of five): a good-sized shot of four beats five far away. Checked on the real freeze-time positions of every round of a pro match on each of the seven maps in the pool (272 team shots, every one framed; all five players in 263, four in the rest: six Dust II rounds leave out a T standing well apart, and three Mirage rounds the T strung furthest along its street).
  - One team, then the other (the Ts first in even rounds), each once a round. A team no spot frames, and any time left after both, gets the map's spawn cameras: they need at least two players in their area or in view within 2600 units, and no camera is shown twice in a round, whether it played or CS2 didn't take it.
  - The time left is shared between shots of 4–12 s (a 20 s freeze time: two of about 10 s), one straight after another with no player view between. The last one runs until the round goes live. At most four per freeze time.
  - A spawn camera turns slowly: 3° a second or less, at most 30° over the shot, one way then the other. Matchframe moves every shot itself (see **Smooth camera motion** below).
  - Camera paths are not used in freeze time unless `cinematic.freezeTimePaths` is on.
- **Pauses** (a tactical timeout, or a technical pause): the camera cuts at once to a still shot of the team that called the timeout (its team shot, else a spawn camera showing it; for a technical pause, the team on screen, else the Ts), and stays there until the round goes live, also after the pause ends (reason `PAUSE`).
- **Start of the round:** first person when the round goes live (a shot still playing is cut), and no overviews in the first 10 s. Bomb shots can still come.
- **No follow cams** (removed in 0.6.5, ADR-037): the Auto Director shows players in first person, cinematic cameras (freeze-time team shots and spawn cameras, the bomb, fight overviews, camera paths) and nade cams.
- **Nade cams** (Full Action Observer, on by default): a camera on a smoke, flash, molotov or HE that matters; coordinated utility (an execute, a flash entry) is taken more readily.
- **Fights before they start:** with the map's free-space grid, the director knows whether two opponents see each other now, or will in the next 1.6 s at their current speed, and cuts to the player before the shooting (ADR-028).
- **HUD graphics** and **OBS scenes** follow the shots too: see [OBS integration](obs.md) and ADR-029.
- `GET /api/v1/director/auto` returns the status and checks, and `PUT /api/v1/director/auto/settings` sets `cinematic`, `nadeCams`, `returnAfterSec`, `chase` and `clutch`.

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
| Chase view | `spec_player "{name}"; spec_mode 5` (the chase command after the player). After the first one, `getpos` must put the camera at least 40 units across from the player. If it doesn't, the adapter tries the other numbering's chase command (`spec_mode 3`) once and keeps it if `getpos` agrees. Leaving the chase view sends the in-eye command before `spec_player`. By hand: `view: "chase"` on `POST /api/v1/observer/commands`, or Shift-click / Shift + number key in Live Control. |
| In-eye / chase / free camera | `spec_mode 4` / `5` / `6` (CS:GO numbering). On a build where `getpos` shows that this numbering doesn't move the camera, the adapter tries CS2's enum numbering (`2` / `3` / `4`). It keeps whichever works and saves it to the templates. The in-eye command is checked from the game data when leaving the free camera, allowing for CS2's game data arriving after the console (see below). |
| Static camera | `{roaming}; spec_goto {x} {y} {z} {pitch} {yaw}` (`{roaming}` is the free-camera command), then `getpos`. |
| Camera path | The first pose as a static camera, then `spec_goto {x} {y} {z} {pitch} {yaw}` 60 times a second along the path (Catmull-Rom positions, eased timing, the shorter way round for yaw), then `getpos` at the end. |

**Leaving the free camera.** CS2's game data arrives a moment after the console has acted (a quarter of a second or more), so the adapter doesn't let it decide too early:

- After a camera or path, the camera counts as free for at least 1.5 s, even if game data from before the shot still shows a player. The next player selection always sends the in-eye command first.
- Leaving the free camera keeps the same in-eye command until the game data has shown the free camera for 2 s since the first try (the director tries again after each confirmation timeout). Only then is the other numbering tried, for as long again, and so on. The first one after which the game data shows a player is kept and saved, also over a numbering saved earlier.

Before 0.6.1 the adapter decided after 0.3 s. With the game data a quarter of a second behind, a camera that had left the free camera still looked free, so the adapter saved the other numbering. From then on every attempt to leave a freeze-time shot failed, and the camera stayed on it into the live round.

**Director log.** `<data folder>/logs/director.log` (Windows: `%APPDATA%\Matchframe Esports\logs\director.log`; 4 MB, the last three kept) records every console line the adapter sends (not the 60-per-second frames of a path or follow cam), each command and its result, each change in the director's decision, and each change in what the game data shows (round, phase, spectated player, camera mode). The support file (**Settings → Diagnostics**) includes its last 400 entries. Send it with a recording when a shot looks wrong.
| Pose readback | `getpos` → `setpos x y z;setang pitch yaw roll`. |
| Replay PC going back | `demo_gototick -{ticks} relative` goes back from where CS2 is, 64 ticks a second (`demo_gototick -448 relative` is 7 s; this works on a live CSTV connection). **Go back and stay behind** sends it once; **Go back for each missed kill** skips forward again with `demo_gototick {ticks} relative`. Connected straight to the game server, CS2 answers "Not currently playing back a demo" and the replay PC stops trying. Whether CS2 went back is measured from the jump in the game data's round clock, not assumed. See [Replay PC](../operations/replay-pc.md). |

Since the CS2 update of 2026-10-15, demo playback ignores `spec_goto`'s position while the demo free camera is on. `cl_demo_freecam 0` is the workaround reported by players (Valve issue #4660). Live servers and GOTV are not affected.

The console channel is a documented Valve launch option, not memory reading or injection. Because the console accepts arbitrary commands, Matchframe only connects to loopback and fills templates with validated values. Do not expose the netcon port on a network. If a workshop/observer-only server setup is needed for cameras, the server operator must configure it deliberately; Matchframe never changes competitive server settings.

## How control is confirmed

Each kind of control is recorded per CS2 build in `observer.verifiedControl`, from the game's own feedback, never from test data or simulation. Evidence is never downgraded.

| Capability | Confirmed when |
|---|---|
| Player selection | The game data shows the requested player after a request, from the Auto Director's check, a click in Live Control or the setup test. |
| Static cameras | `getpos` answers with the camera's pose (within 16 units across, 72 up or down, 3° of pitch and yaw). |
| Camera readback | Same as static cameras. |
| Observer mode | `partial`, with the first confirmed free camera; `supported` when `getpos` confirms the first chase view. |
| Camera paths | `partial` once static cameras are confirmed (the same command, streamed), then `supported` when `getpos` confirms the end of the first path. |

Automatic POV cuts need player selection confirmed. Cinematic shots need static cameras confirmed, and paths need camera paths at least `partial`. Manual requests (player cards, camera requests) are allowed before that, because each one is itself the check.

The setup tests remain available: `POST /api/v1/setup/test-player-selection`, `test-static-camera` with `confirm-static-camera` (operator-confirmed, `partial`), and `reset-verification`.

## Cameras

- **Built-in cameras and paths** for ten maps ship in the map packs: the seven in the active-duty pool (Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke) and Overpass, Train and Vertigo; 466 cameras and 92 paths (ADR-025, ADR-026, ADR-035). Cache's map pack (0.6.3) is built from a pro demo's place names, like Inferno's, Ancient's and Anubis's. The spawn areas of the seven pool maps are where players stood at the end of freeze time in those demos (`scripts/set-spawn-regions.py`): the navigation place names had them 100–500 units off, and on Ancient and Anubis the CT spawn missed the spawn points entirely. The bombsites, mid and spawns have three or two cameras each and the paths. Every other named area has up to two cameras for live play (big-fight overviews and nade cams, no paths); small or enclosed areas (tunnels, ladders, small rooms) have none. `scripts/generate-map-cameras.py` placed them on CS2's own walkable floor (navigation meshes) and checked each one against CS2's collision geometry (build 26144732). A camera has clear space around it, sees its area's centre and at least half of the area (45 % for the extra areas; more than 70 % for most cameras), most of its view is open, and no wall fills the picture: at most a quarter of the whole picture (106° across, CS2's 90° at 4:3) is geometry nearer than 150 units. That last rule (0.6.2) dropped 12 cameras that looked into a wall and moved 13 to better spots. Every camera was also checked for sitting inside geometry or under a floor (the faces it sees all round are the outside faces): none does. The real flight curve of each path is clear of geometry and keeps the area in view. Collision geometry leaves out see-through and non-solid things (glass, fences, foliage), so a shot can still show one of those in front of the action. They are used without validation unless switched off (Maps & Cameras → **Built-in cameras**, or `PUT /api/v1/cameras/built-in`). They were not checked by eye in CS2; validate or invalidate each one after a look.
- **Your own cameras** from `getpos` (Maps & Cameras → Add camera) are used once validated (`/maps/:map/cameras/:id/validation`). An invalidated camera is never used, built-in or not.
- In freeze time, team shots and the spawn cameras are the shots described above. They don't count against the round's cinematic budget. A team shot is shown as camera `team-T` or `team-CT` (a pause's still one `team-T-still` or `team-CT-still`, so a pause cuts to it from the same team's glide; source `framed_live`); it is not stored in the map pack.

**Smooth camera motion.** Every `spec_goto` is a jump in the game, so a camera Matchframe moves glides only when the poses arrive evenly and faster than the recording's frames.
- **Moving shots** (a team shot's glide, a spawn camera's slow turn): the camera is shown at the move's first pose and confirmed there with `getpos`, then Matchframe sends its pose 64 times a second, waiting on timers between them (the engine is idle in between), until the shot's planned end; it stays where the move ends. At a few degrees or a few units a second each step is far below a pixel, so uneven timer ticks don't show. A still stretch sends nothing.
- **Not CS2's turning keys:** in CS2, `+left` and `+right` strafe the camera sideways (they are the A and D keys), and turning is `+turnleft`/`+turnright`. 0.6.1 used `+left`/`+right` to turn freeze-time shots, so the first one of a session slid sideways, into walls and floors, for about a second (on Mirage, into the ground), before the check turned turning off. 0.6.2 sends no movement keys.
- **Paths** are streamed: 128 poses a second, evenly spaced (the loop waits with `setImmediate` between frames, busy while a path plays). Windows timers tick every 15.6 ms, so the earlier 64 a second came unevenly and juddered.
- **Free-space grids** (`assets/map-packs/<map>.grid`, ADR-028): 12-unit cells from CS2's collision meshes for the ten maps.
  - Used for sightlines between players, and for placing and checking the team shots.
  - Checked against the exact geometry: they miss 5–13 % of clear sightlines, and saw through a wall at most once in about 1,350 blocked ones.
- **Replay PC:** a second computer's director avoids the main PC's player (`avoid`, reason `MAIN_OBSERVER_ON_IT`); see [Replay PC](../operations/replay-pc.md).

## Confirmation semantics

Writing bytes or sending a key is `transport_only`. A command is `confirmed` when the game data shows the requested player (`observed_exact`) or the console's `getpos` matches the camera pose (`observed_exact`). A free-camera state in the game data that is consistent with a camera or path gives `observed_consistent`. If feedback keeps arriving but never shows the target, the command fails with `confirmation_timeout`. One bounded retry is allowed, for transport errors only.

The game data lags the console: `getpos` confirms a camera before the game data shows the free camera. So, after a confirmation (from either):
- for 400 ms, a change in the game data is not taken for a human taking over, and the game data catching up with the confirmed command's shot never is;
- for the first 600 ms of a cinematic, a player's view in the game data is taken as data from before the cut: the shot stays on air;
- the same game data evaluated again never sends the same command again.
