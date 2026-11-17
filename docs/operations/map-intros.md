# Map intros

One video per map, played on the program by itself at the moment you pick (the map loading, the knife round, the pistol round…), or when you press **Play map intro**. Then the program goes back to the scene it came from. Design: ADR-079.

Everything is under **Replays & Production → Map intros**, and the buttons are in **Live Control**.

## Add the videos

The panel has one row per map: Ancient, Anubis, Dust II, Inferno, Mirage, Nuke, Overpass, Train, Vertigo and Cache, and **Default** for maps without their own (another map, a workshop map, a map you have no intro for yet).

- **Add** (or **Replace**) and pick the file. MatchFrame checks it before keeping it:
  - an **MP4 or MOV** file;
  - a video codec OBS and vMix play: H.264, H.265 (HEVC), ProRes, DNxHD/DNxHR, QuickTime Animation, PNG, VP9, AV1 or MPEG-4;
  - between **0.5 s and 2 minutes** long;
  - its start and its end decode (a file cut off by a download, or damaged, is refused);
  - a picture can be taken from its middle (the preview).
- A file that fails is refused, with why: *It is only 0.3 s long: an intro must be at least 0.5 s.*, *It isn't an MP4 or MOV file (it reads as matroska,webm)…*, *ffmpeg can't play it through…*. Nothing of it is kept.
- Each row then shows the video's frame, its length, codec, size, frame rate and file size, the file's name, and notes that don't stop it playing:
  - *No sound.*
  - *See-through (it has an alpha channel): what is under it in the map intro scene shows through.*
  - *vMix may not play VP9: H.264 is the safest.*
  - a size under 1280×720.
- **Remove** empties the row; the default intro plays for that map then (if there is one).
- An intro can't be replaced or removed while it is on air.
- Up to 1 GB per file. Large files are written straight to disk as they arrive.

**Where they go:** the data folder's `map-intros` folder (`%APPDATA%\MatchFrame Esports\map-intros` with the program). Each upload gets a new name (`de_mirage-<time>.mp4`); the old file is removed, or a little later if OBS still had it open.

**Checking needs ffmpeg:** the program's own (download it under Replay PC → Replay feed (NDI) on Windows) or one installed on the system. MatchFrame reads the file with ffprobe when there is one beside the ffmpeg it uses (the same folder, or both installed on the system), and with ffmpeg itself otherwise; the program's own download has ffmpeg only, and that is enough.

**Not shared by account sync.** Video files are too large to share, so each computer keeps its own intros. Add them on every computer that plays intros (normally only the production computer).

## When it plays

**Start the intro:**

| Choice | When | Notes |
|---|---|---|
| Manual only | Only when you press **Play map intro** (Live Control, the hotkey, the Stream Deck) | |
| When the map loads | In the warmup of a map the game data has just changed to | Also when the observer's CS2 joins the server during the warmup. A server without a warmup: the first round's freeze time. Joining a map after its warmup is no map load. |
| Knife round start | In the freeze time of a knife round | See *Knife rounds* below. A map without a knife round gets no intro by itself: use **When the match goes live** to cover both. |
| Pistol round start (the default) | In the freeze time of the first round that isn't a knife round | After the knife round when there is one; otherwise round 1. |
| Both pistol rounds | Round 1's freeze time, and the second half's first round's | The second half starts at round 13 in MR12 and 16 in MR15: from the active match's format (MR12 without an active match). Not in overtime. |
| When the match goes live | In the freeze time of the first round after the warmup | Knife round or pistol round, whichever comes first. |

**The rules:**

- **Once per map per match.** Each map's intro plays by itself once in a match (Both pistol rounds: once in each half). A technical restart back to round 1 doesn't play it again.
  - **Play map intro** plays it again whenever you want, and counts as its play: pressed in the warmup with *Pistol round start* chosen, it doesn't play again at the pistol round.
  - Without an active match, a map's intro can play again once another map has been played since.
- **Never during a live round.** It plays only in a warmup or a freeze time (or, by Play, after a round). **Play map intro** is refused while a round is live, with why.
- **It plays when its moment is seen, not later.** If something keeps it from starting, it doesn't start once the moment is over:
  - the round's replays, Test replays or highlights on air: it **waits** for them, while the freeze time (or warmup) lasts;
  - OBS showing **your own scene** (one you put on in OBS, a multiview's): it doesn't play over it. The status says *Mirage's intro wasn't played at pistol round start: OBS showed your scene "Casters". Press Play map intro to play it.*;
  - the studio or break scene **you** chose with the program buttons: the same;
  - the studio or break scene the OBS automation chose (*Map end → studio scene*, timeouts): it plays from there;
  - with *Cut back to the game*, less than 3 s of freeze time left: not played (it would be cut at once).
- The panel and Live Control show what happened last: *Mirage's intro played at pistol round start: 10 of 10 players have a gun or grenade.*, or why it didn't.

**If the round goes live during the intro:**

- **Cut back to the game** (the default): back to the live scene as the freeze time ends. The cut back starts a second before the freeze time's end (by the game's countdown), so a stinger has cut to the game as the round goes live; if the countdown isn't in the game data, as soon as the round is live.
- **Finish the intro:** it plays to its end, then the live scene. **Viewers miss the start of the round** meanwhile.
- Either way it goes back to the **live scene** then, not the scene it came from.

## How it plays in OBS

- **The scene:** MatchFrame makes **MatchFrame Map Intro** with one Media Source, **MatchFrame Map Intro Video**, the first time an intro plays (or press **Set up OBS map intro scene**). If you remove the source from the scene, it is put back. The scene is saved with the program's scenes (its MAP_INTRO scene).
  - You can add things to the scene in OBS: a background under a see-through intro, a logo over it. Keep the video source itself.
  - The source plays from the start each time it is shown, plays once, and holds its last frame while the transition back runs.
- **Going on air:** MatchFrame sets the source to the map's intro off air, then puts the scene on program.
- **Transitions** (in the panel, and OBS scenes → Transitions):
  - **Map intro in:** the **MatchFrame Stinger** by default, when OBS has it (Matches → Thumbnails & stingers → Put the stingers in OBS), else OBS's current transition. Or any of OBS's transitions.
  - **Map intro out:** the same as Map intro in unless chosen.
  - OBS's own transition is put back afterwards, as for replays.
- **The end:** OBS says when the video has ended (its media events). If OBS doesn't say so, MatchFrame goes back anyway at the video's length (as checked when it was added) plus 2 s.
- **Where it goes back to:**
  - the scene it came from: the live scene, your own scene (still yours), the studio or break scene (still chosen by whoever chose it);
  - the live scene when a round is live, or the scene it came from no longer exists in OBS;
  - from the OBS automation's **studio scene** as the next map loads (*When the map loads* with *Map end → studio scene* on): straight to the live scene, not to the studio scene first.
- **You take the program** meanwhile (another scene in OBS, the Transition button in Studio Mode, **Return live**): the intro stops, and MatchFrame leaves OBS where you put it.
- **Stop** (Live Control, while one is on air): back to where it came from.
- No sponsor bugs over an intro, as over replays and highlights.
- A few seconds after it ends, the source lets go of the file.

## In vMix

With **Play replays in → vMix** (Automatic replays), the intro plays in vMix through its Web Controller, as replays do:

- the file is added as an input and played;
- **Map intro in** to it: the replays' Replay in unless chosen (Cut, Fade, Stinger 1 or Stinger 2);
- when it ends (or the round goes live, with Cut back to the game), **Map intro out** to the input that was on air before: the replays' Replay out unless chosen;
- the input is removed afterwards.

vMix must be on the same computer (it opens the file from MatchFrame's data folder).

## Sound

The live game audio picked under **Automatic replays → Sound** is turned down as the intro goes on air, and put back exactly afterwards, however it ends (as for replays). The intro's own sound plays at its volume.

## Controls

**Live Control → Map intro:**

- the status line: *Next intro: Mirage, at pistol round start.* (the map in the game data while its intro is still to come, else the active match's next map); *Mirage's intro waits: the round's replays are on air.*; *On air: Mirage's intro.*
- **Play map intro:** the map in the game data's intro (its own, else the default), now.
- **Play next map's intro (Inferno):** the next map in the active match's veto, before the server changes map (in the break between maps, say). That map's intro then doesn't play again by itself when it loads.
- **Stop** while one is on air.
- Greyed out with why when it can't play (a round live, no intro for the map, OBS not connected).

| | Console | Global hotkey (the program; off until set) | Stream Deck action |
|---|---|---|---|
| Play map intro | Ctrl+Shift+F4 | suggested Ctrl+Shift+F4 | `map_intro_play` |
| Play next map's intro | | | `map_intro_next` |
| End it early | | | `return_live` |

Set the global hotkey under **Map intros → Hotkeys and Stream Deck**. The tally (`GET /api/v1/devices/tally`) has `mapIntro`: `running`, `onAir` (the map), `ready`, `readyNext` and `next` (the status line), for a button's light.

## Knife rounds

CS2's game data has no "knife round" flag: to the game it is an ordinary round. How the common setups run one, and what MatchFrame sees:

- **MatchZy, and get5-style plugins:** after the warmup, a knife config (no default pistols, no bomb, no money, free armour) and a restart. The knife round is round 1 at 0–0, past the warmup; everyone has a knife only and $0. The winner picks a side (MatchZy pauses), the game restarts, and the real round 1 (the pistol round) is round 1 at 0–0 again, with pistols and the start money.
- **Plain `mp_` configs** (an admin's knife.cfg, then live.cfg): the same, the knife round being round 1 at 0–0 after the restart.

So MatchFrame calls a round a knife round when it is **round 1 at 0–0, past the warmup, and every player whose weapons the game data lists has knives only** (any knife skin; the bomb is left aside, as a plain config may still hand it out). One gun, grenade or Zeus on anyone and it isn't one. Everyone at $0 is noted, but not required. The loadouts are read once the freeze time is 1.2 s old, as the first update of a round can still carry the weapons of before.

**What it can't tell:**

- **Without the players' weapons in the game data:** the observer's CS2 must be a spectator (or GOTV), which sends every player's weapons. A player's own game data has only theirs: then MatchFrame can't tell a knife round from the pistol round, *Knife round start* never plays, and *Pistol round start* takes the first round 1 it sees (it may be the knife round).
- **A plugin that takes the pistols away only when the round starts** (not as players spawn): the freeze time looks like a pistol round.
- **A knife round anywhere but round 1 at 0–0** (in the warmup, or after rounds were played): not one.
- **A "knife and Zeus" round:** not one.
- **The bomb:** a knife round with the bomb handed out still counts.

## Make an intro video

- **Size and frame rate:** your OBS canvas's (1920×1080), at your stream's frame rate (60 or 50 fps).
- **Format:** MP4 with **H.264** (yuv420p) and AAC sound, 48 kHz stereo. H.264 plays everywhere, decoded by the graphics card.
- **See-through** (an intro over the game, a logo animation): a MOV with **ProRes 4444** or **QuickTime Animation** and its alpha channel. The files are much larger; add what should show through to the map intro scene, under the video.
- **Length:** shorter than the freeze time, so it ends before the round goes live: about 5–12 s (CS2's competitive freeze time is 15–20 s, a knife round's often 10 s).
- **The first second:** the stinger covers the cut into the intro (0.4–1.0 s with MatchFrame's stingers), so start with something that doesn't need to be seen.
- **The end:** the last frame holds while the transition back runs: end on a picture that can stay a moment.
- **Sound:** about as loud as the game sound; the live game audio is turned down meanwhile.
- **Text on it** (the map's name): put it in the video.

From any editor (DaVinci Resolve, Premiere Pro, After Effects), export H.264 MP4 at high quality. To convert a file with ffmpeg:

```
ffmpeg -i intro-master.mov -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 60 -c:a aac -b:a 192k -ar 48000 -movflags +faststart mirage-intro.mp4
```

See-through, ProRes 4444:

```
ffmpeg -i intro-master.mov -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -c:a pcm_s16le mirage-intro.mov
```

## API

- `GET /api/v1/map-intros`: the settings, the status (`next`, `current`, `nextMap`, `blocked`, `blockedNext`, `waiting`, `last`, `auto`), every slot with its intro (`durationMs`, `videoCodec`, `audioCodec`, `width`, `height`, `fps`, `bytes`, `notes`, `previewUrl`), the scene in OBS (`setup`), `ffmpeg`, `maxBytes`, `shared: false`.
- `PUT /api/v1/map-intros/settings`: `trigger` (`manual`, `map_load`, `knife`, `pistol`, `pistols`, `match_live`), `onLive` (`cut`, `finish`), `vmixIn`, `vmixOut` (null: as the replays').
- `POST /api/v1/map-intros/<slot>?name=<file name>` (`de_ancient` … `de_cache`, `default`): the file as the body; 422 with why when it can't be an intro, 409 without ffmpeg. `DELETE /api/v1/map-intros/<slot>`.
- `GET /api/v1/map-intros/<slot>/preview.jpg`: the preview frame (no token needed, like the match graphics).
- `POST /api/v1/map-intros/play` (`{}`: the current map; `{"map":"de_mirage"}`), `POST /api/v1/map-intros/play-next`, `POST /api/v1/map-intros/stop`: 409 with why.
- `POST /api/v1/map-intros/obs-setup`: the scene in OBS now.
- `introIn`, `introOut` (null: the MatchFrame Stinger when OBS has it; as Map intro in) in `GET`/`PUT /api/v1/obs/auto`; the program's `MAP_INTRO` scene and mode; the device actions `map_intro_play`, `map_intro_next` and `mapIntro` in the tally.

## Checked

- **Knife rounds and the triggers** (`map-intro-trigger.test.ts`, game data built as CS2 sends it and read by the engine's own state code): a MatchZy-style map from the warmup through the knife round, the side pick, the restart, the pistol round, halftime and round 13, each trigger at its moment and no other; MR15's second half at round 16; plain configs without a knife round; the first freeze-time update still carrying the warmup's weapons; a player's own game data; a server without a warmup; joining mid-map; two rounds of the built-in simulation. Knife rounds: knives only with and without money, the bomb, dead players; not with a pistol on one player, a Zeus, a grenade, in a later round, once the round is over.
- **Uploads** (`map-intro-store.test.ts`, tiny videos made by ffmpeg): an H.264 MP4 and a see-through QuickTime Animation MOV kept with their facts and frame; refused: too short, Matroska, MPEG-2, not a video, a cut-off file, an empty one, no ffmpeg; ffprobe and ffmpeg reading the same; Replace and Remove; the folder swept.
- **Playing** (`map-intro.e2e.test.ts`, the engine with a stand-in OBS sending OBS 30's media events, and a stand-in vMix): uploads through the route; the scene made, the MatchFrame Stinger in and out (OBS's own without it, the chosen ones), back to the live scene and to your own scene; the live audio down 20 dB and back; by itself at the pistol round (not before the loadouts settle, once per map, not after a restart, again by Play), the knife round, both pistol rounds, the map loading from the studio scene straight to live; cut back and finish as the round goes live; the fallback without media events; you taking the program; Stop; Play next map's intro from the veto; waiting for the replays; never over your own scene; vMix with Stinger 1, back with the replays' Replay out, the input removed, cut back.
- **Console and hotkeys** (`MapIntros.test.tsx`, `replay-hotkeys.test.ts`).
- **Not checked yet:** a real OBS or vMix, and real servers running MatchZy or get5.
