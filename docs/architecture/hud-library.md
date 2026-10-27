# HUD Library and desktop HUD outputs (ADR-020)

Status: accepted (0.2.0). Builds on ADR-007 (HUD packages and outputs) and the existing overlay server.

## Goal

Matchframe opens into a **HUD Library**: HUDs installed on this computer, shown like a library of installed software, with controls to run each one locally in three ways:

| Mode | What it is | Who makes it |
|---|---|---|
| Preview | A normal window (or a panel in the manager), optional checkerboard behind the HUD | Electron main (window) / manager (panel) |
| Transparent desktop HUD | Frameless, click-through, always-on-top, non-focusable window over a borderless-windowed game | Electron main |
| OBS browser source | A local URL that renders only the HUD on a transparent background | HUD server (engine overlay port) |

All three load the **same runtime URL** and therefore show the same match state and the same per-HUD settings. Game data is received and processed once by the engine; every output is a subscriber.

## Storage (per-user, offline)

- Installed HUDs live in the engine data folder, which is Electron's per-user application data folder for the program: `%APPDATA%\Matchframe Esports\huds\<hud-id>\<version>\` (one folder per HUD, one subfolder per installed version, previous version kept for rollback). The importer copies files there; the original ZIP or folder can be moved or deleted afterwards.
- Library metadata (kind, settings, token, stopped flag, last used) is in the engine's SQLite database (`hud_library` table, migration). Per-HUD settings are separate per HUD and survive restarts.
- Desktop overlay placement (display, bounds, scale, lock) and hotkeys are program settings: `%APPDATA%\Matchframe Esports\program\hud-overlays.json`.
- Nothing here needs the internet or an account. The bundled sample HUD (`assets/hud-packages/matchframe-sample-cs2`, shipped as `resources/sample-huds`) is installed into the library on first start, once (removing it is respected).

## Package format

A HUD package is a folder (or ZIP of one) with `manifest.json` at its root (or one level down) plus static web files: HTML, compiled JavaScript, CSS, fonts, images, video. Allowed extensions, size limits, path-traversal and symlink rules are unchanged (`services/local-engine/src/hud/packages.ts`). Nothing in a package is executed by the program; it runs only inside a sandboxed renderer or browser source.

`manifest.json` (contracts `HudManifest`):

| Field | Required | Notes |
|---|---|---|
| `manifestVersion` | yes | `1` |
| `id` | yes | `^[a-z0-9][a-z0-9.-]{2,63}$`; not `assets`, `sdk` (`RESERVED_HUD_IDS`) |
| `name`, `version` (semver), `author`, `licence` | yes | |
| `game` | yes | `"cs2"` |
| `schemaVersions` | yes | must include `1` (public HUD state schema) |
| `entryPoints` | yes | variant → HTML file, e.g. `{ "live": "index.html" }`; variants: `live`, `compact`, `replay`, `veto`, `pre-match`, `break`, `post-map`, `post-series`, `studio` |
| `permissions` | yes | public data the HUD uses |
| `description`, `category`, `tags` | no | shown and filtered in the library |
| `thumbnail` | no | package-relative image for the library card (falls back to `preview`) |
| `designResolution` | no | `{ "width": 1920, "height": 1080 }`; defaults to the first of `resolutions` |
| `presets`, `settingsSchema`, `resolutions` | no | `settingsSchema` values follow `HudSettingField` (`boolean`, `number`, `string`, `color`, `select`) and produce the settings form |

A HUD page connects to the HUD server with the read-only SDK (`/sdk/hud-sdk.js`), using the `output`, `variant` and `t` query parameters it is opened with, and receives `hud.snapshot` messages (public HUD state, including `settings`). Its `html` and `body` backgrounds must be transparent.

### Import, update and conflicts

`POST /api/v1/hud/library/import` (ZIP body) and `POST /api/v1/hud/library/import-folder` (`{ path }`, local computer only) validate the package first; a failed import never touches the installed version. If the id is already installed the import fails with **409 `duplicate_id`** (`detail: { id, installedVersion, incomingVersion, builtin }`) unless `onConflict` is given: `replace` (install over it; the replaced version becomes the rollback target) or `copy` (install as a new HUD with id `<id>-copy[-n]`, name `<name> (copy)`). The built-in HUD can never be replaced.

## HUD server (engine overlay port, default 37212)

Read-only, GET only, bound to `127.0.0.1` unless `MATCHFRAME_HOST` says otherwise.

- `GET /hud/<hud-id>/<variant>?t=<token>[&mode=obs|desktop|preview][&checker=1]` — the **output page** (engine-generated, trusted). It is a transparent wrapper that loads the HUD in a full-size frame at its design resolution and scales it uniformly to fit the window or browser source (letterboxed, never stretched). Modes: `obs` (default; nothing but the HUD), `desktop` (adds an edit-mode outline and size label that the program toggles; never shown otherwise), `preview` (optional checkerboard with `checker=1`). The frame URL is
  - built-in HUD: `/hud/index.html?output=hud:<id>&variant=<v>&t=<token>`
  - package: `/huds/<id>/<entry>?output=hud:<id>&variant=<v>&t=<token>`
- `GET /hud-runtime-ws?hud=<id>&variant=<v>&mode=<mode>&t=<token>` (WebSocket) — the wrapper's control channel. The server sends a `HudRuntimeControl` message on connect and whenever `stopped`, `hidden` (global hide-all) or `reloadSeq` change. The wrapper: hides the frame while hidden (the HUD stays connected), removes it while stopped (the browser source stays connected and comes back on start), reloads it when `reloadSeq` changes. These connections are counted as the HUD's active outputs by mode.
- `GET /overlay-ws?output=hud:<id>&variant=<v>&t=<token>` — the existing HUD state socket also accepts library outputs. The state is the live timeline (no delay), the HUD's settings and preset, profile `program`. A new connection gets the current snapshot immediately; settings changes push a new snapshot to every output of that HUD.
- Tokens: one random token per library HUD (rotatable). They guard the state and control sockets and the output page; package files under `/huds/<id>/…` and the built-in renderer under `/hud/…` are static and public on this computer.
- Existing broadcast outputs (`/overlay/<output>/<variant>`, draft/publish/rollback, delay) keep working unchanged.

## Operator API (engine API port, bearer token)

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/v1/hud/library` | metadata.read | `HudLibrary` |
| `POST /api/v1/hud/library/import?onConflict=` | hud.publish | ZIP body |
| `POST /api/v1/hud/library/import-folder` | hud.publish | `{ path, onConflict? }` |
| `POST /api/v1/hud/library/:id/duplicate` | hud.publish | copy files and settings to a new HUD |
| `GET /api/v1/hud/library/:id/export` | metadata.read | ZIP download (`<id>-<version>.zip`) |
| `DELETE /api/v1/hud/library/:id` | hud.publish | remove (built-in refused; in use by a published broadcast output → 409 `in_use`) |
| `PUT /api/v1/hud/library/:id/settings` | hud.publish | `{ settings, presetId? }`; pushed live to its outputs |
| `POST /api/v1/hud/library/:id/start` / `stop` | hud.publish | clears/sets `stopped`; start also records last used |
| `POST /api/v1/hud/library/:id/reload` | hud.publish | increments `reloadSeq` |
| `POST /api/v1/hud/library/:id/rollback` | hud.publish | previous installed version |
| `POST /api/v1/hud/library/:id/rotate-token` | hud.publish | new token; old URLs stop working |
| `POST /api/v1/hud/library/visibility` | hud.publish | `{ hidden }` global hide-all |
| `GET /api/v1/hud/library/:id/state?variant=` | state.read | public state the outputs receive |

Status: `error` when the package fails verification or its entry file is missing; else `stopped` when stopped; else `running` when at least one output is connected; else `ready`. The manager shows `starting` while its desktop overlay window loads.

## Desktop program (Electron main)

- **Transparent HUD window** per HUD: `BrowserWindow({ transparent: true, backgroundColor: "#00000000", frame: false, hasShadow: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, show: false })`, level `screen-saver`, `setIgnoreMouseEvents(true)`, shown with `showInactive()`, no parent (independent of the manager), `backgroundThrottling: false`, sandboxed, no preload, no Node, context isolation, navigation locked to its output page. It loads `urls[variant] + "&mode=desktop"`. Topmost is re-asserted periodically while visible. Window bounds = the HUD's design size × scale, placed on the chosen display (DIP coordinates; displays left of or above the primary have negative origins; mixed scale factors handled by setting bounds twice). Default placement: fit the display, centred.
- **Edit mode** (explicit): the window accepts the mouse and can be dragged (outline and size label drawn by the output page), bounds are saved when it moves. Live mode is always click-through and never takes focus.
- **Preview window**: a normal framed window per HUD, `mode=preview`, checkerboard optional. Closing it touches nothing else.
- **Hotkeys** (global, configurable): toggle desktop HUD visibility (default `Ctrl+Shift+H`), emergency hide of all HUD graphics including OBS sources (default `Ctrl+Shift+F9`, toggles back). Conflicts are reported, not silently ignored.
- **Tray**: Show Manager, Show/Hide HUD (desktop overlays), Stop HUD (closes desktop overlays and previews), Quit.
- **Lifecycle**: minimising the manager leaves the runtime and overlays running. Closing the manager while overlays are open hides it to the tray. Quit closes outputs, unregisters hotkeys, asks the engine to shut down and waits for it (killing it after a timeout); the engine also exits if the program disappears.
- **Remote mode** (connected to another production computer): the library is usable, desktop overlays are disabled with a reason (the HUD belongs over the game on the production computer).

Bridge (`window.matchframe.hud`, answered only for `app://matchframe` frames): `available`, `displays()`, `overlays()`, `launch(hudId, { variant? })`, `close(hudId)`, `setVisible(hudId, visible)`, `configure(hudId, patch)`, `setEditing(hudId, editing)`, `openPreview(hudId, { variant, checker })`, `closePreviews(hudId)`, `hideAll()`/`showAll()`/`stopAll()`, `hotkeys()`, `setHotkeys(patch)`, `pickZip()`, `pickFolder()`, `openHudsFolder()`, `openHudFolder(hudId)`, `saveFile(name, bytes)`, `onOverlays(fn)`. Types: `apps/operator-web/src/api/desktop.ts`.

## OBS

Add a **Browser Source** with the HUD's URL (Copy OBS Browser URL) at the HUD's design size (shown next to the button, normally 1920×1080), above a **Game Capture** of CS2. The desktop HUD window is a separate window and is not part of Game Capture; use the browser source for the stream. Desktop and OBS outputs run independently or together.

## Limits

- Desktop overlays target **borderless windowed** games. Exclusive fullscreen is not supported by any normal desktop window.
- Multi-monitor placement, Windows display scaling, click-through and focus behaviour are verified on a Windows runner where possible; real CS2 and real OBS checks are manual (see `docs/operations/hud-library.md`).
