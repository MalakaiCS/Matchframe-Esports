# Extending Matchframe

Extension points that exist today: HUD packages, the read-only HUD SDK, the local REST/WebSocket API, automation rules, device actions and the game-adapter interface. All are local; nothing requires a cloud account.

## 1. HUD packages

A HUD package is a folder or zip with a `manifest.json` at its root (or inside one top-level folder) plus static web files. A complete working example is in [`examples/hud-minimal/`](../examples/hud-minimal) — a score bug in ~40 lines — and the engine test suite installs and publishes it.

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
| `presets`, `settingsSchema`, `resolutions`, `preview` | optional |

### What the engine enforces on import

- Allowed file types only (`.html .js .mjs .css .json` images, fonts, `.webm .mp4 .txt .md .ico`); no executables, no symlinks, no absolute paths or `..`; ≤ 2,000 files, ≤ 25 MB per file, ≤ 60 MB total.
- The manifest must validate; every entry point must exist.
- Installing never overwrites what is on air: outputs reference a package and are published explicitly, with rollback.

### Runtime environment

- The page is served from the overlay origin (`http://127.0.0.1:37212/huds/<id>/<entry>?output=…&variant=…&t=…`) with a strict CSP: scripts and styles from the package only (inline styles allowed), images/fonts/media from the package or `data:`/`blob:`, network access only to the overlay origin and its WebSocket. No remote fonts, CDNs or analytics.
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

## 2. Local API

OpenAPI 3.1: [`docs/architecture/openapi.json`](architecture/openapi.json) (regenerate with `pnpm openapi`); route table with permissions: [`docs/architecture/api-routes.md`](architecture/api-routes.md). Issue a role-scoped token (`POST /api/v1/tokens`) per integration. Mutations are refused from foreign browser origins. Operator WebSocket topics are listed in the route table.

## 3. Automation rules

Typed signal rules (`packages/automation`): trigger event kinds, conditions, cooldown/debounce/dedupe, priority, allowed program modes, required capabilities, actions, dry run. Manage through `/api/v1/automation/rules` and test with `POST /api/v1/automation/simulate`. Rules never replay events from before a start or reconnect.

## 4. Devices

Named actions and tally for Companion, Stream Deck or custom controllers: [integrations/companion-streamdeck.md](integrations/companion-streamdeck.md).

## 5. Game adapters (expansion track)

`GameAdapter` (`packages/game-adapters/src/adapter.ts`): `discover()`, `capabilities()`, `start(context)`, `subscribe(handler)`, `stop()`, emitting normalized events. Only the CS2 adapter exists; other games are listed as planned and shown as unsupported. Each new game needs its own adapter, HUDs and real test evidence before any support is claimed.
