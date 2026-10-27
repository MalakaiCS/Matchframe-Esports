import { Icon } from "../../components/icons.tsx";
import { CheckList, CtaBand, PageHero, Screenshot, SectionHead } from "../../components/marketing.tsx";
import { EARLY_ACCESS, FEATURES, featureBySlug } from "../../content/features.tsx";
import type { Feature } from "../../content/features.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";
import { NotFound } from "./NotFound.tsx";

function EarlyAccessNote() {
  return (
    <aside className="early-access" aria-label="Early access">
      <span className="badge badge-brand">Early access</span>
      <p>{EARLY_ACCESS}</p>
    </aside>
  );
}

function FeatureSection({ f, reverse }: { f: Feature; reverse: boolean }) {
  return (
    <section className={`spotlight${reverse ? " is-reverse" : ""}${f.shot ? "" : " spotlight-noshot"}`} id={f.slug} aria-labelledby={`${f.slug}-title`}>
      <div className="spotlight-text">
        <p className="eyebrow eyebrow-icon">
          <Icon name={f.icon} size={18} /> {f.title}
        </p>
        <h2 id={`${f.slug}-title`} className="display-3">
          {f.tagline.replace(/\.$/, "")}
        </h2>
        <p>{f.summary}</p>
        <CheckList items={f.highlights} />
        <p>
          <Link to={`/features/${f.slug}`} className="link-arrow">
            Learn more<span className="visually-hidden"> about {f.title}</span> <Icon name="arrow" size={18} />
          </Link>
        </p>
      </div>
      <div className="spotlight-media">
        {f.shot ? (
          <Screenshot name={f.shot.name} alt={f.shot.alt} caption={f.shot.caption} />
        ) : (
          <div className="feature-panel" aria-hidden="true">
            <Icon name={f.icon} size={56} />
            <p>{f.tagline}</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function Features() {
  useTitle("Features", "Matchframe features: HUDs for OBS, an auto director with manual takeover and emergency stop, observer camera control, grenade tracking, OBS control and replays, match administration, the demo pipeline and multi-PC operation.");
  const { me } = useSession();
  return (
    <>
      <PageHero eyebrow="Product" title="Everything the production desk needs, in one program" lead="Matchframe runs on your Windows production computer and brings the broadcast together: graphics, camera direction, replays and the running order. This website only manages the account, plan and hours behind it.">
        {me ? (
          <Link to="/download" className="btn btn-primary btn-lg">
            Download for Windows
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Create a free account
          </Link>
        )}
        <Link to="/how-it-works" className="btn btn-secondary btn-lg">
          How it works
        </Link>
      </PageHero>

      <nav className="jump" aria-label="Features on this page">
        <div className="wrap">
          <ul>
            {FEATURES.map((f) => (
              <li key={f.slug}>
                <a href={`#${f.slug}`}>{f.nav}</a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="wrap section-top">
        <EarlyAccessNote />
      </div>

      <div className="wrap section spotlights">
        {FEATURES.map((f, i) => (
          <FeatureSection key={f.slug} f={f} reverse={i % 2 === 1} />
        ))}
      </div>

      <section className="section section-alt" aria-labelledby="next-title">
        <div className="wrap">
          <SectionHead id="next-title" title="Before you start" center />
          <div className="tile-grid">
            <article className="tile">
              <span className="feature-icon">
                <Icon name="windows" />
              </span>
              <h3 className="feature-title">System requirements</h3>
              <p>Windows 10 or 11 (64-bit), a CS2 observer client and OBS Studio 30 or later.</p>
              <Link to="/requirements" className="link-arrow">
                See requirements <Icon name="arrow" size={18} />
              </Link>
            </article>
            <article className="tile">
              <span className="feature-icon">
                <Icon name="offline" />
              </span>
              <h3 className="feature-title">Offline-first</h3>
              <p>Only automatic direction on live matches needs an account and hours. Everything else works offline.</p>
              <Link to="/how-it-works#offline" className="link-arrow">
                What works offline <Icon name="arrow" size={18} />
              </Link>
            </article>
            <article className="tile">
              <span className="feature-icon">
                <Icon name="users" />
              </span>
              <h3 className="feature-title">Use cases</h3>
              <p>Tournaments, leagues, streams, LAN events and school programmes.</p>
              <Link to="/use-cases" className="link-arrow">
                See use cases <Icon name="arrow" size={18} />
              </Link>
            </article>
          </div>
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

export function FeatureDetail({ slug }: { slug: string }) {
  const f = featureBySlug(slug);
  useTitle(f ? f.title : "Feature not found", f?.summary);
  const { me } = useSession();
  if (!f) return <NotFound />;
  const others = FEATURES.filter((x) => x.slug !== f.slug);
  return (
    <>
      <PageHero eyebrow={f.nav} title={f.title} lead={f.tagline} crumbs={[{ to: "/features", label: "Features" }]} />
      <div className="wrap section-top feature-layout">
        <div className="feature-main">
          {f.shot && <Screenshot name={f.shot.name} alt={f.shot.alt} caption={f.shot.caption} eager />}
          <section aria-labelledby="what-title" className="feature-block">
            <h2 id="what-title" className="display-3">
              What it does
            </h2>
            <div className="prose">{f.what}</div>
          </section>
          <section aria-labelledby="how-title" className="feature-block">
            <h2 id="how-title" className="display-3">
              How it works
            </h2>
            <ol className="num-steps">
              {f.how.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </section>
          {f.faqs.length > 0 && (
            <section aria-labelledby="ffaq-title" className="feature-block">
              <h2 id="ffaq-title" className="display-3">
                Frequently asked questions
              </h2>
              <div className="faq-list">
                {f.faqs.map((x) => (
                  <details key={x.q} className="faq-item">
                    <summary>
                      <span>{x.q}</span>
                      <span className="faq-chevron" aria-hidden="true" />
                    </summary>
                    <div className="faq-answer">{x.a}</div>
                  </details>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside className="feature-side" aria-label={`About ${f.title}`}>
          <div className="side-card">
            <p className="side-card-title">What you need</p>
            <CheckList items={f.needs} />
            <Link to="/requirements" className="link-arrow small">
              Full system requirements <Icon name="arrow" size={16} />
            </Link>
          </div>
          {f.status && (
            <div className="side-card side-card-note">
              <p className="side-card-title">
                <span className="badge badge-brand">Early access</span>
              </p>
              <p className="small">{f.status}</p>
            </div>
          )}
          <nav className="side-card" aria-label="Other features">
            <p className="side-card-title">Other features</p>
            <ul className="side-links">
              {others.map((o) => (
                <li key={o.slug}>
                  <Link to={`/features/${o.slug}`}>{o.title}</Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      </div>
      <div className="section-gap" />
      <CtaBand title="See it on your own setup" text="Download the program, run the setup checklist and rehearse with the built-in simulation.">
        {me ? (
          <Link to="/download" className="btn btn-primary btn-lg">
            Download the program
          </Link>
        ) : (
          <Link to="/signup" className="btn btn-primary btn-lg">
            Create a free account
          </Link>
        )}
        <Link to="/features" className="btn btn-on-dark btn-lg">
          All features
        </Link>
      </CtaBand>
    </>
  );
}
