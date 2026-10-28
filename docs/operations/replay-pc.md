# Replay PC and automatic replays

Two computers, each with the Matchframe program, CS2 and OBS:

- **PC 1, the main PC:** the on-air observer. Its OBS makes the broadcast.
- **PC 2, the replay PC:** its own CS2 watches the same match. When a kill happens that the main camera missed, PC 2 films it from the killer, saves the last seconds from its OBS replay buffer and sends the clip to PC 1. PC 1 plays it in the break after the round.

PC 1 can also replay big plays its own camera showed (a 3K or more, a won clutch) from its own OBS replay buffer, without a replay PC.

## Best: PC 2 about 7 s behind PC 1

When PC 2's game runs a few seconds later than PC 1's, every kill the main camera misses is known on PC 2 **before it happens there**. PC 2's camera gets on the killer a few seconds before the kill, films it, and sends it. PC 2 measures how far behind it is by itself (from the two round clocks and the kills both see), and shows it in **Replay PC** (for example *7.0 s behind*).

Two ways to get there:

- **PC 1 in the server as a spectator, PC 2 on CSTV:**
  - PC 2 watches the server's CSTV, which is already behind.
  - A CSTV delay of about 7 s (`tv_delay 7`) is best.
  - A long delay (the 90 s or 120 s of public servers) still works, but the clips reach PC 1 after the replay break. They wait in the replay list for the operator to play by hand.
- **PC 1 on CSTV, PC 2 on a second CSTV, 7 s later:** CS2 servers run a second CSTV with its own delay and port. On the server, with the first CSTV at `tv_delay 10`:

  ```
  tv_enable1 1
  tv_port1 27021
  tv_delay1 17
  ```

  PC 1 connects to the first CSTV (`connect server:27020`), PC 2 to the second (`connect server:27021`).

**Same delay, no second CSTV:** PC 2 works live with PC 1 (below), and can rewind a CSTV+ stream (experimental).

## Set up PC 1 (main PC)

1. **Replays & Production → Replay PC → This is the main PC.**
2. Tick **Let other computers on the network connect**. The engine restarts listening on the network; access still needs a code. If Windows asks, allow Matchframe on private networks.
3. Note one of **this computer's addresses** (for example `192.168.1.20:37211`).
4. Press **Make a replay PC code** and copy the code. It is shown once; remove it in Settings → Access to lock the replay PC out.
5. Connect OBS (Settings → Devices) and press **Set up OBS replay scene** in Automatic replays. This adds a *Matchframe Replay* scene with a media source and uses it. Map your live scene in **OBS scenes** if it isn't yet.
6. Tick **Play replays by themselves** in Automatic replays.

## Set up PC 2 (replay PC)

1. Start CS2 with **Start CS2** in a console mode (Observer tools) and spectate the same match. Use a later CSTV if you can (above).
2. Connect OBS (Settings → Devices) with a Game Capture of CS2. Matchframe starts its replay buffer. Set the replay buffer length in OBS to 20 s or more.
3. **Replays & Production → Replay PC → This is the replay PC**: type PC 1's address and the code, then **Make this the replay PC**. The panel shows *Linked* and how far behind PC 1 this computer is. It also shows what it is filming, the clips sent, and kills it couldn't film, with the reason.
4. Press **Start Auto Director** (Observer mode is enough).

## What happens in a round

PC 2 asks PC 1 four times a second who is on air, what PC 1's round clock says, and which kills PC 1 had in the last seconds. PC 1 judges each kill with its exact camera history: did its camera have the killer, only the player who died (**another angle**), or neither (**missed**) in the 2.5 s before it.

**PC 2 behind PC 1 (2.5 s or more):**
- **Timing:** each missed kill (and other angle) is planned at its time on PC 2: PC 1's time plus the delay.
- **Filming:**
  - From the clip's lead-up (5 s before the kill by default, plus 0.6 s for the cut), PC 2's Auto Director is pinned to the killer.
  - After the kill (2 s by default), the replay buffer is saved and sent, if the camera stayed on the killer.
  - Kills by the same player within 4 s go into one clip.
- **One camera:** of two kills that can't both be filmed, PC 2 keeps the better one: more kills first, then a missed kill over another angle. If the player it set aside gets a second kill, it switches to that multi-kill, as long as the kill it was filming hasn't happened yet.
- **Between kills:** PC 2 films anyone but PC 1's player at that moment of the game.

**PC 2 at the same time as PC 1:**
- **Filming:** PC 2's director takes 0.8 off the score of PC 1's player, so it films the other side of the fight, or another fight.
- **Sending:** when a kill happens on PC 2's camera that PC 1 missed, PC 2 waits 2 s, saves its replay buffer and sends it.
- **Rewinding** (experimental, off by default; tick **Rewind to film a missed kill**):
  - **Going back:** on a missed kill PC 2's camera didn't have, CS2 goes back far enough for the kill's lead-up (`demo_gototick`, 3–12 s).
  - **Filming:** that puts PC 2 behind, so the kill is filmed as above.
  - **Back to live:** CS2 skips forward to live again.
  - **CSTV+ only:** only a CSTV+ stream (`playcast`) may be able to go back. A CSTV connection (`connect ip:port`) can't; the panel says so and PC 2 keeps filming someone else.
  - **If CS2 doesn't skip forward:** PC 2 stays behind and keeps filming missed kills from there.

**PC 2 ahead of PC 1:** nothing can be caught early, so PC 2 works as at the same time, and the panel says to swap the delays.

**On PC 1:**
- **When:** replays play from 3.5 s after the round ends until 1.5 s before freeze time ends.
- **Order:** a won clutch first, then 3K+, then missed kills, then other angles.
- **How many and how fast:** by default 2 per break, at real speed. Slow motion at 75 % or 50 % is a setting.
- **The cut:** the program cuts to the replay scene, plays the end of the clip, and goes back to the live scene when OBS reports the clip has ended.
- **Never live:** replays never play during a live round, and stop at once if the round goes live. A replay never plays over a program scene you chose yourself.

## Settings

| Where | Setting | Default |
|---|---|---|
| Automatic replays (PC 1) | Replays per break | 2 |
| | Speed | Real time |
| | Other angles | On |
| | Replay big plays shown live (3K+, won clutches) | On |
| OBS scenes (PC 1) | Replay transition (e.g. a Stinger) | OBS's current one |
| Replay PC (PC 2) | Rewind to film a missed kill (experimental) | Off |

**API:**
- **PC 1:** `GET`/`PUT /api/v1/replays/auto`, `POST /api/v1/replays/obs-setup`, `GET /api/v1/network`.
- **PC 2:** `GET`/`PUT /api/v1/replay-pc` (settings `preRollMs`, `postRollMs`, `rewind`; status `timing`, `rewind`, `filming`, `skipped`, `lastSkip`).
- **The link itself:** `GET /api/v1/replay-link/on-air` and `POST /api/v1/replays/incoming` on PC 1, with the replay code (a `replay` role token). On-air answers carry `clock` (PC 1's round clock) and `kills` (the last 30 s, each with `shown`: `killer`, `victim` or `none`).

## Checked

- **Two engines, same time** (`services/local-engine/test/replay-pc.e2e.test.ts`, stand-in OBS):
  - the link and code;
  - the replay PC avoiding the main player;
  - a missed kill sent with its label and length;
  - a kill the main camera showed not sent;
  - the replay after the round and back to live;
  - a won 1v2 replayed first.
- **Two engines, behind or rewinding** (`replay-pc-timing.e2e.test.ts`): one game played to both, the replay PC's camera following its director's pin.
  - **3 s behind:** the replay PC measures 3 s, pins the killer before the kill plays there, and sends 2 s before to 0.5 s after it.
  - **A single kill and a 2K at once:** the 2K is filmed, even after the replay PC started on the single kill.
  - **Rewinding with a stand-in CS2 console:** it goes back, films the kill with its lead-up, and comes forward to live.
  - **A console that refuses demo commands:** rewinding is marked unsupported.
- **The delay measurement** (`replay-timing.test.ts`): behind, same time, ahead, a paused clock, another round, a rewind and a skip, kills only, readings that disagree.
- **Against a real OBS** (`replay-pc-obs.integration.test.ts`, OBS 30 under Xvfb, both engines on one OBS):
  - the replay buffer saved on the replay PC and the clip uploaded;
  - the one-click replay scene;
  - the clip played on the main PC's replay scene, then back to the live scene.
- **Not checked yet:**
  - two real CS2 clients on two computers over a real network;
  - a real second CSTV;
  - `demo_gototick` on a real CSTV+ stream;
  - Windows OBS.
