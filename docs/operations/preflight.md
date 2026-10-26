# Preflight checklist (before going live)

- [ ] Setup → Status: real GSI packets arriving (not SIMULATION), game build shown, source not stale.
- [ ] Capability report reviewed: all-player state, positions, grenade entities; note which grenade types are verified.
- [ ] Observer adapter configured; player-selection test **recorded** for this build (or automation will stay blocked).
- [ ] Static cameras: only validated cameras for the current map revision; otherwise disable cinematics for the match.
- [ ] OBS connected; program scenes mapped; HUD browser source shows the published output; transparent background verified in OBS.
- [ ] Active match set; team logos/colours and player names correct on both sides; side swap tested in warmup if possible.
- [ ] HUD output published (not just drafted); preview output matches program preset.
- [ ] Replay provider healthy (OBS replay buffer running, or bridge shim healthy).
- [ ] Director mode chosen (start in Advisory or Assisted); emergency stop hotkey works (`Ctrl+Shift+F12`).
- [ ] Demo library paused during live (default) and training not running.
- [ ] Support bundle downloads (Settings & Diagnostics) — confirms logging works.
