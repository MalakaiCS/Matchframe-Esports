# CS2 Game State Integration

GSI sends JSON over HTTP to a receiver configured in a `gamestate_integration_*.cfg` file. It is **telemetry, not camera control**.

## Setup

1. **Setup** checklist step 2 → **Detect CS2** (`POST /api/v1/setup/detect-cs2`). Matchframe reads Steam's `libraryfolders.vdf` and `appmanifest_730.acf`; you can enter the CS2 folder manually.
2. **Write GSI config** (`POST /api/v1/setup/write-gsi-config`). Matchframe writes its own file, `game/csgo/cfg/gamestate_integration_matchframe.cfg`, with the receiver URI `http://127.0.0.1:37210/gsi` and a random auth token. Other applications' GSI files are never touched; an earlier version of the Matchframe file is backed up.
3. Restart the CS2 observer client (configs are read at startup) and join the match as a spectator/observer.
4. Setup shows packet counts and the sampled capability report.

## Requested components

`provider, map, round, player_id, player_state, player_weapons, player_match_stats, player_position, allplayers_id, allplayers_state, allplayers_match_stats, allplayers_weapons, allplayers_position, phase_countdowns, allgrenades, bomb, map_round_wins` — throttle 0.02 s, buffer 0, heartbeat 1 s, timeout 1 s.

**Timing:** CS2 sends one update at a time and waits for the answer. Matchframe answers each update before reading it, so its own work never holds CS2 up. An update not answered within the timeout counts as lost, and CS2 sends the full state again at the next heartbeat. The 1 s heartbeat keeps such a gap to a second or two; with 10 s, every HUD went without data for up to 10 s. Matchframe rewrites its config to the current timing when it starts, and CS2 reads it when CS2 starts. The support file lists gaps in the game data and stalls of the program (`feed`).

A requested component is not proof that it arrives. `GET /api/v1/capabilities` reports what the actual feed delivered (per grenade type too). **Status: unverified on a real CS2 build in this project's environment** — field names follow the public GSI documentation; all fixtures in this repository are synthetic.

## What GSI does not provide (by design, reported as unsupported)

- Exact kill events (killer/victim/weapon/headshot/assists, order) — only cumulative counters. The HUD killfeed is explicitly degraded: eliminations, and "probable" pairings when exactly one kill and one opposite-side death change in the same packet.
- Exact damage attribution — only health deltas and cumulative round damage.
- Grenade detonation events — activation is inferred from effect time, fire areas, rest state or fuse-consistent removal (removal alone is never treated as detonation at the last position).
- Molotov vs incendiary — GSI's `firebomb`/`inferno` types do not distinguish them; Matchframe resolves the type from the thrower's inventory delta (derived) or, failing that, team side (estimated, never confirmed).

An authorized server-event adapter or parsed demos are needed for exact events.
