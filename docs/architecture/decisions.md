# Architecture decision records

Each record states the decision, the evidence behind it and what would make us revisit it. Versions listed are the ones actually installed and tested in this repository's environment (Linux container, Node 22.22.0, pnpm 10.28.0, Python 3.13) unless stated otherwise.

## ADR-001 — Modular monolith with isolated workers
**Decision.** One local engine process (Node/TypeScript) owns match state, the director, the control arbiter, persistence and all APIs. Demo parsing and training run in separate Python worker processes. Electron is only a shell. No distributed queue or container orchestration is required to run a match.
**Why.** Spec §5.1; a single authoritative writer per observer is far easier to make safe in one process. Workers cannot stall the live loop.
**Revisit if.** Multi-observer production needs a second engine per observer (supported by design: one engine per match session).

## ADR-002 — pnpm workspace, TypeScript source packages, esbuild/Vite for builds
**Decision.** Packages export TypeScript source (`exports: ./src/index.ts`); dev uses `tsx`, tests use Vitest; production bundles with esbuild (engine, Electron main/preload) and Vite (operator UI, HUD). TypeScript 6.0.3 (TypeScript 7.0.2 exists but is outside typescript-eslint 8.72's supported range).
**Why.** No per-package build step; one bundle for the packaged engine.

## ADR-003 — Contracts in zod 4, JSON Schema generated
**Decision.** All boundary types (`packages/contracts`) are zod 4.6.7 schemas; `pnpm schemas` writes JSON Schema; `pnpm openapi` writes OpenAPI 3.1 from the router and route body schemas.
**Note.** zod 4 `z.record(enum, …)` is exhaustive; use `z.partialRecord` when keys are optional (found and fixed for HUD manifest entry points).

## ADR-004 — Metadata in Node's built-in SQLite (`node:sqlite`)
**Decision.** Use `node:sqlite` (no native addon) behind `services/local-engine/src/db`. Ordered, append-only migrations; the database file is copied to `backups/` before migrating an existing database. WAL mode, short transactions.
**Evidence (Phase 0).** Works on Node 22.22.0 (SQLite 3.50.4) and inside Electron 44.9.3 under `ELECTRON_RUN_AS_NODE` (Node 24.22.0, SQLite 3.53.4); the bundled engine was run under Electron's runtime with the API and simulation working. The module is still flagged experimental by Node (prints a warning).
**Revisit if.** Node changes the `node:sqlite` API incompatibly; the repository layer isolates the impact.

## ADR-005 — Ports, binding and authentication
**Decision.** GSI 37210, operator API 37211, overlays 37212 (configurable via env/settings; collisions fail loudly). Loopback by default. Every API route except `/health` and `/openapi.json` requires a bearer token mapped to a role; mutations are refused from foreign browser origins; the overlay server is read-only with a per-output token and a strict CSP.

## ADR-006 — Observer control through semantic adapters and one arbiter
**Decision.** `ObserverControlAdapter` (director-policy) with implementations in `services/observer-agent`: `NoControlAdapter`, labelled `SimulationObserverAdapter`, candidate `NetconObserverAdapter` (CS2 `-tools -netconport` console channel, configurable command templates, loopback only, injection-safe), and `KeyboardObserverAdapter` (Windows SendInput via optional `koffi`, only to the focused observer window). The `ControlArbiter` is the single writer: ownership generations, sticky manual takeover, epoch/expiry checks, at most one automated command in flight, bounded retry, confirmation from observed telemetry distinct from transport acknowledgement.
**Status.** Direct and keyboard channels are **unverified**: no CS2 client was available in this environment. Their capabilities stay "unverified" until the setup tests record observed confirmation. No memory reading, injection or anti-cheat evasion is used or planned.

## ADR-007 — GSI field knowledge from public documentation; no GPL code
**Decision.** GSI parsing follows the publicly documented field layout. CounterStrike2GSI (GPL-3.0) was consulted only as documentation; no code or fixtures were copied. All GSI fixtures in this repository are synthetic and labelled as such.

## ADR-008 — Demo parsing with demoparser2 behind an adapter
**Decision.** Python worker with demoparser2 0.42.0 (MIT) behind a `ParserAdapter`; Parquet via pyarrow 26.0.0, queries via DuckDB 2.0.0, Polars 2.1.0, LightGBM 4.7.0, scikit-learn 1.9.1.
**Evidence (Phase 0).** demoparser2 parsed all five available real CS2 demos (2023 builds 13914–14000; Overpass, Anubis, Inferno ×2, Ancient). Grenade entity classes differ by build (shared `CBaseCSGrenadeProjectile` / `CMolotovProjectile` in older builds); event coverage differs by demo (MM/Esportal demos lack most utility/damage events). See `docs/models/phase0-demo-pipeline-report.md`.

## ADR-009 — Live model execution in TypeScript
**Decision.** Trained tree ensembles are exported with LightGBM `dump_model()` and evaluated by a dependency-free TypeScript evaluator (`packages/director-policy/src/model/gbdt.ts`). Unsupported models are rejected and the deterministic baseline policy stays in charge. Parity with Python predictions is checked against exported parity vectors.

## ADR-010 — Region maps from real positions, not invented coordinates
**Decision.** Map packs are built from real parsed positions: per-place voxel cells from demo `last_place_name` samples and floor grids from player Z samples. Sub-regions such as Inferno Bottom/Top Banana are derived splits marked `requires_operator_validation`. Cameras are authored only from captured coordinates (`getpos`). Radar image mode requires an operator-supplied calibrated image; otherwise the HUD draws a schematic outline using the same transform as its markers. No radar calibration values were invented. (Amended by ADR-022: built-in radar images now come before the schematic outline.)

## ADR-011 — Public vs operator projections
**Decision.** Browser-source HUDs receive only `HudState` (packages/hud-sdk) for their output's presentation timeline. Director candidates, predictions, lookahead data and operator telemetry exist only on the authenticated operator socket. Delayed outputs read from a per-output delay buffer and show nothing until the buffer has filled.

## ADR-012 — Electron shell hardening
**Decision.** Electron 44.9.3; context isolation, sandbox, no Node integration; the window may only display the loopback engine origin; the preload bridge exposes a few invoke calls and hands the operator token only to frames from the engine origin. Stored credentials are encrypted with a key protected by Electron `safeStorage` (OS credential store). The engine is a supervised child process; restarts never issue camera or scene commands.

## ADR-013 — Original HUD design and fonts
**Decision.** Built-in HUD with three original presets (Classic, Minimal, Arena) over one widget system; fonts Inter and Barlow Condensed (OFL-1.1) bundled via @fontsource 5.3.0 (no remote fonts). No LHM designs, names or assets are used; LHM's manager is under a proprietary EULA and was used only as a functional reference for workflow breadth.

## ADR-014 — Replay: provider interface, honest angles
**Decision.** `ReplayProvider` (services/replay-agent) with an OBS replay-buffer provider (program angle only; save confirmed by OBS's `ReplayBufferSaved` event; clip facts from ffprobe) and a client for a documented bridge contract for the owner's existing replay tool. The tool's real API was not available, so that integration is **blocked**, not simulated.

## ADR-015 — Simulation is a separate, labelled source
**Decision.** The simulation source produces synthetic GSI on a synthetic test map (`de_synthetic`) through the normal ingest path. Every state and HUD snapshot carries `simulated: true`; HUDs and the operator UI show a SIMULATION badge; setup tests and camera validation refuse to record evidence while simulating; real GSI packets are not mixed into simulated state.

## ADR-016 — Hosted website and cloud API for accounts, billing and auto-director hours
**Context.** Matchframe is sold as a downloaded desktop app plus a website that handles signup, billing and auto-director hours.
**Decision.** One TypeScript service (`services/cloud-api`) serves the API and the website (`apps/cloud-web`) from one origin, on Postgres via node-postgres (PGlite in tests and trials). Billing through Stripe Checkout, the customer portal and signed webhooks (applied once per event id); Stripe is the source of truth for subscription state. Computers link with an RFC 8628 device-code flow and receive a revocable device token. The website issues Ed25519-signed licences (24 h validity, 7-day offline grace) that the desktop verifies offline against keys pinned into release builds. The desktop meters automatic direction locally and uploads idempotent usage records; the server keeps the allowance and debits credits under a per-organisation lock. Prices, plans and included hours are editable placeholders.
**Product rules.** Everything except automatic direction on live telemetry works without an account or internet. A billable second requires automation to own a real camera on live, non-simulated telemetry. Hours never run out mid-map: arming is gated, and when hours are used up automation hands back to manual at the next map change. No overage billing.
**Consequences.** The gate is a client-side licensing control, not DRM; the server-side usage record is authoritative for billing. Real Stripe, SMTP and hosting need the owner's accounts; they were exercised with the real Stripe SDK against a local API stub, the email outbox, and a real Postgres 16 server. Details: `docs/architecture/cloud.md`, `docs/operations/cloud-deployment.md`.

## ADR-017 — The operator console runs only inside the Matchframe program
**Context.** The owner wants a physical program downloaded as an `.exe` that holds everything app-related, and a website limited to payments, subscriptions, auto-director hours usage, account management and staff management.
**Decision.** The Electron program bundles the operator console and shows it from its own privileged `app://matchframe` scheme; the main process forwards `/api` and `/assets` requests to the engine (only an allowlist of headers; Chromium refuses forwarded `Origin`/`Host`). The engine no longer serves the console: its HTTP address serves the API (program, control surfaces), a separate captain veto page build for scoped captain links, and — on the overlay port — HUD outputs for OBS browser sources. Remote operator positions use the same program in remote mode (address + role token, stored encrypted) instead of a browser. The installer is built and smoke-tested on a Windows CI runner and distributed from the website (`MF_DOWNLOAD_DIR` or an external URL) and attached to published GitHub releases.
**Consequences.** One supported way to operate (the program); captains and OBS still use plain URLs by design; the website contains no app features. Development uses `pnpm dev` (launches the program) or the Vite dev server with a pasted token.

## ADR-019 — The auto director is the Observer, with four modes; nade cameras are a plan feature
**Context.** The owner defines the auto director as the "Observer" with four modes — Off, Observer, Observer & Cinematics, Full Action Observer (nade cameras, cinematics and observing) — and Full Action Observer only on the top plan.
**Decision.** `ObserverMode` (contracts) maps each mode to the action classes automation may take on its own: Observer = POV cuts; Observer & Cinematics = POV cuts + `cinematic` static shots; Full Action Observer = those + `utility_camera` (nade cameras, the existing utility-camera shots). Off is the advisory editorial mode. Shots outside the mode are invalid candidates (`OBSERVER_MODE_EXCLUDES`), so the planner picks among allowed shots, and utility is then shown from a POV as if no camera covered it. New non-utility cinematics come only from validated cameras with the matching action class: an establishing shot in freeze time (more than 3 s left; it does not use the round's cinematic budget), the bomb camera during a defuse or the last 10 s of the bomb timer, and a fight overview for a likely fight with at least three players from both sides. The plan feature `fullActionObserver` (Studio by default; older catalogues filled in on start) travels in the licence; the program refuses Full Action Observer when arming or choosing it while armed (HTTP 402), allows it in the simulation, and when a plan loses the feature mid-map it switches to Observer & Cinematics at the map change. All modes except Off meter hours at the same rate. The editorial API (`/api/v1/director/mode`) stays for compatibility.
**Consequences.** Observer & Cinematics needs cameras tagged `establishing`, `bomb` or `tactical` in the map pack; nade cameras use cameras tagged `utility`. Like all static shots they stay blocked until the static camera test passes on a real client (unverified here). The assisted-actions setting is no longer in the console.

## ADR-018 — The program signs in with the website account and requires it to open
**Context.** The owner wants the program to have its own email-and-password sign-in, the same account as the website, required before the program can be used.
**Decision.** `POST /v1/device/login` checks the website's email and password (same scrypt hash, rate limits shared with the website sign-in, disabled accounts refused, confirmed email required), asks which organisation when there are several, checks the role and the plan's computer limit, and issues the same per-computer credential as the device-code flow (kept as "sign in with a code"). The password passes through the local engine to the pinned website once and is never stored. The licence names the signed-in person. Computers are signed out when the person's password is changed or reset, the account is disabled, staff sign them out everywhere, or they leave the organisation. Release builds open on a sign-in screen; the program is usable while signed in with a valid or offline-grace licence (7 days). The gate applies when the program opens: being signed out during a session only shows a notice, so a broadcast is never interrupted, and the next start asks to sign in. Remote operator positions use the production computer's sign-in. CI pins each build to the live website's address and licence keys.
**Consequences.** Every production computer needs an account and a computer slot on the plan; LAN events without internet work for 7 days after the last check. The sign-in gate is in the program's console (the engine keeps serving HUD outputs and the captain page), so like the licence it is a licensing control, not DRM. Development builds skip it (`MATCHFRAME_SIGN_IN=off`, the default for `pnpm dev`).

## ADR-020 — HUD Library and desktop HUD outputs
**Context.** The owner wants a HUD-manager layout (inspired by Lexogrine HUD Manager) that opens into a library of HUDs stored on the computer, runs them as a transparent click-through desktop window over a borderless game, as a preview and as an OBS browser source, and works offline without an account.
**Decision.** See `docs/architecture/hud-library.md`. HUDs are copied into the per-user data folder (`%APPDATA%\Matchframe Esports\huds\<id>\<version>`), with library metadata and per-HUD settings in the engine database. The engine's HUD server serves one output page per HUD and variant (`/hud/<id>/<variant>?t=`), a trusted transparent wrapper that scales the HUD frame uniformly from its design resolution and follows a control socket (stop, global hide, reload). All outputs subscribe to the same processed state. The program opens each desktop HUD in an independent transparent, frameless, always-on-top, non-focusable, click-through window with no preload, and adds preview windows, hotkeys and a tray.
**Consequences.** Desktop HUDs target borderless windowed games; exclusive fullscreen is out of scope. Real-pixel transparency, click-through and focus are checked on the Windows runner; real CS2, real OBS and multi-monitor/mixed-DPI placement remain manual checks.

## ADR-021 — Signing in is optional; the Auto Director needs an account (supersedes the gate in ADR-018)
**Context.** The owner's HUD Library requirements say the core library and runtime must work without internet access or an account, which conflicts with ADR-018's sign-in screen at start.
**Decision.** The program opens straight into the HUD Library. Signing in moves to Settings → Account (same email-and-password and code flows, same licence, offline grace and computer limit). Without an account everything works except automatic direction on live matches (the Observer modes), which the existing arming gate already refuses with "sign in" (HTTP 402); the simulation stays free. Being signed out on the website mid-session still only shows a notice. `MATCHFRAME_SIGN_IN` remains for the engine's sign-in state but no longer gates the console.
**Consequences.** Computers count towards the plan's computer limit only when signed in. Licensing still controls the paid feature (auto-director hours), not HUDs.

## ADR-022 — Built-in minimaps and an estimated GSI killfeed in every HUD
**Context.** Only four maps had generated outlines, so the minimap was missing on Mirage, Dust II, Nuke, Train and Vertigo, and the killfeed showed deaths without killers or weapons. CS2 game state integration reports no kill events; every GSI HUD (Lexogrine's template included) pairs kills from counter changes.
**Decision.** (1) `assets/radars` ships Lexogrine's MIT radar drawings for eight maps with their calibration (they match the game's overview files to a few pixels); the engine uses an operator-calibrated image first, then the built-in image, then the generated outline (Anubis). Nuke and Vertigo choose the upper or lower drawing by height. (2) The state package pairs one killer whose kill counter rose by N with N opposite-side deaths in the same update, carrying the killer's weapon in hand (unknown when holding a grenade), the headshot counter, a single same-side assister and whether the killer was flashed. These stay labelled estimates (`probable_kill_link`, evidence "estimated"; HUD kind `"probable"`); several killers in one update stay unpaired, and an unpaired death shows no killer. Wallbang, no-scope, through-smoke and flash assists are not in GSI and are not shown. (3) Every bundled HUD draws a minimap and killfeed in its own style; HUDs present probable kills like any GSI killfeed, without a per-row mark.
**Consequences.** Minimaps work on all active-duty maps without operator setup. A grenade or fire kill may show the killer's gun; the HUD state keeps `kind` and the docs say how kills are derived.

## ADR-023 — Import LHM-format HUDs and run them in an LHM compatibility layer
**Context.** Many CS2 HUDs (the owner's kaiHUD among them) are built for Lexogrine HUD Manager on Lexogrine's MIT HUD template: a folder with `hud.json`, `index.html` and often `panel.json`. They don't use the Matchframe HUD SDK. Instead they open socket.io on their own origin and expect LHM's events and `/api` paths. LHM itself is proprietary (ADR-013), so nothing of the manager can be reused.
**Decision.** (1) The HUD Library accepts a package with `hud.json` and `index.html` and no `manifest.json`, writes a manifest for it (id `lhm.<name>`, category "LHM", `runtime: "lhm"`, the live variant only) and turns `panel.json` into the HUD's settings form: text, checkbox, colour and select become settings; player and team inputs get pickers (`HudSettingField` types `player` and `team`, stored as ids); action inputs become buttons (`action`, never stored) sent with `POST /api/v1/hud/library/:id/action`. Image inputs and `keybinds.json` are not supported, and the import keeps going without them. Other games' LHM HUDs are refused. (2) The HUD server implements the HUD side of the template protocol, written from Lexogrine's MIT templates. socket.io on `/socket.io`: `readyToRegister` → `register` → `hud_config` (the settings in panel shape, sent again when settings change), `update` (every authenticated game-data packet as CS2 sent it, auth removed; the simulation's packets while it runs), `hud_action`, `match` (the current match changed) and `update_mirv` (Matchframe's paired kills from ADR-022 as HLAE `player_death` events, because the template's killfeed listens only to those). `GET /api/...` serves the current match, teams with logos, players with photos and the built-in radars in LHM's shapes; tournaments and player cameras answer empty. (3) The output page sets an HttpOnly SameSite=Strict cookie with the HUD's token, because an LHM HUD only adds `isProd=1` to its own URL and can't send the token itself. The socket and `/api` require that cookie. (4) LHM HUD files may load Google Fonts; nothing else is relaxed in the CSP. The output page shows a "TEST DATA" badge over LHM HUDs during the simulation, because they don't draw Matchframe's label.
**Consequences.** LHM-format HUDs import and run like any library HUD (desktop window, preview, OBS URL, settings applied live), with no LHM install or account. They show live data only, with no output delay. Their killfeed carries the ADR-022 estimates (no wallbang, no-scope, smoke or flash-assist icons), and kills made before the HUD connected are not replayed. Team names and logos come from the current match in Matchframe. A HUD that depends on other LHM features (cameras, image inputs, keybinds, ACOs, the LHM cloud) loses those parts.

## ADR-024 — Built-in cameras from navigation meshes, console control that confirms itself, and a one-button Auto Director
**Context.** Cinematics needed operator-captured, validated cameras on every map, and console control stayed "unverified" until separate setup tests passed. Some of those tests could never pass on CS2: `spec_player_by_accountid` doesn't exist, the static camera test needed a person to confirm what they saw, and camera paths were unsupported. The owner asked for cameras and paths on every active-duty map and an auto director that works from one button.
**Decision.** (1) **Built-in cameras.** `scripts/generate-map-cameras.py` places cameras and freeze-time paths for the nine active-duty maps from the maps' navigation meshes (awpy 1.3.1 `nav_info.csv`, MIT, CS:GO geometry). Positions are kept only where they agree with CS2 data: on the CS2 radar's drawn area; on the CS2 demo-derived region cells where a pack has them (at least half of a place's cells); with a sight line over continuous walkable floor, no walkable surface within 35 units of the line, and headroom under upper floors. Cameras sit 140 units above the floor, 350 to 1000 units from the target (650 preferred), spread at least 70° apart around each site. Paths are orbits (15° sectors, up to 8 links, at least 3 s) and push-ins (6 s). Records carry `capturedFrom: "derived_navmesh"` (paths `source: "derived_navmesh"`). The map runtime uses them without validation while `builtInCameras` is on (setting `cameras.builtIn`, default on); an invalidated camera is never used. Existing packs keep their CS2 regions and floor grid; navmesh regions fill only the places they lack. (2) **Self-confirming console control.** The Direct adapter records evidence per CS2 build when the game itself confirms an action. Player selection is confirmed when the game data shows the requested player (any manual or automatic request). A static camera is confirmed when `getpos` returns the camera's pose; this also confirms readback, and observer mode as `partial`. If the CS:GO `spec_mode` numbering doesn't move the camera, the adapter tries CS2's enum numbering (2/3/4) and keeps whichever works. Camera paths stream `spec_goto` at 60 Hz and are `partial` once static cameras are confirmed, then `supported` when `getpos` confirms the end of the first path. Player selection sends the in-eye mode first when the camera is free; if the game data still shows the free camera afterwards, the adapter tries the other numbering's in-eye command once and keeps it when the player shows. (3) **Freeze-time paths.** Observer & Cinematics flies one path per round, rotating by round number, when it fits in the time left plus 1.5 s. Paths and establishing shots don't use the round's cinematic budget. (4) **Auto Director.** `AutoDirector` (engine) runs the checks in order and fixes what it can: console (switches the launch mode to Tools, selects the Direct adapter on Start CS2's console, sends `spec_autodirector 0`), game data, the account gate (at Start only, so a running match is never cut off; nade cams fall back to cinematic cameras without the plan), a real player switch, and a real camera (with a `cl_demo_freecam 0` retry for demo playback). It then arms the richest mode that works. It takes the camera back a set time after a person picks a shot (default 8 s), and right after data gaps or session restarts; after Take over it waits for Resume automation or Start. Emergency stop, Off, or the hours ending at a map change stop it. API: `GET /api/v1/director/auto`, `POST .../auto/start`, `POST .../auto/stop`, `PUT .../auto/settings`. (5) Manual player and camera requests are allowed while control is unverified, because the request itself is the check.
**Consequences.** Cinematic cameras and paths work on every active-duty map without authoring, and a fresh install reaches automatic direction with one click once CS2 runs with its console. The built-in cameras were placed from map data and were not checked by eye in CS2. A camera can still clip a prop that the navigation mesh doesn't describe, so they can be switched off, and each can be invalidated. Train lacks a CT spawn camera, Vertigo a T spawn camera, and Overpass and Nuke a mid camera. Demo playback depends on the `cl_demo_freecam 0` workaround for Valve issue #4660. Supersedes "cinematics come only from validated cameras" in ADR-019.
**Revisit if.** CS2 ships navigation data or an official observer camera API, or operators report built-in cameras that look bad on air.

## ADR-025 — Built-in cameras placed on CS2's navigation meshes and checked against CS2's collision geometry (amends ADR-024 (1))
**Context.** The 0.4.0 cameras came from CS:GO-era navigation data, checked only against the CS2 radar and demo positions. Tested against CS2's collision geometry, 30 of the 92 cameras either looked through a wall at their target or sat inside geometry, and 3 of the 32 paths crossed a wall. The owner supplied the awpy-data release for the current build (CS2 1.41.9.2, build 26144732): CS2's navigation meshes and collision meshes for every map.
**Decision.** `scripts/generate-map-cameras.py` rebuilds the built-in cameras and paths from that data with awpy 3.1.1 (`NavMesh`, `VisibilityChecker`):
- **Areas:** each bombsite, the mid area (or the map's equivalent: Nuke Outside, Train and Overpass Connector) and each spawn.
- **Target points:** the region's cells dropped onto CS2's walkable floor at chest height.
- **Camera spots:** walkable floor 300 to 1100 units away, with the camera 140, 200 or 260 units up. A spot is kept only when all of these hold in the collision geometry:
  - the floor below it is clear;
  - it has 24 units of clear space on every side;
  - it sees the area's centre;
  - it sees at least 50 % of the target points (45 % mid, 40 % spawns);
  - at least 55 % of a 9 × 5 grid of view rays run 220 units without a hit (45 % for narrow areas).
- **Aim and choice:** each camera aims at the middle of what it sees of the area. Two or three spots are chosen far apart in angle.
- **Paths:** each area gets moving shots:
  - an orbit through neighbouring spots, at most 10 s;
  - a 6 s push-in;
  - a 6 s sideways drift where there is no orbit.

  The exact Catmull-Rom curve the console adapter flies is checked every 24 units for clearance and a view of the centre.
- **Records:** cameras get ids `cs2-<map>-<region>-<n>` (new ids, so operator overrides made for the old positions don't apply to them) and `occlusionValidation: "validated"`. Paths get `collisionValidated: true`. `validation` stays `unvalidated` until someone looks.
- **Old generator:** renamed `scripts/generate-map-regions-csgo-nav.py`. It still describes how the regions of the navmesh-built packs were made.
- **Data:** the meshes are Valve's assets and are not committed; only derived poses and paths are.

**Consequences.** All 104 cameras and 81 paths pass the geometry checks, against 62 of 92 before.

The earlier gaps are filled:
- Train CT spawn and Vertigo T spawn now have cameras.
- Nuke, Train and Overpass now have a mid stand-in.

What remains:
- **Gaps:** Overpass CT spawn has no named area in any of the data, and Dust II CT spawn has no path.
- **Not seen in game:** collision geometry leaves out see-through and non-solid props, and nothing was seen by eye.
- **Regenerating:** needs the awpy-data release for the new build.

**Revisit if.** A CS2 update changes a map: regenerate from the new awpy-data release and compare.

## ADR-026 — Cameras for every named area, and a chase view for plants, defuses and round wins (extends ADR-025)
**Context.** The 0.4.2 cameras covered only the bombsites, mid and spawns, so a fight or a grenade anywhere else had no camera, and big-fight overviews and nade cams went unused for most of a round. Every POV was first person. The owner asked for cameras on the remaining areas and for a third-person chase cam.
**Decision.**
- **Area cameras.** `scripts/generate-map-cameras.py` also films every other named region of each pack, with the ADR-025 placement and checks. Each area gets two cameras: at least 45 % of the area in view, with the narrow-area openness fallback (45 %) when two spots don't pass at 55 %. They carry `actionClasses: ["tactical", "utility"]` and `allowedPhases: ["live", "over"]`, and have no paths: paths fly in freeze time, where the sites, mid and spawns are the story. An area where no spot passes gets no camera.
- **Chase view (adapter).** `ObserverControlAdapter.selectPlayer` takes an optional `view` (`"in_eye"` or `"chase"`), and `supportsChase` says whether the adapter can show it. The arbiter's `select_player` request carries the view; confirmation is unchanged (the game data shows the player).
  - **Commands:** the console adapter sends the chase command after `spec_player`, and the in-eye command before it when leaving the chase view or the free camera.
  - **Evidence:** the game data now gives the adapter the spectated player's position. After the first chase shot, `getpos` must put the camera at least 40 units across from the player; in first person it is about 0. This records `observerModeControl: supported`. If the camera stayed in first person, the adapter tries the other numbering's chase command once (`spec_mode 3` or `5`), keeps it when `getpos` agrees, and otherwise restores the original command.
- **Chase view (director).** `chaseMoment(state)` (director-policy) is `BOMB_PLANT` for the planter, `BOMB_DEFUSE` for the defuser (the reported player, or a CT within 120 units of the bomb while it is being defused), and `ROUND_WON` for an alive player of the team that won the round that just ended. Otherwise it is null, so gunfights stay in first person.
  - **When it switches:** the live session asks for the chase view on the player already shown, and for first person once the moment ends. It does so only when the director made no cut of its own, the director is automatic and owns the camera, no command is in flight and no cinematic is on.
  - **Limits:** each view is held at least 1.5 s, and a failed switch waits 5 s before the next.
  - **Setting:** settings `autoDirector.chase` (default on).
  - **By hand:** an operator gets the view with `view: "chase"` on `POST /api/v1/observer/commands` (Shift-click or Shift + number key in Live Control).

**Consequences.**
- **Cameras:** 391 cameras (287 new) cover 200 of the 227 named areas. Big-fight overviews and nade cams have a camera almost anywhere a round is played. 27 small or enclosed areas (tunnels, ladders, small rooms) have none.
- **Chase view:** plants, defuses and round wins get a broadcast-style third-person shot without operator input.
- **Not yet seen in a real CS2:** which `spec_mode` number is the chase view on the current build. The adapter learns it from `getpos`.

**Revisit if.** Operators find the chase view distracting at round end, a CS2 update changes `spec_mode`, or an area camera looks bad on air (invalidate it).

## ADR-027 — A replay PC that films what the main camera misses, and automatic replays between rounds
**Context.** One observer can show one player. Kills elsewhere were never seen, and replays needed an operator to bookmark, approve and play each clip. The owner runs two computers and asked for the second one to catch the kills the main observer misses and replay them automatically.
**Decision.**
- **Two programs, linked over the network.** The main PC's engine can listen on the network: the program's network access switch sets `MATCHFRAME_HOST=0.0.0.0`, and access still needs a token. The replay PC links to it with the main PC's address and a replay PC code (a `replay` role token).
- **Avoiding the main player.** The replay PC asks `GET /api/v1/replay-link/on-air` every 250 ms. Its director then takes 0.8 off that player's score for 1.5 s (director `avoid` control, reason `MAIN_OBSERVER_ON_IT`), so it films the other side of the same fight or another fight.
- **Which kills count.** A kill counts when the replay PC's camera had the killer in the 1.5 s before it. It is *missed* when the main camera showed neither player in the 2.5 s before it, and *another angle* when it showed only the victim. Kills the main camera showed are not sent.
- **Sending a clip.** 2 s after the kill (later if the same player kills again within 4 s, up to 12 s), the replay PC saves its OBS replay buffer. It uploads the clip to `POST /api/v1/replays/incoming` with what it shows and how much of its end to play. It starts its OBS replay buffer itself.
- **Automatic replays on the main PC** (`replay/auto.ts`, setting `replay.auto`, off by default):
  - **When:** in the break after the round the clips belong to, from 3.5 s after the round ends until 1.5 s before freeze time ends. They never play while a round is live, stop at once if it goes live, and never play over the operator's program choice.
  - **Order:** a won clutch (4), 3K+ (3), missed (2), other angle (1); N per break (default 2).
  - **Playback:** at the chosen speed (the media source's speed setting), seeking to the clip's end part, and back to the live scene when OBS reports the clip ended.
  - **Big plays shown live:** with *Replay big plays shown live*, the main PC saves its own replay buffer for 3K+ and won 1v2+ clutches the main camera showed.
- **One-click replay scene:** `POST /api/v1/replays/obs-setup` makes the replay scene with its media source and maps it. Clips from the replay PC are kept in `data/replays` (newest 120), and the queue deletes their files when they drop off.

**Consequences.** Kills away from the main camera reach the broadcast as replays without an operator. The replay PC needs its own CS2 spectating the same match at the same delay, and its own OBS with a Game Capture.
- **Checked:** two engines with a stand-in OBS, and against a real OBS under Xvfb.
- **Not checked yet:** two real CS2 clients on two computers over a real network.

**Revisit if.** A dedicated replay tool (bridge provider) is used instead, or GOTV delays differ between the two computers enough to misjudge "missed".

## ADR-028 — Free-space grids from CS2's collision meshes: sightlines, follow cams; clutch mode
**Context.** The director guessed contact from distance and facing only (no geometry at run time; the meshes are Valve's assets and are not shipped). The owner asked for cuts before the fight, a follow camera and a clutch mode.
**Decision.**
- **Grids:**
  - **Content:** `scripts/generate-map-grids.py` derives `assets/map-packs/<map>.grid` for the nine maps from the awpy-data meshes of CS2 build 26144732. A cell is 12 units, over the navigation mesh's extent plus a margin, and is solid when a collision triangle passes through it (points sampled a quarter cell apart).
  - **Size:** 80–260 KB per map, 1.5 MB in all.
  - **Sightline test:** clear eye to eye, or 8 units higher, with no solid cell along it (one cell skipped at each end).
  - **Accuracy:** checked against the exact mesh test on 1,500 sightlines per map, it misses 5–13 % of the clear ones and saw through a wall at most once in ~1,350. Coarser 32-unit cells missed 30 %. A grazing tolerance saw through floors on Nuke, so it was dropped.
  - **Loading:** `VisibilityGrid` in map-runtime; the engine loads the grids with the packs.
- **Fights before they start:** `computePair` records whether the two see each other now, or in 0.4–1.6 s at their current speed.
  - **In sight now:** contact rises as 1 − exp(−(1.2 + 2.4·looking)·h).
  - **A sightline opening soon:** at least 0.8 from that horizon on.
  - **Walls and nothing opening:** it falls (×0.35 within 1 s, ×0.65 after).
- **Follow cams:**
  - **Shot and when:** a new shot `follow:<steamId>` (ShotClass `follow_cam`, a cinematic), for a player running at 160+ u/s with contact within 2 s at or under 0.2. A player view held 5 s gets a variety bonus. It lasts 4.5 s and is interrupted like any cinematic.
  - **Control:** the arbiter's `stream_camera` request makes the adapter fly the free camera along poses computed live (`streamCamera`). The console adapter sends `spec_goto` at 60 Hz.
  - **Pose:** the engine's `FollowCam` puts the camera behind, above and over the shoulder of the player's direction of travel, at the first offset with 14 units of room and a clear line to their eyes in the grid. It is smoothed, never smoothed into a wall, and ends when the player dies or nowhere works.
  - **Setting:** `autoDirector.followCams` (default on, with cinematic cameras).
- **Clutch mode:**
  - **Scoring:** in a 1vX the clutcher's candidate gets +0.45 and opponents −0.25.
  - **Cameras:** the cinematics gate answers `CLUTCH`.
  - **Chase lead-up:** `chaseMoment` gives `CLUTCH_LEADUP` while no opponent is within 1800 units (exit at 1400).
  - **Replay:** a won 1v2+ is replayed first.
  - **Setting:** `autoDirector.clutch` (default on).

**Consequences.**
- **Better cuts:** the director cuts to fights before they start, and no longer over-weights players separated by walls.
- **Follow cams:** they work on every active-duty map.
- **What the grid can't see:** see-through and non-solid props (glass, fences, foliage) are not in collision geometry, so not in the grid either.
- **Updates:** a CS2 map update needs the grids regenerated, like the cameras.

**Revisit if.** A CS2 update changes a map, or a follow cam is seen clipping a prop the collision mesh lacks.

## ADR-029 — HUD graphics timed to the shots, OBS scene automation, and LHM HUD pages
**Context.** Graphics were operator cues or disabled example rules, and OBS scenes changed only by hand. The owner asked for graphics timed to the shots and OBS automation, and for kaiHUD's Player Highlight and Match stats panels to work.
**Decision.**
- **Graphics director** (`live/graphics.ts`, setting `graphics.auto`, on). It runs while the director has the camera:
  - **Freeze time:** the economy cue, then CS2's round MVP (whose MVP count went up).
  - **Player card:** after a player view held 6 s with no fight close. Only on a player view, removed when the view changes; 90 s cooldown per player, 25 s overall.
  - **Clutch:** a banner until the 1v2+ ends.
  - **LHM HUD pages:** shown by toggling their OBS browser sources. Player stats goes up for the MVP (after selecting the player in the HUD's settings), and never over another player's view, because kaiHUD shows the selected or the spectated player. Match stats goes up at half time and at the end of the map.
- **OBS automation** (`live/obs-auto.ts`, setting `obs.auto`):
  - **Scenes:** timeouts and pauses go to the BREAK scene, and map end to the STUDIO scene. Both go back when play resumes or the next map starts.
  - **Ownership:** only from the live scene, and only back from a scene it chose.
  - **Replays:** cut with a chosen OBS transition, and the previous one is restored after.
- **LHM HUD pages:**
  - **Pages:** hud.json `variants` are read at run time and offered as the HUD's pages, opened with `?view=<page>` (the HUD reads `variant`).
  - **Logos:** team logos are sent as an address that serves the image, which kaiHUD uses directly.
  - **Image inputs:** a new `images` settings field, sent as base64 like LHM.
  - **Settings form:** an LHM HUD's form is read from its panel.json again, so already-installed HUDs get it.

**Consequences.** Freeze time, clutches, long holds, timeouts and map ends get their graphics and scenes without an operator. Matchframe HUDs draw the cues, and LHM HUDs get their pages through OBS. kaiHUD 1.0.2 was checked page by page in a browser against test data.

**Revisit if.** Operators want different timings, or an LHM HUD's page needs a data source the layer lacks.

## ADR-030 — Replay PC timing: behind the main PC, or rewinding to get there
**Context.** In 0.5.0 the replay PC watches the game at the same time as the main PC. It can only send a missed kill its own camera happened to have. The owner asked for the replay PC to stay about 7 s behind the main PC. If that isn't possible, it should go back 4–7 s on the same CSTV when a kill is missed, film it, and come back to live.

**What CS2 offers.** These facts come from CS2's console variable and command dump (SteamDatabase GameTracking-CS2, `DumpSource2/convars.txt` and `commands.txt`) and the engine's strings:
- **A second CSTV with its own delay:** `tv_enable1`, `tv_delay1` (default 15 s) and `tv_port1` (default 27021).
- **No rewind on a CSTV connection:** CS2 can't rewind a CSTV connection (`connect ip:port`). The instant-replay commands are development-only.
- **Possible rewind on CSTV+:** a CSTV+ stream (`playcast <url>`) is played by the broadcast player. That player has `SkipToTick`, a fragment cache (`tv_playcast_fragment_cache_history_length`) and `/sync?fragment=N`. `demo_goto <tick> [relative] [pause]` may therefore move it back. No public source confirms this.
- **Refusal message:** demo commands outside playback print "Not currently playing back a demo".

**Decision.**
- **The main PC reports more** (`replay/onair.ts`). `GET /api/v1/replay-link/on-air` adds:
  - its round clock: phase, seconds left, and the age of that reading;
  - its kills of the last 30 s, each judged with its exact camera history: killer shown, victim only, or neither in the 2.5 s before.
- **Measuring the delay** (`replay/timing.ts`):
  - **Clock matching:** the replay PC matches each of its own round-clock readings to the moment the main PC had the same reading. The main PC's readings are interpolated and corrected for half the round trip and the reading's age.
  - **Kill matching:** kills seen on both PCs count too, twice each.
  - **The answer:** the median over 20 s, given only when the interquartile range is ≤ 0.8 s.
  - **Jumps:** a jump in the replay PC's own clock (more than 1 s off) clears its readings, so a rewind or skip is measured again at once.
- **Behind (≥ 2.5 s)** (`replay/link.ts`):
  - **Planning:** every main-PC kill not shown from the killer becomes a planned capture at its time on the replay PC (main time + delay).
  - **Filming:** the director is pinned to the killer from preroll + 0.6 s before the kill until postroll after it.
  - **Confirming:** the kill is confirmed from the replay PC's own game data. A victim going alive → dead counts, so a replayed death counts too; the killfeed would de-duplicate it.
  - **Sending:** the clip is sent only if the camera stayed on the killer from before the kill.
  - **One camera:** of two kills that can't both be filmed, the better one is kept (more kills, then missed over another angle). A set-aside kill comes back when the same player's next kill makes it a multi-kill, and that can replace a kill being filmed, as long as that kill hasn't happened yet.
- **Live:**
  - **Same-time path:** it stays, but the main PC's own verdict for the kill now decides when it reports one.
  - **Rewinding (setting `replayPc.rewind`, off by default):** on a missed kill this camera didn't have, it sends `demo_gototick -N 1` with N = time since the kill + preroll + 1.5 s (3–12 s). Success means the measured delay becomes ≥ 2.5 s within 4 s. The kill is then filmed as above, and `demo_gototick +N 1` returns to live once nothing is planned.
  - **Unsupported:** a refusal from the console, or no jump, marks rewinding unsupported for the session, and the PC films someone else as before.
- **Ahead:** treated as live, and the panel says the replay PC should be the later one.

**Consequences.**
- **Second CSTV ~7 s later:** this setup, or the main PC in the server with the replay PC on CSTV, catches every missed kill the one camera can film, with its lead-up. The clips reach the main PC a few seconds after the kill, still within the replay break.
- **Rewinding** is experimental until checked on a real CSTV+ stream.

**Checked.**
- **Unit tests:** the delay measurement (behind, same time, ahead, paused clock, other round, a rewind and a skip, kills only, disagreement).
- **Two-engine e2e:**
  - 3 s behind: pinned before the kill, clip sent;
  - a single kill and a 2K at once: the 2K is filmed, even after starting on the single;
  - rewinding with a stand-in console: back, filmed, forward to live;
  - a console that refuses: unsupported.
- **Real OBS:** the replay PC flow still passes.

**Revisit if.**
- **Real CSTV+:** a real CSTV+ stream shows `demo_gototick` doesn't seek backwards.
- **Pause instead:** pausing (`demo_pause`) a CSTV+ stream proves a simpler way to fall behind.
- **Delay limit:** operators need delays over two minutes.

**Update (0.5.2).**
- **Going back works on CSTV:** the owner confirmed that on a live CSTV connection `demo_gototick -448` goes back 7 s (64 ticks a second), without the relative argument. ADR-030's statement that CS2 can't rewind a CSTV connection was wrong. The refusal ("Not currently playing back a demo") is now taken to mean a direct game-server connection.
- **The command:** going back is now sent exactly as confirmed: `demo_gototick -N`.
- **Replay PC choice** (`replayPc.sameCstv`; `replayPc.behindMs`, 7 s by default): when PC 2 is at the same time as PC 1, or ahead of it:
  - `stay_behind` (the default): CS2 goes back once, to `behindMs` behind PC 1, and keeps playing from there. PC 2 then works behind. If a reconnect or map change brings it back to PC 1's time, it goes back again after 5 s.
  - `each_kill`: 0.5.1's per-kill rewind. Skipping forward with `demo_gototick N 1` isn't confirmed; if CS2 stays behind, PC 2 keeps working behind.
  - `off`: no going back.
- **Migration:** a stored 0.5.1 `rewind: true` becomes `each_kill`.
- **Measuring across a jump:** after going back, PC 2's round clock reads moments the main PC reported before PC 2 was linked, so the clocks can't be matched for a few seconds. The estimator now carries the delay across a jump in PC 2's own clock (delay before + jump) until readings match again. Without this, going back right after linking was wrongly judged to have failed.

**Update (0.5.3).** The owner gave the relative forms in use: `demo_gototick -448 relative` goes back 448 ticks (about 7 s) from the current playback position, and `demo_gototick 448 relative` goes forward 448 ticks. Both are now sent in exactly that form: back for staying behind and for each missed kill, forward to return to live. 0.5.1/0.5.2 sent the forward skip with `1` instead of `relative`.

## ADR-031 — Cinematics that hold, lighter LHM updates, and match graphics made by the program

**Context.** After 0.5.3 the owner reported, on a real match:
- pre-round cinematics about 1 s long that repeat (a Mirage van shot played five times);
- the camera not going back to the players once the round is live;
- follow cams choppy and not handing back;
- few nade cams;
- pre-round shots of empty spawns;
- kaiHUD's baseboard laggy enough to ruin a production.

They also asked for a visible way to create matches, and for thumbnails and stinger transitions made for every match from the two teams' logos, similar to but not copies of the reference thumbnails.

**Decision (director).**
- **A cinematic's lifecycle** (`planner.ts`): each shot has its own maximum (`maxMs`). A shot is noted in `shownThisRound` when it starts *or* when it fails, and is never sent again in that round. Re-starting the shot already on air does nothing.
- **Noting before sending** (`session.ts`): the session notes a cinematic before submitting it, bound to its command id by the arbiter's synchronous `command` event. Whichever confirmation comes first (getpos during the readback, or the game data) starts it. Before this, a camera confirmed during the readback was never noted, and the director sent it again on every evaluation: the repeating 1 s shot.
- **Freeze time** (`cinematics.ts`, `establishingCandidates`):
  - candidates are the spawn cameras and paths with at least two players in their target regions or in sight within 2600 units;
  - at most two a round (`establishingPerRound`), the second preferring the other side;
  - each played in full, up to 7 s (`establishingMaxMs`);
  - only with the time left to play it.
- **Live start:** for the first 10 s live (`liveStartPovMs`) there are no fight overviews or follow cams. Establishing shots stop being candidates at live, so the director cuts to a player.
- **Follow cams:** at most one per map (`followPerMap`), held their planned 4.5 s. Poses are streamed with a 1 ms timer loop sending every 1000/64 − 1 ms, with player positions carried forward at their velocity for up to 200 ms between game-data updates.
- **Nade cams:** on by default; the threshold drops to 0.28 (×0.8 for coordinated utility).
- **Game data lags the console** (found by the two-round e2e test under load, then made deterministic with a stand-in CS2 whose game data is 250 ms behind its console):
  - for the first 600 ms of a cinematic (`CINEMATIC_SETTLE_MS`), a player's view in the game data is data from before the cut and doesn't end the shot (without this, the spawn camera was dropped after 0.4 s);
  - every confirmation, not only one from the game data, starts the arbiter's 400 ms feedback grace;
  - the game data catching up with the last confirmed command's shot is never an external change (without this, a getpos-confirmed camera turned into a manual takeover, and the Auto Director came back 1 s later on another shot);
  - repeated director output for unchanged game data carries no intent (it re-sent the same camera, which restarts a path on air).

**Decision (LHM HUDs).** `lhm-runtime.ts` sends the newest game data at most every 100 ms. An "urgent" change is sent at once: the spectated player, round or countdown phase, bomb state, alive players, map round/phase or score. CS2 sends up to 50 packets a second, and kaiHUD re-renders on each. Measured with kaiHUD's baseboard on a timeout:
- before: 50 updates a second and 25 % busy; at a sixth of the CPU's speed, 32 fps;
- after: 10 updates a second and 10 % busy; at a sixth of the CPU's speed, 55 fps.

**Decision (matches).** A Create match button whenever the form isn't open. The team pickers have **New team…**: the team is created with the match, once, so a match can be made from nothing.

**Decision (match graphics).**
- **Where they're made:** in the program's window (canvas), not in the engine. Node has no canvas; a native one would complicate the Windows build. The engine stores, serves and checks the files (`domain/match-art.ts`), in `<data>/graphics/<match id>/`.
- **When:** on create, on **Make again**, and on first opening the tab of a match made elsewhere.
- **What:** three 1280×720 thumbnails (Highlights, Full replay, Live), a 1920×1080 Up next card, and two 1920×1080 60 fps stingers.
  - **Designs:** original Matchframe designs — team-colour halves, slanted logo cards with name bars, *VS*, a two-tone outlined headline in Barlow Condensed (OFL, already bundled for the HUD renderer).
  - **Logos:** a "?" hexagon for a team without a logo, and a plate behind a logo whose average colour is near its card's.
  - **Background:** optionally a picture (uploaded, or OBS's program frame).
- **Stingers with alpha:**
  - OBS's Stinger plays the video's own alpha (its track matte only blends the two scenes), so the file needs real alpha.
  - Each frame is the canvas's own PNG export, stored in a QuickTime file (`lib/match-art/mov.ts`: one `png ` track, 32-bit depth, 60 fps). FFmpeg, which OBS uses for stingers, plays it with its alpha. No video encoder is involved.
  - The design is flat (solid team colours, flat bands instead of gradients and stripes), so the 96 PNG frames are about 15 MB per stinger; with gradients they were 75 MB.
  - **First tried:** WebCodecs VP8, encoding each frame twice (colour, and alpha as a grey picture) into one WebM with BlockAdditions. It worked in Chromium on Linux, but on the Windows build machine (no usable GPU) the encoder stalled after about 10 frames, every time, after several fixes (no timer throttling, software encoding, CPU canvases). PNG export needs nothing the machine may lack.
  - The engine accepts only PNG and QuickTime-of-PNG files, and serves a stinger's frame at the cut as `<file>.png` for the previews.
- **Stinger timing:**
  - OBS times a stinger from the transition start, with duration = video length + 250 ms, and cuts at a fixed fraction of it, but the video starts a little late (by ~0.2–0.6 s on a loaded machine).
  - So the screen is covered 0.4–1.0 s and the cut is at 0.9 s, late in the covered part: safe for up to ~0.5 s of lateness.
  - The animation ends by 1.3 s, leaving a see-through tail that OBS may cut short.
- **OBS:**
  - obs-websocket v5 can't create transitions. The operator creates two Stinger transitions once, named `Matchframe Stinger` and `Matchframe Replay Stinger`.
  - Matchframe sets their `path`, `transition_point` (900) and `tp_type` (time) by making each current, setting it, reading it back, and restoring the previous one. The replay one becomes the replay transition if none is chosen. Activating a match points them at its files.
  - OBS applies `SetCurrentSceneTransition` asynchronously: 91 of 200 immediate reads in OBS 30 still returned the previous transition. `setTransition` therefore polls until OBS reports the new one. Otherwise a settings change could go to the wrong transition, and a replay could be cut with the previous transition (a 0.5.0 bug).

**Consequences.**
- The director holds its shots through the console/game-data race, and freeze time shows the players' spawns once each.
- Every match has its broadcast graphics without any design tool.
- They depend only on the canvas in the program's Chromium. The stingers depend on OBS running on the same computer as the program, or the files copied there.

**Checked.**
- **Unit tests:** establishing shots on the real Mirage pack, the repeat and stale-data cases (each fails without its fix), the arbiter catch-up, OBS's late transition switch, the QuickTime structure, LHM coalescing.
- **E2e tests:**
  - two Mirage rounds with a stand-in CS2 whose game data lags 250 ms (fails without the settle window);
  - match art routes and the OBS setup with a stand-in OBS;
  - creating a match from no teams in the UI.
- **Real Chromium:** the built UI against a real engine made all six; FFmpeg decodes the stingers' alpha.
- **Real OBS 30 (Xvfb):**
  - both transitions set and read back;
  - with OBS keeping up, the .mov stinger plays in full, the scenes show through its transparent parts, and the cut is never visible (covered from 0.23 s to 1.23 s after the transition starts);
  - 50 alternating settings changes through the adapter all landed on the right transition.
- **Electron:** the desktop smoke test made all six in 7.5 s without a GPU.

**Not checked.** Real CS2 with these director changes, and OBS on Windows.

## ADR-032 — Leaving the free camera with game data that lags, the director log, and CS2 behind other windows

**Context.** The owner's 0.6.0 recording (Dust2, 107 s) showed the second freeze-time shot on air for 35 s: through freeze time and 12 s into the live round, while five players died off screen. A Dust2 replay against the real engine, with a stand-in CS2 whose game data lags its console by 250 ms and whose camera leaves the free camera only on the build's own `spec_mode` numbers, reproduced it: after the shot the director tried a player every 1.6 s for the whole live round, and every try sent `spec_mode 2; spec_player …` to a build whose first person is `spec_mode 4`. Two races with the lag caused it:
- the adapter cleared its free-camera flag when game data showed a player, including game data from just before a camera, so a selection right after a shot went without the in-eye command and only moved the free camera;
- after leaving the free camera it judged the in-eye command 0.3 s later. The game data still showed the free camera, so the adapter "learned" the other numbering, saved it, and from then on could never leave a shot.

The recording also showed CS2's own picture and sound stopping for 8 s (identical frames, digital silence), then jumping 9 s on: what CS2 does in full screen when another window takes focus.

**Decision.**
- **Free camera:** a free-camera command (camera, path, follow cam) makes the camera free for at least 1.5 s whatever older game data says.
- **In-eye numbering:** leaving the free camera keeps the same in-eye command until the game data has shown the free camera for 2 s since the first try, across the director's retries. Then the other numbering is tried for as long, and so on. The command after which the game data shows a player is kept and saved, also over a numbering saved before, so a wrong saved numbering repairs itself on the next shot.
- **Director log:** `logs/director.log` (4 MB × 3): every console line the adapter sends except streamed path frames, every arbiter event (commands, results, takeovers, external changes), each change of decision (action, desired shot, reasons, control health), and each change in what the game data shows (map, round, phase, spectated player, camera mode, stale). The support file carries its last 400 entries.
- **Behind other windows:** a console game option, on by default in the console modes, sends `engine_no_focus_sleep 0` and `snd_mute_losefocus 0` (off restores 20 and 1). The docs recommend Fullscreen Windowed on the observer computer.

**Consequences.**
- A shot is left on the first try on a build whose numbering is known, and within about 2 s the first time on a build whose numbering isn't.
- The next recording of a wrong shot comes with what Matchframe sent and saw.

**Checked.**
- **Unit tests (stand-in console):** the other numbering only after 2 s of free-camera game data across retries; out of the free camera when game data from before the camera still shows the old player; a working in-eye command never changed by game data 700 ms late; a wrongly saved numbering repaired. The first three fail on the 0.6.0 adapter.
- **E2e (Dust2, real engine, game data 250 ms late, CS:GO numbering):** the spawns in freeze time, on a player within 1 s of the round going live and for the rest of it, only the build's own numbers sent, and the director log holding the console lines, results, decisions and game data. It fails on the 0.6.0 adapter exactly like the recording.
- **The same replay** with game data 500 and 900 ms late and with CS2's numbering: first person within 0.2 s of live, no free camera in the live round.

**Not checked.** A real CS2 (which numbering the current build uses, how late its game data is), and whether the owner's 8 s freeze came from a window taking focus; the director log will show it next time.

## ADR-033 — Freeze time filled with shots the game turns, pauses held on one team, and how smoothly a HUD draws

**Context.** After 0.6.0 the owner asked for:
- smoother cinematics;
- cinematics for all of freeze time;
- a still shot of one team during a tactical or technical pause;
- first person when the round starts.

They also found the HUD laggy in their recording. Measured in that recording:
- The kaiHUD scoreboard's fade stops partway for 0.55 s as freeze time starts and for 0.25 s as the round goes live: the page stops drawing.
- Its clock ticks 0.43–1.50 s apart instead of every second.
- CS2 itself ran at 215–280 FPS (its own frame counter in the picture).

Through Matchframe in Chromium, the same kaiHUD ticks within 0.1 s of each second, within 0.18 s with the CPU slowed six times, and never stops for more than 67 ms at 4× slower. So the lag is in drawing the HUD on that computer (OBS's browser source), not in the game data.

**Decision (freeze time).**
- **Planning:** shots of the spawns with players, sharing the time left: shots of 4–12 s, the last planned 1.5 s past the end so the cut to first person comes at live. At most four per freeze time, each camera once a round.
- **Chaining:** a candidate may carry `chain`; the planner then goes from a cinematic straight to it (at the planned end, or at once when it is also `urgent`) instead of back to a player. Freeze-time shots and the pause shot chain.
- **Motion:** freeze-time shots are static cameras turned in the game. The intent carries `panDegPerSec` (3°/s or less, at most 30° over the shot, alternating direction). The adapter places the camera half the turn to one side, sends `cl_yawspeed <speed>; +left|+right`, and releases with `-left; -right; cl_yawspeed 210` at the planned end or with the next command. The first pan is checked with `getpos` after 0.7 s; a build where it doesn't turn gets still shots.
- **Paths in freeze time:** camera paths are left out unless `cinematic.freezeTimePaths`.
- **Pacing:** streamed paths and follow cams send 128 poses a second with a `setImmediate` wait between frames (busy while they play). Windows' 15.6 ms timer made 64-a-second poses uneven (judder).
- **Pauses:** the game data's `timeout_t`, `timeout_ct` or `paused` phase (or its `paused` flag) during freeze time marks the round's freeze time as paused. The director then offers only a still camera of that team's spawn (technical pause: the team on screen, else T). It is `urgent` and `chain` when a shot from before the pause is on air, planned for up to 180 s, with reason `PAUSE`. It holds until live, also after the pause ends.
- **Live:** unchanged. The freeze-time candidates disappear, so the current shot is invalid and the planner cuts to a player at once.

**Decision (HUD).**
- The output page (wrapper) times its own `requestAnimationFrame` gaps (the HUD frame shares its main thread) and sends `{type:"perf", fps, worstMs, pauses}` every 5 s on its control socket. Gaps over 10 s, a hidden page and a hidden or stopped HUD are not counted.
- The HUD server keeps each output's reports for a minute. `HudLibraryEntry.smoothness` has the worst output per mode. Pauses of 250 ms or more go to the director log as `hud stall`.
- The UI shows that output's indicator amber and, in Outputs, where the pause was and what helps (OBS browser source hardware acceleration; for the desktop HUD, Fullscreen Windowed and a frame cap).

**Consequences.**
- Freeze time is all cinematic, with motion the game draws every frame. Every cut between shots is a cut: there is no player view between them.
- A HUD that stutters says so, where it runs, with the fix; the logs tell lag in drawing from lag in data.

**Checked.**
- **Director unit tests (Mirage pack):**
  - freeze time filled shot after shot with no player view between, turning alternately at most 30°, the last until live, then first person within 0.4 s;
  - in a CT or T timeout, a still shot of that team's spawn within 0.4 s, held until live, then first person;
  - a technical pause held the same way.
- **Adapter unit tests (stand-in console that turns while +left/+right is held):**
  - a pan centred on the camera's aim, about 3°/s, released before the next command and at the planned end;
  - a build that ignores +left gets still shots after one check;
  - path poses at 128 a second: median 6–10 ms apart, 95 % under 14 ms.
- **E2e:**
  - Dust2 against the real engine with game data 250 ms late: spawn shots one after another, each turned, then first person, the camera never free in the live round;
  - a CT tactical timeout: a still CT-spawn shot within 1 s, nothing else until live, then first person;
  - the Auto Director with a stand-in CS2 that turns its camera;
  - output frame reports reaching the library and the director log.
- **Chromium with kaiHUD through the output page:** 57 fps with an 83 ms worst gap, and a 600 ms block in kaiHUD's page reported as a 583 ms pause.

**Not checked.** A real CS2: whether `+left`/`+right` turn the spectator free camera on the current build (the check with `getpos` falls back to still shots); OBS's browser source on the owner's computer.

**Superseded in part by ADR-034:** in CS2 `+left`/`+right` strafe the camera; every move is now sent by Matchframe.

## ADR-034 — Team shots framed live, every move sent by Matchframe, no wall at the lens

**Context.** After 0.6.1 the owner found Mirage's cinematics "all in the ground", nothing like a pro production, and asked for every map to be gone through.
- 0.6.1 turned freeze-time shots with `cl_yawspeed` and `+left`/`+right` (ADR-033). In CS2 those are the strafe keys (A and D); turning is `+turnleft`/`+turnright`, and sources disagree on whether `cl_yawspeed` still sets its speed. So the first panned shot of a session slid sideways (into walls, under floors) for the 0.7 s before the `getpos` check and its readback, and the check then turned panning off for the session.
- Every built-in camera was checked against CS2's collision meshes (build 26144732): none sits inside geometry or under a floor (rays all round hit only outward faces, as from player positions). But rendered from the meshes, Mirage's spawn cameras show the team small, with walls filling half the picture. 14 of 391 cameras had a third or more of the picture within 150 units: the generator's openness test used a 90° picture, not CS2's 106° across 16:9, and had no rule for a wall at the lens.

**Decision.**
- **No movement keys.** A moving shot is an `activate_static_camera` with `motion` (`CameraMotion`: `durationMs` and `pose(t)`). The adapter shows `pose(0)`, confirms it with `getpos` (and learns the spec_mode numbering) as for any camera, then sends `spec_goto` 64 times a second, waiting on timers (no busy loop), until the planned end. Pans (`panMotion`) and glides (`glideMotion`) are built by the session from the intent.
- **Team shots** (`frameTeam`, director-policy/src/framing.ts), framed with the map's free-space grid from the team's live positions (players can't move in freeze time):
  - the group: players within 900 units and 160 units of height of the team's median; at least half the team, two or more;
  - spots: 32 bearings × 4 distances (the group's spread + 220–600, 260–1000 units) × 4 heights (75, 110, 160, 220 above their floor);
  - a spot is kept when: 20 units of room round it, 28 above, floor below; aimed at the middle of the group as it lands in the picture, pitch −5° to 40°; every body (feet to 72 units) inside 86 % / 88 % of the picture; all but one seen (chest or eyes); no other player within 120 units or in the picture nearer than 70 % of the way; nothing within 90 units of the lens or between the lens and the middle of the picture (rays through the upper two thirds), and at most 45 % of those rays blocked before the team;
  - scored on players seen, the group filling about half the picture's width, a 12° look down, height, distance, how much they face the camera, and openness;
  - the glide: 10° round the focus and 8 % closer (else the other way, else 5°), checked every 12 units the same way; otherwise still;
  - none frames all of them: the player furthest out is left out (down to three);
  - framed once per team and round, again when the team's middle moves 150 units (game data from before the respawn) or a second after no spot worked.
- **Freeze time:** the team shots (cameras `team-T`, `team-CT`, source `framed_live`, shot keys `camera:team-*`) come first: same coverage as a spawn camera, narrative 0.95/0.94 against 0.7, the Ts first in even rounds. Spawn cameras follow, or stand in for a team no spot frames. **Pauses:** the still team shot of that side first (camera `team-CT-still` / `team-T-still`: its own shot key, so a pause cuts to it from the same team's glide).
- **Built-in cameras:** `scripts/generate-map-cameras.py` also rejects a spot when more than a quarter of a 9 × 5 grid of rays across the whole 106° picture hits geometry within 150 units. Rerun on the same meshes: 12 cameras dropped (no other spot qualified), 13 moved, 354 and all 81 paths unchanged.

**Consequences.**
- Freeze time shows the teams the way a broadcast does, from where they actually stand, on every map, moving gently; a camera never moves unless Matchframe sends the pose.
- The engine keeps no thread busy for slow moves.
- Areas with a wall at every camera spot have no built-in camera; operators can add their own.

**Checked.**
- **Exact geometry, both spawns of all nine maps** (five players placed on navigation areas inside each spawn; Overpass's CT spawn has no area in the data): a team shot for every spawn in 4–60 ms. Rendered from the collision meshes and looked at. Along every glide, the camera is in open space (outward faces all round) and sees at least as many players as the grid said.
- **Framing tests:** flat ground (distance, height, look down, glide, faces, still, walls, foreground, groups) and CS2's grids for the 17 spawns.
- **Director:** Mirage with its grid gives a gliding team shot of each team for all of freeze time, then first person; a CT timeout gives the CTs' still team shot, held until live.
- **Adapter:** against a console where `+left`/`+right` strafe, a pan is sent as poses (about 64 a second), never with movement keys, ending where planned; a glide keeps the focus centred; a still shot is one command.
- **E2e:** Dust2 against the real engine with game data 250 ms late (both team shots gliding, then first person; a CT timeout's still CT team shot until live); Mirage rounds; the Auto Director.
- **Built-in cameras:** 379, none inside geometry, none with more than 30 % of the picture within 150 units.

**Not checked.** A real CS2: how the shots look on air.

## ADR-035 — Real spawns from pro demos, team shots tuned on them, and Cache

**Context.** The owner pointed out that the players in the team-shot previews weren't in Nuke's real spawns, and uploaded an HLTV demo for each map in the current active-duty pool: Ancient, Anubis, Cache, Dust II, Inferno, Mirage and Nuke.
- The previews placed test players on navigation areas inside the packs' spawn regions. Those regions came from navigation place names ("TSpawn", "CTSpawn"): whole named areas whose middles were 100–500 units from where players really stand. On Ancient and Anubis the CT region missed the spawn points entirely. Spawn cameras aim at their region.
- Cache is in the pool, but there was no map pack, grid or camera for it.

**Decision.**
- **Spawn regions from demos** (`scripts/set-spawn-regions.py`, awpy): every alive player's position as each round's freeze time ends is a spawn point. Each pool map's `t_spawn` / `ct_spawn` region becomes the cells holding those points and one cell round them, tagged `spawn_points`; the spawn cameras and paths were regenerated, and no other camera changed.
- **Cache:** the pack is built from the demo with the workers' `build-map-pack` (46 regions from CS2 place names, `demo_place_names`). The grid and the cameras come from the same awpy-data meshes and generators as the other maps (`de_cache` added to both). On 1,500 sightlines the grid never saw through a wall, and it missed 13 of 144 clear ones. Cache is in the default event pool; Overpass, Train and Vertigo keep their packs, out of the default pool.
- **Team shots tuned on the real positions** (every round, both teams, seven maps):
  - spots on 48 bearings × 6 distances (the group's spread + 160–800, 260–1100 units) × 5 heights (75, 110, 160, 220, 300);
  - a size score (the middle player 380 units from the lens);
  - when the whole team only fits from far away (the middle player more than 580 units off), groups without the player furthest out are framed too. Each player left out costs 0.8 of score: a good-sized four beats five far away.

**Checked.**
- **Real rounds:** 272 team shots (every round of the seven demos, both teams): every one framed; all five players in 263 (six Dust II rounds leave out a T standing well apart, three Mirage rounds show four of the Ts strung along their street), gliding in 271; at most 64 ms each. Before tuning, two of Mirage's 36 had no shot: the Ts stand along a narrow street.
- **CS2's exact geometry:** along every glide the camera is in open space and sees the players.
- **Rendered from the collision meshes** for round 1 of each map, and looked at.
- **Framing tests** use round-1 positions from the demos, plus Mirage's T spawn strung along its street.

**Not checked.** On air in a real CS2.

## ADR-036 — Clutches without X-ray, number keys from CS2's slots, coaches hidden

**Context.** The owner asked for:
- X-ray off in clutches such as a 1v2, so a won clutch looks like magic;
- player names above heads whenever X-ray is on (`hud_showtargetid 1`);
- a fix for kaiHUD's minimap numbering every player one too low;
- coaches kept off the scoreboard: their recording showed a coach as a sixth player all match.

**Decision.**
- **Clutch X-ray** (`GameConsoleService`, option `clutchXrayOff`, default on): when a live round has one player alive (coaches aside) against two or more, the console gets `spec_show_xray 0` and `hud_showtargetid 0`. Everything applied while it is held uses X-ray off. It ends when the round attempt is no longer live or changes, or when either option goes off, and the stored option is sent again. Only in the console launch modes.
- **Names:** `xrayCommands(on)` sends `spec_show_xray` and `hud_showtargetid` together.
- **Number keys** (`observerKeys`): CS2 numbers observer slots 0–9, the first team on 0–4; CS:GO and the synthetic data number them like the keys (1–9, then 0). The two are told apart by slots 0 and 1: on one team when counting starts at 0, on different teams when slots are keys. `PlayerState.observerKey` is the key: CS2's slot + 1, the tenth player 0, null without a slot. HUDs, Live Control, the director's intents and the Stream Deck use it. LHM HUDs get it as `observer_slot`. LHM's own parser expects key numbering (it puts the team whose first player has the lower number on the left, with 0 counted as 10), so its left and right are now right on CS2 too.
- **Coaches** (`PlayerState.coach`):
  - detected by `detectCoaches`: a name with "coach" as a word, or, on a team listing more than five, a player with no slot or not alive in freeze time while five teammates are; forgotten once they are alive in a live round;
  - also the roster role Coach;
  - the operator's choice wins over both (`players.coaches` setting, Live Control buttons, `PUT /api/v1/live/players/:steamId/coach`).
  - Coaches get no number key; the team projections and the minimap, LHM game data, the director's candidates, the Auto Director's test target and the device number keys leave them out.

**Checked.**
- Number keys for both numberings, and in the match state for a CS2-numbered game.
- Coach detection, the roster coach and the operator's override.
- LHM game data: renumbered, coaches dropped, raw packet untouched.
- The clutch toggle against the stand-in console: off at 1v2, back at round end, not touched with the option off.

**Not checked.**
- How a real CS2 lists a coach in GSI: whether they have an observer slot and what health they report. The manual choice covers a coach the detection misses.

## ADR-037 — No X-ray in retakes; follow cams removed

**Context.** The owner asked for:
- X-ray off on retakes too, "when it makes sense";
- no follow cams: keep only the observer (first person), cinematics and nade cams.

**Decision.**
- **Retakes** (`retakeUnderway`, console option `retakeXrayOff`, default on): X-ray and `hud_showtargetid` go off when all of these hold, and stay off until the round attempt is no longer live:
  - a live round with the bomb planted (or being defused);
  - players alive on both teams, coaches aside;
  - a CT defusing, or a CT within `RETAKE_RANGE` (1,600 units, about a site's approach) of the bomb;
  - the bomb's countdown leaving time to defuse (5 s if a living CT has a kit, else 10 s; an unknown countdown counts as enough).

  CTs saving far off, a bomb with no time left, or no T left keep X-ray on. Without a bomb position, a planted bomb with time left counts as a retake. The clutch rule is checked first: a 1v2 after the plant is held as a clutch. Both share one hold (`xrayHold`, reason `clutch` or `retake`).
- **Follow cams removed:**
  - the director's follow cam candidates and `follow_player` intents;
  - the engine's `FollowCam`;
  - the Auto Director's `followCams` setting and its switch;
  - `cinematic.followPerMap`;
  - the `follow:` shot keys.

  The adapters' `streamCamera` stays (generic pose streaming). The `follow_cam` shot class and `FOLLOW_CAM` reason stay in the contracts so older director logs still read. The chase view (third person at plants, defuses and round wins, and in clutches) is unchanged: it is a player view through the observer, and can be turned off on the card (**Chase cam**).

**Checked.**
- Retake detection: on with a CT 900 units from the bomb, or defusing; off with the CTs 3,000 units away, with 8 s left and no kit (on with a kit), before the plant, and with no T alive.
- The stand-in console: a 2v2 retake turns X-ray off only once a CT comes close, and the round's end turns it back on.

**Not checked.** On air in a real CS2: whether 1,600 units suits every map's sites.

## ADR-038 — Demo learning on the operator's PC: POV labels, FTP storage, Python set up from the program

**Context.** The owner wants pro demos turned into "the valuable information to make calculated decisions on the best POV to get kills or multi-frags". The demo should not be needed afterwards. A 4 TB FTP storage box (storage only, no compute) is available, and the reading is done on the owner's PC.

The Demo Library already read demos into datasets, but Python and its packages don't ship with the program (only the worker sources do). Datasets stayed local, and nothing said which POV would have shown the action.

**Decision.**
- **POV labels** (`build-features`, features version 2): `pov_labels.parquet` per live grid frame and alive player, looking into (t, t + h]:
  - kill / death / either within 2 s and 5 s;
  - kills within 10 s, and a multi-frag (two or more).

  Kills are death events plus counter-attributed kills; suicides are excluded. They are labels only, never features, and are the target for an observer model and for scoring the director on replays. Datasets with features version 1 are built again.
- **Storage** (`DatasetStorage`, workers `storage-test` / `upload-dataset`, Python's ftplib):
  - each committed dataset is uploaded after `build-features`, which, if it fails, doesn't stop the upload;
  - the layout matches the local one, written to a `.partial-<token>` directory, each file's size checked, then renamed into place. An unchanged remote copy is skipped; a changed one is replaced.
  - **FTPS (explicit TLS) by default**, with the data connections reusing the login's TLS session. Storage boxes are reached by IP with self-signed certificates, so the certificate's SHA-256 is pinned at the first good test (trust on first use) and checked on every connection; a new host or port forgets it. Plain FTP only when chosen.
  - The connection goes to the worker in environment variables (`MF_STORAGE_*`), never arguments. The password is in the secret store and never returned, logged or audited.
  - One upload at a time, not during a live broadcast or while the library is paused, retried 10 minutes after a failure. Uploads are recorded per demo SHA-256 (setting `demos.uploads`).
- **Retention `remove_after_upload`:** a raw demo enters quarantine only once its upload is recorded, and is deleted after the quarantine days (verified dataset, as before).
- **Archives:**
  - `.zip` / `.rar` in an ingest folder are unpacked by the worker into `<ingest>/unpacked/<name>/`. Only demo files are taken, flattened to safe names, at most 16 GB, using zipfile for zip and bsdtar (Windows' `tar.exe`) for RAR.
  - The demos are imported and the archive is deleted. An archive imported from outside an ingest folder is never deleted.
  - Scanning skips a folder while it is being unpacked.
- **Python** (`PythonSetup`): the interpreter is the one chosen by hand, else `MATCHFRAME_PYTHON`, else `<data>/python-env` if it exists. **Set up** finds Python 3.11+ (`py -3`, `python`, `python3`), creates that virtual environment and pip-installs `workers/pyproject.toml`'s dependencies. Nothing goes into the system Python. `doctor` reports the version and missing packages.

**Not chosen.**
- **Bundling Python and the packages in the installer:** about 150 MB more for every user, when only the owner reads demos.
- **Uploading raw demos to the storage:** about 300 MB each, and the box can't read them.

**Checked.**
- POV labels against a brute-force count on the synthetic demo.
- Uploads against real local FTP and FTPS servers (pyftpdlib): complete, skipped when unchanged, replaced when changed, no staging left behind, wrong password refused, FTPS against a server without TLS, a changed certificate refused.
- Zip unpacking: only demos, no path escape.
- The engine: no deletion before the upload, the password only in the environment, the 10-minute retry, certificate trust and its reset on a new host, archives (deleted from the ingest folder, kept from elsewhere), Python setup and its messages with a stand-in.

**Not checked.**
- The owner's storage server (FTPS support, speed).
- RAR on Windows 10.
- The Python setup on a real Windows computer.

## ADR-039 — The free camera's position sent again after the switch; an unconfirmed camera fails

**Context.** The owner reported that when cinematics start, CS2 goes into the free camera "underneath the player in the ground and not actually in the cameras you set". The earlier Mirage report ("cinematics all in the ground", 0.6.1) was put down to `+left`/`+right` strafing (ADR-034). That was real, but it wasn't the whole cause.

Static cameras were sent as `{roaming}; spec_goto …` on one line. CS2 applies the switch to the free camera a tick later, so the `spec_goto` arrived while the camera still followed the player and was dropped. The free camera then started at the player's position.

`getpos` saw the mismatch, but the adapter returned the command as transport-acknowledged. The game data then showed the free camera, which confirmed the shot, and the camera stayed in the ground for the whole cinematic. The stand-in CS2 applied both commands at once, so the tests never saw it.

**Decision.**
- After the camera command, `spec_goto` alone is sent again at 50, 150 and 300 ms, then `getpos`. On a mismatch it is sent once more, followed by another `getpos`.
- A camera `getpos` places elsewhere after that is **failed** (`confirmation_timeout`, with the `getpos` position). The director marks it failed for the round and goes back to a player. A camera with no `getpos` answer is still left to the game data, as before.
- The pitch comparison wraps like the yaw's.
- The engine's stand-in CS2 switches to the free camera 40 ms late (`freeSwitchMs`) and starts it at the player's feet.

**Checked.**
- Against that stand-in, the 0.6.6 adapter fails the Dust2 freeze-time e2e test, and the new one passes.
- Adapter tests: a late switch is confirmed at the camera's pose; a camera `spec_goto` never moves is reported failed; the CS2-numbering fallback still works.

**Not checked.** Against a real CS2: how many ticks the switch takes when spectating a server rather than a demo or CSTV. The resends cover about 300 ms, and the second `getpos` about 1 s.

## ADR-040 — One spec_mode numbering; cameras find the command that moves them on this build

**Context.** ADR-039 put the "camera in the ground" report down to CS2 switching to the free camera a tick late. The owner's 0.6.7 support file (Mirage, build 14193) showed otherwise:
- every camera was sent as `spec_mode 6; spec_goto …`;
- `getpos` kept answering the spectated player's position, even after five resends over half a second;
- the game data never showed the free camera;
- every `spec_player` then went unconfirmed.

The CS2-numbering fallback never ran. It needed the templates to be the built-in CS:GO set, but the saved ones weren't: an earlier session had learned a CS2 first-person or chase command and saved only that one. CS2 has no `spec_mode 6`. It put the view in a state at the player where `spec_goto` and `spec_player` did nothing, and the camera code never changed out of it.

**Decision.**
- **One numbering:** the in-eye, chase and free-camera commands always come from the same set (CS:GO 4/5/6, CS2 2/3/4). Learning from leaving the free camera, from the chase check or from a confirmed camera sets all three. At start, saved templates that mix standard values take the numbering a CS2-only value shows (in-eye 2 or chase 3). Hand-edited non-standard templates are left alone.
- **Ways of moving the camera:** until one is confirmed in the session, a camera `getpos` doesn't confirm is tried, in order, with:
  - the other numbering's free camera;
  - `setpos x y z; setang pitch yaw 0` with the current free camera;
  - `setpos`/`setang` with the other free camera.

  Each is followed by the position resends and `getpos`. The first that works is kept (numbering and move command) and saved to the templates. Paths and moving shots use its frame command.
- **Never left in the odd view:** a camera that didn't move sends the first-person command, then fails. A player selection after a free-camera command always sends the first-person command first: on this build the game data names a player even out of first person.
- **Diagnostics:** CS2's console answers that say a command failed (`Unknown command`, cheat or `sv_cheats` messages, `Usage:`) are logged as `console reply`, at most 20 a minute. The support file includes the observer adapter's settings.

**Checked.**
- Adapter tests where the stand-in reports the camera's real position: the support file's state (in-eye 2 saved, free 6) uses 4 and moves; `spec_goto` unknown with `setpos` working is learned and used next time; a camera that never moves sends `spec_mode 2` and the next selection leaves the free camera.
- The earlier learning tests now expect whole numberings.

**Not checked.** On a real CS2: whether its free camera is `spec_mode 4` with `spec_goto` (expected), or needs `setpos` (cheat-protected outside demos and local servers).


## ADR-041 — A replay test bench: the director scored on read demos

**Context.** Whether a director change helps was judged by watching. The owner asked for a test bench.

**Decision.**
- **Replay streams:** the worker command `export-replay` writes a committed dataset as JSON lines: alive players at 8 Hz (position, view angles, health, armor, weapon), the round phase and the planted bomb. Kills go between the frames, for scoring only.
- **The replay:** `runBench` turns each frame into synthetic game data, runs it through `MatchStateStore` and calls `Director.evaluate` in Observer mode. A player switch goes on air 300 ms later. While it is on its way the director gets `pendingCommand`, as it does live.
- **Scores:**
  - kills shown (the killer's or the victim's POV on air);
  - opening kills shown;
  - multi-frags shown on the killer's POV (a second or later kill by the same player within 10 s);
  - mean lead (how long the shot had been on that player, capped at 10 s);
  - cuts per minute.
- **In the program:** Training → Director test bench replays the newest read demos. It compares the director as set up with the same director without the demo-trained model, and without multi-frag awareness. It never runs during a live broadcast. `services/local-engine/scripts/bench-replays.ts` does the same from the command line.

**Checked.**
- Seven pro matches (Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke; 963 kills).
- The first version reset the switch delay whenever the director repeated a cut, so many cuts never landed. Ancient went from 53 % to 69 % kills shown once it waited like the live session.
- Unit tests on a synthetic round: counts, the background run equals the direct one, and a switch on its way is never re-sent.

## ADR-042 — Multi-frag awareness: cut to the player who just got a kill only while the shot on air is quiet

**Context.** After a kill, more kills often follow from the same player when enemies are close.

**Decision.**
- **The boost:** a player who got a kill in the last 4 s (from GSI `round_kills`), still alive with an enemy within 1600 units, gets narrative and action coverage. The boost grows with how many enemies are near and how many kills they have this round. The candidate is marked `MULTI_FRAG_CHANCE`, and the planner's post-event hold covers it.
- **The guard:** the boost only applies to a player who is not on air when the POV on air has baseline imminence below 0.5 (`multiFrag.leaveBelowImminence`).

**Checked (bench, 7 matches).**

| Variant | Kills shown | Multi-frags shown on the killer's POV |
|---|---|---|
| Without the guard | −8 | +8 |
| Hold-only (only for the player on air) | −4 | +1 |
| With the guard | −5 | +8 (45 % → 49 %) |

With the demo-trained model as well, multi-frags go from 49 % to 53 % at the same kills shown (ADR-043).

## ADR-043 — The demo-trained POV model helps the director pick whose POV to show

**Context.** "Use what the demos teach." The POV labels (ADR-038) record, for every frame and alive player, whether their POV shows a kill in the next 2 s (`action_2s`).

**Decision.**
- **Task `pov_2s`:** player rows built from the T×CT pair features (`workers/training/mf_training/pov.py`). There are 19 features, all available from live game data:
  - side, health, armor, speed, weapon class;
  - alive counts, round time, the player's kills this round;
  - nearest enemy distance and facings (self and opponent);
  - enemies within 1000 and 2000 units;
  - best facings within 2000 units;
  - max closing speed;
  - the max and sum of the pair heuristic.
- **Training:** LightGBM, as for `contact_2s`. `train --task pov_2s`, a `--max-rounds` option, and splits with a fraction of 0 hold nothing back (for a shipped model).
- **Live:** `LivePovModel` reuses the contact model's pair vectors and aggregates them the same way. The director blends the result into imminence: `0.5 · baseline + 0.5 · min(1, p / 0.5)`. Players without a prediction keep the baseline, and a model that throws is ignored.
- **Built in:** `assets/models/pov_2s-builtin`, trained on the seven pro matches (1.3 M player frames, 200 rounds, build 14191). It is on by default and can be switched off under Training → What the demos teach. A `pov_2s` model trained on your own demos can replace it there.

**Checked.**
- **Accuracy:** leave-one-match-out AUC 0.941 against 0.881 for the heuristic, better on every map. The pipeline's own split gives a test AUC of 0.940.
- **Bench**, each match scored by a model trained without it:

  | Metric | Baseline | With the model | Model + multi-frag awareness |
  |---|---|---|---|
  | Kills shown | 71.3 % | 74.2 % | 74.0 % |
  | Opening kills shown | 96 / 141 | 102 / 141 | 102 / 141 |
  | Multi-frags shown | 44.9 % | 49.4 % | 53.4 % |
  | Cuts per minute | 6.05 | 5.48 | 5.41 |

- **Parity:** on Anubis frames, the TypeScript features match the Python ones (correlation 1.000 except speed, 0.973: position changes against demo velocities). Model parity vectors pass at 1e-9.

**Not checked.** On a live GSI feed in a real match.

## ADR-044 — Freeze times that differ from round to round, and shots for big moments

**Context.** Every freeze time showed the Ts, then the CTs, from the same kind of spot.

**Decision.**
- **Variety** (on by default):
  - Every third round has one longer shot of one team (70 % of the freeze time).
  - A team whose players average under $2,500 in money and equipment (an eco) gets no team shot.
  - Team shots rotate between looks: eye height, high, from the side, low.
  - The pan direction alternates from round to round.
  - Map cameras and paths that played 1–3 rounds ago score lower (0.18 / 0.10 / 0.05). The planner remembers four rounds.
- **Big moments** (on by default; `matchMoment`, MR12 with MR3 overtime):
  - A pistol round opens with the map's camera.
  - The team on match point comes first and longer.
  - Half time and the end of the map get slow shots of the map and the teams. At half time the team ahead goes first; at the map's end, the winners.
- **Winners after the round:** 2 s after the round ends, the winning team framed where they stand, until the next freeze time. This plays every round by default; the card can set big rounds only, or never. Big rounds are pistol rounds, the end of a half or of regulation, an overtime half, the map, and putting the winner on match point.
- **Shot ids:** winners shots use `team-T-win`; half time and map end use `team-T-break`. So the next freeze time can still show the team.
- **Budget:** these shots are off the live round's cinematic budget.
- **Reason codes:** `ROUND_WINNERS`, `PISTOL_ROUND`, `MATCH_POINT`, `HALF_TIME`, `MAP_END`.

**Checked.** Director tests on Mirage with its grid cover:
- the pistol opener, match point first and longer, no team shot for an eco team;
- one team every third round, and both teams with variety off;
- the winners after 2 s, big rounds only and off;
- half time with the team ahead first;
- round memory.

The engine end-to-end tests that check both team shots now run with variety off.

## ADR-045 — Your own cameras: walkthrough with Keep/Hide, save the CS2 view, HLAE paths

**Decision.**
- **Walkthrough:** the Maps screen shows every camera of the map being played, a few seconds each, with Keep / Hide. Hidden cameras are never used (`MapRuntime.hiddenCameras`, setting `cameras.review`).
- **Save the view:** Ctrl+Shift+F11 (works while CS2 has the focus), the Automation menu, or the Maps screen. The engine reads `getpos` and saves the view as `mine-N` for this map:
  - used for freeze time and fights;
  - counted as checked, since you looked through it;
  - focus at the first wall or floor straight ahead in the grid.

  A notification says how it went.
- **HLAE camera paths** (experimental, off by default; only in the HLAE launch mode):
  - The path is written as an HLAE campath file: advancedfx CamPath XML with absolute seconds, rx roll / ry pitch / rz yaw, cubic from four keyframes, and `hold`.
  - Then `mirv_campath load "<file>"; mirv_campath edit start; mirv_campath enabled 1`, and `enabled 0` at the end or on a cut.
  - If CS2 answers "Unknown command: mirv_…", paths go back to streamed positions for the session.

**Not checked.** HLAE documents `mirv_campath` for demo playback; whether `edit start` follows the live client's time while spectating is unknown.

## ADR-046 — Every free-camera and moving shot through HLAE (replaces ADR-045's campath option)

**Context.** The owner: Lexogrine HUD Manager uses HLAE for all its cinematic shots; use HLAE for every free-camera and moving shot, since it is more stable and better. The console method has to:
- get CS2's spectator mode numbers right (ADR-039, ADR-040);
- resend positions and check them with `getpos`;
- send up to 128 `spec_goto` lines a second for a move, at the mercy of console timing.

ADR-045's `mirv_campath` option only covered paths and relied on `edit start` following live time, which HLAE doesn't document.

**Decision.**
- **The script:** HLAE for CS2 runs JavaScript (mirv-script, from HLAE 2.162). Matchframe writes a small script, `observer-agent/src/hlae-camera.ts` → `<data>/hlae/matchframe-camera.js`, and loads it with `mirv_script_load` whenever the console connects in the HLAE launch mode.
- **The connection:** the script connects to the engine (`/hlae` on the API port, this computer only, with a token) through `mirv.connect_async`, and reconnects every second.
- **Playing shots:** while it is connected, the console adapter sends every shot to it as timed poses, 33 ms apart, sampled from the same motions and paths: static cameras with their pan, team-shot glides, winner, half-time and map-end shots, camera paths, streamed moves. HLAE returns the view from `cViewRenderSetupView` every frame, interpolating, and holds the last pose. It confirms the shot when it draws the first frame.
- **CS2's own camera:** the free-camera command still goes once to the first pose, unchecked, so the game data and the sound follow the shot.
- **Release:** a player selection, the next shot or a cancel releases the view. A dropped connection releases it in the script.
- **Fallback:** no script, or no answer within a second, means the console method (ADR-040) is used.
- **Setting:** Auto Director → **Camera shots through HLAE**, on by default (`hlaeCamera`). The `mirv_campath` path file and the experimental `hlaePaths` option are gone.

**Checked.**
- The script runs in Node against a stand-in `mirv`, connected over a real WebSocket to the engine's `/hlae`. Tested:
  - a shot drawn from its keys, the yaw turning the short way, the last pose held;
  - live easing and release;
  - stopping the moment the program goes away;
  - a wrong token refused;
  - loading again replaces the running copy.
- Adapter tests: cameras, glides, paths and live moves go to HLAE with one console line and no `getpos`; a player selection releases; no HLAE or no answer falls back to the console.
- The console service sends `mirv_script_load` after the options on connect in the HLAE mode only.

**Not checked.** A real CS2 with HLAE: the script API is HLAE's documented one, but it has not run in the game here. Older HLAE builds without `mirv.events` use the `mirv.on…` hooks the API still maps.

## ADR-047 — Camera paths built from demos (200–300 a map)

**Context.** The owner: make realistic camera paths from the demos provided, 200–300 different ones on each map. The map packs had 9–10 paths each (ADR-025), placed from navigation data round the sites, mid and spawns. HLAE now plays paths smoothly (ADR-046). No free database of CS2 campaths exists to start from.

**Decision.**
- **What the demos give** (`scripts/demo-path-anchors.py`, from committed datasets; positions only, no names or IDs):
  - routes: 6 s stretches where a player ran or walked steadily (90–320 units a second) in a live round, at 4 Hz;
  - where each kill happened (victim and killer) and where the bomb was planted;
  - where every player stood at the end of freeze time;
  - which 64-unit floor cells living players stood on.
- **Places:** clusters of kills and plants (fights), the two spawns as teams stand in them, and the busiest floor away from those. 27–33 places a map.
- **Shots** (`services/local-engine/scripts/generate-demo-paths.ts`):
  - round a place (orbit, 45° or 70°, at four radii and heights);
  - towards it (push-in), away from it (pull-out), up over it (crane), across it (slide), always looking at it;
  - along a route players ran, smoothed, a little behind and above them, looking ahead down the route.
- **Every candidate is flown the way the program flies it** (`samplePath`, every 60 ms and between samples) through the map's free-space grid, and kept only when:
  - the camera has 20 units of room, nothing solid between one sample and the next, and floor within 900 units below;
  - it stays over walkable floor or the cell next to it (navigation floor and where players stood): never out over the roofs and the scenery beyond;
  - no wall fills the picture (never within 70 units straight ahead; only briefly within 160, or at the edges);
  - the place it looks at is in view most of the time;
  - speed and turning stay gentle (orbits and the rest 230 units and 40° a second; routes 320 and 60);
  - it lasts 3–10 s, at 0.5 s keyframes.
- **Choosing:** the best of each style per place (a few per place), then routes, leaving out near-copies. Each map ends with 200–300.
- **In the packs** (`scripts/merge-demo-paths.py`): `source: "derived_demos"`, ids `demo-<map>-<style>-NNN`, named after the area (`Orbit: B site 3`, `Route: T spawn to Outside Long (T)`). They replace the previous demo paths only; operator and navigation paths stay. Keyframes are written one to a line by every script that writes packs. `MapRuntime.pathsFor` treats them as built in, like `derived_navmesh`: used unvalidated unless built-in cameras are switched off.
- **Where they play:**
  - in freeze time, half time and map end, alongside the team shots and spawn cameras, when they show at least two players;
  - only while the HLAE camera is connected: the Auto Director sets `cinematic.freezeTimePaths` from it, because paths over console commands judder.
  - With variety on, map cameras and paths of equal score take turns from round to round (a small shuffle from the shot id and round number). Without it, the first in the pack would always win.
- **Speed:** the director remembers line-of-sight results by their two ends, so checking hundreds of paths against ten players costs nothing once players stand still (it took 10–20 ms a decision).

**Checked.**
- Every shipped demo path flown again in a test through its map's grid at 100 ms steps: room round the camera, nothing between samples, pitch and speed in range, built in and switched off with built-in cameras.
- A Mirage freeze time with paths on flies demo paths round the spawns, each once.
- The Auto Director switches paths on with the HLAE camera and off without it.
- Radar previews of all paths per map were checked by eye.

**Not checked.**
- Any of them in a real CS2. Collision geometry leaves out glass, fences and foliage, so a path can pass close to one; see-through scenery outside the map isn't modelled either.
- One demo per map so far: more demos give more routes and fight places (rerun the three scripts).
- Overpass, Train and Vertigo have no demos yet, so they keep their navigation paths only.

## ADR-048 — Player cams through the website, delayed in the program

**Context.** The owner: player face cams exactly like LHM. A website page opens to the match being played; the player picks themselves, then their camera, sees a preview, approves and sends. The production delays the cams as long as it needs, to cover the CSTV delay.

LHM's HUD protocol (lexogrine/cs2-react-hud, MIT) is the model:
- the HUD reads `/api/camera` (players, a room id) and emits `registerAsHUD`;
- it receives each player's video as a WebRTC offer (`offerFromPlayer`) and plays the stream simple-peer gives it.

WebRTC alone can't delay video by minutes.

**Decision.**
- **The page:** `/cam/<room>` on the Matchframe website, public, no account.
  - It shows the match (`GET /v1/cams/<room>`); the player picks themselves (players are listed by an opaque key, never their SteamID), picks a camera and sees the preview. **Approve and send** encodes the camera in the browser with WebCodecs: VP8, the room's size and frame rate, a keyframe every 2 s or when asked.
  - Frames go over a WebSocket (`/v1/cams/<room>/publish`): JSON hello, then binary frames (version, keyframe flag, capture time, data).
  - Frames come from MediaStreamTrackProcessor where available (Chrome, Edge), so they keep coming while the game covers the browser; elsewhere from a canvas on a timer.
- **The relay** (cloud-api `CamRelay`, memory only):
  - the program hosts the room on `/v1/cams/host` with its computer's credential;
  - each frame is passed on prefixed with the player's connection id;
  - status, keyframe requests and kicks go the other way.
  - **Limits:** 16 players a room, 512 kB a frame, three times the room's bitrate per player. A backed-up program connection drops frames until the next keyframe.
  - A player who opens the page again replaces the old connection. Players wait while the program is away.
- **The program** (`CamHub`, setting `cams`):
  - opens the room while switched on and signed in, and keeps the roster in step with the current match (or the game data);
  - keeps each player's frames and plays them out `delayMs` later (0–300 s), paced by the capture times against the least-delayed arrival seen recently;
  - serves on-air cams (approved, not hidden) to HUDs and OBS pages on `/cams-ws`, and every cam live to the operator's screen on `/api/v1/cams/ws`;
  - starts a new viewer at a keyframe.
- **In the browser** (`hud-runtime/cams.js`): WebCodecs decodes into a canvas per player, available as a MediaStream.
- **LHM-format HUDs:**
  - the HUD server puts `cams.js` and `lhm-cams.js` into their pages, before their scripts;
  - `/api/camera` lists the match's players, and `registerAsHUD` gets `playersCameraStatus` and an `offerFromPlayer` per on-air cam (repeated every 3 s, which the HUD ignores while connected);
  - the offers carry a marker. The page's RTCPeerConnection (a wrapper) answers them locally and hands simple-peer the cam's MediaStream, with no network connection; every other use is the browser's own.
  - A cam off air for 1.5 s fails its connection, so the HUD shows the avatar again and takes the next offer.
- **Matchframe's HUD** shows the observed player's cam above their panel.
- **OBS:** `/cams/observed` and `/cams/player/<id>` (cams token).
- **The operator** (Cameras → Player cameras): switch on, the link (and a new one), delay, quality, auto-approve, and per player put on air, take off air, stop, with live previews. Plus the OBS addresses.

**Why not WebRTC end to end.** The delay needs the video kept somewhere: in the program, encoded, it's about 10 MB a player for two minutes. WebRTC would also need a TURN relay for players behind strict NATs, which costs the same traffic, and LHM HUDs need a MediaStream in their own page either way.

**Checked.**
- Relay: room ownership, roster, first-keyframe rule, status and key requests, replacing and kicking, waiting for the program, bitrate cap, closing.
- Program end to end against the real website server: link and roster, the operator's frames at once and the HUD's after the delay, at the filmed pace, off air and back from a keyframe, approval, stop, tokens, a new link.
- Chromium:
  - VP8 encoded in the page, through website and program, decoded on the OBS page (colour checked);
  - the LHM shim given the calls simple-peer makes, and with simple-peer 9.11 itself (stream shown, ERR_CONNECTION_FAILURE off air), an ordinary RTCPeerConnection unaffected;
  - the cam page with a fake camera end to end.
- Page and screen unit tests.

**Not checked.** Real players over the internet; kaiHUD itself; OBS's browser. The website needs redeploying.

## ADR-049 — A cinematic holds while CS2 names the player from before the cut; moving pause shots

**Context.** The owner's 0.8.0 support file (Mirage, HLAE camera connected): "the cinematics flicker when the match is paused and when it's unpaused it continues to flicker", "like it's trying to change cameras but isn't", and "the cinematic shots aren't moving ones".

The log showed every cinematic confirmed by HLAE, then, 600 ms later, the director back on the player CS2 had shown before the cut:
- the game data went on naming that player (camera mode never roaming; ADR-040 had seen the same);
- the planner kept a cinematic only while the game data showed the free camera or within the 600 ms after the cut.

So in a pause the director sent the same pause shot again every one to two seconds. Each time, `spec_mode 4; spec_goto` switched CS2's spectator mode under HLAE's view: the flicker. In freeze time it cut to a new shot about every 3 s, so glides and paths never got going. After each cut back to a player it also sent `spec_player` once per game-data packet for 600 ms (17 times).

Two smaller findings:
- the team shots' glide (10° round the team, 8 % closer, over 10–14 s) is about 6 units a second, which reads as still;
- the pause shot was still by design.

The same file showed the demo-trained POV model refused: "model checksum does not match its card". The Windows build's Git checkout had converted `model.json`'s line ending to CRLF.

**Decision.**
- **Holding:** when a cinematic starts, the director remembers the player the game data named. While the cinematic is on air, that player doesn't end it, nor does the 600 ms after the cut, nor the free camera. The planner follows the game data again when it shows:
  - another player (someone picked one in CS2, or the player died);
  - the player the director asked for when cutting away from the cinematic (the cut is confirmed at once, so no `spec_player` repeats).
- **HLAE follows CS2:** when CS2 moves to another player under HLAE's view and it wasn't Matchframe's selection, the adapter stops HLAE drawing, so that player is shown.
- **Current shot:** the operator screens report the cinematic on air, not the player underneath.
- **Glides:** 24° round the team and 15 % closer, falling back to 16° then 10°, either way, when the full arc runs into a wall or loses a player.
- **Pauses:** the team's shot glides one way over 20 s (`team-T-still`), then back (`team-T-still-back`), until the round goes live. A spawn camera pause shot stays still.
- **Model files:** `.gitattributes` keeps `assets/models/**` byte-exact. The loader also takes a model whose only difference is CRLF line endings.

**Checked.**
- Director tests with the game data naming the old player after every confirmed cinematic (as CS2 does):
  - freeze time plays the same two team shots, each its full length, and one selection at live;
  - a pause glides out, back, out, back 20 s apart, each starting where the last ended.
  - Without the fix, both tests fail.
- The pause tests with the free camera in the game data. The Dust2 e2e pause, now gliding over the console with no movement keys.
- Adapter: HLAE keeps drawing while CS2 names the same player and stops when it names another.
- The built-in model from a CRLF copy loads; a changed byte is refused.

**Not checked.** In a real CS2 with HLAE.

## ADR-050 — HLAE shots run on the frames' lengths; game data answered first; team overhead

**Context.** The owner's recording of two rounds on Ancient (demo playback, HLAE camera, kaiHUD), made on 0.8.1: the freeze-time team shots stood still ("i want moving cinematics of the teams not just stationary"), and the HUD lagged on a fast PC. The owner also found the console lines that show the players' names above them with only the kill feed drawn: `cl_drawhud 1`, `cl_draw_only_deathnotices 1`, `cl_drawhud_force_teamid_overhead 1`.

What the recording showed:
- **Still shots:** differencing the first and last frames of each 9–10 s team shot left only the players moving; the camera didn't move a pixel. The glide was planned (frameTeam gives 10–24° on 77 of 80 real spawn line-ups).
- **The cause:** HLAE's CS2 hook passes `absTime = g_MirvTime.absoluteframetime_get()` to `cViewRenderSetupView`. That is the frame's length in seconds (about 0.005 at 189 fps), not a clock. The Matchframe script took it as a clock, so "time into the shot" stayed at about zero. Since 0.7.1, every HLAE shot (team glides, pause glides, pans, the demo paths) was drawn at its first key, and streamed shots never eased. The script's test fed `absTime` as a running clock, so it passed.
- **The HUD:** the round timer stayed on 1:55 and the minimap's dots stood still for 8.3 s from the moment the round went live (the cut from the HLAE shot to first person), then everything caught up at once. CS2 ran at 189 fps throughout. A stall of the HUD's data, not of its drawing speed. The engine itself answered each update in 4 ms (90 ms at worst) on the same transition in a benchmark (Ancient, real spawn positions), so the recording alone can't say which side stopped. One way the data stops for that long: CS2 sends one update at a time and waits for the answer; an update not answered within the config's `timeout` (0.5 s) counts as lost, and CS2 sends the full state again at its next heartbeat (10 s).

**Decision.**
- **HLAE clock:** the script runs shots on the sum of the frames' lengths (`absTime` per view, capped at 5 s), the way HLAE's own `mirv_input` camera moves; the wall clock only where `absTime` is missing.
- **Team shots:** where no arc round the team stays clear, the camera pushes straight in (79 of 80 real line-ups move).
- **Game data:** the engine answers each update before reading it. The config's timing is now `timeout 1`, `heartbeat 1` (a lost answer costs a second or two). The engine rewrites its config to the new timing when it starts; CS2 reads it when CS2 starts.
- **Diagnostics:** `FeedWatch` records gaps of 1.5 s or more in the game data and event-loop stalls of 250 ms or more, with the round and phase. They go in the support file (`feed`) and the director log. With the outputs' own "hud stall" entries, one support file says which side froze.
- **Team overhead:** `cl_drawhud 1` is sent with the console options; `cl_drawhud_force_teamid_overhead` goes on and off with X-ray, with `spec_show_xray` and `hud_showtargetid`, so the names also go off for clutches and retakes. The standard launch mode's copy line has all three.

**Checked.**
- HLAE script with HLAE's real arguments: a 10 s glide moves every frame at 144 fps and ends on time; the wall-clock fallback. Both fail on the old script.
- Team shots on the 20 real spawn line-ups in all four looks: 79 of 80 move.
- `FeedWatch` gaps and stalls; the GSI config's timing; console lines per launch mode, and team overhead off and on for a clutch and a retake.

**Not checked.** In a real CS2 with HLAE, and whether CS2 really waits for the heartbeat after a lost answer (Valve documents it for CS:GO).

## ADR-051 — Replays: every kill filmed, ranked per round; an NDI replay feed recorded on the main PC; vMix

**Context.** The owner: "PC1 and PC2 should communicate and list the kills every round and structure it in best clips to replay to worst. Get the 3-4 best ones to replay and ignore the rest", with the replay PC going back and staying behind for every game, and a replay feed like LHM's: the delayed PC's screen over NDI (vMix Desktop Capture), recorded by the main PC, which switches OBS or vMix to the replays at the end of a round. The owner chose the NDI feed and OBS plus vMix.

Before this, the replay PC filmed only kills the main camera missed (or showed from the victim), saved each from its own OBS replay buffer and uploaded the file; the main PC played 2 a break in a fixed order (clutch, 3K+, missed, other angle).

**Decision.**
- **Every kill:** behind the main PC, the replay PC plans every kill it has time for (`filmAll`, default on), including those the main camera showed (kind `shown`). Its one camera keeps the better of two clashing kills: more kills, then missed, other angle, shown. Each poll tells the main PC which rounds it still has kills of to film or send (`on-air?pending=`).
- **Ranking:** each clip of a round gets a score (replay/rank.ts): kills (a 2K worth more than two singles), a won clutch, not seen live, another angle, knife/Zeus, Deagle, AWP, headshot, the opening kill, the round-winning kill, a fast multi-kill. The reasons are shown. Clips of the same kills count once. The break plays the best clip that fits in the time left, again and again, best first, up to `perBreak` (default 4). A clip's lead-up is shortened down to 2 s to fit (clips carry `leadMs`). The first replay waits up to 8 s for the replay PC's pending kills, while at least 16 s of the break would remain.
- **Replay feed (NDI):**
  - **Receiving:** the main PC receives the replay PC's screen with grandi (Apache-2.0 bindings to the NDI 6 SDK, prebuilt with the NDI runtime). This runs in a process of its own (feed-worker.mjs, forked by the engine), so neither the native module nor 250 MB/s of frames touch the engine.
  - **Encoding:** frames are piped to ffmpeg as they arrive with `-use_wallclock_as_timestamps 1 -fps_mode cfr`, using the GPU's H.264 encoder (NVENC, QSV, AMF; x264 as the fallback), into one-second MPEG-TS segments. A segment list gives each segment's time from the first frame.
  - **Marks:** the replay PC sends a mark (`POST /api/v1/replays/mark`: how long ago the clip began, the kill happened, and it ended).
  - **Cutting:** the main PC joins the segments and copies them into an MP4 cut at the end (no re-encoding). The clip starts on the second before; `playMs` and `leadMs` say what to show.
  - **Switching:** the replay PC uses the feed when the main PC says it records (`feed.recording` in the on-air answer); otherwise it sends OBS clips.
  - **ffmpeg:** not shipped. On Windows the program downloads one pinned build on request (gyan.dev 7.1 essentials, SHA-256 checked), or uses one on the PATH.
- **vMix:** Automatic replays can play in vMix through its Web Controller API: `AddInput Video|clip`, `SetPosition` (the part to show), `SetRate`, `Play`, then a transition (CutDirect, Fade, Stinger1, Stinger2). Back to the input that was on air when the clip ends or the round goes live, then `RemoveInput`. It doesn't cut back if another input was put on air.
- **Packaging:** the desktop build bundles feed-worker.mjs and copies grandi, node-gyp-build and the platform's `@grandi/*` addon into `engine/node_modules`, named in electron-builder's extraResources (it drops node_modules otherwise). The Windows smoke test asks the installed program for NDI sources: the binding must load.

**Alternatives.** NDI output of the replays (LHM sends its Replay Feed as an NDI source): OBS and vMix both play files, which needs no NDI plugin in OBS and gives frame-exact starts; an NDI output can follow for other mixers. Recording on the replay PC (OBS) stays as the fallback.

**Checked.**
- Ranking and break tests: unit, six clips in a round, the replay PC pending, a stand-in vMix.
- The replay PC filming a shown kill.
- The feed with a stand-in NDI source and real ffmpeg: cuts to the picture within 0.2 s; two programs with the replay PC marking and the main PC cutting.
- The Linux package carries the NDI binding.

**Not checked.**
- The real NDI binding receiving a real NDI source: this session's safety checks don't run third-party native code; the Windows release build checks that it loads.
- ffmpeg's hardware encoders on Windows.
- A real vMix.

## ADR-052 — LHM HUDs get game data 20 times a second; a low frame rate shows

**Context.** The owner (0.9.0): kaiHUD is "very choppy and feels like its running at 20fps", on an RTX 4060 and i7-14700K, and asked whether drawing the HUD on the CPU would take strain off the GPU.

Measured with kaiHUD 1.0.2 in Chromium through Matchframe, with a player running across its minimap and 50 game-data packets a second:
- The page drew at 60 fps.
- At 10 updates a second (ADR-031's limit), the minimap dot surged and almost stopped ten times a second. Each update starts LHM's 0.1 s eased transition (`.player { transition: transform .1s ease }`), so the dot's per-frame step went 0.46, 0.73, 0.47, 0.25, 0.12, 0.03 px and repeated.

| Updates a second | Step variation (sd/mean) | Main thread busy | CPU 4× slower |
|---|---|---|---|
| 10 | 0.70 | 16 % | 74 %, 58 fps |
| 20 | 0.25 | 21 % | 87 %, 60 fps |
| 30 | 0.25 | 24 % | 100 %, 52 fps |
| 50 | 0.32 | 34 % | 104 %, 51 fps |

**Decision.**
- **Rate:** `UPDATE_MS` is 50: the newest packet at most 20 times a second. Urgent changes (spectated player, phases, bomb, alive players, score) still go at once.
- **Low frame rate:** an output that draws under 40 fps at its slowest 5 s in the last minute is shown in amber like one that pauses, with what helps. Each mode shows the fewest frames and the longest pause of its outputs.
- **Support file:** each running HUD's outputs and frame report (`hudOutputs`).

**Alternatives.**
- **Drawing the HUD without the GPU** (Chromium's software rendering): no. The HUD drew at 60 fps already, and the measured choppiness came from the update rate. Software rendering would draw every frame of a 1920×1080 page with transparency on the CPU, and it is a whole-program switch (the match graphics' video encoding too). Where CS2 leaves the graphics card no room, capping CS2's frame rate (`fps_max`) helps, and the Outputs note says so.
- **Every packet (50 a second):** no smoother, and frames drop on a slower PC.

**Checked.**
- Minimap motion at 10, 20, 30 and 50 updates a second, at full speed and with the CPU 4× slower.
- kaiHUD's baseboard on a timeout at 20 a second: 60 fps, main thread 19 % busy. With the CPU 6× slower it is 45 fps (55 at 10 a second): the cost on a much slower PC.

**Not checked.** On the owner's PC, and in OBS's browser source there. The frame report shows how each output draws.

## ADR-053 — An LHM HUD that can't keep up gets fewer updates; radars for maps without one

**Context.** The owner (0.9.1): "All other huds aren't lagging but my imported hud is lagging real bad. And also Kaihud doesn't have Anubis radar supported."

- **The lag.** Measured with kaiHUD 1.0.2 in Chromium through Matchframe, with realistic game data (full loadouts, two molotovs of 25 flames, three smokes, a flash in the air, the bomb carried, 14 rounds of history):

  | HUD (same game data) | Main thread busy |
  |---|---|
  | Matchframe's default HUD | 12 % |
  | kaiHUD with no updates arriving (its animations alone) | 8 % |
  | kaiHUD at 20 updates a second | 31 % |

  - Its own script is about 6 % of that; the rest is styling and painting the page again for each update.
  - With the CPU 4× slower it drew 21 fps (42 with the measuring lighter).
  - On a computer also running CS2 (and OBS), the built-in HUDs have room and kaiHUD runs out first. 0.9.1's 20 updates a second made that worse.
- **Anubis.** kaiHUD bundles radars for nine maps (no Anubis) and asks the HUD manager for the rest (`GET /api/radar/maps`, `{ map: { config, file } }`), which Matchframe answered with `{}`. Matchframe has no Anubis drawing either (assets/radars, from Lexogrine, has eight maps).

**Decision.**
- **Pacing (lhm-runtime.ts `updatePacer`):**
  - **Measuring:** each output page pings itself every 100 ms and reports the 90th percentile of how long the ping waited (`lagMs`, with its frame report every 5 s). The HUD in its frame shares that main thread.
  - **Slowing down:** from `BUSY_LAG_MS` (15 ms) the HUD's interval doubles, after a full report at the new pace (20, 10, then 5 a second).
  - **Speeding up:** under `CALM_LAG_MS` (6 ms) for three reports it halves again; after a slowdown, for twelve reports (a minute), so a page that can't keep up at 20 doesn't swing.
  - **Calibration:** 0.1 ms at full speed; 11, 18 and 27 ms with the CPU 2, 3 and 4× slower. The wait is used rather than the frame rate, because an OBS canvas at 30 fps would read as a slow page.
  - **Scope:** the busiest of a HUD's outputs decides. Each page connection has its own feed at its HUD's pace (its registered name, else its only HUD cookie).
- **Radars from outlines (outline-radar.ts):**
  - **What's drawn:** for a map with a map pack and no radar drawing (Anubis, Cache), a 1024 × 1024 SVG of the pack's outline cells (where players stood in pro demos, 64 units), dark like kaiHUD's radars, bombsites in red, A and B lettered.
  - **Calibration:** Matchframe's schematic transform: origin = (−minX, maxY) × 1024/size, pxPerU = ±1024/size.
  - **Where:** `/api/radar/maps` for older template HUDs, `/api/game-maps/cs2` for newer ones, image at `/api/game-maps/cs2/image/<map>/radar`.

**Alternatives.**
- **A fixed lower rate for LHM HUDs:** gives up the smooth minimap on computers with room.
- **Letting the operator choose the rate:** they can't see what the page is doing; the measurement can.
- **Valve's radar for Anubis from the CS2 install:** compiled textures (`.vtex_c`) in VPKs. Decoding them is a project of its own.

**Checked.**
- kaiHUD with the CPU 4× slower: 42 fps at 20 updates a second, 47 at 10, about 54 at 5, where it stayed. At full speed it stayed at 20 a second and 60 fps.
- An end-to-end test: a report of 30 ms halves a HUD's updates (about 20 a second to 10).
- kaiHUD on Anubis showed the outline radar with every player on the map shape. A test checks that cell centres land on drawn cells through the calibration.

**Not checked.** On the owner's PC.

## ADR-054 — Smooth camera paths, freeze time only where players are, committed nade cams, no free camera left on air

**Context.** The owner, from broadcasts on 0.9.x:
- "Some Cinematics actually are very rough and choppy when moving around the map."
- "Can the cinematics in freeze time only show shots of where players are."
- "For nade cameras … cut to where players are … if it does commit and knows there are players stay on it for 2-3 seconds as it just is in for half a second then out again."
- "Sometimes … it cuts to freecam on the player it was last on and [doesn't] go to a player."
- kaiHUD lags with CS2's graphics on high, not on low.

**Findings.**
- **Paths:** `samplePath` put positions on a Catmull-Rom curve but pitch and yaw on straight lines between keyframes. The turning rate jumped at every key (every 0.5 s on the demo-derived paths): on 169 of the 1,487 built-in paths by more than 20 °/s within one frame, at most 61 °/s.
- **Freeze time:** a map camera counted a player as shown when they stood in a region it was aimed at, whichever way it looked and whatever was in between. A path counted them at its middle keyframe only.
- **Nade cams:**
  - A nade cam was planned as the grenade's flight time plus at most 1.8 s.
  - It was dropped the moment its opportunity ended. A flash or HE ends as it goes off; a smoke or molotov counts for only 2.5 s after it pops.
  - A grenade had value with nobody near it.
- **Free camera:** during a cinematic, the director took a player the game data named but it hadn't asked for (the player CS2 was on died, or CS2 moved on by itself) as the shot on air.
  - On builds whose game data names a player in the free camera, CS2 was in fact still in it, with HLAE released.
  - The director sent nothing, so the free camera stayed on air.

**Decision.**
- **Paths:** one cubic Hermite curve through the keyframes for position, pitch and yaw. Each key's tangent is the slope between its neighbours over their times; the end keys use the slope of the first or last stretch. Yaw is unwrapped the short way.
  - Turning jolt: p90 21.3 → 1.7 °/s per frame, worst 61 → 5.3, none over 20.
  - Speed jolt: worst 195 → 19 units/s per frame.
  - Every demo path still stays clear of CS2's geometry and within its speed and pitch limits.
- **Freeze time:** a map camera shows a player only within ±36° of its yaw and ±28° of its pitch (CS2's view less the slow pan and a margin), within range, and in clear sight in the grid (else in a region it is aimed at). A path must show them at its start, middle and end. Team shots are framed from the players, as before.
- **Nade cams:**
  - **Players:** a camera only when an alive player within 800 units of the grenade, on its level, is in its frame.
  - **Length:** planned until `utilityAfterEffectMs` (2 s) after the grenade goes off, and at least `utilityHoldMs` (2.5 s).
  - **Hold:** for those 2.5 s the shot stays even after its opportunity is gone; only bomb urgency cuts away.
- **Free camera:** a player named during a cinematic that the director didn't ask for ends the shot, and the director then selects a player. What is on screen counts as unknown (`reselect`) until a selection is sent, and every selection from a free camera leaves it.
- **Frame cap:** Game options → **Cap CS2's frame rate** sends `fps_max` (60, 120, 144 or 240; default: CS2's own setting). An uncapped CS2 on high settings takes the whole graphics card; the HUD (and OBS) need some of it.

**Checked.**
- Path smoothness measured over all built-in paths at 60 fps; the demo-path clearance test.
- A freeze-time camera facing away from the players is never chosen.
- No nade cam for a grenade with nobody near it.
- A nade cam stays 2.5–4 s after the grenade went off.
- A player change during a nade cam, with the game data naming players in the free camera, leads to a player selection within 0.3 s. The test fails without the fix.
- The frame cap's console line.

**Not checked.** In CS2 on the owner's PC; which CS2 builds name a player in the free camera.


## ADR-055 — Vector and Lineup: two original broadcast HUDs with commercial-grade motion

**Context.** The owner (0.9.x) sent two commercial CS2 HUDs, one with team columns at the sides and one with all ten players along the bottom: "Can you make copies of these huds and design them with all Animations as close as possible but keeping a different design aspect to them."

**Decision.**
- **What is copied:** layout, sizes, positions, colour treatment and motion. The first versions had a deliberately different look (dark panels with thin team-colour stripes); the owner found them nothing like the references, so both were redone to match them closely. Every component was measured from the recordings and checked side by side with them. No artwork, logos, branding text, code or fonts come from the references, and their names appear nowhere in the product. The timings were measured frame by frame from the owner's screen recordings:
  - **Going live:** the loss-bonus pills tuck into the score bar (about 200 ms), the series strip wipes away right to left (about 270 ms), and the players-alive box slides in from the right (about 150 ms, starting about 70 ms after the clock flips).
  - **A kill:** the victim's card goes dead within about 100 ms, and about 100 ms later the killfeed row slides in (about 120 ms).
  - **Round won:** in the side-column HUD, a winner card fades and scales in under the bar (about 180 ms). In the bottom-row HUD, a panel in the winner's colour grows from the centre of the score bar over the whole bar (about 200 ms), then the winner's logo comes in (about 60 ms later).
- **Vector** (side columns) and **Lineup** (bottom row) are separate HUD packages in `apps/hud-designs`, one Vite build per HUD. They share the demo scenes, the format helpers, and the HUD renderer's weapon silhouettes, glyphs and radar.
  - **Vector** (Montserrat, bundled with the Pro CS2 HUD; OFL):
    - a score bar of solid team-colour halves and a dark clock block;
    - player cards with a photo slot, a team-colour band and a dark stats area;
    - solid loss-bonus pills;
    - a solid two-colour players-alive box;
    - outlined killfeed rows.
  - **Lineup** (Barlow Condensed):
    - a title bar with series tabs;
    - a near-black score bar with team-colour ends;
    - a sponsor box;
    - small solid team-colour cards with the portrait standing above each card.
  - **Different from the references:**
    - our own icons and fonts;
    - a neutral silhouette where a player has no photo;
    - a monogram or wordmark where a team has no logo.
- **Bundled:** both are installed into the library on first start, like the Pro CS2 HUD: electron-builder copies `dist/vector` and `dist/lineup` into `sample-huds`, and the engine's dev folders include `apps/hud-designs/dist`.
- **Performance** (the owner's imported HUD lagged):
  - Only transform, opacity and clip-path animate.
  - No backdrop-filter and no large blurred shadows.
  - The only loops are the planted-bomb pulse and the radar's bomb ping.
  - Only the round clock and the bomb bar re-render ten times a second; player cards are memoised.
- **Tools:**
  - `?demo=<scene>` and `?demo=cycle` show built-in sample states.
  - `scripts/shots.mjs` records the scenes and the transitions.
  - `scripts/thumbnail.mjs` writes each package's library picture (the browser encodes the WebP).

**Checked.**
- Typecheck, lint, and a build of both packages.
- The bundled-package tests: valid manifests, settings defaults and thumbnails; the built packages install as they are.
- The six demo scenes and every transition at 1920×1080, including slowed-down frame sequences for the timings.
- Both HUDs served by the real engine on its test data for 85 s (freeze time, kills, bomb plant, round loss, next freeze time): radar, labels and every panel showed, with no page errors.

**Not checked.** On the owner's PC over CS2 and in OBS.

**Not available from game data.**
- Round damage on a dead player's card: Lineup shows kills this round, and ADR when it is validated.
- Defuse progress: the defuse bar keeps showing the bomb's time.

## ADR-056 — getpos, not the game data, confirms first person after the free camera

**Context.** The owner (0.9.5, Mirage, support file): "when cinematics finished it cuts to freecam underneath a player."

**Findings** (director log 01:12–01:16 and engine log).
- **Every return to a player after an HLAE cinematic** was `spec_mode 4; spec_player "<name>"`.
  - The game data never confirmed the player.
  - The director's retries (`spec_player` alone, every 1.5 s, five different players) failed for up to 9 s.
  - It ended only when the operator took over in CS2. After that, every `spec_player` was confirmed in 30 ms.
- **The cause, at 00:51:33:** "console camera modes learned: spec_mode 4 / 5 / 6" (CS:GO's numbering) was saved over CS2's 2 / 3 / 4, which `getpos` had confirmed on 28 October.
  - The adapter had tried `spec_mode 4` to leave the free camera, and the game data then named a player.
  - On this build that doesn't mean first person: CS2's `spec_mode 4` is the free camera, and `spec_player` in the free camera moves it to the player's feet while the game data names a player.
- **Why it was never corrected:**
  - HLAE shots counted as confirmed cameras, so `getpos` never checked CS2's own numbering again.
  - Retries dropped the in-eye command once the first one had been sent.

**Decision.**
- **getpos decides:** after a selection that leaves the free camera, `getpos` is read twice (from 0.3 s) and compared with the players' positions from the game data.
  - **First person:** the game data names the player and the camera is at their eyes (24–96 units up, within 96 across).
  - **Still free:** the camera is at a player's feet (within 48 across and 16 up or down).
- **Still free:** the other numbering's in-eye command is sent with the same `spec_player`; the one `getpos` confirms is kept and saved for all three modes.
- **Neither confirmed:** the first command is restored, the next selection still carries it, and the check is off for the session.
- **Game data:** with player positions, a player named in the game data no longer teaches the numbering.
- **Retries:** they carry the in-eye command until first person is confirmed.
- **HLAE shots:** they no longer count as a confirmed console camera.

**Checked.** A stand-in CS2 with CS2's numbering, whose game data names the previous player while the free camera sits at a player's feet, the CS:GO numbering saved and HLAE drawing the shot. Before the fix the camera stayed in the free camera (`spec_mode 4`); now it is in first person within about 1 s, the CS2 numbering is saved, and the next return goes straight to `spec_mode 2`. Also: retries keep the in-eye command, and the check turns itself off where neither number shows first person. The director and console end-to-end tests pass.

**Not checked.** In CS2 on the owner's PC. That `getpos` in first person reads the eyes rather than the feet is taken from the earlier chase-view checks; if it doesn't, the check finds neither, and turns itself off after one round.

**For the owner:** the wrong numbering saved on the owner's PC is corrected the first time a cinematic ends after the update (the free camera shows for about half a second once).

## ADR-057 — Account sync: an organisation's people, matches and imported HUDs on all its computers

**Context.** The owner: "I want it so the Players, Matches & imported CS HUDs are linked to each account via the database, so it can be seen on multiple PCs at once." Decided with the owner: shared by the whole organisation the program is signed into.

**Decision.**
- **Items:** each shared local record is one item, keyed by kind and its local id (the same id on every computer). Kinds:
  - team, player, roster entry, event, match, map, veto;
  - asset: the logos and photos those records use;
  - hud: imported HUDs with their settings. Bundled samples and the built-in HUD come with the program and aren't shared.
- **Files:** HUD packages and pictures are blobs stored once per organisation by SHA-256. Limits: 60 MB a file, 2 GB an organisation (`MF_SYNC_QUOTA_BYTES`), 256 KB a record.
- **Website** (migration 6):
  - **Seq:** every change gets the organisation's next seq, under a lock on the organisation's counter row. Seqs are strictly increasing and commit in order, so a computer reading with a cursor never misses one. Checked on Postgres 16 with six computers pushing at once.
  - **Last edit wins:** a change based on an older seq loses to a later edit, and the newer version goes back to the sender.
  - **Deletes** are kept as tombstones.
  - **Unused files** are removed after an hour.
  - **Uploads** are read only after the computer's credential is checked, within the limit.
- **Program** (local migration 4, `sync_state`):
  - **Finding changes:** every 3 s, and 1 s after a change through the program's API, current records are compared with what was last agreed with the organisation. This catches every way a record changes: forms, imports, the API. Only the changed records go out.
  - **Pulling:** the organisation's changes are fetched every 5 s and applied in a transaction. Their files are fetched first, and the stored hash keeps them from being sent back.
  - **Offline:** edits wait until the website is back.
  - **A computer that already has data:** it fetches the organisation's records first. A player with the same SteamID, or a team with the same name, takes the organisation's record and every reference is rewritten. Empty fields are filled from the local copy.
  - **HUDs:** a deterministic zip of the installed files, uploaded once. Settings changes reuse it. They install under the same id on other computers, which keep their own tokens and outputs.
- **Switch:** Settings → Account → **Shared with <organisation>** (on by default), with status and **Sync now**. The website's organisation page shows what is shared and the storage used.

**Checked.**
- Website: 13 end-to-end tests (seq order under concurrent pushes, last edit wins, tombstones, file hashes, limits and quota, organisation isolation, clean-up, the members' page) and the Postgres integration test.
- Program:
  - 12 unit tests (finding changes, applying, merging with reference rewriting);
  - 10 end-to-end tests with three computers on a stand-in website (records, edits, deletes, HUD install and settings, offline edits, conflicts, first-sync merge);
  - two computers on the real website code (PGlite).
- An older website without sharing: the program says so and carries on.

**Not checked.** On the owner's computers and the deployed website (it needs a redeploy; a proxy in front must allow 64 MB requests). Last edit wins goes by each computer's clock. Records that were already shared twice under different ids are not merged.

## ADR-058 — Series boxes, HUD images for every HUD, and Matchframe's clean radar

**Context.** The owner (0.10.0):
- The two small boxes next to each score in the reference HUDs are best-of boxes: "Best of 3 it would be 2… best of 5 there would be 3… best of 7 … 5 on each side."
- They sent radars, agent pictures, map logos and pictures and a dead-player icon to use "for any and all other huds".
- They came from kaiHUD's package. Its eight radars are byte for byte the Lexogrine radars Matchframe already bundles (MIT), so they stay in use. The other pictures and icons are not in Matchframe; like kaiHUD's code, they aren't put in it. The owner chose upload slots for them.

**Decision.**
- **Series boxes** in Vector (the capsule at each end of the score bar, replacing the timeout ticks) and Lineup (between score and logo):
  - Bo1 1, Bo3 2, Bo5 3, Bo7 5 (the owner's choice), else ceil(n/2), none without a series.
  - Filled per map won.
- **HUD images** (setting `hud.art`, asset ids): up to 5 CT and 5 T default player pictures, a logo and picture per map, a dead-player icon.
  - They reach HUDs as `HudState.art` (`/assets/<id>`).
  - Player n of a side (observer-slot order) takes picture n, cycling.
  - Used by Vector, Lineup, the Pro CS2 HUD and the built-in Broadcast HUD. LHM HUDs keep their own.
  - Per computer: account sync doesn't carry program settings.
- **Clean radar** (`HudRadar.cleanUrl`):
  - **Source:** an SVG drawn from Matchframe's map packs: walkable cells, floor heights, collision grids for wall placement, bomb-site regions.
  - **Frame:** the same as the radar background the markers use: built-in calibration per layer (Nuke and Vertigo with both levels), operator calibration, or the outline frame.
  - **Style:** navy `#262f40` floor, `#34405b` lower level, light walls, red bomb sites, transparent around. No site letters, like the owner's reference.
  - **Serving:** drawn once per map and frame, then cached.
  - **Where it's used:** first Vector and Lineup used it for every map. The owner wanted the radars they had sent, which are byte for byte the bundled Lexogrine radars (MIT), so every bundled HUD shows the radar image, and this drawing only for a map without one (Anubis, Cache), in place of the outline.
- `HudPlayer.roundDamage` from the engine's player state; Lineup's dead cards show it.

**Checked.**
- Bomb-site centres of all ten maps, through the markers' transform, land in the drawn sites on the right level. A calibrated Dust II matches the built-in one within 4 px.
- The HUD images routes and their effect on HUD state.
- Series boxes at Bo1/3/5/7 and the art in both HUDs (screenshots).
- The renderer and Pro CS2 HUD tests.

**Not checked.** In CS2 and OBS on the owner's PC. Wall outlines come from 64-unit navigation cells refined by the collision grid, so they're smoother than the cells but not traced like a hand-made radar. On Nuke's upper level, floors at different heights merge into one shape.
