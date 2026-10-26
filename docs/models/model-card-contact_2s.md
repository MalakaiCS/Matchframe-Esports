# Model card — `contact_2s` (pipeline proof)

| Field | Value |
|---|---|
| Task | Probability that a T × CT pair has an attributed damage or kill interaction within the next 2 s (`contact_2s` label, docs/models/README.md §3) |
| Intended use | Shadow comparison against the baseline director's contact estimate; research. **Not** for directing a broadcast. |
| Status | `experimental` → `shadow` in the Phase 0 run; never `approved` |
| Model | LightGBM 4.7.0 binary, 113 trees (early stopping on validation), seed 7 |
| Inputs | 19 `gsi_compatible` features (docs/models/README.md §2); required capability `gsi_compatible` |
| Training data | 2 matches: de_anubis (build 13914), de_overpass 2v2 (build 13914); 227,814 pair rows, 8,151 positives |
| Validation | 1 match: de_ancient (13916); AUC 0.9675 (heuristic 0.9483), Brier 0.02170 (heuristic 0.02585) |
| Test (held out, newest build) | 1 match: de_inferno (13926); AUC 0.9406 (heuristic 0.9147), Brier 0.02620 (heuristic 0.02702, prevalence-only 0.03037); ECE 0.0177 (heuristic 0.0126) |
| Confidence intervals | none — the test split holds one match and the match-level bootstrap needs ≥ 2 |
| Calibration | poor in upper bins (predicted 0.549 → observed 0.312 in the 0.5–0.6 bin) |
| Export | `dump_model()` JSON + card + 64 parity vectors; TypeScript evaluator matches LightGBM within 1e-9 (synthetic parity fixture, `fixtures/models/contact_2s_parity/`) |
| Live behaviour | runs in shadow in the engine (integration test); refused if its card asks for `demo_rich` features or its checksum does not match |
| Known limitations | 4 matches on 4 maps (one 2v2), 2023 builds only; high AUC mostly reflects that close, facing pairs are about to fight; labels depend on counter-delta attribution in event-less demos (cross-checked on 41 kills in one demo); live/demo feature parity not measured |
| Ethical / data notes | trained on a public MIT test corpus; demos, player names and SteamIDs are not committed; the committed fixture is synthetic |

Reproduce: docs/models/phase0-demo-pipeline-report.md §12.
