# Backlog and risk register

Numbered work items in dependency order. Status: **done**, **open**, **blocked (input)**. "Input" names what the owner must supply. Progress narrative: BUILD_PROGRESS.md.

## Backlog

### Phase 0 — feasibility
| # | Item | Status |
|---|---|---|
| B001 | Monorepo, contracts, JSON Schema/OpenAPI generation | done |
| B002 | node:sqlite under Node and Electron runtime | done |
| B003 | Demo parser feasibility on real demos (demoparser2) | done (5 demos, 2023 builds) |
| B004 | OBS websocket feasibility | done (OBS 30.0.2 Linux) |
| B005 | Observer control mechanism on a real CS2 client (console `-netconport` vs keyboard) | **blocked (input: CS2 observer environment)** |
| B006 | Real GSI capture on the current CS2 build; confirm field names and per-type grenade data | **blocked (input: CS2 environment)** |
| B007 | Current-build SourceTV demos (20–50) through the pipeline | **blocked (input: demos)** |

### Phase 1–2 — live slice, HUD, administration
| # | Item | Status |
|---|---|---|
| B010 | GSI ingest, reconciliation, epochs, clock, derived events with evidence | done |
| B011 | Public/operator projections, delay buffers, overlay server | done |
| B012 | Built-in HUD (3 presets × 9 variants), HUD packages, outputs | done |
| B013 | Teams/players/events/matches/series/veto/sponsors/automation | done |
| B014 | Operator console | done (see BUILD_PROGRESS.md for screens) |
| B015 | Radar calibration images per map | open (needs operator-captured calibration) |
| B016 | Visual HUD Composer (drag-and-drop, bindings) | open |

### Phase 3 — director and cinematics
| # | Item | Status |
|---|---|---|
| B020 | Baseline director, control arbiter, modes, takeover | done |
| B021 | Universal utility tracker (6 types), opportunities, scenario rules | done |
| B022 | Bottom Banana scenario (logic, synthetic + real geometry) | done |
| B023 | Real POV cut verification via setup test | **blocked (B005)** |
| B024 | Static camera capture/validation on real maps; real Bottom Banana shot | **blocked (B005)** |
| B025 | Map packs for Mirage, Dust II, Nuke, Train, Vertigo; more demos per map; validate derived regions; author levels | open (input: demos) |

### Phase 4–5 — demos, storage, learning
| # | Item | Status |
|---|---|---|
| B030 | Demo library, validation, quarantine, retention, quotas, lineage | done |
| B031 | Features, labels, leakage checks, splits, training, evaluation, export, registry | done |
| B032 | Live inference in shadow; model rejection rules | done |
| B033 | Live/demo feature distribution parity check on real GSI recordings | **blocked (B006)** |
| B034 | First 1,000 demos per map; beta; +1,000–2,000 per map | **blocked (input: corpus)** |
| B035 | Shadow review UI with annotations; release gates for using an approved model in ranking | open |

### Phase 6 — replays, lookahead, cameras
| # | Item | Status |
|---|---|---|
| B040 | Replay queue, OBS replay buffer capture, playout, return live | done (verified with OBS 30.0.2) |
| B041 | Existing replay tool adapter | **blocked (input: tool API)** |
| B042 | Delayed-observer lookahead (F17): synchronized second client, offset measurement, drift/seek safety | open |
| B043 | Additional replay angles (F20) | open |
| B044 | Player camera routing | done; remote intake open |

### Phase 7–8 — production suite, collaboration, cloud, SDK
| # | Item | Status |
|---|---|---|
| B050 | Stages, standings, brackets, studio panels | done |
| B051 | Device action API + tally | done |
| B052 | Companion module / Stream Deck plugin | open |
| B053 | Win-probability or other predictions (calibrated, optional) | open |
| B054 | Accounts/organisations, cloud asset/preset sync, conflict handling | open |
| B055 | SDK guide + example HUD package | done (example game adapter open) |
| B056 | MatchFrame bridge against the real service | **blocked (input: service API)** |

### Phase 9 — release
| # | Item | Status |
|---|---|---|
| B060 | Windows packaging (portable zip, NSIS installer) | done (built from Linux, unsigned) |
| B061 | Run the installer, app and OBS browser sources on Windows; keyboard adapter on Windows | **blocked (input: Windows machine)** |
| B062 | Code signing and update channel | **blocked (input: certificate / release environment)** |
| B063 | Reference-machine performance report and real full-match soak | **blocked (B005/B006)**; simulated soak done |

## Risk register

| # | Risk | Likelihood | Impact | Mitigation / status |
|---|---|---|---|---|
| R1 | No supported, authorized observer control channel works on the target CS2 build | medium | high (no automatic cuts/cinematics) | Two candidate adapters behind one interface; advisory/assisted modes useful without control; setup tests gate automation; no memory reading or injection |
| R2 | GSI fields or grenade representation differ on the current build | medium | medium | Absent/empty/null distinguished; capability sampler reports what arrives; unknown types preserved |
| R3 | Demo entity classes/properties change by build | high (already seen 13914→14000) | medium | Evidence-ranked type resolution; `unknown` instead of guessing; validation quarantines partial data |
| R4 | `node:sqlite` API changes (experimental) | low | medium | Repository layer isolates it; migrations with backups |
| R5 | Windows-specific behaviour (paths, atomic rename, SendInput focus, safeStorage) untested | medium | medium | Platform code isolated; B061 |
| R6 | Training corpus not supplied or unrepresentative | high | medium | Pipeline ready and measured; models stay in shadow until release gates are met |
| R7 | Replay tool / MatchFrame APIs differ from the documented bridges | high | low–medium | Thin shims on the tool side; OBS replay buffer fallback; failures contained |
| R8 | Live performance on the broadcast PC | low | high | p95 ingest ≈ 1.5 ms, eval ≈ 0.9 ms in simulation; workers at below-normal priority; demo processing pauses during live |
| R9 | Unsigned builds blocked by SmartScreen/AV | medium | low | Document unsigned dev builds; sign in the release environment (B062) |
| R10 | Licence contamination from reference products | low | high | No LHM code/assets/account; GPL projects used only as documentation (THIRD_PARTY_NOTICES.md) |
| R11 | Overconfident utility predictions from small measured samples | medium | medium | Measured SDs floored (100 ms / 250 ms); prediction never promoted to confirmation |
| R12 | Storage growth beyond the 2 TB plan | low | medium | Measured estimate (p95 465 GB / 812 GB for 9k / 27k demos); quotas and admission control; raw retention as queue + curated sample |
