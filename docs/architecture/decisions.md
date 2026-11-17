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
**Decision.** Built-in HUD with three original presets (Classic, Minimal, Arena) over one widget system; fonts Inter and Barlow Condensed (OFL-1.1) bundled via @fontsource 5.3.0 (no remote fonts). No designs, names or assets of other HUD programs are used; the commercial HUD program consulted is under a proprietary EULA and was used only as a functional reference for workflow breadth.

## ADR-014 — Replay: provider interface, honest angles
**Decision.** `ReplayProvider` (services/replay-agent) with an OBS replay-buffer provider (program angle only; save confirmed by OBS's `ReplayBufferSaved` event; clip facts from ffprobe) and a client for a documented bridge contract for the owner's existing replay tool. The tool's real API was not available, so that integration is **blocked**, not simulated.

## ADR-015 — Simulation is a separate, labelled source
**Decision.** The simulation source produces synthetic GSI on a synthetic test map (`de_synthetic`) through the normal ingest path. Every state and HUD snapshot carries `simulated: true`; HUDs and the operator UI show a SIMULATION badge; setup tests and camera validation refuse to record evidence while simulating; real GSI packets are not mixed into simulated state.

## ADR-016 — Hosted website and cloud API for accounts, billing and auto-director hours
**Context.** MatchFrame is sold as a downloaded desktop app plus a website that handles signup, billing and auto-director hours.
**Decision.** One TypeScript service (`services/cloud-api`) serves the API and the website (`apps/cloud-web`) from one origin, on Postgres via node-postgres (PGlite in tests and trials). Billing through Stripe Checkout, the customer portal and signed webhooks (applied once per event id); Stripe is the source of truth for subscription state. Computers link with an RFC 8628 device-code flow and receive a revocable device token. The website issues Ed25519-signed licences (24 h validity, 7-day offline grace) that the desktop verifies offline against keys pinned into release builds. The desktop meters automatic direction locally and uploads idempotent usage records; the server keeps the allowance and debits credits under a per-organisation lock. Prices, plans and included hours are editable placeholders.
**Product rules.** Everything except automatic direction on live telemetry works without an account or internet. A billable second requires automation to own a real camera on live, non-simulated telemetry. Hours never run out mid-map: arming is gated, and when hours are used up automation hands back to manual at the next map change. No overage billing.
**Consequences.** The gate is a client-side licensing control, not DRM; the server-side usage record is authoritative for billing. Real Stripe, SMTP and hosting need the owner's accounts; they were exercised with the real Stripe SDK against a local API stub, the email outbox, and a real Postgres 16 server. Details: `docs/architecture/cloud.md`, `docs/operations/cloud-deployment.md`.

## ADR-017 — The operator console runs only inside the MatchFrame program
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
**Context.** The owner wants a HUD Library layout (inspired by common HUD programs) that opens into a library of HUDs stored on the computer, runs them as a transparent click-through desktop window over a borderless game, as a preview and as an OBS browser source, and works offline without an account.
**Decision.** See `docs/architecture/hud-library.md`. HUDs are copied into the per-user data folder (`%APPDATA%\MatchFrame Esports\huds\<id>\<version>`), with library metadata and per-HUD settings in the engine database. The engine's HUD server serves one output page per HUD and variant (`/hud/<id>/<variant>?t=`), a trusted transparent wrapper that scales the HUD frame uniformly from its design resolution and follows a control socket (stop, global hide, reload). All outputs subscribe to the same processed state. The program opens each desktop HUD in an independent transparent, frameless, always-on-top, non-focusable, click-through window with no preload, and adds preview windows, hotkeys and a tray.
**Consequences.** Desktop HUDs target borderless windowed games; exclusive fullscreen is out of scope. Real-pixel transparency, click-through and focus are checked on the Windows runner; real CS2, real OBS and multi-monitor/mixed-DPI placement remain manual checks.

## ADR-021 — Signing in is optional; the Auto Director needs an account (supersedes the gate in ADR-018)
**Context.** The owner's HUD Library requirements say the core library and runtime must work without internet access or an account, which conflicts with ADR-018's sign-in screen at start.
**Decision.** The program opens straight into the HUD Library. Signing in moves to Settings → Account (same email-and-password and code flows, same licence, offline grace and computer limit). Without an account everything works except automatic direction on live matches (the Observer modes), which the existing arming gate already refuses with "sign in" (HTTP 402); the simulation stays free. Being signed out on the website mid-session still only shows a notice. `MATCHFRAME_SIGN_IN` remains for the engine's sign-in state but no longer gates the console.
**Consequences.** Computers count towards the plan's computer limit only when signed in. Licensing still controls the paid feature (auto-director hours), not HUDs.

## ADR-022 — Built-in minimaps and an estimated GSI killfeed in every HUD
**Context.** Only four maps had generated outlines, so the minimap was missing on Mirage, Dust II, Nuke, Train and Vertigo, and the killfeed showed deaths without killers or weapons. CS2 game state integration reports no kill events; every GSI HUD (the open-source CS2 HUD template included) pairs kills from counter changes.
**Decision.** (1) `assets/radars` ships MIT-licensed third-party radar drawings (THIRD_PARTY_NOTICES.md) for eight maps with their calibration (they match the game's overview files to a few pixels); the engine uses an operator-calibrated image first, then the built-in image, then the generated outline (Anubis). Nuke and Vertigo choose the upper or lower drawing by height. (2) The state package pairs one killer whose kill counter rose by N with N opposite-side deaths in the same update, carrying the killer's weapon in hand (unknown when holding a grenade), the headshot counter, a single same-side assister and whether the killer was flashed. These stay labelled estimates (`probable_kill_link`, evidence "estimated"; HUD kind `"probable"`); several killers in one update stay unpaired, and an unpaired death shows no killer. Wallbang, no-scope, through-smoke and flash assists are not in GSI and are not shown. (3) Every bundled HUD draws a minimap and killfeed in its own style; HUDs present probable kills like any GSI killfeed, without a per-row mark.
**Consequences.** Minimaps work on all active-duty maps without operator setup. A grenade or fire kill may show the killer's gun; the HUD state keeps `kind` and the docs say how kills are derived.

## ADR-023 — Import hud.json-format HUDs and run them in a HUD compatibility layer
**Context.** Many CS2 HUDs (the owner's kaiHUD among them) are built on a widely used MIT-licensed HUD template made for a commercial HUD program: a folder with `hud.json`, `index.html` and often `panel.json`. They don't use the MatchFrame HUD SDK. Instead they open socket.io on their own origin and expect that program's events and `/api` paths. The program itself is proprietary (ADR-013), so nothing of it can be reused.
**Decision.** (1) The HUD Library accepts a package with `hud.json` and `index.html` and no `manifest.json`, writes a manifest for it (id `imported.<name>`, category "Imported", `runtime: "compat"`, the live variant only; the ids and values written before 0.12.0 are in ADR-071) and turns `panel.json` into the HUD's settings form: text, checkbox, colour and select become settings; player and team inputs get pickers (`HudSettingField` types `player` and `team`, stored as ids); action inputs become buttons (`action`, never stored) sent with `POST /api/v1/hud/library/:id/action`. Image inputs and `keybinds.json` are not supported, and the import keeps going without them. Other games' hud.json HUDs are refused. (2) The HUD server implements the HUD side of the template protocol, written from the MIT-licensed template. socket.io on `/socket.io`: `readyToRegister` → `register` → `hud_config` (the settings in panel shape, sent again when settings change), `update` (every authenticated game-data packet as CS2 sent it, auth removed; the simulation's packets while it runs), `hud_action`, `match` (the current match changed) and `update_mirv` (MatchFrame's paired kills from ADR-022 as HLAE `player_death` events, because the template's killfeed listens only to those). `GET /api/...` serves the current match, teams with logos, players with photos and the built-in radars in the format's shapes; tournaments and player cameras answer empty. (3) The output page sets an HttpOnly SameSite=Strict cookie with the HUD's token, because such a HUD only adds `isProd=1` to its own URL and can't send the token itself. The socket and `/api` require that cookie. (4) Imported HUD files may load Google Fonts; nothing else is relaxed in the CSP. The output page shows a "TEST DATA" badge over imported HUDs during the simulation, because they don't draw MatchFrame's label.
**Consequences.** Imported hud.json-format HUDs import and run like any library HUD (desktop window, preview, OBS URL, settings applied live), with no other program or account. They show live data only, with no output delay. Their killfeed carries the ADR-022 estimates (no wallbang, no-scope, smoke or flash-assist icons), and kills made before the HUD connected are not replayed. Team names and logos come from the current match in MatchFrame. A HUD that depends on other features of the program it was made for (cameras, image inputs, keybinds, ACOs, its cloud) loses those parts.

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

## ADR-029 — HUD graphics timed to the shots, OBS scene automation, and imported HUD pages
**Context.** Graphics were operator cues or disabled example rules, and OBS scenes changed only by hand. The owner asked for graphics timed to the shots and OBS automation, and for kaiHUD's Player Highlight and Match stats panels to work.
**Decision.**
- **Graphics director** (`live/graphics.ts`, setting `graphics.auto`, on). It runs while the director has the camera:
  - **Freeze time:** the economy cue, then CS2's round MVP (whose MVP count went up).
  - **Player card:** after a player view held 6 s with no fight close. Only on a player view, removed when the view changes; 90 s cooldown per player, 25 s overall.
  - **Clutch:** a banner until the 1v2+ ends.
  - **Imported HUD pages:** shown by toggling their OBS browser sources. Player stats goes up for the MVP (after selecting the player in the HUD's settings), and never over another player's view, because kaiHUD shows the selected or the spectated player. Match stats goes up at half time and at the end of the map.
- **OBS automation** (`live/obs-auto.ts`, setting `obs.auto`):
  - **Scenes:** timeouts and pauses go to the BREAK scene, and map end to the STUDIO scene. Both go back when play resumes or the next map starts.
  - **Ownership:** only from the live scene, and only back from a scene it chose.
  - **Replays:** cut with a chosen OBS transition, and the previous one is restored after.
- **Imported HUD pages:**
  - **Pages:** hud.json `variants` are read at run time and offered as the HUD's pages, opened with `?view=<page>` (the HUD reads `variant`).
  - **Logos:** team logos are sent as an address that serves the image, which kaiHUD uses directly.
  - **Image inputs:** a new `images` settings field, sent as base64, as the format does.
  - **Settings form:** an imported HUD's form is read from its panel.json again, so already-installed HUDs get it.

**Consequences.** Freeze time, clutches, long holds, timeouts and map ends get their graphics and scenes without an operator. MatchFrame HUDs draw the cues, and imported HUDs get their pages through OBS. kaiHUD 1.0.2 was checked page by page in a browser against test data.

**Revisit if.** Operators want different timings, or an imported HUD's page needs a data source the layer lacks.

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

## ADR-031 — Cinematics that hold, lighter imported-HUD updates, and match graphics made by the program

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

**Decision (imported HUDs).** `compat-runtime.ts` sends the newest game data at most every 100 ms. An "urgent" change is sent at once: the spectated player, round or countdown phase, bomb state, alive players, map round/phase or score. CS2 sends up to 50 packets a second, and kaiHUD re-renders on each. Measured with kaiHUD's baseboard on a timeout:
- before: 50 updates a second and 25 % busy; at a sixth of the CPU's speed, 32 fps;
- after: 10 updates a second and 10 % busy; at a sixth of the CPU's speed, 55 fps.

**Decision (matches).** A Create match button whenever the form isn't open. The team pickers have **New team…**: the team is created with the match, once, so a match can be made from nothing.

**Decision (match graphics).**
- **Where they're made:** in the program's window (canvas), not in the engine. Node has no canvas; a native one would complicate the Windows build. The engine stores, serves and checks the files (`domain/match-art.ts`), in `<data>/graphics/<match id>/`.
- **When:** on create, on **Make again**, and on first opening the tab of a match made elsewhere.
- **What:** three 1280×720 thumbnails (Highlights, Full replay, Live), a 1920×1080 Up next card, and two 1920×1080 60 fps stingers.
  - **Designs:** original MatchFrame designs — team-colour halves, slanted logo cards with name bars, *VS*, a two-tone outlined headline in Barlow Condensed (OFL, already bundled for the HUD renderer).
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
  - obs-websocket v5 can't create transitions. The operator creates two Stinger transitions once, named `MatchFrame Stinger` and `MatchFrame Replay Stinger`.
  - MatchFrame sets their `path`, `transition_point` (900) and `tp_type` (time) by making each current, setting it, reading it back, and restoring the previous one. The replay one becomes the replay transition if none is chosen. Activating a match points them at its files.
  - OBS applies `SetCurrentSceneTransition` asynchronously: 91 of 200 immediate reads in OBS 30 still returned the previous transition. `setTransition` therefore polls until OBS reports the new one. Otherwise a settings change could go to the wrong transition, and a replay could be cut with the previous transition (a 0.5.0 bug).

**Consequences.**
- The director holds its shots through the console/game-data race, and freeze time shows the players' spawns once each.
- Every match has its broadcast graphics without any design tool.
- They depend only on the canvas in the program's Chromium. The stingers depend on OBS running on the same computer as the program, or the files copied there.

**Checked.**
- **Unit tests:** establishing shots on the real Mirage pack, the repeat and stale-data cases (each fails without its fix), the arbiter catch-up, OBS's late transition switch, the QuickTime structure, imported-HUD coalescing.
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
- The next recording of a wrong shot comes with what MatchFrame sent and saw.

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

Through MatchFrame in Chromium, the same kaiHUD ticks within 0.1 s of each second, within 0.18 s with the CPU slowed six times, and never stops for more than 67 ms at 4× slower. So the lag is in drawing the HUD on that computer (OBS's browser source), not in the game data.

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

**Superseded in part by ADR-034:** in CS2 `+left`/`+right` strafe the camera; every move is now sent by MatchFrame.

## ADR-034 — Team shots framed live, every move sent by MatchFrame, no wall at the lens

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
- Freeze time shows the teams the way a broadcast does, from where they actually stand, on every map, moving gently; a camera never moves unless MatchFrame sends the pose.
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
- **Number keys** (`observerKeys`): CS2 numbers observer slots 0–9, the first team on 0–4; CS:GO and the synthetic data number them like the keys (1–9, then 0). The two are told apart by slots 0 and 1: on one team when counting starts at 0, on different teams when slots are keys. `PlayerState.observerKey` is the key: CS2's slot + 1, the tenth player 0, null without a slot. HUDs, Live Control, the director's intents and the Stream Deck use it. Imported HUDs get it as `observer_slot`. The format's own parser expects key numbering (it puts the team whose first player has the lower number on the left, with 0 counted as 10), so its left and right are now right on CS2 too.
- **Coaches** (`PlayerState.coach`):
  - detected by `detectCoaches`: a name with "coach" as a word, or, on a team listing more than five, a player with no slot or not alive in freeze time while five teammates are; forgotten once they are alive in a live round;
  - also the roster role Coach;
  - the operator's choice wins over both (`players.coaches` setting, Live Control buttons, `PUT /api/v1/live/players/:steamId/coach`).
  - Coaches get no number key; the team projections and the minimap, imported HUDs' game data, the director's candidates, the Auto Director's test target and the device number keys leave them out.

**Checked.**
- Number keys for both numberings, and in the match state for a CS2-numbered game.
- Coach detection, the roster coach and the operator's override.
- imported HUDs' game data: renumbered, coaches dropped, raw packet untouched.
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

**Context.** The owner: other HUD programs use HLAE for all their cinematic shots; use HLAE for every free-camera and moving shot, since it is more stable and better. The console method has to:
- get CS2's spectator mode numbers right (ADR-039, ADR-040);
- resend positions and check them with `getpos`;
- send up to 128 `spec_goto` lines a second for a move, at the mercy of console timing.

ADR-045's `mirv_campath` option only covered paths and relied on `edit start` following live time, which HLAE doesn't document.

**Decision.**
- **The script:** HLAE for CS2 runs JavaScript (mirv-script, from HLAE 2.162). MatchFrame writes a small script, `observer-agent/src/hlae-camera.ts` → `<data>/hlae/matchframe-camera.js`, and loads it with `mirv_script_load` whenever the console connects in the HLAE launch mode.
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

**Context.** The owner: player face cams, as other HUD programs offer them. A website page opens to the match being played; the player picks themselves, then their camera, sees a preview, approves and sends. The production delays the cams as long as it needs, to cover the CSTV delay.

The hud.json template's camera protocol (MIT; THIRD_PARTY_NOTICES.md) is the model:
- the HUD reads `/api/camera` (players, a room id) and emits `registerAsHUD`;
- it receives each player's video as a WebRTC offer (`offerFromPlayer`) and plays the stream simple-peer gives it.

WebRTC alone can't delay video by minutes.

**Decision.**
- **The page:** `/cam/<room>` on the MatchFrame website, public, no account.
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
- **Imported hud.json-format HUDs:**
  - the HUD server puts `cams.js` and `compat-cams.js` into their pages, before their scripts;
  - `/api/camera` lists the match's players, and `registerAsHUD` gets `playersCameraStatus` and an `offerFromPlayer` per on-air cam (repeated every 3 s, which the HUD ignores while connected);
  - the offers carry a marker. The page's RTCPeerConnection (a wrapper) answers them locally and hands simple-peer the cam's MediaStream, with no network connection; every other use is the browser's own.
  - A cam off air for 1.5 s fails its connection, so the HUD shows the avatar again and takes the next offer.
- **MatchFrame's HUD** shows the observed player's cam above their panel.
- **OBS:** `/cams/observed` and `/cams/player/<id>` (cams token).
- **The operator** (Cameras → Player cameras): switch on, the link (and a new one), delay, quality, auto-approve, and per player put on air, take off air, stop, with live previews. Plus the OBS addresses.

**Why not WebRTC end to end.** The delay needs the video kept somewhere: in the program, encoded, it's about 10 MB a player for two minutes. WebRTC would also need a TURN relay for players behind strict NATs, which costs the same traffic, and imported HUDs need a MediaStream in their own page either way.

**Checked.**
- Relay: room ownership, roster, first-keyframe rule, status and key requests, replacing and kicking, waiting for the program, bitrate cap, closing.
- Program end to end against the real website server: link and roster, the operator's frames at once and the HUD's after the delay, at the filmed pace, off air and back from a keyframe, approval, stop, tokens, a new link.
- Chromium:
  - VP8 encoded in the page, through website and program, decoded on the OBS page (colour checked);
  - the imported-HUD shim given the calls simple-peer makes, and with simple-peer 9.11 itself (stream shown, ERR_CONNECTION_FAILURE off air), an ordinary RTCPeerConnection unaffected;
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
- **HLAE follows CS2:** when CS2 moves to another player under HLAE's view and it wasn't MatchFrame's selection, the adapter stops HLAE drawing, so that player is shown.
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
- **The cause:** HLAE's CS2 hook passes `absTime = g_MirvTime.absoluteframetime_get()` to `cViewRenderSetupView`. That is the frame's length in seconds (about 0.005 at 189 fps), not a clock. The MatchFrame script took it as a clock, so "time into the shot" stayed at about zero. Since 0.7.1, every HLAE shot (team glides, pause glides, pans, the demo paths) was drawn at its first key, and streamed shots never eased. The script's test fed `absTime` as a running clock, so it passed.
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

**Context.** The owner: "PC1 and PC2 should communicate and list the kills every round and structure it in best clips to replay to worst. Get the 3-4 best ones to replay and ignore the rest", with the replay PC going back and staying behind for every game, and a replay feed as other HUD programs have it: the delayed PC's screen over NDI (vMix Desktop Capture), recorded by the main PC, which switches OBS or vMix to the replays at the end of a round. The owner chose the NDI feed and OBS plus vMix.

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

**Alternatives.** NDI output of the replays (other HUD programs send their replay feed as an NDI source): OBS and vMix both play files, which needs no NDI plugin in OBS and gives frame-exact starts; an NDI output can follow for other mixers. Recording on the replay PC (OBS) stays as the fallback.

**Checked.**
- Ranking and break tests: unit, six clips in a round, the replay PC pending, a stand-in vMix.
- The replay PC filming a shown kill.
- The feed with a stand-in NDI source and real ffmpeg: cuts to the picture within 0.2 s; two programs with the replay PC marking and the main PC cutting.
- The Linux package carries the NDI binding.

**Not checked.**
- The real NDI binding receiving a real NDI source: this session's safety checks don't run third-party native code; the Windows release build checks that it loads.
- ffmpeg's hardware encoders on Windows.
- A real vMix.

## ADR-052 — Imported HUDs get game data 20 times a second; a low frame rate shows

**Context.** The owner (0.9.0): kaiHUD is "very choppy and feels like its running at 20fps", on an RTX 4060 and i7-14700K, and asked whether drawing the HUD on the CPU would take strain off the GPU.

Measured with kaiHUD 1.0.2 in Chromium through MatchFrame, with a player running across its minimap and 50 game-data packets a second:
- The page drew at 60 fps.
- At 10 updates a second (ADR-031's limit), the minimap dot surged and almost stopped ten times a second. Each update starts the template's 0.1 s eased transition (`.player { transition: transform .1s ease }`), so the dot's per-frame step went 0.46, 0.73, 0.47, 0.25, 0.12, 0.03 px and repeated.

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

## ADR-053 — An imported HUD that can't keep up gets fewer updates; radars for maps without one

**Context.** The owner (0.9.1): "All other huds aren't lagging but my imported hud is lagging real bad. And also Kaihud doesn't have Anubis radar supported."

- **The lag.** Measured with kaiHUD 1.0.2 in Chromium through MatchFrame, with realistic game data (full loadouts, two molotovs of 25 flames, three smokes, a flash in the air, the bomb carried, 14 rounds of history):

  | HUD (same game data) | Main thread busy |
  |---|---|
  | MatchFrame's default HUD | 12 % |
  | kaiHUD with no updates arriving (its animations alone) | 8 % |
  | kaiHUD at 20 updates a second | 31 % |

  - Its own script is about 6 % of that; the rest is styling and painting the page again for each update.
  - With the CPU 4× slower it drew 21 fps (42 with the measuring lighter).
  - On a computer also running CS2 (and OBS), the built-in HUDs have room and kaiHUD runs out first. 0.9.1's 20 updates a second made that worse.
- **Anubis.** kaiHUD bundles radars for nine maps (no Anubis) and asks the program running it for the rest (`GET /api/radar/maps`, `{ map: { config, file } }`), which MatchFrame answered with `{}`. MatchFrame has no Anubis drawing either (assets/radars, third-party MIT, has eight maps).

**Decision.**
- **Pacing (compat-runtime.ts `updatePacer`):**
  - **Measuring:** each output page pings itself every 100 ms and reports the 90th percentile of how long the ping waited (`lagMs`, with its frame report every 5 s). The HUD in its frame shares that main thread.
  - **Slowing down:** from `BUSY_LAG_MS` (15 ms) the HUD's interval doubles, after a full report at the new pace (20, 10, then 5 a second).
  - **Speeding up:** under `CALM_LAG_MS` (6 ms) for three reports it halves again; after a slowdown, for twelve reports (a minute), so a page that can't keep up at 20 doesn't swing.
  - **Calibration:** 0.1 ms at full speed; 11, 18 and 27 ms with the CPU 2, 3 and 4× slower. The wait is used rather than the frame rate, because an OBS canvas at 30 fps would read as a slow page.
  - **Scope:** the busiest of a HUD's outputs decides. Each page connection has its own feed at its HUD's pace (its registered name, else its only HUD cookie).
- **Radars from outlines (outline-radar.ts):**
  - **What's drawn:** for a map with a map pack and no radar drawing (Anubis, Cache), a 1024 × 1024 SVG of the pack's outline cells (where players stood in pro demos, 64 units), dark like kaiHUD's radars, bombsites in red, A and B lettered.
  - **Calibration:** MatchFrame's schematic transform: origin = (−minX, maxY) × 1024/size, pxPerU = ±1024/size.
  - **Where:** `/api/radar/maps` for older template HUDs, `/api/game-maps/cs2` for newer ones, image at `/api/game-maps/cs2/image/<map>/radar`.

**Alternatives.**
- **A fixed lower rate for imported HUDs:** gives up the smooth minimap on computers with room.
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

## ADR-058 — Series boxes, HUD images for every HUD, and MatchFrame's clean radar

**Context.** The owner (0.10.0):
- The two small boxes next to each score in the reference HUDs are best-of boxes: "Best of 3 it would be 2… best of 5 there would be 3… best of 7 … 5 on each side."
- They sent radars, agent pictures, map logos and pictures and a dead-player icon to use "for any and all other huds".
- They came from kaiHUD's package. Its eight radars are byte for byte the third-party MIT radars MatchFrame already bundles, so they stay in use. The other pictures and icons are not in MatchFrame; like kaiHUD's code, they aren't put in it. The owner chose upload slots for them.

**Decision.**
- **Series boxes** in Vector (the capsule at each end of the score bar, replacing the timeout ticks) and Lineup (between score and logo):
  - Bo1 1, Bo3 2, Bo5 3, Bo7 5 (the owner's choice), else ceil(n/2), none without a series.
  - Filled per map won.
- **HUD images** (setting `hud.art`, asset ids): up to 5 CT and 5 T default player pictures, a logo and picture per map, a dead-player icon.
  - They reach HUDs as `HudState.art` (`/assets/<id>`).
  - Player n of a side (observer-slot order) takes picture n, cycling.
  - Used by Vector, Lineup, the Pro CS2 HUD and the built-in Broadcast HUD. Imported hud.json-format HUDs keep their own.
  - Per computer: account sync doesn't carry program settings.
- **Clean radar** (`HudRadar.cleanUrl`):
  - **Source:** an SVG drawn from MatchFrame's map packs: walkable cells, floor heights, collision grids for wall placement, bomb-site regions.
  - **Frame:** the same as the radar background the markers use: built-in calibration per layer (Nuke and Vertigo with both levels), operator calibration, or the outline frame.
  - **Style:** navy `#262f40` floor, `#34405b` lower level, light walls, red bomb sites, transparent around. No site letters, like the owner's reference.
  - **Serving:** drawn once per map and frame, then cached.
  - **Where it's used:** first Vector and Lineup used it for every map. The owner wanted the radars they had sent, which are byte for byte the bundled third-party radars (MIT), so every bundled HUD shows the radar image, and this drawing only for a map without one (Anubis, Cache), in place of the outline.
- `HudPlayer.roundDamage` from the engine's player state; Lineup's dead cards show it.

**Checked.**
- Bomb-site centres of all ten maps, through the markers' transform, land in the drawn sites on the right level. A calibrated Dust II matches the built-in one within 4 px.
- The HUD images routes and their effect on HUD state.
- Series boxes at Bo1/3/5/7 and the art in both HUDs (screenshots).
- The renderer and Pro CS2 HUD tests.

**Not checked.** In CS2 and OBS on the owner's PC. Wall outlines come from 64-unit navigation cells refined by the collision grid, so they're smoother than the cells but not traced like a hand-made radar. On Nuke's upper level, floors at different heights merge into one shape.

## ADR-059 — A break's replays back to back, in round order, with one cut in and one out

**Context.** The owner: "Replay feeds seem to be cutting back to main feed and back to replay when it's done, when I want it to play the clips in order from start of round to end of round from the round that just concluded." Since ADR-051 the break picked one clip at a time, best first, and cut to the replay scene and back to live for each.

**Decision.**
- **Choosing:** once the break's replays start (after the wait for the replay PC's last kills), the clips are chosen in one go by the same rules (rank, duplicates out, up to `perBreak`, lead-ups shortened to fit, speed counted), now for one cut in and out (`CUT_MS`) plus `SWITCH_MS` (0.4 s) between two clips (`planBreak` in replay/rank.ts). Before each clip the time left is checked again; a clip that no longer fits is shortened again or skipped.
- **Order** (`order`, default `round`; `best` keeps ADR-051's order): a clip's place is the time of its first kill as the main PC saw it (`roundKills`, one clock for every origin). Clips from the replay PC carry no match time (`matchTimeFromMs` is null), and their `createdAt` is when they arrived, seconds late. Without a seen kill (a clutch): `createdAt` less the clip's part after its lead-up.
- **One sequence:** one cut to the replay scene, the clips back to back, one cut back. The program stays in `REPLAY_PLAYING`; `ProgramArbiter.request` for the same mode with another clip now changes `activeReplay` (and the owner, at equal or higher priority) without a mixer action. So a clip played by hand over the break's replays is seen as the operator taking the program. The round going live or automatic replays turned off: stop and cut to live. Someone else changed the program: left alone. A clip that fails is skipped; if none plays, back to live.
- **OBS:** one media source, as before, so existing replay scenes work.
  - The first clip is loaded before the cut and, when OBS plays it hidden (the set-up source does), skipped to its part, so the cut opens on it. A source that plays only when shown, or restarts then (OBS's default for a new Media Source), is skipped after the cut.
  - Each next clip is loaded as soon as OBS reports the one before ended, then skipped to its part.
  - **Measured** (OBS 30.0.2 on Linux, Xvfb, recordings read frame by frame): one black frame (OBS clears the source on a new file), then about 3 frames at 30 fps of the next clip's first frame before the skip lands. About 0.13 s.
  - **Keyframes:** `SetMediaInputCursor` lands on the keyframe before the target, so a clip starts up to one keyframe interval early. The watch takes its end from OBS's cursor, allowing up to 10 s more than planned, and moves on if the cursor stops for 1.5 s. Before, a clip could be cut by the fixed deadline (part + 2.1 s) before its end.
  - **Found on the way:** OBS answers the first status after a new file with a duration of -9223372036854776, so the duration is awaited, with the clip's probed one as the fallback. The old first-clip `restart` after the cut could race the skip (the status read before OBS restarted), and the whole clip played from its start.
- **vMix:** the next clip is added (`AddInput`, `SetPosition`, `SetRate`) while one plays, then `Play` and `CutDirect` to it. The chosen transition is used only to the first and back after the last. Inputs are removed afterwards, except one on air.
- **Status:** "Replay 2 of 3: <label>"; afterwards how many played and why any didn't.

**Alternatives.** Two media sources alternating visibility would hide OBS's load and skip completely. But a second source has to match the first's position, size and crop, which users set by hand on their replay scene and the OBS adapter can't copy, and the hand-play route and existing scenes use one source. At about 0.13 s that wasn't worth it.

**Checked.**
- Planner unit tests.
- The arbiter's clip switch.
- The break with a stand-in OBS (`replay-break.e2e.test.ts`): best first; round order from the main PC's kills; one cut in and out; a failing clip skipped; the round going live; the operator taking the program; the replay PC wait.
- A stand-in vMix (two clips, Fade in, CutDirect between, Fade back).
- Against real OBS 30: the replay integration tests, and recorded three-clip breaks with 720p30 and 1080p60 clips and both media-source settings.

**Not checked.** Windows OBS and a real vMix. Clips from a real replay buffer with long keyframe intervals on air.

## ADR-060 — Replays to 1:50 on the next round's clock, fading through a twin of the replay scene, chosen transitions, and a clip's round from the game

**Context.** The owner, on 0.10.4's breaks:
- "You can keep showing replays up until 1 minute 50 seconds round timer after round starts to cut back."
- "The clips need to fade together when transitioning clips."
- "Can you organise that the app can select a stinger transition for replays and for transitioning to other screens. Replay transition and replay transition out."
- "Make sure that any replays that weren't shown the previous round aren't shown the next round. As I had a replay from 2 round prior come into the round that just completed replay."

Before, a break ended 1.5 s before freeze time ended, and stopped the moment the round went live (ADR-059). One media source switched files between clips: one black frame and about 0.1 s of the next clip's first frame. One OBS transition (`obs.auto.replayTransition`) went in and out, and was put back 1.5 s later, cutting a longer stinger. A clip's round was the engine's `roundNumber`, CS2 GSI's `map.round + 1`, which moves on when a round ends.

**Decision.**
- **The break's end** (`cutBack`, default `clock`; `cutBackClockSec`, default 110 = 1:50; `before_round` keeps ADR-059's):
  - **In the next round:** its own clock (the phase countdown is the time left): the cut back to live starts by 1:50, 250 ms early (the engine looks every 25–100 ms). The bomb down (phase `bomb`/`defuse`; without a phase countdown, the bomb's own state) or the round already over: now.
  - **Before it:** freeze time's end (the game's countdown; in the over phase its end plus 15 s assumed) plus the round time less 1:50. The round time is the clock when a round goes live straight after freeze time, rounded to the second; 115 s until then. A server whose 1:50 comes before the round starts gets its break's end then.
  - **The break's state lives on into the round:** while its replays play, the round going live no longer clears the break (round, clips chosen, clips played); it ends when they do. The tick never starts a break's replays once the round is live: only the cut to the replays is restricted, not their running on.
  - **The planner** (`planBreak`, `fitNow`) gets the time to that end: about 6 s more. **The replay PC wait** is unchanged (8 s at most, never under 16 s left): with the longer time, 15 s of freeze time no longer cuts it to about 1 s, and PC 2's last clip (about 10 s after the round ends) comes inside it.
- **A clip's round:**
  - **Fix:** `Engine.playRound()`: the round being played, or in the over phase the round last seen live (session state, kept in the engine's state handler; reset on a map change; null in the over phase when no live round was seen). Used for the main PC's kills (`onAir.noteKill`, which the replay PC files its clips under), automatic replays' own kills and big plays, the replay PC's own kills (`link.ts`), bookmarks (API, devices, rules).
  - **A hard rule** whatever a clip says (`AutoReplay.never`): no automatic play for a clip with no round; one made before its round last went live (wall clock, 1 s slack: a round played again after a restart or a backup has the same number); or one of a round up to `closedThrough`. That is raised when a break's replays end (any reason) and set to the live round less one while no break runs (so it follows a backup back). The ranked list shows a clip of the round from before it started, or that came after the break's replays were chosen, as left, with a `note`.
- **Fading between clips: a twin of the replay scene** (`replay/twin.ts`).
  - **The twin:** "<replay scene> B" (or "B 2"… when taken), recorded in `replay.twin` with the scene and source it copies. Every item of the replay scene added as the same source (`CreateSceneItem`, shared), with its transform (`writableTransform`: OBS refuses bounds under 1 px), visibility, lock, blend mode, in the same order; the replay media source replaced by a twin input "<source> B" with the same settings, filters (`GetSourceFilterList`) and audio (volume, mute, monitoring, balance, sync offset, tracks).
  - **Kept the same:** compared and rebuilt off air (never while the twin or the replay scene is on program or in preview) at the start of each break and by `/api/v1/replays/obs-setup`; nothing is touched when nothing changed. A twin of another replay scene is removed.
  - **Both media sources** get `restart_on_activate`, `close_when_inactive` and `clear_on_media_end` off (and the twin `looping` off): a clip waits paused at its part off air and must not restart when the fade shows it, and the outgoing one holds its last frame if it ends a moment before the fade does. The user's own source is changed too: OBS's defaults for a new Media Source restart on show and clear at the end, which would show a clip's first frames at the start of every other fade. The post-show check of ADR-059 (skip to the part if it restarted or never played hidden) stays for both.
  - **The break:** the first clip is loaded in the replay scene, held (`pause`) and skipped to its part off air, and played once the transition in shows the scene (a Stinger's transition point, `ObsAutomation.cutPointMs`). While a clip plays, the next waits the same way in the other scene, loaded once the fade out of it is over. One fade length (`fadeMs`, 500) before the clip on air ends, taken from OBS's cursor (a cursor that jumps back is ignored), the next plays and the program switches to its scene with OBS's Fade, found by kind (`fade_transition`), for `fadeMs`; with `between: "cut"`, OBS's Cut as the clip ends. The arbiter stays in `REPLAY_PLAYING`; the clip on air (`activeReplay`) changes. Without a twin (no media source directly in the scene, not a Media Source, OBS refused): ADR-059's one source.
  - **The twin is the replay scene for the engine:** `ProgramArbiter.replayScenes` (the mapped one and its twin while it is the twin of that scene); automatic replays' check that OBS shows their replay takes both; `followMixerLive` and the OBS state handler only act on the live scene, so the twin never makes the program "manual" or "degraded". A break may end on either scene; the cut back works from both. In the support bundle: `replayScenes`, `twin`, `transitions`, OBS's program scene.
  - **Taking over:** besides the arbiter's mode and owner, a program change made in OBS itself counts (`ObsAutomation.changesInObs`: a `SceneTransitionStarted` MatchFrame didn't ask for), even to a replay scene, as when the operator's Transition button in Studio Mode takes a replay scene from preview. Then nothing more plays and the program stays.
  - **vMix:** the next input is loaded already; one fade length before the one on air ends, `Fade` with `Duration` (`between: "cut"`: `CutDirect` at the end).
- **Transitions** (`obs.auto`: `replayIn`, migrated from `replayTransition`; `replayOut`, null = as `replayIn`; `otherScenes`; "" = OBS's own):
  - **Chosen centrally:** the arbiter's mixer port gets the change (`ProgramMove`: from, to). Into `REPLAY_PLAYING`: Replay in; out of a replay: Replay out; to or from `BREAK`/`STUDIO`: Other scenes; anything else: OBS's own. So a replay played by hand, Return live, the operator's program buttons and the OBS automation use them too. Between clips auto.ts asks `ObsAutomation.switchProgram` directly.
  - **OBS's own back:** saved before the first change (name and duration; a fixed transition's duration is read when a non-fixed one is made current), and put back once OBS reports `SceneTransitionEnded` for that change (a start must be seen first, so an older transition's end doesn't count), or after its duration (+1.5 s; 8 s for a Stinger). Not when another change came meanwhile (that one puts it back), nor when OBS's transition was changed by someone else meanwhile. Measured with OBS 30: `SceneTransitionEnded` comes after `SceneTransitionVideoEnded` and, for a Stinger, at the end of its video.
  - **The arbiter** ignores the mixer reporting the live scene while its own change is under way (OBS answers the scene before the transition is over): one history entry, not two.
  - **Match graphics:** the replay stinger becomes Replay in, and Replay out when that is OBS's own, where none is chosen.
  - **vMix:** `vmixTransition` is Replay in; `vmixTransitionOut` (null = the same) Replay out.
- **OBS Studio Mode** (measured with OBS 30.0.2, obs-websocket 5.3.4):
  - `SetCurrentProgramScene` transitions the program with the current transition and leaves the preview, but Swap Scenes (on by default) puts the scene the program left in preview at the transition's end. MatchFrame saves the preview before its first change and puts it back 150 ms after the end, when the preview is the scene left (not if the operator changed it).
  - Duplicate Scene: the program is a private copy with the same name (`GetCurrentProgramScene` says the original); its media source is the same source, and with Duplicate Sources too (a Media Source is never copied). Clips and fades were on program in both cases.
  - `GetCurrentProgramScene` answers the new scene at once; `CurrentProgramSceneChanged` comes at the transition's end.

**Alternatives.**
- **A second media source in the replay scene,** faded by animating a Color Correction opacity over the websocket: a crossfade at the websocket's rate, filters on the user's scene, and no OBS transition.
- **OBS's per-scene transition overrides** (`SetSceneSceneTransitionOverride`): they stay on the user's scenes, and apply to their own scene changes too.
- **Two MatchFrame-owned twins, the user's scene never used by a break:** no change to the user's media source, but two copies to keep the same, and the user's own scene never on air.
- **Waiting a fixed time before putting OBS's transition back:** ADR-059's 1.5 s cut a long Stinger.
- **Knowing a clip's round from the replay PC's own game:** it is behind, and its round number moves on the same way; the main PC's last live round is one clock for every clip.

**Checked.**
- Unit: the end's arithmetic (over, freeze time, timeout, live clock, no clock, bomb, defuse, the round over, another clock time, the old setting), learning the round time, the planner getting four 6 s clips by 1:50 where three fitted before (`replay-rank.test.ts`); the transitions chosen, OBS's own put back after the end, only after the last of quick changes, not over a transition chosen in OBS, Fade found by a translated name, OBS's duration learned behind a Stinger, the old setting migrated, a missing transition (`obs-auto.test.ts`); the arbiter's port moves, `replayScenes`, its own change not followed (`domain.test.ts`); the twin followed and live followed from it (`program-follows-obs.test.ts`).
- With the ADR-059 stand-in OBS (`replay-break.e2e.test.ts`): a break playing on into the next round and cut back by its clock (1.2 s after 1:51.2, within 0.4–1.5 s), a new round's clip not joining it, the third clip never played after; the bomb and the round over stopping it; the old setting; an earlier round's clip, a clip with no round and one from before a restart never played, and a late clip never played in the next break, with notes; a post-round kill and a bookmark under the round that ended; vMix with Fade 500 ms (0.5 s before the end) and a cut back, then with cuts.
- With a stand-in OBS at the obs-websocket level (`stand-in-obs.ts`, `replay-fade.e2e.test.ts`: real-time media playback, transitions with OBS 30's events, OBS's Media Source defaults, Studio Mode with Swap Scenes): the twin built and brought up to date (moved, added, hidden items, a filter); a break alternating, each fade starting 0.4 s before the end with the next clip at its part; a Stinger in and OBS's own out; cuts; the operator's scene in OBS left alone; the other-scene transitions by the automation and the buttons, Replay out after a hand-played replay; Studio Mode (preview put back after each swap, the Transition button to the twin taken as taking over); no twin.
- Against a real OBS 30.0.2 (Linux, Xvfb, recordings read frame by frame): a user-made replay scene (backdrop, scaled media source, score bug; OBS's defaults): 14 blended frames (0.47 s at 30 fps) per fade, no black frame, no clip-start frame, overlay and backdrop throughout; a transparent Stinger in with the first clip starting at its cut point, Fade out; cuts between; 1080p60 clips with 2 s keyframes and a filter on the media source; Studio Mode with a Stinger, the preview put back each time; the Transition button with the twin in preview seen in about 0.2 s; Duplicate Sources on.

**Not checked.** Windows OBS; a real vMix; a real CS2 round clock and its first live reading (the round time is learned from it); OBS's `fade_transition` on a busy GPU (here llvmpipe software rendering held 30 fps with 720p30 clips; with two 1080p60 clips the blend stepped every 4 frames).

## ADR-062 — The operator's controls of a break's replays, the replay sound and the live audio turned down, Test replays, and the operator's own OBS scenes

**Context.** The owner asked for:
- **Controls** while a break's replays play: Skip, Stop and go live, Hold / Resume (the 1:50 cut back still wins); Exclude and Pin first in the round's list; the same from a Stream Deck or Companion, global hotkeys and console shortcuts; vMix too.
- **Sound:** game sound on replays (the NDI replay feed recorded none: `hasAudio: false`), a replay volume, and the live game audio turned down during replays and put back exactly, however they end, also after a crash.
- **A Test replays button** playing sample clips through the real chain, with a report.
- And, during the work, from the coordinator: the operator switches most OBS scenes themselves with a multiview plugin (analysis between rounds, casters during the replays). MatchFrame must never fight that, nor get stuck on "the program isn't live".

**Decision.**
- **Controls** (`replay/auto.ts`):
  - *Skip* ends the clip on air (its watch returns `skipped`): the next one comes in as usual, already waiting at its part; after the last, back to live with Replay out. A Skip is tied to the clip on air when pressed.
  - *Stop and go live* (`stopped`) ends the break with Replay out. Pressed before its replays start, the break has none.
  - *Hold* pauses the clip on air (OBS's pause, vMix's `Pause`) and moves its end and its late-deadline by the time held. `interrupted()` is checked before the hold, so the round clock, the bomb and Stop still end it. Skip clears a hold.
  - *Exclude* and *Pin* act on the break's list of clips still to play (`Sequence.rest`, replacing the fixed list). `planBreak` takes a pinned clip first if it fits. During a break, the clip waiting off air (in the twin, or loaded in vMix) is replaced when the operator excludes it or pins another; a pinned clip that wasn't chosen joins the break. The watch's `onPoll` does this while the clip on air plays on.
  - The same paths serve Test replays. The console posts to `/api/v1/replays/auto/{skip,stop,hold}` and `PUT /api/v1/replays/auto/clips/:id`; the device actions are `replay_skip`, `replay_hold`, `replay_stop`, `replay_exclude` (`id`, `rank` or `next`) and `replay_pin`; the tally has `replay`.
- **Keys:**
  - Console: Ctrl+Shift+F5 / F6 / F7, on every screen (`lib/replay-keys.ts`), not while typing.
  - The program (`apps/desktop/src/replay-hotkeys.ts`): global hotkeys, off until set, saved in the program's settings, the same three suggested. CS2 and OBS don't use them by default.
  - A key another program holds is saved but reported (*… is already taken by another program (or Windows)*). The program's own hotkeys and duplicates are refused; CommandOrControl counts as Ctrl.
  - Pressed, a hotkey runs the device action through the engine's API, as a Stream Deck would; a notification shows only when it can't.
- **The replay feed's sound** (`replay/feed-core.ts`):
  - NDI's audio frames come with the video through grandi's `data()` (Float32Interleaved, unscaled), as 48 kHz stereo (`toStereo48k`: first two channels, linear resampling otherwise). They go to ffmpeg's second input (`pipe:3`, f32le) and into the segments as AAC 160 kb/s; clips cut with `-c copy` carry it (`hasAudio`).
  - **One clock:** before, list.csv's times counted from ffmpeg's stamp of the first frame, which it reads 30–60 ms after it is written while still starting, so clips were cut that much early. Now the video input is shifted back by the session's start (`-itsoffset -t0`, stamps kept with `-copyts`; 100 ms of lead so the AAC encoder's priming never moves the streams). The segments' times, the sound's sample 0 and the engine's mapping are then the same wall clock. Absolute stamps with `-copyts` alone broke ffmpeg's constant-frame-rate output and keyframe expression (`frame duplication too large`).
  - **AudioClock:** frames follow one another as the sender stamped them (NDI's `timestamp`, or `timecode`); a jump there is a real gap, filled with silence. Where the sound sits against the picture comes from the earliest arrivals of the last 3 s, so a stall in this process, which brings frames late and then all at once, changes nothing. It is moved when more than 60 ms off (drift). A source without sound is recorded with silence, keeping the muxer and the cuts on time.
  - If ffmpeg can't read the second pipe (not seen; possible on Windows), the recording goes on without sound and says why.
- **Live audio turned down** (`replay/audio.ts`):
  - The operator picks the OBS inputs (vMix keys) that are the live game sound; nothing else is touched, and never the replay sources.
  - As the first clip goes on air (beside the transition), their volume and mute are read and saved in the engine's settings (`replay.duck`) before any change, then ramped down in dB steps (300 ms) or muted. After the replays, however they end (`playObs`/`playVmix`'s `finally`), they ramp back and are set to the exact saved multiplier and mute.
  - A fader the operator moved meanwhile is left alone. What can't be put back stays saved and is retried when OBS connects and every 3 s, including at the next start after a crash. The engine's shutdown restores first, while OBS is still there.
  - vMix: `SetVolumeFade` (its fader is a fourth-power curve: −20 dB multiplies it by 10^(−20/80)), `AudioOff`/`AudioOn`.
  - The replay volume (dB, null = as set in OBS) is set on both replay media sources (vMix: each replay input's fader, its gain above 0 dB).
- **Test replays** (`replay/test-run.ts`):
  - **The clips:** two 4 s sample clips (1280×720 30 fps H.264 with 1 s keyframes and an AAC tone; blue *Test clip 1* at 440 Hz, orange *Test clip 2* at 660 Hz; about 90 kB each). Made with ffmpeg's lavfi `color`, `sine` and `drawtext`; bundled in `assets/replay-test`, the installer's `replay-test`, `MATCHFRAME_REPLAY_TEST_DIR`.
  - **Kept out of the match:** they are added *unlisted* to the replay queue (`ReplayQueue.addUnlisted`: found by id, so the replay graphic can show their play — Test Player, AK-47, headshot — but never in `list()` or `playlist()`, so never ranked, in a break or a highlight). They are removed afterwards; nothing is marked or audited as played.
  - **The real path:** they play through `play()` → `playObs`/`playVmix`, the same as a break (a `test` sequence: no round clock; a round going live stops it), traced (`TraceEvent`) for the report: ready, in, fade, out, back live, the audio exactly as before. `ObsAutomation.lastSwitch` names the transition used.
  - **When it refuses:** while a round is live, the program isn't live (or is the operator's scene), or a break's replays play or are about to.
- **The operator's own OBS scenes** (`app.ts`, `ProgramArbiter.followMixerScene`, `ObsAutomation.whose`):
  - *Whose scene:* a scene OBS shows is the operator's when a program change made in OBS itself (a transition MatchFrame didn't ask for) came after MatchFrame's last own change, or, with no change seen (OBS found so on connecting), when it isn't what the program shows. MatchFrame's own changes of the last 12 s, and its replay scenes and twin during its replays, are its own.
  - *What follows:* the program goes MANUAL, the operator's, holder `OBS: <scene>`, and nothing automatic can take it (automation is outranked). No replays cut in, no break or studio scene, no cut back. The live scene shown again: LIVE (`followMixerLive`).
  - *Status:* replays and Test replays *wait* with *OBS shows “Analysis” (your scene): …*, not *blocked*.
  - *Mid-break:* a break taken in OBS during its replays stops (the audio comes back). It is `resumable`: OBS back on the live scene before the next round is live plays what is left and still fits; Stop and go live cancels that. The break's round isn't closed meanwhile.
  - *Break and studio scenes:* obs-auto only takes back what it chose (the operator's mapped break scene is MANUAL, not BREAK).
- **Found on the way:**
  - OBS 30 can let a pause sent as a file starts go: the clip waiting in the twin then ran on hidden and came in near its end. In one real-OBS run the second test clip came in at 3.4 s of 4. Now `cueHeld` checks the pause holds (and sends it again), and a clip that still ran on is put back at its part before it goes on air.
  - The engine's storage of replay clips and of the feed's recording goes through `Engine.replayStorage()`, for a later setting to move them to another drive.

**Alternatives.**
- **The live audio by OBS's own sidechain compressor or ducking filters:** it reacts to sound levels, not to the replays being on program, and would need a filter on the user's inputs.
- **Hold by stopping the round clock:** impossible; the 1:50 deadline is the live round's.
- **NDI audio over a local TCP socket instead of `pipe:3`:** both work; the pipe needs no port, and a failure falls back to no sound with a message.
- **The sample clips generated with ffmpeg on the user's PC:** not every PC has ffmpeg.
- **The operator's scene as an error to clear with Return live:** the owner switches scenes on purpose.

**Checked.**
- Stand-in OBS and vMix (`replay-controls.e2e.test.ts`):
  - Skip: the fade 0.5 s after the press, the next at its part.
  - Stop; Hold for longer than the clip, then the 1:50 cut back while held.
  - Exclude and Pin, before and during a break; the device actions with a replay token; the tally.
  - The live audio down in steps and back to exactly 0.8 after every kind of ending, muted, a fader moved by hand, and after an engine lost OBS and was started again; the replay volume.
  - Test replays: refusals, a passing run (a Stinger in, the fade, out, audio), a failing step with its fix, vMix.
- `obs-own-scenes.e2e.test.ts` (stand-in OBS): the analysis scene between rounds (no replays, no break scene, Test refused), back on live with the break's replay played; back before the replays; the casters during them (stopped, audio back, the rest played on coming back in time; staying: no cut back, Stop and Test refused); the mapped break scene by hand; Studio Mode's Transition; found on connect.
- `replay-fade.e2e.test.ts`: a pause OBS lets go once (sent again) or six times (the clip put back), the next clip in at its part.
- `replay-feed.test.ts` (real ffmpeg, a stand-in NDI source whose tone switches every 0.5 s of wall time):
  - the cut clip's AAC track, in time with the source to 30 ms; the picture to the frame; a source without sound;
  - the clock's behaviour with jitter, a busy moment, a gap and drift; the channel and rate conversion.
- **Real NDI** (grandi with the NDI 6.3 runtime, a local sender found with `extraIPs`, real ffmpeg; a scratch script): the cut clip's tone at the sender's level, in time to within 20 ms.
- Console (`AutoReplays.test.tsx`), the desktop hotkeys (`replay-hotkeys.test.ts`), the OBS adapter's audio (`obs-adapter/test/audio.test.ts`), the planner's pin and vMix's fader curve (`replay-rank.test.ts`), following OBS (`program-follows-obs.test.ts`).
- **Real OBS 30.0.2** (Linux, Xvfb; the scratch script drove the engine's API):
  - Skip: OBS's fade to the twin started 0.13–0.17 s after the press.
  - Hold: the twin's clip *PAUSED* at the same cursor 2.5 s later, playing on from there after Resume, the next fade when what was left had played.
  - The live audio: an input at 0.8 (OBS: 0.800000011920929) down to 0.08 in steps, and back to the same multiplier, bit for bit.
  - Test replays: every step *OK* with the bundled clips (each on air about 4 s, the fade between).
  - Following: a scene put on by another obs-websocket client, and Studio Mode's preview and Transition, followed as the operator's; a round ending on it changed nothing; Test replays refused; back to live with the live scene.

**Not checked.**
- Windows (ffmpeg's second pipe, the global hotkeys).
- A real vMix (`SetVolumeFade`, `AudioOff`, `Pause`, its fader scale).
- A real Stream Deck or Companion.
- vMix Desktop Capture's, OBS NDI output's or NDI Screen Capture's sound over a real network.
- A real multiview plugin (its scene changes look like any change made in OBS, which is what is followed).
- The replay graphic with the sample clips (built separately, ADR-061).

## ADR-061 — A replay graphic on each MatchFrame HUD's replay page, and highlight reels from kept clips

**Context.** The owner asked for two things:

- While a replay is on air: a "REPLAY" tag and a lower third with the play (player, weapon, headshot, victims, 2K–ACE, clutch, round), in each MatchFrame HUD's own style.
- One button to export a map's best clips as one MP4 for social media.

The replay plays on OBS's replay scene, and the HUD's browser source is normally only in the live scene. The replay queue deletes clip files to save space: 200 items in memory, the replay PC's newest 120 files on disk.

**Decision.**

- **HUD state:** `HudState.replay.clip` (`HudReplayClip`), null when no clip is on air or the graphic is off (setting `replay.graphic.enabled`). `active` and `label` stay as they were.
  - **The clip on air:** the program's `activeReplay` in `REPLAY_PLAYING` (not `REPLAY_PREPARED`, still the live scene), else automatic replays' `playing` clip when they play in vMix.
  - **Pushed to HUDs:** a 100 ms watch pushes a new state when the clip changes (`Engine.refreshHuds`), not only with the next game data.
  - **Fields:** from the queue item's `play`; for a clutch (`reason` `clutch`), `play.kills` is the number of opponents.
- **Team:** as the HUD shows it (the player in `left` or `right`, with name, logo and colour). Else the roster's team (left or right by the active match), else the in-game team name.
- **Side in that round:**
  - The killer's side at a kill of that round, as this computer saw it (the killfeed's `killer.side`, kept per map).
  - Else the side kept with the clip.
  - Else the side now, moved to that round: the same half of regulation the same side, the other half the other side, halves of three rounds in overtime.
  - Otherwise null (across regulation and overtime, it depends on the server), and HUDs use the team colour.
  - HUDs colour the play by the team's own colour, else that side's colour.
- **Where it is drawn:** the HUD's `replay` entry point (`/hud/<id>/replay?t=…`). The page reads `variant=replay` (also `layer=replay`) from its own address and draws only the replay graphic, transparent elsewhere. The live HUD never draws it.
  - The address isn't taken from `state.variant`: a live output turns to `replay` there while a replay is on air.
  - Vector, Lineup and the Pro CS2 HUD get a `replay` entry point (manifests 1.2.0, 1.2.0, 1.3.0, so installed copies update). The built-in HUD already had one.
  - **For an imported hud.json-format HUD** (no such page), the built-in Broadcast HUD's page is used.
- **Which HUD** (setting `replay.graphic.hudId`):
  - Chosen by the operator.
  - Or automatic: the HUD with an OBS output started last (the built-in one counted only when nothing else is, since it may be in OBS only as another HUD's replay page), else the one started last, else the built-in.
- **OBS:** `POST /api/v1/replay-graphic/obs` puts a 1920×1080 browser source, *MatchFrame Replay Graphic*, on top of the mapped replay scene (`provisionBrowserSource`). `obs.ts` is unchanged.
  - A new input is created on top.
  - An existing one is re-pointed.
  - If the scene's source list doesn't have it (an input of that name in another scene), the route says so.
  - Choosing another HUD re-points the source when OBS has it.
- **Timing (HUD SDK `ReplayGraphicSequencer`):**
  - Tag in 0.35 s and lower third in 0.75 s after a clip starts.
  - The lower third out and back in per clip, the tag staying.
  - Both out when the replays end.
  - Each HUD animates the changes in its own style (transform, opacity, clip-path).
- **Kept clips** (`replay/highlights.ts`):
  - Every queue item with a local file is kept as soon as it is in the queue: a hard link under `<data>/highlights/clips/<map>/`. It takes no extra space and outlives the queue's deletions. On another drive, a background copy.
  - With each map: its kills (killer, side, victim, time) and round winners.
  - The current and previous map are kept, up to `highlights.settings.keepGb` (3 GB). Over that, unplayed clips go first, then the oldest played.
  - A new map: the map or the active match changes. The list is `<data>/highlights/index.json`.
  - No hook in `routes/replay.ts`, the queue or `app.ts`'s eviction callback: a 2 s check follows the queue (state, trim, label).
- **Reel plan:**
  - Every played clip, or the best N (optionally with unplayed ones) by `clipScore` (rank.ts, unchanged), with the facts the automatic replays use (opening, closing, clutch, multi-kill speed) from the kept kills.
  - The same kills once.
  - Round order, and in a round the first kill's time.
  - Each clip's part: its trim, else the end `playMs` the replay showed, else all of it.
- **Reel encode** (`replay/reel.ts`): one ffmpeg run with the program's ffmpeg (`FfmpegTool`).
  - Each part with `-ss`/`-t`; scaled and padded into 1920×1080 (or the largest clip's size); one frame rate (the highest, at most 60); yuv420p.
  - Padded or cut to its exact length, so the xfade offsets hold.
  - Sound resampled to 48 kHz stereo, or `anullsrc`, cut to the same length.
  - Joined with xfade and acrossfade (concat without a fade).
  - libx264 CRF 18 (a hardware encoder when the build has no libx264), AAC.
  - A clip's lower third: a 1920×1080 PNG the console draws on a canvas (match-art's font), laid over with an alpha fade in and out.
  - Probing uses `ffmpeg -i` (the downloaded Windows build has no ffprobe).
  - A long filter graph goes in a file (`-/filter_complex` from ffmpeg 7, `-filter_complex_script` before).
  - Background job with progress (`-progress`); Cancel kills ffmpeg and keeps no file.
  - Output: `<Videos>/MatchFrame Highlights` in the desktop program (`MATCHFRAME_VIDEOS_DIR`), else `<data>/exports/highlights`. The program opens it on this computer (`mf:open-highlights`).

**Alternatives.**

- **The live HUD drawing the graphic** with its browser source also in the replay scene: one source in two scenes would show the full HUD over replays.
- **A second "layer" output id:** HUD Library outputs are per HUD and variant already, and `replay` is an existing variant.
- **Keeping clips by hooking the queue's deletions** (`routes/replay.ts`, `app.ts`): those files are left alone instead; hard links make the copy free.
- **Two-pass encodes** (normalise each clip, then join): twice the encoding for the same result; ffmpeg's scheduler only decodes the inputs the graph asks for.

**Checked.**

- HUD state with a stand-in OBS (`replay-graphic.e2e.test.ts`):
  - The clip on air with every field, its team as the HUD shows it, the side in its round from the kills seen (the other side from now), and from halves.
  - A break's next clip; cleared after; the vMix clip; turned off.
  - The replay pages' addresses, for Vector and for an imported HUD (the built-in one).
  - The OBS route.
- Sequencer unit tests.
- Kept clips and reels with real ffmpeg (`highlights.e2e.test.ts`):
  - Three generated clips: 1280×720 30 fps with 44.1 kHz sound, 640×480 25 fps mono, 960×540 60 fps silent.
  - Kept after the originals were deleted.
  - Round and kill order; best N with unplayed.
  - The MP4's duration (the clips less the fades, ±0.1 s), 1920×1080 60 fps h264 yuv420p, AAC 48 kHz stereo; the burned-in graphic's pixels; Cancel.
  - Two maps kept; unplayed clips dropped first over the cap.
- Console panel tests.
- Screenshots of every HUD's replay page (demo `?demo=replay&play=…`).

**Not checked.**

- OBS itself with the browser source in the replay scene, and with a twin of the replay scene made for fades.
- vMix.
- Windows hard links and the Videos folder.
- The downloaded Windows ffmpeg build.
- Reels of a full map's clips from a real replay buffer.

## ADR-063 — Highlights on air: a map's kept clips through the replays' engine, a HIGHLIGHTS mode that goes back to where the program came from, and Don't show highlights at halftime

**Context.** The owner runs most OBS scenes themselves with a multiview plugin; between maps and after games they are usually on their own analysis scene. They asked for a highlights scene: MatchFrame plays a map's best clips on air when they press Play, then goes back to the scene they came from. During the work they added: "Can you add a button that says don't show highlights at halftime" (one on/off control, on by default; Play, the hotkeys and the Stream Deck refused at halftime; a Stream Deck action to switch it and its state in the tally).

**Decision.**
- **The scene** (`replay/highlights-air.ts`, `routes/highlights.ts`):
  - **Set up OBS highlights scene** (`POST /api/v1/highlights/air/obs-setup`): *MatchFrame Highlights* with the Media Source *MatchFrame Highlights Clip* (the replay source's media settings, `REPLAY_MEDIA_SETTINGS`), mapped as the program's `HIGHLIGHTS` scene (saved in `program.scenes`), the media source in `highlights.mediaInput`; the replay graphic's browser source on top; the twin.
  - **Your own scene** (`PUT /api/v1/highlights/air/scene`): a scene and its Media Source, as the replay scene's mapping. The replay scene with its own media source may be the highlights scene: the replay scene's twin then serves both (no second copy).
  - **The twin** (`replay/twin.ts`): `ReplayTwin` became `SceneTwin` with a `TwinTarget` (the scene map entry, the setting it is stored under, `replay.twin` / `highlights.twin`, the media source's setting, the words of its messages). The replay twin's messages and storage are unchanged. The arbiter keeps a twin per kind (`setTwin`); `replayScenes` and `highlightsScenes` are a mapped scene with every twin of it.
  - **The replay graphic** (`ReplayGraphic.setupObs(scene)`): the route's logic for any scene. One browser source for every scene: an existing *MatchFrame Replay Graphic* is added to the scene as the same source (`CreateSceneItem`, OBS's Add → Existing) instead of the route's *source_elsewhere* refusal (kept when OBS refuses). Choosing another HUD re-points it once for both scenes. The twin, synced after, shares it too.
- **The clips** (`HighlightStore.choose`, used by reels too): the kept clips of this map, of its last half, or of the previous map; every played clip or the best N by `clipScore` (unplayed ones when asked); the same kills once; round order, then the first kill's time. The last half is the half of the last round the map has (a round won, a kill, a clip): MR12 halves, then overtime halves of three (`halfOf`, `halfRounds`, `isHalfStart` in graphic.ts, which `sideInRound` uses now). Each plays as a replay list item built from the kept clip (`asItem`: its kept file, `playMs`, `leadMs`, its play), never added to the list: the same part as a replay (the play and its lead-up, from the end).
- **One engine** (`replay/auto.ts`): a sequence has a `kind` (`break`, `test`, `highlights`) and a `Stage`: the program mode on air (`REPLAY_PLAYING` or `HIGHLIGHTS`), its owner and holder, the scene and media source, its twin, the scenes it may show, the vMix transitions in and out. `playObs`, `playObsTwin`, `playObsOneSource`, `playVmix`, the watches, the controls, the audio, the status line are shared; a highlights sequence:
  - marks nothing in the replay list (no approve, playing, played, rejected) and ignores the round's Exclude and Pin;
  - has no deadline until a round is live (`wentLive`, noted by `interrupted`), then the replays' own cut back on its clock (`cutBackAt`, the same `cutBack` setting) and `fitNow`;
  - says *Highlight 3 of 8: …*;
  - leaves `busy` set: the tick never starts a round's replays meanwhile. Started in a break whose replays haven't been chosen, the break gets none (`noReplays("highlights")`, *highlights went on air instead*). Play is refused while a break's replays or Test replays play.
  The break's and Test replays' paths are the same code as before (the e2e suites of ADR-059 to ADR-062 pass unchanged).
- **The program** (`production/program.ts`):
  - A mode `HIGHLIGHTS` (in `PROGRAM_MODES`), reachable from `LIVE`, `STUDIO`, `BREAK` and `MANUAL` (not from a replay), going to `LIVE`, `STUDIO`, `BREAK`, `MANUAL` or `DEGRADED`. `activeReplay` is the highlight on air, so the replay graphic (`onAirId`) shows it; the graphic finds a clip the replay list dropped among the kept clips, and for a previous map's clip doesn't move today's sides to it.
  - **The return target** (`highlightsReturn`), saved as highlights go on air, before the mixer is asked: the mode, its scene (MANUAL: the followed scene, else the scene the mixer shows, a new optional `MixerPort.shown`) and the owner then. `returnFromHighlights` (only by the highlights' holder): the live scene when a round is live, when the target is gone from OBS, or when it was live; else MANUAL with that scene (`request`'s new `scene` option: put on program and followed again, owner the operator, holder `OBS: <scene>`), or the studio or break scene with its owner back (`restoreOwner`), so the OBS automation's studio scene is still its own (obs-auto keeps `ours` while highlights from it are on air).
  - **Owner:** Play, a hotkey and the Stream Deck are the operator's (they can take the program from the operator's own scene); the automatic start is automation's (from the live scene only). The holder is `highlights` either way.
  - **Following OBS** is unchanged: `showsScene` and `whose` count the highlights scene and its twin as the program's while it is on air; OBS showing the live scene is `followMixerLive`, another scene put on in OBS `followMixerScene`. Either (or a program change made in OBS, `changesInObs`, as Studio Mode's Transition button) stops the highlights and nothing more changes (`taken`).
- **Transitions** (`live/obs-auto.ts`): `transitionUse` has `highlights-in` (to `HIGHLIGHTS`) and `highlights-out` (from it, to wherever); `highlightsIn` / `highlightsOut` (null: as Replay in / Replay out; "" OBS's own; a Stinger's cut point as for replays). vMix: `vmixIn` / `vmixOut` in the highlights' settings (null: as the replays'); back to the input that was on air before.
- **Don't show highlights at halftime** (`noHalftime`, default on): at halftime, Play (route, hotkey, Stream Deck) is refused with *Highlights at halftime are off (Don't show highlights at halftime).* and no automatic start happens. **Halftime** (`isHalftime`): the game's halftime phase (`intermission`), and around the first round of a half other than the map's first (13, 25, 28, …): from the end of the half's last round (the game's round number has moved on to the next by then) to the end of the next one's freeze time; never at the map's end or in warmup. The coordinator's definition (the halftime phase and the freeze time before the half's first round) is inside it: the round-over seconds before the game's halftime phase were added so that Play pressed just as the half ends doesn't put highlights over the halftime. Highlights already on air when halftime begins play on. Off: Play works then, and **Start by themselves at halftime** (`autoHalftime`, off) can be ticked. Device action `highlights_halftime` (`on`, toggles without); tally `highlights.halftime`, `highlights.noHalftime`.
- **Automatic start** (`autoMapEnd`, off; `autoHalftime`, off and only with `noHalftime` off): once per map end and per halftime (by map and half), after the round's replays (`AutoReplay.replaysDue`, bounded by the replay PC wait), and only with the program live: otherwise not started, with the reason in `status.auto`. The OBS automation's map-end studio scene waits while such a start is due or highlights go on air (`holdsMapEnd`, `onAir`), and comes after them.
- **Controls and keys:** Skip and Hold are the replays' (`/api/v1/replays/auto/skip`, `/hold`, `replay_skip`, `replay_hold`, Ctrl+Shift+F5, F6); Stop is `POST /api/v1/highlights/air/stop` and `highlights_stop`; Play `POST /api/v1/highlights/air/play` and `highlights_play`. Console keys Ctrl+Shift+F9 and F10 (not F8: the console's F8 is Stop automation, with any modifier). The desktop's global hotkeys gained `highlights` and `highlightsStop` (suggested Ctrl+Shift+F9, F10), off until set.
- **Sound:** the highlights scene's media sources count as replay sources (`ReplayAudio.replayInputs`): never ducked, and the replay volume applies to them.
- **Scene maps from before:** `sceneMapOf` fills `HIGHLIGHTS` (null) into stored and partial maps; `PUT /api/v1/settings/program.scenes` without a `HIGHLIGHTS` key keeps the one mapped. Sponsors: no bugs over highlights, as over replays.

**Alternatives.**
- **Highlights as `REPLAY_PLAYING` with another holder:** no return target, the replay transitions and scene, and every check of the replay mode would have needed an exception.
- **The replay list's clips** (`playlist()`): the list keeps 200 items and the replay PC's newest 120 files; a map's clips are gone by its end.
- **Kept clips added to the list unlisted** (as Test replays' samples): new ids, and the graphic's side and team kept with the clip lost.
- **Going back with `request(back.mode)` alone:** the operator's own scene has no mapped scene, and the studio scene would have become the highlights' owner's (the OBS automation would no longer take it back to live).
- **A second graphic source for the highlights scene:** two sources to point at the HUD's page; OBS shares one.
- **Halftime as the halftime phase only:** Play pressed in the few seconds between the half's last round and the halftime phase would have run highlights through the halftime.

**Checked.**
- Unit (`highlights-air.test.ts`): halves, half rounds, the first rounds of halves, halftime (phase, freeze time of 13, 25, 28, the end of round 12, not 14, not live, not the map's end or warmup, MR8); the arbiter: on air from live and back, the clip changing without a mixer action, from the operator's scene and back to it as theirs, refused to another holder, live when a round is live or the scene is gone, from the automation's studio scene with its owner, from MANUAL without a followed scene to what the mixer showed, not over a replay, twins, old scene maps; `transitionUse`; the choice (best 5 played by default, round then kill order, duplicates, all played, best N with unplayed, a clip with no round last, the last half, the previous map, the running time, a kept clip as an item).
- Stand-in OBS (`highlights-air.e2e.test.ts`): set up (the scene, the media source's settings, the graphic's one source in the replay scene, the highlights scene and its twin, on top; the view's status and preview); from live (Highlights in as the stinger, fades between the scene and its twin with each clip at its part, the graphic of each kept clip, none in the replay list, the live audio down 20 dB and back to exactly 0.8, one change in and out, OBS's own transition back); from the operator's scene with chosen Highlights in and out, back to it as theirs (replays still wait); from the studio scene with its owner; the scene gone (live); Skip (the fade within 0.6 s), Hold (paused 1.5 s, the cursor still), Stop (Highlights out); the operator's scene in OBS (stopped, nothing more); refused while live; a break's replays not played during or after, Play refused during a break's replays, the next break as before; Don't show highlights at halftime (playing on as halftime begins, refused in the halftime phase and the freeze time by Play and the Stream Deck, the tally, switched by the Stream Deck); halftime ending mid-way (on into the round, back by its clock to the live scene, not the analysis scene); the automatic halftime start (not with the setting on, from live, not from the operator's scene); Studio Mode (the preview put back, the Transition button taking it); the Stream Deck actions and tally; the previous map's clips on the graphic; the map's end (highlights, then the studio scene).
- Stand-in vMix: Highlights in (Stinger 1), fades, Highlights out (as Replay out, CutDirect) to the input before, the live audio, refused while live.
- Console (`HighlightsOnAir.test.tsx`), the desktop hotkeys, the existing replay suites unchanged.
- **Real OBS 30.0.2** (Linux, Xvfb; a scratch script drove the engine's API; recordings read frame by frame): **Set up OBS highlights scene** made the scene, its Media Source with the three settings off, and the twin; this OBS build has no Browser Source (no obs-browser), so the graphic step said so (*This OBS build has no Browser Source…*) and a colour bar on top stood in for the graphic, with a backdrop and the clip scaled. Played from an analysis scene put on in OBS itself (MANUAL, `OBS: Analysis`), three kept clips (hard links, none in the replay list): OBS's Fade in (or the MatchFrame Replay Stinger as Highlights in, the first clip from its cut point), 14–15 blended frames (0.47–0.5 s at 30 fps) between the clips through the twin, no black frame, no clip-start frame, the backdrop and the overlay in every frame of both scenes; the graphic's clip on the HUD state for each (alpha, bravo, charlie, then none); Fade out back to the analysis scene, the program MANUAL `OBS: Analysis` again; the live audio input at 0.8 back bit for bit (0.800000011920929); OBS's own transition back.

**Not checked.** Windows; a real vMix; a real Stream Deck or Companion; a real multiview plugin; the replay graphic's browser source in a real OBS (no obs-browser in the OBS used); a real CS2 halftime (the halftime phase as CS2 sends it was taken from the game-data reconciler, and the round-over seconds before it from ADR-060's note that the round number moves on when a round ends).

## ADR-064 — The replay feed timed by the replay PC's clock: a constant frame rate written by the feed, its sound written as received, and where frames are lost

**Context.** The owner records the replay PC's screen over NDI (NDI Screen Capture at 1080p60, with its sound). Replays "lag quite a bit" and look choppy, the sound is "crackly", and: "the replay pc is having a lot of dropped frames how do i fix that?". Until now (ADR-062) the feed stamped each frame with the time ffmpeg read it (`-use_wallclock_as_timestamps`) and left ffmpeg's constant-frame-rate output to repeat and drop frames to fit. It dropped a frame whenever ffmpeg's stdin needed draining. The sound followed the sender's timestamps: a jump of more than 20 ms was filled with silence and an overlap cut, and the sound was moved by whole chunks when 60 ms off.

**Measured first.** The setup:
- grandi with the NDI 6.3 runtime receiving a local 1080p60 NDI sender in another process. Its picture carries its frame number; its sound is a continuous 1 kHz tone on the left and a 10 ms burst each second on the right (A/V).
- Real ffmpeg, with x264 *ultrafast* standing in for a graphics card's encoder (this machine has none, and *veryfast* can't do 1080p60 on its 4 cores).
- The feed's own code, with stalls of its event loop (20–150 ms every 0.4–1.5 s, now and then 300 ms) and CPU hogs beside it for CS2 and OBS.
- The recording and a 6 s cut read frame by frame, and the tone by I/Q (level and phase every 5 ms). Scratch scripts, not in the repository.

What it showed:
- **The "dropped frames" were this computer's own.** A 4 MB frame keeps stdin needing a drain until ffmpeg has read all of it. A read slower than a frame (alone: median 1.4 ms, p99 9 ms, worst 47–55 ms) dropped the next frame, even with ffmpeg idle at 60 % of one core: 379 of 2400 in 40 s unloaded, 695 busy. The panel's *frames a second arriving* counted only those written (52, 40).
- **Judder:** frames timed by when ffmpeg read them, then fitted to 60 fps by ffmpeg, were repeated and skipped: 297 repeats and 298 skips in 37 s unloaded, 618/619 busy, 739/739 heavy. A 6 s clip had 64, 111 and 112 of each.
- **Crackle:** NDI's audio timestamp is when the sender submitted the frame (about its last sample). A busy sender's 10–25 ms of jitter made "gaps" of more than 20 ms: in 30 s, 17 pads of silence (379 ms) and 11 cuts to take them back. After AAC each is a 10–40 ms dip with a jump of phase. Tone breaks: 1 in 40 s unloaded, 26 busy, 247 heavy (9.3 s of broken tone); up to 45 in a 6 s clip.
- **NDI's own queue** lost nothing with stalls up to 150 ms. Stalls of 300 ms made NDI drop 8–9 frames in 40 s.
- **Load:** at 1080p60 the feed process's main thread is 85 % idle: garbage collection of the binding's per-frame buffers 6.5 %, writing 1.6 %, the feed's own code under 2 %. Receiving alone (NDI's decoding and grandi's copy, on their own threads) costs 29 % of a core. `ColorFormat.Fastest` gives the same UYVY for this sender. Receiving in a worker thread changed nothing (no NDI drops either way with 150 ms stalls). A lower bandwidth is NDI's preview picture.
- **NDI's clocks:** a video frame's timecode (made by the sender's SDK) steps exactly a frame (16.67 ms), while its timestamp varies 10–25 ms with 4 ms of sender jitter. Audio timecodes aren't sample-accurate (9.38 ms steps for 10 ms frames).

**Decision.**
- **The picture's clock** (`replay/feed-clock.ts`, `VideoClock`):
  - Each frame is timed by the sender's clock: its NDI timecode or its timestamp, whichever runs steadier over the first 30 frames (the median distance of their intervals from their median). A clock that doesn't run forward, or doesn't keep time with the arrivals, isn't used. With neither, frames are timed by their arrival.
  - It is laid on this computer's clock by an offset: the least (arrival − sender time) of the last 10 s, moved only when that moves by more than a frame and a half (25 ms at 60 fps). A frame that came late because this computer was busy keeps its time.
  - A sender clock more than 1 s ahead of the arrivals, or 5 s behind (the sender restarted), is laid again at once.
  - The timestamp's offset is kept either way: the sound is laid by it.
- **Slots** (`FrameSlots`):
  - Slot k of a recording is t0 + k frames. A frame goes in the next slot while within 0.75 of a slot of it (sender jitter).
  - A frame later than that first repeats the frame before for the slots between (nothing came for them). A frame earlier than that (its slot already filled) is skipped.
- **Writing** (`FeedRecording`):
  - The feed writes every slot to ffmpeg's stdin as raw frames at the source's rate. ffmpeg stamps them by their count from `k0` frames after t0 (`-itsoffset k0 × frame`, the stamps kept with `-copyts`, `-fps_mode passthrough`). The segments' times stay real time from t0, so cuts by the replay PC's marks are unchanged.
  - Up to 250 ms of frames may queue for ffmpeg (about 62 MB at 1080p). A frame beyond that isn't recorded: its slot repeats the frame before once ffmpeg takes more, and it counts as the encoder's.
  - Frames lost while ffmpeg starts (until its first segment exists and what queued is taken) are counted apart. A recording more than 2 s behind starts again with an error saying the encoder can't keep up.
  - With no picture for 250 ms and none waiting in NDI's queue (`queue()`), the last frame is held. After 3 s without a picture the session ends; the next frame starts a new one.
  - A stride wider than the picture is read whole and cropped by ffmpeg (`crop`) instead of copied row by row here. The frame's own buffer is written as the binding gives it (grandi copies it once, on its own thread).
- **The sound** (`AudioClock`, `Resampler`):
  - Written as received, sample after sample.
  - A frame ends at its timestamp, laid on this computer's clock by the picture's timestamp offset, plus how much later the recording shows a frame than its timestamp says (the median of the last 2 s), so the sound goes with the picture as shown.
  - Silence goes in only for a dropout: no sound sent for 200 ms or more by the sender's timestamps, filled with as much, faded out and back in over 2 ms. Shorter jumps and overlaps are jitter and ignored.
  - Where it sits against the picture is judged over 3 s: the earliest tenth of the timestamps (a sender stamps late, never early), or the earliest arrival without them.
  - More than 30 ms off: played 0.3 % faster or slower (5 cents) by a linear resampler that carries its position across frames, until exactly that many samples are taken out or added. More than 250 ms off (the sender's clock jumped): one 2 ms crossfaded join.
  - The last 2 ms are held back so a join can fade them. A source without sound is filled with silence as before, but not while sound waits in NDI's queue (this process was busy).
  - The same resampler converts any other sample rate continuously (the old per-frame rounding drifted 0.4 ms a second for 1024-sample frames at 44.1 kHz). A stereo frame's own floats are used, not a copy.
- **Where frames are lost** (`FeedDiagnostics`, `feedLosses`, the console's Replay feed panel):
  - The worker sends its counts each second: received, NDI's own (`performance()`), written, repeated, skipped, not recorded by the encoder, lost to ffmpeg's start, the largest queue, the timing and its re-anchors, and the sound's dropouts, moves and offset.
  - The engine compares them over 10 s and says where frames are lost, each with a hint:
    - *Not arriving from the replay PC* (fewer than the source declares by 5 %, or NDI dropped some): a wired gigabit network, and `fps_max` on the replay PC.
    - *This computer's encoder is behind* (named): for x264 chosen by hand, a graphics card's encoder; for x264 picked because none works, close what you can or lower the bitrate; for a graphics card's encoder, close what else uses it or lower the bitrate.
    - *Frames repeated to fill gaps in what arrived* (beyond the encoder's, more than 1 in 100).
  - `status()` carries `encoder`, `diagnostics` and `losses`, so the support file (`replays.feed`) has them. `receivingFps` now counts every frame arriving, not only those written.
- **The stand-in NDI** (`test/helpers/fake-ndi.ts`) behaves like the real one, as measured:
  - Video frames carry a timestamp (when sent) and an even timecode. An audio frame's timestamp is when it was sent, after its last sample.
  - Options add a declared and a real rate, sender jitter, arrival jitter, busy moments that bunch frames, NDI drops, a frame counter in the picture, a continuous tone, a drifting audio clock, `queue()` and `performance()`.

**Alternatives.**
- **Per-frame timestamps to ffmpeg** (Matroska with raw video), ffmpeg filling gaps: repeats wouldn't cross the pipe, but ffmpeg would again decide the frames, from stamps it can't check. The owner asked for the feed to write the constant rate itself.
- **NDI's frame-sync** (`frameSync`, a time base corrector pulled at this process's own pace): a busy moment here would again decide which frame is taken. Not tried.
- **Receiving and writing on a worker thread:** measured no change (the main thread is mostly idle; no NDI drops either way).
- **A larger queue for ffmpeg:** 250 ms covers a 300 ms stall's burst with ffmpeg reading meanwhile; more is memory (4 MB a frame).
- **The sound against the picture by the median of its timestamps alone:** in the heavy run a sender's late submissions under load, and NDI's timecode running a little apart from its timestamps, put it 34 ms late; by the earliest tenth, laid where the picture is shown, +4 ms.
- **Correcting drift with silence and cuts** (as before) or a crossfade each time: audible. A resample of 0.3 % isn't.

**Checked.**
- Unit (`replay-feed-timing.test.ts`):
  - **Picture:** a 60 fps sender with 4 ms of jitter, arrivals 3–18 ms late and a 150 ms busy moment every 1.3 s: every frame in its own slot, none repeated or skipped. Timed by arrival (as before), the same frames give more than 50 of each.
  - **Clocks:** timestamps alone with 5 ms of jitter; three frames never sent repeated and a duplicate skipped; clocks drifting 100 ppm for 10 minutes, laid again 1 to 3 times with 3 to 5 repeats; a sender clock jumping back an hour, laid again at once; the last frame held through a pause.
  - **Sound:** the resampler passes 48 kHz through bit for bit, converts 44.1 kHz without a break, and moves 480 samples exactly. Timestamps 0–25 ms late (3 % 40 ms late) with bunched arrivals: the samples written exactly as sent (the old rule would have broken them more than 20 times in 20 s). A 300 ms dropout filled once with 300 ms, faded. A sender 0.1 % fast followed by resampling, within 40 ms, no join. A clock jumping back a second: one crossfade. First frames placed by timestamp or arrival. Silence for a source without sound, not while sound waits.
  - **Losses:** their texts and hints.
- E2e (`replay-feed.test.ts`, the stand-in NDI and real ffmpeg):
  - **A busy 60 fps screen capture** (4 ms jitter, sound in 10 ms frames up to 25 ms late, arrivals up to 15 ms late, 150 ms busy every 1.3 s): the clip's frames each once, in order, 16.67 ms apart; its first and last frames those of the marks (0.2 s); the tone without a break at its level; the diagnostics with nothing repeated or skipped and no dropout. The same scenario on the old code: 21–22 repeats, 22 skips and 5 tone breaks in a 3.7 s clip.
  - **Where frames are lost:** a source sending 50 of a declared 60 with NDI dropping one in 25 (*Not arriving … 4x of 60 … NDI dropped …*, and gaps, no encoder); an ffmpeg stand-in taking 40 frames a second (*This computer's encoder (x264 on the CPU) is behind …* with the x264 hint).
  - The existing feed tests unchanged: cuts to 0.2 s, the sound within 30 ms, a source without sound.
- Console (`AutoReplays.test.tsx`): the encoder in words, *52 of 60 frames a second arriving*, the losses with their hints, the totals, *No frames lost in the last 10 s.*
- **Real NDI, before and after** (as above; the recording after its first 3 s, about 37 s, and a 6 s clip cut by a mark):

| 40 s of 1080p60 | | Before | After |
| --- | --- | --- | --- |
| **Unloaded** | recording: repeated / skipped frames | 297 / 298 | 0 / 0 |
| | 6 s clip: repeated / skipped | 64 / 64 | 0 / 0 |
| | tone breaks in the recording | 1 | 0 |
| | sound against the picture (+ late), median | −30 ms | −6 ms |
| | the clip's first / last frame against the mark | −4 / −40 ms | −3 / −19 ms |
| | status: frames a second arriving; dropped | 52.5; 379 | 60; 0 |
| **Busy** (stalls, 2 hogs, sender jitter 4 ms video, 12 ms sound) | recording: repeated / skipped | 618 / 619 | 17 / 19 (10 dropped by NDI in 300 ms stalls) |
| | 6 s clip | 111 / 111 | 2 / 4 |
| | tone breaks: recording; clip | 26 (725 ms); 6 | 0; 0 |
| | sound against the picture: median (range) | −25 ms (−124 to +28) | −6 ms (−22 to +28) |
| | the clip's first / last frame against the mark | −12 / −42 ms | −9 / +13 ms |
| | status: arriving; dropped | 39.5; 695 | 60.5; 0 |
| **Heavy** (stalls, 3 hogs, jitter 6 ms and 25 ms, a frame 12 ms late every 37) | recording: repeated / skipped | 739 / 739 | 23 / 23 (2 events; one 300 ms stall: 10 by NDI, 12 by the encoder) |
| | 6 s clip | 112 / 115 | 0 / 0 |
| | tone breaks: recording; clip | 247 (9.3 s); 45 | 0; 0 |
| | sound against the picture: median (range) | −6 ms (−104 to +34) | +4 ms (−12 to +33) |
| | the clip's first / last frame against the mark | 0 / −43 ms | +3 / −5 ms |
| | status: arriving; dropped | 43; 813 | 60; 12 |

In both, the frames' stamps are 16.67 ms apart (ffmpeg's constant rate before, the feed's slots after): the judder was which frame a stamp showed. The tone's pitch was steady to 0.1 cent before; after, it moved 5.3 cents during the one 0.3 % resample of a run (none unloaded). The feed process used 50–52 % of a core before and 53–61 % after (every frame written now, not 40–52 a second); ffmpeg 53–63 % both.

**Not checked.**
- Windows: ffmpeg 7.1's own threads, the named pipe's writes, the hardware encoders.
- A real NDI Screen Capture on another computer over a real network: whether its video timecode is NDI's even one or its own, its audio frame sizes and timestamps.
- A real graphics card's encoder.
- CS2 loading the replay PC (here a sender in a process beside CPU hogs).
- NDI's frame-sync.
- The first second or so of each recording still shows its first frames held while ffmpeg starts, as before.

## ADR-065 — Team Comms: a TeamSpeak 3 plugin hands each person's voice to the engine, which delays and mixes it per output

**Context.** The owner's brief (docs/specs/team-comms-brief.md): both teams' TeamSpeak channels, each person separately, delayed to match the observer's gameplay, into a public listen-in (one team at a time, no individual attribution), a separate gameplay recording with its own selection and a speaker strip, and the operator's preview. Phases 1 and 2: prove per-person capture and the second recording, then build the bridge, identities and buffers. Evidence and numbers: docs/operations/team-comms.md.

**Decision.**
- **Capture in a TeamSpeak 3 client plugin** (`native/ts3-matchframe-plugin`, C++17, plugin API 26 for TeamSpeak 3.6.x): `onEditPlaybackVoiceDataEvent` gives each person's decoded voice before TeamSpeak mixes it (measured: mono, 48 kHz, 360 samples every 7.5 ms). The callback copies into a bounded lock-free queue and zeroes the samples; a sender thread does everything else. The standalone TeamSpeak SDK (not a client for normal servers) and ServerQuery (no audio) were not options; a desktop or NDI capture of the mixed output can't remove one person from overlapping speech.
- **The engine decides which tabs are captured** (MANAGE by server and channel); unmanaged tabs are untouched. Managed tabs are listen-only (input deactivated and muted, never deafened: the callbacks need playback running) and silent here (per-person and mixed playback zeroed), and carry TeamSpeak's recording status while MatchFrame records.
- **Bridge: TCP on 127.0.0.1** with a token MatchFrame generates (secret store; written with the port to `<data>/team-comms/bridge.json` for the plugin), binary audio + JSON events, validated, bounded, the plugin reconnecting. Not a named pipe: one transport on every platform, testable here as on Windows.
- **Identity:** a person is `team id / server unique id / TeamSpeak unique identity`; session client ids are re-resolved from events; the listener is never a person; anyone new is excluded everywhere until approved. Team slots A/B are the active match's team A/B by id, so a halftime changes nothing.
- **Timeline:** the engine's monotonic clock; the plugin stamps each block with its own monotonic clock, mapped by pings (shortest round trip, slewed, jumps detected). Each person's buffer holds sparse chunks, contiguous through jitter, bounded by delay + 2 s and an overall memory cap. Readiness is "captured without a break since before the playhead".
- **Outputs after the buffers:** every 10 ms the mixer reads each person at now − delay (at least 150 ms) and applies inclusion, level and team gates there (10 ms ramps; the public listen-in 40 ms, closing one team before opening the other). Never undelayed audio: a team not ready contributes silence. The public gate is closed at start, closes itself on its team's source loss, and is never restored at startup. Per-person activity comes from the samples mixed into each output (team level only for public).
- **Second recording: OBS's Source Record filter** on a recording-only scene (measured in OBS 30.0.2: gameplay throughout while the program cut to casters, its own encoder, the scene's own audio). **Audio into OBS: NDI audio-only from the engine** (grandi, already shipped), received by DistroAV; the preview goes to headphones from the console (Web Audio, `setSinkId`), never through OBS. Both phase 3–4 work.

**Alternatives.**
- **A virtual audio cable (VB-CABLE)** for the public bus: not redistributable without VB-Audio's licence, and Node needs a native WASAPI module; kept as an operator-installed fallback.
- **A second OBS instance** for the recording: a second renderer and game capture to keep in step; the fallback if Source Record can't hold 1080p60 on the owner's PC.
- **One TeamSpeak client with two tabs vs two clients:** both supported (the bridge takes up to 4 plugins). Two tabs on one server need two identities on a default server (one connection per identity).
- **Placing every block at its own stamp:** 1–10 ms of timestamp jitter would add clicks and gaps; contiguous within a sentence, re-laid only on a jump.

**Checked.**
- Real TeamSpeak (Linux; client 3.6.2, server 3.13.8, two team channels, 7 talkers each with a distinct tone, one listener client with two tabs; and the in-repo rig with one listener per team): per-person streams by identity, never across teams; −59 to −70 dB between people during overlapping speech; listener muted and not deafened on the server, recording status shown; its playback exactly silent once managed while the callbacks kept coming; 195 784 blocks, 0 lost; plugin→engine median 1.3 ms; drift under 0.3 ppm; the delayed output's speech onsets 0.0 ms from capture + 20 s; a server kick and a client crash handled (public closed and not reopened; slots back after the delay); an excluded person gone from the next 20 ms though still buffered.
- The real plugin binary in a stand-in host, on Linux in the tests and the Windows DLL under Wine, against the real bridge.
- Fixture tests on a simulated clock (`team-comms*.test.ts`): the brief's cases, incl. 90 s alignment within 10 ms.
- Source Record 0.4.8 in OBS 30.0.2 at 1080p60 (software rendering): see the operations document.
- NDI audio-only between two processes: 0 of 17 989 frames dropped, 10.5 ms.

**Not checked.** Windows TeamSpeak with the MSVC build; DistroAV receiving the engine's NDI audio (not buildable for OBS 30.0.2 here); Source Record and the whole single-PC load with a GPU encoder; TeamSpeak 6.

## ADR-066 — Team Comms on air: one controller for the public listen-in, the mixes to OBS as NDI audio from MatchFrame, the preview in the operator's headphones, caster ducking shared with the replays', and a team-only overlay

**Context.** The owner's brief (docs/specs/team-comms-brief.md), sections 6, 7, 10 and 11, phase 3: put a team's permitted, delayed comms on the public broadcast only when the operator says so, with nothing undelayed, no individual attribution and silence on any failure; give the operator a private preview; build the console. ADR-065 built the capture, the buffers and the mixes (`CommsSink` left for this). Evidence: docs/operations/team-comms.md.

**Decision.**
- **One output-state controller** (`comms/controller.ts`) owns the public gate: OFF, BUFFERING — team, LISTENING IN — team, FAULT, always shown in words. Actions: *Listen In — [team]* by the match's team id (never CT/T), *End Listen-In*, *Mute All Comms*. Listen In refuses until the team's buffer holds the configured delay (and while the public output isn't running). A team switch closes the open team to silence (40 ms) before the other opens. Mute All Comms closes the gate in 5 ms in the mixer itself and touches neither the recording nor the preview. A lost source, a bridge or slot reset, the active match changing, or the public output stopping closes it as FAULT; only an explicit Listen In opens it again. A delay change while on air is BUFFERING until the new delay is held, then on air again (an operator's deliberate change, not a reset). Nothing about the gate is saved: every start is OFF. Recording and preview never call into it.
- **Silence enforced in MatchFrame:** every public block is checked again as it leaves; while the gate is closed the block sent is zeros, whatever the mix holds. OBS muting is never the mechanism.
- **NDI audio-only, sent by MatchFrame** (grandi, already shipped): "MatchFrame Comms" (public) and "MatchFrame Comms Recording" (phase 4), from their own process (`comms/ndi-worker.ts`, forked like the replay feed's), 48 kHz stereo FLTp in 480-sample frames, each sent a fixed latency (60 ms) after its own time on the engine's clock and stamped with it as its timecode; a block late goes as silence and is dropped when it comes (never stale or repeated audio); a stall skips ahead. **Paced by MatchFrame, not NDI's clockAudio:** with NDI clocking the sends ran 99.91 frames a second here and the latency crept from 60 to 140 ms until a resync; paced on the engine's clock it held 60 ms. If the process stops, a listen-in closes (FAULT) and the process restarts.
- **Preview** (`comms/preview.ts`): the preview mix to the console over its own WebSocket (production roles only), played with Web Audio on the output the operator picks (`AudioContext.setSinkId`, or an audio element's). Never NDI, never OBS.
- **Caster ducking** (`comms/ducking.ts`) through the OBS adapter with the replays' rules (volumes saved before, put back exactly, a fader moved by hand left alone, a crash put right at the next start). With the replays' ducking on the same input, whichever ends last restores: a small additive hook in `replay/audio.ts` (`DuckPeer`, `heldInput`) lets each take the volume from before either, never raise what the other holds lower, and hand the input over at the other's level.
- **Team-only overlay** (`comms/overlay.ts`): its own page on the overlay server (`/comms/public`, token in the address, external script under the server's CSP), fed `{onAir, team: name, short name, logo, colour, label, placement}` only, built field by field so nothing about a person can reach it; a setup action adds it as a browser source on top of the live scene. The recording's speaker strip will be a separate route (phase 4).
- **Console:** Live Control → Team Comms (both teams' panels, the public state and its actions, preview, delay, outputs, ducking, overlay, OBS routing check, bridge and plugin setup), and the state with the four actions in Live Control.

**Alternatives.**
- **A virtual audio cable** for the public bus: not redistributable (VB-Audio's licence) and needs a native WASAPI writer; NDI is already in the program and measured.
- **The gate in OBS** (mute/unmute the comms source over obs-websocket): a lost connection to OBS, or an operator's click in OBS, would put comms on air or keep them there; the brief asks for MatchFrame's silence.
- **NDI's own audio clocking:** simpler, but it drifted from the engine's timeline here (above); kept as a setting.
- **The preview through OBS's monitoring:** would put a private mix in a process that also feeds the program; ruled out by the brief.
- **Opening a not-ready team's listen-in and waiting:** comms would come on air later by themselves; refusing with the time left keeps the operator in charge.

**Checked.**
- Fixture tests on a simulated clock with the real bridge and a stand-in plugin (`team-comms-public.test.ts`): OFF at start, refused while buffering, recording and preview never open it; broadcast off sends exact zeros while both buffers and the recording carry on; a team switch with no 10 ms block holding both teams and no sample step beyond the tone's own slope; Mute All silent from 5 ms with the recording and preview on; bridge loss is FAULT and the source coming back doesn't reopen it; the NDI process stopping or failing to start is FAULT and Listen In is refused; halftime; BUFFERING after a delay change and back on air; never saved open; the soloed person only in the preview (WebSocket), never in the public, recording or NDI blocks; the overlay's messages carry no name, identity, player, avatar or activity; ducking put back exactly, a moved fader left alone, all three orders with the replays' ducking, a crash put right at the next start.
- Through the engine (`team-comms-public.e2e.test.ts`): the routes and audit, the overlay page, script and token, its socket, the preview socket refused to a viewer, the overlay added on top of the live scene in a stand-in OBS, the routing check before and after the documented fixes, the support file without the overlay's token.
- Real NDI (`team-comms-ndi.test.ts`, `scripts/comms-ndi-measure.ts`): the engine's outputs and NDI process against a real NDI 6.3.2 receiver in another process, 180 s: 18 001 frames on each source at 100.00 a second, 48 kHz stereo float in 480-sample frames, 0 dropped, latency from a block's own time median 60.5 ms (p99 64, max 66), 0 public bursts heard while the gate was closed and every one heard while open (operations document).
- Console component tests (jsdom): the page, the live room card, the preview player.

**Not checked.** DistroAV receiving the sources in OBS (not buildable for OBS 30.0.2 here), its own latency and its sync modes; real headphones and `setSinkId` in the packaged program; ducking and the overlay's look in a real OBS; NDI pacing with Windows timers.

## ADR-067 — A break's replays rendered into one file and played in one scene; the scenes path loaded just in time; the replay feed drops frames rather than starting again

**Context.** The owner (0.10.12, Windows, OBS 30): replays "pausing and not playing then transitioning to the next clip", and "is there any way to make replays & Highlights run smoother on 1 scene and fade into each clip, as well as have the audio fade in and out so it's not such a hard cut at the end". The support file showed the clip held paused off air running on (often to its end): that OBS lets a hidden media source's pause go. Putting it back (restart, pause, skip) left it stuck at about 24 ms; the play sent as it went on air didn't start it; 1.5 s later the stall rule faded to the next clip. Separately the replay feed restarted its recording about six times in 25 minutes (*ffmpeg (h264_nvenc) can't keep up with the picture*), each a gap.

**Decision.**
- **The default (playback "rendered"): one file, one scene, one play.** Once a break's clips are chosen, ffmpeg (the engine's, with the replay feed's encoder: NVENC on the owner's PC) joins them into one MP4 (replay/render.ts): each cut to its part, normalised by the highlight reel's graph, crossfaded (xfade, acrossfade; a cut joins them plainly), the sound faded in and out (Sound fade, 0.4 s). The first clip's first frame is held 1.2 s before it and the last frame 1 s after, in silence, so the clips start at the Stinger's cut point whatever it is and Replay out covers the end; keyframes at each clip's start and through the held first frame make seeks land where sent. The file plays in the mapped scene's one media source (no twin): loaded off air, checked to move, Replay in, the cursor set back by what is left to the cut point; the status, the program's clip and the replay graphic follow the cursor; Skip seeks to the next clip's start; Hold pauses on air; Stop and the round clock end it, the source's sound faded out (its volume back once off air). Replay out starts its cut point early when it is Replay in's transition. Exclude and Pin made mid-break apply from the next break. Highlights on air and Test replays take the same path (highlights wait for their file, with progress).
- **When the file isn't ready in time** (6 s for a break and Test replays, less when the round clock would make it pointless; 3 minutes for highlights), can't be made, or doesn't play, the clips go back on the list and play **through the scenes**, logged and in the status. A break plans its clips with what the last renders took.
- **Through the scenes (the fallback, and playback "scenes"):** nothing waits paused off air and nothing is restarted. Each next clip is chosen early but loaded into the off-air scene just in time (the measured load time, half again and 0.25 s: 0.5–2.5 s before its fade), skipped so it reaches its part as the fade starts, and plays hidden into it; one that ran on (the clip on air was held) is opened again and skipped to its part. On air every clip must move within 0.3 s: play again, then the file opened again and skipped to its part, else it is skipped and logged. A clip that stops on air: play, then opened again where it was, then given up. OBS 30 ignores being given the file it has (measured: its cursor carries on), so "opened again" empties the source first.
- **The replay feed:** when ffmpeg is behind for a moment, frames are dropped (encoder drops, as before) and, past 1 s behind, the slots owed are let go: the recording skips ahead and tells the engine where and by how much, which maps its segment times (clips are cut from the right moment and are their own length), and the sound skips with it at one crossfade. The recording starts again only when ffmpeg takes nothing for 5 s, or stops.
- **The support file** carries OBS's version, its websocket's and its platform, and the last render.

**Alternatives.**
- **Keep the paused clip off air, but check the pause holds:** a check can't say whether a pause will still hold seconds later; on the owner's OBS it went after a while. Loading just in time works whether or not pauses hold.
- **Prepare each clip when it arrives, so a break only joins them:** the join still re-encodes every frame (xfade), so it saves only reading the clips; measured here, reading and joining four clips took 3.8 s of a 9.4–10.3 s x264 render, the rest the encoder that NVENC takes off the CPU. Kept as the next step if the owner's renders run long.
- **Stream copy of the clips' bodies with only the fades encoded:** fast, but the pieces' encoder settings, timestamps and AAC edges must match exactly; not worth it before the simple render is measured on the owner's PC.
- **Restart the feed's recording when ffmpeg is behind (as before):** each restart lost a second or more of the recording.

**Checked.**
- Stand-in OBS with options for a hidden source's pause let go, a clip wedged at 24 ms after a restart and a pause or skip, and a clip stalling on air: on the code before, the second clip came in at 24 ms (the owner's report); now every clip comes in at its part and plays, with the recoveries tested. The rendered path: layout, offsets, the status and graphic by cursor (within 0.13 s), Skip, Hold, the round clock with the sound faded first, the fallback when the file is slow or fails, Stop while it is made, Test replays, highlights with progress.
- ffmpeg: the file's length (the clips less the fades plus the frames held, to 0.05 s), keyframes at each clip's start, the sound silent, fading in, full, fading out, silent.
- Real OBS 30.0.2 (Linux, Xvfb, software rendering), four 6.2 s 1920×1072 29.97 fps clips with a tone, a Stinger in and out, 0.5 s fades, recordings read frame by frame: rendered, each clip from its part, about 0.4 s of blend at each fade, playback steady to 0.05 s, the sound fading in and out and crossfading; through the scenes, each clip loaded about 0.5 s before its fade and steady to 0.18 s with 43 % of OBS's renders skipped. Render time here (x264, 4 cores): 9.4–10.3 s.
- The feed with a real ffmpeg behind a pipe that stalls 3 s: no restart (before: *can't keep up … starts again*), clips across and after it on their moments; a pipe that never drains: started again after 5 s.

**Not checked.** A Windows OBS (the fix is for its ways, as the support file showed them); NVENC's render time on the owner's PC (if over 6 s, breaks play through the scenes, which now hold up on that OBS); the feed's skip with h264_nvenc on Windows.

## ADR-068 — Team Comms' dedicated recording: Source Record on a scene MatchFrame sets up, the scene's own sound on track 1, a recording-only speaker strip timed by the recording mix, and the delay calibrated against the gameplay

**Context.** The owner's brief (docs/specs/team-comms-brief.md), sections 8, 8.1, 9 and 11, phase 4: a separate gameplay recording that stays on gameplay whatever the program shows, with the normal HUD, the recording team's permitted delayed comms and a speaker strip that identifies who speaks (only in this recording); its own Start/Stop, team, levels, folder and status; the owner's reference picture for the strip; the comms delay calibrated against the observer's gameplay. ADR-065 chose Source Record for the second video path and put the recording mix on its own NDI source (ADR-066). Evidence: docs/operations/team-comms.md, phase 4.

**Decision.**
- **MatchFrame sets the scene up** over obs-websocket (`comms/recording.ts`): "MatchFrame Comms Recording Scene" (0.11.0 and earlier: "Matchframe Comms Recording", still used where OBS has it) with the live scene's own gameplay source and HUD browser source shared into it (one game capture and one HUD for both: they stay active, nothing to keep in step) with their transforms, the strip's browser source on top, DistroAV's "MatchFrame Comms Recording" (audio only, kept receiving), and a copy of the live scene's game audio input whose fader is the recording's game level; Source Record's filter on the scene. Existing sources are shared, never replaced; it can run again.
- **Source Record is detected by its filter kind** (`source_record_filter`, read from its source): `GetSourceFilterKindList` where obs-websocket has it (5.4+), else `GetSourceFilterDefaultSettings`, which OBS refuses with 607 for a kind it doesn't have. Missing: said plainly with the install steps; Start refused.
- **Sound: the scene's own** (Source Record's default). Measured: that is each source's track-1 audio after its fader and mute, and OBS mixes it only while an output uses track 1. So the recording's two audio inputs are on track 1 only (they are in no program scene, so never in the stream's mix), the casters are excluded by not being in the scene, and MatchFrame shows a fault while recording with track 1 unused (Simple output: streaming, recording or the replay buffer; Advanced: their tracks from the profile). Source Record's track modes record OBS's mix of the program, so they were not used. One stereo track: no separate stems from Source Record.
- **Start/Stop** is the filter's record mode (Always/None), set with its folder, file name, format (MKV by default), encoder (by default OBS's recording encoder, as Source Record picks it) and bitrate. Independent of the public listen-in (its controller never touches it; Mute All Comms leaves it). TeamSpeak's recording indicator on while recording. Status every second: elapsed, the file (found by its name, its growth), free space (warning, fault), track 1, the filter still recording, DistroAV receiving; faults in words. Never started by itself; a recording still running in OBS after an engine restart is carried on.
- **Team and levels:** the recording team is a team id; the recording mix crossfades through silence to it, and the strip's cards change on the same block. Comms level is MatchFrame's gain on the recording mix before NDI; game level the game audio copy's fader.
- **The speaker strip** (`comms/strip.ts`): its own page, script, socket and token on the overlay server, only ever in the recording scene; the public overlay's route and payload are unchanged (team-level only). Cards: the recording team's included people, at most seven, in roster order; clipped-corner hexagons with rounded corners, a substantial frame and a dark inset, grayscale with a grey frame while silent, colour with a green frame (#20FF00, configurable) while speaking, as live SVG; roster pictures (respecting a player's hidden photo), else the HUD images' default player picture, else the operator's placeholder, else MatchFrame's silhouette; a crop per portrait; anchor, position, size, spacing, colours, release, optional names. Speaking comes from the recording mix's per-person activity (the delayed samples actually mixed), with the strip's attack and release; each block's cards and speakers are sent at the block's output time plus the NDI send latency plus a calibrated offset. The page gets card ids, names, picture addresses, crops and layout, never TeamSpeak identities.
- **Calibration** (`comms/calibrate.ts`): a player's "mark" call at a visible moment, its start taken from that player's own incoming TeamSpeak stream (exact), and the operator's Seen when it shows in the gameplay in OBS; the median of a few marks less a stated reaction time and the NDI send latency is the suggested delay; the fine milliseconds and the strip's timing offset are then measured in a recording. The 0–300 s range plus fine ms is kept.

**Alternatives.**
- **Source Record's track modes** (record OBS's track N): measured to follow the program (a source not on program is missing), so not scene-independent.
- **A second OBS instance** (ADR-065's fallback): a second renderer and game capture; still the fallback if Source Record can't hold 1080p60 next to the stream on the owner's PC.
- **Driving the strip from TeamSpeak's talk events:** early by the whole delay and blind to inclusion; the recording mix's own samples are what the recording carries.
- **One strip page for public and recording with a flag:** one mistake would put people's names on air; separate routes, tokens and payloads instead.
- **Keeping track 1 in use by itself** (e.g. a second Source Record on track 1 or OBS's replay buffer): a second encoder for nothing; the broadcast streams on track 1 anyway, and MatchFrame says when it isn't.
- **Calibration from the GSI clock or the server's delay setting:** the brief rules them out; the gameplay as OBS shows it is what the comms must match.

**Checked.**
- Real OBS 30.0.2 with Source Record 0.4.8 (Linux, software rendering): what its audio modes record (above); detection with and without the plugin (607); MatchFrame's setup action, Start/Stop and status through its API; four 64 s recordings at a 90 s gameplay delay with the program cutting to casters, replay and break, Mute All Comms and a team switch mid-way: gameplay and HUD in every frame, the strip in every frame (five cards, then four), included voices present and excluded ones 40 dB or more below, casters absent, every voice onset (168 of 168 in the four recordings) lit its card; after one measured correction the strip 57 ms after the comms and the comms 47 ms before the gameplay (medians), with OBS rendering 7–9 frames a second. The strip and the recording comms reached this OBS through stand-ins (Chromium captured from the screen; a PulseAudio sink) because this build has no Browser Source and DistroAV can't be built for it.
- Fixture tests (`team-comms-strip.test.ts`, simulated clock, real bridge): who lights and when against the recording mix, overlapping speakers, a 90 s delay, the team change and an exclusion on the same block, release, the timing offset, card order and pictures; (`team-comms-recording.e2e.test.ts`, stand-in OBS): the setup, Start/Stop, signal, levels, track 1, free space, faults, adoption, the strip's page and token apart from the public overlay's.
- Playwright screenshots of the real strip page (generated placeholder portraits) against the reference's rules; console component tests.

**Not checked.** A Windows OBS with a real Browser Source and DistroAV in the recording scene; the GPU encoder's load at 1080p60 next to the stream; the offsets of that path (measured on the owner's PC with the calibration); a match-length recording and split files.

## ADR-069 — Team Comms phase 5: reconnects that never misassign or reopen, faults said as faults, team tabs remembered by the plugin, event presets, the plugin offered from the program, and a timing test found in the recording file

**Context.** The owner's brief (docs/specs/team-comms-brief.md), sections 3–5, 10, 11 and 12 step 5: reconnect handling and failure recovery against the acceptance rows "Reconnection", "Half-time" and "Failure"; event presets; installer and setup steps; real production validation. Phases 1–4 (ADR-065, ADR-066, ADR-068) built the capture, the mixes, the public listen-in and the dedicated recording; phase 4 left the recording's timing test. Evidence: docs/operations/team-comms.md, phase 5.

**Decision.**
- **Identity is the TeamSpeak unique identity, never the session id, at both ends.** The engine takes audio only from someone its tab's channel holds now (by identity): a block captured before the listener's tab moved, or from someone who left, is dropped and counted (`notInChannel`), never laid on another team's or person's buffer. The plugin keeps who left the channel for a few seconds, so a block captured before they left is still named after them even once TeamSpeak has given their session id to a newcomer, and it sends a person it discovers ahead of their first block (not queued behind it). Teams are matched by server and channel, never by tab order (a restarted TeamSpeak may connect the tabs the other way round). Newcomers stay excluded; the public gate never reopens by itself (unchanged, now tested through each reconnect path), and **Listen In needs the team's tab captured now**: delayed audio from before a loss still at the playhead no longer makes a team "ready" for it (the trial soak with real TeamSpeak showed a Listen In accepted then, which the reconnect would have carried back on air without a new press).
- **A plugin that stops answering is a lost source.** The bridge closes a plugin that has sent nothing for 6 s (it sends statistics every second and answers pings), on the computer's own clock: TeamSpeak frozen or a half-open connection is then silence and FAULT, not a listen-in left open on a dead stream. When MatchFrame itself didn't run (a ping round more than a second late: the computer frozen or asleep, a long stall), what the plugins sent meanwhile is still unread when that round runs, so every plugin's silence counts from then instead: a 17.7 s freeze of the whole test machine during a restart check closed both plugins (both teams FAULT and buffering again) before this.
- **The plugin remembers the team tabs** (server unique id, channel name and the address TeamSpeak dials, at most four, in `matchframe_comms_tabs.txt` in TeamSpeak's own config folder via `getConfigPath`): while team tabs are remembered, a connection the plugin hasn't settled is silent here from its first block, decided in the playback callbacks themselves (lock-free), and settled on TeamSpeak's main thread once its channel and server id are known (at the connection, the tab's next client move or talk event): in a remembered team channel listen-only and silent before MatchFrame answers, elsewhere released (it plays), except that on a team's server it stays silent for 3 s after connecting (a new connection lands in the default channel first and is moved on: releasing it there let the team's voices through). The first soak with real TeamSpeak caught about 220 ms of a team's voices while a restarted client was connecting. Deciding earlier (from TeamSpeak's status callbacks, then in the playback callbacks themselves, then with the 3 s on a team's server) cut that to 10–100 ms, audible in 10 of 14 measured restarts: under load TeamSpeak's playback thread runs on a new connection before its main thread has reported even "connecting", and a tab released in the default channel played as it was moved on. A temporary probe in the plugin (each block it didn't silence, with its state) then showed the rest was MatchFrame's: it handed the restored tab back on TeamSpeak's first report of the connection, sent before TeamSpeak had filled in the server's address, and took it over again on the next report 5–80 ms later. Capture still waits for MatchFrame. **MatchFrame hands back** (MANAGE with no flags, the plugin forgets it) a remembered tab that is in no team's server and channel now, **only once its server (unique id and address) and channel are known**; with that, four restarts (three in a row, one in the second soak) played nothing (the listener's playback recorded throughout, every voice block and mix zeroed by the plugin). The plugin's writers of its managed table take a lock; the audio callback still reads it without one.
- **Connecting team tabs from MatchFrame: TeamSpeak's own links, not `guiConnect`.** Plugin API 26 has `guiConnect`, `guiConnectBookmark`, `startConnection` and bookmark functions, but no way for a plugin's own thread to run something on TeamSpeak's main (GUI) thread, and calling GUI functions from the plugin's sender thread can't be shown safe here (no Windows TeamSpeak). MatchFrame gives each team's `ts3server://` link (server, port, listener nickname, channel; no password), the form TeamSpeak's command line takes (the real-TeamSpeak rig connects its listeners with it): *Connect in TeamSpeak* hands it to TeamSpeak through the operating system (the program opens only links of exactly that form), Copy link for a bookmark; and MatchFrame shows which TeamSpeak tab is which team. Whether a running TeamSpeak opens such a link in a new tab or the current one is TeamSpeak's choice (not tested on Windows).
- **The NDI process restarts with a back-off**: 3 s after it stops, doubling while it keeps stopping soon after a start (6, 12, 24, at most 30 s), back to 3 s after a minute of good running; the status gives the restarts, the last exit and the next start. While it is down nothing reaches OBS (the public route is silent and a listen-in is FAULT, as before).
- **Buffered voice in pages.** Each person's buffer copies its blocks into 1 s pages and keeps views of them, instead of one memory allocation per block (a 90 s delay holds about 57 000 blocks for 14 people). An A/B on an idle machine (14 people talking, 90 s delay, the real render timer, 120 s measured, twice each): garbage collection 206–214 ms against 274–327 ms, its longest pause 8.7–9.2 ms against 13.8–32.2 ms, the engine's CPU 9–18 % lower, heap 27–28 MB against 36–42 MB. Blocks rendered more than 50 ms late were rare either way (0–8 of 12 000, with collector pauses under 10 ms: not the collector), so the soak's NDI misses (below) came from that machine's overload, not the engine's memory; the NDI send latency stays 60 ms (raised in the outputs' settings on a PC whose support file shows late blocks; it adds to the comms' path in OBS, so calibrate after).
- **Recording faults are explicit** (RECORDING FAULT with the reason, no longer a warning): the recording comms not sent (the NDI process down or restarting, Team Comms or its NDI output off), OBS disconnected (MatchFrame can't confirm the file), besides phase 4's filter and file faults. OBS back with Source Record still recording (or recording again into a new file by itself) clears it; OBS back with Source Record stopped names that and Start begins a new file (the faulted run is closed as such). Caster ducking was already re-applied on OBS's reconnect and released when OBS answers.
- **Event presets** (`comms/presets.ts`, settings `comms.presets`): by name, with the active match's event (or none): each identity's mapping, display name, Include in Broadcast, Include in Recording and level; each team slot's server, port, channel, listener nickname and identity name; the delay; the recording team and its comms and game levels; the strip's settings; the on-air settings. Never the public gate (nothing about it is saved; loading a preset never opens or closes it), the Solo, passwords or tokens (they stay in the secure settings per slot), the recording's folder or format. Loading applies the people it names and leaves the rest (new arrivals stay excluded); the active preset shows what differs from it now (a newcomer still as MatchFrame meets anyone isn't a difference). Save as, Save, Load, Rename, Delete.
- **The plugin from the program and a guided checklist** (`comms/setup.ts`): the program already ships `resources/ts3-plugin` (the Windows build stays non-fatal in CI); *Install TeamSpeak plugin* copies this computer's binary into TeamSpeak 3's plugins folder (via a temporary name), and says to close TeamSpeak when the copy is refused (TeamSpeak holds the file); the program's window can open TeamSpeak's plugins folder or the package. The checklist reads each step live from the existing checks: TeamSpeak plugin (in the program, installed and the same build, connected, both team tabs), DistroAV (OBS's NDI source kind, MatchFrame sending, receivers on both sources), Source Record, OBS scenes (live scene, public comms source, banner, recording scene and recorder, nothing of the recording on air), calibration (the marks' delay applied, the timing test).
- **The timing test** (`comms/timing-test.ts`): five 200 ms beeps at 3 150 Hz, a second apart, added to the recording output only (after the comms level, never public, preview or the mixes), and every strip card lit on exactly the beeps' blocks (both start on a block boundary). In the finished file ffmpeg reads the strip's area of the picture (scaled from the 1920×1080 layout, frames 1:1 with their own times) and the sound (placed by its first decoded frame's time: an AAC track's priming starts before zero), finds each beep's start and each flash's first frame, and from their median difference D suggests the strip's offset (less D) and, when the delay is the marks' suggestion, the fine ms less the comms' extra path in OBS (the strip's offset then less D), taking the browser source to show the gameplay's frame. Only a file of the dedicated recording can be analysed.

**Alternatives.**
- **Trusting session ids within a short window, or re-resolving identities in the engine from TeamSpeak's lists:** a reused session id is exactly the case that misassigns; the identity travels with every block instead, and the engine checks it against the channel.
- **Persisting the managed tabs in MatchFrame's data folder:** the plugin would write into another program's folder and still need MatchFrame's file to start silent; TeamSpeak's own config folder is the plugin's.
- **`guiConnect` from the sender thread, or a hidden window to reach TeamSpeak's main thread on Windows:** untestable here and Windows-only; a plugin menu item (`onMenuItemEvent`, main thread) would work but needs the operator in TeamSpeak anyway, which the links already give.
- **A longer NDI send latency by default (100–150 ms):** it would hide stalls of an overloaded PC, but it delays every mute and moves the calibration; on an idle machine 60 ms missed at most 8 of 12 000 blocks, and the setting is there for a PC that needs more.
- **Restarting the NDI process at a fixed 3 s:** a crash loop restarts twenty times a minute and floods the log; the back-off keeps trying without that.
- **Restarting Source Record automatically after OBS comes back:** the operator may have stopped it on purpose; MatchFrame says what happened and Start is one press.
- **Presets as an export file:** the brief asks for presets saved with the event; a file would carry identities around and invite passwords into it.
- **Copying the plugin with TeamSpeak running, or killing TeamSpeak:** TeamSpeak holds the DLL; MatchFrame never closes another program for the operator.
- **A timing test by eye only (phase 4):** it stays as the fallback; the beep and flash are on the same engine block, so the file measures exactly the two OBS paths.

**Checked.**
- Fixture tests (simulated clock, real bridge, stand-in plugin, stand-in NDI process): a TeamSpeak restart with a new plugin instance, the tabs in the other order and every session id new; a reused session id; MatchFrame restarted while TeamSpeak runs (the plugin reconnects from the bridge file); a team tab disconnecting and reconnecting; the listener's tab moved to the lobby, into the other team's channel and back; a frozen plugin; the NDI process crashing repeatedly (back-off 3, 6, 12, 24, 30, 30 s, reset after a minute); in each, identities and choices kept, the stranger excluded, the public output exact zeros from the loss and FAULT until an explicit Listen In, the recording silent from the gap until a full delay of new capture (never fresh audio).
- Through the engine (stand-in OBS): halftime from the game data (CS2's sides swapped; slots, listen-in, recording team and both outputs unchanged); the recording's NDI and OBS faults, OBS back with Source Record recording (a new file found) or stopped (Start again); ducking across an OBS restart; presets; the installer and checklist.
- The plugin binary (g++, stand-in host): the tabs remembered, a restarted host with no MatchFrame silent and listen-only from the first block (and a tab in another channel untouched), a remembered tab no team's handed back and forgotten. The Windows DLL (mingw-w64) under Wine: the same, through a non-ASCII path. CMake builds (Linux, mingw-w64) clean.
- The timing test against a file made with ffmpeg (beeps 120 ms before the strip's flashes, AAC in MKV): 5 of 5 found, 120.5 ms measured.
- Two soaks with real TeamSpeak (docs/operations/team-comms.md, phase 5 evidence), 47 min each, 44 and 45 of them with 14 TeamSpeak clients talking through the plugin (7 per team, 2–5 at once), a 90 s delay, Listen In switching every minute, the recording team every five, NDI received in another process, the console's status polled and a listener's TeamSpeak killed and restarted: 2.25 and 2.14 million blocks with 0 gaps and 0 plugin queue drops; clock offsets moved at most 0.39 ms, 0 steps; no 100 ms of either output with an excluded or other-team voice above 0.01; every closed public block exact zeros; engine memory flat once the buffers held the delay. The first (the first build) found the Listen In gap and the restart's playback above; the second (the final build): nothing of the team played at the restart, no strip message late, 0.018 % of NDI blocks not ready in time (1.9 % in the first, on an overloaded machine). Restart checks between them (25 restarts in 11 runs, the soaks included) found MatchFrame's early hand-back and the liveness flaw above.

**Not checked.** The plugin in TeamSpeak 3 on Windows (remembering the tabs there, its config folder); MSVC's build (CI, non-fatal); the installer copying into a real `%APPDATA%\TS3Client\plugins` with TeamSpeak running; the timing test on a Source Record file from the owner's OBS (DistroAV and a Browser Source); DistroAV's behaviour across MatchFrame's NDI process restarting.

## ADR-071 — One product name (MatchFrame) and neutral names for the HUD compatibility layer, with every earlier name still read

**Context.** The owner: the product is branded MatchFrame Esports throughout, with no other product's branding. Up to 0.11.0 the program wrote "Matchframe" in places people see and in names it gives things (OBS scenes, sources and transitions; folders; the installer), and named its support for imported hud.json-format HUDs after the commercial HUD program that format was made for (ids `lhm.<slug>`, manifest `runtime: "lhm"`, category "LHM", the cookie `mf_lhm_<id>`, `lhm.ts`, `lhm-runtime.ts`). Operators' computers, OBS collections, OBS browser source URLs and account-sync data carry those names.

**Decision.**
- **Visible name:** "MatchFrame Esports" / "MatchFrame" in every user-visible string. Lowercase identifiers stay (`@matchframe/*`, `matchframe-default`, `app://matchframe`, `MATCHFRAME_*`, settings keys, cookies, `com.matchframe.esports`).
- **Names the program gives things and finds again** (`services/local-engine/src/brand.ts`): new OBS scenes, sources and transitions use "MatchFrame …"; a lookup uses the new name when it exists (or nothing does), else the old spelling (`existingName`), so an OBS set up by 0.11.0 is used, never doubled. The Team Comms recording scene is now "MatchFrame Comms Recording Scene": its old name differed from its NDI source "MatchFrame Comms Recording" only in case. Folders (`brandedFolder`): the data folder and the Videos folders ("MatchFrame Highlights", "MatchFrame Comms Recordings") are the ones on disk under either spelling, exactly as named there, else the new name. On Windows and macOS this is the same folder, so stored paths stay valid; on a case-sensitive file system the old folder keeps being used. The TeamSpeak plugin finds the data folder the same way on macOS.
- **Installer:** product name, executable, shortcuts and uninstaller "MatchFrame Esports"; files `MatchFrameEsports-Setup-<version>.exe` and `MatchFrameEsports-<version>-win.zip`. `appId com.matchframe.esports` is kept: it keys the NSIS uninstall entry and the upgrade path. Installed 0.11.0 programs update through `latest.yml`, which names the new file (the first update downloads in full: the differential download looks for the previous installer's blockmap under the new file name and falls back). The website serves installers under either file name.
- **HUD compatibility layer:** `compat.ts`, `compat-runtime.ts`, `compat-migration.ts`, runtime `"compat"`, new ids `imported.<slug>`, category "Imported", cookie `mf_compat_<id>`. Legacy input is read and migrated, never written: the manifest schema reads `"lhm"` as `"compat"`; at engine start `migrateLegacyHuds` moves each `lhm.<slug>` HUD (folder, library row with its token and settings, outputs and published revisions, program settings, other HUDs' settings, account-sync record) to `imported.<slug>` and rewrites its manifests with their checksums; account sync maps HUDs shared by computers still on 0.11.0; imports of packages exported by 0.11.0 are brought up to date; the desktop program moves its window placements. Old addresses (`/hud/lhm.<slug>/…`, `/huds/lhm.<slug>/…`, `output=hud:lhm.<slug>`) and the 0.11.0 cookie keep working with the same token. A HUD whose new id is taken or longer than 64 characters keeps its legacy id.
- **Compatibility identifiers kept on purpose:** `LEGACY_IMPORTED_HUD_PREFIX = "lhm."`, `LEGACY_COMPAT_RUNTIME = "lhm"`, the cookie prefix `mf_lhm_` (read only), `LEGACY_PRODUCT_NAME = "Matchframe"` and `LEGACY_RECORDING_SCENE` (read only), `LEGACY_GSI_CONFIG_NAME` (a CS2 config file written by 0.11.0 is still recognised), and what the hud.json format fixes for the HUDs themselves: `/api/…` paths, socket.io event names, JSON field names such as `lhmId`, the file names `hud.json`, `panel.json` and `keybinds.json`, and the camera room id.
- **Third-party notices:** the MIT texts and copyright lines of the HUD template, weapon icons and radar images live in `third-party-licenses/` next to the shipped files and in THIRD_PARTY_NOTICES.md, nowhere else.

**Consequences.** An update from 0.11.0 keeps teams, players, matches, pictures, HUDs, their settings and tokens, OBS scenes and sources, and folders, and changes no stored path text on Windows. A second start changes nothing (`test/upgrade-0110.e2e.test.ts` on a data folder made by the 0.11.0 engine; `test/obs-legacy-names.e2e.test.ts` with a stand-in OBS). A computer still on 0.11.0 can't install a HUD shared under its new id (its manifest schema has no `"compat"`); its own legacy records keep working there.

**Revisit if.** All computers of an organisation are past 0.12.0 and a later release can drop reading the legacy names.

## ADR-072 — Stage HUD: a tournament-stage layout in MatchFrame's own look

**Context.** The owner sent phone recordings of a major tournament's grand-final broadcast and asked for "a similar HUD", then: "Go as close as you can to it without having issues with copyright."

**Decision.**
- **What is matched** (layout and CS conventions, measured from the recordings at 1920×1080 and checked side by side and blended over them):
  - the position, size and proportions of every panel: series strip (16, 28) and minimap under it; event line and score bar (760–1160, 28–128) with the players-alive badge under it; sponsor slot and killfeed top right; the team tab (16, 614) and five 308×72 cards per side every 84 px; the observed player's cam and name bar (812–1108, 858–1062); the scoreboard bar (44–1876, 769–1031: a 64 px header and five 36 px rows, the sponsor block 600 px wide in the middle) and the timeout callout over its end;
  - the information and its order: card = slot number, name, photo, weapons, health, kills and deaths, money, armour and kit; scoreboard header = equipment value, loss bonus, timeouts left, logo, tag, series boxes, score; row = photo, name, armour, kit, grenades, pistol, main weapon, money;
  - the states: players alive in side colours under the bar, dead cards grey with a skull, the observed card lit, the scoreboard in freeze time and timeouts with the sponsor in the middle;
  - CS side colours (CT blue, T gold), a dark panel base and a condensed bold uppercase face (Barlow Condensed, already bundled).
- **What is MatchFrame's own:** flat deep-navy panels with chamfered corners (no textured royal-blue panels), team-colour edge rules, the event line without any emblem, diamond series boxes and round-kill marks, skewed timeout pips, MatchFrame's glyphs (bomb, kit, armour, grenades, skull, kill mark, player figure) with the bundled MIT weapon silhouettes, its own motion (cards slide in from the edges in turn, the scoreboard header opens from the centre and its rows rise, the alive badge drops in). No logo, name or mark of the event, its organiser or its sponsors; no reference frame in the repository.
- **Left out:** the coach row over the scoreboard (HudState has no coach), per-player voice and mute icons (Team Comms never shows a player's comms on air), the organiser's logo slot top right and the trophy emblem.
- **Data:** the event line reads `event.stage` and `event.matchTitle`, new optional HudState fields (the active match's stage name and title), else the setting, else the series length. Sponsor spots show only the operator's sponsors (`sponsors.top_bar`, `sponsors.scoreboard_slot`) and nothing otherwise. The cam is the player cams integration (`/hud-runtime/cams.js`, the shared `PlayerCam`); the killfeed is the HUD renderer's shared component restyled; the minimap is the shared `MapRadar`.
- **Phases:** the scoreboard replaces the cards whenever the round is not under way or just won (the same split as Lineup): freeze time, timeouts, pauses, half time and warm-up.

**Checked.** Typecheck, lint, the test suite; every demo scene at 1920×1080 (live with the stand-in cam, kills with dead cards, planting, bomb, defuse, round won, freeze time, timeout), compared side by side and blended with the reference frames for position, and against the references' styling for difference.

**Not checked.** On the owner's PC over CS2, in OBS, and with a real player cam on air.

## ADR-073 — Stage HUD closer to the reference: side-coloured cards, the round MVP card and coaches

**Context.** The owner, after ADR-072's screenshots: "Can you make it even more similar", then a second frame of the same broadcast (the left team on T with gold cards, a tall "key player" card in its list, the next round 15 s in), asking for an 8 or 9 out of 10 on closeness while keeping the line drawn in ADR-072.

**Decision.**
- **Cards:** filled with the side colour as far as the player's health, grey beyond, as the reference does, in MatchFrame's own shades: the team colour mixed 60 % into deep navy (computed in the page; OBS's browser has no CSS `color-mix`), so white text reads on CS gold too; the observed card 74 %. Sizes and order measured from both frames (slot strip 12 px, name 21 px, K/D 18 px, money 19 px, photo 48 px, weapons from 16 px past the photo with the grenades under them, health 39 px with armour and kit or bomb under it). Dead cards shrink (clip-path) to the name and photo plus a 56 px skull area.
- **Round MVP card:** in place of the key player's card, 308×214 (measured: the reference's is 306×215), bottom-aligned so the cards below keep their places. Shown at the round's end, in freeze time when the cards are up (the scoreboard replaces them by default), and for the first 15 s of the next round, as in the reference frame (taken at 1:40). Wording "ROUND MVP"; the picture stands on the card, contained and faded at its foot so a square photo works too.
- **Round MVP data:** CS2 resets round kills and damage at the next freeze time, so the engine keeps each round's players at its end (`RoundMvpTracker`): the update that ends the round usually carries the final stats (the round counter has already moved on, so the reconciler files it as `.hist`; the tracker instead takes only the end of the round it saw live), else the last live update. The key player is the one whose CS2 MVP count went up at the round's end, else the winning side's player with the most kills, then damage. `HudState.lastRound` is looked up by the last round in each output's own round history, so a delayed output shows it when its timeline reaches that round's end, like the round winners kept at round end.
- **Coaches:** `HudTeam.coach` is the team's current roster member with the role coach (name, photo when it may be shown), through a `coachOf` lookup in the HUD context; shown over each end of the scoreboard bar with a COACH tag. No voice or mute indicator (Team Comms).
- **Observed player without a cam:** the player's picture on a transparent backdrop instead of a dark box; the name bar is side-coloured with K/A/D in it.
- **Also matched:** series-strip arrows and picker logos, side-coloured team tabs and alive boxes, killfeed rows tinted by the killer's side, score bar sizes (logo boxes, digits, round and clock), the side-colour bar under each score, players alive only once someone is down.
- **Kept MatchFrame's own (unchanged line):** flat dark-navy neutral panels (score bar, event line, scoreboard header, MVP card), own chamfers and arrows, own icons with the MIT weapon silhouettes, no emblem, no organiser or sponsor names or logos, no reference frame in the repository.

**Checked.** Typecheck, lint, the test suite (new: MVP choice, projection on a delayed timeline, coaches, and game data through the engine to live and delayed outputs); every demo scene at 1920×1080 blended with the three reference frames.

**Not checked.** CS2's exact timing of the MVP count against the round's end on a real server (both orders are handled); a real coach on a roster in CS2 (the coach slot in the game data is left out of the teams as before).

## ADR-074 — Icon pack: Counter-Strike 2's icons loaded by the operator, never shipped

**Context.** The owner wants the HUD to use CS2's own icons, pointing at a public repository of them (github.com/Juknum/counter-strike-icons, `cs2/panorama/images/icons`). Its licence says the icons are Valve's property and not licensed for commercial use without Valve's permission. MatchFrame is a paid product, so it may not bundle them.

**Decision.**
- **Never shipped:** no CS2 icon in the repository, packages, fixtures, tests or documentation screenshots. The operator loads them on their own computer: **Import ZIP…**, **Import folder…** or **Get CS2 icons**, which downloads them at their press from that repository to their computer, for their own broadcast (the help text says so). They stay in `<dataDir>/icon-pack/`, are not synced, and the overlay server serves them only to the HUDs on that computer.
- **What is kept:** every `equipment` icon (weapons, grenades, armour, kits, the bomb, knives) and a fixed list of `ui` marks (kill, kill_headshot, elimination, elimination_headshot, health, armor, helmet, defuser, bomb, bomb_c4, bomb_icon, map_death, dollar_sign, stat_assists, stat_headshots, stat_mvps, star, timer, clock, pause, player, switch_teams_dead, dominated_dead); `planted_c4` is in `equipment`. Found under any `panorama/images/icons/{equipment,ui}/` path (CS2's tree over another game's in the same repository; on a shared name the HUD's `ui` icon over the buy menu's) or straight in a chosen folder. Get CS2 icons lists the `equipment` folder through GitHub's contents API (names only) and falls back to a built-in list of names.
- **Untrusted SVG:** a small checker rather than a dependency: well-formed tags with one `<svg>` root; refused: script, foreignObject, iframe, embed, object, a, image, animation elements, event attributes, `javascript:`/`data:` values, references other than `#id` (attributes and CSS `url()`), `@import`, DTD internal subsets (entities) and processing instructions. The XML declaration, comments and a plain DOCTYPE are dropped. 634 of the 638 icons of CS2's two folders pass (the 4 refused declare entities and are not HUD icons). Served as `image/svg+xml` with `nosniff` and `default-src 'none'; style-src 'unsafe-inline'; sandbox`. Caps: ZIP 200 MB (only candidate SVGs within 512 KB are decompressed), 512 KB an SVG, 20 MB kept, 400 icons.
- **HUDs:** `HudState.art.iconPack` = `{ names, base: "/icon-pack/" }` or null, refreshed at once on a change. The Stage HUD resolves every icon through one resolver and draws a set's icon as a CSS mask over `currentColor` (the icons are white silhouettes), sized by a hidden copy of the icon. Other HUDs are unchanged.
- **The owner's icon set first** (the owner: "Use these icons as a priority and whatever hasn't been used use the other icons"): the owner's own pack of white PNG silhouettes (its README: generated recreations, not Valve's assets) is bundled with the Stage package, renamed to CS2's weapon ids, its faint background (alpha below 16) removed, cropped and scaled to 64 px tall (219 KB for 64 icons). Resolution is by name, most specific first, and for each name the owner's set before the loaded pack: a karambit is the pack's karambit, a knife without its own icon is the owner's knife. Only icons with a place and data are bundled: no airborne, no-scope, through-smoke, wallbang or reload (the killfeed and player data have no such fields), no labelled round timer (the clock is text), no shield (vest and helmet cover armour); the labelled TIMEOUT mark sits in the timeout callout, the PC-pause mark in MATCH PAUSED.
- **Download:** at most 4 requests at a time, a 15 s timeout each, one retry; progress through the status route; a clear error suggesting Import ZIP… when nothing could be fetched. Tests use a stand-in server through a configurable source (`iconPackSource`, `MATCHFRAME_ICON_PACK_BASE`/`_LIST`).

**Checked.** Unit and end-to-end tests with icons written in the tests; the console panel; the Stage HUD's scenes with the pack imported from a local copy (screenshots outside the repository).

**Not checked.** Get CS2 icons against GitHub itself from this environment (it was exercised against a stand-in server); the program's folder picker for the icon pack on Windows.

## ADR-075 — Stage HUD third pass: royal-blue panels, plain rectangles, a tall condensed face

**Context.** After ADR-073 the owner said: "I don't need the coach in the baseboard. And it's still nowhere near being close to the [reference] one." The biggest gap was the neutral panels' colour (theirs bright royal blue, ours dark navy), then the shapes (theirs plain rectangles, ours chamfered) and the typeface.

**Decision.**
- **Colour:** the neutral panels are a flat royal blue of MatchFrame's own: #1d449a to #163780 top to bottom, event band #15357f, killfeed rows rgba(26, 63, 143, 0.9). Measured from the frames, the reference's base is a deeper, textured ultramarine (about #021c74 with highlights to #1b34af); ours is lighter, slightly more cyan and flat, with no texture or pattern. A **Panel colour** setting keeps dark navy available. Cards stay in the side colours; the CT and T defaults moved to #3d7ee6 and #e6b83a, so the shaded fills (60 % into navy) land near the reference's royal blue and olive gold; tabs, slot strips and score bars use a pale tint (62 % towards white), as theirs do.
- **Shapes:** every chamfer and angled cut removed; panels are rectangles. Dead cards still shrink, with `clip-path: inset()`.
- **Score bar and scoreboard** rebuilt to the measured sizes (see the changelog); the series boxes are small upright bars; labels as theirs: EQUIPMENT VALUE, LOSS BONUS, TIMEOUTS REMAINING; scoreboard rows as dark cells with green money; the scoreboard sponsor fills its block.
- **Typography:** rendered next to the reference's lettering, Antonio (OFL) was the closest of Barlow Condensed, Oswald, Teko, Bebas Neue and Antonio: tall, narrow, flat-sided digits. Weights 500 to 700, bundled with its licence (`OFL-Antonio.txt`).
- **Coach:** not drawn; `HudTeam.coach` remains in the state (harmless, other HUDs may use it).
- **Comparisons:** demo pages can place players on Mirage's real radar image (`?radar=mirage`; MIT, already shipped with the program; served by the screenshot scripts, never packaged), show a made-up sponsor (SAMPLE CO, drawn here) and better placeholder portraits. Side-by-side renders use a blurred, darkened game frame as their background, kept outside the repository; the committed renders and the thumbnail use the scripts' own gradient.
- **Unchanged line:** no organiser or sponsor names or logos, no trophy or emblem, no texture artwork, no traced artwork; own icons, the owner's icon set and the MIT weapon icons.


## ADR-076 — Releases: code signing when a certificate is added, Stable and Beta update channels, going back to a previous version safely

**Context.** The owner picked three features from the roadmap to 1.0: signed releases (no certificate bought yet, so the build must sign as soon as one is added), a Beta update channel, and one-click rollback to an earlier version. The hard part of rollback is the data: the engine migrates its SQLite database forward and an older engine had no idea a database was newer than it, so it would open it and could damage it.

**Decision.**
- **Code signing:** unsigned exactly as before unless the Windows workflow has secrets, in this order of preference. *Azure Artifact Signing* (Microsoft's service, formerly Trusted Signing): secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (an app registration with the Artifact Signing Certificate Profile Signer role) and variables or secrets `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_SIGNING_CERTIFICATE_PROFILE`, `AZURE_SIGNING_PUBLISHER_NAME`; the workflow adds `win.azureSignOptions` on electron-builder's command line (`-c.win.azureSignOptions.*`, merged onto `electron-builder.yml`), because electron-builder switches to Azure whenever that key exists, so it can't live in the file. *A certificate authority's cloud signing tool*: since mid-2023 new OV/EV certificates keep their key on hardware, so a fresh one usually can't be a PFX in a secret; rather than integrate one authority's tool, a hook: `WIN_SIGN_COMMAND` (a command line with `{file}`) and `WIN_SIGN_PUBLISHER_NAME` make the workflow pass `apps/desktop/custom-sign.mjs` as `win.signtoolOptions.sign` (with `publisherName`), which runs the command once per file (electron-builder calls it once per hash algorithm) and never prints it; installing a particular tool and its login are left for when an authority is chosen. *An existing PFX certificate*: secrets `CSC_LINK` (base64) and `CSC_KEY_PASSWORD`, as before. A half-set method fails the build (never a release unsigned by mistake). Signed builds are checked with `Get-AuthenticodeSignature`: the installer and `win-unpacked` program after packaging and the installed program after the silent install must be `Valid` (the signer is printed); `app-update.yml` must name the publisher; a typed publisher name (Azure, custom) must equal the certificate's name, because installed signed programs accept only updates signed by that name (electron-updater's publisher check). Owner's guide: `docs/operations/code-signing.md` (eligibility first: individuals in the USA and Canada, organisations in the USA, Canada, the EU and the UK; no free, trial or sponsored subscriptions; billing from the signing account's creation; identity validation with a photo ID and selfie through Entra Verified ID, 1 to 20 business days; the seven portal steps).
- **Channels:** `program-settings.json` `updateChannel`, Stable (default) or Beta, in Settings → General → Program. Betas are versions like `0.13.0-beta.1`, released as GitHub prereleases. `electron-builder.yml` sets `publish.channel: ${channel}` (for the GitHub provider electron-builder doesn't take the channel from the version itself), so a beta writes `beta.yml` and a Stable version `latest.yml`. The program sets electron-updater's `channel`/`allowPrerelease`/`allowDowngrade` per channel (`versions.ts`): Stable reads GitHub's latest release and `latest.yml`; Beta reads the newest release in the feed, `beta.yml` for a beta, a newer Stable release through its `latest.yml`. **Back on Stable while running a beta**, downgrades are allowed for the check only: the older Stable version is offered (`downgrade` in the update state, "Install <version>…") and installs only through going back (below), after the operator confirms; it is never downloaded by electron-updater. A beta already downloaded when the operator switches to Stable doesn't install on quit (`fitsChannel`). The workflow: a version with a prerelease suffix must look like `x.y.z-beta.n` and agree with the tag; the build must write `beta.yml` and not `latest.yml` (and the reverse for Stable); the release is created with `--prerelease`, and a beta published without that box ticked is marked as one (otherwise Stable programs would see it as the latest release).
- **Going back to a previous version** (`rollback.ts`): lists up to 10 earlier Stable releases from the GitHub releases API (not drafts or prereleases, with `MatchFrameEsports-Setup-<v>.exe` and `SHA256SUMS.txt`). On a choice: decide what happens to the data (below; refused before anything is downloaded), download the installer while hashing it, compare with the release's `SHA256SUMS.txt` (a mismatch deletes it and changes nothing), ask in a native dialog that says what happens to the data, stop the engine, decide again with it stopped (must match what was confirmed), restore the data copy if needed, turn automatic update downloads off (so the earlier version doesn't download the newer one and install it on its next quit), keep a downloaded update from installing on quit, and run the installer the way electron-updater does (`--updated /S --force-run`: silent, the registered install folder, user data kept by electron-builder's NSIS script, the program started afterwards). Electron's userData (`<dataDir>/program`) and the HUD folder are never touched. All Electron calls are injected, so the flow is tested against a stand-in release feed.
- **Data safety** (`services/local-engine/src/db/version-backups.ts`): the engine already copied the database before each migration; the copy is now named `matchframe-v<format>-from-<version>-<time>.sqlite`, the version being the last `engine.start` in the audit log. Every engine since the first records `engine.start` with its version and the format it left the database in (checked on the 0.11.0 fixture), so the database itself says which versions used it and in which format. Going back to V: no database → nothing to do; V used today's format or a newer one → data kept as it is; V used an older format → the newest copy in V's format is restored (copies from 0.12.4 and earlier, without `-from-`, count by their format), checked with `quick_check` and its format first, and today's database is kept as another copy (WAL checkpointed first, `-wal`/`-shm` removed, the copy renamed into place); V never used this data and no copy says which format it reads → refused with an explanation. "Same format reads the same data" is the line migrations already draw.
- **Newer database:** `Database.migrate` refuses a database whose format is newer than the engine knows (`NewerDatabaseError`) before reading or writing anything, saying which version saved it and how to get back. The engine sends it to the program (`{ type: "fatal" }`), which stops restarting the engine, shows it with a link to the releases page and quits. Versions up to 0.12.4 have no such check, which is why going back always restores the right copy first.

**Checked.** Typecheck and lint; tests for version order and channel settings, release selection, `SHA256SUMS.txt` parsing, the verified download (match, mismatch, unlisted), the whole flow on the 0.11.0 data folder updated twice (restore, refusal before download, mismatch, cancel), backup naming and pairing, restore, a damaged copy, and the newer-format refusal leaving the file byte-for-byte unchanged; electron-builder's own code for the `${channel}` macro and for `--config` plus `-c.win.azureSignOptions.*` (parsed by its CLI and merged onto the file); the workflow's YAML and bash steps (`bash -n`, and the signing choice run with dummy values in its six cases); the custom signing hook (once per file, the command never in its error) and its resolution by electron-builder; the bundled main process loads `node:sqlite` only when going back.

**Not checked.** Anything on Windows: signing with any of the three methods (and electron-builder's TrustedSigning module against the renamed service), `Get-AuthenticodeSignature` on a signed build, the NSIS installer of an older version over a newer one with `--updated /S --force-run`, electron-updater against real `beta.yml` prereleases on GitHub, the GitHub releases API from the program, and the native dialogs. SmartScreen's reputation after signing is Microsoft's.

## ADR-077 — Opt-in crash reports: the support file and what crashed, sent by the program, kept 90 days, read by staff

**Context.** The owner picked crash reporting from the roadmap to 1.0: when the program crashes on an operator's PC, support should get the support file without asking the operator to find and email it. It must be opt-in and off by default, must not nag, and the owner is cost-conscious.

**Decision.**
- **Consent.** Settings → General → Program → **Send crash reports** (off by default; `crashReports` in the program's `program-settings.json`). A crash while it is off is kept on the computer, and the next start asks once: "MatchFrame closed unexpectedly. Send a crash report?" with **Send**, **Don't send** (also Escape) and **Always send** (turns the setting on). One question covers every crash since; no other prompt. Turning the setting on sends what waits; turning it off puts unsent reports back to waiting (asked about at the next start).
- **What counts as a crash** (`apps/desktop/src/crash/reporter.ts`): an uncaught exception in Electron's main process (the program keeps running, and shows the same error box Electron shows when nothing handles one); `render-process-gone` of the manager window, a desktop HUD or a HUD preview (not `clean-exit` or `memory-eviction`); the engine exiting when nobody asked it to, with a non-zero exit code or a signal (restart, remote mode, network access change and quit mark their stops; exit code 0 only follows a stop request; nothing counts while Windows logs off or shuts down, when Electron sends no `before-quit`); native crashes: Electron's `crashReporter` writes minidumps on this computer only (`uploadToServer: false`, `<userData>/Crashpad`); one not seen before is reported at the next start, or attached to the renderer report it belongs to. Minidumps already there at the first start with this feature are not reported.
- **What is sent** (`CrashReportUpload` in `@matchframe/cloud-contracts`): the support file as the engine makes it (Settings → Diagnostics), plus version, OS, which process, reason, error and stack, uptime of the process and of the program, process details (exit code and signal, window, HUD id, the engine's last 80 output lines) and a minidump when it is at most 2 MB. The support file is taken at the crash when the engine can still make one, else from the restarted engine (a report waits up to 3 minutes for it; `supportFileAt` says when). Remote mode sends no support file (it would describe the production computer, not this one).
- **Redaction**, checked and tightened: the support file's sections were built without secrets and log data was redacted when written, but log messages, error text and keys like `apiKey`/`privateKey` were not, and `host.hostnameHash` was the start of the hostname in base64, not a hash. Now one pass (`services/local-engine/src/support-redact.ts`) runs over the whole support file in the engine and again over the whole report in the program: secret-like keys at any depth (token, secret, password, auth, credential, cookie, API/private/access/signing/session/stream/join keys), Bearer and Basic headers, tokens, keys, codes and passwords in addresses, `user:pass@`, `password=`/`"token": "…"` in text, `mfd_` website credentials, 48-hex engine access tokens, PEM private keys, every secret the engine's store holds word for word (operator, GSI and role tokens, stored passwords, the website credential) plus what the program holds (operator token, remote access token, credential key), and the user's home folder in paths becomes `~`. The hostname is a SHA-256 prefix. A minidump has those secrets overwritten (one-byte and UTF-16) before it is attached.
- **Size:** at most 10 MB unpacked (`CRASH_REPORT_MAX_BYTES`), sent gzip-compressed. The program fits a report by dropping the minidump, then halving the support file's longest lists (oldest entries go), then the support file, then most of the stack; the website refuses larger bodies (413) and stops unpacking at 10 MB.
- **Queue** (`apps/desktop/src/crash/queue.ts`): `<userData>/crash-reports/`, one file per report, atomic writes. At most 20 reports and 50 MB (oldest dropped), one report at most 10 MB; the same crash (process, reason, first error line, HUD) again within 30 minutes is counted on the report waiting or just sent instead of making another; failures are tried again after 1 min, 5 min, 15 min, 1 h, then every 6 h; reports the website refuses (400, 413) are dropped; anything not sent in 30 days is dropped.
- **Upload:** `POST /v1/crash-reports` from the program's main process (Electron's network stack), with the computer's device token when it is signed in (the engine hands the token over its IPC channel only, never HTTP), else anonymous to the address this build is pinned to. A signed-out token is accepted as anonymous. Limits: 10 an hour per computer; anonymous 3 an hour per address and 20 an hour in all, and refused (503, sent later) while anonymous reports take `MF_CRASH_ANONYMOUS_MAX_BYTES` (1 GB by default). The answer is an id `CR-XXXX-XXXX`; the program's own report id makes a resend return the same id. The console shows "Crash report sent (ID …)" (a Windows notification when the console isn't on screen), and Settings lists the last ids.
- **Website** (migration 7, `crash_reports`): one row per report with the list fields and the report as received, gzip-compressed, in `bytea` with `STORAGE EXTERNAL`, as account sync stores its files. Deleted 90 days after arrival, at start and hourly (`crash_report.purged` in the audit log). Staff only (both roles): list (version, process, organisation, computer, error; search and filter), detail (error, stack, the engine's output, support file sections) and downloads of the report and its minidump, each download audited (`admin.crash_report_downloaded`); `crash_report.received` for every report. The privacy policy has a paragraph on it.

**Consequences.** Support gets a crash's context with an id the operator can quote. Nothing is sent unless the operator agrees; a crash is never shown to the operator more than once. Storage stays bounded: 90 days, gzip, per-computer and anonymous limits, the anonymous ceiling. The desktop main bundle gains no dependency (only types from the contracts).

**Checked.** Cloud API end to end (`crash-reports.e2e.test.ts`): signed-in and anonymous uploads, resend, refused bodies, the 10 MB cap sent and unpacked, the anonymous, global, storage and per-computer limits, staff-only list, detail and downloads with audit, the 90-day purge. Engine: the redaction pass (unit) and the support file end to end with secrets in log messages and the store. Program: the queue (consent, folding, caps, backoff, minidumps seen) and the report (redaction, minidump scrubbing, fitting 10 MB, the engine's last error). Website: the list and detail pages.

**Not checked.** On Windows: Electron's crash reporter writing minidumps (and where Crashpad puts them), a real renderer or native crash, the next-start question and the notification. A real deployment's database growth.

**Revisit if.** Reports are too many or too large to read (group them by signature on the website), or staff need them longer than 90 days.

## ADR-079 — Map intros: one video per map, a MAP_INTRO mode that goes back like highlights, triggers read from the game data, and knife rounds told by the loadouts

**Context.** The owner: "Map intros: one video per map, played automatically when the map starts. (Pick when to start either Pistol Round Start, Knife Round Start & So On)". The brief added: one slot per map of the pool and a default; uploads checked with ffprobe and refused when unplayable; six choices of when (manual, the map loading, the knife round, the pistol round, both pistol rounds, the match going live); once per map per match; never during a live round; cut back to the game or finish the intro when the round goes live; OBS and vMix as highlights play; the game sound ducked as for replays; Play map intro and Play next map's intro in Live Control, a hotkey and Stream Deck actions; a status line; a knife-round detector with honest limits; not shared by account sync.

**Decision.**
- **Storage** (`replay/map-intro-store.ts`, `routes/map-intros.ts`): eleven slots (`de_ancient` … `de_cache`, `default`), files in the data folder's `map-intros/`, listed in the engine setting `mapIntro.files` (the program's own settings: account sync never shares them). An upload is streamed to a part file (a new router option, `streamBody`, and `writeBodyToFile`; up to 1 GB, never held in memory), then checked: ffprobe beside the ffmpeg in use (else `ffmpeg -i`, parsed: the program's ffmpeg download has no ffprobe), an MP4/MOV container, a video codec on a list OBS and vMix play (H.264, HEVC, ProRes, DNxHD, QuickTime Animation, PNG, VP9, AV1, MPEG-4), 0.5 s to 2 minutes, its first 2 s and last 1.5 s decoded with `-xerror` and their frames counted (framecrc: a cut-off file with its index first decodes "cleanly" but has no frames at its end), and a JPEG frame from its middle. Refused with a 422 and why; 409 without ffmpeg. Each upload is kept under a new name and the old file removed, or swept later (Windows keeps a file OBS has open locked). Notes that don't refuse a file: no sound, alpha, VP9/AV1 in vMix, HEVC/AV1 decoding, under 1280×720.
- **When** (`replay/map-intro-trigger.ts`, `IntroTriggerWatch`): fed each new game state, it says which moment the chosen trigger has open:
  - *map_load*: the map's first state with a known phase was its warmup (or, without a warmup, its first round's freeze time); open while that lasts;
  - *knife*: round 1 at 0–0, past the warmup, in freeze time, the knife detector says knife;
  - *pistol*: the same round when the detector doesn't say knife ("unknown", no loadouts in the game data, counts as the pistol round);
  - *pistols*: that, and the freeze time of round regulation / 2 + 1 (the active match's format; 24 without one), never overtime;
  - *match_live*: the first round 1 at 0–0 freeze time, knife or not.
  Every moment is in a warmup or a freeze time, and is open only while that lasts: nothing starts late. Round 1's loadouts are read once its freeze time is 1.2 s old by the game data's own arrival times (GSI heartbeats every second), as its first update can still carry the warmup's weapons.
- **Knife rounds** (`replay/knife-round.ts`): CS2 has no flag. MatchZy, get5-style plugins and plain `mp_` configs all play the knife round as round 1 at 0–0 after a restart, everyone spawned with a knife only (no default secondary, no bomb, `mp_maxmoney 0`); the pistol round is round 1 at 0–0 again after the next restart. So: round 1 at 0–0, map phase live, round in freeze time or live, at least two players read on both sides (on a side, not a coach, not dead, weapons listed), every one with knives only (any knife skin, fists; the bomb left aside). Any gun, grenade or Zeus: not one. Everyone at $0 is reported, never required (configs differ). Limits, documented: no loadouts without a spectator's game data; a plugin stripping pistols only at round start looks like a pistol round in freeze time; knife rounds elsewhere than round 1 at 0–0 aren't seen; "knife and Zeus" rounds aren't knife rounds.
- **Once per map per match:** plays are recorded in `mapIntro.played` as `<active match id>|<map>|first` (every moment of the map's start, and every press) or `|pistol2` (the second half's pistol round). Without an active match the key is `none|…`, and a change of map forgets the other maps' plays. A press always plays, and is recorded: Play next map's intro in the break means the next map's intro doesn't repeat when it loads.
- **Starting by itself** (`MapIntros.tick`): a moment not handled, not played, with an intro (the map's or the default): it starts, unless the round's replays, Test replays, highlights or a replay are on air (it waits, while the moment is open), or the program is the operator's (MANUAL: their own scene; the studio or break scene they chose): never over it, as highlights by themselves. With Cut back to the game, not with under 3 s of freeze time left. What happened is in `status.auto`. Automatic intros are automation's; presses are the operator's.
- **The program** (`production/program.ts`): a mode `MAP_INTRO` (`PROGRAM_MODES`), reachable from `LIVE`, `STUDIO`, `BREAK` and `MANUAL`, scene `MAP_INTRO` in the scene map. The return target and the return are highlights' own (`HighlightsReturn`, now saved for either returning mode; `returnFromHighlights` and the new `returnFromIntro` share `returnBack`). `introReturn` is the target while an intro is on air.
- **OBS** (`replay/map-intro.ts`): *MatchFrame Map Intro* with the Media Source *MatchFrame Map Intro Video* is made or repaired as an intro plays (`existingName` for the old spelling, the source put back in the scene if taken out, the scene mapped), its settings `restart_on_activate` on (its file is set off air; it starts from the beginning as it is shown), `clear_on_media_end` off (the last frame holds under the transition back), `close_when_inactive` off, `looping` off, `hw_decode` on. The end: OBS's `MediaInputPlaybackEnded` (the adapter now emits `media` events for started and ended; obs-websocket subscribes to them by default), an end within 250 ms of the program change ignored as an earlier file's; the fallback is the probed length plus 2 s. Stopped by Stop, by someone taking the program (mode or holder changed, a program change made in OBS; then nothing more changes), or by the cut back. Back: `returnFromIntro`, to the live scene when a round is live, on a cut back, or when the OBS automation would take the scene it came from back to live now (`ObsAutomation.leavesNow`: its studio scene as the next map loads, its break scene once play has resumed), so a map-load intro from the studio scene goes straight to the game. The source is emptied 4 s later (OBS lets go of the file) and replaced files swept.
- **Transitions** (`live/obs-auto.ts`): `transitionUse` has `intro-in` and `intro-out`; `introIn` (null: the *MatchFrame Stinger* when OBS has it, under either spelling, else OBS's own, through a new pick `{ anyOf }` that falls back to OBS's own without a warning), `introOut` (null: as `introIn`).
- **The OBS automation:** while an intro is on air, due now or waiting (`MapIntros.holdsProgram`), it doesn't take the program (no studio scene over it at a map's end, no studio-to-live under it as the map loads); it keeps its scene as its own while an intro from it is on air; and it forgets its scene once the program is live (it used to keep it, so an operator's later studio scene could be taken back to live as its own).
- **Round going live:** Cut back to the game (default): when the round is live, or the freeze-time countdown has 1 s or less left (the cut starts then, so a stinger has cut to the game as the round goes live). Finish the intro: plays to its end, then the live scene. A warmup's "live" round phase is no live round.
- **vMix:** the file added as an input, Play, Map intro in (the replays' Replay in unless chosen), watched until Completed (or the cut back, Stop, another input put on air after 1.2 s), Map intro out (the replays' Replay out unless chosen) to the input before, removed 2 s later.
- **Sound:** `ReplayAudio.duck()` as the program goes to the intro, `restore()` after, however it ends.
- **Controls:** `POST /api/v1/map-intros/play` (`{}` or `{ map }`), `/play-next` (the active match's map instances in order, else the veto's picks and decider: after the map in the game data, else its first map still upcoming), `/stop`, `/obs-setup`; device actions `map_intro_play`, `map_intro_next`; tally `mapIntro`; the desktop's global hotkey `mapIntro` (map_intro_play, suggested Ctrl+Shift+F4, off until set) and the console's Ctrl+Shift+F4. The status line: the map in the game data while its intro is still to come, else the active match's next map ("Next intro: Mirage, at pistol round start."; "…, at the second half's pistol round." with Both pistol rounds).
- **Console:** Replays & Production → Map intros (the slots with frame, facts, notes, Add/Replace/Remove; Start the intro; If the round goes live during the intro; transitions; the scene; hotkeys; the account-sync note); Live Control → Map intro (status line, Play map intro, Play next map's intro (<map>), Stop). Sponsors: no bugs over a map intro.

**Alternatives.**
- **Intros through the replays' engine as a one-clip highlights sequence:** its deadline is the replays' clock (into the live round), and its scene, transitions and status are the highlights'; an intro needs none of the twin, rendering or graphic machinery.
- **`HIGHLIGHTS` or `MANUAL` mode for the intro:** the program's scene comes from the mode; MANUAL would have made the intro the operator's own scene, followed and never left by automation.
- **Timing the match-live intro to end as the freeze time ends:** the brief's "play in the freeze time just before it" reads as the first live round's freeze time; a start that depends on the countdown would also start nothing when the countdown is missing.
- **Knife rounds by money alone:** configs differ (`mp_maxmoney 0` isn't universal); loadouts are what every setup changes.
- **Intros over the operator's own scene by themselves:** against the arbiter's priorities (the operator's manual program over automation) and highlights' rule; a press plays over it.
- **Extending the ffmpeg download with ffprobe.exe:** another large file for every user; `ffmpeg -i` gives the same facts.
- **Refusing unknown codecs only after a decode test:** a codec ffmpeg decodes may still not play in vMix; the list is explicit and the reason names the export to use.

**Checked.**
- Unit (`map-intro-trigger.test.ts`): weapons (knife skins, fists, bomb, guns, grenades, Zeus); knife rounds through the engine's reconciler from synthetic GSI (MatchZy-style knife round in freeze time and live, its end, the bomb, dead players; negatives: the pistol round, one pistol, a Zeus, a grenade, a later round, rifles; unknown without allplayers or one side); every trigger along a MatchZy-style map (warmup, knife round, side pick, restart, pistol round, mid-half, halftime, round 13), MR15's round 16, plain configs, the stale first freeze update, a player's own game data, no warmup, joining mid-map, map names; two rounds of the built-in simulation (its first freeze time the map load, the pistol round and the match going live; no knife round, nothing later).
- Unit (`map-intro-store.test.ts`): ffprobe JSON (cover art skipped), `ffmpeg -i` text, `checkIntro`'s reasons and notes, `ffprobeBeside`, `writeBodyToFile` (whole, 413 with the part removed); with ffmpeg-made 0.3–2.5 s videos: an H.264 MP4 and a QuickTime Animation MOV kept, refused too short / Matroska / MPEG-2 / junk / cut off / empty / no ffmpeg, ffprobe and ffmpeg agreeing, Replace, Remove, sweep.
- Stand-in OBS with media events (`map-intro.e2e.test.ts`): the upload route (preview served, 422, 404), the scene made with its settings, the Stinger in and out, ended by the event (not the fallback), the audio down 20 dB and back to 0.8, OBS's own transition back, the source emptied; from the operator's scene and back as theirs; chosen transitions; OBS's own without the Stinger; by itself at the pistol round (not in warmup, not before settling, recorded under the match, not after a restart, again by a press), refused live; the knife round; both pistol rounds; cut back (about 1 s before the freeze time's end, to the live scene); finish (on through the live round, then the live scene); the fallback without media events; taken; Stop; Play next map's intro (the default for Nuke from the veto, back to the studio scene, not again as Nuke loads); the map loading from the studio scene straight to live; waiting for replays, giving up when the round went live; not over the operator's scene. Stand-in vMix: by itself at the pistol round (AddInput, Play, Stinger1, CutDirect back, RemoveInput, the game audio 80 → 45 → 80), cut back, refused live.
- Console (`MapIntros.test.tsx`) and desktop hotkeys (`replay-hotkeys.test.ts`); the engine's other suites, the console's and the desktop's pass.

**Not checked.** A real OBS (its media events and a stinger over a real intro), a real vMix, Windows, real MatchZy or get5 servers (their knife rounds as CS2 sends them were taken from their configs), a Stream Deck.

## ADR-080 — Clutches that cut to the hunters and back, and freeze times that tell the buy story

**Context.** From the roadmap to 1.0 the owner picked (34) "Smarter clutch direction, switching between the clutch player and the hunters" and (40) "Storytelling shots in freeze time for eco and force-buy rounds". Clutch mode (ADR-028) stayed on the clutcher for the whole 1vX: the viewer never saw a hunter walk in, plant or defuse. Freeze time showed the same two team shots whatever the money said, and ADR-044 dropped an eco team's shot altogether.

**Decision (clutches).**
- **Walking distance** (`WalkGraph`, map-runtime/src/walk.ts, built once per map from its free-space grid, about 0.3 s):
  - a floor in each 24-unit column where a solid cell has 60 units of free space above it;
  - neighbouring floors (eight directions) joined when a line at body height between them is clear and the step up is at most 64 units (a crouch jump), or the drop at most 260 (one way);
  - one search from the clutcher along the edges backwards gives every hunter's walk;
  - a position within 72 units above a floor (a jump), or falling onto one, is placed; one it can't place is measured in a straight line, 25 % longer.
- **Clutch direction** (`ClutchDirector`, director-policy/src/clutch.ts), with clutch mode on in a live 1vX: the clutcher is the default. For each hunter it reads:
  - the walk to the clutcher, how fast it shrinks (over about a second), and the time to contact range at that speed;
  - the contact model's sightline (now or within 1.6 s) and its chance of a fight within a second;
  - the bomb: planter, defuser, carrier, or walking onto the site the clutcher holds (the bombsite they stand in, or a T's planted bomb within 1,500 units);
  - the time left (round clock, or the bomb once planted).
- **Looks at a hunter:**
  - a plant or defuse starting: after 2 s on the clutcher, whatever the time left; 3 s and 2.5 s, cut at once;
  - a hunter walking into the clutcher's site: after 4 s on the clutcher; 2.5 s;
  - a hunter closing in: after 4 s on the clutcher, within 1,800 units' walk, closing at 120 u/s or more, in contact range in 2.5–7 s. It lasts until 1.5 s before they are expected there (2–4 s). The bomb carrier comes first, then the soonest.
  - Closing and site looks need the same hunter for 250 ms.
- **Back to the clutcher:**
  - before contact, at once: in sight, a sightline within 1.6 s, a 60 % chance of a fight within a second, within 450 units' walk or a second from it;
  - at the end of the look, at once;
  - when the clutcher plants or defuses, when the hunter dies, or when the look never came on air (1.5 s).
- **Hysteresis:** no look before 4 s on the clutcher, 10 s before the same hunter's next (a plant or defuse once), never hunter to hunter, and with under 8 s left only a plant or defuse.
- **Scoring:**
  - The player the clutch shot is on gets the clutch bonus (+0.45) and everyone else −0.25, so the planner's hysteresis (minimum shot, advantage, persistence) applies as before.
  - Mid-clutch, only the clutch direction marks a candidate urgent (a plant or defuse starting, going back).
  - Cinematics stay off in a clutch. X-ray stays off for the round from the 1v2 (ADR-036), whoever is on air.
- **Explained:**
  - reason codes `CLUTCH_HUNTER_CLOSING`, `CLUTCH_HUNTER_ON_SITE`, `CLUTCH_HUNTER_PLANTING`, `CLUTCH_HUNTER_DEFUSING`, `CLUTCH_BACK_BEFORE_CONTACT` and `CLUTCH_LOOK_OVER` on the decisions;
  - a `clutch` entry in the director log for every change of focus: a sentence (what, why, the numbers) and each hunter's walk, closing speed, time to contact range, sightline and bomb role.
- **Config** `clutch` holds all the numbers above; `hunterLooks` off keeps the clutcher only. There is no new operator setting: it is part of clutch mode.

**Decision (buy stories).**
- **Classification** (`BuyTracker`, director-policy/src/features/buy.ts), per team, from the game data: money, equipment value, weapons (rifle; SMG or shotgun; pistols), CS2's loss count (the next loss pays $1,400 + $500 a loss, up to $3,400), the round number (1 and 13 are pistol rounds; overtime starts with a full buy) and the round before.
  - **Before the team buys**, from money and kept equipment: $4,000 each (Ts) or $3,600 (CTs) is a full buy, under $2,000 an eco. In between, a force buy after a win or on the last round of a half; otherwise an eco when saving brings a full buy next round ($4,300 / $4,500 with the loss bonus), and a force buy when it wouldn't.
  - **From what it bought**, once half the team has spent $500, after 6 s of freeze time, in its last 5 s and the first second live: rifles for all but one with $3,000 of equipment on average, all but two with $3,600 / $3,900, or $4,800 whatever the guns, is a full buy; under $900 an eco. In between, money kept for a full buy next round is a half buy (an eco with one main weapon or none), and spent beyond that a force buy.
  - **Anti-eco:** a team with $2,000 or more of equipment against a team on an eco.
  - **Final** one second into the live round. Every read goes to the director log (`buy`).
- **Freeze-time shots** (`cinematic.buyStories`, on), after a pause, match point and the pistol round, within the freeze time's four shots and their chaining:
  - **a force buy:** the other team first (at most 40 % of the freeze time), then the forcing team until live, in a new `weapons` look (eye height, the middle player about 300 units away) so their pistols or SMGs are in view (`FORCE_BUY`; both teams that way when both force);
  - **an eco against a full buy or anti-eco:** both teams, the full buy last (`ECO_VS_FULL_BUY`). This replaces ADR-044's dropped eco shot there; an eco against anything else still gets none with variety on;
  - **the time** is shared among the shots the plan still has (at least 4 s each), so a pistol round now shows the map's camera and then both spawns.
- **HUD cue** `buy_type` (graphics director, setting **Buy type in freeze time**, on):
  - one per team from freeze time until 8 s into the round;
  - title the label (`PISTOL ROUND`, `ECO`, `FORCE BUY`, `HALF BUY`, `FULL BUY`, `ANTI-ECO`), subtitle the team's name; data `side`, `team`, `label`, `buyType`, `firm`, `roundNumber`;
  - changed in place (same id, `Engine.updateCue`); documented in docs/extensions.md;
  - no HUD's design changed: the built-in HUD, which draws unknown cue kinds as lower thirds, leaves this one out.

**Consequences.**
- Clutches show the hunters the way a broadcast does, the plant and the defuse as they start, and the clutcher at the moment of contact. Each switch can be read back in the director log.
- The walking graph is a general tool (the contact model's `pathDistance` hook could use it later); for now only clutches use it.
- Freeze time follows the money: forcing teams with their guns, ecos against full buys, both spawns on pistol rounds. HUDs can show the buy without working it out themselves.

**Checked.**
- **Walking distance:**
  - synthetic floors: open ground about the straight line (at most 8 % longer); round a wall through its gap; a closed wall unreachable; a 48-unit block climbed, a 96-unit one not, and dropped from;
  - T spawn to CT spawn walked on Ancient, Anubis, Cache, Dust II and Mirage, 1.1–1.3 times the straight line; two spots 260 units apart either side of Mirage's ladder-room wall are more than 2,000 units' walk apart, both ways;
  - the seven pro demos' player routes (about 23,000 one-second steps, `scripts/demo-path-anchors.py`): every position placed (Nuke 99.8 %), 99.8–100 % of steps reached, the walk 1.10 times the sampled route at the median and 1.4 at the 99th percentile. A committed sample (`packages/map-runtime/test/fixtures/demo-routes.json`, 14 routes a map) is the test.
- **Clutch direction** (unit tests, a stand-in camera 300 ms behind):
  - a closing look of 2–4 s with its sentence, then back with `CLUTCH_LOOK_OVER`;
  - back with `CLUTCH_BACK_BEFORE_CONTACT` the moment a sightline is about to open, on air before it does; never off the clutcher with a hunter in sight or close;
  - two hunters walking in and out for a minute: every look 2–4 s, between clutcher shots of at least 4 s, 10 s between looks at one hunter, never hunter to hunter;
  - the plant (about 3 s), the defuse (back when the clutcher comes into sight), a hunter walking onto the clutcher's site, low time;
  - a hunter 260 units away but 2,500 on foot is no contact, while in a straight line it would be.
- **On Mirage with its grid** (the whole director): a T walking a pro demo's route through apartments towards a CT on B site gets a look, and the camera is back on the clutcher before the grid's first sightline between them; a plant on B shown within 0.5 s for about 3 s, then back; a defuse on A; the ladder-room wall.
- **Buy types:**
  - constructed cases for each type, the loss bonus and the last round of a half;
  - 136 rounds of the seven pro matches (`scripts/export-buy-rounds.py` → `packages/director-policy/test/fixtures/buy-rounds.json`): every pistol round; nine hand-checked rounds (Dust II round 2 a force against a full buy, round 3 an eco against an anti-eco, round 10 a CT half buy, round 12 a pistol force; Anubis 14 an SMG force; Ancient 5 an eco with armour; Mirage 4 an eco against an anti-eco; Nuke 19 five rifles, a full buy); the mix (59 % full buys; 28 pistol, 28 eco, 28 anti-eco, 25 force and 3 half-buy team-rounds); and the read before anyone buys matching the buy 83 % of the time (226 of 272);
  - the tracker: predicted, read once bought, final a second into the live round; a team that never spends read as saving after 6 s.
- **Freeze time on Mirage with its grid:** a force buy (the CTs first and shorter, the Ts last and closer than their usual shot), an eco against a full buy (the eco first), a pistol round (the map's camera, then both spawns), two full buys (no story); shot after shot with no player view between, at most four. The `weapons` look on the 15 real spawn line-ups: never further than the usual shot, 10 of them closer (about 50 units on average, up to 160), as many players in it, 67–110 units above the floor.
- **HUD cue:** both teams' cues with labels and names, changed in place, final with `firm`, gone 8 s into the round, none with the setting off.

**Not checked.** On air in a real CS2: how a 2–4 s look feels; whether CS2's game data names the defuser as the bomb's player (a CT within 120 units of the bomb counts too); whether the thresholds suit every team's economy (they are tuned on seven matches). The walking graph misses ladders (Nuke) and boosts.

## ADR-081 — Slow motion in the rendered replays, and multi-angle moments filmed again by the replay PC going back

**Context.** The owner picked two items from the roadmap to 1.0: (41) "Slow-motion replays" and (42) "Multi-angle replays: the same kill from the victim's view and a free camera." Before this, replays had one speed for every clip (Real time, 75 % or 50 %), set on OBS's media source (or vMix's rate), so a slowed break was slow from start to end; each kill was filmed once, from the killer, by the replay PC 7 s behind on CSTV (ADR-051), and a break's clips are rendered into one file (ADR-067).

**Decision: slow motion.**
- **Where:** in the rendered file (`replay/slowmo.ts`, through the reel graph `replay/reel.ts`), so it is frame-exact and needs nothing from OBS. Each slowed clip is cut into real-speed pieces and slowed windows, each made to a whole number of output frames and joined: the frames before and after a window are the clip's own, not blends.
- **The ramp (Kill moment, the default):** around each kill (the kill's time is from the marks: the replay PC now sends each kill's time in the clip, `killsMs`/`killsAgoMs`; else the first kill at `leadMs`), an ease of 0.3 s from real speed down to the slow speed, a hold from 0.2 s before the kill to 0.8 s after it, and an ease of 0.3 s back up. Kills whose windows come within 0.4 s are held slow between them. The ease is smoothstep-shaped in how much each moment is stretched, so speed changes without a jolt; the time map is its integral, given to ffmpeg as a `setpts` expression (`windowExpr`, with `windowMap` the same in TypeScript). **Whole clip** slows the part throughout; **Off**. **Speed** 50 % (twice as long) or 33 % (three times).
- **The missing frames:** blended from the two nearest (`framerate`), or with **Smooth slow motion** made by motion interpolation (`minterpolate`, bidirectional estimation, overlapped blocks). Measured here (4 cores, no graphics card, ffmpeg 6.1): one kill's window at 1080p60 (1.6 s of the clip, 2.9 s on air at 50 %) blended in 0.9 s, interpolated in 95 s. So a break uses interpolation only when its file will still be ready in time: the cost is estimated from the slowed frames and their size at a rate learned from earlier interpolated renders (starting at 270 ms per frame per megapixel); otherwise the break blends and its render note says why. Highlights (they wait up to 3 minutes) and reels use it as set.
- **The game sound while slowed:** **muted** by default, fading out over 0.12 s just before the ease in and back in after the ease out; or **slowed with its pitch kept** (`atempo`, one tempo for the window so it lasts as long as the picture). Muted is the default: `atempo` (time-stretching) of gunfire at 50 % and more so at 33 % smears the transients into doubled, phasing shots, while a short, clean gap under the casters is the broadcast convention; the slowed sound stays a setting for those who want it.
- **Fitting the break:** a slowed clip's length on air counts when the break's clips are chosen and before each plays (`rank.ts`: a candidate's `extraMs` for the windows, or its own `speedPercent` for a whole clip). A lead-up shortened to fit is never slowed (the window starts at most 0.5 s before the kill, the lead-up is never under 2 s), so shortening leaves the slow part as it is. Replays still end by 1:50.
- **Played clip by clip** (through the scenes, the fallback, or vMix) a file can't be ramped: **Whole clip** is the mixer's speed for that clip (OBS's media speed, vMix's `SetRate`), **Kill moment** plays at real time. The break is planned with the rendered lengths, so the fallback only ends earlier.
- **Per clip:** **Slow** in the round's list (and `slow` on `PUT /api/v1/replays/auto/clips/:id`, the device action `replay_slow`) turns slow motion on or off for one clip whatever the setting (null back to the setting). Made while a break's file plays, from the next break.
- **The old setting:** a stored speed under 100 % reads as Whole clip at 50 % (33 % up to 40 %), and the old API's `speedPercent` still sets it.
- **Highlights:** **Slow motion** on Highlights on air and on the highlight reel (off by default): as automatic replays slow theirs, around the kills when theirs is off.
- **Test replays** slow their sample clips as set (the samples carry no kill time, so Kill moment leaves them at real time).

**Feasibility: filming the same kill again.**
- **What exists:** PC 2 plays the match on CSTV about 7 s behind PC 1 and already goes back in its CS2 (`demo_gototick -N relative`, 64 ticks a second) and forward again (ADR-051's rewind for a missed kill); PC 1 records PC 2's whole screen (the NDI feed) and cuts any moment PC 2 marks; PC 2's director can be pinned to any player; the Observer places still cameras from players' positions and the map's free-space grid (`frameTeam`, ADR-034) and shows them through the arbiter (`activate_static_camera`).
- **Second pass on PC 2 by going back (built):** the victim's view and a free camera need only those parts. Its cost is PC 2's live coverage: while it films an old moment, the stretch it skips when it comes forward isn't shown here, and a kill PC 1 reports meanwhile may start before PC 2 is back. PC 2 knows every kill up to PC 1's time, so it can do the pass exactly when no kill can lose its lead-up: no planned kill starts before it is back, and the earliest unknown kill (at least the delay later, and only once PC 2's next round is live) leaves room for the pass and the whole lead-up. With 7 s behind and a 5 s lead-up that is after the round ends on PC 2 (the round-over and freeze time are long enough); 12 s or more behind (or a shorter lead-up), during the round too.
- **Timing for the break:** after the round, the angle reaches PC 1 about 15 s after the round ends (PC 2's last kill about 9 s after it, then the pass of about 5 s and the cut). A break starts at most 11.5 s after the round ends and plays until 1:50 of the next round (about 27 s after the round ends with 15 s of freeze time, 32 s with 20 s). So PC 1 waits up to 12 s for an angle being filmed (still never with less than 16 s of the break left): with 20 s of freeze time the top kill's angle makes the break; with 15 s it usually doesn't, and plays in highlights and by hand. A top kill early in the round with PC 2 far enough behind is filmed during the round.
- **A demo or HLAE render after the round:** the server's demo is only complete after the map (and on the server, not the PCs); a CSTV+ broadcast's fragments could be read, but rendering them in another CS2 or HLAE in a 20 s break, on PC 1 (which runs CS2 and OBS), isn't realistic. Kept for highlight reels after a map: not built.
- **A third PC:** a CS2 that does only extra angles could go back the moment a kill is asked for, without costing any coverage, and get the angles to PC 1 within seconds of the kill. What it would take: a replay-link role for it (film no kills, go back at once for each request), PC 1 keeping the pending rounds per linked computer (one list today: two would overwrite each other), and the third PC sending through its own OBS replay buffer (the upload path exists; the NDI feed records one screen). Not built: hardware the owner hasn't asked for.

**Decision: multi-angle.**
- **Clips:** a queue item can be an extra angle of a moment (`angle`: `victim` or `free`, `momentOf`: the moment's first clip on PC 1), sent by PC 2 on the mark (`angle`, `momentOf`) or the upload (query). Extra angles aren't ranked or deduplicated themselves: they belong to their moment, are listed under it, and follow it when it plays (a break, highlights, reels).
- **Asking:** PC 1's on-air answer has `angles`: the round's top kill (its best clip with a kill) and every clip the operator **starred**, with the views wanted (**Extra angle**: the player who died's view, the default; a free camera; both), those not in yet; at most three. **Multi-angle replays:** the round's top kill and starred kills (the default), only starred kills, or off (nothing asked, nothing played). PC 2 reports the rounds it is filming an angle of (`on-air?angles=`), and the break waits up to 12 s for one, while 16 s of the break remain.
- **Playing:** a moment's extra angles play straight after its first clip. They take the time the break's clips leave (best moment first) and never displace a clip; a starred moment's are chosen with it. In a moment with its angles, the first clip (the killer's view) plays at real time and the extra angles are slowed (the operator's Slow can change either). The operator's Exclude works on an angle; excluding the moment drops its angles; pinning it brings them along.
- **Filming (PC 2, `replay/link.ts`, experimental, off by default: Replay PC → **Film extra angles**):** for the next moment asked for whose kill has played here, when the rule above allows and PC 2 is behind and not filming: go back by the time since the kill plus 2.5 s of lead-up and 1 s to land; when the player who died is alive again (CS2 landed), pin them (or select them as a device without the Auto Director) or show a still free camera placed for the kill (`replay/angles.ts`: the two players framed together when close, the player who died with the line of the shot when far apart, from the positions at the kill as PC 2 showed it; none without a free-space grid); film until 1.5 s after the last kill plays again; send the clip (feed mark or upload) with the moment's id; go forward by as far as it is behind beyond where it was. Kills PC 1 reports meanwhile are planned once it is back. At most two angles per round. If CS2 doesn't go back within 4 s, or isn't back within 5 s of going forward, PC 2 stops filming angles and says so (staying behind where it is, filming kills from there).

**Alternatives.**
- **Slowing in OBS** (speed per clip by the media source, or a speed filter): no ramp, and through the rendered file a change of speed mid-file isn't possible.
- **Slowing the whole file in OBS** (as before): every clip slow, and the cut points (Stinger, Replay out) and the cursor no longer match the layout.
- **Frame interpolation for every clip as it arrives, during the round:** would take the cost off the break, but runs single-threaded on PC 1 for half a minute or more per kill while it runs CS2 and OBS live; not by default. Possible later as an option for a PC with cores to spare.
- **Sound slowed with its pitch lowered** (`asetrate`): the classic slow-motion growl, sounding wrong for gunfire and footsteps over a longer stretch; muted or pitch-kept are the choices.
- **Going back during the round regardless:** more angles in time for the break, but a kill PC 1 reports during the pass would lose its lead-up (or not be filmed); not worth losing a replay for a second view.

**Checked.**
- **ffmpeg** (`replay-slowmo.test.ts`, tiny generated clips 64×36 with a 440 Hz tone, the top half's brightness telling the clip's moment and the bottom half alternating per frame so a blend shows): one kill at 50 %: the file as long as planned (to 0.05 s), every frame within a frame of the time map, the frames before and after the window the clip's own (none blended), blends in the window; the sound at 440 Hz before, fading out, silent through the window, back after. At 33 % with the pitch kept: the sound through the window at 440 Hz and the right length. Whole clip at 50 %: twice as long, every frame at half speed. Smooth (minterpolate) on the same time map. Two clips, one slowed: the second where its fade begins after the first's slowed length, the part moved within the file keeping its kill. The windows, the joins, the ease's speed (real speed at its ends, the slow speed in the hold, continuous), the frames per piece.
- **The planner** (`replay-rank.test.ts`): four slowed clips fitting where they should, a lead-up shortened with the slow part kept, a whole clip at its own speed; a moment's angles in the time left, never displacing a clip; a starred moment's chosen with it; two moments and time for one angle: the better moment's. The old speed setting read and set.
- **A rendered break** (`replay-rendered.e2e.test.ts`, stand-in OBS and renderer): the file asked for each clip's kills at the slow speed (a 3K's three), a clip turned off by the operator at real time, the status following the slowed layout clip by clip; the top kill asked for in the on-air answer, a starred kill first, the angle listed under its moment, the moment then its angle (slowed) then the next clip, all marked played.
- **Filming an angle** (`replay-pc-timing.e2e.test.ts`, two engines, a stand-in game on both and a stand-in CS2 console that goes back and forward): 3 s behind, the kill filmed live with its kill time, PC 1 asking for it, the round ending, PC 2 going back once, pinning the player who died before the kill plays again, the angle sent as an extra angle of the moment (lead-up 2–2.6 s, 1.4–2 s after), going forward to where it was (within 0.6 s), PC 1 asking for nothing more and listing it under the moment (the moment at real time, the angle slowed). While the round is live 3 s behind: not filmed, saying why, no `demo_gototick` sent.
- **The free camera** (`replay-angles.test.ts`): close players framed together from above the floor, far apart the player who died along the shot, never a camera inside a wall.
- **The console** (`AutoReplays.test.tsx`, `HighlightReel.test.tsx`): the settings, Slow and Star per clip, an angle's own Slow and Exclude, Film extra angles on the replay PC.
- **Fixed on the way:** clips of a round made in the same millisecond could swap places in round order (each read both clocks at a slightly different moment); one reading now serves them all.

**Not checked.**
- `demo_gototick` sent by MatchFrame to a real CS2 on CSTV or CSTV+ (as ADR-051: the owner uses it by hand), and how far back a real CSTV connection can go (going back past 90 s isn't tried).
- A real CS2's spectator camera landing after going back: whether `spec_player` takes the player who died at once, and the still free camera (`spec_goto`) in CSTV playback (the Observer's camera notes after the 2026-10-15 CS2 update).
- The interpolation's cost with the owner's CPU and NVENC on Windows (only the estimate gates it); the look of 33 % blended slow motion at 60 fps on air.
- A real NDI feed carrying a pass (PC 1 cuts it as any mark).
