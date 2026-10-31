# Matches, thumbnails and stingers

## Create a match

**Matches → Create match** (top right; the form is already open when there are no matches yet).

- **Team A / Team B:** pick a team, or **New team…** to make one here: its name and short name (the short name is shown on the HUD; left empty, it is made from the name, e.g. *Northern Lights* → *NL*). The team is made with the match. Add its logo and colours later in **Teams**.
- Event, title (e.g. *Grand final*), time, format, round rules and map pool as before. **Create match** needs both teams and at least as many maps as the best-of.

## What is made for every match

As soon as a match is created, the program makes these, in **Matches → (the match) → Thumbnails & stingers**:

| File | Size | Use |
|---|---|---|
| Highlights thumbnail | 1280×720 PNG | YouTube thumbnail for the highlights video (*MATCH HIGHLIGHTS*) |
| Full replay thumbnail | 1280×720 PNG | Thumbnail for the full match VOD (*FULL REPLAY*) |
| Live thumbnail | 1280×720 PNG | Stream thumbnail (*LIVE NOW*) |
| Up next screen | 1920×1080 PNG | Full-screen card for OBS before the match: both teams, event, title, best-of, time |
| Stinger | 1920×1080 QuickTime (.mov) with transparency, 1.6 s, about 15 MB | OBS Stinger transition for scene changes |
| Replay stinger | 1920×1080 QuickTime (.mov) with transparency, 1.6 s, about 15 MB | OBS Stinger transition for replays (with a REPLAY band) |

- **The look:** both teams' colours (from **Teams**; a blue and a red when a team has none), each team's logo on a slanted card with its name, *VS* between them, and a bold two-tone headline. The event name and match title go under the headline. An event's brand colour (from **Tournaments**) replaces the yellow of the headline when it is set.
- **No logo:** a team without a logo gets a **?** badge. Add the logo in **Teams** and press **Make again**.
- **A logo in its team's own colour** (a red logo on a red card) gets a soft plate behind it so it stays visible.
- **Background picture** (optional): thumbnails and the Up next screen are drawn on the teams' colours, or on a picture under **Background picture**: upload one, or **Use what OBS shows now** (a frame of OBS's program, e.g. CS2 in-game). Then **Make again**.
- **Download** under each one saves it. All six are also kept in the folder shown under them (`<data folder>\graphics\<match id>\`).
- **Make again** makes all six again (after changing logos, colours, the title or the background). A match made another way (an import, the API) gets them the first time its tab is opened.
- They are made by the program on this computer, in a few seconds (the tab shows the progress). The stinger previews show the frame at the cut.

## Stingers in OBS

OBS can't create transitions for another program, so make two Stinger transitions once:

1. In OBS: **Scene Transitions → + → Stinger**, name it `Matchframe Stinger`, pick any video file, OK.
2. Again: **+ → Stinger**, named `Matchframe Replay Stinger`.
3. In Matchframe (OBS connected under **Settings → Devices**): **Thumbnails & stingers → Put the stingers in OBS**.

Matchframe then:

- sets both transitions' video to this match's stingers, and the cut (*transition point*) to 900 ms, checked by reading them back from OBS;
- makes the replay stinger **Replay in**, and **Replay out** (Replays & Production → OBS scenes → Transitions), where OBS's current transition is chosen there (Replay out "the same as Replay in" follows Replay in);
- with **Use the stinger for every scene change** (on by default), makes `Matchframe Stinger` OBS's current transition.

When you **activate** a match, Matchframe puts that match's stingers in the two transitions by itself (without changing OBS's current transition).

The stinger covers the screen from 0.4 s to 1.0 s, with the cut at 0.9 s. OBS starts the video a little after the transition starts (more on a busy computer) but cuts at a fixed time, so the cut is placed late in the covered part, and the animation is over by 1.3 s.

OBS must be on the same computer as the Matchframe program that made the stingers: the transitions point at files in its data folder. With OBS on another computer, download the two stingers there and pick them in the transitions by hand (transition point 900 ms).

## API

- `GET /api/v1/matches/:id/art`: the files made, their URLs and sizes, the folder, the background setting, and the OBS transition names.
- `POST /api/v1/matches/:id/art/:kind` (`thumb-highlights`, `thumb-replay`, `thumb-live`, `up-next`, `stinger`, `stinger-replay`): stores one file (PNG, or for the stingers a QuickTime file of PNG frames with transparency); the program uses it after drawing.
- `PUT /api/v1/matches/:id/art/settings` (`backgroundAssetId`), `POST /api/v1/matches/:id/art/background-from-obs`.
- `POST /api/v1/matches/:id/art/obs` (`useStinger`): the stingers into OBS's two transitions.
- `GET /api/v1/match-art/:id/<file>`: the files themselves, without a token (like team logos under `/assets/`); `stinger.mov.png` and `stinger-replay.mov.png` are the stingers' frames at the cut (the previews).

## Checked

- **In Chromium:** the program's own window made all six for a new match. FFmpeg (which OBS uses to play stingers) decodes the stingers with their transparency: see-through at the start and end, fully covered around the cut.
- **In the Matchframe program** (Electron, the desktop smoke test, with no graphics card): all six made for a new match in 7.5 s. Also in the smoke test of the installed program on the Windows runner.
- **In a real OBS 30** (Linux, Xvfb), with the .mov stingers: both transitions set and confirmed; recordings of a cut from a red scene to a green scene show the red scene through the stinger's transparent parts at the start, the green one at the end, and never both at once (the cut is always hidden).
- **Engine and screen tests:** storing and serving the files, the file type checks, the OBS setup with a stand-in OBS, creating a match from no teams.
- **Not checked yet:** OBS on Windows.
