import { PageHero } from "../../components/marketing.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

interface Release {
  version: string;
  title: string;
  summary: string;
  sections: { heading: string; items: string[] }[];
}

const RELEASES: Release[] = [
  {
    version: "0.1.1",
    title: "Sign in to the program",
    summary: "The program now has its own sign-in screen, using the same account as this website.",
    sections: [
      {
        heading: "The program",
        items: [
          "Sign in with your Matchframe email and password when the program opens, or with a code approved on this website. Accounts in several organisations choose which one the computer is for.",
          "Works offline for up to 7 days after each check; a program that is already open is never locked when it is signed out on the website.",
          "Account & Hours shows who the program is signed in as, with Sign out.",
          "Builds are pinned to this website's address and licence keys, so there is nothing to configure.",
        ],
      },
      {
        heading: "The website",
        items: [
          "Changing or resetting your password, being removed from an organisation or a disabled account signs that person's computers out.",
          "Public product pages, FAQ, help centre, legal documents and a staff console for user management.",
        ],
      },
    ],
  },
  {
    version: "0.1.0",
    title: "First release",
    summary: "The first public version of the Matchframe program for Windows and of this website.",
    sections: [
      {
        heading: "The program",
        items: [
          "Counter-Strike 2 Game State Integration ingest with token authentication, capability sampling and clear evidence levels for every derived event.",
          "Browser-source HUDs for OBS: Classic, Minimal and Arena presets with pre-match, veto, live, post-map, standings and bracket variants; imported HUD packages; draft, publish and rollback per output.",
          "Auto director with advisory, assisted and automatic modes, explained shot choices, sticky manual takeover, emergency stop and a single-writer camera control arbiter. Always starts disarmed.",
          "Observer camera control through the direct console or keyboard adapter, gated by in-program setup tests; operator-validated static cameras for cinematic shots.",
          "OBS control over obs-websocket 5: scenes, sources, audio, recording, streaming and the replay buffer, with a replay approval queue and confirmed playout.",
          "Events, teams, players, series rules, veto with captain links, sponsors with delivery acknowledgements, automation rules and studio rundown.",
          "Multi-PC operator positions with role-scoped tokens, a Stream Deck and Companion control surface, and a labelled simulation for rehearsals.",
          "Offline demo pipeline that builds datasets from CS2 demos and trains models evaluated in shadow mode.",
          "Account & Hours screen: link the computer, see the plan and hours left; automatic direction on live matches is never cut off mid-map.",
        ],
      },
      {
        heading: "The website",
        items: [
          "Accounts with email verification, password reset, email changes confirmed from the new address, active sessions and data export.",
          "Organisations with owner, admin, billing and member roles, and email invitations.",
          "Plans and hour packs through Stripe Checkout, the customer portal and invoices.",
          "Linking computers with a short code, signed licences with offline grace, and auto-director usage by day, computer and session with CSV export.",
          "Program download with SHA-256 checksum, help centre, FAQ, legal documents and a contact form.",
        ],
      },
    ],
  },
];

export function Changelog() {
  useTitle("Changelog", "What's new in the Matchframe program and website, release by release.");
  return (
    <>
      <PageHero eyebrow="Product updates" title="Changelog" lead="New features and improvements in the Matchframe program and this website." />
      <div className="wrap section-top narrow-block">
        <ol className="releases">
          {RELEASES.map((r) => (
            <li key={r.version} className="release" id={`v${r.version}`}>
              <div className="release-meta">
                <span className="badge badge-brand">Version {r.version}</span>
              </div>
              <div className="release-body">
                <h2 className="display-3">{r.title}</h2>
                <p className="release-summary">{r.summary}</p>
                {r.sections.map((s) => (
                  <section key={s.heading} aria-label={`${r.version}: ${s.heading}`}>
                    <h3 className="h3">{s.heading}</h3>
                    <ul className="release-list">
                      {s.items.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </li>
          ))}
        </ol>
        <p className="small muted">
          Signed in? The latest installer is on the <Link to="/download">download page</Link>.
        </p>
      </div>
    </>
  );
}
