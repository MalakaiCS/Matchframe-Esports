# Replay PC and automatic replays

Two computers, each with the Matchframe program and CS2:

- **PC 1, the main PC:** the on-air observer. Its OBS (or vMix) makes the broadcast.
- **PC 2, the replay PC:** its own CS2 watches the same match a few seconds later. It knows each kill before it happens there, gets its camera on the killer and films it. Every kill it has time for, by default.
- **Each round:** PC 1 ranks that round's clips, best to worst. In the break after the round it plays the best ones that fit (up to 4) back to back, from the start of the round to its end, fading from one to the next, and leaves the rest. The replays can run on into the next round until its clock reads 1:50.

PC 2's picture reaches PC 1 in one of two ways:

- **Replay feed (NDI), like LHM's Replay Feed:**
  - PC 2 sends its whole screen over NDI (vMix Desktop Capture, OBS's NDI output, or NDI Screen Capture).
  - PC 1 records it all the time, keeping the last 4 minutes.
  - PC 2 only tells PC 1 when it filmed a kill, and PC 1 cuts the clip from its recording.
  - PC 2 needs no OBS.
- **Clips from PC 2's OBS:** PC 2 saves each kill from its OBS replay buffer and sends the file.

PC 1 can also replay big plays its own camera showed (a 3K or more, a won clutch) from its own OBS replay buffer, without a replay PC.

The replay graphic over replays (a REPLAY tag and a lower third), highlight reels of a map's best clips, and highlights on air (a map's best clips on the program, then back to your scene): [replay-graphics-and-highlights.md](replay-graphics-and-highlights.md).

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
  - **Sound:** PC 2's sound, when its NDI sender sends it, is recorded with the picture (AAC, 48 kHz stereo) and every clip cut carries it (below, *Sound*).
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
5. Connect OBS (Settings → Devices) and press **Set up OBS replay scene** in Automatic replays. This adds a *Matchframe Replay* scene with a media source and uses it, and a second one beside it, *Matchframe Replay B*, for fading between replays (below). Map your live scene in **OBS scenes** if it isn't yet. Your own replay scene works too: map it as the replay scene in **OBS scenes**, with its media source.
6. Optionally, pick a Stinger for replays: **OBS scenes → Transitions → Replay in** (and **Replay out**). The Stinger has to be made once in OBS first (Scene Transitions → + → Stinger).
7. Tick **Play replays by themselves** in Automatic replays.

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
- **When:** replays play from 3.5 s after the round ends until the next round's clock reads **1:50** (**Back to live**, a setting). CS2's round starts at 1:55, so the replays can run about 5 s into the next round, while the teams leave spawn.
  - **The time:** in the next round, its own clock (the game's countdown): the cut back to live starts by 1:50 (a quarter second before, as the engine looks every 25–100 ms). Before it is live: freeze time's end (as the game says; until freeze time starts, the round's end plus 15 s) plus the round time less 1:50.
  - **The round time** is what the clock shows when a round goes live (1:55 is assumed until a round has gone live); a server with 1:40 rounds has its 1:50 before the round starts, and the replays end then.
  - **Earlier:** the bomb planted, or the next round already over, ends the replays at once.
  - **Never started in a live round:** the cut to the replays only happens before the next round is live; once it is, they only run on.
  - **Back to live → Before the round starts** is the behaviour before 0.10.5: until 1.5 s before freeze time ends, and stopped at once when the round goes live.
  - **Other times:** 1:52, 1:45, 1:40, 1:35 or 1:30 on the round clock.
- **Waiting for PC 2:** PC 2 plays the round some seconds later, and the round's last kills are often its best. So the break's replays wait while PC 2 still has kills of the round to film or send. They wait up to 8 s, and never when less than 16 s of the break would be left. With replays until 1:50 a break has about 6 s more, so with 15 s of freeze time the wait is no longer cut short (before, only about 1 s of it was left): PC 2's last clip of the round reaches PC 1 about 10 s after the round ends (7 s behind, 2 s after the kill, the save), inside the 11.5 s the break waits.
- **Which round a clip is of:** the round being played, or, once it is over, the round that just ended. CS2 counts a round as played when it ends, so its round number moves on then: before 0.10.5 a kill after the round was won (an exit frag, a saving player hunted down) was put in the next round, and played first in its break. Now PC 1's game data says which round was last live, for its own kills, the kills it tells PC 2 about (PC 2 files its clips under them), bookmarks, and PC 2's own kills.
- **Never played automatically** (whatever a clip says):
  - a clip of a round whose break is over (its replays done, or the next round's 1:50 reached), or of an earlier round: a clip that comes late waits in the replay list for playing by hand;
  - a clip with no round;
  - a clip made before its round went live: a round played again after a restart or a backup has the same number.
  - The list under Automatic replays shows a clip of the round that came before it started, or after the break's replays were chosen, as *Not played*, with why.
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
- **How many:** when the break's replays start, PC 1 chooses the best clips that fit together in the time left, up to **Replays per break** (default 4). The rest are left. A clip that doesn't fit has its lead-up before the kill shortened, down to 2 s, when that makes it fit. The time counted is up to 1:50 on the next round's clock, each clip at its speed, one cut to the replay and back (0.6 s) and 0.4 s from one clip to the next (a fade between them overlaps them instead, so that is spare). Before each clip the time left is checked again (freeze time may turn out shorter): a clip that no longer fits is shortened again, or skipped. Clips of the next round never join a break that runs on into it.
- **Order:** the chosen clips play in **round order** by default, from the start of the round to its end. A clip's place is the moment of its first kill as PC 1 saw it in its own game data, the same clock for PC 2's clips and PC 1's own. A clip whose kills PC 1 didn't see (a clutch) goes by when it arrived, less its part after the lead-up. **Order → Best first** plays the best one first instead.
- **How fast:** real speed by default. Slow motion at 75 % or 50 % is a setting.
- **Transitions:** one transition to the replays for the whole break (**Replay in**), the clips one after another, fading into each other (**Between replays**), and one transition back to the live scene after the last (**Replay out**). The status reads *Replay 2 of 3: …* meanwhile.
  - **Replay in / Replay out** (OBS scenes → Transitions): any of OBS's transitions, such as a Stinger, or OBS's current one. Replay out is the same as Replay in unless chosen. They are used whoever changes the program: automatic replays, a clip played by hand, **Return live**.
  - **Other scenes:** the transition to and from the break and studio scenes, by the OBS automation or your own program buttons.
  - **Highlights in / Highlights out:** into highlights on air and back out of them (to the scene the program came from). The same as Replay in and Replay out unless chosen. See [replay-graphics-and-highlights.md → Highlights on air](replay-graphics-and-highlights.md#highlights-on-air).
  - **OBS's own transition** (and its duration) is put back once OBS says the transition has ended: a Stinger's whole video, not a fixed time.
  - **A Stinger** has to be made once in OBS first (Scene Transitions → + → Stinger, with its video); then it can be picked here. With a Stinger in, the first clip plays from the Stinger's cut point (its transition point), when the replay scene shows.
  - **Match graphics:** putting a match's stingers in OBS makes *Matchframe Replay Stinger* Replay in and out where none is chosen.
- **Between replays** (Automatic replays): **a fade** of 0.5 s by default (0.3, 0.75 or 1 s), or **a cut**.
  - **Two replay scenes:** OBS can't fade a media source into itself, so Matchframe keeps a copy of your replay scene, **"<your replay scene> B"**, with the same sources (shared, as OBS's *Add Existing*: one score bug shows in both), the same positions, sizes, crops, visibility, blend modes and order, and a media source of its own, **"<your media source> B"**, with the same settings, filters and audio. It is built, or brought up to date with your replay scene, off air at the start of each break and by **Set up OBS replay scene**. Leave it to Matchframe: changes go in your own replay scene.
  - **The clips alternate between the two scenes.** The first is loaded in your replay scene before the transition, held (paused) at its part, and plays as the replay scene comes on. While a clip plays, the next waits in the other scene, loaded and held at its part. One fade length before the clip on air ends, the next plays and the program fades over to its scene with OBS's Fade (found by its kind, whatever its name in your language), so the end of one blends into the start of the next. With **Cut**, the program cuts over as the clip on air ends: no black frame either, as the next is ready.
  - **The media sources:** both play while hidden, keep their place when shown and hold their last frame, so Matchframe turns off *Restart playback when source becomes active*, *Close file when inactive* and *Show nothing when playback ends* on your replay media source (OBS's defaults for a new Media Source are the other way round). If one is turned back on, the clip is still skipped to its part once shown, but the fade may start on the clip's first frames.
  - **Measured** (OBS 30.0.2 on Linux, recordings read frame by frame): your scene with a backdrop, the media source scaled and moved, and a score bug on top. Between two 720p30 clips, 14 frames (0.47 s) of the two blended, the mix moving from one to the other frame by frame; no black frame, no frame of a clip's start; the backdrop and the score bug through every fade, in both scenes; each clip from its part.
  - **No second scene** (your media source is in a group, or isn't a Media Source): the clips play in your replay scene's one source, as before 0.10.5: the next is loaded as the one before ends, which shows one black frame and about 0.1 s of the next clip's first frame. The panel says why.
  - **Keyframes:** OBS skips to the keyframe before a clip's part, not to the exact frame, so a clip can start up to one keyframe interval early (with OBS's default of 250 frames, about 4 s at 60 fps; 1 or 2 s keyframes are better). That is more lead-up, not a gap.
- **Stops:** the break's replays stop, back to the live scene with Replay out, when the next round's clock reaches 1:50 (or, with **Before the round starts**, when the round goes live), the bomb is planted, or automatic replays are turned off. If you (or anything else) change the program meanwhile, it is left as you put it and no further clip plays: in Matchframe, or in OBS (a scene clicked, the Transition button in Studio Mode, even to one of the two replay scenes). A clip that doesn't play is skipped and the next one plays; if none plays, the program goes back to the live scene.
- **Only from the live scene:** automatic replays play while the program is live. The status under **Automatic replays** says when it isn't, and **Return live** (top of Replays & Production) puts it back. On a scene of yours in OBS, they wait for you (see *Switching scenes yourself*).
  - **Follows OBS (0.10.2):** when OBS shows your live scene, the program counts as live again. That covers a scene you switched to by hand, and OBS reconnecting on the live scene. Before, the program could stay in "replay playing" or "degraded" while OBS showed the live scene, and automatic replays waited.
  - **Clips played by hand:** after **Approve** and **Play**, the program goes back to the live scene when the clip ends, like an automatic replay.
  - **The second replay scene** counts as the replay scene: a break that ends on it goes back to live from it, and OBS showing it never makes the program "manual".

## Switching scenes yourself (multiview)

You can switch OBS's scenes yourself at any time (a multiview plugin, OBS's own buttons, a hotkey, Studio Mode's Transition button): to an analysis scene between rounds, the casters during the replays, your break or studio scene. Matchframe follows OBS and never fights it:
- **Your scene:** a scene OBS shows that Matchframe didn't put there, other than your live scene, is yours (even your mapped break, studio or replay scene). The program follows it (*manual*, yours, named after the scene) and Matchframe changes nothing until OBS shows your live scene again: no replays cut in, no break or studio scene, no cut back at 1:50. Matchframe's own changes (its replays, the second replay scene during them, the break scene for a timeout) don't count.
- **The status says so, it isn't an error:** *OBS shows “Analysis” (your scene): replays wait until you're back on the live scene.* Test replays wait the same way.
- **Back on the live scene** (in OBS, or **Return live**): live again, as before. During a break with time left (before the next round is live), its replays play then, the ones that still fit.
- **During the replays:** switching OBS to one of your scenes stops them (the clip on air stays where it is in its scene); the live game audio goes back up; nothing more plays and nothing cuts away from your scene, not the 1:50 cut back, not Stop. Back on the live scene in time, the rest of the break plays; **Stop and go live** meanwhile cancels that.
- **Break and studio scenes:** Matchframe only takes back the break or studio scene it put on itself (a timeout, the end of a map); one you put on stays until you change it.
- **Studio Mode** (a plugin may put a scene in preview and press Transition): followed the same way. **After a restart, or OBS reconnecting,** on one of your scenes: it's yours too.

## OBS Studio Mode

Automatic replays work with Studio Mode on, and leave your preview alone:
- **The program** changes with obs-websocket's *SetCurrentProgramScene*, which in Studio Mode transitions the program (with the chosen transition) without taking the preview.
- **Swap Scenes** (on by default) then puts the scene the program left in preview, at the end of each transition. Matchframe puts your preview back a moment later (about 0.15 s; you may see it flicker), unless you changed it meanwhile.
- **Duplicate Scene** (on by default): the program shows a private copy of the replay scene under the same name. Its media source is the same source, so loading, holding and skipping clips works. **Duplicate Sources** doesn't change that: OBS never copies a Media Source (checked with OBS 30.0.2: the clips and fades were on program with it on).
- **Your Transition button** during a break counts as taking the program, even with a replay scene in preview: no further clip plays and the program stays where you put it, followed as your scene (above). So does any program change made in OBS.
- **The second replay scene** isn't changed while it, or your replay scene, is in preview: the break then uses it as it is (or, before it exists, your replay scene's one source).
- **Measured** with OBS 30.0.2 (Studio Mode, Swap Scenes and Duplicate Scene on): three clips on program with a Stinger in and out and two fades; the preview back on the operator's scene after each transition; the Transition button pressed during the first clip (with the twin in preview) seen within 0.2 s, and the break left alone.

## Playing replays in vMix

**Play replays in → vMix** (Automatic replays), with vMix on PC 1 and its Web Controller on (vMix → Settings → Web Controller; the address is `http://127.0.0.1:8088` by default). Press **Test vMix**.

For each break, through vMix's API:
1. The first clip is added as a video input (`AddInput`), set at the part to show (`SetPosition`, `SetRate` for slow motion) and started (`Play`). vMix transitions to it with **Replay in**: Cut, Fade, Stinger 1 or Stinger 2.
2. While a clip is on air, the next one is added and set up the same way. One fade length before the clip on air ends, the next plays and vMix fades to it (`Fade` with the fade's `Duration`); with **Between replays → Cut**, vMix cuts to it (`CutDirect`) as the one on air ends. It is loaded already, so there is no gap.
3. After the last clip (or when the next round's clock reaches 1:50), vMix goes back to the input that was on air before the break's replays, with **Replay out** (the same as Replay in unless chosen).
4. The replay inputs are removed.

If someone puts another input on air during the replays, it is left there and no further replay plays.

Everything below (the controls, Stream Deck, hotkeys, the sound, Test replays) works with vMix too.

## Your controls during the replays

While a break's replays play, **Automatic replays** shows three buttons above its settings:

- **Skip:** the clip on air ends now. The next one comes in as usual (the fade, or the cut), already waiting at its start; after the last, back to live with Replay out.
- **Hold / Resume:** the clip on air pauses where it is (OBS's or vMix's pause) and nothing plays on until **Resume**, which plays it on from there. The round clock still wins: at 1:50 (or the bomb planted, the round over) the program goes back to live, held or not, so a hold can never keep a replay over the live round.
- **Stop and go live:** the break's replays end now, back to the live scene with **Replay out**. The clips that didn't play stay in the replay list for playing by hand. Pressed between the round's end and the first replay, the break has none.

In the round's list (*Round 7: its clips, best first*), each clip that hasn't played has two buttons:

- **Exclude:** it doesn't play in its break (**Include** lets it play again).
- **Pin first:** it plays first in its break, if it fits (even a clip with the same kills as a better one). Pinned while the break's replays play, it plays next: if another clip was already waiting in the second replay scene, Matchframe loads the pinned one there instead, and a clip that wasn't chosen joins the break. One clip at a time is pinned.

These apply to the current break, or the next one of that round (during the round, before it ends). A clip whose break is over can't be pinned: play it by hand.

Every control is in the audit log (`replay.auto_skip`, `replay.auto_hold`, `replay.auto_resume`, `replay.auto_stop`, `replay.auto_exclude`, `replay.auto_pin`).

## Stream Deck and Bitfocus Companion

The same controls are actions of Matchframe's control-surface API (see [Companion / Stream Deck](../integrations/companion-streamdeck.md)): `POST http://127.0.0.1:37211/api/v1/devices/actions/<action>` with the headers `Authorization: Bearer <token>` and `Content-Type: application/json`.

| Button | Action | Body |
|---|---|---|
| Skip | `replay_skip` | `{}` |
| Hold / Resume (one button) | `replay_hold` | `{}` (toggles; `{"held":true}` holds, `{"held":false}` resumes) |
| Stop and go live | `replay_stop` | `{}` |
| Exclude the next clip | `replay_exclude` | `{"next":true}` |
| Exclude the round's best clip | `replay_exclude` | `{"rank":1}` (its place in the round's list, as shown) |
| Pin the round's 2nd clip first | `replay_pin` | `{"rank":2}` (`{"id":"rp_…"}` for a clip by its id) |
| Play highlights | `highlights_play` | `{}` (what and how many as set under Highlights on air) |
| Stop highlights | `highlights_stop` | `{}` (Skip and Hold on a highlight: `replay_skip`, `replay_hold`) |
| Don't show highlights at halftime | `highlights_halftime` | `{}` (toggles; `{"on":true}`, `{"on":false}`) |

Exclude and Pin toggle; `"excluded":false` or `"pinned":false` undoes one.

**A token for the device:** Settings → Access → make a token with the **replay** role (or **producer**), labelled for the device, for example *Stream Deck*. Don't reuse the replay PC's code: a device token can be removed on its own.

**Bitfocus Companion** (the *Generic: HTTP Requests* module), one button per action:
1. Add a connection *Generic: HTTP Requests*, Base URL `http://127.0.0.1:37211` (or the main PC's address, with **Let other computers on the network connect** on).
2. Button → Press action **POST**: URL `/api/v1/devices/actions/replay_skip`, Body `{}`, Header `{"Authorization":"Bearer <token>"}`, Content type `application/json`.
3. For lights, Companion can read `GET /api/v1/devices/tally` (same header): `replay.running` (replays playing), `replay.held`, `replay.onAir` (the clip's label), `replay.position` (`{"n":2,"of":3}`), `replay.waiting`, `replay.pinned`; for highlights `highlights.running`, `highlights.held`, `highlights.onAir`, `highlights.position`, `highlights.ready`, `highlights.halftime` and `highlights.noHalftime` (Don't show highlights at halftime).

**Elgato Stream Deck** with a web-request plugin that sends a POST with headers (for example BarRaider's *API Ninja* from the Stream Deck store): URL `http://127.0.0.1:37211/api/v1/devices/actions/replay_skip`, method POST, content type `application/json`, header `Authorization: Bearer <token>`, body `{}`. One button per action. A plugin that can only open a URL (GET) won't do: the actions need POST and the header.

An answer of 409 means nothing to do now (no replay on air), 403 a token without the replay role.

## Hotkeys

- **In the console** (while its window has the focus, not while you type in a field): **Ctrl+Shift+F5** Skip, **Ctrl+Shift+F6** Hold / Resume, **Ctrl+Shift+F7** Stop and go live. On any screen. Highlights on air: **Ctrl+Shift+F9** Play highlights, **Ctrl+Shift+F10** Stop highlights (Skip and Hold are F5 and F6).
- **Global hotkeys** (the Matchframe program; they work with CS2 or OBS in front): Automatic replays → **Hotkeys and Stream Deck**. Off until you set them, since a global hotkey takes its keys from every other program. **Use the suggested keys** sets the same three, which CS2 and OBS don't use by default; or type your own (for example `Ctrl+Alt+F9`), a modifier and a key, or a function key alone.
  - A key another program (or Windows) holds isn't registered: the panel says so in red, *Ctrl+Shift+F5 is already taken by another program (or Windows): choose another key for Skip.* Choose another, or free it in the other program (for example a hotkey you set in OBS).
  - The program's own hotkeys (emergency stop Ctrl+Shift+F12, save the CS2 view Ctrl+Shift+F11, the desktop HUD hotkeys) are refused.
  - They are kept on this computer, with the program's settings.
  - **Highlights on air → Hotkeys and Stream Deck:** Play highlights and Stop highlights the same way (suggested Ctrl+Shift+F9 and Ctrl+Shift+F10), also off until set.

## Sound

**Replays carry the replay PC's game sound.**
- **Replay feed (NDI):** PC 1 records the sound PC 2's NDI sender sends with its picture. Turn the sender's sound on:
  - **vMix Desktop Capture:** choose the computer's sound (the audio device) in it, so the NDI source carries audio.
  - **OBS with an NDI output:** it sends OBS's mix; keep the game's sound in it (Desktop Audio, or an Application Audio Capture of cs2.exe) and mute or remove microphones.
  - **NDI Screen Capture:** turn on its system audio.
  - The Replay feed panel says *The replay PC's sound is recorded* while recording. A sender without sound is recorded with silence, so clips still have a sound track.
- **Clips from PC 2's OBS replay buffer** carry whatever PC 2's OBS records. On PC 2:
  - The game's sound in OBS's mix: **Desktop Audio** (Settings → Audio), or an **Application Audio Capture** of cs2.exe in the scene.
  - Mute or remove **Mic/Aux** there, or every replay has PC 2's room sound.
  - **Settings → Output:** in *Simple* mode the replay buffer records the mix; in *Advanced* mode, Recording → **Audio Track 1** ticked, and the game's source on track 1 (Edit → Advanced Audio Properties).
  - PC 1's big plays come from its own replay buffer: the same settings on PC 1.

**Replay volume** (Automatic replays → Sound): both replay media sources (your replay scene's and its copy), so replays can be louder (+3, +6 dB) or quieter (−3, −6, −10 dB) than recorded. *As set in OBS* (the default) leaves them alone. With vMix: each replay input's fader (above 0 dB, its gain).

**The live game audio, turned down during replays:**
1. Automatic replays → Sound: tick the OBS audio inputs that are the live game's sound (for example *Game capture* or *Desktop Audio*). The list has every input with audio (**Find audio inputs** reads it again). Only those ticked are touched: leave casters' microphones unticked. The replay media sources can't be ticked.
2. **Live game audio during replays:** muted, −10 dB, −20 dB (the default) or −30 dB.
- As the first replay comes in, they go down with a short ramp (0.3 s, in steps); after the last, back to **exactly** their volume and mute before, with the same ramp, as the program goes back to live. However the replays end: the last clip, Skip, Stop and go live, the round clock, a clip that doesn't play, someone taking the program.
- If you move one of those faders yourself during the replays, it stays where you put it.
- **A crash or a restart in the middle of a break:** their volumes are saved before they are touched, so the next start puts them back as soon as OBS connects (vMix: answers). The panel says *Turned down for replays: …* until then.
- **vMix:** the same with vMix inputs (by their key; `SetVolumeFade` down and back, `AudioOff`/`AudioOn` for muted).

## Test replays

Automatic replays → **Test replays** plays two sample clips (*Test clip 1* in blue, *Test clip 2* in orange, each 4 s with a tone; part of the program) on your program output, through exactly the path a break's replays take: the replay scene and its copy, **Replay in**, the fade between them, **Replay out**, the live game audio turned down and back, and the replay graphic (they carry a play: *Test Player*, AK-47, headshot).
- It asks first: *This plays on your program output now.*
- It refuses, and says why, while a round is live, while the program isn't live, and while a break's replays play or are about to.
- Skip, Hold and Stop work on it too.
- **The report**, step by step, with what to do about a step that failed:
  1. Replay scene and twin ready (vMix: vMix ready)
  2. Transition in (Replay in), with the transition used
  3. The fade between the clips (or the cut)
  4. Transition out (Replay out)
  5. Back live (the program live, OBS on your live scene)
  6. Live audio turned down and put back exactly (skipped when none is ticked)
- The sample clips are never in the replay list, a round's ranking, a break or a highlight.

## Settings

| Where | Setting | Default |
|---|---|---|
| Automatic replays (PC 1) | Replays per break (the best of the round that fit) | 4 |
| | Order (round order or best first) | Round order |
| | Back to live (by a time on the next round's clock, or before the round starts) | By 1:50 |
| | Between replays (a fade and its length, or a cut) | Fade, 0.5 s |
| | Play replays in | OBS (or vMix: address, Replay in, Replay out) |
| | Speed | Real time |
| | Other angles | On |
| | Replay big plays shown live (3K+, won clutches) | On |
| Automatic replays → Sound (PC 1) | Replay volume | As set in OBS |
| | Live game audio during replays (the inputs ticked: muted, −10, −20 or −30 dB) | None ticked; −20 dB |
| Automatic replays → Hotkeys (PC 1, the program) | Global hotkeys: Skip, Hold / Resume, Stop and go live | Off (suggested: Ctrl+Shift+F5, F6, F7) |
| OBS scenes → Transitions (PC 1) | Replay in (e.g. a Stinger) | OBS's current one |
| | Replay out | The same as Replay in |
| | Other scenes (to and from the break and studio scenes) | OBS's current one |
| | Highlights in, Highlights out (highlights on air) | The same as Replay in, Replay out |
| Replay feed (PC 1) | Record the replay PC's screen; its NDI source; encoder | Off; none; the best this computer has |
| Replay PC (PC 2) | Kills to film | Every kill |
| | On the same CSTV as the main PC: go back and stay behind, go back for each missed kill, or don't | Go back and stay behind |
| | How far behind | 7 s |

**API:**
- **PC 1:** `GET`/`PUT /api/v1/replays/auto` (`perBreak`, `order` (`round`, `best`), `cutBack` (`clock`, `before_round`), `cutBackClockSec` (110 = 1:50), `between` (`fade`, `cut`), `fadeMs`, `mixer`, `vmixUrl`, `vmixTransition`, `vmixTransitionOut` (null: as `vmixTransition`), `replayVolumeDb` (null: as set in OBS), `duckInputs` (OBS input names), `duckVmixInputs` (vMix input keys), `duckTo` (`"mute"` or dB, −20), `duckRampMs` (300); status `round`, `ranked` (with `note`, `excluded`, `pinned`), `vmix`, `twin`, `roundSec`, `running`, `held`, `position`, `audio`, `test`), `POST /api/v1/replays/auto/skip`, `POST /api/v1/replays/auto/stop`, `POST /api/v1/replays/auto/hold` (`{"held":true|false}`, toggles without), `PUT /api/v1/replays/auto/clips/:id` (`{"excluded":…, "pinned":…}`), `POST /api/v1/replays/auto/test` (409 with why it can't play now), `GET /api/v1/replays/audio-inputs`, the device actions `replay_skip`, `replay_hold`, `replay_stop`, `replay_exclude`, `replay_pin` and `replay` in `GET /api/v1/devices/tally`, `GET`/`PUT /api/v1/obs/auto` (`replayIn`, `replayOut` (null: as `replayIn`), `otherScenes`, `highlightsIn`, `highlightsOut` (null: as Replay in, Replay out); "" is OBS's current transition; it took `replayTransition` before 0.10.5, kept as `replayIn`), the device actions `highlights_play`, `highlights_stop`, `highlights_halftime` and `highlights` in the tally (Highlights on air: [replay-graphics-and-highlights.md](replay-graphics-and-highlights.md#highlights-on-air)), `POST /api/v1/replays/vmix/test`, `POST /api/v1/replays/obs-setup` (with `twin`), `GET`/`PUT /api/v1/replays/feed`, `POST /api/v1/replays/feed/sources`, `POST /api/v1/replays/feed/ffmpeg`, `GET /api/v1/network`.
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
- **Ranking and the break** (`replay-rank.test.ts`, `replay-break.e2e.test.ts`, `domain.test.ts`, stand-in OBS and vMix):
  - the score and its reasons; the best clip that fits, its lead-up shortened; a break's clips chosen to fit together (one cut, a switch between two), then in round order or best first;
  - **best first:** six clips of a round, three played best first, a duplicate not played, the rest left;
  - **round order:** three clips ranked the other way round played in the order of their kills as the main PC saw them;
  - each break with one cut to the replay scene and one back to live (OBS's scene changes and the program's transitions counted);
  - a clip OBS can't play skipped, the next one played; the round going live in the middle stopping them and cutting to live; the operator taking the program left alone;
  - the break's replays waiting for the replay PC's last kills;
  - two clips through a stand-in vMix: AddInput, SetPosition, Play and Fade to the first, the second added while it plays, CutDirect to it, Fade back, both inputs removed.
- **The break against a real OBS** (OBS 30.0.2 on Linux under Xvfb, recorded and read frame by frame): three clips, one cut in and one out; the first clip opens on its part; one black frame and about 0.1 s of the next clip's first frame between two clips; the same with a media source that restarts when shown. The real-OBS integration tests above pass too.
- **The break's end, a clip's round, fading and transitions (0.10.5):**
  - **The end** (`replay-rank.test.ts`): by 1:50 from the round over, freeze time, a timeout and the live clock, without a clock, the bomb, a defuse, the round over; another time; the round time learned; the old setting; four 6 s clips planned by 1:50 where three fitted before.
  - **The break** (`replay-break.e2e.test.ts`): playing on into the next round and cut back 1.2 s after its clock read 1:51.2; a new round's clip not joining; the bomb or the round over stopping it; the old setting; an earlier round's clip, a clip with no round, one from before a restart and a late one never played, with notes; a kill after the round was won and a bookmark under the round that ended; vMix fading 0.5 s before the end, cutting back with Replay out, and cutting between.
  - **The twin and the transitions** (`replay-fade.e2e.test.ts` with a stand-in OBS at the obs-websocket level, `obs-auto.test.ts`, `domain.test.ts`, `program-follows-obs.test.ts`): the twin built, kept the same (moved, added, hidden items, a filter) and untouched when nothing changed; a break alternating between the two scenes, each fade 0.4 s before the end with the next clip at its part; a Stinger in, OBS's own out; cuts; the operator's scene left alone; the break and studio scenes with Other scenes, by the automation and the buttons; Replay out after a clip played by hand; OBS's own transition put back after each change (not over one chosen in OBS meanwhile); Studio Mode; no twin.
  - **Against a real OBS 30.0.2** (recordings read frame by frame): see Measured above and under Studio Mode; also 1080p60 clips with 2 s keyframes and a filter on the media source (each clip from the keyframe before its part, as before), and Duplicate Sources on.
- **Every kill** (`replay-pc-timing.e2e.test.ts`): a kill the main camera showed is filmed from behind and sent as `shown`, with its lead-up; PC 1 knows the round is pending until it arrives.
- **The replay feed** (`replay-feed.test.ts`, `replay-pc-timing.e2e.test.ts`, a stand-in NDI source with real ffmpeg): recording in one-second segments stamped with real time; a cut a few seconds back starts and ends on the picture of those moments (to 0.2 s, read from the picture's brightness, which tells the time); a cut whose end is still being written waits for it; two programs, the replay PC without OBS, its missed kill marked and cut on PC 1.
- **The controls, the sound and Test replays** (`replay-controls.e2e.test.ts`, the stand-in OBS at the obs-websocket level and a stand-in vMix; `replay-feed.test.ts` with real ffmpeg; `AutoReplays.test.tsx`; `replay-hotkeys.test.ts`):
  - **Skip:** the fade to the next starts within 0.5 s of the press, the next at its part; skipping the last goes back to live with Replay out.
  - **Stop and go live:** back to live with Replay out at once; the rest stay *prepared*.
  - **Hold:** the clip paused (its cursor still) for longer than it had left, nothing playing on; Resume plays it on to its fade; held again, the next round's clock at 1:51.2 still cuts back to live in under 1.5 s.
  - **Exclude and Pin** before the break (the excluded never plays, the pinned first) and during it (the clip waiting in the twin replaced, a clip left out joining next).
  - **The control-surface actions** with a replay token (by rank, next), 403 for a viewer, 409 with nothing on air, and the tally.
  - **The live audio:** turned down 20 dB in at least 4 steps starting within 0.25 s of the transition in, back to exactly 0.8 (OBS's multiplier) and unmuted after the last clip, Skip, Stop, the round clock, a clip OBS can't play and the operator taking the program; muted and back; a fader moved by hand left as it was; never the caster's mic; after the engine lost OBS mid-break and was started again on the same data, back as OBS connected. With vMix: `SetVolumeFade` 80 → 44.99 → 80, the mic never.
  - **Replay volume** on both replay sources (−6 and +6 dB; left alone when not set); vMix 84.14 for −6 dB.
  - **Test replays:** refused while a round is live and while the program isn't live; Replay in (a Stinger), the fade to the twin, Replay out, every step *OK*; the clip on air found by its id with its play, and gone afterwards (not listed, ranked or in a playlist); a sample clip OBS can't play reported with its fix; through vMix too.
  - **The feed's sound** (real ffmpeg, a stand-in NDI source with a tone on and off every 0.5 s by wall time): the cut clip has an AAC 48 kHz stereo track at the source's level, in time with the source to within 30 ms; a source without sound recorded with silence as long as the picture; the clock's handling of jitter, a busy moment, a real gap and a drifting sender.
  - **Real NDI** (the NDI 6.3 runtime that comes with the binding, a local NDI sender on this computer, real ffmpeg): the cut clip's tone at the sender's level, in time to within 20 ms.
- **Switching scenes yourself** (`obs-own-scenes.e2e.test.ts`, the stand-in OBS): an analysis scene put on in OBS between rounds followed as yours, no replays cut in, no break scene for a timeout, Test replays waiting, back to live and the break's replay played; back on the live scene before a break's replays started: they play; the casters put on during the replays: they stop, the live audio back up, the rest played on coming back in time; staying on it: no cut back at 1:50, Stop and Test replays refused; the mapped break scene put on by hand not taken back, Matchframe's own taken back; Studio Mode's preview and Transition; found on your scene when OBS connects.
- **Not checked yet:**
  - the real NDI binding receiving a real NDI source (the Windows release build only checks that it loads), and vMix Desktop Capture;
  - the replay feed on Windows (ffmpeg's hardware encoders);
  - a real vMix;
  - two real CS2 clients on two computers over a real network;
  - a real second CSTV;
  - `demo_gototick` sent by Matchframe to a real CS2 on CSTV (the owner uses `-448 relative` and `448 relative` by hand);
  - Windows OBS;
  - a real CS2's round clock at the start of a live round (the round time is learned from it) and the break's end against it;
  - fades on a busy computer: here (software rendering) the blend moved every frame with 720p30 clips, every fourth frame with two 1080p60 clips.
  - the replay feed's sound from vMix Desktop Capture, OBS's NDI output or NDI Screen Capture on another computer, and ffmpeg's second pipe on Windows (if it can't be read, the feed records without sound and says why);
  - the controls from a real Stream Deck or Companion; the global hotkeys on Windows (registered, and a key another program holds);
  - a real vMix's `SetVolumeFade`, `AudioOff`/`AudioOn`, `Pause` and its fader scale (vMix's knowledge base gives amplitude = (fader / 100)⁴).
