import type { ReactNode } from "react";
import { Icon } from "../../components/icons.tsx";
import type { IconName } from "../../components/icons.tsx";
import { Callout, CheckList, CtaBand, DownloadButton, PageHero, SectionHead } from "../../components/marketing.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

const FLOW: { icon: IconName; title: string; text: string }[] = [
  { icon: "download", title: "Install", text: "Download the Windows installer from your account. HUDs, replays and intros work straight away, without an account." },
  { icon: "link", title: "Sign in", text: "Sign in to the program with your MatchFrame email and password for the Auto Director, player cams and account sync." },
  { icon: "card", title: "Buy or receive hours", text: "Plans include auto-director hours each period, and hour packs add more at any time." },
  { icon: "director", title: "Start the Auto Director", text: "Choose an Observer mode and press Start Auto Director. Hours are used only while it drives the camera on a live match." },
];

const OFFLINE: [string, ReactNode, ReactNode][] = [
  ["Every HUD, in OBS or over the game", "Yes", "Yes"],
  ["Manual direction and the Observer's Off mode (shot suggestions)", "Yes", "Yes"],
  ["Replays, the replay PC, highlights and map intros", "Yes", "Yes"],
  ["Team Comms, OBS, vMix and Stream Deck", "Yes", "Yes"],
  ["Match, veto and sponsor administration", "Yes", "Yes, shared with your other computers when you're back online"],
  ["Player cams", "Yes, signed in", "No: the cams use our relay"],
  ["Simulation and demo pipeline", "Yes", "Yes"],
  ["Observer and Observer & Cinematics on live matches", "Uses your plan's auto-director hours", "Yes, for up to 7 days after the last licence refresh"],
  ["Full Action Observer (nade cameras) on live matches", "Top plan only, same hourly rate", "Yes, for up to 7 days after the last licence refresh"],
];

/** The three ways to set up (Home links to each by id). */
const SETUPS: { id: string; icon: IconName; title: string; lead: string; points: ReactNode[]; more: { to: string; label: string } }[] = [
  {
    id: "one-pc",
    icon: "cpu",
    title: "One PC",
    lead: "CS2 as an observer, OBS and MatchFrame on one Windows computer: the simplest setup, and a good one for streams and rehearsals.",
    points: [
      <>
        Turn on <strong>Low-spec mode (one PC)</strong> in Settings → General → Performance: HUDs at 30 frames a second without heavy effects, MatchFrame's OBS sources at 30 fps, the engine's memory capped and background jobs paused during live rounds.
      </>,
      "The program suggests it once if your HUD stutters while CS2 runs on the same PC.",
      "Replays come from the OBS replay buffer: big plays the live camera showed, such as a 3K or a won clutch.",
    ],
    more: { to: "/features/program", label: "Setups and updates" },
  },
  {
    id: "two-pc",
    icon: "replay",
    title: "Two PCs: add a replay PC",
    lead: "A second computer with its own CS2 and MatchFrame watches the match a few seconds behind and films every kill it has time for.",
    points: [
      "Its screen reaches the main PC over NDI and is recorded there, or it sends clips from its own OBS.",
      "Between rounds the main PC plays the best clips back to back, slowed at the kill, and can start early once the round is decided.",
      <>
        Multi-angle replays film the round's top kill again from the victim's view or a still camera. <span className="badge">Experimental</span>
      </>,
    ],
    more: { to: "/features/replays", label: "Replays" },
  },
  {
    id: "crew",
    icon: "network",
    title: "A crew on a production network",
    lead: "Extra operators run the same program on their own computers and connect to the production computer.",
    points: [
      "Each position gets its own role token (for example observer or producer) and sees only what the role allows.",
      "Teams, players, matches and imported HUDs are shared across your organisation's computers with account sync.",
      "Stream Deck and Companion buttons drive the same actions, with tally.",
    ],
    more: { to: "/features/program", label: "Operator positions" },
  },
];

const SETUP: { id: string; title: string; where: string; body: ReactNode }[] = [
  {
    id: "account",
    title: "Create your account",
    where: "On this website",
    body: (
      <p>
        <Link to="/signup">Sign up</Link> and name your organisation, then open the confirmation link we email you. Purchases, invitations and linking computers wait until your address is verified. <Link to="/help/creating-an-account">More help</Link>
      </p>
    ),
  },
  {
    id: "install",
    title: "Download and install the program",
    where: "On each production computer",
    body: (
      <p>
        Download the installer from your account and check its SHA-256 checksum. Builds aren't code-signed yet, so Windows SmartScreen may warn: choose More info → Run anyway. Signed builds are coming. After that the program updates itself, on the Stable or Beta channel. <Link to="/help/installing-the-program">More help</Link>
      </p>
    ),
  },
  {
    id: "checklist",
    title: "Work through the setup checklist",
    where: "In the program",
    body: (
      <>
        <p>The program opens on the HUD Library. Settings → Setup has a checklist that only ticks a step once it has seen it working:</p>
        <ul>
          <li>Detect CS2 and write the Game State Integration config, then start CS2 as an observer (the program can start it for you).</li>
          <li>Wait for real game data and read the capability report.</li>
          <li>Connect OBS (or vMix), map your scenes and add a HUD's browser source.</li>
          <li>On one PC, consider low-spec mode; with a replay PC, link it with a replay PC code.</li>
        </ul>
      </>
    ),
  },
  {
    id: "link",
    title: "Sign in to the program",
    where: "In the program",
    body: (
      <p>
        Start the program and sign in with the same email and password as this website (or choose <strong>Sign in with a code from the website</strong> and approve it at <Link to="/link">/link</Link>). If you're in several organisations, pick the one this computer is for. <Link to="/help/linking-a-computer">More help</Link>
      </p>
    ),
  },
  {
    id: "plan",
    title: "Choose a plan or buy hours",
    where: "On this website",
    body: (
      <p>
        Every organisation starts on the Free plan. Move to a larger plan on Billing &amp; Subscription, or buy an hour pack for a one-off event. See <Link to="/pricing">pricing</Link>.
      </p>
    ),
  },
  {
    id: "team",
    title: "Invite your crew",
    where: "On this website and in the program",
    body: (
      <p>
        Invite producers and billing contacts on the Team page with the right role. Extra operator computers connect to the production computer with a role token issued in the program, and every computer signed in to your organisation shares teams, players, matches and imported HUDs. <Link to="/help/team-roles">More help</Link>
      </p>
    ),
  },
  {
    id: "live",
    title: "Go live",
    where: "In the program",
    body: (
      <p>
        Rehearse with the built-in simulation first. On a live match, watch the shot suggestions in Off, then press Start Auto Director and choose Observer, Observer &amp; Cinematics or Full Action Observer: it checks the console, the game data, your hours and player switching before it directs. Stop everything with <kbd>F8</kbd> in the program or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F12</kbd> anywhere in Windows.
      </p>
    ),
  },
];

export function HowItWorks() {
  useTitle("How it works", "How MatchFrame works: one PC with low-spec mode, two PCs with a replay PC, or a crew of operator positions; the program on your production PC and the website for your account and hours; metering only while automation drives the camera; what works offline.");
  const { me } = useSession();
  return (
    <>
      <PageHero eyebrow="How it works" title="The program runs the show. The website runs the account." lead="The Windows program on your production computer does all the broadcast work, on one PC or across a crew. This website keeps the account, plan and auto-director hours behind it.">
        <DownloadButton />
        <a href="#setups" className="btn btn-secondary btn-lg">
          Pick a setup
        </a>
      </PageHero>

      <section className="section" id="setups" aria-labelledby="setups-title">
        <div className="wrap">
          <SectionHead id="setups-title" eyebrow="Setups" title="One PC, two PCs or a whole crew" lead="Start on one computer and grow into a production network with the same program." center />
          <div className="setups">
            {SETUPS.map((s) => (
              <article key={s.id} id={s.id} className="setup-card" aria-labelledby={`${s.id}-title`}>
                <span className="feature-icon">
                  <Icon name={s.icon} />
                </span>
                <h3 id={`${s.id}-title`} className="display-3">
                  {s.title}
                </h3>
                <p className="muted">{s.lead}</p>
                <CheckList items={s.points} />
                <Link to={s.more.to} className="link-arrow small">
                  {s.more.label} <Icon name="arrow" size={16} />
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="parts-title">
        <div className="wrap">
          <SectionHead id="parts-title" title="Two parts, clearly separated" center />
          <div className="parts">
            <article className="part">
              <span className="feature-icon">
                <Icon name="windows" />
              </span>
              <h3 className="display-3">The program</h3>
              <p className="muted">On your production computer</p>
              <CheckList items={["Reads the live game from your CS2 observer client", "Serves HUDs to OBS and over the game", "Directs the observer camera when you start the Auto Director", "Plays replays, map intros and highlights through OBS or vMix", "Keeps matches, vetoes, sponsors and the rundown", "Measures auto-director time and uploads it"]} />
            </article>
            <div className="parts-link" aria-hidden="true">
              <span>licence</span>
              <Icon name="arrow" size={20} />
              <span>usage</span>
            </div>
            <article className="part">
              <span className="feature-icon">
                <Icon name="server" />
              </span>
              <h3 className="display-3">This website</h3>
              <p className="muted">Your account, from any browser</p>
              <CheckList items={["Accounts, organisations and team roles", "Plans, hour packs, payments and invoices", "Linked computers and their signed licences", "Auto-director hours: allowance and usage", "The program download"]} />
            </article>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="flow-title">
        <div className="wrap">
          <SectionHead id="flow-title" eyebrow="The flow" title="From install to automatic direction" center />
          <ol className="flow">
            {FLOW.map((s, i) => (
              <li key={s.title} className="flow-step">
                <span className="flow-icon">
                  <Icon name={s.icon} />
                </span>
                <p className="flow-num">Step {i + 1}</p>
                <h3 className="flow-title">{s.title}</h3>
                <p className="small">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section section-alt" id="metering" aria-labelledby="metering-title">
        <div className="wrap two-col-lg">
          <div>
            <SectionHead id="metering-title" eyebrow="Fair metering" title="Hours are used only while automation drives the camera" lead="The program counts a second only when every one of these is true:" />
            <Callout title="At the limit">
              <p>Automation already running is never cut off mid-map: it finishes the map and hands the camera back at the map change. Re-arming is then blocked until hours are added. There are no overage charges. If a plan stops including Full Action Observer, the program switches to Observer &amp; Cinematics at the next map change.</p>
            </Callout>
          </div>
          <div>
            <CheckList
              items={[
                "Automation is armed, not manually taken over and not emergency-stopped",
                "The Observer is in Observer, Observer & Cinematics or Full Action Observer mode (all at the same rate)",
                "A real observer control adapter is connected",
                "Telemetry is live, not simulated, with a packet in the last 15 seconds",
                "The computer is linked to your organisation",
              ]}
            />
            <p className="small muted">Records close on map or session changes and every five minutes, are uploaded every two minutes, and are accepted once even if sent twice. Time while the computer sleeps is never counted.</p>
          </div>
        </div>
      </section>

      <section className="section" id="offline" aria-labelledby="offline-title">
        <div className="wrap">
          <SectionHead id="offline-title" eyebrow="Offline-first" title="What works offline" lead="Your broadcast never depends on this website. The program signs in once, refreshes its signed licence every 15 minutes while online, and keeps working offline for 7 days. Being signed out never stops a show that is already running." center />
          <div className="table-scroll" role="region" aria-label="What works offline" tabIndex={0}>
            <table className="cmp-table">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">On every plan</th>
                  <th scope="col">Offline</th>
                </tr>
              </thead>
              <tbody>
                {OFFLINE.map(([f, a, o]) => (
                  <tr key={f}>
                    <th scope="row">{f}</th>
                    <td>{a}</td>
                    <td>{o}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="setup" aria-labelledby="setup-title">
        <div className="wrap">
          <SectionHead id="setup-title" eyebrow="Setup guide" title="Getting started, step by step" />
          <div className="guide">
            <ol className="timeline">
              {SETUP.map((s, i) => (
                <li key={s.id} className="timeline-item">
                  <span className="timeline-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="timeline-body">
                    <p className="timeline-where">{s.where}</p>
                    <h3 className="timeline-title">
                      <span className="visually-hidden">Step {i + 1}: </span>
                      {s.title}
                    </h3>
                    {s.body}
                  </div>
                </li>
              ))}
            </ol>
            <aside className="guide-side">
              <Callout title="Early access">
                <p>Real CS2 telemetry ingest and observer camera control haven't yet been verified on a real CS2 client. Run the checklist and a rehearsal before a live match.</p>
              </Callout>
              <div className="side-card">
                <p className="side-card-title">Need a hand?</p>
                <p className="small muted">Our team can help with setup questions, plans and invoices.</p>
                <Link to="/contact?topic=support" className="btn btn-secondary btn-sm">
                  Contact support
                </Link>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <CtaBand title="Set up your first broadcast" text="The Free plan includes the whole program and a few auto-director hours every month.">
        {me ? (
          <Link to="/dashboard" className="btn btn-primary btn-lg">
            Open your dashboard
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Get started free
          </Link>
        )}
        <Link to="/features" className="btn btn-on-dark btn-lg">
          Explore the features
        </Link>
      </CtaBand>
    </>
  );
}
