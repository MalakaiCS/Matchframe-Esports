# Vector HUD

A broadcast HUD for CS2 in the Matchframe HUD Library: dark graphite glass panels with angled ends, thin team-colour stripes and condensed type, with each team's players down its own side of the screen.

What it shows:

- **Score bar** (top centre): team logos (or a monogram badge from the short name), names, series wins, timeouts left, scores, the round clock and round number. In **freeze time** the loss bonus hangs off both ends of the bar, the series maps sit under it (picks, decider, finished scores, the live map) and each team's grenades and equipment value sit above its players.
- **Players** down the left and right edges: avatar (or initial), observer slot, health and armour, name, main weapon, money, kills and deaths, grenades, bomb, defuse kit and kills this round, with a health bar whose damage trail follows a moment later. A dead player's card collapses to a narrow, darker card with name, money and K/D. The observed player's card steps out from the edge.
- **Observed player** (bottom centre): avatar, health, team and name on a team-colour health bar, weapon and ammunition, K/A/D, ADR, grenades and armour.
- **Players alive** and the **killfeed** (top right). Kills stay seven seconds.
- **Bomb bar** under the score bar once the bomb is planted: the seconds left and a bar that drains to the middle; in the CT colour with "bomb being defused" while it is defused.
- **Round winner** card under the score bar until the next freeze time.
- **Radar** (top left) from Matchframe's map data, hidden when no trustworthy calibration exists.
- The **SIMULATION** label while test data runs and **DATA PAUSED** when game data stops arriving.

Motion follows the game: going live flips the clock, tucks the loss bonus into the bar, wipes the series away and slides the players-alive box in; a kill collapses the victim's card and then slides the kill in; a planted bomb swaps the clock for the bomb and drops the bar in; the round winner's card fades in when the round ends. Everything animates with transform, opacity and clip-path only, and only the clocks update ten times a second.

Change it in the HUD Library under **Appearance**: CT and T colours (a team's own colour wins), full team names or tags, and which elements show (radar, killfeed, observed player, players alive, player money, the freeze-time loss bonus, series and utility). Variants: **live** (everything) and **compact** (no radar and no freeze-time extras).

## Build your own from it

The source is in the Matchframe repository at `apps/hud-designs/src/vector` (React, TypeScript, plain CSS, Vite), with the parts shared by Matchframe's HUD designs in `apps/hud-designs/src/shared`:

```
pnpm install
pnpm --filter @matchframe/hud-designs dev:vector    # http://localhost:5176/?demo=cycle plays every scene
cd apps/hud-designs && pnpm exec vite build --mode vector && node scripts/finish-packages.mjs vector
```

`?demo=<scene>` shows one sample state (`freeze`, `live`, `kill`, `bomb`, `defuse`, `over`); `?demo=cycle&every=3000` plays them in turn. The package is written to `apps/hud-designs/dist/vector`. Set your own `id`, `name` and `version` in `package-files/vector/manifest.json`, build, then use **Import HUD Folder** on the built folder (or zip it and use **Import HUD ZIP**).

Rules every HUD package follows: transparent `html` and `body` backgrounds; the page reads `output`, `variant` and `t` from its query string and opens the read-only `/overlay-ws` socket; settings arrive in `state.settings` with every snapshot; a visible label while `state.simulated` is true; only static files.

## Licences and credits

- Code: MIT, Matchframe.
- Barlow Condensed and Inter fonts: SIL Open Font License 1.1 (`OFL-fonts.txt`).
- The weapon silhouettes come with Lexogrine's CS2 HUD template (MIT, `LICENSE-lexogrine.txt`) and originate from Counter-Strike 2 game files (© Valve Corporation). Lexogrine's MIT licence covers the code, not Valve's artwork. Broadcast HUDs for Counter-Strike commonly use these icons; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons. The grenade, bomb, kit, armour and killfeed glyphs are original Matchframe shapes. Matchframe Esports is not affiliated with or endorsed by Valve.
