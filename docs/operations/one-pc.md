# One-PC setup

Everything on one Windows machine: CS2 observer client, Matchframe, OBS.

1. **Install** the Matchframe program (`MatchframeEsports-Setup-<version>.exe`, downloaded from your account on the website; or run from source with `pnpm dev`, see README). HUDs, manual and advisory direction need no Python, account or paid service; automatic direction on live matches needs a linked computer with auto-director hours (**Account & Hours**).
2. **First run** opens Setup. Choose *Live observer*.
3. **Detect CS2** and **write the GSI config** (Setup). Restart CS2.
4. Launch CS2 as an observer (spectator/GOTV). Setup should show packets arriving and the capability report.
5. **Observer control (optional but required for automation).** Either:
   - add the launch option `-netconport 2121` to the observer client and choose *Direct (console)* with host `127.0.0.1`, port `2121`; or
   - choose *Keyboard* and keep the CS2 window focused.
   Run the **player selection test**. Automatic POV cuts stay blocked until it passes.
6. **OBS:** enable the WebSocket server, connect from Devices & Integrations, map program scenes (LIVE/REPLAY/STUDIO/BREAK). Add a *Game Capture* of CS2 and the Matchframe HUD browser source (or use *Provision HUD source*), 1920×1080.
7. **HUD:** HUDs & Composer → choose preset (Classic/Minimal/Arena) → Publish. Copy the browser-source URL.
8. **Match:** create teams/players (SteamID64 as text), create the match, run the veto, **Activate** the match so the HUD shows team identity and series.
9. **Director:** start in *Advisory* (recommendations only). Move to *Assisted* (POV cuts only) or *Automatic* once you trust the setup; **Resume automation** explicitly.
10. Run the **preflight checklist** (`preflight.md`) and save a setup profile.

Resource note: one CS2 client + OBS + Matchframe is the supported topology. Running additional CS2 clients on the same PC (for replays or lookahead) needs a measured resource profile first.
