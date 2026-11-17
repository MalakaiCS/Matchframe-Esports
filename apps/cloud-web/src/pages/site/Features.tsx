import { Icon } from "../../components/icons.tsx";
import { CheckList, CtaBand, DownloadButton, PageHero, Screenshot, SectionHead } from "../../components/marketing.tsx";
import { EARLY_ACCESS, FEATURES, MOVED_FEATURES, featureBySlug } from "../../content/features.tsx";
import type { Feature } from "../../content/features.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link, Redirect } from "../../router.tsx";
import { NotFound } from "./NotFound.tsx";

function EarlyAccessNote() {
  return (
    <aside className="early-access" aria-label="Early access">
      <span className="badge badge-brand">Early access</span>
      <p>{EARLY_ACCESS}</p>
    </aside>
  );
}

/** A capability without a screenshot: its icon, name and tags on the stage background (decorative: the text beside it says it all). */
function FeaturePanel({ f }: { f: Feature }) {
  return (
    <div className="feature-panel" aria-hidden="true">
      <span className="feature-panel-icon">
        <Icon name={f.icon} size={40} />
      </span>
      <p className="feature-panel-title">{f.title}</p>
      <ul>
        {(f.tags ?? f.highlights).map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}

function FeatureSection({ f, reverse }: { f: Feature; reverse: boolean }) {
  return (
    <section className={`spotlight${reverse ? " is-reverse" : ""}`} id={f.slug} aria-labelledby={`${f.slug}-title`}>
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
            Learn more <span className="visually-hidden">about {f.title}</span>
            <Icon name="arrow" size={18} />
          </Link>
        </p>
      </div>
      <div className="spotlight-media">{f.shot ? <Screenshot name={f.shot.name} alt={f.shot.alt} caption={f.shot.caption} /> : <FeaturePanel f={f} />}</div>
    </section>
  );
}

export function Features() {
  useTitle("Features", "MatchFrame features: the Stage HUD and four more HUDs, the Auto Director with Observer modes, replays of every kill with slow motion, map intros, Team Comms, player cams, match administration, OBS, vMix and Stream Deck, low-spec mode and safe updates.");
  return (
    <>
      <PageHero eyebrow="Features" title="Everything your CS2 broadcast needs, in one program" lead="MatchFrame runs on your Windows production PC: HUDs, camera direction, replays, intros, comms and the running order. This website only manages the account, plan and hours behind it.">
        <DownloadButton />
        <Link to="/pricing" className="btn btn-secondary btn-lg">
          See plans
        </Link>
      </PageHero>

      <section className="stage-band" aria-labelledby="stage-band-title">
        <div className="wrap stage-band-grid">
          <div className="stage-band-text">
            <p className="eyebrow">Front and centre</p>
            <h2 id="stage-band-title" className="display-2">
              The Stage HUD
            </h2>
            <p>A tournament-stage layout in MatchFrame's own look: side-coloured player cards, the round MVP card, a full-width pause scoreboard and a trophy on the event line. Try it live in your browser.</p>
            <div className="stage-band-actions">
              <Link to="/stage-hud#stage-demo" className="btn btn-primary">
                <Icon name="play" size={18} /> Try the live demo
              </Link>
              <Link to="/stage-hud" className="btn btn-on-dark">
                What's on screen
              </Link>
            </div>
          </div>
          <Screenshot name="stage-live" alt="The Stage HUD during a live round, with fictional teams: side-coloured player cards in the bottom corners, the score bar and event line top centre, the minimap top left and the killfeed top right." sizes="(min-width: 1100px) 640px, 100vw" />
        </div>
      </section>

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

      <div className="section">
        <div className="wrap spotlights">
          {FEATURES.map((f, i) => (
            <FeatureSection key={f.slug} f={f} reverse={i % 2 === 1} />
          ))}
        </div>
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
              <p>Windows 10 or 11 (64-bit), a CS2 observer client, and OBS Studio 30 or later or vMix.</p>
              <Link to="/requirements" className="link-arrow">
                See requirements <Icon name="arrow" size={18} />
              </Link>
            </article>
            <article className="tile">
              <span className="feature-icon">
                <Icon name="offline" />
              </span>
              <h3 className="feature-title">Offline-first</h3>
              <p>Only the Auto Director's camera-moving modes on live matches need an account and hours. Everything else works offline.</p>
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

      <CtaBand title="Try it on your next rehearsal" text="The built-in simulation lets your crew practise with HUDs, replays and the Auto Director before a real match, clearly labelled as simulated everywhere.">
        <DownloadButton />
        <Link to="/pricing" className="btn btn-on-dark btn-lg">
          See plans
        </Link>
      </CtaBand>
    </>
  );
}

export function FeatureDetail({ slug }: { slug: string }) {
  const f = featureBySlug(slug);
  const moved = MOVED_FEATURES[slug];
  useTitle(f ? f.title : moved ? "Features" : "Feature not found", f?.summary);
  if (moved) return <Redirect to={`/features/${moved}`} />;
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
          {f.sections?.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="feature-block">
              <h2 id={`${s.id}-title`} className="display-3">
                {s.title}
              </h2>
              {s.body}
            </section>
          ))}
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
          {f.slug === "huds" && (
            <div className="side-card side-card-stage">
              <p className="side-card-title">Stage HUD</p>
              <p className="small">A tournament-stage layout, live in your browser.</p>
              <Link to="/stage-hud" className="link-arrow small">
                Try the live demo <Icon name="arrow" size={16} />
              </Link>
            </div>
          )}
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
              <li>
                <Link to="/stage-hud">Stage HUD</Link>
              </li>
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
        <DownloadButton />
        <Link to="/features" className="btn btn-on-dark btn-lg">
          All features
        </Link>
      </CtaBand>
    </>
  );
}
