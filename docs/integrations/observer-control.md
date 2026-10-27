# Observer control

Matchframe controls the observer through semantic operations (`selectPlayer`, `setObserverMode`, `activateStaticCamera`, `playCameraPath`, `cancelPath`) implemented by adapters. Only the control arbiter writes to the observer.

## Adapters

| Adapter | Mechanism | Status |
|---|---|---|
| None | No game control; advisory/manual only. | Supported |
| Simulation | Drives the labelled simulation source only. | Supported (does not certify real control) |
| Direct (console) | CS2 TCP console via the `-tools -netconport <port>` launch options (CS2 opens the console only with `-tools`, which needs the free CS2 Workshop Tools), loopback only. **Start CS2** in the Observer tools mode starts CS2 this way and selects this adapter when none was chosen. Command templates are configurable: `spec_player_by_accountid {accountId}`, `spec_mode 4/5/6`, `spec_mode 6; spec_goto {x} {y} {z} {pitch} {yaw}`, `getpos`. | **Unverified** — templates are candidate mappings that must be confirmed on the target build |
| Keyboard | Windows SendInput of the observer-slot number key, only to the focused window whose title matches (default `^Counter-Strike 2$`); needs the optional `koffi` package. | **Unverified** — not testable on this project's Linux CI |

The console channel is a documented Valve launch option, not memory reading or injection. Because the console accepts arbitrary commands, Matchframe only connects to loopback and fills templates with validated values. Do not expose the netcon port on a network. If a workshop/observer-only server setup is needed for cameras, the server operator must configure it deliberately; Matchframe never changes competitive server settings.

## Verifying control (required before automation)

1. Configure the adapter (`PUT /api/v1/observer/adapter`).
2. **Player selection test** (`POST /api/v1/setup/test-player-selection`): pick a player who is not currently spectated. Evidence is recorded (and automatic POV cuts are unlocked) only if GSI feedback shows that player within 3 s.
3. **Static camera test**: telemetry can only show a free-camera state, so after `test-static-camera` the operator confirms what the observer shows (`confirm-static-camera`). Support is then recorded as `partial`.
4. Validate each camera on each map (`/maps/:map/cameras/:id/validation`). Unvalidated cameras are preview-only and never used automatically.

## Confirmation semantics

Writing bytes or sending a key is `transport_only`. A command is `confirmed` only when telemetry shows the requested player (`observed_exact`) or a consistent free-camera state for static cameras (`observed_consistent`). If feedback keeps arriving but never shows the target, the command fails with `confirmation_timeout`; one bounded retry is allowed for transport errors only.
