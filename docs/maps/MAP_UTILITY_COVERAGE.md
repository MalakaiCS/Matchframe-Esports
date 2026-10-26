# Map × utility coverage

What Matchframe can track, predict and show per map, grenade type and area, and the evidence behind each claim. Status words follow FEATURE_COVERAGE.md. "Live" means a real CS2 GSI feed; no real GSI feed or CS2 client was available while building this release, so **every live telemetry cell is `unverified`** until the setup checklist records a real capture.

## 1. Map packs and profiles (generated)

The table below is produced from the shipped data by `pnpm coverage:maps` (`docs/maps/coverage.generated.md`); the engine serves the same rows, combined with the live source's capability report, at `GET /api/v1/coverage/maps`.

<!-- keep in sync: pnpm coverage:maps -->
| Map | Pack | Regions (source) | Derived regions needing validation | Floor grid | Radar calibration | Cameras validated / unvalidated | Scenario rules |
|---|---|---|---|---|---|---|---|
| Inferno (`de_inferno`) | yes | 26 (demo_place_names) | bottom_banana, top_banana | yes | none | 0 / 0 | inferno-bottom-banana |
| Mirage (`de_mirage`) | **no** | – | – | no | none | 0 / 0 | – |
| Dust II (`de_dust2`) | **no** | – | – | no | none | 0 / 0 | – |
| Nuke (`de_nuke`) | **no** | – | – | no | none | 0 / 0 | – |
| Ancient (`de_ancient`) | yes | 18 (demo_place_names) | – | yes | none | 0 / 0 | – |
| Anubis (`de_anubis`) | yes | 28 (demo_place_names) | – | yes | none | 0 / 0 | – |
| Overpass (`de_overpass`) | yes | 14 (demo_place_names) | – | yes | none | 0 / 0 | – |
| Train (`de_train`) | **no** | – | – | no | none | 0 / 0 | – |
| Vertigo (`de_vertigo`) | **no** | – | – | no | none | 0 / 0 | – |

Packs were built by `build-map-pack` from one real 2023 demo per map (see `docs/models/phase0-demo-pipeline-report.md` §8). Regions are the engine's own place names over 64-unit cells; the Inferno Banana split is derived and unvalidated. Overpass has site B only (2v2 demo). Nuke was refused for lack of usable data. Maps without a pack still get whole-map tracking; they only lack region names, floor grid and level association.

| Type | Source | Samples | Fuse (mean ± sd used live) | Effect duration (mean ± sd used live) |
|---|---|---|---|---|
| he | measured_from_demos | 66 | 1641 ± 100 ms | – |
| flashbang | measured_from_demos | 49 | 1641 ± 100 ms | – |
| smoke | measured_from_demos | 47 | – | 22063 ± 250 ms |
| molotov | measured_from_demos | 32 | 1610 ± 311 ms | 6875 ± 810 ms |
| incendiary | measured_from_demos | 13 | 1369 ± 427 ms | 7024 ± 250 ms |
| decoy | default_unmeasured | 0 | – | 15000 ± 1500 ms |

Measured values come from one Inferno match; the live engine floors the standard deviation at 100 ms (fuse) and 250 ms (duration).

## 2. Per grenade type × source capability

| Type | Identity & owner (live GSI) | Flight / position (live GSI) | Activation | Effect state | Demo evidence (types resolved) | Tracker tests (synthetic GSI) |
|---|---|---|---|---|---|---|
| HE | unverified | unverified | predicted from fuse; confirmed only by disappearance near predicted time → `derived` | instantaneous; damage never inferred from GSI | 244 thrown across 5 demos; entity signature agrees with detonate events 115/115 | prediction kept separate from confirmation (A64); vanished outside fuse window → lost, not detonated |
| Flashbang | unverified | unverified | as HE | blind state only where GSI reports `flashed` per player (`measured`); no inferred victims | 264 thrown; 115/115 signature agreement (with HE) | detonation linked to measured flash state; director A54 (flash_entry opportunity, entry duel shown once the defender is blind) |
| Smoke | unverified | unverified | at rest (`effecttime` when present) | active / expired from GSI `effecttime`; extent = nominal radius, presented as approximate | 252 thrown; 47 durations measured | deployment from source effect time, expiry measured on removal; director A55 (smoke_execute story only near deployment while the smoke stays tracked) |
| Molotov | unverified | unverified | fire area (`inferno` entity) linked to projectile | fire active / expired; flames positions when GSI provides them | 97 thrown; `m_bIsIncGrenade` agrees with weapon_fire 47/47 + 27/27 | A56 separated from incendiary by the thrower's inventory delta (not by team side); projectile linked to fire area |
| Incendiary | unverified | unverified | as molotov | as molotov | 95 thrown | A56 as molotov; without inventory evidence an explicitly *estimated* side-based type is reported |
| Decoy | unverified | unverified | at rest | active / expired (default duration) | 8 thrown (1 event-linked sample) | activation at rest; director A57 (tracked, never an automatic cut) |

GSI sends grenades as one shared `firebomb` type for both molotov and incendiary projectiles; the tracker resolves the exact type from the thrower's inventory change and otherwise reports `molotov_or_incendiary` with its uncertainty instead of guessing.

## 3. Areas

- **Whole-map tracking (A52).** The tracker has no callout whitelist: every grenade is tracked anywhere, including flights outside walkable cells (A60, over-roof trajectories). Region and level are attached when a pack exists and left null otherwise. Tests: `packages/cs2-state/test/utility-tracker.test.ts`.
- **Level association (A59).** Uses the pack's levels and floor grid. All four real packs have a single `ground` level; multi-floor areas are present in the floor grid (Inferno 30, Ancient 7, Anubis 36, Overpass 12 stacked cells) but no level split has been authored, so level-specific framing is **unverified** on real maps (tested on the synthetic map).
- **Inferno Bottom Banana (A22/A23).** The scenario is configuration (`inferno-bottom-banana`) over the generic utility engine. On the demo-derived Inferno geometry: the T stack is placed in `bottom_banana` (not `top_banana`), a consequential HE raises the scenario, and smoke/decoy or the stack alone do not (`packages/director-policy/test/real-geometry.test.ts`). No camera is validated for Bottom Banana on a real map, so the director falls back to a POV and marks `UTILITY_NO_CAMERA`. The static-camera cinematic itself is tested only on the synthetic map, and **real in-game static-camera execution is blocked** (no CS2 client; see CAPABILITIES.md).

## 4. Cameras and fallbacks

No validated static camera exists for any real map: cameras must be captured in game with `getpos` and validated by an operator through the setup checklist, and that was not possible here. For every map/type/area the fallback is therefore: the POV of the most relevant player (affected player, thrower, or the player best placed to see the effect), otherwise radar emphasis on the HUD, otherwise hold the current shot. Multi-map cinematic support is **not claimed**.

## 5. To close remaining gaps

1. Run a real CS2 observer client with GSI; record capabilities per type (the capability sampler stores per-type support with the game build).
2. Build packs for Mirage, Dust II, Nuke, Train and Vertigo from usable demos (`pnpm worker build-map-pack …`); add more demos per map to fill unwalked areas and validate derived regions.
3. Capture and validate at least one static camera per declared area with the in-game `getpos` flow, then run the static-camera setup test on each map before enabling automatic cinematics there.
