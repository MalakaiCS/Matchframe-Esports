# One-PC setup

Everything on one Windows machine: CS2 observer client, MatchFrame, OBS.

1. **Install** the MatchFrame program (`MatchFrameEsports-Setup-<version>.exe`, downloaded from your account on the website; or run from source with `pnpm dev`, see README). It opens on the **HUD Library**: HUDs, test data, the transparent desktop HUD and OBS browser sources need no account ([hud-library.md](hud-library.md)). To use the Observer modes on live matches, **sign in** under **Settings → Account** with your MatchFrame website account (email and password; the email must be confirmed): they use the plan's auto-director hours, and Full Action Observer (nade cameras) needs a plan that includes it. After signing in, the program works offline for up to 7 days after each check.
2. Open **Settings → Setup**. Choose *Live observer*.
3. **Detect CS2** and **write the GSI config** (Setup). Restart CS2.
4. Launch CS2 as an observer (spectator/GOTV). Setup should show packets arriving and the capability report.
5. **Observer control (optional but required for automation).** Either:
   - start CS2 with **Start CS2** in the *Observer tools* mode (`-tools -netconport 2121`; needs the free CS2 Workshop Tools), which selects *Direct (console)* on `127.0.0.1:2121`; or
   - choose *Keyboard* and keep the CS2 window focused.
   Run the **player selection test**. Automatic POV cuts stay blocked until it passes.
6. **OBS:** enable the WebSocket server, connect from **Settings → Devices**, map program scenes (LIVE/REPLAY/STUDIO/BREAK). Add a *Game Capture* of CS2 and the MatchFrame HUD browser source (or use *Provision HUD source*), 1920×1080.
7. **HUD:** in the **HUD Library**, select a HUD, choose its preset and settings, then **Copy OBS Browser URL** (Browser Source above the Game Capture). **Launch Transparent HUD** shows it over CS2 on this computer too (CS2 in Fullscreen Windowed).
8. **Match:** create teams/players (SteamID64 as text), create the match, run the veto, **Activate** the match so the HUD shows team identity and series.
9. **Director:** start in *Advisory* (recommendations only). Move to *Assisted* (POV cuts only) or *Automatic* once you trust the setup; **Resume automation** explicitly.
10. Run the **preflight checklist** (`preflight.md`) and save a setup profile.

Resource note: one CS2 client + OBS + MatchFrame is the supported topology. Running additional CS2 clients on the same PC (for replays or lookahead) needs a measured resource profile first.

## Low-spec mode

When CS2, OBS and MatchFrame share one PC and the HUD stutters, turn on **Settings → General → Performance → Low-spec mode (one PC)** (off by default; ADR-078). The HUD Library suggests it once, when a desktop or OBS output stutters twice within a minute while CS2 sends game data from this PC; **Dismiss** and it is not shown again.

While it is on:

| Where | What changes |
|---|---|
| HUD outputs and the desktop HUD | At most 30 frames a second: the output page runs the HUD's animation frames at most 30 times a second, and the desktop HUD windows get Electron's `setFrameRate(30)` too. MatchFrame's HUDs drop large soft shadows, backdrop blur and looping animations, and their timer and fuse bars step with each update instead of gliding (`HudState.lowSpec`, [extensions.md](../extensions.md)). Imported HUDs get the frame cap only. |
| OBS | The browser sources MatchFrame made (*MatchFrame HUD*, *MatchFrame Replay Graphic*, *MatchFrame Team Comms*) are set to *Use custom frame rate* on, *FPS* 30 over OBS websocket (when it is turned on, when OBS connects, when such a source is made); turning it off puts back what they had. Not Team Comms' *MatchFrame Speaker Strip*: it is only in the comms recording, and its timing is measured frame by frame from that recording. **Your own browser sources:** right-click → **Properties** → tick **Use custom frame rate**, **FPS** 30. |
| Engine | HUD pushes that would change nothing are not sent (at least every 5 s the state goes again), and each output's state is serialized once however many pages show it. Demo hashing and processing, training runs and highlight reels wait while a round is live (also with the Demo Library's *Pause during live* off); a job already running finishes. Replays and highlights are encoded with the encoder's fastest preset (x264 `ultrafast` for the replay feed and `veryfast` for reels, NVENC `p1`, Quick Sync `veryfast`, AMF `speed`; the replay feed from its next start). |
| Engine memory | The program starts the engine with `--max-old-space-size` 1024 MB (768 MB on PCs with less than 12 GB). The engine's heap is 50–150 MB in a broadcast, so this only bounds the worst case: without it V8 sets its own limit from the PC's memory (2,096 MB measured on a 16 GB computer; 1,072 MB with the cap). It applies from the engine's next start: **Restart engine now** in the panel (HUD outputs reconnect by themselves; camera automation stays off until resumed). An engine started without the program (`pnpm engine`) has no cap. |
| Console | No live previews or animated thumbnails: a HUD's details show its still picture with **Show live preview**, and the on-air preview (HUD outputs) and the player cams' previews start off. |

The panel shows what it has done here: the engine's memory cap and use, the OBS sources set to 30 fps (or why not), and whether background work is waiting for the round to end.

**Measured** (`scripts/low-spec-measure.mjs`, Linux with Xvfb and software rendering, the labelled simulation, the Vector HUD as an OBS-style page in Chromium; see ADR-078 for the full table): while something on the HUD moves all the time (the planted bomb), the HUD's CPU fell from 23.2 % to 14.4 % of a core and its frames drawn from 60 to 16 a second. In the rest of the live round it made no difference (15.2 % and 15.4 %): the HUD redraws for its 12 updates a second either way. The engine's CPU was the same (7.4 %); its heap limit fell from 2,096 to 1,072 MB. Run it yourself: `xvfb-run -a node scripts/low-spec-measure.mjs --low-spec both --reps 3`, and with `--offset 56 --seconds 13` for the planted bomb.

**Limits:** CSS animations and transitions are drawn by the browser's compositor and are not capped by the page: in imported HUDs they keep running at the display's rate. Electron applies `setFrameRate` to offscreen rendering only, so on screen the cap is the output page's own. Frames that come from the HUD's own state updates (up to 30 a second from the engine) are drawn when they arrive, so a busy round still draws more main-thread frames than the cap alone. Not measured on Windows with CS2 and OBS running.
