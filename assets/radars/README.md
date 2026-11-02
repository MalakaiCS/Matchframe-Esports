# Built-in radar images

Flat radar drawings of eight CS2 maps with their world-to-image calibration, used by every HUD's
minimap (the engine places players, the bomb and utility on them). Anubis has no image here and uses
MatchFrame's generated outline (map pack) instead. An operator-calibrated image in a map pack
(Maps & Cameras) takes precedence over these.

- Source: a third-party open-source CS2 HUD template, MIT licence
  (`third-party-licenses/radar-images-MIT.txt`); its provenance (project, commit, files) is in
  `THIRD_PARTY_NOTICES.md`.
- `radars.json`: per map, the 1024 x 1024 image and one or two layers. Image pixel =
  `origin + world * pxPerU`. Nuke and Vertigo draw both levels on one image; a player uses the layer
  whose `zMin <= z < zMax` (Nuke: z = -450, Vertigo: z = 11700).
- The calibrations agree with the game's overview files to within a few pixels (for example Dust II:
  origin x 563.1 vs pos_x 2476 / scale 4.4 = 562.7).
