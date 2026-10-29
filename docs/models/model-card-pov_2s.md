# Model card: `pov_2s` (built in)

**What it predicts.** For a living player at a moment in a live round: the chance their POV shows a kill within the next 2 s (they kill or die). One probability per player.

**How it is used.** The Auto Director blends it into its imminence score: `0.5 · baseline + 0.5 · min(1, p / 0.5)`. It never picks a shot by itself. It is on by default, and Training → What the demos teach switches it off or replaces it with a model trained on your demos.

**Training data.**

| | |
|---|---|
| Source | 7 professional CS2 matches on game build 14191 (Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke) |
| Size | 1,314,096 player frames at 16 Hz in live rounds; 51,902 positives (3.9 %) |
| Hold-out | none: the shipped model used all 7 matches |
| Demo files | not distributed |

**Features.** 19, all available from a spectator's live game data (`docs/models/README.md` §8).

**Model.** LightGBM binary:
- 200 rounds, 15 leaves, at least 200 rows per leaf;
- learning rate 0.05, seed 7;
- exported as a JSON dump with 64 parity vectors (TypeScript matches LightGBM within 1e-9).

**Evaluation.** Each match was held out in turn and scored by a model trained on the other six, with the same recipe.

| Held-out map | Model AUC | Distance/facing heuristic AUC |
|---|---|---|
| Ancient | 0.946 | 0.888 |
| Anubis | 0.955 | 0.894 |
| Cache | 0.939 | 0.896 |
| Dust II | 0.948 | 0.877 |
| Inferno | 0.948 | 0.914 |
| Mirage | 0.922 | 0.842 |
| Nuke | 0.930 | 0.855 |
| **Mean** | **0.941** | **0.881** |

**Director test bench**, the same leave-one-match-out models replayed through the director (963 kills, 300 ms switch delay):

| Metric | Director without the model | With the model (0.5 / 0.5) | With the model + multi-frag awareness |
|---|---|---|---|
| Kills shown | 687 (71.3 %) | 715 (74.2 %) | 713 (74.0 %) |
| Opening kills shown | 96 / 141 | 102 / 141 | 102 / 141 |
| Multi-frags on the killer's POV | 80 / 178 | 88 / 178 | 95 / 178 |
| Cuts per minute | 6.05 | 5.48 | 5.41 |

**Live parity.** On Anubis replay frames, the live feature code matches the training features:
- correlation 1.000 for every feature except speed (0.973: position changes at the live rate against the demo's velocities);
- `round_kills` is exact.

**Limits.**
- 7 matches, one game build, top-level teams only.
- Not yet run on a live GSI feed in a real match.
- Maps outside the seven work with the same features but are unmeasured.
- Lower-level play may look different.
