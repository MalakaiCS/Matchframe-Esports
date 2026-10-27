import { Icon } from "../../components/icons.tsx";
import { CheckList, CtaBand, PageHero } from "../../components/marketing.tsx";
import { USE_CASES } from "../../content/useCases.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

export function UseCases() {
  useTitle("Use cases", "How Matchframe is designed to help tournament organisers, leagues, streamers and casters, LAN events, and school and collegiate programmes produce CS2 broadcasts.");
  return (
    <>
      <PageHero eyebrow="Use cases" title="Built for every kind of CS2 production" lead="From a single caster at home to a multi-day LAN with a full crew, Matchframe is designed to scale with your production." />
      <nav className="jump" aria-label="Use cases on this page">
        <div className="wrap">
          <ul>
            {USE_CASES.map((u) => (
              <li key={u.id}>
                <a href={`#${u.id}`}>{u.title}</a>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="wrap section use-cases">
        {USE_CASES.map((u) => (
          <section key={u.id} id={u.id} className="use-case" aria-labelledby={`${u.id}-title`}>
            <div className="use-case-head">
              <span className="feature-icon">
                <Icon name={u.icon} />
              </span>
              <h2 id={`${u.id}-title`} className="display-3">
                {u.title}
              </h2>
              <p>{u.intro}</p>
            </div>
            <div className="use-case-body">
              <h3 className="h3">How Matchframe helps</h3>
              <CheckList items={u.helps} />
            </div>
            <div className="use-case-side">
              <h3 className="h3">Typical setup</h3>
              <p className="small">{u.setup}</p>
              <h3 className="h3">Related features</h3>
              <ul className="side-links">
                {u.features.map((f) => (
                  <li key={f.slug}>
                    <Link to={`/features/${f.slug}`}>{f.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
      <CtaBand title="Tell us about your production" text="Not sure which plan or setup fits? Describe your event and we'll help you plan it.">
        <Link to="/contact?topic=sales" className="btn btn-primary btn-lg">
          Contact us
        </Link>
        <Link to="/pricing" className="btn btn-on-dark btn-lg">
          See pricing
        </Link>
      </CtaBand>
    </>
  );
}
