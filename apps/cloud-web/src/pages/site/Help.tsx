import { useId, useState } from "react";
import { Icon } from "../../components/icons.tsx";
import { PageHero, Prose } from "../../components/marketing.tsx";
import { Empty } from "../../components/ui.tsx";
import { HELP_ARTICLES, HELP_CATEGORIES, helpArticle, searchHelp } from "../../content/help.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { NotFound } from "./NotFound.tsx";

function SupportBox() {
  return (
    <div className="side-card">
      <p className="side-card-title">Still need help?</p>
      <p className="small muted">Send us a message and we'll reply by email.</p>
      <Link to="/contact?topic=support" className="btn btn-secondary btn-sm">
        Contact support
      </Link>
    </div>
  );
}

export function HelpCentre() {
  useTitle("Help centre", "Matchframe help centre: guides for creating an account, verifying email, linking computers, plans and hours, hour packs, invoices, team roles, installing the program and resetting your password.");
  const [q, setQ] = useState("");
  const inputId = useId();
  const results = searchHelp(q);
  const searching = q.trim().length > 0;
  return (
    <>
      <PageHero eyebrow="Support" title="Help centre" lead="Guides for your Matchframe account, plans and the program download.">
        <form className="help-search" role="search" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor={inputId} className="visually-hidden">
            Search help articles
          </label>
          <Icon name="search" size={20} className="help-search-icon" />
          <input id={inputId} type="search" placeholder="Search, e.g. invoice, SmartScreen, sign in" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </form>
      </PageHero>
      <div className="wrap section-top">
        {searching ? (
          <section aria-labelledby="results-title">
            <h2 id="results-title" className="display-3" aria-live="polite">
              {results.length === 0 ? "No articles match" : `${results.length} ${results.length === 1 ? "article" : "articles"} found`}
            </h2>
            {results.length === 0 ? (
              <Empty title={`Nothing matches “${q.trim()}”`}>
                Try a different word, browse the topics below, or <Link to="/contact?topic=support">ask our team</Link>.
              </Empty>
            ) : (
              <ul className="article-list">
                {results.map((a) => (
                  <li key={a.slug}>
                    <Link to={`/help/${a.slug}`} className="article-link">
                      <span className="article-title">{a.title}</span>
                      <span className="article-summary">{a.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <div className="help-grid">
            {HELP_CATEGORIES.map((c) => (
              <section key={c.id} id={c.id} className="help-cat" aria-labelledby={`cat-${c.id}`}>
                <span className="feature-icon">
                  <Icon name={c.icon} />
                </span>
                <h2 id={`cat-${c.id}`} className="help-cat-title">
                  {c.title}
                </h2>
                <p className="small muted">{c.text}</p>
                <ul className="help-cat-links">
                  {HELP_ARTICLES.filter((a) => a.category === c.id).map((a) => (
                    <li key={a.slug}>
                      <Link to={`/help/${a.slug}`}>{a.title}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        <div className="help-foot">
          <div className="tile">
            <h2 className="feature-title">New to Matchframe?</h2>
            <p className="small muted">Follow the getting-started guide from account to first live match.</p>
            <Link to="/how-it-works" className="link-arrow">
              Getting started <Icon name="arrow" size={18} />
            </Link>
          </div>
          <div className="tile">
            <h2 className="feature-title">Quick answers</h2>
            <p className="small muted">Short answers about plans, billing, privacy and the program.</p>
            <Link to="/faq" className="link-arrow">
              Frequently asked questions <Icon name="arrow" size={18} />
            </Link>
          </div>
          <div className="tile">
            <h2 className="feature-title">Talk to us</h2>
            <p className="small muted">Questions about your account, invoices or setup.</p>
            <Link to="/contact?topic=support" className="link-arrow">
              Contact support <Icon name="arrow" size={18} />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

export function HelpArticlePage({ slug }: { slug: string }) {
  const article = helpArticle(slug);
  useTitle(article ? `${article.title} · Help` : "Help article not found", article?.summary);
  if (!article) return <NotFound />;
  const cat = HELP_CATEGORIES.find((c) => c.id === article.category)!;
  const siblings = HELP_ARTICLES.filter((a) => a.category === article.category);
  return (
    <>
      <PageHero
        eyebrow={cat.title}
        title={article.title}
        lead={article.summary}
        crumbs={[
          { to: "/help", label: "Help centre" },
          { to: `/help#${cat.id}`, label: cat.title },
        ]}
      />
      <div className="wrap section-top article-layout">
        <article className="article-body">
          <Prose>{article.body}</Prose>
          <p className="article-feedback small muted">
            Was this article missing something? <Link to="/contact?topic=support">Tell us</Link> and we'll improve it.
          </p>
        </article>
        <aside className="article-side" aria-label="More help">
          <nav aria-label={`More in ${cat.title}`} className="side-card">
            <p className="side-card-title">In {cat.title}</p>
            <ul className="side-links">
              {siblings.map((a) => (
                <li key={a.slug}>
                  <Link to={`/help/${a.slug}`} aria-current={a.slug === slug ? "page" : undefined}>
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <SupportBox />
        </aside>
      </div>
    </>
  );
}
