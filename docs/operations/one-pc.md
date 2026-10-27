# One-PC setup

Everything on one Windows machine: CS2 observer client, Matchframe, OBS.

1. **Install** the Matchframe program (`MatchframeEsports-Setup-<version>.exe`, downloaded from your account on the website; or run from source with `pnpm dev`, see README). It opens on the **HUD Library**: HUDs, test data, the transparent desktop HUD and OBS browser sources need no account ([hud-library.md](hud-library.md)). To use the Observer modes on live matches, **sign in** under **Settings → Account** with your Matchframe website account (email and password; the email must be confirmed): they use the plan's auto-director hours, and Full Action Observer (nade cameras) needs a plan that includes it. After signing in, the program works offline for up to 7 days after each check.
2. Open **Settings → Setup**. Choose *Live observer*.
3. **Detect CS2** and **write the GSI config** (Setup). Restart CS2.
4. Launch CS2 as an observer (spectator/GOTV). Setup should show packets arriving and the capability report.
5. **Observer control (optional but required for automation).** Either:
   - add the launch option `-netconport 2121` to the observer client and choose *Direct (console)* with host `127.0.0.1`, port `2121`; or
   - choose *Keyboard* and keep the CS2 window focused.
   Run the **player selection test**. Automatic POV cuts stay blocked until it passes.
6. **OBS:** enable the WebSocket server, connect from **Settings → Devices**, map program scenes (LIVE/REPLAY/STUDIO/BREAK). Add a *Game Capture* of CS2 and the Matchframe HUD browser source (or use *Provision HUD source*), 1920×1080.
7. **HUD:** in the **HUD Library**, select a HUD, choose its preset and settings, then **Copy OBS Browser URL** (Browser Source above the Game Capture). **Launch Transparent HUD** shows it over CS2 on this computer too (CS2 in Fullscreen Windowed).
8. **Match:** create teams/players (SteamID64 as text), create the match, run the veto, **Activate** the match so the HUD shows team identity and series.
9. **Director:** start in *Advisory* (recommendations only). Move to *Assisted* (POV cuts only) or *Automatic* once you trust the setup; **Resume automation** explicitly.
10. Run the **preflight checklist** (`preflight.md`) and save a setup profile.

Resource note: one CS2 client + OBS + Matchframe is the supported topology. Running additional CS2 clients on the same PC (for replays or lookahead) needs a measured resource profile first.
