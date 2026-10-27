import { Icon } from "../../components/icons.tsx";
import { Callout, CheckList, CtaBand, PageHero, Screenshot, SectionHead, Spotlight } from "../../components/marketing.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

const JUMP = [
  { id: "huds", label: "HUDs for OBS" },
  { id: "director", label: "Auto director" },
  { id: "camera", label: "Camera control" },
  { id: "replays", label: "Replays & OBS" },
  { id: "admin", label: "Match administration" },
  { id: "multi-pc", label: "Multi-PC" },
  { id: "offline", label: "Offline-first" },
  { id: "requirements", label: "Requirements" },
];

const REQUIREMENTS: [string, string][] = [
  ["Operating system", "Windows 10 or Windows 11, 64-bit (x64). The installer sets up the program for the current user."],
  ["OBS Studio", "Version 30 or later, with its built-in WebSocket server (obs-websocket 5) enabled for scene, replay and source control. HUDs are added as browser sources."],
  ["Counter-Strike 2", "An observer or spectator client on the same computer or the local network. The program writes the Game State Integration config for you."],
  ["Network", "Internet access to link the computer, refresh its licence and upload auto-director usage. A local network for extra operator positions."],
  ["Account", "Optional for HUDs, manual direction, replays and administration. Needed for automatic direction on live matches (Free plan included)."],
];

export function Product() {
  useTitle("Product", "What the Matchframe program does: HUDs for OBS, an auto director with manual takeover and emergency stop, observer camera control, replays, match and veto administration, multi-PC positions. System requirements included.");
  const { me } = useSession();
  return (
    <>
      <PageHero eyebrow="The Matchframe program" title="One program for the whole production desk" lead="Matchframe runs on your Windows production computer and brings the broadcast together: graphics, camera direction, replays and the running order. This website only manages the account, plan and hours behind it.">
        {me ? (
          <Link to="/download" className="btn btn-primary btn-lg">
            Download for Windows
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Create a free account
          </Link>
        )}
        <a href="#requirements" className="btn btn-secondary btn-lg">
          System requirements
        </a>
      </PageHero>

      <nav className="jump" aria-label="On this page">
        <div className="wrap">
          <ul>
            {JUMP.map((j) => (
              <li key={j.id}>
                <a href={`#${j.id}`}>{j.label}</a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="wrap section spotlights">
        <Spotlight
          id="huds"
          eyebrow="HUDs for OBS"
          title="Broadcast graphics that publish like software"
          shot={<Screenshot name="huds-outputs" alt="The HUDs & Composer screen: a list of outputs, the draft settings of the main program HUD and a live preview of the published HUD." caption="HUDs & Composer: outputs, drafts and live preview. Simulated data." />}
        >
          <p>Each output is one browser source with its own URL and access token. Edit a draft, preview it, publish when you're ready and roll back instantly if something looks wrong.</p>
          <CheckList
            items={[
              "Built-in Classic, Minimal and Arena presets with pre-match, veto, live, post-map, standings and bracket variants",
              "Import your own HUD package; files and permissions are checked first",
              "Delayed outputs never show information ahead of the delayed programme feed",
              "Outputs only receive the public match picture, never operator data",
            ]}
          />
        </Spotlight>

        <Spotlight
          id="director"
          eyebrow="Auto director"
          title="Automatic direction, with a human in charge"
          reverse
          shot={<Screenshot name="live-control" alt="Live Control: player cards, the point-of-view panel with confirmed, last commanded and wanted shots, operator actions and the director panel with its modes." caption="Live Control with director modes and operator actions. Simulated match data." />}
        >
          <p>The director reads the live game, anticipates fights, crossfires and utility, and picks the next shot with the reasons on screen. Choose how much it may do: off, advisory (it only recommends), assisted or fully automatic.</p>
          <CheckList
            items={[
              "Manual takeover: the operator's choice sticks until automation is resumed",
              "Emergency stop with F8 or Pause in the program, Ctrl+Shift+F12 anywhere in Windows, or the Automation menu",
              "Always starts disarmed; automation is armed deliberately from Live Control",
              "When hours run out, the current map is finished and the camera is handed back at the map change",
            ]}
          />
        </Spotlight>

        <Spotlight
          id="camera"
          eyebrow="Observer camera control"
          title="One verified channel to the observer client"
          shot={<Screenshot name="maps-cameras" alt="The Maps & Cameras screen: map packs, a schematic outline of Inferno with named regions and the cameras authored for the map." caption="Maps & Cameras: map regions and operator-validated cameras." />}
        >
          <p>Matchframe moves the observer camera through a direct console connection or keyboard input to the focused CS2 window. A single control channel means the operator, the director and remote positions never fight over the camera.</p>
          <CheckList
            items={[
              "Player cuts confirmed from what the observer client actually shows",
              "Cinematic static cameras authored with getpos and validated by an operator",
              "Telemetry goes stale? Control falls back to the operator",
              "No memory reading, injection or anti-cheat evasion",
            ]}
          />
        </Spotlight>

        <Spotlight
          id="replays"
          eyebrow="Replays and OBS"
          title="Replays and scenes without leaving the desk"
          reverse
          shot={<Screenshot name="setup" alt="The Setup checklist in the program with steps to choose the source, detect CS2, write the GSI config and wait for a real payload." caption="The setup checklist connects CS2, OBS and your HUD step by step." />}
        >
          <p>Matchframe connects to OBS over its WebSocket API: scenes, sources, audio, recording and streaming. Bookmark moments from the replay buffer, approve them in a queue and play them out, then return live with one action.</p>
          <CheckList items={["Programme scene mapping for live, replay, break and more", "Replay playout confirmed from OBS media status", "Player cameras routed to the mixer with consent and delay alignment", "Stream Deck and Companion control surface with tally"]} />
        </Spotlight>

        <Spotlight
          id="admin"
          eyebrow="Match administration"
          title="Events, vetoes and sponsors"
          shot={<Screenshot name="matches-veto" alt="The Matches & Veto screen with a veto board, its result, revisions and captain links." caption="Veto with captain links and an audited history. Simulated teams." />}
        >
          <p>Keep teams, players, series rules and the running order in the program. Captains veto from a link scoped to their own turns, and every revision stays in the history.</p>
          <CheckList items={["Single-elimination brackets and standings for studio graphics", "Sponsor rotations with delivery acknowledgements", "Automation rules for routine production moments", "Event export and restore between computers"]} />
        </Spotlight>
      </div>

      <section className="section section-alt" aria-labelledby="more-title">
        <div className="wrap">
          <div className="tile-grid">
            <article className="tile" id="multi-pc">
              <span className="feature-icon">
                <Icon name="network" />
              </span>
              <h3 className="feature-title">Multi-PC operator positions</h3>
              <p>Install the program on extra computers and connect them to the production computer with role-scoped tokens: a replay operator, a graphics operator or a producer, each with the access their role needs.</p>
            </article>
            <article className="tile" id="offline">
              <span className="feature-icon">
                <Icon name="offline" />
              </span>
              <h3 className="feature-title">Offline-first</h3>
              <p>HUDs, manual and advisory direction, replays, administration and the simulation work without an account or internet. Only automatic direction on live matches uses auto-director hours, and a fetched licence keeps working offline for up to seven days.</p>
            </article>
            <article className="tile" id="models">
              <span className="feature-icon">
                <Icon name="model" />
              </span>
              <h3 className="feature-title">Demo-trained models</h3>
              <p>An offline pipeline turns CS2 demos into datasets and trains models that you can evaluate in shadow mode next to the director. Learned models never drive the live camera.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="requirements-title" id="requirements">
        <div className="wrap two-col-lg">
          <div>
            <SectionHead id="requirements-title" eyebrow="System requirements" title="What you need" lead="Matchframe is light on its own. Size the production computer for CS2 and OBS encoding, which do the heavy lifting." />
            <Callout title="Good to know">
              <p>
                Automatic camera control needs the in-program setup tests to pass on your observer client: the player-selection test for player cuts, and the static camera test with operator-validated cameras for cinematic shots. Until then the director runs in advisory mode and recommends shots without moving the camera.
              </p>
              <p>The installer isn't code-signed yet, so Windows SmartScreen asks for confirmation. The download page shows a SHA-256 checksum to check first.</p>
            </Callout>
          </div>
          <dl className="spec-list">
            {REQUIREMENTS.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <CtaBand title="Try it on your next rehearsal" text="The built-in simulation lets your crew practise with HUDs, replays and the director before a real match, clearly labelled as simulated everywhere.">
        {me ? (
          <Link to="/download" className="btn btn-primary btn-lg">
            Download the program
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Get started free
          </Link>
        )}
        <Link to="/pricing" className="btn btn-on-dark btn-lg">
          See pricing
        </Link>
      </CtaBand>
    </>
  );
}
