import { CheckList, FeatureGrid, PageHero, SectionHead } from "../../components/marketing.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSite } from "../../state/site.ts";

const STORED: [string, string][] = [
  ["Account", "Your name, email address, a salted password hash, whether your email is verified, and when you signed up and last signed in."],
  ["Sessions", "For each signed-in browser: when it was created and last used, its user agent and IP address, so you can review and end sessions."],
  ["Organisations", "Organisation names, members and their roles, pending invitations and the audit trail of changes."],
  ["Linked computers", "The computer name, platform and program version you approved, when it was linked and last seen. Its access token is stored only as a hash."],
  ["Auto-director usage", "When and for how long automatic direction ran on each computer, with the map and match label sent by the program."],
  ["Billing", "Your plan, subscription status, hour credits and a reference to your Stripe customer and invoices. No card numbers."],
  ["Support", "Messages you send through the contact form and the emails we send you (recipient and subject, delivery state)."],
];

export function Security() {
  useTitle("Security", "How Matchframe protects your account and data: what we store, password hashing, signed licences, HTTPS, Stripe payments and responsible disclosure.");
  const { site } = useSite();
  return (
    <>
      <PageHero eyebrow="Trust" title="Security and data protection" lead="We keep as little as we can, protect what we keep, and leave your broadcast data on your own computers." />

      <section className="section" aria-labelledby="principles-title">
        <div className="wrap">
          <SectionHead id="principles-title" title="How we protect your account" />
          <FeatureGrid
            columns={3}
            items={[
              { icon: "lock", title: "Hashed passwords", text: "Passwords are hashed with scrypt and a unique salt. We can't see or recover them; resetting sends a single-use link that expires after an hour." },
              { icon: "shield", title: "Encrypted connections", text: "The website and API are served over HTTPS. Session cookies are HttpOnly, SameSite and Secure, and changes must come from this website." },
              { icon: "card", title: "Payments by Stripe", text: "Card details are entered on Stripe's pages and never reach our servers. We store a customer reference, not card data." },
              { icon: "link", title: "Signed licences", text: "Licences sent to the program are signed with Ed25519 and checked against keys built into the program, so a fake server can't grant access." },
              { icon: "users", title: "Least privilege", text: "Team roles limit who can pay, invite or link computers. Staff access is split into support and admin roles, and every staff change is audited." },
              { icon: "clock", title: "Sessions you control", text: "Review the browsers signed in to your account, end any of them, and sign out everywhere when you change your password." },
            ]}
          />
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="stored-title">
        <div className="wrap two-col-lg">
          <div>
            <SectionHead id="stored-title" eyebrow="Data" title="What we store" lead="Everything else, including game telemetry, HUD content, recordings and replays, stays on your computers." />
            <p>
              <Link to="/account">Download a copy of your data</Link> from your account page at any time. Read the <Link to="/legal/privacy">privacy policy</Link> for how long we keep it and your rights.
            </p>
          </div>
          <dl className="spec-list">
            {STORED.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="section" aria-labelledby="program-title">
        <div className="wrap two-col-lg">
          <SectionHead id="program-title" eyebrow="The program" title="Security in the Windows program" />
          <CheckList
            items={[
              "The broadcast engine listens on this computer only unless you choose otherwise; remote positions need role-scoped tokens.",
              "HUD outputs receive only the public match picture, protected by a token per output.",
              "Credentials are stored with Windows' protected storage; the computer's link token is encrypted at rest.",
              "Imported HUD packages are checked for paths, size, scripts and permissions before use.",
              "No memory reading, code injection or anti-cheat evasion: the program uses the game's documented interfaces.",
            ]}
          />
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="disclosure-title">
        <div className="wrap narrow-block">
          <SectionHead id="disclosure-title" eyebrow="Responsible disclosure" title="Found a vulnerability?" />
          <p>
            Please tell us privately before sharing it with anyone else. Send the details through the <Link to="/contact?topic=other">contact form</Link>
            {site?.supportEmail ? (
              <>
                {" "}
                or to <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
              </>
            ) : null}
            , including steps to reproduce. Don't access data that isn't yours, degrade the service or test against other customers' accounts. We'll acknowledge your report and keep you updated while we fix it.
          </p>
        </div>
      </section>
    </>
  );
}
