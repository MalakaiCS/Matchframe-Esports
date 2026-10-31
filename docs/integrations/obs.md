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
  - **Transitions:** **Replay in** (live to a replay), **Replay out** (back to live; the same as Replay in unless chosen) and **Other scenes** (to and from the break and studio scenes): any of OBS's transitions, such as a Stinger made once in OBS (Scene Transitions → + → Stinger), or OBS's current one. Every program change uses them, whoever makes it (automatic replays, a clip played by hand, Return live, the program buttons, this automation). OBS's own transition and duration are put back once OBS says the transition has ended (`SceneTransitionEnded`: a Stinger's whole video).
  - API: `GET`/`PUT /api/v1/obs/auto` (`replayIn`, `replayOut`, `otherScenes`; before 0.10.5 one `replayTransition`, kept as `replayIn`).
- **Set up OBS replay scene** (`POST /api/v1/replays/obs-setup`): a *Matchframe Replay* scene with a *Matchframe Replay Clip* media source, mapped as the replay scene, and its twin *Matchframe Replay B* (below).
- **The replay scene's twin,** for fading from one replay to the next: "<replay scene> B", the replay scene's sources shared with the same transforms, visibility, blend modes and order, and a media source of its own ("<media source> B") with the same settings, filters and audio. A break's clips alternate between the two and the program fades over with OBS's Fade (found by its kind, `fade_transition`). It is brought up to date off air at each break. See [Replay PC and automatic replays](../operations/replay-pc.md).
- **Studio Mode:** program changes use `SetCurrentProgramScene`, which leaves the preview; OBS's Swap Scenes (on by default) then puts the scene the program left in preview, and Matchframe puts the operator's back. A program change made in OBS itself (the Transition button) during a break's replays is taken as the operator taking over. Duplicate Scene and Duplicate Sources don't affect media source control (OBS never copies a Media Source).
- **Automatic replays** and the **replay PC**: see [Replay PC and automatic replays](../operations/replay-pc.md). Replays play at the chosen speed with the media source's own speed setting, from the clip's end part (`SetMediaInputCursor`).
- **HUD graphics:** an LHM HUD's pages are shown by toggling their OBS browser sources in a scene you pick.
- **Match stingers:** every match gets a stinger and a replay stinger (QuickTime files with transparency). **Matches → Thumbnails & stingers → Put the stingers in OBS** puts them in two Stinger transitions you create once in OBS, `Matchframe Stinger` and `Matchframe Replay Stinger` (obs-websocket can't create transitions): video file and transition point (900 ms), confirmed by read-back. Activating a match puts its stingers in. See [Matches, thumbnails and stingers](../operations/match-graphics.md).
- **Changing OBS's transition:** OBS applies a transition change a moment after the request (in OBS 30, 91 of 200 reads straight after still saw the old one). Matchframe waits until OBS reports the new transition before cutting or changing its settings, so a replay is cut with the replay transition and a transition's settings never go to another one.
- **OBS 30's events around a program change** (measured): `SceneTransitionStarted` before the request is answered, `GetCurrentProgramScene` says the new scene at once, then at the end `SceneTransitionVideoEnded`, `CurrentProgramSceneChanged` and `SceneTransitionEnded` (a Stinger's at the end of its video).

## Tested

Integration tests (`packages/obs-adapter/test/obs.integration.test.ts`, run with `MF_OBS_URL`/`MF_OBS_PASSWORD`) pass against **OBS 30.0.2 (obs-websocket 5.3.4) on Linux, headless under Xvfb**: wrong-password rejection, request discovery, provisioning without replacement, confirmed program cut and visibility toggles, refusal to replace another input kind, replay buffer start → confirmed save (real .mkv written) → stop → playback of the saved clip through a media source, confirmed from OBS's media status. The engine-level replay flow (`services/local-engine/test/replay-obs.integration.test.ts`: bookmark with capture → approve → play on the replay scene → return live) also passes against it, and so does the replay PC flow (`replay-pc-obs.integration.test.ts`: two engines; the replay PC's buffer saved and uploaded, the one-click replay scene, the clip played after the round and back to live), and so do the match stingers (`match-art-obs.integration.test.ts`: both Stinger transitions set and read back from OBS, OBS's transition kept unless asked; it needs the two transitions in the scene collection). With the program's real stingers, recordings of a red → green scene cut showed the scenes through the stinger's transparent parts and never both at once. Replay playout is confirmed the same way in production: if OBS does not report playback within 2 s, the clip is marked failed and the program returns to LIVE. That OBS build has no Browser Source plugin, so browser-source provisioning was verified only as a clear failure path; it is **not yet verified on Windows OBS**.

## Browser source settings

URL from HUDs & Composer (contains a read-only output token), 1920×1080 (1440p/4K scale automatically), "Shutdown source when not visible" off, custom CSS empty. The page background is transparent.
