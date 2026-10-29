# Player cams

Players' face cams in the broadcast, the way Lexogrine HUD Manager does it: each player opens a link on the Matchframe website, picks themselves and their camera, checks the preview and sends it. Matchframe shows the observed player's cam in your HUD and in OBS, delayed to match the game (ADR-048).

## Setting up

1. Sign the program in to your Matchframe account (**Settings → Account**). Player cams go through the Matchframe website.
2. **Cameras → Player cameras → Player cams**: switch on. The panel shows **Open on the website** and the link for your players (`https://<website>/cam/<code>`).
3. Set the **Delay** to your CSTV delay (`tv_delay`, often 90–120 s at events), so faces match what the game shows. Up to 300 s.
4. Send the link to the players in the match. Anyone with the link can send a camera as one of the match's players, so share it only with them. **New link** stops the old one at once.
5. Players open the link in Chrome or Edge, pick their name, pick their camera, check the preview and press **Approve and send**. Their page then says whether the cam is live.

**Who is listed:** the players of the current match (**Matches**: the two teams and their current players). Without a current match, the players in the game data, by side. Coaches are left out.

## On air

- **Put cams on air as soon as they arrive** (on by default). Off: each cam waits on the Player cameras screen, where you see it first, until you press **Put on air**.
- **Take off air** hides one player's cam from the HUD and OBS. The player keeps sending and their page says so.
- **Stop camera** sends the player away. Their page says the production stopped it, and they can send it again from the link.
- The previews on the Player cameras screen are live, not delayed. The HUD and OBS get each cam after the delay.

## Where the cams show

- **LHM-format HUDs** (such as kaiHUD): through their own camera protocol, with no setup. The HUD shows the observed player's cam where its design puts it. Reload a HUD that was open before you switched player cams on (LHM HUDs read the player list when they start).
- **Matchframe's own HUD:** above the observed player's panel.
- **OBS:** browser sources from the panel:
  - the observed player's cam (`/cams/observed?t=…`), which follows the observer and is transparent while that player has no cam on air;
  - one player's cam (`/cams/player/<SteamID64>?t=…`).

## Video and bandwidth

**Video players send** sets what every player's browser sends:

| Setting | Size | From each player |
|---|---|---|
| Low | 480×270, 25 fps | about 0.4 Mbit/s |
| Standard (default) | 640×360, 30 fps | about 0.7 Mbit/s |
| High | 1280×720, 30 fps | about 1.8 Mbit/s |

- **Encoding:** the player's browser encodes the camera (VP8, a keyframe every 2 s) and sends it to the website. The website passes it straight to your program and stores nothing.
- **Your download:** ten players at Standard is about 7 Mbit/s.
- **The program's memory:** it keeps the delay's worth of video. 120 s at Standard is about 10 MB a player.
- **Website traffic:** the video goes through the Matchframe website, so it counts as website traffic in both directions. That is about 3 GB an hour for ten players at Standard.
- **Behind the game:** in Chrome and Edge the camera keeps sending while the game covers the browser. Other browsers slow it down (the page says so).

## For HUD authors

HUD pages served by Matchframe can load `/hud-runtime/cams.js` and use `window.MatchframeCams`:

| Call | What it gives |
|---|---|
| `canvas(steamId)` | The canvas a player's cam is drawn into (transparent while off air). |
| `stream(steamId)` | A `MediaStream` of that canvas, for a video element. |
| `onAir(steamId)` | Whether the cam is on air. |
| `observed()` | The observed player's SteamID. |
| `on("change" \| "observed", fn)` | Called when cams go on or off air, or the observed player changes. |

Video arrives already delayed.

## Not verified yet

- **A real match:** a real CS2 match with players at home. The whole path was tested in Chromium:
  - the cam page with a fake camera, through the relay and the program, to the OBS page and to an LHM HUD's peer connection (simple-peer);
  - not with kaiHUD itself, nor in OBS's own browser.
- **Hosting:** the website must be redeployed with this version for the cam page and relay to exist there.
