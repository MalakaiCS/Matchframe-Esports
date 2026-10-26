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

## Tested

Integration tests (`packages/obs-adapter/test/obs.integration.test.ts`, run with `MF_OBS_URL`/`MF_OBS_PASSWORD`) pass against **OBS 30.0.2 (obs-websocket 5.3.4) on Linux, headless under Xvfb**: wrong-password rejection, request discovery, provisioning without replacement, confirmed program cut and visibility toggles, refusal to replace another input kind, replay buffer start → confirmed save (real .mkv written) → stop. That OBS build has no Browser Source plugin, so browser-source provisioning was verified only as a clear failure path; it is **not yet verified on Windows OBS**.

## Browser source settings

URL from HUDs & Composer (contains a read-only output token), 1920×1080 (1440p/4K scale automatically), "Shutdown source when not visible" off, custom CSS empty. The page background is transparent.
