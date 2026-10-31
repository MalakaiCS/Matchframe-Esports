# Replay PC and automatic replays

Two computers, each with the Matchframe program and CS2:

- **PC 1, the main PC:** the on-air observer. Its OBS (or vMix) makes the broadcast.
- **PC 2, the replay PC:** its own CS2 watches the same match a few seconds later. It knows each kill before it happens there, gets its camera on the killer and films it. Every kill it has time for, by default.
- **Each round:** PC 1 ranks that round's clips, best to worst. In the break after the round it plays the best ones that fit (up to 4) and leaves the rest.

PC 2's picture reaches PC 1 in one of two ways:

- **Replay feed (NDI), like LHM's Replay Feed:**
  - PC 2 sends its whole screen over NDI (vMix Desktop Capture, OBS's NDI output, or NDI Screen Capture).
  - PC 1 records it all the time, keeping the last 4 minutes.
  - PC 2 only tells PC 1 when it filmed a kill, and PC 1 cuts the clip from its recording.
  - PC 2 needs no OBS.
- **Clips from PC 2's OBS:** PC 2 saves each kill from its OBS replay buffer and sends the file.

PC 1 can also replay big plays its own camera showed (a 3K or more, a won clutch) from its own OBS replay buffer, without a replay PC.

## Replay feed (NDI)

**On PC 2 (the replay PC):**
1. Install the NDI runtime: http://ndi.link/NDIRedistV6.
2. Download vMix Desktop Capture NDI (https://cdn.vmix.com/download/vMixDesktopCaptureNDI.zip), extract it (for example to the desktop) and run `vMixDesktopCapture.exe`. It sends the whole screen as an NDI source named after the computer. OBS with an NDI output plugin, or NDI Screen Capture from NDI Tools, works too.
3. Optionally, show a HUD on PC 2's screen (its desktop HUD from the HUD Library): it is part of the picture PC 1 records.
4. Set up Matchframe as the replay PC (below), on a delayed CSTV.

**On PC 1 (the main PC):** Replays & Production → Replay PC → **This is the main PC** → **Replay feed (NDI)**:
1. **Download ffmpeg.** This is a 92 MB download of ffmpeg 7.1 (the gyan.dev essentials build). It is checked against its SHA-256 and kept in the program's data folder. ffmpeg is the encoder: it uses your graphics card's encoder (NVIDIA NVENC, Intel Quick Sync or AMD AMF) when there is one, otherwise the CPU (x264).
2. **Find NDI sources**, then choose PC 2's source, for example *REPLAY-PC (vMix Desktop Capture)*.
3. Tick **Record the replay PC's screen.** The status shows the picture size, frames a second, and how much is kept.

PC 2's panel then says *The main PC records this computer's screen over NDI: no OBS needed here.*

**How it works:**
- **Recording:**
  - The NDI picture is received in a process of its own, never in the engine.
  - It is encoded into one-second H.264 segments, each frame stamped with the time it arrived.
  - The last 4 minutes are kept.
- **Cutting:**
  - When PC 2 has filmed a kill, it sends PC 1 the moment: how long ago the clip began, the kill happened, and the clip ended.
  - PC 1 cuts that stretch from its recording without re-encoding. The cut starts on the second before.
- **Delay:** a setting (default 100 ms) covers the time the picture takes to arrive over NDI.
- **Fallback:** if PC 1 stops recording, PC 2 sends clips from its own OBS again, when it has one.

**Bandwidth:** NDI at 1080p60 is about 100–150 Mbit/s on the network, so use a wired gigabit network between the two computers.

## Best: PC 2 about 7 s behind PC 1

When PC 2's game runs a few seconds later than PC 1's, every kill the main camera misses is known on PC 2 **before it happens there**. PC 2's camera gets on the killer a few seconds before the kill, films it, and sends it. PC 2 measures how far behind it is by itself (from the two round clocks and the kills both see), and shows it in **Replay PC** (for example *7.0 s behind*).

Three ways to get there:

- **Both on the same CSTV (nothing to set up):**
  - **Going back:** when PC 2 finds itself at PC 1's time, CS2 goes back 7 s once (`demo_gototick -448 relative`, 64 ticks a second; a live CSTV connection can do this) and keeps playing from there.
  - **Checking:** PC 2 checks the jump in its round clock and shows *7.0 s behind*.
  - **Reconnects and map changes:** after one, if CS2 is back at PC 1's time, it goes back again.
  - **Settings:** this is **On the same CSTV as the main PC → Go back and stay behind**, the default, with 5, 7 or 10 s.
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

**Connected straight to the game server (not CSTV):** CS2 can't go back there; the panel says so, and PC 2 works live with PC 1 (below).

## Set up PC 1 (main PC)

1. **Replays & Production → Replay PC → This is the main PC.**
2. Tick **Let other computers on the network connect**. The engine restarts listening on the network; access still needs a code. If Windows asks, allow Matchframe on private networks.
3. Note one of **this computer's addresses** (for example `192.168.1.20:37211`).
4. Press **Make a replay PC code** and copy the code. It is shown once; remove it in Settings → Access to lock the replay PC out.
5. Connect OBS (Settings → Devices) and press **Set up OBS replay scene** in Automatic replays. This adds a *Matchframe Replay* scene with a media source and uses it. Map your live scene in **OBS scenes** if it isn't yet.
6. Tick **Play replays by themselves** in Automatic replays.

## Set up PC 2 (replay PC)

1. Start CS2 with **Start CS2** in a console mode (Observer tools) and watch the same match on CSTV (the same CSTV as PC 1 is fine: PC 2 goes back 7 s by itself).
2. Connect OBS (Settings → Devices) with a Game Capture of CS2. Matchframe starts its replay buffer. Set the replay buffer length in OBS to 20 s or more.
3. **Replays & Production → Replay PC → This is the replay PC**: type PC 1's address and the code, then **Make this the replay PC**. The panel shows *Linked* and how far behind PC 1 this computer is. It also shows what it is filming, the clips sent, and kills it couldn't film, with the reason.
4. Press **Start Auto Director** (Observer mode is enough).

## What happens in a round

PC 2 asks PC 1 four times a second who is on air, what PC 1's round clock says, and which kills PC 1 had in the last seconds. PC 1 judges each kill with its exact camera history: did its camera have the killer, only the player who died (**another angle**), or neither (**missed**) in the 2.5 s before it.

**PC 2 behind PC 1 (2.5 s or more):**
- **Which kills:** by default every kill PC 2 has time for (**Kills to film → Every kill**). That includes the kills the main camera showed, so the best plays can be replayed too. The other choice is only the kills the main camera missed or showed from the player who died.
- **Timing:** each kill is planned at its time on PC 2: PC 1's time plus the delay.
- **Filming:**
  - From the clip's lead-up (5 s before the kill by default, plus 0.6 s for the cut), PC 2's Auto Director is pinned to the killer.
  - After the kill (2 s by default), the replay buffer is saved and sent, if the camera stayed on the killer.
  - Kills by the same player within 4 s go into one clip.
- **One camera:** of two kills that can't both be filmed, PC 2 keeps the better one: more kills first, then a missed kill, then another angle, then one the main camera showed. If the player it set aside gets a second kill, it switches to that multi-kill, as long as the kill it was filming hasn't happened yet.
- **Telling PC 1:** each time it asks PC 1 for the state, PC 2 says which rounds it still has kills to film or send. PC 1's break waits for them (below).
- **Between kills:** PC 2 films anyone but PC 1's player at that moment of the game.

**PC 2 at the same time as PC 1:**
- **Filming:** PC 2's director takes 0.8 off the score of PC 1's player, so it films the other side of the fight, or another fight.
- **Sending:** when a kill happens on PC 2's camera that PC 1 missed, PC 2 waits 2 s, saves its replay buffer and sends it.
- **On CSTV, PC 2 doesn't stay at the same time** with the default **Go back and stay behind**: it goes back 7 s and works behind, as above. A missed kill PC 2's camera didn't have, in the moment before it goes back, is filmed too: it goes back far enough for that kill's lead-up.
- **Go back for each missed kill, then live** (the other choice):
  - **Going back:** on a missed kill PC 2's camera didn't have, CS2 goes back far enough for the kill's lead-up (`demo_gototick -N relative`, 3–12 s).
  - **Filming:** that puts PC 2 behind, so the kill is filmed as above.
  - **Back to live:** CS2 skips forward the same distance with `demo_gototick N relative`.
  - **If CS2 doesn't skip forward:** PC 2 stays behind and keeps filming missed kills from there.
- **Connected straight to the game server:** CS2 answers that it can't go back, and the panel says so.

**PC 2 ahead of PC 1:** nothing can be caught early, so PC 2 works as at the same time, and the panel says to swap the delays.

**On PC 1:**
- **When:** replays play from 3.5 s after the round ends until 1.5 s before freeze time ends.
- **Waiting for PC 2:** PC 2 plays the round some seconds later, and the round's last kills are often its best. So the first replay waits while PC 2 still has kills of the round to film or send. It waits up to 8 s, and never when less than 16 s of the break would be left.
- **Ranking:** every clip of the round gets a score, shown with its reasons under Automatic replays:

  | What it shows | Points |
  |---|---|
  | Kills in the clip | 1: 10, 2: 24, 3: 42, 4: 64, 5 (ace): 90 |
  | A won clutch (1vN, N ≥ 2) | 40 + 10 per opponent |
  | Not seen live (the main camera had neither player) | 8 |
  | Another angle (the main camera had only the player who died) | 5 |
  | Knife or Zeus / Deagle or R8 / AWP or Scout | 20 / 4 / 3 |
  | Headshot | 3 |
  | The round's opening kill | 4 |
  | The round's last kill, by the side that won | 5 |
  | A multi-kill within 2.5 s | 6 |

  Two clips of the same kills (for example PC 1's own 3K and PC 2's) count once; the better one stays.
- **How many:** the best clips that fit in the time left, best first, up to **Replays per break** (default 4). The rest are left. A clip that doesn't fit has its lead-up before the kill shortened, down to 2 s, when that makes it fit.
- **How fast:** real speed by default. Slow motion at 75 % or 50 % is a setting.
- **The cut:** the program cuts to the replay scene, plays the end of the clip, and goes back to the live scene when OBS reports the clip has ended.
- **Never live:** replays never play during a live round, and stop at once if the round goes live. A replay never plays over a program scene you chose yourself.
- **Only from the live scene:** automatic replays play while the program is live. The status under **Automatic replays** says when it isn't, and **Return live** (top of Replays & Production) puts it back.
  - **Follows OBS (0.10.2):** when OBS shows your live scene, the program counts as live again. That covers a scene you switched to by hand, and OBS reconnecting on the live scene. Before, the program could stay in "replay playing" or "degraded" while OBS showed the live scene, and automatic replays waited.
  - **Clips played by hand:** after **Approve** and **Play**, the program goes back to the live scene when the clip ends, like an automatic replay.

## Playing replays in vMix

**Play replays in → vMix** (Automatic replays), with vMix on PC 1 and its Web Controller on (vMix → Settings → Web Controller; the address is `http://127.0.0.1:8088` by default). Press **Test vMix**.

For each replay, through vMix's API:
1. The clip is added as a video input (`AddInput`) and started at the part to show (`SetPosition`, `SetRate` for slow motion, `Play`).
2. vMix transitions to it with the chosen transition: Cut, Fade, Stinger 1 or Stinger 2.
3. When the clip ends (or the round goes live), vMix goes back to the input that was on air.
4. The replay input is removed.

If someone puts another input on air during the replay, it is left there.

## Settings

| Where | Setting | Default |
|---|---|---|
| Automatic replays (PC 1) | Replays per break (the best of the round that fit) | 4 |
| | Play replays in | OBS (or vMix: address, transition) |
| | Speed | Real time |
| | Other angles | On |
| | Replay big plays shown live (3K+, won clutches) | On |
| OBS scenes (PC 1) | Replay transition (e.g. a Stinger) | OBS's current one |
| Replay feed (PC 1) | Record the replay PC's screen; its NDI source; encoder | Off; none; the best this computer has |
| Replay PC (PC 2) | Kills to film | Every kill |
| | On the same CSTV as the main PC: go back and stay behind, go back for each missed kill, or don't | Go back and stay behind |
| | How far behind | 7 s |

**API:**
- **PC 1:** `GET`/`PUT /api/v1/replays/auto` (`perBreak`, `mixer`, `vmixUrl`, `vmixTransition`; status `round`, `ranked`, `vmix`), `POST /api/v1/replays/vmix/test`, `POST /api/v1/replays/obs-setup`, `GET`/`PUT /api/v1/replays/feed`, `POST /api/v1/replays/feed/sources`, `POST /api/v1/replays/feed/ffmpeg`, `GET /api/v1/network`.
- **PC 2:** `GET`/`PUT /api/v1/replay-pc` (settings `preRollMs`, `postRollMs`, `sameCstv` (`stay_behind`, `each_kill`, `off`), `behindMs`; status `timing`, `rewind`, `filming`, `skipped`, `lastSkip`).
- **The link itself:** `GET /api/v1/replay-link/on-air?pending=<rounds>`, `POST /api/v1/replays/incoming` (a clip file) and `POST /api/v1/replays/mark` (a moment, with the replay feed) on PC 1, with the replay code (a `replay` role token). On-air answers carry `clock` (PC 1's round clock), `kills` (the last 30 s, each with `shown`: `killer`, `victim` or `none`) and `feed.recording`.

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
  - **Same CSTV, the default, with a stand-in CS2 console:** it sends `demo_gototick -448 relative`, holds 7 s behind at once, pins the killer before the missed kill plays there and sends it. It goes back again after a simulated reconnect.
  - **Same CSTV, each missed kill:** it goes back, films the kill with its lead-up, and comes forward to live.
  - **A console that refuses demo commands** (connected straight to the game server): going back is marked unsupported.
- **The delay measurement** (`replay-timing.test.ts`): behind, same time, ahead, a paused clock, another round, a rewind and a skip, the delay right after going back (before the main PC's matching readings exist), kills only, readings that disagree.
- **Against a real OBS** (`replay-pc-obs.integration.test.ts`, OBS 30 under Xvfb, both engines on one OBS):
  - the replay buffer saved on the replay PC and the clip uploaded;
  - the one-click replay scene;
  - the clip played on the main PC's replay scene, then back to the live scene.
- **Ranking and the break** (`replay-rank.test.ts`, `replay-break.e2e.test.ts`): the score and its reasons; the best clip that fits, its lead-up shortened; six clips of a round, three played best first, a duplicate not played, the rest left; the first replay waiting for the replay PC's last kills; the same through a stand-in vMix (AddInput, SetPosition, Play, CutDirect to it and back, RemoveInput).
- **Every kill** (`replay-pc-timing.e2e.test.ts`): a kill the main camera showed is filmed from behind and sent as `shown`, with its lead-up; PC 1 knows the round is pending until it arrives.
- **The replay feed** (`replay-feed.test.ts`, `replay-pc-timing.e2e.test.ts`, a stand-in NDI source with real ffmpeg): recording in one-second segments stamped with real time; a cut a few seconds back starts and ends on the picture of those moments (to 0.2 s, read from the picture's brightness, which tells the time); a cut whose end is still being written waits for it; two programs, the replay PC without OBS, its missed kill marked and cut on PC 1.
- **Not checked yet:**
  - the real NDI binding receiving a real NDI source (the Windows release build only checks that it loads), and vMix Desktop Capture;
  - the replay feed on Windows (ffmpeg's hardware encoders);
  - a real vMix;
  - two real CS2 clients on two computers over a real network;
  - a real second CSTV;
  - `demo_gototick` sent by Matchframe to a real CS2 on CSTV (the owner uses `-448 relative` and `448 relative` by hand);
  - Windows OBS.
