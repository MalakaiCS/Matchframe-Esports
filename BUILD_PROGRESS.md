# Build progress

Last updated: 2026-10-26. Branch: `claude/inspiring-newton-it4omx`. For a resumed session: read this file, `docs/architecture/decisions.md`, `FEATURE_COVERAGE.md`, `docs/acceptance.md` and `docs/backlog.md`, then continue with "Next".

## Completed

**Phase 0 — feasibility (real checks).** node:sqlite under Node 22.22 and Electron 44.9.3; demoparser2 0.42.0 on 5 real 2023 CS2 demos (throughput, memory, coverage, grenade entity findings, capacity vs 2 TB — `docs/models/phase0-demo-pipeline-report.md`); OBS 30.0.2 over obs-websocket v5 (integration tests); bundled engine under the Electron runtime. Decision records: `docs/architecture/decisions.md`.

**Phases 1–3 — live slice, HUD, director.** Contracts; GSI ingest and reconciliation (epochs, round attempts, duplicates/out-of-order, pause-aware clock, derived events with evidence); universal utility tracker (6 types, both teams, whole map) using measured profiles; map runtime with four demo-derived packs; baseline-1 director (anticipation, readiness, interactions, utility opportunities, Bottom Banana scenario, hysteresis, cinematic budget/interruption); control arbiter (single writer, generations, sticky takeover, emergency stop, confirmation from feedback); observer adapters (simulation; console and keyboard — unverified); local engine (SQLite, REST/WS, roles, audit, overlays, delay buffers); built-in HUD (3 presets × 9 variants + standings/bracket panels); veto, series, sponsors, automation, program state machine, replays, player cameras, statistics, broadcast report, event packages, device actions/tally, stages/standings/brackets.

**Phases 4–5 — demos and learning.** Python workers (extract, validate, verify, map packs, utility profiles, causal features/labels, leakage checks, splits, LightGBM training, evaluation with match-level bootstrap, export, registry); engine Demo Library and Training Service over the worker CLI; live contact-model runtime in shadow; TypeScript/LightGBM parity.

**Desktop and packaging.** Hardened Electron shell with engine supervision; Windows x64 build from Linux (see Packaging).

**Documentation.** README, CAPABILITIES, COMPATIBILITY_MATRIX, FEATURE_COVERAGE, acceptance status, backlog/risk register, architecture (overview, decisions, contracts, API routes, OpenAPI), operations, integrations, models, maps coverage, security, storage, extensions, THIRD_PARTY_NOTICES, CHANGELOG.

## Checks (latest run)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | see final section |
| `pnpm test:py` (no demos) | 56 passed, 9 skipped |
| Real-demo engine integration (`MF_TEST_DEMOS`, `MATCHFRAME_PYTHON`) | 4 passed (62 s) |
| Real OBS integration (`MF_OBS_URL`) | 3 passed earlier this session against OBS 30.0.2 |

## Exact blockers

| Blocker | Blocks | Needed from the owner |
|---|---|---|
| No CS2 client / observer environment | real GSI ingest, POV cut and static-camera verification, real Bottom Banana shot, real HUD tracking (A02/A03/A11/A22 real parts), live/demo feature parity | an observer PC with CS2 and the allowed control setup (console launch option or keyboard) |
| No Windows machine | installer/app run, Windows OBS browser sources, keyboard adapter, safeStorage on Windows (A01) | a Windows 10/11 test machine |
| Replay tool API not available | replay tool adapter (F19/F20) | its source or integration documentation |
| MatchFrame service API not available | F33 bridge | API/assets documentation and credentials |
| Training corpus not supplied | 1,000/map programme, beta, model promotion | demo corpus (current builds) |
| Code-signing certificate | signed releases | certificate in the release environment |

## Next

1. With a CS2 observer environment: run the setup checklist (GSI capture → capability report; player-selection test; static-camera test), then the preflight in `docs/operations/preflight.md`; record results in CAPABILITIES.md and docs/acceptance.md.
2. Capture and validate cameras (Bottom Banana first) with `getpos`; enable automatic cinematics per map only after the static-camera test passes.
3. Build map packs for the five missing maps from current-build demos; validate derived regions; author levels.
4. Windows: install the build, run OBS browser sources, keyboard adapter and a full-match soak; sign the release.
5. Start the 1,000-demos-per-map programme when the corpus arrives; keep models in shadow until release gates are met.
6. Open backlog items: F17 lookahead, F08 visual composer, Companion module, predictions, cloud sync.
