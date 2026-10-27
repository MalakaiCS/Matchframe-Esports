# Pro CS2 HUD

A full broadcast HUD for the Matchframe HUD Library, adapted from [Lexogrine's CS2 React HUD](https://github.com/lexogrine/cs2-react-hud) (MIT) to Matchframe's public HUD state.

What it shows:

- **Match bar:** team names and logos, scores, the round clock and round number, the bomb timer once planted, "wins the round", best-of and series wins.
- **Players:** both teams down the sides with health, armour, helmet, defuse kit, bomb, weapons, grenades, money and round kills; K/A/D for dead players.
- **Observed player:** health, armour, K/A/D and K/D, grenades and ammunition.
- **Killfeed** and **players alive**.
- **Radar** from Matchframe's map data (hidden when no trustworthy calibration exists).
- **Freeze time:** utility level and team economy (loss bonus only when the game reports it) and the series maps.
- **Pause** and **timeout** banners, the **SIMULATION** label when test data is running and **DATA PAUSED** when game data stops arriving.

Change it in the HUD Library under **Appearance**: team names, CT and T colours, panel opacity, which elements show and the radar size. Variants: **live** (everything) and **compact** (no radar, side boxes or series maps).

## Build your own from it

The source is in the Matchframe repository at `apps/hud-template` (React, TypeScript, SCSS, Vite):

```
pnpm install
pnpm --filter @matchframe/hud-template dev      # http://localhost:5175/?demo=1 shows sample data
pnpm --filter @matchframe/hud-template build    # writes the package to apps/hud-template/dist
```

Change the components in `src/hud/` and the styles in `src/styles/`, set your own `id`, `name` and `version` in `package-files/manifest.json`, build, then use **Import HUD Folder** on `dist/` (or zip it and use **Import HUD ZIP**). With the program running, `pnpm dev` connects to the local HUD server through the dev proxy; open the page with your HUD's `output`, `variant` and `t` parameters from **Copy OBS Browser URL**.

Rules every HUD package follows: transparent `html` and `body` backgrounds; the page reads `output`, `variant` and `t` from its query string and opens the read-only `/overlay-ws` socket (`src/useHud.ts`); settings arrive in `state.settings` with every snapshot; a visible label while `state.simulated` is true; only static files.

## Licences and credits

- Code: MIT. Lexogrine's original licence is in `LICENSE-lexogrine.txt`; Matchframe's changes are under the same terms.
- Montserrat font: SIL Open Font License 1.1 (`OFL-Montserrat.txt`).
- The weapon and equipment icons come with Lexogrine's template and originate from Counter-Strike 2 game files (© Valve Corporation). Lexogrine's MIT licence covers the code, not Valve's artwork. Broadcast HUDs for Counter-Strike commonly use these icons; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons. Matchframe Esports is not affiliated with or endorsed by Valve.
