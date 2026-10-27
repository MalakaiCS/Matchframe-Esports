import { Icon } from "../../components/icons.tsx";
import { Callout, CtaBand, PageHero } from "../../components/marketing.tsx";
import { REQUIREMENT_GROUPS } from "../../content/requirements.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

export function Requirements() {
  useTitle("System requirements", "Matchframe system requirements: Windows 10/11 64-bit, a CS2 observer client, OBS Studio 30+ with obs-websocket 5, local ports 37210–37212 and internet only for linking, licence refresh and usage upload.");
  const { me } = useSession();
  return (
    <>
      <PageHero eyebrow="Product" title="System requirements" lead="What you need to run the Matchframe program on your production computer." crumbs={[{ to: "/features", label: "Features" }]} />
      <div className="wrap section-top req-layout">
        <div className="req-groups">
          {REQUIREMENT_GROUPS.map((g) => (
            <section key={g.id} id={g.id} className="req-group" aria-labelledby={`${g.id}-title`}>
              <h2 id={`${g.id}-title`} className="req-title">
                <span className="feature-icon feature-icon-sm">
                  <Icon name={g.icon} size={18} />
                </span>
                {g.title}
              </h2>
              <dl className="spec-list">
                {g.rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <aside className="req-side" aria-label="Notes">
          <Callout title="Tested so far">
            <p>The installer is built, installed and smoke-tested on Windows runners. In early access it hasn't yet been used on a production desktop with a real CS2 client; real telemetry ingest and camera control are still to be verified there.</p>
          </Callout>
          <div className="side-card">
            <p className="side-card-title">Setting up</p>
            <ul className="side-links">
              <li>
                <Link to="/how-it-works#setup">Setup guide</Link>
              </li>
              <li>
                <Link to="/help/installing-the-program">Installing the program</Link>
              </li>
              <li>
                <Link to="/features/multi-pc">Multi-PC operation</Link>
              </li>
              <li>
                <Link to="/faq#troubleshooting">Troubleshooting</Link>
              </li>
            </ul>
          </div>
        </aside>
      </div>
      <div className="section-gap" />
      <CtaBand title="Ready to install?" text="Download the Windows installer with its SHA-256 checksum from your account.">
        {me ? (
          <Link to="/download" className="btn btn-primary btn-lg">
            Download the program
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Create a free account
          </Link>
        )}
        <Link to="/how-it-works" className="btn btn-on-dark btn-lg">
          How it works
        </Link>
      </CtaBand>
    </>
  );
}
