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
- **Counter-Strike 2** card: whether CS2 was found and its data arrives, the launch mode, **Start CS2** and **Setup** (below). In the standard mode it shows the console command `cl_draw_only_deathnotices 1` with **Copy** (paste it into the CS2 console while spectating so only your HUD and the kill notices show); in the console modes it shows the game options instead.
- Below: search, category, status and sort, list or grid, and **Add HUD**. HUDs are grouped by category; click a group's name to fold it.
- Each HUD's row shows its picture, name and version, author, status and active outputs, then **Settings** (gear), **Preview** (eye), **Copy OBS Browser URL**, **⋯** (more actions), the **Desktop** switch and the arrow that opens its details under the row.

## Minimap and killfeed

Every bundled HUD shows a minimap (top left) and a killfeed (top right), each in its own style: the Matchframe Broadcast HUD (Classic, Minimal and Arena presets), the Pro CS2 HUD and the Sample CS2 HUD. Turn either off in the HUD's details → **Appearance**.

- **Minimap:** the map drawing for Ancient, Dust II, Inferno, Mirage, Nuke, Overpass, Train and Vertigo (Nuke and Vertigo show both levels), and Matchframe's generated outline for Anubis. Players show their slot number in the team colour: bigger with a ring when observed, lighter while flashed, marked when carrying the bomb, a faded cross when dead. Smokes are outlined in the thrower's team colour; fires, flashes and HE grenades show briefly; the bomb shows when dropped or planted (pulsing) and when defused. **Utility on the radar** in the library turns the utility off. A radar image you calibrate in Maps & Cameras replaces the built-in one.
- **Killfeed:** killer (+ assister), weapon, headshot and blind-killer marks, victim; each kill stays for a few seconds. CS2's game data does not report kills, so Matchframe pairs them from the score changes in the same update, like every game-data HUD: the weapon is the one the killer was holding (a grenade or fire kill can show their gun), and when two players get kills in the same instant the victims are shown without a killer. Wallbang, no-scope, through-smoke and flash-assist marks are not available from game data.

## Start CS2

**Start CS2** on the Counter-Strike 2 card writes the game data (GSI) config into the CS2 folder and starts CS2 in the launch mode chosen next to it. Change the console port, add launch options (for example `-novid`) and choose HLAE in **Settings → Setup → Start CS2**.

| Mode | Starts CS2 with | What you get | Needs |
|---|---|---|---|
| **Standard** | Steam, your launch options | Game data for the HUDs. Works on any server. | CS2 |
| **Observer tools** | Steam, `-tools -netconport 2121` | Matchframe connects to CS2's console on this computer: camera control for the Observer (the *Direct (console)* adapter is selected if none was) and the game options below. | The free **CS2 Workshop Tools** (Steam → Counter-Strike 2 → DLC) |
| **Observer tools + HLAE** | HLAE, `-steam -insecure -tools -netconport 2121` | Also HLAE's options: no flash, team colours in the kill feed or no game kill feed, no end-of-match screen. | CS2 Workshop Tools, [HLAE](https://www.advancedfx.org/) (choose `HLAE.exe`), Steam running |

Game options (console modes; sent every time the console connects, and straight away when changed):

- **Hide game HUD**: `cl_draw_only_deathnotices 1`, the game shows only its kill feed and your HUD shows the rest.
- **X-ray**: `spec_show_xray`, players visible through walls on the observer's screen.
- **Run behind other windows** (on by default): `engine_no_focus_sleep 0` and `snd_mute_losefocus 0`. CS2 keeps drawing every frame and playing its sound while you use Matchframe or OBS. Off, CS2 slows down and goes silent whenever another window has focus (its own defaults). With CS2 in **Fullscreen** (not **Fullscreen Windowed**), clicking another window still stops the picture: use Fullscreen Windowed on the observer computer.
- HLAE only: **No flash** (`mirv_noflash 1`), **Team colours in kill feed** (`mirv_deathmsg colors`, using each team's colour from Teams, swapped at half time), **Hide end-of-match screen** (`mirv_endofmatch 0`), **Hide CS2 kill feed** (`mirv_deathmsg filter add block=1`: CS2's own kill notices are blocked so only your HUD's kill feed shows; with **Hide game HUD** on, the crosshair stays). Matchframe clears its kill feed rule (`mirv_deathmsg filter clear`) each time it applies the options, so rules never stack; that also clears kill feed filters you added in the console yourself.

The card shows **Console connected** once CS2 is up. If it keeps showing *Console: waiting for CS2* after CS2 has started, the CS2 Workshop Tools are usually not installed, or CS2 was already running (close it and click Start CS2 again).

**HLAE runs CS2 insecure.** Matchframe asks you to accept this before the HLAE mode is used:

- Insecure CS2 cannot join VAC-secured servers. The match server must allow insecure observers (`tv_secure_bypass 1`), or use LAN or demos.
- Never join matchmaking or a VAC-secured server while HLAE is loaded: HLAE's developers warn that this can get the account VAC banned.
- CS2 updates often break HLAE until HLAE ships an update. Standard and Observer tools keep working; install the latest HLAE when HLAE fails to start CS2.

HLAE is a separate download (MIT licence) and is not included with Matchframe. Matchframe never changes server settings and sends only the fixed console lines listed above.

## Add a HUD

- **Add HUD → Import HUD ZIP…** or **Import HUD folder…**, at the right of the toolbar. The package is checked first (manifest, entry files, allowed file types, sizes, paths). An invalid package is refused with the reason and nothing installed changes.
- The files are copied into the library: you can move or delete the original ZIP or folder afterwards.
- Importing a HUD whose id is already installed shows both versions and asks what to do: **Update to <version>** (keeps its settings and reloads its outputs; the old version stays available as **Roll back** in its details), **Import as a copy** (a new id), or **Cancel**.
- Package format and manifest: `docs/extensions.md` and `assets/hud-packages/matchframe-sample-cs2/README.md`.

Other actions, under **⋯** on the HUD's row: **Reload**, **Stop**, **Duplicate** (a copy you can change), **Export ZIP**, **Open Folder**, **Remove…**. The built-in HUD can't be removed, exported or duplicated.

## LHM-format HUDs

HUDs made for Lexogrine HUD Manager (LHM) can be imported as they are: a ZIP or folder with `hud.json` and `index.html`, usually also `panel.json`. Many custom HUDs are built this way. LHM doesn't need to be installed and no LHM account is needed.

1. **Add HUD → Import HUD ZIP…** (or **Import HUD folder…**) and pick the HUD. It appears in the **LHM** category with the id `lhm.<its name>`. Its details show **Format: LHM-format HUD**.
2. If the HUD uses team names, logos, colours or player photos, enter the teams and players in **Teams** and **Players** and make the match active in **Matches**. The HUD reads them from Matchframe, the way it read them from LHM. Without an active match it shows the names CS2 sends.
3. The HUD's control panel (`panel.json`) becomes its **Appearance** settings, grouped by panel section: text, checkboxes, colours and lists. Player and team choices are lists of Matchframe's players (and the players in the game) and teams. **Save settings** sends them to the running HUD.
4. Panel buttons (for example *Toggle Header* or *Show veto*) appear as buttons in **Appearance** and act straight away. They work only while the HUD is running (desktop, preview or OBS); otherwise the program says the HUD isn't running.
5. Show it like any other HUD: the **Desktop** switch, **Preview**, or **Copy OBS Browser URL**. The OBS size is 1920×1080.
6. **The HUD's own pages** (its `hud.json` variants) are listed under **HUD pages** in its details, each with **Copy URL**. kaiHUD has *Player stats* (its Player Highlight panel), *Match stats*, *Match preview*, *Veto* and *Baseboard*. Add each one you use as another OBS Browser Source. In **Replays & Production → HUD graphics → LHM HUD pages**, Matchframe can show Player stats for the round MVP in freeze time and Match stats at half time and at the end of the map.
7. **Image inputs** (for example kaiHUD's baseboard sponsors) are **Add images** fields in **Appearance**. The images are sent to the HUD the way LHM sends them.

What works: everything the HUD draws from game data (scoreboard, players, bomb, utility, its own minimap and killfeed), its fonts, its settings, buttons and image inputs, its own pages, teams (names, logos, colours as `TeamColor`), players (real names, photos), the current match and veto, and Matchframe's built-in radars for HUDs that ask for them. kaiHUD 1.0.2 was checked page by page in a browser against test data: Player Highlight, Match stats, match preview and baseboard showed the right players, stats, logos, colours and sponsor images. During **Test data**, a purple **TEST DATA** label appears at the top of the HUD.

Limits:

- **Killfeed**: CS2's game data has no kill events. The killfeed shows Matchframe's paired kills (killer, weapon in hand, headshot, assister, blind killer), so wallbang, no-scope, through-smoke and flash-assist icons never appear. Kills made before the HUD opened don't appear either.
- No output delay: LHM-format HUDs always show live data.
- **Update rate**: CS2 sends game data up to 50 times a second, more than an LHM-format HUD redraws smoothly (kaiHUD's baseboard stuttered). Matchframe sends the HUD the newest data at most 10 times a second, and at once when something on screen changes: the spectated player, the round or countdown phase, the bomb, who is alive, the score. Measured on kaiHUD's baseboard at a sixth of the CPU's speed: 55 frames a second instead of 32.
- Not supported: the HUD's keyboard shortcuts (`keybinds.json`), player cameras, and anything that needs LHM's cloud. The rest of the HUD still works.
- kaiHUD's Player Highlight shows the selected player *or* the spectated one, whichever comes first in the game data. So Matchframe shows it for the MVP only when the camera isn't on another player.
- Fonts from Google Fonts load from the internet. Offline, the HUD falls back to other fonts.
- Only CS2 (and CS:GO-format) HUDs are accepted.

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
| LHM-format HUD stays empty | Opened through Matchframe's URL (Preview, Desktop or Copy OBS Browser URL), not by opening `index.html`; game data arriving or Test data on; after **New access key**, copy the URL again |
| LHM-format HUD shows no team names or logos | Teams entered in **Teams** with logos, and the match active in **Matches** |
| Hotkey not working | Registration failure in the HUD's details; choose another combination |
| Console never connects | CS2 Workshop Tools installed; CS2 started with Start CS2 (not already running); the same console port in Setup and in CS2's launch options |
| HLAE could not start CS2 | Latest HLAE installed (CS2 updates break older versions); Steam running; the HLAE folder still has `x64\AfxHookSource2.dll` |
| Update stuck or failing | **Settings → General → Program** shows the error; **Check for updates** again, or download the installer from the website and install over the current version (HUDs and settings are kept) |

## What is verified automatically, and what needs a manual check

Automated (unit, end-to-end and the Windows workflow): package import, validation and conflicts, storage across restarts, per-HUD settings, the HUD server and its outputs, and the library screen. `scripts/overlay-check.cjs` runs against the installed program on a Windows runner: desktop HUD window settings, transparent pixels, edit mode, scale and position, live settings, updates while the manager is minimised, the OBS browser source rendered offscreen and transparent, independent outputs, emergency hide, recovery after an engine restart, Stop, and a clean quit with no process left; and on the real Windows desktop, screen pixels over a stand-in game window, click-through and focus with real mouse input, and the emergency-hide hotkey. The runner has one monitor at 100 % scaling.

**Manual check before a broadcast** (needs real hardware and software):

- [ ] CS2 in Fullscreen Windowed with the desktop HUD on top; the game keeps mouse and keyboard; alt-tab and back keeps the HUD on top.
- [ ] Two or more monitors, including one left of the main monitor and one with different scaling (e.g. 100 % and 150 %): placement, Fit display and remembered position.
- [ ] OBS 30+: Browser Source over Game Capture shows the HUD with a transparent background at the stated size; settings changes appear in OBS.
- [ ] Unplug or close CS2 mid-round: HUD shows paused data; start again: it recovers.
- [ ] Quit from the tray: no `Matchframe Esports` processes remain in Task Manager.
