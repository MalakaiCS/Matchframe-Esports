import type { ReactNode } from "react";
import { Icon } from "../../components/icons.tsx";
import type { IconName } from "../../components/icons.tsx";
import { Callout, CheckList, CtaBand, PageHero, SectionHead } from "../../components/marketing.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

const FLOW: { icon: IconName; title: string; text: string }[] = [
  { icon: "download", title: "Install", text: "Download the Windows installer from your account and run the setup checklist in the program." },
  { icon: "link", title: "Link the computer", text: "Account & Hours → Link this computer, then approve the code on this website." },
  { icon: "card", title: "Buy or receive hours", text: "Plans include auto-director hours each period, and hour packs add more at any time." },
  { icon: "director", title: "Arm automation", text: "Resume automation in Live Control. Hours are used only while it drives the camera." },
];

const OFFLINE: [string, ReactNode, ReactNode][] = [
  ["HUDs for OBS", "Yes", "Yes"],
  ["Manual and advisory direction", "Yes", "Yes"],
  ["OBS control and replays", "Yes", "Yes"],
  ["Match, veto and sponsor administration", "Yes", "Yes"],
  ["Simulation and demo pipeline", "Yes", "Yes"],
  ["Automatic direction on live matches", "No: needs a linked computer with hours", "Yes, for up to 7 days after the last licence refresh"],
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
        Download the installer from your account and check its SHA-256 checksum. The installer isn't code-signed yet, so SmartScreen asks you to confirm with More info → Run anyway. <Link to="/help/installing-the-program">More help</Link>
      </p>
    ),
  },
  {
    id: "checklist",
    title: "Work through the setup checklist",
    where: "In the program",
    body: (
      <>
        <p>The program opens with a setup checklist that only ticks a step once it has seen it working:</p>
        <ul>
          <li>Detect CS2 and write the Game State Integration config, then restart CS2 as an observer.</li>
          <li>Wait for a real payload and read the capability report.</li>
          <li>Choose the observer control adapter and run the player-selection test (and the static camera test for cinematic shots).</li>
          <li>Connect OBS, map your programme scenes and add the HUD browser source.</li>
        </ul>
      </>
    ),
  },
  {
    id: "link",
    title: "Link the computer",
    where: "In the program, then on this website",
    body: (
      <p>
        Open <strong>Account &amp; Hours → Link this computer</strong>, enter the code at <Link to="/link">/link</Link>, choose your organisation and approve. <Link to="/help/linking-a-computer">More help</Link>
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
        Invite producers and billing contacts on the Team page with the right role. Extra operator computers connect to the production computer with a role token issued in the program. <Link to="/help/team-roles">More help</Link>
      </p>
    ),
  },
  {
    id: "live",
    title: "Go live",
    where: "In the program",
    body: (
      <p>
        Start the director in Advisory, move to Assisted or Automatic when you trust the setup, and arm it with Resume automation. Stop everything with <kbd>F8</kbd> in the program or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F12</kbd> anywhere in Windows.
      </p>
    ),
  },
];

export function HowItWorks() {
  useTitle("How it works", "How Matchframe works: the program on your production PC, the website for your account and hours, linking computers, metering only while automation drives the camera, and what works offline.");
  const { me } = useSession();
  return (
    <>
      <PageHero eyebrow="How it works" title="The program runs the show. The website runs the account." lead="Matchframe has two parts. The Windows program on your production computer does all the broadcast work. This website keeps the account, plan and auto-director hours behind it.">
        {me ? (
          <Link to="/download" className="btn btn-primary btn-lg">
            Download the program
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Create a free account
          </Link>
        )}
        <a href="#setup" className="btn btn-secondary btn-lg">
          Setup guide
        </a>
      </PageHero>

      <section className="section" aria-labelledby="parts-title">
        <div className="wrap">
          <SectionHead id="parts-title" title="Two parts, clearly separated" center />
          <div className="parts">
            <article className="part">
              <span className="feature-icon">
                <Icon name="windows" />
              </span>
              <h3 className="display-3">The program</h3>
              <p className="muted">On your production computer</p>
              <CheckList items={["Reads the live game from your CS2 observer client", "Serves HUDs to OBS and controls scenes and replays", "Directs the observer camera when you arm it", "Keeps matches, vetoes, sponsors and the rundown", "Measures auto-director time and uploads it"]} />
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

      <section className="section section-alt" aria-labelledby="flow-title">
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

      <section className="section" id="metering" aria-labelledby="metering-title">
        <div className="wrap two-col-lg">
          <div>
            <SectionHead id="metering-title" eyebrow="Fair metering" title="Hours are used only while automation drives the camera" lead="The program counts a second only when every one of these is true:" />
            <Callout title="At the limit">
              <p>Automation already running is never cut off mid-map: it finishes the map and hands the camera back at the map change. Re-arming is then blocked until hours are added. There are no overage charges.</p>
            </Callout>
          </div>
          <div>
            <CheckList
              items={[
                "Automation is armed, not manually taken over and not emergency-stopped",
                "The director is in automatic or assisted mode",
                "A real observer control adapter is connected",
                "Telemetry is live, not simulated, with a packet in the last 15 seconds",
                "The computer is linked to your organisation",
              ]}
            />
            <p className="small muted">Records close on map or session changes and every five minutes, are uploaded every two minutes, and are accepted once even if sent twice. Time while the computer sleeps is never counted.</p>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="offline" aria-labelledby="offline-title">
        <div className="wrap">
          <SectionHead id="offline-title" eyebrow="Offline-first" title="What works offline and without an account" lead="Your broadcast never depends on this website. A linked computer refreshes its signed licence every 15 minutes while online and keeps it valid offline for 7 days." center />
          <div className="table-scroll" role="region" aria-label="What works offline" tabIndex={0}>
            <table className="cmp-table">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">Without an account</th>
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

      <section className="section" id="setup" aria-labelledby="setup-title">
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
