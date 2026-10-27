# Matchframe Sample CS2 HUD

A complete HUD package for the Matchframe HUD Library, kept small enough to read in one sitting. Copy this folder to start your own HUD.

| File | What it does |
|---|---|
| `manifest.json` | Name, version, game, entry points (variants), thumbnail, design resolution and the settings form shown in the library |
| `index.html` | The page every output loads (desktop overlay, preview and OBS browser source) |
| `app.js` | Connects to the HUD server with the read-only SDK (`/sdk/hud-sdk.js`) and renders each state snapshot |
| `styles.css` | Layout for 1920×1080; outputs scale it uniformly |
| `fonts/` | Inter (SIL Open Font License 1.1, see `fonts/OFL.txt`) |
| `images/` | Artwork used by the HUD; `images/weapons/` holds the killfeed's weapon icons (from Lexogrine's MIT CS2 HUD template, see `images/weapons/LICENSE-lexogrine.txt`) |
| `thumbnail.webp` | The library card image |

The minimap (`renderMinimap`) and killfeed (`renderKillfeed`) in `app.js` show how to use `state.radar` and `state.killfeed`: draw the background from `radar.backgroundUrl` (an image, or a JSON outline in the schematic mode), place markers with their 0–1 coordinates, and keep each kill on screen for a few seconds after it first arrives.

Rules for any HUD package:

- Keep `html` and `body` backgrounds transparent, so the game shows through the desktop overlay and OBS composites the HUD over Game Capture.
- Read `output`, `variant` and `t` from the page's query string and pass them to `/overlay-ws` (see `app.js`). The socket is read-only.
- Settings from the HUD Library arrive in `state.settings` with every snapshot; apply them on each render and they update live.
- Show a clear label when `state.simulated` is true (test data).
- Only static files: HTML, JS, CSS, JSON, images, fonts, video, text. No executables; nothing is run during install.

Import the folder (or a ZIP of it) with **Import HUD Folder** or **Import HUD ZIP** in the HUD Library.
