# Phase 0 — demo pipeline report (5 real CS2 demos)

Status: **pipeline proof**. Every number below comes from commands run on 2026-10-26 with the
code on this branch (`workers/`), the final run being
`benchmark → inspect/hash → validate/verify → check-leakage → build-map-pack ×4 →
measure-utility → freeze-dataset → audit-split → train → evaluate → export-model → promote →
estimate ×2`. Demos are referred to by dataset id `<map>-<build>-<sha256[:16]>`.

## 1. Corpus and environment

| dataset id | map | build | recorder | size (MB) | rounds with result |
|---|---|---|---|---:|---:|
| de_overpass-13914-d7f8405454bafcc9 | de_overpass (2v2 wingman) | 13914 | SourceTV | 23.7 | 16 |
| de_anubis-13914-fe6be1aceb1b8834 | de_anubis | 13914 | SourceTV | 31.7 | 14 |
| de_ancient-13916-9051f4690a8a2f1a | de_ancient | 13916 | SourceTV | 39.3 | 21 |
| de_inferno-13926-ee700e629d47c8ea | de_inferno | 13926 | SourceTV | 77.8 | 17 |
| de_inferno-14000-567aef660852a90c | de_inferno | 14000 | client POV | 240.8 | 17 (starts at round 8) |

Source: MIT test corpus (markus-wa/cs-demos-2), 2023 builds. Machine: 4 vCPU Linux VM,
15 GiB RAM, Python 3.13.17, demoparser2 0.42.0, polars 2.1.0, pyarrow 26.0.0, duckdb 2.0.0,
lightgbm 4.7.0. All runs single-process, sequential.

Tick rate was derived from the `game_time`/tick slope: **64.0 on all 5 demos**. Recorded frame
interval: every 3 ticks (21.33 Hz) on the four SourceTV demos, every tick (64 Hz) on the POV demo.

## 2. Throughput, memory, temp space, output size

`benchmark --with-features` (extract in a child process per demo; RSS = child `ru_maxrss`;
temp = staging directory size just before the atomic rename; demoparser2 itself uses no temp disk).

| dataset | wall (s) | parse (s) | MB/s | peak RSS (MB) | temp peak (MB) | output (MB) | features wall (s) | features RSS (MB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| overpass-13914 | 1.441 | 0.957 | 16.44 | 425.1 | 1.25 | 1.24 | 0.389 | 220.3 |
| anubis-13914 | 3.574 | 2.818 | 8.87 | 803.1 | 3.29 | 3.28 | 1.127 | 492.4 |
| inferno-13926 | 3.699 | 2.762 | 21.03 | 1071.5 | 3.85 | 3.83 | 1.263 | 592.8 |
| ancient-13916 | 3.988 | 3.091 | 9.85 | 1038.7 | 4.30 | 4.29 | 1.433 | 612.8 |
| inferno-14000 (POV) | 17.378 | 14.103 | 13.85 | 2142.8 | 8.69 | 8.68 | 2.031 | 911.5 |

| metric (n = 5) | p50 | p95 | mean | min | max |
|---|---:|---:|---:|---:|---:|
| throughput (MB/s) | 13.85 | 20.11 | 14.01 | 8.87 | 21.03 |
| extract wall (s) | 3.70 | 14.70 | 6.02 | 1.44 | 17.38 |
| peak RSS (MB) | 1038.7 | 1928.5 | 1096.2 | 425.1 | 2142.8 |
| temp peak (MB) | 3.85 | 7.82 | 4.28 | 1.25 | 8.69 |
| output (MB) | 3.83 | 7.80 | 4.27 | 1.24 | 8.68 |
| output / raw bytes | 0.0524 | 0.1081 | 0.0701 | 0.0361 | 0.1093 |
| build-features wall (s) | 1.263 | 1.911 | 1.249 | 0.389 | 2.031 |

Bytes per table (p50 / p95 over 5 demos): `ticks` 3.55 MB / 7.21 MB · `grenade_samples`
144 KB / 472 KB · `grenades` 74 KB / 91 KB · `events` 11.7 KB / 31.9 KB · `attributions`
6.1 KB / 6.6 KB · `rounds` 7.0 KB / 7.1 KB · `players` 4.4 KB / 4.5 KB · `team_scores`
1.4 KB / 1.4 KB · `features` 6.64 MB / 7.14 MB · `labels` 112 KB / 126 KB · dataset JSON
(manifest/qa/validation) 16.0 KB / 18.5 KB.

Sampling (`--sample-hz 16 --event-window-s 2`): SourceTV demos keep 86–89 % of full-rate player
rows (e.g. ancient 364,809 of 419,298; 31,619 grid frames + 20,193 event-window frames) because
the 16 Hz grid is close to the 21.3 Hz recording rate. The 64 Hz POV demo keeps 785,346 of
1,325,995 rows (59 %) after 33,580 duplicate (player, tick) parser rows were dropped; its
`ticks` table is 8.0 MB vs 1.1–4.0 MB for the SourceTV demos.

## 3. Event and field coverage per demo

| dataset | game event types | lifecycle events | `player_hurt` | parser ids on deaths (user) | ids after recovery: deaths user / attacker | hurt user / attacker |
|---|---:|---|---:|---:|---|---|
| overpass-13914 | 11 | none | none | 0.977 | 0.977 / 1.000 | – |
| anubis-13914 | 8 | none | none | 0.000 | 0.961 / 0.961 | – |
| ancient-13916 | 9 | none | none | 0.000 | 0.963 / 0.957 | – |
| inferno-13926 | 57 | all (HE 66, flash 49, smoke 50/47, inferno 46/45, decoy 2/1) | 464 | 0.000 | 0.952 / 0.952 | 0.871 / 0.838 |
| inferno-14000 | 39 | HE 60, flash 76, smoke 92/82, inferno 86/86; no `player_blind`, no `round_end` | 436 | 0.077 | 0.904 / 0.769 | 0.874 / 0.117 |

* The three 2023 MM/third-party SourceTV demos only carry `player_death` and `round_end`
  (+ `round_start`); no hurt, utility lifecycle, `weapon_fire`, blind or bomb events.
* **Player identity on game events is missing** in four demos (parser returns null SteamIDs).
  Recovered from scoreboard counter deltas (`kills_total`/`deaths_total`, pawn
  `m_unTotalRoundDamageDealt`); `damage_total` was rejected because it only updates at round end.
  Cross-check where the parser does give ids (overpass): **41 of 41** recovered kills agree.
  Damage attribution rate (attributed / all health drops): ancient 0.920, anubis 0.818,
  inferno-13926 0.956, overpass 0.964, inferno-14000 **0.000** (the live round-damage property is
  absent in that build/recording).
* Alive-row field coverage (sampled `ticks`): ≥ 0.984 for x/y/z/health/team/pitch/yaw/place/weapon
  on all four SourceTV demos. POV demo: z 0.857, active_weapon 0.216 (partial entity state).

## 4. Grenade entity findings

| dataset | raw rows | projectile rows | held-weapon rows dropped (with position) | projectiles | resolved types | unknown |
|---|---:|---:|---:|---:|---|---:|
| overpass-13914 | 89,839 | 14,007 | 75,832 (0) | 90 | flash 32, HE 17, smoke 22, molotov 4, incendiary 11, decoy 4 | 0 |
| anubis-13914 | 247,617 | 36,341 | 211,276 (0) | 182 | flash 54, HE 47, smoke 60, molotov 12, incendiary 9 | 0 |
| ancient-13916 | 330,888 | 31,255 | 299,633 (0) | 228 | flash 68, HE 67, smoke 48, molotov 10, incendiary 33, decoy 2 | 0 |
| inferno-13926 | 379,919 | 31,683 | 348,236 (0) | 214 | flash 49, HE 66, smoke 50, molotov 32, incendiary 15, decoy 2 | 0 |
| inferno-14000 | 1,541,744 | 149,816 | 1,391,928 (0) | 247 | flash 61, HE 47, smoke 72, molotov 39, incendiary 27 | 1 |

* Classes vary by build as expected: builds 13914–13926 use `CBaseCSGrenadeProjectile` (HE **or**
  flash) and `CMolotovProjectile` (molotov **or** incendiary); build 14000 has
  `CHEGrenadeProjectile`/`CFlashbangProjectile` but still the shared `CMolotovProjectile`.
* `CFlashbang`/`CHEGrenade`/`CSmokeGrenade`/`CMolotovGrenade`/`CIncendiaryGrenade`/`CDecoyGrenade`
  rows are held inventory entities: **0 of 2,326,905 such rows carry a position** → excluded.
* Entity indices are reused across throws (one id spanned up to 77k ticks); samples are split into
  throws on tick gaps > 16, class or owner change.
* Resolution evidence: `hegrenade_detonate`/`flashbang_detonate` entity id (inferno-13926: 115/115
  agree with the `m_DmgRadius`/`m_flDamage` signature 350/99 = HE, 100/100 = flash);
  `m_bIsIncGrenade` (inferno-13926: 47/47 agree with tick-matched `weapon_fire`; inferno-14000:
  27/27). In the three event-less demos the signature rule resolved all 285
  `CBaseCSGrenadeProjectile` throws and `m_bIsIncGrenade` all 79 `CMolotovProjectile` throws. Build 14000 does not expose `m_DmgRadius`/`m_flDamage`, and exposes `m_bIsIncGrenade`
  only as `true`: 39 molotovs there rest on the weaker `weapon_fire` tick match (confidence 0.8),
  1 projectile stays `unknown` (two candidate throws).
* `inferno_startburn` carries the inferno entity id, not the projectile's: linked by time
  (projectile ends 3 ticks before) and position (median 9.5 units in probing).
* Activation linked by exact events: 213/214 (inferno-13926), 214/247 (inferno-14000); in the
  event-less demos HE/flash activation is *derived* from projectile disappearance (±1 frame) and
  flagged as such; smoke/fire activation stays null there.
* Affected players are only recorded with exact support (`player_blind` by flash entity id; HE
  `player_hurt` at a unique detonation tick); fire damage is not attributed.

## 5. Validation verdicts (`validate`)

| dataset | verdict | result reconciliation vs team scores | reasons / notable flags |
|---|---|---|---|
| overpass-13914 | usable | 16/16 | 8 round flags (warm-up ×2, pre-first-freeze, no-result, trailing segment) |
| anubis-13914 | usable | 14/14 | 6 round flags (same kinds) |
| ancient-13916 | usable | 21/21 | 6 round flags |
| inferno-13926 | usable | 17/17 | 6 round flags |
| inferno-14000 | **quarantine** | 17/17 | `field_coverage: z 0.857 < 0.95; active_weapon 0.215 < 0.5`; flag: starts mid-match (round 8) |

All five pass manifest, checksums, Parquet readability, non-empty parse, expected map, round
structure, identity continuity, timestamp ordering, map bounds, causal features and DuckDB
queries (e.g. inferno-13926 opening/middle/closing rounds: 15,360 / 27,020 / 30,610 tick rows,
10 players, 8 deaths each). `verify` passed on all five; re-extracting the smallest demo returned
`duplicate` in 0.32 s without rewriting. Round boundaries come from `is_freeze_period`
transitions; results from `round_end` events, or from the `round_win_status` 0→non-zero
transition when the event list lacks `round_end` (POV demo).

## 6. Capacity extrapolation vs the 2 TB plan (9 maps)

`estimate` uses per-demo bytes from the benchmark (mean and p95), a transient raw-ingest queue of
200 demos at p95 size, 2 % of demos kept as curated raw, and reserves the full models/clips
allocations (not measured).

| category (allocation) | 1,000 demos/map (9,000) mean / p95 GB | 3,000 demos/map (27,000) mean / p95 GB |
|---|---|---|
| sampled state: ticks + grenade_samples (600) | 37.4 / 69.1 | 112.1 / 207.3 (35 %) |
| events + features (300) | 51.4 / 66.7 | 154.3 / 200.1 (67 %) |
| raw ingest queue (200) | 16.5 / 41.6 | 16.5 / 41.6 |
| curated raw 2 % (150) | 14.9 / 37.5 | 44.6 / 112.4 (75 %) |
| metadata (50) | 0.15 / 0.17 | 0.45 / 0.50 |
| models (100), clips (150) | reserved | reserved |
| **total p95 incl. reserved** | **465.1 GB → 1,534.9 GB headroom** | **812.0 GB → 1,188.0 GB headroom** |

* Fits the 2 TB plan at both sizes on these numbers; the sampled-state allocation alone would
  hold ≈ 8,682 demos/map (p95) for 9 maps.
* Keeping **all raw demos would not fit**: 743.8 GB (9,000) / 2,231.3 GB (27,000) at the mean
  raw size — raw retention must stay a queue + curated sample.
* Single-worker extraction time at the measured mean (6.02 s/demo, excluding features):
  15.0 h for 9,000 demos, 45.1 h for 27,000.

## 7. Measured utility profiles (`assets/utility-profiles/measured.json`)

Only the inferno-13926 demo has lifecycle events among the usable datasets, so durations come from
one match; gravity uses trajectories from all four usable demos. Types need ≥ 5 event-linked
samples.

| type | n | fuse (first projectile frame → activation) | effect duration | default (profiles.ts) |
|---|---:|---|---|---|
| he | 66 | 1640.9 ± 1.9 ms (median 1640.6 = 105 ticks) | – | fuse 1600 ± 250 |
| flashbang | 49 | 1641.3 ± 4.5 ms | – | fuse 1600 ± 250 |
| smoke | 47 | (time to detonation 1964 ± 1069 ms, n = 50; at-rest) | 22062.5 ± 21.9 ms | effect 20000 ± 1500 |
| molotov | 32 | 1609.9 ± 310.6 ms (startburn) | 6874.5 ± 809.9 ms (median 7031.2; min 2437.5) | fuse 2000 ± 300, effect 7000 ± 800 |
| incendiary | 13 (14 fuse) | 1369.4 ± 427.3 ms | 7024.0 ± 17.6 ms | fuse 2000 ± 300, effect 7000 ± 800 |
| decoy | omitted | 1 event-linked sample < 5 | | |

From the tick-matched `weapon_fire` instead of the first projectile frame, fuses are ~110 ms
longer (HE 1750.2 ± 38.8 ms, flash 1756.1 ± 28.7 ms). Effective grenade gravity: **320.0 u/s²
median** (mean 319.89, sd 1.25) from 681 airborne-segment fits, median z-residual RMS 0.009 units,
12 fits rejected — i.e. 0.4 × sv_gravity 800, consistent across all six types.

## 8. Map packs (`assets/map-packs/`)

Packs built only from usable datasets (one demo per map; the quarantined POV demo was excluded);
`de_nuke` was refused (`INSUFFICIENT_DATA`) — no packs for maps without data. All four pass the
Python validator and the actual zod `MapPack` schema from `packages/contracts/src/maps.ts`.
Cells 64 u (XY) × 128 u (Z); floor grid 64 u; one `ground` level; `radar: null`; no cameras/paths.

| map | samples | regions (place + derived) | region cells | floor cells (multi-floor) | bombsites | JSON | graph nodes/edges |
|---|---:|---|---:|---:|---|---:|---|
| de_inferno | 223,644 | 26 (24 + bottom/top banana) | 2,206 | 1,569 (30) | A, B | 93.9 KB | 24 / 32 |
| de_ancient | 252,337 | 18 | 2,094 | 1,488 (7) | A, B | 89.0 KB | 18 / 33 |
| de_anubis | 188,209 | 28 | 2,346 | 1,724 (36) | A, B | 103.2 KB | 28 / 44 |
| de_overpass | 57,238 | 14 | 834 | 638 (12) | B only | 40.2 KB | 14 / 17 |

Inferno `Banana` split: principal axis (0.580, 0.815) explains 91.55 % of the cell-centre variance;
split at the sample-weighted median; the half nearer the `TSpawn` centroid (−1544, 508) is
`bottom_banana` (centroid 217, 1509) vs `top_banana` (659, 2075). Both carry
`derived_split` + `requires_operator_validation`, `validated: false`. Overpass has no `BombsiteA`
samples in its 2v2 demo, so only site B is declared.

## 9. Features, labels, leakage

* Pairwise T×CT features at 16 Hz grid ticks of live phases: 216,761 (inferno-13926), 236,457
  (ancient), 198,803 (anubis), 29,273 (overpass), 286,730 (POV) rows; 19 `gsi_compatible` +
  3 `demo_rich` features.
* `contact_2s` positives / unknown: inferno-13926 6,790 / 208; ancient 8,263 / 614; anubis
  5,809 / 262; overpass 2,342 / 0; POV 0 / 286,730 (all null: damage attribution unavailable).
* Leakage: `build-features` refuses to write unless the perturbation check passes; it passed on all
  five. Standalone `check-leakage` on inferno-13926: 3 cuts (48,841 / 116,806 / 176,877 rows at or
  before the cut), max abs feature difference **0.0**, 0 rows with future inputs. A unit test
  proves the check fails for a feature built from the next sample.

## 10. Model pipeline proof (`contact_2s`)

Frozen split (newest build → test; build is the only time proxy): train = anubis-13914 +
overpass-13914 (227,814 rows, 8,151 positives), val = ancient-13916 (235,843 / 8,263),
test = inferno-13926 (216,553 / 6,790); POV demo skipped (quarantine). `audit-split` passed
(relations recomputed). LightGBM (seed 7, 113 rounds with early stopping on val), features
`gsi_compatible` only.

| split | model AUC | heuristic AUC | model Brier | heuristic Brier | prevalence-only Brier |
|---|---:|---:|---:|---:|---:|
| val (ancient) | 0.9675 | 0.9483 | 0.02170 | 0.02585 | 0.03381 |
| test (inferno) | 0.9406 | 0.9147 | 0.02620 | 0.02702 | 0.03037 |

* Heuristic = `clip((facing_max+1)/2)² · exp(−dist_3d/1000)`, Platt-calibrated on train.
* Test calibration is poor in the upper bins (predicted 0.549 → observed 0.312 in the 0.5–0.6 bin;
  ECE 0.0177 vs 0.0126 for the heuristic).
* **No confidence interval**: the test split holds one match, and the match-level bootstrap refuses
  to estimate a CI from fewer than 2 matches.
* Top gain: dist_3d 34.7 %, facing_min 15.9 %, facing_max 14.7 %, dist_2d 12.3 %.
* Export: LightGBM `dump_model()` JSON (113 trees) + model card (status `experimental`,
  required capability `gsi_compatible`) + 64 parity vectors (9 with missing values); the
  pure-Python reference tree evaluator reproduces LightGBM raw scores to 5.3e-15. `promote → approved`
  was refused (exit 3, transition not allowed); `promote → shadow` succeeded.
* The committed fixture `fixtures/models/contact_2s_parity/` is trained on **synthetic** data with the
  same 19-feature schema (40 trees, 64 vectors, max raw-score error 1.8e-15 in the reference
  evaluator), so it contains no demo-derived content.

This model is **not a director model**: 4 matches, 4 different maps, one of them 2v2, 2023
builds; the high AUCs mostly reflect that pairs who are close and facing each other are about to
fight.

## 11. What is NOT verified

* Only **5 demos from 2023 builds 13914–14000**, not the target 20–50 current-build demos.
  Entity classes, entity properties (e.g. `m_DmgRadius` already missing in 14000), event coverage
  and recorded frame rates can differ on current builds.
* No current-build **SourceTV** demo was tested; the only build-14000 demo is a client POV
  recording and is quarantined for partial entity state.
* The HE/flash entity-property signature was validated against events on one demo (115
  projectiles); its use in the three event-less demos (285 projectiles) is unverified by events.
* Counter-delta identity recovery was cross-checked on 41 kills in one 2v2 demo; damage
  attribution was never cross-checked against parser ids (no demo had both).
* Utility durations come from one match; decoy is not measured; fuse is quantised to the 3-tick
  frame interval.
* Map packs come from one match per map: cells exist only where players walked, place names are
  the engine's, the banana split and all regions are unvalidated, there is no radar calibration and
  no level split.
* Capacity figures extrapolate from 5 demos (p95 over 5 is a weak tail estimate); 64 Hz-recorded
  demos roughly double the `ticks` table; models and clips were not measured; only one worker on a
  4-vCPU VM was measured (no parallel scaling).
* The TypeScript LightGBM runtime was not exercised — parity was proven only with the Python
  reference evaluator against LightGBM's own predictions.
* Not run on Windows (the app's primary platform); atomic directory rename semantics were only
  exercised on Linux.

## 12. Reproduce

```sh
export PYTHONPATH=workers/common:workers/demo-parser:workers/features:workers/training:workers/evaluation
python -m mf_common.cli benchmark --inputs DEMOS --dataset-root DATA --with-features --out bench.json
for d in DATA/map=*/build=*/demo=*; do python -m mf_common.cli validate --dataset "$d"; done
python -m mf_common.cli build-map-pack --datasets DATA --map de_inferno --out assets/map-packs/de_inferno.json --graph-out assets/map-packs/de_inferno.graph.json
python -m mf_common.cli measure-utility --datasets DATA --out assets/utility-profiles/measured.json
python -m mf_common.cli freeze-dataset --datasets DATA --out MODELS/frozen.json
python -m mf_common.cli audit-split --manifest MODELS/frozen.json
python -m mf_common.cli train --task contact_2s --dataset-manifest MODELS/frozen.json --out-dir MODELS
python -m mf_common.cli evaluate --model-dir MODELS/<id> --dataset-manifest MODELS/frozen.json --split test
python -m mf_common.cli export-model --model-dir MODELS/<id> --out EXPORT
python -m mf_common.cli estimate --benchmark-json bench.json --maps 9 --demos-per-map 3000 --budget-gb 2000
MF_TEST_DEMOS=DEMOS python -m pytest workers/tests
```
