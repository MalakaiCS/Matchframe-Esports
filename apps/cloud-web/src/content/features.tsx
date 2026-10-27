import type { ReactNode } from "react";
import type { IconName } from "../components/icons.tsx";
import type { ShotName } from "../components/marketing.tsx";
import { Link } from "../router.tsx";

/**
 * Product capabilities shown on /features and /features/:slug. Facts follow README.md,
 * CAPABILITIES.md, FEATURE_COVERAGE.md and docs/operations/*.md: describe what the program is
 * designed to do, and say plainly what hasn't been verified yet.
 */
export interface FeatureFaq {
  q: string;
  a: ReactNode;
}

export interface Feature {
  slug: string;
  title: string;
  /** Short label for menus. */
  nav: string;
  icon: IconName;
  tagline: string;
  /** One paragraph for the overview page and meta description. */
  summary: string;
  /** Three highlights for the overview card. */
  highlights: string[];
  shot?: { name: ShotName; alt: string; caption: string };
  what: ReactNode;
  how: string[];
  needs: ReactNode[];
  /** Early-access note specific to this capability (verification status). */
  status?: ReactNode;
  faqs: FeatureFaq[];
}

export const EARLY_ACCESS = (
  <>
    Matchframe is in early access. The program is built and tested with synthetic Game State Integration data, a labelled simulation, real OBS and real CS2 demos, and its Windows installer is smoke-tested. Real CS2 telemetry ingest and real observer camera control haven't yet been verified on a real CS2 client, so test your setup with the in-program checklist before a live match.
  </>
);

export const FEATURES: Feature[] = [
  {
    slug: "huds",
    title: "HUDs for OBS",
    nav: "HUDs for OBS",
    icon: "hud",
    tagline: "Broadcast graphics as OBS browser sources, published like software.",
    summary: "Every HUD output is an OBS browser source with its own URL and access token. Pick a built-in preset, adjust it in the Composer, publish when it's ready and roll back instantly.",
    highlights: ["Classic, Minimal and Arena presets with nine variants", "Draft, publish and roll back each output", "Import your own HUD packages"],
    shot: { name: "huds-outputs", alt: "The HUDs & Composer screen: a list of outputs, the draft settings of the main program HUD and a preview of the published HUD.", caption: "HUDs & Composer: outputs, drafts and live preview. Simulated match data." },
    what: (
      <>
        <p>The program serves your graphics as browser sources for OBS. Each output (for example the main programme HUD, a clean feed or a preview) has its own URL and token, a draft revision you edit and a published revision that's on air.</p>
        <ul>
          <li>Three original presets, Classic, Minimal and Arena, each with variants for pre-match, veto, live, post-map and more, plus studio standings and bracket panels.</li>
          <li>The Composer lets you move and hide HUD elements on a 1920×1080 stage and saves the change to the output's draft.</li>
          <li>Import your own HUD package as a zip or folder; paths, size, scripts and permissions are checked first. A HUD SDK and an example package are included.</li>
          <li>Outputs only receive the public match picture: never operator data, director predictions or secrets. Simulated or stale data is badged on screen.</li>
          <li>Per-output delay: a delayed output reads from a delay buffer and shows nothing ahead of the delayed programme.</li>
        </ul>
      </>
    ),
    how: ["Open HUDs & Composer, choose a preset and variant, then Publish.", "Copy the output's browser-source URL.", "Add it to OBS as a 1920×1080 Browser Source (or let the program provision it).", "Activate the match so the HUD shows the teams, players and series."],
    needs: ["OBS Studio 30 or later", "The program on the production computer", "No account or hours"],
    status: <>HUDs are rendered and checked in Chromium, the browser engine OBS uses for browser sources. They haven't yet been used in a Windows OBS production.</>,
    faqs: [
      { q: "Do HUDs use auto-director hours or need an account?", a: <p>No. HUDs work offline without an account, on every plan.</p> },
      { q: "Can I design my own HUD?", a: <p>Yes. Build a HUD package with the HUD SDK and import it in HUDs &amp; Composer. It gets the same draft, publish and rollback flow as the built-in presets.</p> },
      { q: "Are the player cards video feeds?", a: <p>No. Player cards are graphics driven by game data. Player cameras are routed separately through OBS, with the player's consent.</p> },
      { q: "Can a delayed output leak what's about to happen?", a: <p>Delayed outputs read from a delay buffer and show nothing until it has filled, so they never show information ahead of the delayed programme.</p> },
    ],
  },
  {
    slug: "auto-director",
    title: "Auto director",
    nav: "Auto director",
    icon: "director",
    tagline: "Automatic direction that explains itself, with the operator always in charge.",
    summary: "The director is designed to anticipate fights, crossfires and utility, pick the next shot and show its reasons. Choose how much it may do, take the camera back at any moment, and stop everything with one key.",
    highlights: ["Advisory, assisted and automatic modes", "Sticky manual takeover and emergency stop", "Starts disarmed every time"],
    shot: { name: "live-control", alt: "Live Control: player cards for both teams, the point-of-view panel, operator actions and the director panel with its modes and the reasons for the current shot.", caption: "Live Control: director modes, reasons and operator actions. Simulated match data." },
    what: (
      <>
        <p>The rule-based director reads the live game state and scores possible shots on anticipation (where action is likely next), readiness and information value. It looks at interaction clusters, crossfires, isolated aggressors and utility opportunities, and a planner with hysteresis avoids jittery cuts.</p>
        <ul>
          <li>
            <strong>Modes:</strong> off; advisory (recommends, never moves the camera); assisted (player cuts only); automatic; and shadow for comparing models.
          </li>
          <li>
            <strong>Explanations:</strong> every recommendation shows its reasons, confidence and the best alternatives.
          </li>
          <li>
            <strong>Manual takeover:</strong> any manual camera action makes control manual and sticky; pending automated commands are cancelled.
          </li>
          <li>
            <strong>Emergency stop:</strong> the on-screen button, <kbd>F8</kbd> or <kbd>Pause</kbd> in the program, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F12</kbd> anywhere in Windows, or the Automation menu.
          </li>
          <li>
            <strong>Safe defaults:</strong> the program always starts disarmed; if telemetry goes stale, control falls back to the operator.
          </li>
        </ul>
        <p>
          Automatic direction on live matches uses <Link to="/how-it-works#metering">auto-director hours</Link>. When hours run out, the current map is finished and the camera is handed back at the map change.
        </p>
      </>
    ),
    how: ["Pass the player-selection test in the setup checklist.", "Start in Advisory and watch the recommendations.", "Switch to Assisted or Automatic once you trust the setup.", "Arm it with Resume automation in Live Control; take over whenever you like."],
    needs: ["A real observer control adapter with a passed player-selection test", "A linked computer with auto-director hours for live matches", "Advisory and manual direction: no account needed"],
    status: <>The director has been exercised end to end in the labelled simulation and with synthetic data. It hasn't yet directed a real CS2 match.</>,
    faqs: [
      { q: "Does advisory mode use hours?", a: <p>No. Hours are only used while automation actually controls the camera on a live match. Advisory, manual direction and the simulation are free.</p> },
      { q: "Is there a language model in the cut loop?", a: <p>No. Live decisions come from the rule-based director. Demo-trained models only run in shadow mode for comparison and never move the camera.</p> },
      { q: "What happens if the game data stops?", a: <p>If telemetry is stale for more than a few seconds, the command in flight is cancelled, control goes back to the operator and an alert is raised.</p> },
      { q: "Will it resume on its own after I take over?", a: <p>No. Automation only resumes when an operator chooses Resume automation, optionally after a short countdown.</p> },
    ],
  },
  {
    slug: "cameras",
    title: "Observer camera control",
    nav: "Camera control",
    icon: "camera",
    tagline: "One verified control channel to the CS2 observer client.",
    summary: "The program moves the observer camera through a direct console connection or keyboard input, behind a single-writer control arbiter. Automatic control stays blocked until the in-program setup tests pass on your client.",
    highlights: ["Single-writer control arbiter", "Setup tests before any automation", "Operator-validated cinematic cameras"],
    shot: { name: "maps-cameras", alt: "The Maps & Cameras screen: map packs, a schematic outline of Inferno with named regions and the list of cameras for the map.", caption: "Maps & Cameras: map regions and operator-validated cameras." },
    what: (
      <>
        <p>Game State Integration carries telemetry only; it can't move the camera. Matchframe uses a separate control channel:</p>
        <ul>
          <li>
            <strong>Direct console:</strong> the observer client is started with a <code>-netconport</code> launch option and the program connects on this computer.
          </li>
          <li>
            <strong>Keyboard:</strong> player-slot key presses are sent only to the focused CS2 window; nothing is sent if another window has focus.
          </li>
          <li>
            <strong>Control arbiter:</strong> one writer at a time, ownership generations so stale commands can't run, at most one automated command in flight and a bounded retry.
          </li>
          <li>
            <strong>Confirmation:</strong> a command counts as done only when the observer client reports the new view, not when it was sent.
          </li>
          <li>
            <strong>Cinematic cameras:</strong> authored from in-game <code>getpos</code> output, validated by an operator and invalidated when the map revision changes.
          </li>
        </ul>
        <p>No memory reading, code injection or anti-cheat evasion is used.</p>
      </>
    ),
    how: ["Add -netconport to the observer client's launch options and choose Direct (console), or choose Keyboard.", "Run the player-selection test; automatic player cuts stay blocked until it passes.", "For cinematic shots, author cameras in Maps & Cameras, run the static camera test and validate each camera.", "Arm automation from Live Control."],
    needs: ["A CS2 observer or spectator client on the same computer as the control adapter", "A passed player-selection test for this game build", "Validated cameras for the current map revision for cinematic shots"],
    status: <>Both adapters are built against the public documentation and tested with a simulated observer. Real camera control hasn't yet been verified on a real CS2 client, which is exactly why the setup tests gate automation.</>,
    faqs: [
      { q: "Why won't the director move the camera yet?", a: <p>Automatic control needs a passed player-selection test on your client (and the static camera test plus validated cameras for cinematic shots). Until then it stays in advisory mode.</p> },
      { q: "Can the keyboard adapter type into the wrong window?", a: <p>No. It only sends input when the CS2 observer window has focus. Otherwise the command fails with a clear reason.</p> },
      { q: "Can I control an observer client on another computer?", a: <p>The console channel is local by design and keyboard input must happen on the observer computer. Run a second engine there as the control agent, or operate that client manually.</p> },
    ],
  },
  {
    slug: "utility-tracking",
    title: "Grenade tracking",
    nav: "Grenade tracking",
    icon: "grenade",
    tagline: "All six grenade types, from both teams, anywhere on the map.",
    summary: "The utility tracker follows HE grenades, flashbangs, smokes, Molotovs, incendiaries and decoys from both teams. Predictions are kept apart from confirmed events, and the director uses utility to anticipate the action.",
    highlights: ["HE, flash, smoke, Molotov, incendiary and decoy", "Predictions never shown as confirmed", "Measured per-type profiles from real demos"],
    what: (
      <>
        <p>The tracker follows every grenade the game reports, for both teams and anywhere on the map, and labels each piece of information with its evidence level: measured (reported by the game), derived (computed from measured data) or estimated (a prediction such as a landing point).</p>
        <ul>
          <li>Per-type flight and effect profiles measured from real CS2 demos, with uncertainty margins.</li>
          <li>Fire areas linked to the grenade that caused them; Molotov and incendiary told apart from the thrower's inventory where possible.</li>
          <li>Entity-ID reuse handled, so a new grenade isn't mistaken for an old one.</li>
          <li>The director uses utility opportunities such as flash entries, smoke executes, volleys and fire displacement; the radar shows confirmed utility.</li>
        </ul>
        <p>Game State Integration doesn't report damage or impacts, so those details are never invented.</p>
      </>
    ),
    how: ["The observer client sends grenade entities through Game State Integration.", "The tracker matches each grenade over time and predicts where it lands.", "Observed positions confirm or correct the prediction.", "The capability report shows which grenade types your feed actually delivers."],
    needs: ["A CS2 observer client with Game State Integration", "Map packs improve region-aware direction: available for Ancient, Anubis, Inferno and Overpass"],
    status: <>All six types are covered by real demo evidence. Per-type support in a live GSI feed hasn't been verified yet; GSI reports Molotov and incendiary under one name, so that pair is marked partial.</>,
    faqs: [
      { q: "Does tracking work on every map?", a: <p>Tracking works from the game data on any map. Map packs, which add named regions and floor levels for smarter direction, currently exist for Ancient, Anubis, Inferno and Overpass.</p> },
      { q: "Can the HUD show grenade damage?", a: <p>No. The game's live feed doesn't include damage or impact events, and Matchframe never presents estimates as facts.</p> },
    ],
  },
  {
    slug: "obs-replays",
    title: "OBS control and replays",
    nav: "OBS & replays",
    icon: "replay",
    tagline: "Scenes, sources, audio and replays without leaving the production desk.",
    summary: "The program controls OBS over its WebSocket API: scenes, sources, audio, recording, streaming and the replay buffer. Bookmark moments, approve them in a queue, play them out and return live.",
    highlights: ["Programme scene mapping", "Replay approval queue and confirmed playout", "Reconnects safely after an OBS disconnect"],
    shot: { name: "setup", alt: "The Setup checklist in the program, with steps for the source, detecting CS2, writing the GSI config and waiting for a real payload.", caption: "The setup checklist connects CS2, OBS and your HUD step by step." },
    what: (
      <>
        <ul>
          <li>Connects to OBS with obs-websocket 5: authentication, scene discovery, programme and preview, source visibility, audio, and recording, streaming and replay-buffer outputs.</li>
          <li>Maps your scenes to programme modes such as live, replay, studio and break.</li>
          <li>Provisions the HUD browser source without replacing your existing sources.</li>
          <li>Replays: bookmark from the replay buffer, approve in a queue, play out through a media source (confirmed from OBS's media status), then return live.</li>
          <li>Player cameras routed to the mixer by player identity, with consent, live only and delay-aligned.</li>
          <li>If OBS disconnects, the programme is marked degraded, the program reconnects with backoff and never replays stale cues.</li>
        </ul>
      </>
    ),
    how: ["Enable the WebSocket server in OBS (Tools → WebSocket Server Settings).", "Connect from Devices & Integrations in the program.", "Map your programme scenes and add the HUD source.", "Start the replay buffer; bookmark, approve and play replays from the program."],
    needs: ["OBS Studio 30 or later with obs-websocket 5 (built in)", "The replay buffer enabled in OBS for replays"],
    status: <>OBS control and the replay flow are tested against a real OBS 30 instance on Linux. OBS on Windows hasn't been tested yet.</>,
    faqs: [
      { q: "Can I use a separate replay system?", a: <p>A bridge for an external replay tool is designed, but that integration isn't available yet. The OBS replay buffer is the supported replay path today.</p> },
      { q: "Are multiple replay angles supported?", a: <p>Replays currently use the programme angle captured by OBS. Additional angles are planned.</p> },
      { q: "Do I need an account for OBS control?", a: <p>No. OBS control and replays work offline without an account.</p> },
    ],
  },
  {
    slug: "match-admin",
    title: "Match administration",
    nav: "Match administration",
    icon: "trophy",
    tagline: "Events, vetoes, sponsors, standings and brackets in one place.",
    summary: "Keep events, teams, players, series and the running order in the program. Captains veto from their own links, sponsors rotate in safe windows, and standings and brackets feed your studio graphics.",
    highlights: ["Veto with captain links and full history", "Sponsor rotation with delivery acknowledgements", "Standings and single-elimination brackets"],
    shot: { name: "matches-veto", alt: "The Matches & Veto screen with a veto board of bans, picks and side choices, the result and an audited history.", caption: "Veto with captain links and an audited history. Simulated teams." },
    what: (
      <>
        <ul>
          <li>Events and stages, teams and players (SteamID64 kept exact, rosters, logos), bulk import with preview.</li>
          <li>Matches and series: best-of formats, MR and overtime settings; a series never advances on a tied or unfinished map.</li>
          <li>Veto: sequences built from the map pool, captain links scoped to one match and team, an overlay variant, and an immutable history where corrections are recorded as revisions.</li>
          <li>Sponsors: zones, weighted rotation and safe windows that never cover live fights, with a delivery log confirmed by the HUD.</li>
          <li>Studio: rundown cues, lower thirds and break screens, standings and single-elimination brackets.</li>
          <li>Automation rules for routine moments, and event export and restore between computers.</li>
        </ul>
      </>
    ),
    how: ["Create teams and players, or import them.", "Create the match and its format.", "Send captain links and run the veto.", "Activate the match so HUDs show the teams, players and series."],
    needs: ["The program only: no account or hours"],
    faqs: [
      { q: "How secure are captain links?", a: <p>Each link is a token scoped to one match and one team. Captains only see veto information and can only act on their own turns. Links can be revoked at any time.</p> },
      { q: "Can sponsors appear during a fight?", a: <p>No. Sponsor slots use safe windows that avoid live fights, and each display is logged when the HUD acknowledges it.</p> },
    ],
  },
  {
    slug: "multi-pc",
    title: "Multi-PC operation",
    nav: "Multi-PC",
    icon: "network",
    tagline: "Extra operator positions connected to one production computer.",
    summary: "Run the engine on the production computer and connect graphics, replay or producer positions from other computers with role-scoped tokens. Stream Deck and Companion can drive actions through the same permissions.",
    highlights: ["Role-scoped tokens per position", "The console is never served to browsers", "Stream Deck and Companion control surface"],
    what: (
      <>
        <p>A typical split is an observer PC running the CS2 observer client, a production PC running OBS and Matchframe, and optional extra positions.</p>
        <ul>
          <li>Extra positions install the same program and connect to the production computer. They run no engine of their own and see the console with their token's permissions.</li>
          <li>Each position gets its own role-scoped token (for example observer or producer); tokens are stored encrypted with the Windows credential store.</li>
          <li>The observer PC sends Game State Integration data to the production computer over the local network.</li>
          <li>A control-surface API with per-action permissions and tally serves Stream Deck and Companion setups.</li>
          <li>Everyone works on one shared live state, with an audit log and optimistic revision checks.</li>
        </ul>
      </>
    ),
    how: ["On the production computer, allow the local network and issue a token per position in Devices & Integrations → Tokens.", "On each extra computer, choose File → Connection settings → Connect to the production computer.", "Enter the production computer's address and that position's token.", "Write the GSI config on the observer PC with the production computer as the receiver."],
    needs: ["Windows 10 or 11 on each position", "A local network between the computers; ports 37210–37212 open to the production subnet", "Only computers that run automatic direction need to be linked to your organisation"],
    status: <>Remote operator positions are smoke-tested. Camera control across computers needs a control agent on the observer PC; a dedicated remote observer agent is planned.</>,
    faqs: [
      { q: "Can operators connect over the internet?", a: <p>Multi-PC operation is designed for a local production network. Exposing the engine to the internet isn't supported.</p> },
      { q: "Can I open the console in a browser?", a: <p>No. The operator console only runs inside the program, never in a browser.</p> },
    ],
  },
  {
    slug: "demo-pipeline",
    title: "Demo pipeline and training",
    nav: "Demo pipeline",
    icon: "model",
    tagline: "Turn CS2 demos into datasets and evaluate models in shadow mode.",
    summary: "The Demo Library imports and validates CS2 demos, builds datasets with leakage checks and trains models you can evaluate against the director in shadow mode. Learned models never drive the live camera.",
    highlights: ["Demo Library with validation and retention", "Leakage-checked datasets and match-level splits", "Shadow evaluation next to the director"],
    what: (
      <>
        <ul>
          <li>Demo Library: import, hashing, duplicate detection, extraction, validation, quarantine and retention.</li>
          <li>Datasets: causal features and labels, leakage checks and match-level splits, frozen with a content hash.</li>
          <li>Training and evaluation on held-out matches, export and a model registry with promotion and rollback.</li>
          <li>Shadow mode runs a model next to the rule-based director so you can compare them without affecting the broadcast.</li>
        </ul>
      </>
    ),
    how: ["Import demos into the Demo Library.", "Validate them and build a dataset.", "Train and evaluate a model on held-out matches.", "Run it in shadow mode and compare it with the director."],
    needs: ["Python 3.11 or later with the worker dependencies", "Disk space for demos and datasets"],
    status: <>The pipeline is tested on five real 2023 demos. Demos from the current game build haven't been tested yet, and no model has been approved to influence cuts.</>,
    faqs: [{ q: "Will a trained model ever move the camera on its own?", a: <p>Not today. Learned models run in shadow mode only; live cuts come from the rule-based director.</p> }],
  },
];

export const featureBySlug = (slug: string): Feature | undefined => FEATURES.find((f) => f.slug === slug);
