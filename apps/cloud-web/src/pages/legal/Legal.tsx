import { Icon } from "../../components/icons.tsx";
import { PageHero, Prose } from "../../components/marketing.tsx";
import { Alert, Button, Loading } from "../../components/ui.tsx";
import { LEGAL_DOCS, legalDoc } from "../../content/legal.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { SITE_FALLBACK, useSite } from "../../state/site.ts";
import { NotFound } from "../site/NotFound.tsx";

/** "2026-10-01" → "1 October 2026" in the viewer's locale (the date itself never shifts by time zone). */
export function formatLegalDate(ymd: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function LegalHub() {
  useTitle("Legal", "Matchframe's terms of service, privacy policy, cookie policy, refund and cancellation policy, acceptable use policy and end user licence agreement.");
  const { site } = useSite();
  return (
    <>
      <PageHero eyebrow="Legal" title="Legal information" lead={site ? <>The terms and policies that apply when you use {site.websiteName}. Last updated {formatLegalDate(site.legalEffectiveDate)}.</> : "The terms and policies that apply when you use Matchframe."} />
      <div className="wrap section-top">
        <ul className="legal-grid">
          {LEGAL_DOCS.map((d) => (
            <li key={d.slug}>
              <Link to={`/legal/${d.slug}`} className="legal-card">
                <span className="legal-card-title">{d.title}</span>
                <span className="legal-card-text">{d.summary}</span>
                <span className="legal-card-more" aria-hidden="true">
                  Read <Icon name="arrow" size={16} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="small muted legal-note">
          Questions about these documents? <Link to="/contact?topic=legal">Contact us</Link>. For how we protect your data, see the <Link to="/security">security overview</Link>.
        </p>
      </div>
    </>
  );
}

export function LegalDocPage({ slug }: { slug: string }) {
  const doc = legalDoc(slug);
  useTitle(doc ? doc.title : "Document not found", doc?.summary);
  const { site, loading, error, reload } = useSite();
  if (!doc) return <NotFound />;
  const s = site ?? SITE_FALLBACK;
  return (
    <>
      <PageHero eyebrow="Legal" title={doc.title} crumbs={[{ to: "/legal", label: "Legal" }]} lead={site ? <>Last updated {formatLegalDate(site.legalEffectiveDate)}</> : loading ? "Loading company details…" : undefined} />
      <div className="wrap section-top legal-layout">
        <article className="legal-body">
          {loading && !site && <Loading label="Loading company details…" />}
          {error && !site && (
            <Alert tone="warn" title="Company details couldn't be loaded" actions={<Button size="sm" onClick={reload}>Try again</Button>}>
              The document is shown with generic wording. {error}
            </Alert>
          )}
          {(site || error) && <Prose>{doc.render(s)}</Prose>}
        </article>
        <aside className="legal-side" aria-label="Legal documents">
          <nav className="side-card" aria-label="Other legal documents">
            <p className="side-card-title">Legal documents</p>
            <ul className="side-links">
              {LEGAL_DOCS.map((d) => (
                <li key={d.slug}>
                  <Link to={`/legal/${d.slug}`} aria-current={d.slug === slug ? "page" : undefined}>
                    {d.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {site && (
            <div className="side-card">
              <p className="side-card-title">{site.companyName}</p>
              {site.address && <p className="small pre-line">{site.address}</p>}
              {site.supportEmail && (
                <p className="small">
                  <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
                </p>
              )}
              <p className="small">
                <Link to="/contact?topic=legal">Contact form</Link>
              </p>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
