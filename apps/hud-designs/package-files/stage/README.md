# Stage HUD

A broadcast HUD for CS2 laid out like a tournament stage broadcast, built for the MatchFrame HUD Library on MatchFrame's public HUD state. Flat deep-navy panels with chamfered corners, the CS side colours (CT blue, T gold) or each team's own colour, one condensed face.

What it shows:

- **Top left:** the series strip, the series' maps in order behind arrows: the picking team's logo (else its tag on its colour) or DECIDER, the map's name and the score of maps already played; the live map is lit (with the map's picture from the HUD images behind it), maps to come are dimmed. The minimap sits under it: the map's radar image (or MatchFrame's clean radar) with player numbers, the bomb, bombsites and utility, the same markers as the other MatchFrame HUDs.
- **Top centre:** the event line (the event's name on the left, the match's stage and title on the right, or your own text), then the score bar: each team's logo (or tag) in a 60 px box, the series boxes (one per map needed, lit for each map won), the score with a bar in the side's colour under it, and in the middle the round and its clock. While the bomb is down the middle shows the bomb and the seconds left on its fuse (the defuse kit in the CT colour while it is being defused) and a fuse bar drains under the bar. Under the bar: **players alive** (`4 VS 2` on the teams' colours) once someone has gone down in the round, the round's winner and how it was won at round end, MATCH PAUSED during a pause.
- **Top right:** the sponsor scheduled for the **top bar** (its image, else its name; nothing when none is scheduled), and the killfeed under it: rows tinted with the killer's side colour with killer, assister, weapon, headshot and blind marks and victim, each kill for about seven seconds.
- **Bottom corners:** each team's name on a tab in its colour over its five player cards, the right team mirrored. From the screen edge a card has the observer slot number on a strip in the team's colour, the name with kills and deaths and money, the photo, the weapon (and the one in hand) with the grenades under it, and the health as a big number with the armour and the defuse kit or bomb under it. The card is filled with the team's colour (CT blue and T gold by default, or the team's own) as far as the player's health, grey beyond (a light trail follows a hit). Round kills show as small diamonds on the card's top edge. The observed player's card is lit with a white rim and nudged towards the centre. A dead player's card shrinks to the name and photo, grey, with a skull (or the HUD images' dead icon) beside the photo; kills, deaths and money stay.
- **Round MVP:** at the round's end and the first seconds of the next round, the round's key player's card grows into a tall card in its place (the cards below keep their places): ROUND MVP, the name, that round's kills and damage, health and armour at the round's end, and the player's picture standing on the card (a cut-out PNG with a transparent background looks best). The key player is CS2's own round MVP when the game data shows it, else the winning side's player with the most kills, then damage.
- **Bottom centre:** the observed player: their **player cam** while it is on air (MatchFrame's player cams, already delayed to match the game), else their picture standing on a transparent backdrop, with their grenades on the left and the ammunition on the right, over a name bar in the team's colour with the slot number, kills, assists, deaths and health.
- **Freeze time, timeouts, half time and pauses:** the cards and the observed player make way for a full-width **scoreboard** along the bottom. Each team's **coach** (from the team's roster) is named over its end. Its header has, for each team, the equipment value (the five players' together), the loss bonus (CS2's ladder from the team's losses in a row), timeouts left as pips, the logo, the tag, the series boxes and the score. Under it each player's photo, name, armour, kit or bomb, grenades, pistol, main weapon and money, with the sponsor scheduled for the **scoreboard slot** in the middle (empty when none is). During a tactical timeout a callout over the calling team's end of the bar shows the seconds left, the team and its timeouts left.
- **Labels:** SIMULATION while test data is running, DATA PAUSED when game data stops arriving, REPLAY while a replay is on air.

Players' and coaches' voice or mute state is never shown: MatchFrame's Team Comms rules keep individual comms off air.

**Icons**, in this order, each tinted with a CSS mask so it takes the panel's colour:

1. **The owner's icon set**, bundled with the package (64 white PNG silhouettes): 34 weapons, the grenades, knife, Zeus, C4, defuse kit, vest and helmet, and the marks for kills, deaths, assists, headshot, health, money, ammunition, the bomb carrier, planting, planted, defusing and defused, a disconnected player, a blinded killer, fire and grenade kills, the timeout (labelled, in the timeout callout) and the match pause.
2. **The icon pack** loaded on the computer, if any (HUD Library → HUD images → Icon pack: Counter-Strike 2's own icons from the operator's copy): whatever the owner's set lacks, such as knife variants and the round-kill star.
3. **MatchFrame's own glyphs and the bundled MIT weapon silhouettes** for anything else.

The package contains no CS2 icon files.

Pictures come from the HUD Library's **HUD images** (default player pictures by side, map logos, the dead icon) where a player, map or mark has none of its own. Change the HUD in the HUD Library under **Appearance**: CT and T colours (teams with their own colour keep it), full names or tags over the cards, the two halves of the event line, and whether the series strip, minimap, killfeed (and how many rows), sponsor slots, players alive, observed player, freeze-time scoreboard, round MVP card and player money show. Variants: **live** (everything), **compact** (score bar, killfeed and observed player) and **replay** (the replay graphic: a REPLAY tag where the score bar sits and a lower third with who made the play, 2K to ACE or the clutch, the weapon and who went down).

Motion runs on `transform`, `opacity` and `clip-path` only, with no blur or backdrop filters, so it stays smooth in an OBS browser source: cards slide in from the screen edges one after another, the scoreboard header opens from the centre and its rows rise in, the players-alive badge drops in under the bar, kills slide in from the right. Only the round clock, the bomb's fuse and the killfeed's timer update several times a second; player cards re-render only when what they show changes.

## Build or change it

The source is in the MatchFrame repository at `apps/hud-designs/src/stage` (React, TypeScript, plain CSS, Vite):

```
pnpm install
pnpm --filter @matchframe/hud-designs dev:stage     # http://localhost:5178/?demo=cycle plays every scene
cd apps/hud-designs
pnpm exec vite build --mode stage && node scripts/finish-packages.mjs stage    # writes dist/stage
```

`?demo=<scene>` shows one sample state (`freeze`, `live`, `kill`, `plant`, `bomb`, `defuse`, `over`, `timeout`, `mvp`, `nocam`); `?demo=cycle&every=3000` plays them in turn. Add `&art=1` for sample HUD images, `&radar=1` for a sample radar, `&logo=1` for sample team emblems, `&bo=5` (or `1`, `3`, `7`) for another series length and `&cam=0` (or the `nocam` scene) to leave out the stand-in player cam. `node scripts/shots.mjs stage <dir> --query "art=1&radar=1&logo=1"` screenshots every scene. To make your own HUD from it, set your own `id`, `name` and `version` in `package-files/stage/manifest.json`, build, then use **Import HUD Folder** on `dist/stage` (or zip it and use **Import HUD ZIP**).

Rules every HUD package follows: transparent `html` and `body` backgrounds; the page reads `output`, `variant` and `t` from its query string and opens the read-only `/overlay-ws` socket; settings arrive in `state.settings` with every snapshot; a visible label while `state.simulated` is true; only static files (plus `/hud-runtime/cams.js`, which the HUD server provides for player cams).

## Licences and credits

- Code: MIT, MatchFrame.
- Barlow Condensed font: SIL Open Font License 1.1 (`OFL-fonts.txt`).
- Icons in `assets/` named after weapons and marks (`ak47-….png`, `kills-….png`, …): the owner's own icon set (generated recreations, not Valve's files), prepared for the HUD (faint background removed, cropped, 64 px tall).
- Bomb, kit, armour, grenade, kill, round-kill and arrow marks, the player figure and the panel shapes are original MatchFrame drawings. The weapon silhouettes come with a third-party CS2 HUD template (MIT, `third-party-licenses/weapon-icons-MIT.txt`) and originate from Counter-Strike 2 game files (© Valve Corporation). That licence covers the code, not Valve's artwork; a commercial distribution should confirm it is covered by Valve's terms for broadcasting Counter-Strike, or replace them with original icons. MatchFrame Esports is not affiliated with or endorsed by Valve.
- The layout follows common tournament broadcast practice; the look, artwork and motion are MatchFrame's own, with no third-party HUD artwork, logos, names or text.
