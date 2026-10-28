# Replay PC and automatic replays

Two computers, each with the Matchframe program, CS2 and OBS:

- **PC 1, the main PC:** the on-air observer. Its OBS makes the broadcast.
- **PC 2, the replay PC:** its own CS2 watches the same match, and its Auto Director films whoever the main camera *isn't* showing. When a kill happens that the main camera missed, PC 2 saves the last seconds from its OBS replay buffer and sends the clip to PC 1. PC 1 plays it in the break after the round.

PC 1 can also replay big plays its own camera showed (a 3K or more, a won clutch) from its own OBS replay buffer, without a replay PC.

## Set up PC 1 (main PC)

1. **Replays & Production → Replay PC → This is the main PC.**
2. Tick **Let other computers on the network connect**. The engine restarts listening on the network; access still needs a code. If Windows asks, allow Matchframe on private networks.
3. Note one of **this computer's addresses** (for example `192.168.1.20:37211`).
4. Press **Make a replay PC code** and copy the code. It is shown once; remove it in Settings → Access to lock the replay PC out.
5. Connect OBS (Settings → Devices) and press **Set up OBS replay scene** in Automatic replays. This adds a *Matchframe Replay* scene with a media source and uses it. Map your live scene in **OBS scenes** if it isn't yet.
6. Tick **Play replays by themselves** in Automatic replays.

## Set up PC 2 (replay PC)

1. Start CS2 with **Start CS2** (Observer tools mode) and spectate the same match: the same GOTV relay or server, so both PCs see the game at the same time.
2. Connect OBS (Settings → Devices) with a Game Capture of CS2. Matchframe starts its replay buffer. Set the replay buffer length in OBS to 20 s or more.
3. **Replays & Production → Replay PC → This is the replay PC**: type PC 1's address and the code, then **Make this the replay PC**. The panel shows *Linked*, who the main camera has, and the clips sent.
4. Press **Start Auto Director** (Observer mode is enough).

## What happens in a round

- PC 2 asks PC 1 four times a second who is on air, and its director takes 0.8 off that player's score. It films the other side of the main camera's fight, or another fight.
- A kill counts as **missed** when PC 2 had the killer on camera just before it, and the main camera showed neither player in the 2.5 s before it. It counts as **another angle** when the main camera showed only the player who died.
- PC 2 waits 2 s after the kill and saves its replay buffer. Kills by the same player within 4 s go into one clip. It then sends the clip with what it shows (killer, victims, weapon, and how much of the end to play: 5 s before the first kill to 2 s after the last).
- On PC 1, replays play from 3.5 s after the round ends until 1.5 s before freeze time ends: a won clutch first, then 3K+, then missed kills, then other angles. By default 2 per break, at real speed (Slow motion at 75 % or 50 % is a setting). The program cuts to the replay scene, plays the end of the clip, and goes back to the live scene when OBS reports the clip has ended.
- Replays never play during a live round, and stop at once if the round goes live. A replay never plays over a program scene you chose yourself.

## Settings

| Where | Setting | Default |
|---|---|---|
| Automatic replays | Replays per break | 2 |
| | Speed | Real time |
| | Other angles | On |
| | Replay big plays shown live (3K+, won clutches) | On |
| OBS scenes | Replay transition (e.g. a Stinger) | OBS's current one |

API:
- PC 1: `GET`/`PUT /api/v1/replays/auto`, `POST /api/v1/replays/obs-setup`, `GET /api/v1/network`.
- PC 2: `GET`/`PUT /api/v1/replay-pc`.
- The link itself: `GET /api/v1/replay-link/on-air` and `POST /api/v1/replays/incoming` on PC 1, with the replay code (a `replay` role token).

## Checked

- **Two engines with a stand-in OBS** (`services/local-engine/test/replay-pc.e2e.test.ts`): the link and code, the replay PC avoiding the main player, a missed kill sent with its label and length, a kill the main camera showed not sent, the replay after the round and back to live, and a won 1v2 replayed first.
- **Against a real OBS** (`replay-pc-obs.integration.test.ts`, OBS 30 under Xvfb, both engines on one OBS): replay buffer saved on the replay PC, clip uploaded, one-click replay scene, clip played on the main PC's replay scene, back to the live scene.
- **Not checked yet:** two real CS2 clients on two computers over a real network, and Windows OBS.
