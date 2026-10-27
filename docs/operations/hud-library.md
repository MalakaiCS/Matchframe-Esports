# HUD Library: setup and use

Matchframe opens into the **HUD Library**: the HUDs installed on this computer, with controls to run each one as a transparent window over the game, as a preview, or as an OBS browser source. The library, the HUD server and test data work offline and without an account. An account is needed only for the Auto Director (the Observer's automatic camera work) and its hours.

## Install

1. Run `MatchframeEsports-Setup-<version>.exe` (per-user install, no administrator rights; unsigned development builds show a SmartScreen prompt: More info → Run anyway). Nothing else is needed: no Node.js, npm or development server.
2. Start **Matchframe Esports**. The program starts its local HUD server automatically (`127.0.0.1`, ports 37210 for game data, 37211 for the program, 37212 for HUD outputs) and opens the HUD Library. The bottom status bar shows the server, active HUD outputs and the last game-data update.
3. The library already contains the **Matchframe Broadcast HUD** (built in), the **Matchframe Sample CS2 HUD** (a small package to copy and learn from) and the **Pro CS2 HUD** (a full broadcast HUD adapted from Lexogrine's open-source CS2 React HUD; its source in `apps/hud-template` is a starter kit for your own).

Installed HUDs and their settings are kept in `%APPDATA%\Matchframe Esports\huds\<hud-id>\` and the program database; they survive restarts and updates. **Open HUDs Folder** shows the folder.

## Add a HUD

- **Import HUD ZIP** or **Import HUD Folder** in the library toolbar. The package is checked first (manifest, entry files, allowed file types, sizes, paths). An invalid package is refused with the reason and nothing installed changes.
- The files are copied into the library: you can move or delete the original ZIP or folder afterwards.
- Importing a HUD whose id is already installed shows both versions and asks what to do: **Update to <version>** (keeps its settings and reloads its outputs; the old version stays available as **Roll back** in the details panel), **Import as a copy** (a new id), or **Cancel**.
- Package format and manifest: `docs/extensions.md` and `assets/hud-packages/matchframe-sample-cs2/README.md`.

Other card actions, under **More**: **Duplicate** (a copy you can change), **Export ZIP**, **Open Folder**, **Remove…**. The built-in HUD can't be removed, exported or duplicated.

## Test data

**Run Test Data** starts the labelled simulation: a synthetic 5v5 on a synthetic map, offline. The toolbar shows **Test data** while it runs, and HUDs show a test-data label. Stop it before a real match; real game data is ignored while it runs.

## Three ways to show a HUD

| Mode | How | Notes |
|---|---|---|
| **Transparent desktop HUD** | **Launch Transparent HUD** on the card | A separate window with only the HUD graphics, always on top, click-through, never takes keyboard focus. Keeps updating when the manager is minimised. |
| **Preview** | **Preview** on the card, or the preview in the HUD's details panel | A normal window; tick *Checkerboard* to inspect transparency. Closing it affects nothing else. |
| **OBS browser source** | **Copy OBS Browser URL** | A local URL with only the HUD on a transparent background. Use the size shown next to the button (normally 1920×1080). |

All three show the same match information and the same settings, and run independently: hiding or closing the desktop HUD doesn't touch OBS, and stopping one HUD doesn't stop another.

### Transparent HUD over CS2

1. In CS2 set **Display Mode: Fullscreen Windowed** (borderless). **Exclusive fullscreen is not supported**: no normal desktop window can draw over it.
2. **Launch Transparent HUD** on the card. Mouse clicks and keys go to the game; the HUD never takes focus.
3. Select the card → details panel → **Outputs** → **Desktop HUD**: choose the **monitor** CS2 runs on. **Fit to monitor** sizes the HUD to the monitor without stretching (16:9 HUDs are letterboxed on 16:10 or ultrawide monitors); **100 %** uses the HUD's design size; **Scale (%)**, **X** and **Y** set it exactly.
4. To move it by hand: **Edit position**. The window shows an outline and can be dragged. Click **Done editing** (or tick **Lock position and size**) when done. Position and scale are remembered per HUD.
5. Windows display scaling and monitors of different resolutions are handled; monitors to the left of or above the main one work too. If a monitor is disconnected the HUD moves to the main monitor.

### OBS

1. Add a **Game Capture** source for CS2.
2. Add a **Browser Source** above it: URL from **Copy OBS Browser URL**, width and height as shown (1920×1080 for the included HUDs), *Shutdown source when not visible* off, *Refresh browser when scene becomes active* off. No custom CSS is needed; the background is transparent.
3. The desktop HUD window is a separate window and is **not** included in Game Capture. Use the browser source for the stream; use the desktop HUD to see the graphics while you play or observe.
4. The URL contains a key for that HUD. **New access key** (details panel → Outputs) makes old URLs stop working.

## Settings

Select a card (or **Settings** on it) to open its details panel. **Appearance** holds the HUD's settings form (from its manifest) and preset; **Save settings** applies them immediately to the desktop HUD, previews and OBS sources, without a reload. Settings are saved per HUD on this computer.

## Hotkeys and tray

- **Toggle desktop HUD** (default `Ctrl+Shift+H`) shows or hides the desktop HUD windows. OBS sources are unaffected.
- **Emergency hide** (default `Ctrl+Shift+F9`) hides **all** HUD graphics, desktop and OBS, until pressed again. The status bar shows when graphics are hidden.
- Change them in the details panel → **Outputs** → **Hotkeys**. A hotkey another program already uses is reported as not registered.
- **Stop automation** (`Ctrl+Shift+F12`, or F8 in the window) stops the Auto Director, as before.
- The **tray icon** has Show Manager, Show/Hide HUD, Stop HUD (closes desktop HUD windows and previews) and Quit.
- Minimising the manager keeps the HUD server and HUD windows running. Closing the manager while a desktop HUD is open keeps the program in the tray. **Quit** (tray or File menu) closes every output and stops the HUD server; no background process is left.

## When game data stops

The toolbar shows the game-data state. If CS2 stops sending data (game closed, map change, network), the status changes to *stale* or *waiting*. HUDs keep the last state and are labelled as paused. When data resumes, everything recovers on its own; there is no need to relaunch HUDs or refresh OBS.

## Troubleshooting

| Symptom | Check |
|---|---|
| Desktop HUD not visible over the game | CS2 in Fullscreen Windowed, the right monitor selected, not hidden (Toggle desktop HUD / emergency hide), HUD not stopped |
| OBS source shows nothing | URL copied from this computer's library, HUD not stopped or hidden, source size as shown, Matchframe running |
| OBS source shows a black background | Custom CSS in the source settings; clear it |
| Card shows Error | The package's files changed on disk or its entry file is missing: re-import it |
| Hotkey not working | Registration failure in the details panel; choose another combination |

## What is verified automatically, and what needs a manual check

Automated (unit, end-to-end and the Windows workflow): package import, validation and conflicts, storage across restarts, per-HUD settings, the HUD server and its outputs, and the library screen. `scripts/overlay-check.cjs` runs against the installed program on a Windows runner: desktop HUD window settings, transparent pixels, edit mode, scale and position, live settings, updates while the manager is minimised, the OBS browser source rendered offscreen and transparent, independent outputs, emergency hide, recovery after an engine restart, Stop, and a clean quit with no process left; and on the real Windows desktop, screen pixels over a stand-in game window, click-through and focus with real mouse input, and the emergency-hide hotkey. The runner has one monitor at 100 % scaling.

**Manual check before a broadcast** (needs real hardware and software):

- [ ] CS2 in Fullscreen Windowed with the desktop HUD on top; the game keeps mouse and keyboard; alt-tab and back keeps the HUD on top.
- [ ] Two or more monitors, including one left of the main monitor and one with different scaling (e.g. 100 % and 150 %): placement, Fit display and remembered position.
- [ ] OBS 30+: Browser Source over Game Capture shows the HUD with a transparent background at the stated size; settings changes appear in OBS.
- [ ] Unplug or close CS2 mid-round: HUD shows paused data; start again: it recovers.
- [ ] Quit from the tray: no `Matchframe Esports` processes remain in Task Manager.
