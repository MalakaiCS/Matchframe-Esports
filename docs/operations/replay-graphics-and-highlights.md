# Replay graphic, highlight reels and highlights on air

Three things for replays on the main PC (design: ADR-061, ADR-063):

- **Replay graphic:** while a replay is on air, a "REPLAY" tag and a lower third with the play: who made it (with the team's logo), the weapon, a headshot, who died, 2K/3K/4K/ACE or a 1vN clutch, and the round.
- **Highlight reel:** one button turns a map's best clips into one MP4 for social media.
- **Highlights on air:** **Play** puts a map's best clips on the program, back to back, then goes back to the scene you came from (your analysis scene, say).

All three are under **Replays & Production**.

## Replay graphic

### What it looks like

Each Matchframe HUD draws it in its own style:

| HUD | Tag | Lower third |
|---|---|---|
| Vector | Top left, the team colour behind the rewind mark | Bottom left: team-colour block with the logo, the player on a dark body, a team-colour badge for 2K–ACE or a clutch |
| Lineup | Top centre, where the score bar is, with the round on a white tab | Bottom centre: the player on a near-black bar with the team's edge, a white badge, the play on a team-colour strip |
| Pro CS2 | Top centre, where the match bar is | Bottom centre, where the observed player is: dark panels, the side colour, a stats row (weapon, headshot, killed, round) |
| Broadcast (built in) | Top left | Bottom left, in the preset's style (Classic, Minimal, Arena) |

LHM-format HUDs (kaiHUD and others) have no replay graphic of their own. With one of them on air, the built-in Broadcast HUD's replay graphic is used.

**Timing:**

- The tag comes in about 0.35 s after a clip goes on air, and the lower third about 0.75 s after.
- In a break's replays (clips back to back), the lower third goes out and comes back with each clip. The tag stays.
- When the replays end, both go out.

**The colour of the play** is the team's own colour when it has one. Otherwise it is the colour of the side the player was on **in that round**, not the side now: a first-half play shown after half time keeps its first-half colour.

### Where it goes in OBS

The HUD's browser source is normally only in the live scene, and the replay plays on the replay scene. So the replay graphic is its own page. The page is the HUD's **replay** address, which is transparent except for the graphic. The live HUD never shows it.

1. Set up the replay scene first: **Automatic replays → Set up OBS replay scene**, or pick it under **OBS scenes → Replay scene**.
2. In **Replay graphic**, choose the **HUD**:
   - **Automatic:** the HUD in OBS. This is the HUD with an OBS browser source that was started last, else the HUD started last, else the built-in one.
   - **A HUD by name.**

   The panel shows which page that gives, and its address.
3. Press **Add replay graphic to the OBS replay scene**. This puts a 1920×1080 browser source named *Matchframe Replay Graphic* on top of the replay scene, pointing at that page.
4. Press it again after another HUD goes on air in OBS. Choosing another HUD in the panel re-points the source by itself.

Checks the button makes:

- If OBS already has that source in another scene (the highlights scene), it is added to the replay scene as the same source (as OBS's Add → Existing). If OBS doesn't take it there, the button says so: add it in OBS, or remove it and press again.
- If something was put above it, the message says to move it to the top.

**vMix:** add the address shown in the panel as a Web Browser input over the replay inputs.

Every HUD with a replay graphic also lists the address in the HUD Library (its **replay** URL). It is the HUD's library address with `/replay` as the variant: `http://127.0.0.1:37212/hud/<id>/replay?t=…`.

### Which clip, and what it says

- **Which clip is on air:**
  - The program's replay: a clip played by hand, or automatic replays in OBS. It counts once the program is on the replay scene, not while a clip is being loaded.
  - Automatic replays in vMix: the clip they are playing.
  - Highlights on air (OBS or vMix): the highlight on air. It is a clip kept for reels, found there when the replay list has dropped it.
- **What the lower third says:**
  - **Player:** the killer of the clip's play. A clip bookmarked by hand has none, so only the tag shows.
  - **Team:** the player's team as the HUD shows it (left or right), with its name, logo and colour. Without teams set up in Matchframe, it is the in-game team name.
  - **Side:** the side the player had in the clip's round. It is taken from the kills this computer saw in that round. When none was seen, the player's side now is moved to that round by halves of regulation (the same half: the same side; the other half: the other side), and by halves of three rounds in overtime. Across regulation and overtime the side isn't known, and the team colour is used. For a clip of the previous map, only what was kept with it counts (the sides now are another map's).
  - **Weapon, headshot, victims, kills:** from the clip's play.
  - **2K–ACE:** for two kills or more.
  - **1vN clutch:** for a won clutch. Its opponents are counted, not its kills.
- **Round:** the clip's round.

**Turn it off:** untick **Show the replay graphic**. The replay pages then stay empty.

## Highlight reel

**Replays & Production → Highlight reel:**

1. **Map:** this map or the previous one.
2. **Clips:**
   - **All played clips**, or
   - **The best N** by the same score as automatic replays. With **Also clips that weren't played**, the map's other clips can be among them too. The replay PC films more kills than a break has time for.
3. **Crossfade:** 0.5 s by default.
4. **Burn in the replay graphic:** each clip gets its lower third (player, weapon, victims, 2K–ACE or clutch, round). It fades in after the crossfade and out before the next one.
5. **Export highlight reel.**

The panel lists the clips in order, with the reel's length:

- Rounds in order.
- In a round, plays in the order they happened (by the first kill as this computer saw it).
- The same kills only once (the better clip).

**What ffmpeg makes:**

- **Size:** 1920×1080, or the largest clip's size when one is larger. Clips of another shape are letterboxed.
- **Frame rate:** one for the whole reel, the highest of the clips (at most 60).
- **Video:** H.264 yuv420p (CRF 18).
- **Sound:** AAC 48 kHz stereo, with silence where a clip has no sound.
- **Joins:** crossfades (xfade, acrossfade).
- **Each clip's part:** its trim, else the part the replay showed (the end of the clip), else all of it.

It runs in the background, with progress and **Cancel**. One reel is made at a time. ffmpeg is the program's own (download it in the panel on Windows, about 90 MB), or the one on the system.

**Where it goes:**

- With the Matchframe program: your **Videos** folder, in *Matchframe Highlights*.
- Otherwise: the data folder's `exports/highlights`.

The panel shows the path. **Open folder** opens it in the program on this computer.

### Clips kept for reels

The replay queue deletes clips to save space:

- It keeps 200 items in memory.
- The replay PC's files are deleted when their item drops off the queue, or when more than 120 newer ones came in.
- Feed clips are pruned the same way.

So every clip that comes into the queue is also kept in the data folder's `highlights/clips`:

- **How:** a hard link to the same file. It takes no extra space and stays when the queue deletes the original. A clip on another drive is copied.
- **Which:** the current and the previous map.
- **How much:** up to **3 GB** together (set it under **Where reels go, and the clips kept**). Over that, clips that weren't played go first, then the oldest played ones.
- **With them:** the kills of each map and its round winners, for the score, the order and the sides.

The list is in `highlights/index.json`, so reels can be made after a restart.

A new map starts when the map changes, or when the active match changes.

## Highlights on air

**Replays & Production → Highlights on air.** Press **Play highlights**: the map's best clips play on the program, one after another, fading from one to the next, with the replay graphic on each. Then the program goes back to the scene it came from.

### The highlights scene

- **Set up OBS highlights scene** (one click) makes:
  - the scene **Matchframe Highlights**, with a Media Source **Matchframe Highlights Clip**, set like the replay scene's (it plays while hidden, keeps its place when shown, and holds its last frame);
  - the replay graphic's browser source on top: the same *Matchframe Replay Graphic* source as in the replay scene (OBS shares it, as with *Add Existing*), so choosing another HUD under **Replay graphic** changes both;
  - **Matchframe Highlights B**, its twin for the fades. Leave it to Matchframe, as the replay scene's twin.

  It is saved with the program's other scenes (the highlights scene of **OBS scenes**).
- **Or use your own scene:** **Or use your own scene** → pick the scene and its Media Source (directly in the scene, not in a group), then **Use this scene**. **Add the replay graphic** puts the graphic on top of it. Matchframe turns off the same three settings of its Media Source as for the replay scene. Your replay scene works too: its twin then serves both.
- The panel shows what is ready: **Scene ready**, **Twin ready**, **Graphic on top**.
- **vMix** (Automatic replays → Play replays in → vMix): no scene needed. Each clip is added as an input, as for replays, and vMix goes back to the input that was on air before.

### What plays

| Setting | Choices | Default |
|---|---|---|
| What | This map; the last half of this map; the previous map | This map |
| How many | The best 5, 8, 10 or 15 (by the same score as automatic replays); all played clips | The best 5 |
| Also clips that weren't played | With the best N: the map's other clips can be among them | Off |

- **The clips** are the ones kept for highlight reels (see *Clips kept for reels* above), not the replay list, which drops clips.
- **The last half:** the half of the last round the map has. Halves are MR12's (rounds 1–12, 13–24), then overtime halves of three rounds (25–27, 28–30, …). At halftime that is the first half; after round 17, the second half so far.
- **Order:** rounds in order; in a round, by when the play happened. The same kills only once.
- **Each clip:** the part a replay shows (the play and its lead-up, the end of the clip).
- The panel lists them (round, label, length) with the running time: the clips at the replays' speed, less the fades between them.

### How they play

As a break's replays (Automatic replays' settings):

- **Highlights in** to the first clip; **Between replays** (a fade of 0.5 s by default, or a cut) from one to the next, through the highlights scene and its twin; **Highlights out** after the last.
- The replay graphic on each clip: the tag and the lower third with the play. A clip of the previous map shows its own play and round.
- The live game audio picked under **Automatic replays → Sound** is turned down as the first clip comes in, and put back exactly afterwards, however they end.
- The status reads *Highlight 3 of 8: …*.
- **Skip**, **Hold / Resume** and **Stop**: the buttons in the panel (and in Automatic replays), the keys and the Stream Deck. Skip and Hold are the replays' own.

### Where the program goes back to

- **To the scene it came from:**
  - your own scene (a multiview's analysis scene): back on it, still yours, so automatic replays keep waiting for you;
  - the live scene;
  - the studio or break scene, still chosen by whoever chose it: the OBS automation's studio scene still goes back to live at the next map.
- **To the live scene** when a round is live, or when the scene it came from no longer exists in OBS.
- **You take the program** meanwhile (another scene in OBS, the Transition button in Studio Mode, **Return live**): they stop, and nothing more changes.

### Rounds and replays

- **Not while a round is live:** Play is refused, with why.
- **A round goes live while they play** (halftime over): they play on until the replays' **Back to live** time on its clock (1:50 by default), then the live scene, not the scene they came from. A clip that wouldn't end by then isn't started. With **Before the round starts**, they stop as the round goes live.
- **No automatic replays while they play.** Pressed in a break before its replays start, the break has none.
- **Not over a replay:** Play waits until the break's replays are over (or Stop).

### Halftime

**Don't show highlights at halftime** is on by default:

- **On:** no highlights start at halftime, by **Play**, a hotkey, the Stream Deck or by themselves. Play is greyed out with *Highlights at halftime are off*, and a hotkey or the Stream Deck gets that answer.
  - **Halftime** is the game's halftime phase, and the time around the first round of a half other than the map's first (the second half, an overtime half): from the end of the half's last round to the end of the next one's freeze time.
  - Highlights already playing when halftime starts play on, by the usual rules.
- **Off:** Play works at halftime, and **Start by themselves at halftime** appears under it (off by default).

### By themselves

- **Start by themselves when a map ends** (off by default), and **at halftime** (when halftime highlights are allowed).
- Only when the program is on the live scene: never over your own scene, the studio or break scene. The panel says when one didn't start, and why.
- After the round's replays.
- With **Map end → studio scene** (OBS scenes) on, the highlights come first, then the studio scene.
- Once per halftime and per map end.

### Transitions

- **OBS:** **OBS scenes → Transitions → Highlights in** and **Highlights out** (also in the panel). They are the same as **Replay in** and **Replay out** until chosen. Any of OBS's transitions, a Stinger too. OBS's own transition is put back afterwards, as for replays.
- **vMix:** **Highlights in** and **Highlights out** in the panel: Cut, Fade, Stinger 1 or Stinger 2. They are the same as the replays' until chosen.

### Keys and the Stream Deck

| | Console | Global hotkey (the program; off until set) | Stream Deck action |
|---|---|---|---|
| Play highlights | Ctrl+Shift+F9 | suggested Ctrl+Shift+F9 | `highlights_play` |
| Stop highlights | Ctrl+Shift+F10 | suggested Ctrl+Shift+F10 | `highlights_stop` |
| Skip | Ctrl+Shift+F5 | the replays' Skip | `replay_skip` |
| Hold / Resume | Ctrl+Shift+F6 | the replays' Hold | `replay_hold` |
| Don't show highlights at halftime | | | `highlights_halftime`: `{"on":true}`, `{"on":false}`, `{}` toggles |

Not F8: the console's F8 is **Stop automation**. The tally (`GET /api/v1/devices/tally`) has `highlights`: `running`, `held`, `onAir`, `position`, `ready`, `halftime` (it is halftime now) and `noHalftime` (the setting), for a button's light.

**API:** `GET`/`PUT /api/v1/highlights/air` (`what` (`map`, `half`, `previous`), `count` (a number or `"all"`), `unplayed`, `noHalftime`, `autoHalftime`, `autoMapEnd`, `vmixIn`, `vmixOut` (null: as the replays'); with `status` (`plan`, `blocked`, `halftime`, `last`, `auto`) and `setup`), `POST /api/v1/highlights/air/play` (409 with why), `POST /api/v1/highlights/air/stop`, `POST /api/v1/highlights/air/obs-setup`, `PUT /api/v1/highlights/air/scene` (`{"scene":…,"input":…}`), `POST /api/v1/highlights/air/graphic`; `highlightsIn`, `highlightsOut` (null: as Replay in, Replay out) in `GET`/`PUT /api/v1/obs/auto`; the program's `HIGHLIGHTS` scene and mode.

## Storage: another drive (0.10.6)

**Replays → Storage** chooses where replays and highlights are written on the production computer. **Choose folder…** opens a folder picker in the program; a full path can also be typed. Matchframe checks it can write there, and shows the free space on that drive.

| Setting | What goes there | Default |
|---|---|---|
| Replay clips and recording | the replay PC's clips (`replays`) and the replay feed's recording of its picture (`replay-feed`) | Matchframe's data folder |
| Highlights | the clips kept for reels (`Kept clips`) and the reels | the Videos folder's `Matchframe Highlights` |

- **From then on:** new files go to the new folder. Clips already saved stay where they are, and still play and go into reels.
- **Recording:** the replay feed's recording restarts in the new folder.
- **Old folder:** clips of the old replay folder are still deleted when they drop off the replay list.
- **Reels:** a reel is made in a work folder beside it (`.matchframe-reel-…`, removed afterwards). So nothing large is written to the data folder's drive, and the finished file is moved, not copied.
- **Different drives:** when the replay folder and the highlights folder are on different drives, kept clips are copied in the background instead of hard-linked.
- **Use default** goes back to the default folders.
- **API:** `GET`/`PUT /api/v1/storage` (`replays`, `highlights`: a full folder path, or null for the default).
