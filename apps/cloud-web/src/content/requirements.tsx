import type { ReactNode } from "react";
import type { IconName } from "../components/icons.tsx";
import { CURRENT_VERSION, installerName } from "./release.ts";

/** /requirements. Facts from README.md, COMPATIBILITY_MATRIX.md, docs/release-notes and docs/operations/*.md. */
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
      ["Current version", <>MatchFrame Esports {CURRENT_VERSION}, an early-access development build.</>],
      ["Installation", <>Per-user installer (<code>{installerName()}</code>), no administrator rights needed. Builds aren't code-signed yet, so Windows SmartScreen may warn: check the SHA-256 checksum, then choose More info → Run anyway. Signed builds are coming.</>],
      ["Updates", "The program updates itself from our GitHub releases on the Stable channel (or Beta, if you choose it), and installs when you restart. You can go back to a previous version from Settings."],
      ["Data folder", <><code>%APPDATA%\MatchFrame Esports</code>. A copy of your data is kept before each update that changes its format.</>],
      ["Hardware", "Size the computer for CS2 and OBS encoding; the program itself is light. On one PC with CS2 and OBS, turn on low-spec mode."],
    ],
  },
  {
    id: "cs2",
    title: "Counter-Strike 2",
    icon: "camera",
    rows: [
      ["Client", "A CS2 observer or spectator client (including GOTV) on the production computer."],
      ["Game State Integration", "The program writes the config file for you (gamestate_integration_matchframe.cfg) with a secret token, and can start CS2 for you."],
      ["Camera control", <>For the Auto Director, start CS2 from the program in the Observer tools mode (<code>-tools -netconport</code>; needs the free CS2 Workshop Tools), optionally with HLAE for smooth camera moves. The keyboard adapter needs the CS2 window to be focused.</>],
      ["Cameras", "Built-in cameras for the main map pool, checked against each map's geometry; add your own with getpos in Maps & Cameras. The static camera test must pass on your CS2 build."],
    ],
  },
  {
    id: "obs",
    title: "OBS or vMix",
    icon: "hud",
    rows: [
      ["OBS", "OBS Studio 30 or later, with its built-in WebSocket server (obs-websocket 5)."],
      ["vMix", "Works for replays, map intros and highlights."],
      ["HUD", "A 1920×1080 Browser Source per HUD output, or the desktop HUD over the game."],
      ["ffmpeg", "For replays from a replay PC, rendered replay breaks, highlight reels and checking map intros. The program downloads and checks it for you."],
    ],
  },
  {
    id: "replay-pc",
    title: "Replay PC (optional)",
    icon: "replay",
    rows: [
      ["Computer", "A second Windows PC with CS2 and MatchFrame, watching the same match a few seconds behind."],
      ["Picture", "Its screen sent over NDI (for example vMix Desktop Capture NDI, OBS's NDI output or NDI Screen Capture), or clips from its own OBS replay buffer."],
      ["Network", "The two computers on the same local network, linked with a replay PC code."],
    ],
  },
  {
    id: "network",
    title: "Network and ports",
    icon: "network",
    rows: [
      ["Local ports", <>37210 (Game State Integration), 37211 (the program's API), 37212 (HUD outputs). Bound to this computer (loopback) by default.</>],
      ["Operator positions", "Let other computers connect to the production computer and allow ports 37210–37212 from the production subnet only."],
      ["Internet", "For signing in, refreshing the licence (every 15 minutes while online), uploading auto-director usage, account sync, player cams, updates and crash reports if you turn them on. Everything else works offline, and the Auto Director keeps working for up to 7 days after each licence check."],
      ["Account", "Not needed for HUDs, replays, map intros or manual direction. A free MatchFrame account with a confirmed email address is needed for the Auto Director, player cams and account sync."],
    ],
  },
  {
    id: "optional",
    title: "Optional",
    icon: "layers",
    rows: [
      ["Auto-director hours", "Needed only for Observer, Observer & Cinematics and Full Action Observer on live matches (the Free plan includes a few hours; Full Action Observer needs the top plan). Off, manual direction and the simulation use none."],
      ["Team Comms", "TeamSpeak 3 with the MatchFrame plugin, and an NDI plugin for OBS (DistroAV) for the on-air mix."],
      ["Player cams", "Players need a current browser with a webcam; no install."],
      ["Control surfaces", "Stream Deck or Companion through the program's control-surface actions."],
      ["Demo pipeline", "Python 3.11 or later with the worker dependencies, and disk space for demos."],
    ],
  },
];
