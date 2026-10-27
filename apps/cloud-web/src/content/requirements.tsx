import type { ReactNode } from "react";
import type { IconName } from "../components/icons.tsx";

/** /requirements. Facts from README.md, COMPATIBILITY_MATRIX.md and docs/operations/*.md. */
export interface RequirementGroup {
  id: string;
  title: string;
  icon: IconName;
  rows: [string, ReactNode][];
}

export const REQUIREMENT_GROUPS: RequirementGroup[] = [
  {
    id: "computer",
    title: "Production computer",
    icon: "windows",
    rows: [
      ["Operating system", "Windows 10 or Windows 11, 64-bit (x64)."],
      ["Installation", "Per-user installer (MatchframeEsports-Setup-<version>.exe). The installer isn't code-signed yet, so SmartScreen asks for confirmation."],
      ["Data folder", <><code>%APPDATA%\Matchframe Esports</code></>],
      ["Hardware", "Size the computer for CS2 and OBS encoding; the program itself is light. One CS2 client, OBS and Matchframe on one PC is the supported single-computer setup."],
    ],
  },
  {
    id: "cs2",
    title: "Counter-Strike 2",
    icon: "camera",
    rows: [
      ["Client", "A CS2 observer or spectator client (including GOTV)."],
      ["Game State Integration", "The program writes the config file for you (gamestate_integration_matchframe.cfg) with a secret token. Restart CS2 afterwards."],
      ["Camera control", <>For the direct console adapter, add the launch option <code>-netconport 2121</code>. The keyboard adapter needs the CS2 window to be focused.</>],
    ],
  },
  {
    id: "obs",
    title: "OBS Studio",
    icon: "hud",
    rows: [
      ["Version", "OBS Studio 30 or later."],
      ["WebSocket", "obs-websocket 5, built into OBS 30 (Tools → WebSocket Server Settings)."],
      ["HUD", "A 1920×1080 Browser Source per HUD output."],
      ["Replays", "The replay buffer enabled for replay playout."],
    ],
  },
  {
    id: "network",
    title: "Network and ports",
    icon: "network",
    rows: [
      ["Local ports", <>37210 (Game State Integration), 37211 (engine API), 37212 (HUD outputs). Bound to this computer (loopback) by default.</>],
      ["Multi-PC", "Set the production computer to listen on its LAN address and allow ports 37210–37212 from the production subnet only."],
      ["Internet", "For signing in to the program, refreshing its licence (every 15 minutes while online) and uploading auto-director usage. After that the program works offline for up to 7 days after each check."],
      ["Account", "A free Matchframe account with a confirmed email address. The program asks you to sign in with it when it opens."],
    ],
  },
  {
    id: "optional",
    title: "Optional",
    icon: "layers",
    rows: [
      ["Account", "Not needed for HUDs, manual and advisory direction, replays, administration or the simulation. Needed for automatic direction on live matches (the Free plan is enough to start)."],
      ["Demo pipeline", "Python 3.11 or later with the worker dependencies, and disk space for demos."],
      ["Control surfaces", "Stream Deck or Companion through the program's control-surface API."],
    ],
  },
];
