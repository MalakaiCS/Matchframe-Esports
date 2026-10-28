# OBS integration

Matchframe uses the authenticated obs-websocket v5 protocol (OBS 28+). OBS provides scene/source/recording/replay-buffer control; it does not provide CS2 telemetry or game-camera control.

## Connect

OBS → Tools → WebSocket Server Settings: enable, set a password. In Matchframe: Devices & Integrations → OBS (`POST /api/v1/obs/connect` with `ws://127.0.0.1:4455` and the password). The password is stored in the secret store (encrypted with the desktop shell).

## What Matchframe does

- Discovers OBS version, available requests and input kinds; re-synchronizes state after reconnect (backoff up to 15 s) and never replays old cues.
- Program/preview changes, source visibility, mute/volume, outputs (record/stream/replay buffer) — each confirmed by reading the resulting state back.
- Provisions a "Matchframe Live" scene and "Matchframe HUD" browser source on request without replacing existing scenes; refuses to replace an input of another kind; fails clearly when the OBS build has no Browser Source.
- Replay buffer saves wait for OBS's `ReplayBufferSaved` event before a clip is considered to exist.
- Program state machine (LIVE, REPLAY_PREPARED, REPLAY_PLAYING, STUDIO, BREAK, MANUAL, DEGRADED) maps modes to scenes you choose (`PUT /api/v1/settings/program.scenes`). A mode that needs a scene cannot be entered until one is mapped; OBS disconnect sets DEGRADED and recovery requires the operator.

## Scene automation and replays

**Replays & Production** has the OBS side of the production in one place:

- **OBS scenes:** the scene for each program mode (live, replay, break, studio).
  - Timeouts and pauses go to the break scene, and back when play resumes.
  - Map end goes to the studio scene, and back when the next map starts.
  - Scenes only change from the live scene, and only back from a scene Matchframe chose.
  - **Replay transition** picks an OBS transition (a Stinger) for cuts to and from replays, then puts the previous one back.
  - API: `GET`/`PUT /api/v1/obs/auto`.
- **Set up OBS replay scene** (`POST /api/v1/replays/obs-setup`): a *Matchframe Replay* scene with a *Matchframe Replay Clip* media source, mapped as the replay scene.
- **Automatic replays** and the **replay PC**: see [Replay PC and automatic replays](../operations/replay-pc.md). Replays play at the chosen speed with the media source's own speed setting, from the clip's end part (`SetMediaInputCursor`).
- **HUD graphics:** an LHM HUD's pages are shown by toggling their OBS browser sources in a scene you pick.
- **Match stingers:** every match gets a stinger and a replay stinger (QuickTime files with transparency). **Matches → Thumbnails & stingers → Put the stingers in OBS** puts them in two Stinger transitions you create once in OBS, `Matchframe Stinger` and `Matchframe Replay Stinger` (obs-websocket can't create transitions): video file and transition point (900 ms), confirmed by read-back. Activating a match puts its stingers in. See [Matches, thumbnails and stingers](../operations/match-graphics.md).
- **Changing OBS's transition:** OBS applies a transition change a moment after the request (in OBS 30, 91 of 200 reads straight after still saw the old one). Matchframe waits until OBS reports the new transition before cutting or changing its settings, so a replay is cut with the replay transition and a transition's settings never go to another one.

## Tested

Integration tests (`packages/obs-adapter/test/obs.integration.test.ts`, run with `MF_OBS_URL`/`MF_OBS_PASSWORD`) pass against **OBS 30.0.2 (obs-websocket 5.3.4) on Linux, headless under Xvfb**: wrong-password rejection, request discovery, provisioning without replacement, confirmed program cut and visibility toggles, refusal to replace another input kind, replay buffer start → confirmed save (real .mkv written) → stop → playback of the saved clip through a media source, confirmed from OBS's media status. The engine-level replay flow (`services/local-engine/test/replay-obs.integration.test.ts`: bookmark with capture → approve → play on the replay scene → return live) also passes against it, and so does the replay PC flow (`replay-pc-obs.integration.test.ts`: two engines; the replay PC's buffer saved and uploaded, the one-click replay scene, the clip played after the round and back to live), and so do the match stingers (`match-art-obs.integration.test.ts`: both Stinger transitions set and read back from OBS, OBS's transition kept unless asked; it needs the two transitions in the scene collection). With the program's real stingers, recordings of a red → green scene cut showed the scenes through the stinger's transparent parts and never both at once. Replay playout is confirmed the same way in production: if OBS does not report playback within 2 s, the clip is marked failed and the program returns to LIVE. That OBS build has no Browser Source plugin, so browser-source provisioning was verified only as a clear failure path; it is **not yet verified on Windows OBS**.

## Browser source settings

URL from HUDs & Composer (contains a read-only output token), 1920×1080 (1440p/4K scale automatically), "Shutdown source when not visible" off, custom CSS empty. The page background is transparent.
