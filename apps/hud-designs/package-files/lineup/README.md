# Lineup HUD

A broadcast HUD for CS2 with all ten players in one row along the bottom, built for the Matchframe HUD Library on Matchframe's public HUD state.

What it shows:

- **Top left:** an event title line with the best-of and series score, the series panel (each map with its score, who picked it, the live map highlighted and the decider marked) and the radar under it.
- **Score bar (top centre):** a dark capsule with each team's colour on its end cap, scores, logos (a monogram badge when a team has none), series pips, the round clock and round number.
- **Bomb:** the clock cross-fades to the bomb glyph and site, a bar slides down under the score bar and drains with the 40 s fuse; it turns to the CT colour while the bomb is being defused.
- **Round won:** the score ticks, a panel in the winner's colour grows out of the centre of the score bar over the whole bar, the winner's badge and name come in with the round and how it was won; it folds back into the centre when freeze time starts.
- **Top right:** a sponsor slot (the sponsor scheduled for the scoreboard slot or top bar, else the sponsor text from the settings) and the killfeed under it. Kills slide in from the right just after the victim's card goes dark and fade after about 7 seconds.
- **Players:** five cards from each edge with portrait (initials when there is no avatar), health that counts down when hit with a damage trail on the bar, armour, name, K/D, money, then the equipment value in freeze time, weapon and grenades once live, and the round's kills when dead (dead cards go grey and drop down). The observed player's card lifts with a team-colour outline.
- **Middle:** the observed player (health, armour, K/A/D, ADR when validated, money, weapon and ammunition, grenades, kit, bomb) rises in once the round is live and slides across when the observed player changes. In freeze time the middle shows both teams' equipment value, team money, loss bonus and grenades.
- **Labels:** SIMULATION while test data is running, DATA PAUSED when game data stops arriving, REPLAY while a replay is on air.

Change it in the HUD Library under **Appearance**: CT and T colours (teams with their own colour keep it), the title above the series (the event's name when empty), the sponsor slot text, and whether the radar, killfeed, observed player, series panel and player money show. Variants: **live** (everything) and **compact** (score bar, killfeed and observed player).

Motion runs on `transform`, `opacity` and `clip-path` only, with no blur or backdrop filters, so it stays smooth in an OBS browser source. Only the round clock and the bomb bar update ten times a second; player cards re-render only when what they show changes.

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
- Inter and Barlow Condensed fonts: SIL Open Font License 1.1 (`OFL-fonts.txt`).
- Grenade, bomb, kit and status glyphs are original Matchframe shapes. The weapon silhouettes come with Lexogrine's CS2 HUD template (MIT, `LICENSE-lexogrine.txt`) and originate from Counter-Strike 2 game files (© Valve Corporation). Lexogrine's licence covers the code, not Valve's artwork; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons. Matchframe Esports is not affiliated with or endorsed by Valve.
- The layout conventions and motion timings follow common broadcast HUD practice; the artwork is Matchframe's own.
