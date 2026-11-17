import { Icon } from "../../components/icons.tsx";
import { Callout, CtaBand, DownloadButton, PageHero } from "../../components/marketing.tsx";
import { REQUIREMENT_GROUPS } from "../../content/requirements.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { CURRENT_VERSION } from "../../content/release.ts";

export function Requirements() {
  useTitle("System requirements", `MatchFrame ${CURRENT_VERSION} system requirements: Windows 10/11 64-bit, a CS2 observer client, OBS Studio 30+ or vMix, an optional replay PC, local ports 37210–37212, Stable and Beta updates, and internet only for signing in, licences, sync and player cams.`);
  return (
    <>
      <PageHero eyebrow="Product" title="System requirements" lead={`What you need to run MatchFrame ${CURRENT_VERSION} on your production computer, and on a replay PC if you add one.`} crumbs={[{ to: "/features", label: "Features" }]} />
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
            <p>Each version is checked automatically on Linux and on a Windows runner, where the installer is built, installed and smoke-tested. Our tests haven't yet verified real CS2 telemetry and camera control on a real CS2 client, so run the setup checklist and a rehearsal first.</p>
          </Callout>
          <Callout title="Windows may warn you" tone="warn">
            <p>
              Builds aren't code-signed yet, so SmartScreen may show "Windows protected your PC". Check the SHA-256 checksum on the download page, then choose <strong>More info → Run anyway</strong>. Signed builds are coming.
            </p>
          </Callout>
          <div className="side-card">
            <p className="side-card-title">Setting up</p>
            <ul className="side-links">
              <li>
                <Link to="/how-it-works#setups">One PC, two PCs or a crew</Link>
              </li>
              <li>
                <Link to="/how-it-works#setup">Setup guide</Link>
              </li>
              <li>
                <Link to="/help/installing-the-program">Installing the program</Link>
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
        <DownloadButton />
        <Link to="/how-it-works" className="btn btn-on-dark btn-lg">
          How it works
        </Link>
      </CtaBand>
    </>
  );
}
