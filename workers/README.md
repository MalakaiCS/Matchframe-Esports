# Matchframe workers (Python offline pipeline)

Offline data pipeline for Matchframe Esports: CS2 demo import → committed Parquet datasets →
validation → map packs, measured utility profiles, causal features/labels → frozen splits →
LightGBM baseline, evaluation, export and a file-based model registry.

The TypeScript engine owns job state (`packages/contracts/src/jobs.ts`); these workers perform the
work steps and report JSON. **The Python side never deletes raw demos** — retention is the engine's
job (it calls `verify` first).

```
workers/
  pyproject.toml          setuptools; packages found in common/ demo-parser/ features/ training/ evaluation/
  common/mf_common/       CLI entry, JSON-lines protocol, atomic IO, dataset discovery
  demo-parser/mf_demo_parser/   ParserAdapter + Demoparser2Adapter, extract, validate, benchmark/estimate
  features/mf_features/   map packs, utility profiles, causal features + labels, leakage check
  training/mf_training/   freeze/audit splits, train, export, registry, synthetic parity fixture
  evaluation/mf_evaluation/     metrics, calibration, match-level bootstrap, evaluate
  tests/                  pytest (synthetic unit tests + opt-in real-demo integration tests)
```

## Install / run

Requires Python ≥ 3.11 (developed and verified on 3.13) with `demoparser2`, `polars`, `pyarrow`,
`duckdb`, `lightgbm`, `numpy`, `pandas` (tests also use `pytest` and `scikit-learn`).

Run from the source tree (verified):

```sh
export PYTHONPATH=workers/common:workers/demo-parser:workers/features:workers/training:workers/evaluation
python -m mf_common.cli --help
```

Build a wheel (verified; provides the `matchframe-workers` console script, same commands):

```sh
python -m pip wheel --no-deps -w dist ./workers
python -m pip install --no-deps --target /path/to/site dist/matchframe_workers-0.1.0-py3-none-any.whl
```

## Protocol (for the TypeScript engine)

Every command prints JSON lines to stdout: zero or more `{"type":"progress",...}` /
`{"type":"warning",...}` lines, then exactly one `{"type":"result",...}` or
`{"type":"error","code":...,"message":...,"details":{...}}`. NaN/Infinity never appear (null).

| exit | meaning |
|---|---|
| 0 | success |
| 1 | error (`error` line; codes below) |
| 2 | invalid command line |
| 3 | command completed but the verdict is negative (`validate` → quarantine, `verify` mismatch, `audit-split` leak, `check-leakage` failure, `validate-map-pack` invalid, refused `promote`) |

Error codes: `INPUT_NOT_FOUND`, `INPUT_UNREADABLE`, `UNSUPPORTED_FORMAT`, `PARSER_FAILED`,
`EMPTY_PARSE`, `DATASET_CONFLICT`, `DATASET_NOT_FOUND`, `DATASET_INVALID`, `FEATURES_MISSING`,
`LEAKAGE_DETECTED`, `INSUFFICIENT_DATA`, `MODEL_NOT_FOUND`, `PROMOTION_REFUSED`,
`SCHEMA_INVALID`, `INTERNAL`.

## Commands (all verified on the 5-demo test corpus)

```sh
# pre-flight
python -m mf_common.cli hash    --input demo.dem
python -m mf_common.cli inspect --input demo.dem

# import (atomic; duplicate-safe by sha256); --validate also runs validate after commit
python -m mf_common.cli extract  --input demo.dem --dataset-root DATA [--sample-hz 16] [--event-window-s 2] [--validate]
python -m mf_common.cli validate --dataset DATA/map=de_inferno/build=13926/demo=<sha16> [--expected-map de_inferno]
python -m mf_common.cli verify   --dataset DATA/map=de_inferno/build=13926/demo=<sha16>

# cost measurement and capacity forecast
python -m mf_common.cli benchmark --inputs DEMO_DIR --dataset-root DATA --with-features --out bench.json
python -m mf_common.cli estimate  --benchmark-json bench.json --maps 9 --demos-per-map 3000 --budget-gb 2000

# derived assets
python -m mf_common.cli build-map-pack --datasets DATA --map de_inferno \
    --out assets/map-packs/de_inferno.json --graph-out assets/map-packs/de_inferno.graph.json
python -m mf_common.cli validate-map-pack --file assets/map-packs/de_inferno.json
python -m mf_common.cli measure-utility --datasets DATA --out assets/utility-profiles/measured.json

# features / labels (per dataset) and the standalone leakage check
python -m mf_common.cli build-features --dataset DATA/map=.../demo=<sha16> [--force]
python -m mf_common.cli check-leakage  --dataset DATA/map=.../demo=<sha16>

# splits, training, evaluation, export, registry
python -m mf_common.cli freeze-dataset --datasets DATA --out MODELS/frozen.json
python -m mf_common.cli audit-split    --manifest MODELS/frozen.json
python -m mf_common.cli train          --task contact_2s --dataset-manifest MODELS/frozen.json --out-dir MODELS
python -m mf_common.cli evaluate       --model-dir MODELS/<model_id> --dataset-manifest MODELS/frozen.json --split test
python -m mf_common.cli export-model   --model-dir MODELS/<model_id> --out EXPORT_DIR
python -m mf_common.cli promote        --models-dir MODELS --model-id <model_id> --to shadow --reason "..."
python -m mf_common.cli registry       --models-dir MODELS
python -m mf_common.cli make-parity-fixture --out fixtures/models/contact_2s_parity
```

Datasets that are not `usable` (validation verdict) are skipped by map packs, utility profiles
and `freeze-dataset` (`--allow-unvalidated` admits datasets that have no verdict yet; quarantined
datasets are never used).

## Dataset layout

`DATA/map=<map>/build=<build>/demo=<sha256[:16]>/` — written to `DATA/.staging/<id>` first and
published with a single atomic `rename`; an existing directory with a COMMITTED manifest for the
same sha256 is reported as `duplicate`. Parquet tables are zstd-compressed.

| file | content |
|---|---|
| `rounds` | round attempts: start / freeze-end / end / official-end ticks with evidence, winner, reason, warm-up, flags |
| `players` | one row per (round, player): `player_id` (SteamID string, `bot:<hash>` for bots), team, side |
| `ticks` | sampled player state: uniform grid at `--sample-hz` (as-of selection, never looking ahead) ∪ all recorded frames within ±`--event-window-s` of deaths/throws/activations; `in_grid`, `in_event_window`, `sampling_policy`, `dt`, `frame_dt`, causal backward-difference velocity |
| `events` | deaths, hurt, blind, weapon_fire, bomb, round, grenade lifecycle events; `user_id`/`attacker_id` with `*_evidence` (`event` or `counter_delta`) |
| `attributions` | damage/kill attributions derived from per-frame counter deltas (`attributed`/`ambiguous`/`unattributed`) |
| `team_scores` | team score change points (used for result reconciliation) |
| `grenades` | one row per thrown projectile: resolved `type` + `type_evidence` + `type_confidence` + `candidate_types`, owner, team, throw/activation/expire, affected players only with exact event support, decimated trajectory list columns |
| `grenade_samples` | every recorded projectile sample (for physics fits) |
| `qa.json`, `manifest.json` | QA/compatibility report; provenance, parser + version, settings, per-file sha256 + rows, `status: COMMITTED` |
| `validation.json` | written by `validate` (verdict `usable`/`quarantine`, reasons, flags, per-check results) |
| `features.parquet`, `labels.parquet`, `utility_labels.parquet`, `features_manifest.json` | written by `build-features` |

## Key design decisions

* **Tick rate** is derived from the `game_time`/tick slope (64 on all test demos); the recorded
  frame interval is measured separately (SourceTV 2023: every 3 ticks ≈ 21.3 Hz; POV: every tick).
* **Grenade types**: classes differ by build (`CBaseCSGrenadeProjectile` = HE or flash,
  `CMolotovProjectile` = molotov or incendiary on older builds). Evidence, strongest first: detonate
  event with the projectile entity id → `m_bIsIncGrenade` → `m_DmgRadius`/`m_flDamage` signature →
  tick-matched `weapon_fire`. Disagreeing strong evidence or no narrowing evidence → `unknown`.
  Held inventory entities (`CFlashbang`, `CHEGrenade`, …; no position) are excluded and counted.
* **Identity recovery**: several demos have no player ids on game events. Kills/damage are
  attributed from `kills_total`/`deaths_total` and the pawn's live `m_unTotalRoundDamageDealt`
  deltas (unique opposing candidate only); validated 41/41 against parser ids where both exist.
* **Validation** (`usable` | `quarantine`): manifest, checksums, Parquet readability, non-empty
  parse, expected map, round structure, identity continuity, timestamp ordering, map bounds,
  result reconciliation vs team scores, field coverage thresholds, causal features, DuckDB
  queries of opening/middle/closing rounds. Unusual-but-legit content only produces flags.
* **Causality**: features use only uniform-grid frames at or before the sample tick (event-window
  frames are excluded because their existence depends on future events); `max_input_tick` is
  stored and checked; `check-leakage` perturbs all frames after a cut and requires identical past
  features. Labels live in separate files and look into `(t, t+h]` only; unknown → null.
* **Splits**: unit = complete match; sha256 de-duplication; related demos (same map, ≥60 % shared
  roster) grouped; newest game build → test (build number is the only time proxy available).
* **Registry**: `experimental → shadow → candidate → approved`, `approved → rolled_back`,
  any → `retired`; `approved` requires a test-split `evaluation.json` with an AUC.

## Tests

```sh
python -m pytest workers/tests                                   # synthetic unit tests (real-demo tests skipped)
MF_TEST_DEMOS=/path/to/demos python -m pytest workers/tests      # also runs integration tests on real demos
```

Demos are never copied into the repository; integration tests extract into a pytest temp dir.
