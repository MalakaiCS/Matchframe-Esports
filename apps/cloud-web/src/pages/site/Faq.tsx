import { useId, useState } from "react";
import { Icon } from "../../components/icons.tsx";
import { CtaBand, PageHero } from "../../components/marketing.tsx";
import { Empty } from "../../components/ui.tsx";
import { FAQ, FAQ_CATEGORIES, FaqList, filterFaq } from "../../content/faq.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

export function Faq() {
  useTitle("FAQ", "Answers to common questions about Matchframe: the program and installation, the auto director and hours, HUDs and OBS, accounts, billing, privacy and troubleshooting.");
  const [q, setQ] = useState("");
  const inputId = useId();
  const matches = filterFaq(FAQ, q);
  const searching = q.trim().length > 0;
  const groups = FAQ_CATEGORIES.map((c) => ({ ...c, items: matches.filter((f) => f.category === c.id) })).filter((g) => g.items.length > 0);
  return (
    <>
      <PageHero eyebrow="Support" title="Frequently asked questions" lead={<>Answers about the program, the auto director, plans and your account. For step-by-step guides, see the <Link to="/help">help centre</Link>.</>}>
        <form className="help-search" role="search" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor={inputId} className="visually-hidden">
            Filter questions
          </label>
          <Icon name="search" size={20} className="help-search-icon" />
          <input id={inputId} type="search" placeholder="Filter questions, e.g. SmartScreen, hours, OBS" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </form>
      </PageHero>
      <div className="wrap section-top faq-page">
        <nav className="faq-toc" aria-label="FAQ sections">
          <p className="faq-toc-title">Categories</p>
          <ul>
            {FAQ_CATEGORIES.map((c) => {
              const n = matches.filter((f) => f.category === c.id).length;
              return (
                <li key={c.id}>
                  <a href={`#${c.id}`} aria-disabled={n === 0 || undefined} className={n === 0 ? "is-empty" : undefined}>
                    {c.title} <span className="faq-toc-count">{n}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="faq-sections">
          <p className="faq-result" role="status">
            {searching ? (matches.length === 0 ? "No questions match your filter." : `${matches.length} of ${FAQ.length} questions match “${q.trim()}”.`) : `${FAQ.length} questions in ${FAQ_CATEGORIES.length} categories.`}
          </p>
          {groups.length === 0 && (
            <Empty title="Nothing matches that filter">
              Try another word, <button type="button" className="link-button" onClick={() => setQ("")}>clear the filter</button>, or <Link to="/contact">ask us directly</Link>.
            </Empty>
          )}
          {groups.map((g) => (
            <section key={g.id} id={g.id} aria-labelledby={`${g.id}-title`} className="faq-section">
              <h2 id={`${g.id}-title`} className="display-3">
                {g.title}
              </h2>
              <FaqList items={g.items} open={searching} />
            </section>
          ))}
        </div>
      </div>
      <div className="section-gap" />
      <CtaBand title="Didn't find your answer?" text="Send us a message and we'll get back to you by email.">
        <Link to="/contact" className="btn btn-primary btn-lg">
          Contact us
        </Link>
        <Link to="/help" className="btn btn-on-dark btn-lg">
          Browse the help centre
        </Link>
      </CtaBand>
    </>
  );
}
