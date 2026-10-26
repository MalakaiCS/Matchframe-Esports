# Build progress

Last updated: 2026-10-26. Branch: `claude/inspiring-newton-it4omx`. For a resumed session: read this file, `docs/architecture/decisions.md`, `FEATURE_COVERAGE.md`, `docs/acceptance.md` and `docs/backlog.md`, then continue with "Next".

## Completed

**Phase 0 — feasibility (real checks).** node:sqlite under Node 22.22 and Electron 44.9.3; demoparser2 0.42.0 on five real 2023 CS2 demos (throughput, memory, coverage, grenade entity findings, capacity vs 2 TB — `docs/models/phase0-demo-pipeline-report.md`); OBS 30.0.2 over obs-websocket v5; bundled engine under the Electron runtime. Decision records: `docs/architecture/decisions.md`.

**Phases 1–3 — live slice, HUD, director.** Contracts; GSI ingest and reconciliation (epochs, round attempts, duplicates/out-of-order, pause-aware clock, derived events with evidence levels); universal utility tracker (6 types, both teams, whole map) using measured profiles with uncertainty floors; map runtime with four demo-derived packs; baseline-1 director (anticipation, readiness, interactions, utility opportunities incl. flash entries/smoke executes/volleys, Inferno Bottom Banana scenario on synthetic and real geometry, hysteresis, cinematic budget/interruption); control arbiter (single writer, generations, sticky takeover, emergency stop, confirmation from feedback); observer adapters (simulation; console and keyboard — unverified); local engine (SQLite with re-entrant transactions, REST/WS, roles, audit, overlays, delay buffers); built-in HUD (3 presets × 9 variants, standings/bracket panels, composer offsets); veto, series, sponsors, automation, program state machine, replays (playback confirmed from OBS), player cameras with consent, statistics, broadcast report, event packages, device actions/tally, stages/standings/brackets.

**Phases 4–5 — demos and learning.** Python workers (extract, validate, verify, map packs, utility profiles, causal features/labels, leakage checks, splits, LightGBM training, evaluation with match-level bootstrap, export, registry); engine Demo Library and Training Service over the worker CLI (quarantine causes, crash adoption, verified retention, below-normal worker priority); live contact-model runtime in shadow with rejection rules; TypeScript/LightGBM parity.

**Operator console.** `apps/operator-web`: 16 screens + captain page — top bar (SIMULATION, telemetry, director, OBS, program, ownership, resume countdown, EMERGENCY STOP, STOP AUTOMATION F8/Pause), Live Control (roster POV requests with transport vs confirmed feedback, number keys, hold/pin/follow/cinematic/return live, decision explanation), 12-step Setup checklist, Events, Teams & Players (CSV import), Matches & Veto (captain links), HUDs & Composer, Director, Maps & Cameras (getpos authoring, validation, coverage), Replays, Player Cameras, Studio & Rundown, Sponsors & Automation, Demo Library, Training & Evaluation, Devices & Integrations, Settings & Diagnostics. Screenshots: `docs/screenshots/operator/`.

**Desktop and packaging.** Hardened Electron shell with engine supervision; `pnpm smoke:desktop` passes on Linux (Xvfb); Windows installer and zip built (below).

**Documentation.** README, CAPABILITIES, COMPATIBILITY_MATRIX, FEATURE_COVERAGE, docs/acceptance.md, docs/backlog.md (backlog + risk register), architecture (overview, decisions, contracts, API routes, OpenAPI), operations, integrations, models (+ model card), maps coverage (generated table), security, storage, extensions (+ `examples/hud-minimal`), THIRD_PARTY_NOTICES, CHANGELOG.

## Checks (final run, this environment)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` (unit, fixture, e2e with real HTTP/WS servers, console tests) | 221 passed, 8 skipped (the opt-in real-integration files) |
| `pnpm test:py` without demos / with `MF_TEST_DEMOS` | 56 passed, 9 skipped / 65 passed |
| `pnpm test:integration` (real demos + Python workers; real OBS 30.0.2) | 8 passed: 4 demo-pipeline (import, quarantine, crash adoption, verified retention with tamper detection, training/evaluation/export, promotion refusal, shadow inference, model rejection), 1 engine replay flow on OBS, 3 OBS adapter |
| `pnpm build` | pass |
| `pnpm smoke:desktop` (Linux, Xvfb) | pass — supervised engine healthy, console loaded, hardened window settings confirmed, no page errors |
| `pnpm soak --minutes 20` (simulated) | RSS 150 → 188 MB, flat over the last 12 min; 75/75 automated cuts confirmed; p95 ingest 1.0 ms, evaluation 0.43 ms; logs capped |

Lesson recorded: the two OBS replay tests share one OBS replay buffer, so `test:integration` runs files sequentially (`--no-file-parallelism`).

## Packaging

`pnpm package:win` on Linux (Wine installed for the NSIS step) produced, unsigned:

| Artifact | Size | SHA-256 |
|---|---|---|
| `apps/desktop/release/MatchframeEsports-Setup-0.1.0.exe` (NSIS, per-user, choose directory) | 122 MB | `e4b3e4aa79c9808eb056866eb2c7eafc291c3eb03f4f05be8bd06a7ced79a3ab` |
| `apps/desktop/release/Matchframe Esports-0.1.0-win.zip` (portable) | 155 MB | `3149621b8a0ed610742deb781f7c041400d1c5bd3046a4030b4107e67b39bd95` |

Contents: Electron 44.9.3 app, bundled engine, operator console, HUD renderer, map packs, measured utility profiles, Python worker sources, THIRD_PARTY_NOTICES. Artifacts are not committed (rebuild with the same command; checksums change with any source change). **Not run on Windows**; a silent install under Wine exited with code 2 and Wine is not treated as evidence. No code-signing certificate was available.

## Known gaps in the console (from its review against the engine)

- HUD Composer: visibility, reduced motion and position offsets work on air; resize, new layers, bindings, per-variant layouts, undo and draft preview are not built.
- Player Cameras: routing works; remote intake/mixer has no engine support yet.
- Setup "demo playback" source: guidance only.
- OBS audio: no level metering (the engine does not expose it).

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

1. With a CS2 observer environment: run the Setup checklist (real payload → capability report; player-selection test; static-camera test), then `docs/operations/preflight.md`; record results in CAPABILITIES.md and docs/acceptance.md.
2. Capture and validate cameras (Bottom Banana first) with `getpos`; enable automatic cinematics per map only after the static-camera test passes on that map.
3. Build map packs for Mirage, Dust II, Nuke, Train and Vertigo from current-build demos; validate derived regions; author levels.
4. Windows: install the build, run OBS browser sources, the keyboard adapter and a real full-match soak; sign the release.
5. Start the 1,000-demos-per-map programme when the corpus arrives; keep models in shadow until release gates are met.
6. Open backlog items: F17 lookahead, the rest of F08 (layers/bindings), Companion module, predictions, cloud sync, remote camera intake.
