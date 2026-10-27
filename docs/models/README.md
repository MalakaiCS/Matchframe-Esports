# Models: data, labels, training, evaluation

Matchframe's learned components are **advisory and offline-trained**. The live director is the deterministic baseline (`baseline-1`, `packages/director-policy`); a trained model can only run in **shadow** today, next to the baseline, and never drives the camera. Nothing here uses future demo information at live time, and parsed demos are not treated as expert observer decisions (they contain player behaviour, not camera choices).

Documents:

| File | Content |
|---|---|
| this file | data schemas, label definitions, training/evaluation commands, promotion gates, shadow comparison, training programme status |
| `phase0-demo-pipeline-report.md` | measured Phase 0 results on 5 real demos: throughput, memory, coverage, grenade findings, validation, capacity vs 2 TB, utility profiles, the `contact_2s` pipeline proof, and what is not verified |
| `model-card-contact_2s.md` | model card for the only trained task |
| `../../workers/README.md` | worker CLI reference, dataset layout, JSON-lines protocol |

## 1. Data schemas

Each imported demo becomes an immutable dataset directory `DATA/map=<map>/build=<build>/demo=<sha256[:16]>/`, written to a staging directory and published with one atomic rename; `manifest.json` (status `COMMITTED`) records provenance (source sha256 and size), parser name and version, extraction settings, measured tick rate and recorded frame rate, and per-file sha256/row counts. Tables (zstd Parquet): `rounds`, `players`, `ticks` (sampled player state), `events`, `attributions`, `team_scores`, `grenades`, `grenade_samples`; plus `qa.json`, `validation.json` and, after `build-features`, `features.parquet`, `labels.parquet`, `utility_labels.parquet`, `features_manifest.json`. Column-level detail: `workers/README.md` § Dataset layout.

Lineage in the engine: every import is a demo job with an append-only transition history (`GET /api/v1/jobs/:id`), the dataset directory, parser, schema version and the validation verdict. Training runs record their datasets, every step's result and the resulting model id (`GET /api/v1/training/runs`).

## 2. Feature sets

Pairwise T × CT features at 16 Hz grid ticks inside live phases, computed causally (only grid frames at or before the sample tick; `max_input_tick` stored and checked):

- `gsi_compatible` (19): `dist_3d`, `dist_2d`, `dz`, `facing_a`, `facing_b`, `facing_max`, `facing_min`, `closing_speed` (0.5 s history), `speed_a`, `speed_b`, `health_a/b`, `armor_a/b`, `weapon_class_a/b` (4 sniper, 3 rifle/MG, 2 SMG/shotgun, 1 pistol, 0 other), `alive_t`, `alive_ct`, `round_time_s`.
- `demo_rich` (3): `flash_a`, `flash_b`, `same_place` — need demo-only state; a model using them is refused for live use.

The engine computes the `gsi_compatible` set from live state with the same definitions (`services/local-engine/src/live/model-runtime.ts`); unknown values are NaN (never 0), routed by each tree's missing-value direction. Live/demo distribution parity is not yet measured (no real GSI recording).

Leakage control: `build-features` refuses to write unless a perturbation check passes (all frames after a cut are altered; features at or before the cut must be identical); `check-leakage` runs it standalone.

## 3. Label definitions

For each (tick t, T player a, CT player b) and horizon h ∈ {0.5, 1, 2, 3} s, looking only into (t, t + h]:

| Label | 1 | 0 | null (unknown) |
|---|---|---|---|
| `damage_<h>` | an attributed damage event between a and b | no attributed damage between them | an ambiguous attribution touched a or b before any positive, or the dataset's damage-attribution rate is < 0.5 |
| `death_<h>` | an attributed kill between a and b | no kill | ambiguous attribution touched a or b first |
| `contact_<h>` | damage or kill between a and b | neither | as `damage_<h>` |

Attributions come from exact events where the demo has them, otherwise from per-frame counter deltas with a unique opposing candidate (`attributed` / `ambiguous` / `unattributed`). Utility labels (per throw): activation delay, activation position and place — only when activation is linked by an exact event; otherwise null. Labels are stored separately from features and are never model inputs.

## 4. Commands (verified)

Engine (operator console or API; workers run at below-normal OS priority and training is refused while a live broadcast is running unless overridden):

```sh
# import a folder of demos (files inside configured ingest roots follow the retention policy; others are never deleted)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"paths":["D:/demos/incoming"]}' http://127.0.0.1:37211/api/v1/demos/import
# train contact_2s on all committed, usable datasets: features → freeze → audit → train → evaluate → export
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' http://127.0.0.1:37211/api/v1/training/runs
# promote through the registry (it refuses illegal jumps), then run in shadow and compare with the baseline
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"shadow","reason":"review"}' http://127.0.0.1:37211/api/v1/models/<id>/promote
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37211/api/v1/models/<id>/shadow
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:37211/api/v1/models/shadow
```

Worker CLI directly (`pnpm worker <command> …` runs `python -m mf_common.cli` with the worker packages on the path; set `MATCHFRAME_PYTHON` or create `workers/.venv`):

```sh
pnpm worker extract --input demo.dem --dataset-root DATA --validate
pnpm worker build-features --dataset DATA/map=de_inferno/build=13926/demo=<sha16>
pnpm worker freeze-dataset --datasets DATA --out MODELS/frozen.json
pnpm worker audit-split --manifest MODELS/frozen.json
pnpm worker train --task contact_2s --dataset-manifest MODELS/frozen.json --out-dir MODELS
pnpm worker evaluate --model-dir MODELS/<id> --dataset-manifest MODELS/frozen.json --split test
pnpm worker export-model --model-dir MODELS/<id> --out MODELS/<id>/export
pnpm worker promote --models-dir MODELS --model-id <id> --to shadow --reason "first review"
pnpm worker benchmark --inputs DEMOS --dataset-root DATA --with-features --out bench.json
pnpm worker estimate --benchmark-json bench.json --maps 9 --demos-per-map 3000 --budget-gb 2000
```

## 5. Evaluation

`evaluate` reports, overall and per map, AUC, Brier score, log loss, 10-bin calibration and expected calibration error for the model and for a Platt-calibrated distance/facing heuristic baseline, with **match-level (cluster) bootstrap** confidence intervals (refused when fewer than 2 matches). Splits are by complete match: sha256 de-duplication, related demos (same map, ≥ 60 % shared roster) grouped, newest game build → test (the build number is the only time proxy in demos). `audit-split` fails on any duplicate or related-match leakage across splits.

## 6. Promotion, shadow and rollback

Registry statuses: `experimental → shadow → candidate → approved`; `approved → rolled_back`; any → `retired`; `approved` additionally requires a test-split evaluation. The engine:

- loads a model for shadow only if its registry status is `shadow`, `candidate` or `approved`, its card requires only `gsi_compatible` data, its checksum matches the card, and its structure is supported (numeric splits, single output) — otherwise it is refused with the reason and the baseline continues (A44/A45);
- compares the model's 2 s contact probability with the baseline's for every live T × CT pair (4 Hz): mean absolute difference and agreement on the most likely pair (`GET /api/v1/models/shadow`);
- never lets a model command the observer. Using an approved model to influence shot ranking is **planned** and will need release gates beyond a demo count (shadow agreement, operator review, per-map/type/region results).

## 7. Training programme status

| Step (spec) | Status |
|---|---|
| Pipeline readiness (import, validation, lineage, retention, quotas, features, splits, training, evaluation, export, registry, local inference) | **implemented and tested** on 5 real 2023 demos and in the engine integration test |
| First 1,000 demos per map | **blocked — corpus not supplied**. The pipeline accepts it; measured cost: ~6 s/demo single worker, p95 465 GB on disk for 9 × 1,000 (see report §6) |
| 1–2 week beta | not started (depends on the corpus and a real CS2 environment) |
| +1,000–2,000 demos per map | not started |

No model has been approved, and the only trained model is a pipeline proof (see the model card).
