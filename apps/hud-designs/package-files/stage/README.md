# Stage HUD

A broadcast HUD for CS2 laid out like a tournament stage broadcast, built for the MatchFrame HUD Library on MatchFrame's public HUD state. Flat deep-navy panels with chamfered corners, the CS side colours (CT blue, T gold) or each team's own colour, one condensed face.

What it shows:

- **Top left:** the series strip, the series' maps in order: who picked each one (their logo, else their tag on their colour) or DECIDER, the map's logo from the HUD images, the name and the score of maps already played; the live map is lit (with the map's picture from the HUD images behind it), maps to come are dimmed. The minimap sits under it: the map's radar image (or MatchFrame's clean radar) with player numbers, the bomb, bombsites and utility, the same markers as the other MatchFrame HUDs.
- **Top centre:** the event line (the event's name on the left, the match's stage and title on the right, or your own text), then the score bar: each team's logo (or tag), the series boxes (one per map needed, lit for each map won), the score, and in the middle the round and its clock. While the bomb is down the middle shows the bomb and the seconds left on its fuse (the defuse kit in the CT colour while it is being defused) and a fuse bar drains under the bar. Under the bar: **players alive** (`4 VS 2` in the teams' colours) during the round, the round's winner and how it was won at round end, MATCH PAUSED during a pause.
- **Top right:** the sponsor scheduled for the **top bar** (its image, else its name; nothing when none is scheduled), and the killfeed under it: killer, assister, weapon, headshot and blind marks, victim, in side colours, each kill for about seven seconds.
- **Bottom corners:** each team's name tab over its five player cards, the right team mirrored. A card has the observer slot number at the screen edge, the name, kills and deaths with small marks, money, the photo, the weapon in hand and the main weapon, grenades, armour and helmet, the defuse kit or the bomb, and the health as a big number with a health bar along the card's foot (a light trail follows a hit). Round kills show as small diamonds on the card's top edge. The observed player's card is lit with a white rim and nudged towards the centre. A dead player's card turns grey with a skull (or the HUD images' dead icon) where the gear was; name, kills, deaths and money stay.
- **Bottom centre:** the observed player: their **player cam** while it is on air (MatchFrame's player cams, already delayed to match the game), kills, assists, deaths, round kills and ammunition, and a name bar with the slot number and health.
- **Freeze time, timeouts, half time and pauses:** the cards and the observed player make way for a full-width **scoreboard** along the bottom. Its header has, for each team, the equipment value (the five players' together), the loss bonus (CS2's ladder from the team's losses in a row), timeouts left as pips, the logo, the tag, the series boxes and the score. Under it each player's photo, name, armour, kit or bomb, grenades, pistol, main weapon and money, with the sponsor scheduled for the **scoreboard slot** in the middle (empty when none is). During a tactical timeout a callout over the calling team's end of the bar shows the seconds left, the team and its timeouts left.
- **Labels:** SIMULATION while test data is running, DATA PAUSED when game data stops arriving, REPLAY while a replay is on air.

Players' voice or mute state is never shown: MatchFrame's Team Comms rules keep individual players' comms off air.

Pictures come from the HUD Library's **HUD images** (default player pictures by side, map logos, the dead icon) where a player, map or mark has none of its own. Change the HUD in the HUD Library under **Appearance**: CT and T colours (teams with their own colour keep it), full names or tags over the cards, the two halves of the event line, and whether the series strip, minimap, killfeed (and how many rows), sponsor slots, players alive, observed player, freeze-time scoreboard and player money show. Variants: **live** (everything), **compact** (score bar, killfeed and observed player) and **replay** (the replay graphic: a REPLAY tag where the score bar sits and a lower third with who made the play, 2K to ACE or the clutch, the weapon and who went down).

Motion runs on `transform`, `opacity` and `clip-path` only, with no blur or backdrop filters, so it stays smooth in an OBS browser source: cards slide in from the screen edges one after another, the scoreboard header opens from the centre and its rows rise in, the players-alive badge drops in under the bar, kills slide in from the right. Only the round clock, the bomb's fuse and the killfeed's timer update several times a second; player cards re-render only when what they show changes.

## Build or change it

The source is in the MatchFrame repository at `apps/hud-designs/src/stage` (React, TypeScript, plain CSS, Vite):

```
pnpm install
pnpm --filter @matchframe/hud-designs dev:stage     # http://localhost:5178/?demo=cycle plays every scene
cd apps/hud-designs
pnpm exec vite build --mode stage && node scripts/finish-packages.mjs stage    # writes dist/stage
```

`?demo=<scene>` shows one sample state (`freeze`, `live`, `kill`, `plant`, `bomb`, `defuse`, `over`, `timeout`); `?demo=cycle&every=3000` plays them in turn. Add `&art=1` for sample HUD images, `&radar=1` for a sample radar, `&logo=1` for sample team emblems, `&bo=5` (or `1`, `3`, `7`) for another series length and `&cam=0` to leave out the stand-in player cam. `node scripts/shots.mjs stage <dir> --query "art=1&radar=1&logo=1"` screenshots every scene. To make your own HUD from it, set your own `id`, `name` and `version` in `package-files/stage/manifest.json`, build, then use **Import HUD Folder** on `dist/stage` (or zip it and use **Import HUD ZIP**).

Rules every HUD package follows: transparent `html` and `body` backgrounds; the page reads `output`, `variant` and `t` from its query string and opens the read-only `/overlay-ws` socket; settings arrive in `state.settings` with every snapshot; a visible label while `state.simulated` is true; only static files (plus `/hud-runtime/cams.js`, which the HUD server provides for player cams).

## Licences and credits

- Code: MIT, MatchFrame.
- Barlow Condensed font: SIL Open Font License 1.1 (`OFL-fonts.txt`).
- Bomb, kit, armour, grenade, kill and round-kill marks, the player figure and the panel shapes are original MatchFrame drawings. The weapon silhouettes come with a third-party CS2 HUD template (MIT, `third-party-licenses/weapon-icons-MIT.txt`) and originate from Counter-Strike 2 game files (© Valve Corporation). That licence covers the code, not Valve's artwork; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons. MatchFrame Esports is not affiliated with or endorsed by Valve.
- The layout follows common tournament broadcast practice; the look, artwork and motion are MatchFrame's own, with no third-party HUD artwork, logos, names or text.
