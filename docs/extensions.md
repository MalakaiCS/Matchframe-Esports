# Extending Matchframe

Extension points that exist today: HUD packages, the read-only HUD SDK, the local REST/WebSocket API, automation rules, device actions and the game-adapter interface. All are local; nothing requires a cloud account.

## 1. HUD packages

A HUD package is a folder or zip with a `manifest.json` at its root (or inside one top-level folder) plus static web files: HTML, compiled JavaScript, CSS, fonts, images. Two working examples: [`assets/hud-packages/matchframe-sample-cs2/`](../assets/hud-packages/matchframe-sample-cs2) (the sample HUD bundled with the program: scorebug, players, bomb, observed player, a settings form) and [`examples/hud-minimal/`](../examples/hud-minimal) (a score bug in ~40 lines). Packages are installed in the **HUD Library** (`docs/operations/hud-library.md`) and run as a transparent desktop HUD, a preview or an OBS browser source; the design is ADR-020 (`docs/architecture/hud-library.md`).

### Manifest (`HudManifest`, `packages/contracts/src/hud.ts`; JSON Schema in `packages/contracts/schema/HudManifest.schema.json`)

| Field | Rule |
|---|---|
| `manifestVersion` | `1` |
| `id` | lowercase, `^[a-z0-9][a-z0-9.-]{2,63}$`, e.g. `studio.team-cards` |
| `name`, `author`, `licence`, `description` | strings (licence is required) |
| `version` | semver |
| `game` | `"cs2"` |
| `schemaVersions` | public HUD state versions you support (currently `[1]`) |
| `entryPoints` | HTML file per variant you implement: `live`, `compact`, `replay`, `veto`, `pre-match`, `break`, `post-map`, `post-series`, `studio` (at least one) |
| `permissions` | data you need: `match.public`, `players.public`, `radar.public`, `utility.public`, `sponsors`, `series`, `event`, `veto.public`, `annotations` |
| `description`, `category`, `tags` | optional; shown, searched and filtered in the HUD Library |
| `thumbnail` | optional package-relative image for the library card (falls back to `preview`) |
| `designResolution` | optional `{ "width": 1920, "height": 1080 }`: the size the HUD is laid out for. Outputs scale it uniformly (letterboxed, never stretched). Defaults to the first of `resolutions` |
| `settingsSchema` | optional settings form for the library: `{ "key": { "type": "boolean" \| "number" \| "string" \| "color" \| "select" \| "player" \| "team", "label", "default", "options": [{ "value", "label" }], "min", "max", "step", "group" } }`. `player` stores a SteamID and `team` a Matchframe team id, both picked from lists. Values arrive in `state.settings` and update live |
| `presets`, `resolutions`, `preview` | optional |
| `runtime` | optional, `"matchframe"` (default). `"lhm"` is set by the importer for LHM-format HUDs (below); don't set it yourself |

Ids `assets` and `sdk` are reserved.

### LHM-format HUDs

HUDs built for Lexogrine HUD Manager on Lexogrine's MIT HUD template (`hud.json`, `index.html`, optionally `panel.json`) import without changes. The importer writes the manifest and turns `panel.json` into the settings form. At run time the HUD server provides what the template expects from LHM: socket.io with raw game data, panel settings and buttons, and `/api` with Matchframe's teams, players, current match and built-in radars. Operator steps and limits are in `docs/operations/hud-library.md` (LHM-format HUDs); the protocol details are in `docs/architecture/hud-library.md` (ADR-023). New HUDs should use the HUD SDK below: it gives the processed state (killfeed, utility, radar, series, delay) that LHM HUDs have to work out from raw data.

### What the engine enforces on import

- Allowed file types only (`.html .js .mjs .css .json` images, fonts, `.webm .mp4 .txt .md .ico`); no executables, no symlinks, no absolute paths or `..`; ≤ 2,000 files, ≤ 25 MB per file, ≤ 60 MB total.
- The manifest must validate; every entry point must exist.
- Installing never overwrites what is on air: broadcast outputs reference a package and are published explicitly, with rollback. In the HUD Library, importing an id that is already installed asks to replace it (the old version stays available for rollback) or keep both (a copy with a new id).

### Runtime environment

- Library outputs open `http://127.0.0.1:37212/hud/<id>/<variant>?t=…`, a transparent page that loads your entry file in a frame at the design resolution and scales it. Your page itself is served from the overlay origin (`http://127.0.0.1:37212/huds/<id>/<entry>?output=…&variant=…&t=…`); keep its `html` and `body` backgrounds transparent. It runs with a strict CSP: scripts and styles from the package only (inline styles allowed), images/fonts/media from the package or `data:`/`blob:`, network access only to the overlay origin and its WebSocket. No remote fonts, CDNs or analytics.
- Data arrives over the read-only overlay socket as `HudState` (`packages/hud-sdk/src/state.ts`) — the public projection for that output's timeline (live or delayed). It never contains director candidates, predictions or operator data.
- The only message a HUD may send is a sponsor display acknowledgement.

### The SDK

Import it from the engine (`/sdk/hud-sdk.js`, an ES module) or from `@matchframe/hud-sdk` when bundling:

```js
import { HudClient, displayClock, formatClock } from "/sdk/hud-sdk.js";
const client = new HudClient({ url, onState: (state, receivedAt) => render(state, receivedAt) });
client.start();
// Clocks: extrapolate only while the source says they run, for at most 1.5 s past the last update.
// receivedAt is performance.now(); compare it with performance.now().
const seconds = displayClock(state.match.phaseEndsInSec, state.match.clockRunning, receivedAt, performance.now());
client.ackSponsor(sponsorId, zone); // proof of delivery for sponsor reporting
```

Honour the flags in the state: show a SIMULATION marker when `state.simulated` is true, dim or freeze when `state.stale` is true, and render `null` values as unknown (not zero).

**Minimap** (`state.radar`, permission `radar.public`): `players`, `bomb` and `utility` carry 0–1 coordinates on the background. In mode `"image"`, `backgroundUrl` is a radar image (the built-in one for the map, served at `/overlay-api/radar-image/<map>`, or an operator-calibrated image); in mode `"schematic"` it is a JSON outline (`cells`, `polygons`, `regions`) at `/overlay-api/radar/<map>`; in mode `"none"` draw nothing. Player markers have `side`, `alive`, `observed`, `flashed`, `hasBomb`, `label` (observer slot) and `yawDeg`; utility has `type`, `side` (thrower) and `radius`.

**Killfeed** (`state.killfeed.entries`, the current round): `killer`, `victim`, `weapon` (e.g. `"weapon_ak47"`), `headshot`, `assister` and `attackerBlind`. Game state integration reports no kill events, so `kind: "probable"` entries are paired from counter changes (the weapon is the killer's weapon in hand) and `kind: "elimination"` has no killer; any field can be `null`. Keep each row on screen for a few seconds after it first arrives (the bundled HUDs use 5–7 s). The Sample CS2 HUD (`assets/hud-packages/matchframe-sample-cs2/app.js`) shows both in plain JavaScript.

## 2. Local API

OpenAPI 3.1: [`docs/architecture/openapi.json`](architecture/openapi.json) (regenerate with `pnpm openapi`); route table with permissions: [`docs/architecture/api-routes.md`](architecture/api-routes.md). Issue a role-scoped token (`POST /api/v1/tokens`) per integration. Mutations are refused from foreign browser origins. Operator WebSocket topics are listed in the route table.

## 3. Automation rules

Typed signal rules (`packages/automation`): trigger event kinds, conditions, cooldown/debounce/dedupe, priority, allowed program modes, required capabilities, actions, dry run. Manage through `/api/v1/automation/rules` and test with `POST /api/v1/automation/simulate`. Rules never replay events from before a start or reconnect.

## 4. Devices

Named actions and tally for Companion, Stream Deck or custom controllers: [integrations/companion-streamdeck.md](integrations/companion-streamdeck.md).

## 5. Game adapters (expansion track)

`GameAdapter` (`packages/game-adapters/src/adapter.ts`): `discover()`, `capabilities()`, `start(context)`, `subscribe(handler)`, `stop()`, emitting normalized events. Only the CS2 adapter exists; other games are listed as planned and shown as unsupported. Each new game needs its own adapter, HUDs and real test evidence before any support is claimed.
