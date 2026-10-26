# Acceptance scenarios A01–A66 — status

Status words: **pass (real)** = passed against the real system; **pass (fixture)** = passed with synthetic GSI, simulated observer, stubs or real demos where noted; **partial** = some of the expected behaviour is shown, the rest is listed; **blocked** = needs an environment or input that was not available; **planned** = not built.

Environment for every run below: Ubuntu 24.04.5 container, Node 22.22.0, Python 3.13.17, OBS 30.0.2 (Linux, headless) for OBS rows, five public 2023 CS2 demos for demo rows. **No CS2 client, no Windows machine, no replay tool and no MatchFrame service were available**, so no scenario that needs them can pass "real" yet.

Test files: `packages/cs2-state/test/reconciler.test.ts` (R), `packages/cs2-state/test/utility-tracker.test.ts` (U), `packages/director-policy/test/director.test.ts` (D), `packages/director-policy/test/real-geometry.test.ts` (G), `packages/director-policy/test/arbiter.test.ts` (C), `packages/map-runtime/test/runtime.test.ts` (M), `services/local-engine/test/engine.e2e.test.ts` (E, real HTTP/WS servers), `services/local-engine/test/demo-pipeline.integration.test.ts` (P, real demos + Python workers), `services/local-engine/test/demo-library.test.ts` (L), `services/local-engine/test/domain.test.ts` (O), `services/observer-agent/test/*` (K), `services/replay-agent/test/*` (Y), `packages/obs-adapter/test/obs.integration.test.ts` (B, real OBS), `packages/automation/test/*` (T), `workers/tests` (W, pytest).

| ID | Scenario | Status | Evidence / what is missing |
|---|---|---|---|
| A01 | Fresh Windows installation | **pass (Windows CI runner)** | The `Windows program (.exe)` workflow builds the unsigned NSIS installer on `windows-latest`, installs it silently per user, starts the installed program and checks the bundled engine, the console (from `app://matchframe`), API forwarding, the live connection, the HUD output and that the engine serves no console to browsers, then uninstalls (run 40408121752). Not yet repeated on a production Windows 10/11 desktop with CS2 and OBS. |
| A02 | Real CS2 observer payload | partial | E: token-authenticated GSI over real HTTP, bad tokens rejected, token absent from state/HUD/audit/logs/support bundle — with synthetic payloads. Real payload blocked (no CS2). |
| A03 | Real live HUD | blocked | Needs real CS2. HUD tracks simulated state (E, screenshots). |
| A04 | Team side switch | pass (fixture) | R: halftime side swap keeps team identity by roster. Logos/cameras follow team identity (projection); camera routing by player identity (E). |
| A05 | Pause/resume | pass (fixture) | R: match clock freezes while paused; countdowns do not advance during pause or staleness. |
| A06 | Warmup/halftime/overtime | partial | Phases mapped; series/overtime rules (O: tied/unfinished map never advances). No dedicated overtime HUD test. |
| A07 | Round restart/restore | pass (fixture) | R: new epoch + round attempt, no duplicated results; C: stale-epoch commands cancelled. |
| A08 | Out-of-order/duplicate input | pass (fixture) | R: duplicates rejected without duplicate events; older packets rejected. |
| A09 | GSI disconnect | pass (fixture) | R: source marked stale after silence; D: no commands on stale input; session forces manual on stale telemetry. |
| A10 | Missing exact kill events | pass (fixture) | R: killer/weapon/headshot never fabricated from counters; killfeed degraded mode. |
| A11 | Acknowledged player cut | partial | C: transport ack ≠ confirmation, observed feedback confirms; E: confirmed automatic cuts in labelled simulation. Real CS2 cut blocked. |
| A12 | Failed player cut | pass (fixture) | C: failure visible, one bounded retry, never falsely confirmed. |
| A13 | Human takes control | pass (fixture) | C: takeover cancels pending, automation stays disarmed; unexplained POV change treated as takeover. |
| A14 | Wrong desktop window focused | pass (fixture) | K: keyboard adapter sends nothing when the observer window is not focused (focus check mocked; real Windows unverified). |
| A15 | Two control clients compete | pass (fixture) | C: only the current owner/generation executes; expired lease reverts to local operator. |
| A16 | T group vs earlier CT push | pass (fixture) | D: imminent CT push outranks the grouped-T utility shot. |
| A17 | Wall-separated nearby players | pass (fixture) | D: floor/wall-separated pairs not treated as guaranteed fights (synthetic geometry). |
| A18 | Flashed/reloading player | pass (fixture) | D: fully flashed duelist ranked lower but not excluded; reloading lowers readiness (readiness.ts; covered indirectly). |
| A19 | Crossfire/trade sequence | partial | D: crossfire detected with reason codes. Trade-support grouping exists; no dedicated trade-sequence test. |
| A20 | Death or invalid POV | pass (fixture) | D: dead POV recovers immediately to a living POV. |
| A21 | Normal score jitter | pass (fixture) | D: ≤ 2 cuts over 60 jittered frames. |
| A22 | Bottom Banana positive | partial | D (synthetic geometry, validated synthetic camera): static utility shot planned; G (real demo-derived Inferno geometry): scenario raised, no validated camera → POV fallback. Real static shot blocked (no CS2, no validated camera). |
| A23 | Bottom Banana false positives | pass (fixture) | D + G: T mass alone, smoke/decoy, dispersed Ts, earlier fight elsewhere → no scenario/cinematic. |
| A24 | Other fight during cinematic | pass (fixture) | D: cinematic interrupted, exits to a POV. |
| A25 | Unverified static camera | pass (fixture) | D + G: unvalidated camera or unverified control → cinematic invalid, POV fallback marked. |
| A26 | Map revision changes | pass (fixture) | M: cameras/regions/radar from older revisions selectively invalidated. |
| A27 | Delayed observer operation | partial | Per-output delay buffers; delayed outputs show nothing until filled. A separate synchronized delayed observer is planned (F17). |
| A28 | Lookahead drift/seek | planned | Needs F17. |
| A29 | Replay from captured footage | pass (real OBS) | `services/local-engine/test/replay-obs.integration.test.ts` against OBS 30.0.2: replay-buffer capture → prepared → approved → played through an OBS media source (playback confirmed from OBS media status, program on the replay scene) → return live; Y: queue logic. Game footage was a colour source (no CS2). |
| A30 | Missing replay angle | partial | OBS provider reports program angle only, so no other angle is offered; not separately tested. |
| A31 | Historical replay HUD | partial | During REPLAY_PLAYING the HUD shows an intentionally clean replay frame; historical-state graphics not built. |
| A32 | Existing replay adapter failure | pass (fixture) | Y: failed provider leaves a visible failed item; bridge health failures reported without throwing. Real tool blocked. |
| A33 | OBS reconnect | partial | Adapter reconnects with backoff and resyncs; T: automation never replays events from before a reconnect. Not exercised by killing real OBS. |
| A34 | Camera source substitution | partial | Routing by stable player id with consent (E). Substitution under load not tested; no real camera sources. |
| A35 | Delayed player reaction | partial | Per-route delay alignment setting; not verified against real video. |
| A36 | Veto concurrent action | pass (fixture) | O: exactly one legal action commits under concurrent submissions. |
| A37 | HUD archive import attack | pass (fixture) | E: unsafe paths/scripts rejected. |
| A38 | HUD revision publication | pass (fixture) | E: drafts don't affect air until published; rollback works. |
| A39 | Partial/corrupt demo | pass (real demos) | P: garbage, 2 MB truncated and partial POV demo quarantined, never deletion-eligible. |
| A40 | Parser worker crash | pass (real demos) | P: dataset committed by a crashed attempt adopted once (single dataset dir); L: interrupted jobs requeued on restart. |
| A41 | Raw retention execution | pass (real demos) | P: only verified, in-root raw demos removed; tampered dataset keeps its raw file; L: outside-root files never deleted. |
| A42 | Storage quota exhausted | pass (fixture) | L: admission refuses with a visible reason, nothing processed or deleted. |
| A43 | Dataset split audit | pass (real demos) | W + P: match-level splits, related-match grouping, audit passes; unit tests prove leaks are caught. |
| A44 | Live-unavailable model feature | pass (real model) | P: card requiring `demo_rich` data refused; baseline continues. |
| A45 | Corrupt/incompatible model | pass (real model) | P: checksum mismatch refused; the validated model and the baseline keep running. |
| A46 | Training load during broadcast | partial | Training refused during a live broadcast unless overridden; demo processing pauses during live; workers run at below-normal priority. No load measurement. |
| A47 | Cloud outage | partial | No cloud dependency exists (local-first); MatchFrame bridge failures contained (tested). Cloud sync itself is planned. |
| A48 | Application restart | pass (fixture) | E: restart resumes manual/disarmed with data intact. |
| A49 | Unauthorized overlay client | pass (fixture) | E: overlay socket read-only, public projection only. |
| A50 | Full-match soak | partial | `pnpm soak --minutes 20` (simulated GSI + simulated observer, operator and overlay WebSocket clients attached, automatic mode): RSS 150 → 188 MB, flat (+0.2 MB) over the last 12 min; 75/75 automated cuts confirmed; p95 ingest 1.0 ms, evaluation 0.43 ms; decision log capped at 1,000; readable broadcast report. No real full match. |
| A51 | All six grenade types | partial | U: all six types tracked with scoped identity and per-type lifecycle; real demos resolve all six (report §4). Live GSI per-type support unverified. |
| A52 | Utility beyond named regions | pass (fixture) | U: tracking with no region and above the walkable area, both teams. |
| A53 | Multi-map validation | partial | Coverage matrix (docs/maps/MAP_UTILITY_COVERAGE.md): 4 real packs, 5 maps without packs; logic tests on several map names and real Inferno geometry. |
| A54 | Flash followed by entry | pass (fixture) | D: flash_entry opportunity, defender measured blind, entry duel shown. |
| A55 | Smoke execute/retake | pass (fixture) | D: smoke_execute story near deployment; smoke stays tracked afterwards. |
| A56 | Molotov vs incendiary | pass (fixture) | U: separated by thrower inventory delta, not team; fire area linked; ambiguity reported otherwise. |
| A57 | Decoy activation | pass (fixture) | U + D: tracked, never an automatic cut. |
| A58 | Multiple simultaneous utility areas | pass (fixture) | D: decisive fight shown, both utility opportunities kept. |
| A59 | Multi-floor/elevated utility | partial | M: levels separate events below/above a floor (synthetic). Real packs have one level; floor grid has stacked cells. |
| A60 | Flight outside navigation mesh | pass (fixture) | U: items above the walkable area keep being tracked. |
| A61 | Region without cinematic coverage | pass (fixture) | D + G: tracking continues, POV fallback. |
| A62 | Missing type-specific effect data | pass (fixture) | U: unknown/future types preserved without invented effects; sampler reports partial support. |
| A63 | Duplicate IDs, lost source, epoch reset | pass (fixture) | U: entity reuse → new item; source silence cleans up; epoch change clears persistent utility. |
| A64 | Prediction vs confirmation | partial | U: prediction kept separate from confirmation. Activation uncertainty uses measured profiles with floors; calibration against live data not measured. |
| A65 | Both-team utility and late-round use | pass (fixture) | D: CT HE on a post-plant T cluster handled by the generic engine. |
| A66 | Utility during delayed/replay output | partial | Delayed outputs read state (incl. utility) from the delay buffer; replay is a clean frame. Not separately tested. |

Summary (66 scenarios): 37 pass with fixtures, 4 pass on real demos, 2 pass with a real trained model, 1 passes against real OBS (A29), 1 passes on a Windows CI runner (A01), 19 partial, 1 blocked (A03), 1 planned (A28). **None has passed against a real CS2 client**, and Windows evidence is limited to installing and smoke-testing the program on a CI runner; every scenario that depends on CS2 or a production Windows desktop stays open until that environment is available.
