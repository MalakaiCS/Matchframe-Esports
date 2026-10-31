# Lineup HUD

A broadcast HUD for CS2 with all ten players in one row along the bottom, built for the Matchframe HUD Library on Matchframe's public HUD state.

What it shows:

- **Top left:** a dark title bar (the title from the settings, else the event's name) with the series maps as tabs under it: the live map white, each with who picked it (or DECIDER) and the score of maps already played. The radar sits under the tabs with no panel behind it.
- **Score bar (top centre):** a near-black bar with each team's colour fading in from its end, big scores, a colon divider, team logos (the short name as a wordmark in the team colour when a team has none), and the round clock with ROUND n/24 under it.
- **Bomb:** the clock cross-fades to the bomb glyph and a red bar slides down under the score bar and drains with the 40 s fuse. A panel under it names who is planting (the bomb carrier) or the team defusing, with a countdown.
- **Round won:** the score ticks, a dark panel tinted in the winner's colour grows out of the centre over the whole bar, the winner's logo comes in, and it folds back into the centre when freeze time starts.
- **Top right:** a sponsor box (the sponsor scheduled for the scoreboard slot or top bar, else the sponsor text from the settings) with a square logo tile, and the killfeed under it: killer, assister, weapon, headshot and victim in their team colours. Kills slide in from the right just after the victim's card goes dark and fade after about 7 seconds.
- **Players:** five cards from each edge, the right team mirrored. The photo (a neutral silhouette when there is none) stands on the card; the card's upper body is the team colour filled to the player's health, with the name and the health number (it counts down when hit, with a light damage trail). Under it a K/D band in the team colour and the money (green from $3,700), then grenades and weapon (the equipment value in freeze time). Armour, round kills and the bomb or defuse kit sit on the card. Dead cards lose their colour, the photo gives way to a skull and the row shows the round's kills.
- **Middle:** the observed player's photo on a navy strip with health and armour, name and ammunition; it rises in once the round is live and slides across when the observed player changes. In freeze time the middle shows both teams' equipment value, team money, loss bonus and grenades.
- **Labels:** SIMULATION while test data is running, DATA PAUSED when game data stops arriving, REPLAY while a replay is on air.

Change it in the HUD Library under **Appearance**: CT and T colours (teams with their own colour keep it), the title above the series, the sponsor text, and whether the radar, killfeed, observed player, series tabs and player money show. Variants: **live** (everything) and **compact** (score bar, killfeed and observed player).

Motion runs on `transform`, `opacity` and `clip-path` only, with no blur or backdrop filters, so it stays smooth in an OBS browser source. Only the round clock and the bomb timers update ten times a second; player cards re-render only when what they show changes.

## Build or change it

The source is in the Matchframe repository at `apps/hud-designs/src/lineup` (React, TypeScript, plain CSS, Vite):

```
pnpm install
pnpm --filter @matchframe/hud-designs dev:lineup     # http://localhost:5177/?demo=cycle plays every scene
cd apps/hud-designs
pnpm exec vite build --mode lineup && node scripts/finish-packages.mjs lineup    # writes dist/lineup
```

`?demo=<scene>` shows one sample state (`freeze`, `live`, `kill`, `bomb`, `defuse`, `over`); `?demo=cycle&every=3000` plays them in turn. `node scripts/shots.mjs lineup <dir>` screenshots every scene, and `--frames <a>,<b> <ms> <count>` records the change from one scene to the next. To make your own HUD from it, set your own `id`, `name` and `version` in `package-files/lineup/manifest.json`, build, then use **Import HUD Folder** on `dist/lineup` (or zip it and use **Import HUD ZIP**).

Rules every HUD package follows: transparent `html` and `body` backgrounds; the page reads `output`, `variant` and `t` from its query string and opens the read-only `/overlay-ws` socket; settings arrive in `state.settings` with every snapshot; a visible label while `state.simulated` is true; only static files.

## Licences and credits

- Code: MIT, Matchframe.
- Barlow Condensed and Inter fonts: SIL Open Font License 1.1 (`OFL-fonts.txt`).
- Bomb, kit, armour and status glyphs are original Matchframe shapes. The weapon and grenade silhouettes come with Lexogrine's CS2 HUD template (MIT, `LICENSE-lexogrine.txt`) and originate from Counter-Strike 2 game files (© Valve Corporation). Lexogrine's licence covers the code, not Valve's artwork; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons. Matchframe Esports is not affiliated with or endorsed by Valve.
- The layout and motion follow common broadcast HUD practice; the artwork (glyphs, player silhouette, wordmarks) is Matchframe's own, with no third-party HUD artwork, logos or text.
