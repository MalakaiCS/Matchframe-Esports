# HUD Library: setup and use

Matchframe opens into the **HUD Library**: the HUDs installed on this computer, with controls to run each one as a transparent window over the game, as a preview, or as an OBS browser source. The library, the HUD server and test data work offline and without an account. An account is needed only for the Auto Director (the Observer's automatic camera work) and its hours.

## Install

1. Run `MatchframeEsports-Setup-<version>.exe` (per-user install, no administrator rights; unsigned development builds show a SmartScreen prompt: More info → Run anyway). Nothing else is needed: no Node.js, npm or development server.
2. Start **Matchframe Esports**. The program starts its local HUD server automatically (`127.0.0.1`, ports 37210 for game data, 37211 for the program, 37212 for HUD outputs) and opens the HUD Library. The bottom status bar shows the server, active HUD outputs and the last game-data update.
3. The library already contains the **Matchframe Broadcast HUD** (built in), the **Matchframe Sample CS2 HUD** (a small package to copy and learn from) and the **Pro CS2 HUD** (a full broadcast HUD adapted from Lexogrine's open-source CS2 React HUD; its source in `apps/hud-template` is a starter kit for your own).

Installed HUDs and their settings are kept in `%APPDATA%\Matchframe Esports\huds\<hud-id>\` and the program database; they survive restarts and updates. **Add HUD → Open HUDs folder** shows the folder.

The window has no Windows title bar: the header with the page title is the title bar. Drag an empty part of it (or the logo) to move the window; minimise, maximise and close are at its right end. Connection settings and the data folder are in **Settings → General → Program**.

## Updates

The program updates itself from the Matchframe Esports releases on GitHub, so you install it only once.

- It checks shortly after it starts and then every few hours. A new version downloads in the background (turn off **Download updates automatically** in **Settings → General → Program** to choose when).
- When the update is ready, the status bar shows **Update <version> ready · Restart now**. Restarting closes the program and every HUD output for a moment, so do it between matches. Otherwise the update installs the next time you quit the program.
- The program never restarts on its own during a broadcast. **Check for updates** and **What's new** are in **Settings → General → Program**.
- Updates keep your HUDs, settings and sign-in. Version 0.2.0 has no updater: install the next version once by hand, and updates are automatic from then on.

## The library page

- **Switches** at the top: **Test data** (the labelled simulation, below), **Show HUD graphics** (off hides every HUD graphic at once, the same as the emergency hide) and **Utility on the radar** (smokes, fires and flashes the game reports, on HUD radars). Hover the **?** for details.
- **Counter-Strike 2** card: whether CS2 was found and its data arrives, the console command `cl_draw_only_deathnotices 1` with **Copy** (paste it into the CS2 console while spectating so only your HUD and the kill notices show), **Launch CS2** (through Steam) and **Setup** (the game state integration config).
- Below: search, category, status and sort, list or grid, and **Add HUD**. HUDs are grouped by category; click a group's name to fold it.
- Each HUD's row shows its picture, name and version, author, status and active outputs, then **Settings** (gear), **Preview** (eye), **Copy OBS Browser URL**, **⋯** (more actions), the **Desktop** switch and the arrow that opens its details under the row.

## Add a HUD

- **Add HUD → Import HUD ZIP…** or **Import HUD folder…**, at the right of the toolbar. The package is checked first (manifest, entry files, allowed file types, sizes, paths). An invalid package is refused with the reason and nothing installed changes.
- The files are copied into the library: you can move or delete the original ZIP or folder afterwards.
- Importing a HUD whose id is already installed shows both versions and asks what to do: **Update to <version>** (keeps its settings and reloads its outputs; the old version stays available as **Roll back** in its details), **Import as a copy** (a new id), or **Cancel**.
- Package format and manifest: `docs/extensions.md` and `assets/hud-packages/matchframe-sample-cs2/README.md`.

Other actions, under **⋯** on the HUD's row: **Reload**, **Stop**, **Duplicate** (a copy you can change), **Export ZIP**, **Open Folder**, **Remove…**. The built-in HUD can't be removed, exported or duplicated.

## Test data

The **Test data** switch starts the labelled simulation: a synthetic 5v5 on a synthetic map, offline. The header shows **Test data** while it runs, and HUDs show a test-data label. Stop it before a real match; real game data is ignored while it runs.

## Three ways to show a HUD

| Mode | How | Notes |
|---|---|---|
| **Transparent desktop HUD** | The **Desktop** switch on the HUD's row (**Launch Transparent HUD** on a grid card) | A separate window with only the HUD graphics, always on top, click-through, never takes keyboard focus. Keeps updating when the manager is minimised. |
| **Preview** | **Preview** (eye) on the HUD's row, or the preview in its details | A normal window; tick *Checkerboard* to inspect transparency. Closing it affects nothing else. |
| **OBS browser source** | **Copy OBS Browser URL** | A local URL with only the HUD on a transparent background. Use the size shown next to the button (normally 1920×1080). |

All three show the same match information and the same settings, and run independently: hiding or closing the desktop HUD doesn't touch OBS, and stopping one HUD doesn't stop another.

### Transparent HUD over CS2

1. In CS2 set **Display Mode: Fullscreen Windowed** (borderless). **Exclusive fullscreen is not supported**: no normal desktop window can draw over it.
2. Turn on the HUD's **Desktop** switch. Mouse clicks and keys go to the game; the HUD never takes focus.
3. Open the HUD's details (the arrow at the end of its row) → **Outputs** → **Desktop HUD**: choose the **monitor** CS2 runs on. **Fit to monitor** sizes the HUD to the monitor without stretching (16:9 HUDs are letterboxed on 16:10 or ultrawide monitors); **100 %** uses the HUD's design size; **Scale (%)**, **X** and **Y** set it exactly.
4. To move it by hand: **Edit position**. The window shows an outline and can be dragged. Click **Done editing** (or tick **Lock position and size**) when done. Position and scale are remembered per HUD.
5. Windows display scaling and monitors of different resolutions are handled; monitors to the left of or above the main one work too. If a monitor is disconnected the HUD moves to the main monitor.

### OBS

1. Add a **Game Capture** source for CS2.
2. Add a **Browser Source** above it: URL from **Copy OBS Browser URL**, width and height as shown (1920×1080 for the included HUDs), *Shutdown source when not visible* off, *Refresh browser when scene becomes active* off. No custom CSS is needed; the background is transparent.
3. The desktop HUD window is a separate window and is **not** included in Game Capture. Use the browser source for the stream; use the desktop HUD to see the graphics while you play or observe.
4. The URL contains a key for that HUD. **New access key** (details → Outputs) makes old URLs stop working.

## Settings

Click a HUD's row (or its arrow, or the gear) to open its details under it. **Appearance** holds the HUD's settings form (from its manifest) and preset; **Save settings** applies them immediately to the desktop HUD, previews and OBS sources, without a reload. Settings are saved per HUD on this computer.

## Hotkeys and tray

- **Toggle desktop HUD** (default `Ctrl+Shift+H`) shows or hides the desktop HUD windows. OBS sources are unaffected.
- **Emergency hide** (default `Ctrl+Shift+F9`) hides **all** HUD graphics, desktop and OBS, until pressed again. The status bar shows when graphics are hidden.
- Change them in a HUD's details → **Outputs** → **Hotkeys**. A hotkey another program already uses is reported as not registered.
- **Stop automation** (`Ctrl+Shift+F12`, or F8 in the window) stops the Auto Director, as before.
- The **tray icon** has Show Manager, Show/Hide HUD, Stop HUD (closes desktop HUD windows and previews) and Quit.
- Minimising the manager keeps the HUD server and HUD windows running. Closing the manager while a desktop HUD is open keeps the program in the tray. **Quit** (tray) closes every output and stops the HUD server; no background process is left.

## When game data stops

The header shows the game-data state. If CS2 stops sending data (game closed, map change, network), the status changes to *stale* or *waiting*. HUDs keep the last state and are labelled as paused. When data resumes, everything recovers on its own; there is no need to relaunch HUDs or refresh OBS.

## Troubleshooting

| Symptom | Check |
|---|---|
| Desktop HUD not visible over the game | CS2 in Fullscreen Windowed, the right monitor selected, not hidden (Toggle desktop HUD / emergency hide), HUD not stopped |
| OBS source shows nothing | URL copied from this computer's library, HUD not stopped or hidden, source size as shown, Matchframe running |
| OBS source shows a black background | Custom CSS in the source settings; clear it |
| HUD shows Error | The package's files changed on disk or its entry file is missing: re-import it |
| Hotkey not working | Registration failure in the HUD's details; choose another combination |
| Update stuck or failing | **Settings → General → Program** shows the error; **Check for updates** again, or download the installer from the website and install over the current version (HUDs and settings are kept) |

## What is verified automatically, and what needs a manual check

Automated (unit, end-to-end and the Windows workflow): package import, validation and conflicts, storage across restarts, per-HUD settings, the HUD server and its outputs, and the library screen. `scripts/overlay-check.cjs` runs against the installed program on a Windows runner: desktop HUD window settings, transparent pixels, edit mode, scale and position, live settings, updates while the manager is minimised, the OBS browser source rendered offscreen and transparent, independent outputs, emergency hide, recovery after an engine restart, Stop, and a clean quit with no process left; and on the real Windows desktop, screen pixels over a stand-in game window, click-through and focus with real mouse input, and the emergency-hide hotkey. The runner has one monitor at 100 % scaling.

**Manual check before a broadcast** (needs real hardware and software):

- [ ] CS2 in Fullscreen Windowed with the desktop HUD on top; the game keeps mouse and keyboard; alt-tab and back keeps the HUD on top.
- [ ] Two or more monitors, including one left of the main monitor and one with different scaling (e.g. 100 % and 150 %): placement, Fit display and remembered position.
- [ ] OBS 30+: Browser Source over Game Capture shows the HUD with a transparent background at the stated size; settings changes appear in OBS.
- [ ] Unplug or close CS2 mid-round: HUD shows paused data; start again: it recovers.
- [ ] Quit from the tray: no `Matchframe Esports` processes remain in Task Manager.
