# Vector HUD

A broadcast HUD for CS2 in the Matchframe HUD Library: solid team-colour panels on dark bases with rounded corners and heavy geometric type, with each team's players down its own side of the screen.

What it shows:

- **Score bar** (top centre): each team's logo (or a monogram badge from its short name) and score on a team-colour panel, the round clock and "ROUND 17/24" in a dark centre block, and each team's timeouts as a small outlined capsule at the ends. In **freeze time** the loss bonus sits in a team-colour pill outside each end, the series maps sit under the bar (picking team, decider, finished score, the live map) and each team's grenades sit in a bar above its players.
- **Players** down the left and right edges: photo on the outer side (a neutral silhouette when there is none), a team-colour band with name, armour and health whose length is the health (a lighter damage trail follows a moment later), kills and deaths, money, kills this round, main weapon, grenades, bomb and defuse kit. A dead player's card turns grey and narrows to name, K/D and money. The observed player's card is outlined.
- **Observed player** (bottom centre): photo standing above the box, health and armour, ammunition, the name on a team-colour health bar.
- **Players alive** ("3 VS 2", top right) and the **killfeed** under it. Kills stay seven seconds.
- **Bomb**: the clock turns into the bomb on a T-colour centre and a bar with the seconds left drops in under the score bar and drains; while the bomb is defused the centre turns CT colour and a second bar names the defending team. A defused bomb ends the round on a green centre.
- **Round winner** card, in the winning team's colour, under the score bar until the next freeze time.
- **Radar** (top left) from Matchframe's map data, hidden when no trustworthy calibration exists.
- The **SIMULATION** label while test data runs and **DATA PAUSED** when game data stops arriving.

Motion follows the game: going live flips the clock, tucks the loss bonus into the bar, wipes the series away and slides the players-alive box in; a kill collapses the victim's card and then slides the kill in; a planted bomb swaps the clock for the bomb and drops the bar in; the winner's card fades in when the round ends. Everything animates with transform, opacity and clip-path only, and only the clocks update ten times a second.

Change it in the HUD Library under **Appearance**: CT and T colours (a team's own colour wins), full team names or tags on the winner card and defuse bar, and which elements show (radar, killfeed, observed player, players alive, player money, the freeze-time loss bonus, series and utility). Variants: **live** (everything) and **compact** (no radar and no freeze-time extras).

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
- Montserrat font: SIL Open Font License 1.1 (`OFL-Montserrat.txt`). Barlow Condensed and Inter: SIL Open Font License 1.1 (`OFL-fonts.txt`).
- The weapon silhouettes come with Lexogrine's CS2 HUD template (MIT, `LICENSE-lexogrine.txt`) and originate from Counter-Strike 2 game files (© Valve Corporation). Lexogrine's MIT licence covers the code, not Valve's artwork. Broadcast HUDs for Counter-Strike commonly use these icons; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons. The grenade, bomb, kit, armour, killfeed and player-silhouette glyphs are original Matchframe shapes. Matchframe Esports is not affiliated with or endorsed by Valve.
