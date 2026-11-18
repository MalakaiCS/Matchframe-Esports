import type { ReactNode } from "react";
import { Icon } from "../components/icons.tsx";
import type { IconName } from "../components/icons.tsx";
import { Included, NotIncluded } from "../components/marketing.tsx";
import type { ShotName } from "../components/marketing.tsx";
import { Link } from "../router.tsx";

/**
 * Product capabilities shown on /features and /features/:slug. Facts follow CHANGELOG.md,
 * docs/release-notes, docs/architecture/decisions.md (ADR-072 to 083) and docs/operations/*.md:
 * describe what the program does, mark experimental parts, and say plainly what hasn't been tried
 * on a real CS2 match yet. Only the Auto Director's camera-moving modes use hours; Full Action
 * Observer needs the top plan; everything else is on every plan.
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
  /** Short tags for the picture of a capability without a screenshot. */
  tags?: string[];
  what: ReactNode;
  /** Extra sections shown after "What it does", each with its own heading. */
  sections?: { id: string; title: string; body: ReactNode }[];
  how: string[];
  needs: ReactNode[];
  /** Early-access note specific to this capability (what has and hasn't been tried). */
  status?: ReactNode;
  faqs: FeatureFaq[];
}

/** The Observer modes of the Auto Director, from "never moves the camera" to nade cameras. */
export const OBSERVER_MODES: { id: string; name: string; icon: IconName; text: string; note: string }[] = [
  { id: "off", name: "Off", icon: "stop", text: "MatchFrame never moves the camera. Shot suggestions stay visible in Live Control for your observer to use.", note: "Uses no hours" },
  { id: "observer", name: "Observer", icon: "director", text: "Does the observing: switches between player POVs automatically, cutting to a fight before it starts.", note: "Uses auto-director hours on live matches" },
  { id: "cinematics", name: "Observer & Cinematics", icon: "camera", text: "Observing plus cinematic shots from map cameras: team shots in freeze time, bomb plant and defuse shots, and overviews of big fights.", note: "Same hourly rate as Observer" },
  { id: "full-action", name: "Full Action Observer", icon: "grenade", text: "Everything above plus nade cameras: static cameras that catch smokes, flashes, molotovs and incendiaries, and HE grenades as they land.", note: "Same hourly rate · top plan only" },
];

type ModeCell = boolean | string;

/** What each mode does, in OBSERVER_MODES order (Off, Observer, Observer & Cinematics, Full Action Observer). */
const MODE_COMPARISON: [string, ModeCell[]][] = [
  ["Shot suggestions in Live Control", [true, true, true, true]],
  ["Moves the camera", [false, true, true, true]],
  ["Switches between player POVs", [false, true, true, true]],
  ["Team shots and the buy story in freeze time", [false, false, true, true]],
  ["Bomb plant and defuse shots", [false, false, true, true]],
  ["Overviews of big fights", [false, false, true, true]],
  ["Nade cameras: smokes, flashes, molotovs and HE grenades as they land", [false, false, false, true]],
  ["Auto-director hours on live matches", ["None", "Yes", "Yes, same rate", "Yes, same rate"]],
  ["Simulation (rehearsal)", ["Free", "Free", "Free", "Free"]],
  ["Setup in the program", ["Nothing extra", "A passed player-selection test", "Plus the map's cameras and a passed static camera test", "Plus nade cameras"]],
  ["Plans", ["Every plan", "Every plan with auto-director hours", "Every plan with auto-director hours", "Top plan only"]],
];

function ModeCards() {
  return (
    <ul className="feature-grid cols-2 mode-grid">
      {OBSERVER_MODES.map((m) => (
        <li key={m.id} className="feature" id={`mode-${m.id}`}>
          <span className="feature-icon">
            <Icon name={m.icon} />
          </span>
          <h3 className="feature-title">{m.name}</h3>
          <p className="feature-text">{m.text}</p>
          <p className="mode-note">{m.note}</p>
        </li>
      ))}
    </ul>
  );
}

function ModeComparison() {
  return (
    <div className="table-scroll" role="region" aria-label="Observer modes compared" tabIndex={0}>
      <table className="cmp-table cmp-modes">
        <caption className="visually-hidden">What each Observer mode does</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Feature</span>
            </th>
            {OBSERVER_MODES.map((m) => (
              <th scope="col" key={m.id}>
                {m.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MODE_COMPARISON.map(([label, cells]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {cells.map((c, i) => (
                <td key={OBSERVER_MODES[i]!.id}>{typeof c === "string" ? c : c ? <Included /> : <NotIncluded />}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const EARLY_ACCESS = (
  <>
    MatchFrame is in early access. Every version is tested automatically with synthetic Game State Integration data, a labelled simulation, real OBS and real CS2 demos, and its Windows installer is built and smoke-tested on a Windows runner. Real CS2 telemetry ingest and real observer camera control haven't yet been verified on a real CS2 client by our tests, and parts marked experimental are new, so run the in-program checklist and a rehearsal before a live match.
  </>
);

export const FEATURES: Feature[] = [
  {
    slug: "huds",
    title: "HUDs",
    nav: "HUDs",
    icon: "hud",
    tagline: "Broadcast HUDs for OBS and over the game, led by the Stage HUD.",
    summary: "Four broadcast HUDs come with the program: Stage, Vector, Lineup and the MatchFrame Broadcast HUD. Run any of them as an OBS browser source or as a transparent window over CS2, import hud.json HUDs, and add your own pictures, trophy and icon pack.",
    highlights: ["Stage HUD: a tournament-stage layout with the round MVP card", "OBS browser source or a transparent window over the game", "Import hud.json HUDs and MatchFrame HUD packages"],
    shot: { name: "console-hud-library", alt: "The HUD Library in the MatchFrame program: Lineup, MatchFrame Broadcast, Stage and Vector HUDs as cards with their thumbnails, each ready with Launch Transparent HUD and its OBS, preview and settings buttons.", caption: "The HUD Library in the program. Real screenshot; the match data is simulated." },
    what: (
      <>
        <p>The program opens on the HUD Library: the HUDs installed on this computer, each with its settings, a preview, its OBS browser-source address and a button to show it over the game. HUDs, their settings and test data work without an account.</p>
        <ul>
          <li>
            <strong>
              <Link to="/stage-hud">Stage HUD</Link>:
            </strong>{" "}
            a tournament-stage layout on royal-blue panels, with side-coloured player cards, the round MVP card and a full-width scoreboard in timeouts and pauses.
          </li>
          <li>
            <strong>Vector</strong> puts each team down its side of the screen; <strong>Lineup</strong> puts all ten players in one row along the bottom.
          </li>
          <li>
            <strong>MatchFrame Broadcast HUD</strong> with its Classic, Minimal and Arena presets.
          </li>
          <li>
            <strong>Import</strong> HUDs in the hud.json format (they run unchanged in a compatibility layer) or MatchFrame HUD packages, as a ZIP or a folder.
          </li>
          <li>
            <strong>Desktop HUD:</strong> any HUD as a transparent, click-through window over CS2 in fullscreen windowed mode, on this computer.
          </li>
          <li>
            <strong>HUD images:</strong> default player pictures, map pictures and logos, the dead-player icon and a trophy. An <strong>icon pack</strong> lets you load CS2's own weapon icons on your computer for your broadcast; they're never shipped with MatchFrame.
          </li>
          <li>Each MatchFrame HUD has its own replay graphic. Imported HUDs and their settings are shared with every computer in your organisation.</li>
        </ul>
      </>
    ),
    how: ["Pick a HUD in the HUD Library and set its colours, texts and pictures.", "Choose Copy OBS Browser URL and add it to OBS as a 1920×1080 Browser Source, or let the program add the source.", "Or choose Launch Transparent HUD to show it over CS2 on this computer.", "Activate your match so the HUD shows the teams, logos and series."],
    needs: ["OBS Studio 30 or later for browser sources (or the desktop HUD alone)", "The program on the computer that runs the HUD", "No account or hours needed"],
    status: <>HUDs are rendered and checked automatically in Chromium, the browser engine OBS uses for browser sources. Imported HUDs run in a compatibility layer; tell us if one doesn't look right.</>,
    faqs: [
      { q: "Do HUDs use auto-director hours?", a: <p>No. HUDs work on every plan, including Free, and without an account.</p> },
      { q: "Can I use my own HUD design?", a: <p>Yes. Import a hud.json HUD or a MatchFrame HUD package with Add HUD in the HUD Library. The package format is documented, with a small working example to start from.</p> },
      { q: "Can players' faces be shown?", a: <p>Yes: add player pictures to your players, or default pictures in HUD images. With <Link to="/features/player-cams">player cams</Link> on air, the Stage HUD shows the observed player's camera.</p> },
      { q: "Why aren't CS2's own icons included?", a: <p>They belong to Valve and aren't licensed for a paid product. MatchFrame's HUDs come with their own icons; with the icon pack you can load CS2's icons on your own computer for your own broadcast.</p> },
    ],
  },
  {
    slug: "auto-director",
    title: "Auto Director",
    nav: "Auto Director",
    icon: "director",
    tagline: "Automatic observing that cuts before the fight and explains every shot.",
    summary: "The Auto Director moves the CS2 observer camera for you: it cuts to a fight before it starts, follows clutches with short looks at the hunters, tells the buy story in freeze time and adds cinematic shots. Choose how much it does with the Observer modes, take the camera back at any moment and stop everything with one key.",
    highlights: ["Off, Observer, Observer & Cinematics and Full Action Observer", "Cuts before the fight; clutch looks at the hunters", "Sticky manual takeover and an emergency stop"],
    shot: { name: "console-live-control", alt: "Live Control in the MatchFrame program: player cards for both simulated teams, the Auto Director on air in Observer & Cinematics with its checks passed, the camera on air and the Observer mode selector.", caption: "Live Control with the Auto Director on air in Observer & Cinematics. Real screenshot; the match data is simulated." },
    what: (
      <>
        <p>The Auto Director reads the live game and picks the shot, then shows its reasons and the best alternatives in Live Control.</p>
        <ul>
          <li>
            <strong>Cuts before the fight:</strong> it knows when opponents will see each other in the next moment and gets there before the shooting.
          </li>
          <li>
            <strong>Clutches:</strong> in a 1vX it stays with the clutcher, takes short looks (2 to 4 seconds) at a hunter closing in, planting or defusing, and is back before the fight.
          </li>
          <li>
            <strong>Freeze time tells the buy story:</strong> each team's buy is read (pistol, eco, force, half, full or anti-eco) and the shots follow it: a closer look at a force buy, an eco against a full buy shown in turn.
          </li>
          <li>
            <strong>Cinematics:</strong> team shots, bomb plant and defuse shots, overviews of big fights, round winners, half time and map end, from built-in cameras checked against each map's geometry. With HLAE (a free tool) every shot glides smoothly, including camera paths.
          </li>
          <li>
            <strong>Nade cameras</strong> on the top plan catch utility as it lands.
          </li>
        </ul>
        <p>In every mode the operator stays in charge:</p>
        <ul>
          <li>
            <strong>Manual takeover:</strong> any manual camera action makes control manual and sticky; pending automated commands are cancelled.
          </li>
          <li>
            <strong>Emergency stop:</strong> the on-screen button, <kbd>F8</kbd> or <kbd>Pause</kbd> in the program, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F12</kbd> anywhere in Windows, or the Automation menu.
          </li>
          <li>
            <strong>Safe defaults:</strong> the program always starts with automation off; if the game data stops, control falls back to the operator.
          </li>
        </ul>
        <p>
          Observer, Observer &amp; Cinematics and Full Action Observer use <Link to="/how-it-works#metering">auto-director hours</Link> at the same rate, and only while automation actually controls the camera on a live match. The simulation is free in every mode. When hours run out, the current map is finished and the camera is handed back at the map change.
        </p>
      </>
    ),
    sections: [
      { id: "modes", title: "The Observer modes", body: <ModeCards /> },
      {
        id: "compare-modes",
        title: "Compare the modes",
        body: (
          <>
            <ModeComparison />
            <p className="small muted mode-foot">
              Built-in cameras cover the main map pool; you can add your own with <code>getpos</code> in Maps &amp; Cameras. The static camera test must pass on your CS2 build before cinematics run. See which plan includes Full Action Observer on the <Link to="/pricing">pricing page</Link>.
            </p>
          </>
        ),
      },
      {
        id: "cameras",
        title: "How it moves the camera",
        body: (
          <div className="prose">
            <p>Game State Integration carries game data only; it can't move the camera. MatchFrame uses a separate channel to the CS2 observer client on the same computer: CS2's console (the Observer tools launch mode, which needs the free CS2 Workshop Tools), HLAE for smooth camera moves, or keyboard input to the focused CS2 window.</p>
            <p>One writer controls the camera at a time, a command only counts once the game shows the new view, and automatic control stays blocked until the player-selection test passes on your CS2 build. No memory reading, code injection or anti-cheat evasion is used.</p>
          </div>
        ),
      },
    ],
    how: [
      "Start CS2 from the program in the Observer tools mode (or Observer tools + HLAE for smooth moves).",
      "Press Start Auto Director: it checks the console, the game data, your hours, player switching and the map's cameras.",
      "Choose Observer, Observer & Cinematics or Full Action Observer, and the options you want (cinematic cameras, chase cam, clutch mode).",
      "Take over whenever you like; resume automation when you're ready.",
    ],
    needs: [
      "A CS2 observer client on the same computer as MatchFrame, with a passed player-selection test",
      "Signed in, with auto-director hours for the camera-moving modes on live matches; Full Action Observer needs the top plan",
      "Off, manual direction and the simulation: no hours needed",
    ],
    status: <>The director is tested end to end in the labelled simulation, on real CS2 demos and on maps' real geometry. Clutch looks, the buy story and early replays are new in 0.13 and haven't yet been tried in a real CS2 match.</>,
    faqs: [
      { q: "Which mode should I start with?", a: <p>Start in Off and watch the shot suggestions during a rehearsal. Move to Observer once you trust the setup, then Observer &amp; Cinematics once the map's cameras pass their test. Full Action Observer adds nade cameras on the top plan.</p> },
      { q: "Do all the modes use the same hours?", a: <p>Observer, Observer &amp; Cinematics and Full Action Observer all use auto-director hours at the same rate, and only while automation actually controls the camera on a live match. Off, manual direction and the simulation are free in every mode.</p> },
      { q: "What happens if we change plan during a match?", a: <p>Automation is never cut mid-map. The program picks up a plan change within 15 minutes; if the new plan doesn't include Full Action Observer, it switches to Observer &amp; Cinematics at the next map change.</p> },
      { q: "Is there a language model in the cut loop?", a: <p>No. Live decisions come from the rule-based director, with explainable scores. Models trained from demos only run in shadow mode for comparison and never move the camera.</p> },
      { q: "What happens if the game data stops?", a: <p>If game data is stale for more than a few seconds, the command in flight is cancelled, control goes back to the operator and an alert is raised.</p> },
      { q: "Will it resume on its own after I take over?", a: <p>No. After a takeover, automation only resumes when an operator chooses Resume automation.</p> },
    ],
  },
  {
    slug: "replays",
    title: "Replays",
    nav: "Replays",
    icon: "replay",
    tagline: "Every kill filmed, the best ones on air between rounds, slowed at the kill.",
    summary: "A second PC watches the match a few seconds behind and films every kill it has time for. Between rounds the program plays the best clips back to back with fades, slowed around the kill, and can start early once the round is decided. Highlights go on air at half time and become a reel for social media.",
    highlights: ["A replay PC films every kill it has time for", "Slow motion, and early replays when the round is decided", "Highlights on air and highlight reels"],
    shot: { name: "console-auto-replays", alt: "Replays in the MatchFrame program: Automatic replays on, with Start replays early when the round is decided, the best 4 clips per break in round order, back to live by 1:50 on the round clock, fades, and the Replay PC panel with the NDI replay feed.", caption: "Automatic replays and the replay PC. Real screenshot; the match data is simulated." },
    what: (
      <>
        <ul>
          <li>
            <strong>Replay PC:</strong> a second computer with its own CS2 watches the same match a few seconds later. It knows each kill before it happens there and films it from the killer's view. Its picture reaches the main PC over NDI (recorded and cut there), or as clips from its own OBS.
          </li>
          <li>
            <strong>Between rounds:</strong> the best clips of the round that fit (up to 4) play back to back, fading from one to the next, until the next round's clock reads 1:50. The replay graphic names the player, weapon, victims and multi-kill or clutch.
          </li>
          <li>
            <strong>Slow motion</strong> at the kill moment (or the whole clip), at 50% or 33% speed, on by default.
          </li>
          <li>
            <strong>Early replays:</strong> up to 10 seconds before the round ends, when the bomb is down and no CT can defuse in time, or the Ts can't plant before time runs out. Never during a fight, and back to live at once if the round heats up again.
          </li>
          <li>
            <strong>Multi-angle replays (experimental):</strong> the replay PC goes back and films the round's top kill again from the victim's view or a still camera.
          </li>
          <li>
            <strong>Highlights:</strong> a map's best clips on air, then back to your own scene; and one button for a highlight reel MP4.
          </li>
          <li>Without a replay PC, the main PC can still replay big plays its own camera showed (a 3K or more, a won clutch) from the OBS replay buffer.</li>
        </ul>
      </>
    ),
    how: ["On the replay PC, install MatchFrame and CS2 and send its screen over NDI (or use its OBS).", "On the main PC, download ffmpeg in the program and choose the replay PC's NDI source.", "Link the two with a replay PC code.", "Turn on Play replays by themselves, and pick slow motion and early replays."],
    needs: ["A second Windows PC with CS2 and MatchFrame for the replay PC", "OBS Studio 30 or later, or vMix, on the main PC", "ffmpeg, downloaded and checked by the program", "No hours needed"],
    status: <>Replays are tested against real OBS on Linux with stand-ins for CS2. Multi-angle replays are experimental and haven't been tried against a real CS2 server; early replays haven't yet been tried in a real CS2 match.</>,
    faqs: [
      { q: "Do I need a second PC for replays?", a: <p>For every kill, yes: the replay PC films what the live camera missed. With one PC, the program can replay big plays its own camera showed from the OBS replay buffer.</p> },
      { q: "Can replays run into the next round?", a: <p>Yes, until the next round's clock reads 1:50, and never once the bomb is planted. You choose how many clips a break holds.</p> },
      { q: "Do replays use hours?", a: <p>No. Replays, highlights and reels work on every plan.</p> },
    ],
  },
  {
    slug: "map-intros",
    title: "Map intros",
    nav: "Map intros",
    icon: "film",
    tagline: "One video per map, played by itself at the moment you pick.",
    summary: "Add an intro video for each map and a default for the rest. MatchFrame plays it once per map at the moment you choose (map load, knife round, pistol round or the match going live), then goes back to the scene it came from.",
    highlights: ["A video per map, plus a default", "Starts on map load, knife or pistol round, or match live", "Live Control buttons, a hotkey and Stream Deck actions"],
    shot: { name: "console-map-intros", alt: "Map intros in the MatchFrame program: Start the intro at Pistol round start, cut back to the game if the round goes live, and a list of maps with intro videos added for Ancient, Dust II and Inferno, each with its length, codec, size and frame rate.", caption: "Map intros, with sample videos added. Real screenshot; the match data is simulated." },
    what: (
      <>
        <ul>
          <li>One row per map: Ancient, Anubis, Dust II, Inferno, Mirage, Nuke, Overpass, Train, Vertigo and Cache, and a default for maps without their own.</li>
          <li>MP4 or MOV in the codecs OBS and vMix play, checked before it's kept, with its frame, length and notes such as no sound or see-through video.</li>
          <li>Start it manually, when the map loads, at the knife round, at the pistol round (the default), at both pistol rounds, or when the match goes live.</li>
          <li>It plays once per map, only in warmup or freeze time. If the round goes live during the intro, it cuts back to the game, unless you choose to finish the intro.</li>
          <li>MatchFrame makes its own map intro scene in OBS and uses your MatchFrame stinger if you have one. vMix works too.</li>
        </ul>
      </>
    ),
    how: ["Open Replays & Production → Map intros and add a video per map.", "Pick when intros start.", "Play map intro and Play next map's intro are in Live Control, on a hotkey and on Stream Deck."],
    needs: ["OBS Studio 30 or later, or vMix", "ffmpeg to check the videos (the program can download it)", "No hours needed"],
    status: <>Map intros are tested with stand-ins for OBS and vMix and with simulated game data. Knife rounds are recognised from the players' loadouts in the observer's game data.</>,
    faqs: [
      { q: "Are intros shared between our computers?", a: <p>No. Video files are large, so each computer keeps its own. Add them on the computer that plays them, normally the production PC.</p> },
      { q: "What if a map has no intro?", a: <p>The default intro plays, if you've added one. Otherwise nothing plays for that map.</p> },
    ],
  },
  {
    slug: "team-comms",
    title: "Team Comms",
    nav: "Team Comms",
    icon: "headset",
    tagline: "Both teams' TeamSpeak, per person, delayed and safe to put on air.",
    summary: "A TeamSpeak 3 plugin hands each player's voice to MatchFrame, which delays it with the broadcast and mixes it per output. Listen in on one team on air, hear both privately, and record both teams' comms on their own.",
    highlights: ["Each person's voice, delayed with the broadcast", "Listen in on air with one button, mute all instantly", "A dedicated comms recording with a speaker strip"],
    tags: ["TeamSpeak 3", "Per person", "Delayed", "Listen In", "Mute All Comms", "NDI audio to OBS", "Comms recording"],
    what: (
      <>
        <ul>
          <li>The plugin captures each person's decoded voice in TeamSpeak 3. Listeners are listen-only and never transmit.</li>
          <li>You choose who is heard on each team; anyone you leave out is cut at once.</li>
          <li>
            <strong>On air:</strong> Listen In on one team, End Listen-In and Mute All Comms. The public mix reaches OBS as an NDI audio source, with casters ducked, and a TEAM COMMS overlay shows which team you hear.
          </li>
          <li>
            <strong>Private preview</strong> of either team in the operator's headphones.
          </li>
          <li>
            <strong>Recording:</strong> both teams' comms recorded in a scene MatchFrame sets up, with a speaker strip that lights up who is talking, kept in time with the gameplay.
          </li>
          <li>Reconnects safely: a TeamSpeak restart never plays a team on the PC or reopens the listen-in by itself.</li>
        </ul>
      </>
    ),
    how: ["Install the MatchFrame plugin in TeamSpeak 3 on the comms PC (the program offers it).", "Connect TeamSpeak to each team's channel; the plugin keeps you listen-only.", "Pick the players to include in Live Control → Team Comms.", "Add the NDI audio source in OBS and use Listen In when it's safe to air."],
    needs: ["TeamSpeak 3 with the MatchFrame plugin", "OBS with an NDI plugin (DistroAV) for the on-air mix", "No hours needed"],
    status: <>Tested with real TeamSpeak, OBS and NDI on Linux, including 45-minute soaks with both teams talking. Not yet tried on a Windows production PC.</>,
    faqs: [{ q: "Can a team's comms leak on air by mistake?", a: <p>Comms are closed until an operator chooses Listen In, the other team never plays in that mix, and Mute All Comms closes everything at once. If the bridge to TeamSpeak drops, the public listen-in closes and stays closed.</p> }],
  },
  {
    slug: "player-cams",
    title: "Player cams",
    nav: "Player cams",
    icon: "video",
    tagline: "Players' webcams on the HUD, from a link, with no extra software.",
    summary: "Send each team a link. Players open it in their browser, pick themselves and their camera, and send. You approve each cam, delay it with the broadcast and put it on air: the Stage HUD shows the observed player's cam.",
    highlights: ["A browser link for players: no install", "Delayed with the broadcast, approved by you", "In the HUD or as their own OBS sources"],
    tags: ["Browser link", "No install", "Delay up to 5 min", "You approve", "On the HUD", "OBS sources"],
    what: (
      <>
        <ul>
          <li>Players open the link you send on this website, choose their name and camera, preview and send. The camera keeps sending while the game is in front.</li>
          <li>The video passes through our relay in memory only; it isn't stored.</li>
          <li>The program delays each cam (up to 5 minutes) to match the broadcast, and you approve, put on air or take off air each one.</li>
          <li>MatchFrame's HUDs show the observed player's cam; each cam also has its own OBS address, and imported HUDs that support cams get them too.</li>
        </ul>
      </>
    ),
    how: ["Open Cameras → Player cameras and copy the link.", "Send it to the players.", "Approve each cam, set the delay and put them on air."],
    needs: ["The program signed in to your MatchFrame account (the cams use our relay)", "Players: a current browser with a webcam", "No hours needed"],
    faqs: [{ q: "Do players need an account?", a: <p>No. The link is all they need, and you can make a new one at any time to close the old.</p> }],
  },
  {
    slug: "match-admin",
    title: "Matches, teams and players",
    nav: "Matches",
    icon: "trophy",
    tagline: "Teams, players, series and vetoes, with thumbnails and stingers made for every match.",
    summary: "Keep teams, players, events and matches in the program, run the map veto with captain links, and get thumbnails, an up-next screen and stingers made for every match in the teams' colours.",
    highlights: ["Veto with captain links and full history", "Thumbnails, up-next screen and stingers per match", "Shared with every computer in your organisation"],
    tags: ["Teams", "Players", "Series", "Map veto", "Captain links", "Thumbnails", "Stingers", "Brackets", "Sponsors"],
    what: (
      <>
        <ul>
          <li>Teams and players with logos, pictures and colours (SteamID64 kept exact), rosters and bulk import; a team's players stay with it when sides swap.</li>
          <li>Events, series in best-of formats with round rules, standings and single-elimination brackets.</li>
          <li>Map veto: captain links scoped to one match and team, a veto overlay, and a history where corrections are recorded.</li>
          <li>
            <strong>For every match:</strong> highlights, full-replay and live thumbnails (1280×720), an up-next screen (1920×1080) and two transparent stingers, one for scene changes and one for replays, in the teams' colours and logos.
          </li>
          <li>Sponsors in safe windows that never cover live fights, with each display logged.</li>
          <li>Account sync shares teams, players, matches and imported HUDs with every computer in your organisation, and works offline.</li>
        </ul>
      </>
    ),
    how: ["Add teams and players, or import them.", "Create the match and its format.", "Send captain links and run the veto.", "Activate the match so HUDs show the teams, logos and series."],
    needs: ["The program only: no hours needed", "Signed in for account sync between computers"],
    faqs: [
      { q: "How secure are captain links?", a: <p>Each link is a token scoped to one match and one team. Captains only see the veto and can only act on their own turns. Links can be revoked at any time.</p> },
      { q: "Can sponsors appear during a fight?", a: <p>No. Sponsor slots use safe windows that avoid live fights, and each display is logged when the HUD shows it.</p> },
    ],
  },
  {
    slug: "integrations",
    title: "OBS, vMix and Stream Deck",
    nav: "Integrations",
    icon: "sliders",
    tagline: "Your switcher and your buttons, driven by the match.",
    summary: "MatchFrame drives OBS over its WebSocket and works with vMix for replays, map intros and highlights. Stream Deck and Companion get named actions with tally, so the crew can run the show from buttons.",
    highlights: ["OBS scenes follow the match: live, replay, break, studio", "vMix for replays, intros and highlights", "Stream Deck and Companion actions with tally"],
    tags: ["OBS 30+", "Scene automation", "vMix", "Stream Deck", "Companion", "Tally"],
    what: (
      <>
        <ul>
          <li>
            <strong>OBS:</strong> scenes mapped to live, replay, studio and break; timeouts and pauses to the break scene and map end to the studio scene; HUD, replay and map intro sources set up for you without replacing yours; a replay transition and stingers.
          </li>
          <li>It never switches over a scene you picked yourself, and after an OBS disconnect it reconnects without replaying old cues.</li>
          <li>
            <strong>vMix</strong> works too for replays, map intros and highlights, with its own transitions.
          </li>
          <li>
            <strong>Stream Deck and Companion:</strong> named actions with permissions and tally, for example take over, emergency stop, select a player, slow a replay, star a kill, play a map intro and play highlights.
          </li>
        </ul>
      </>
    ),
    how: ["Turn on the WebSocket server in OBS (Tools → WebSocket Server Settings).", "Connect it in Settings → Devices and map your scenes.", "For buttons, issue a control-surface token and set up Stream Deck or Companion."],
    needs: ["OBS Studio 30 or later (obs-websocket 5 is built in), or vMix", "Stream Deck or Companion for buttons (optional)", "No hours needed"],
    status: <>OBS control is tested against a real OBS 30 on Linux; vMix with a stand-in. Neither has been tested on Windows by our automated tests.</>,
    faqs: [{ q: "Will MatchFrame take over my OBS scenes?", a: <p>Only the moments you map. Automatic replays, intros and highlights never start over a scene you chose yourself, and they go back to where the program came from.</p> }],
  },
  {
    slug: "program",
    title: "One PC, two PCs or a crew",
    nav: "Setups and updates",
    icon: "cpu",
    tagline: "From a one-PC stream to a crew on a production network, kept up to date safely.",
    summary: "Run everything on one PC with low-spec mode, add a replay PC, or connect operator positions to the production computer. Updates come by themselves on the Stable or Beta channel, and you can go back to a previous version with your data kept safe.",
    highlights: ["Low-spec mode for CS2, OBS and MatchFrame on one PC", "Remote operator positions with role tokens", "Stable and Beta updates, and going back a version"],
    tags: ["Low-spec mode", "Replay PC", "Operator positions", "Account sync", "Stable · Beta", "Go back a version", "Crash reports: opt-in"],
    what: (
      <>
        <ul>
          <li>
            <strong>Low-spec mode (one PC):</strong> HUDs capped at 30 frames a second without heavy effects, MatchFrame's OBS browser sources at 30 fps, the engine's memory capped and background jobs waiting during live rounds. The program suggests it if your HUD stutters while CS2 runs on the same PC.
          </li>
          <li>
            <strong>Operator positions:</strong> other computers on the production network connect to the production computer with their own role token (for example observer or producer) and see only what that role allows.
          </li>
          <li>
            <strong>Account sync:</strong> teams, players, matches and imported HUDs are shared across your organisation's computers.
          </li>
          <li>
            <strong>Updates:</strong> downloaded in the background and installed when you restart, never during a broadcast. Choose the Stable or Beta channel.
          </li>
          <li>
            <strong>Go back to a previous version</strong> from Settings: the installer is checked, and the copy of your data that version can read is restored. It refuses if there isn't one.
          </li>
          <li>
            <strong>Crash reports are off</strong> unless you turn them on. When on, the support file (passwords, keys and tokens removed) and the error go to MatchFrame support, and you get a reference to quote.
          </li>
        </ul>
      </>
    ),
    how: ["One PC: turn on Settings → General → Performance → Low-spec mode.", "Operator positions: allow the local network on the production computer and issue a token per position in Settings → Devices.", "On each other computer: File → Connection settings → Connect to the production computer.", "Updates: pick the channel in Settings → General → Program."],
    needs: ["Windows 10 or 11 (64-bit) on each computer", "A local network between computers; ports 37210–37212 open to the production subnet only", "Signed in for account sync"],
    status: <>Low-spec mode is measured on Linux with the simulation; it hasn't been measured on Windows with CS2 and OBS running. Going back safely works for versions from 0.13.0 on.</>,
    faqs: [
      { q: "Can operators connect over the internet?", a: <p>Operator positions are designed for a local production network. Exposing the program to the internet isn't supported.</p> },
      { q: "Will an update interrupt a show?", a: <p>No. The program never restarts on its own. On event day, turn off automatic downloads in Settings → General → Program, then turn them back on afterwards.</p> },
    ],
  },
];

/** Earlier feature pages and where their content lives now. */
export const MOVED_FEATURES: Record<string, string> = {
  cameras: "auto-director#cameras",
  "utility-tracking": "auto-director",
  "demo-pipeline": "auto-director",
  "obs-replays": "replays",
  "multi-pc": "program",
};

export const featureBySlug = (slug: string): Feature | undefined => FEATURES.find((f) => f.slug === slug);
