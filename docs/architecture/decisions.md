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
