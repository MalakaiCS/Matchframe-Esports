# Built-in radar images

Flat radar drawings of eight CS2 maps with their world-to-image calibration, used by every HUD's
minimap (the engine places players, the bomb and utility on them). Anubis has no image here and uses
Matchframe's generated outline (map pack) instead. An operator-calibrated image in a map pack
(Maps & Cameras) takes precedence over these.

- Source: [lexogrine/cs2-react-hud](https://github.com/lexogrine/cs2-react-hud), MIT licence
  (`LICENSE-lexogrine.txt`), commit `4ec8eea`, `src/HUD/Radar/LexoRadar/maps/<map>/radar.png` and
  `index.ts`. Lexogrine's later versions load radars from their own program instead.
- `radars.json`: per map, the 1024 x 1024 image and one or two layers. Image pixel =
  `origin + world * pxPerU`. Nuke and Vertigo draw both levels on one image; a player uses the layer
  whose `zMin <= z < zMax` (Nuke: z = -450, Vertigo: z = 11700).
- The calibrations agree with the game's overview files to within a few pixels (for example Dust II:
  origin x 563.1 vs pos_x 2476 / scale 4.4 = 562.7).
