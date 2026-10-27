import type { ReactNode } from "react";
import { Link } from "../router.tsx";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";

/** Real screenshots of the program, shipped in public/images (WebP, two widths). */
export type ShotName = "live-control" | "huds-outputs" | "matches-veto" | "setup" | "maps-cameras" | "hud-broadcast";

const BIG: Record<ShotName, number> = { "live-control": 1600, "huds-outputs": 1600, "matches-veto": 1600, setup: 1600, "maps-cameras": 1600, "hud-broadcast": 1280 };

export function Screenshot({ name, alt, caption, eager, chrome = true }: { name: ShotName; alt: string; caption?: ReactNode; eager?: boolean; chrome?: boolean }) {
  const big = BIG[name];
  return (
    <figure className="shot">
      <div className={`shot-frame${chrome ? "" : " shot-frame-plain"}`}>
        {chrome && (
          <span className="shot-bar" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        <img
          src={`/images/${name}-${big}.webp`}
          srcSet={`/images/${name}-800.webp 800w, /images/${name}-${big}.webp ${big}w`}
          sizes="(min-width: 1100px) 620px, (min-width: 720px) 80vw, 100vw"
          alt={alt}
          width={big}
          height={Math.round((big * 9) / 16)}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
        />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Heading block for inner public pages (eyebrow, title, lead, optional actions). */
export function PageHero({ eyebrow, title, lead, children, crumbs }: { eyebrow?: ReactNode; title: string; lead?: ReactNode; children?: ReactNode; crumbs?: { to: string; label: string }[] }) {
  return (
    <header className="page-hero">
      <div className="wrap">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="crumbs">
            <ol>
              {crumbs.map((c) => (
                <li key={c.to}>
                  <Link to={c.to}>{c.label}</Link>
                </li>
              ))}
            </ol>
          </nav>
        )}
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 tabIndex={-1} data-page-heading>
          {title}
        </h1>
        {lead && <p className="page-hero-lead">{lead}</p>}
        {children && <div className="page-hero-actions">{children}</div>}
      </div>
    </header>
  );
}

export function SectionHead({ eyebrow, title, lead, id, center }: { eyebrow?: ReactNode; title: string; lead?: ReactNode; id?: string; center?: boolean }) {
  return (
    <div className={`section-head-lg${center ? " is-center" : ""}`}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2 id={id} className="display-2">
        {title}
      </h2>
      {lead && <p className="section-lead">{lead}</p>}
    </div>
  );
}

export interface Feature {
  icon: IconName;
  title: string;
  text: ReactNode;
}

export function FeatureGrid({ items, columns = 3 }: { items: Feature[]; columns?: 2 | 3 | 4 }) {
  return (
    <ul className={`feature-grid cols-${columns}`}>
      {items.map((f) => (
        <li key={f.title} className="feature">
          <span className="feature-icon">
            <Icon name={f.icon} />
          </span>
          <h3 className="feature-title">{f.title}</h3>
          <p className="feature-text">{f.text}</p>
        </li>
      ))}
    </ul>
  );
}

/** Alternating text + screenshot row. */
export function Spotlight({ id, eyebrow, title, children, shot, reverse }: { id?: string; eyebrow?: ReactNode; title: string; children: ReactNode; shot: ReactNode; reverse?: boolean }) {
  return (
    <section className={`spotlight${reverse ? " is-reverse" : ""}`} aria-labelledby={id ? `${id}-title` : undefined} id={id}>
      <div className="spotlight-text">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h3 id={id ? `${id}-title` : undefined} className="display-3">
          {title}
        </h3>
        {children}
      </div>
      <div className="spotlight-media">{shot}</div>
    </section>
  );
}

export function CheckList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="check-list">
      {items.map((t, i) => (
        <li key={i}>
          <Icon name="check" size={18} className="check-icon" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** Comparison-table mark for "included": a check, with its meaning for screen readers. */
export function Included({ label = "Included" }: { label?: string }) {
  return (
    <span className="cmp-yes">
      <Icon name="check" size={18} />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/** Comparison-table mark for "not included": a dash, with its meaning for screen readers. */
export function NotIncluded({ label = "Not included" }: { label?: string }) {
  return (
    <span className="cmp-no">
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

export function Steps({ items }: { items: { title: string; text: ReactNode; icon?: IconName }[] }) {
  return (
    <ol className="steps">
      {items.map((s, i) => (
        <li key={s.title} className="step">
          <span className="step-num" aria-hidden="true">
            {s.icon ? <Icon name={s.icon} /> : i + 1}
          </span>
          <div>
            <h3 className="step-title">
              <span className="visually-hidden">Step {i + 1}: </span>
              {s.title}
            </h3>
            <div className="step-text">{s.text}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Closing call to action on the dark stage background. */
export function CtaBand({ title, text, children }: { title: string; text?: ReactNode; children: ReactNode }) {
  return (
    <section className="cta-band" aria-labelledby="cta-title">
      <div className="wrap cta-inner">
        <div>
          <h2 id="cta-title" className="display-2">
            {title}
          </h2>
          {text && <p className="cta-text">{text}</p>}
        </div>
        <div className="cta-actions">{children}</div>
      </div>
    </section>
  );
}

/** Highlighted note ("Good to know"). */
export function Callout({ title, children, tone = "brand" }: { title: string; children: ReactNode; tone?: "brand" | "warn" }) {
  return (
    <aside className={`callout callout-${tone}`} aria-label={title}>
      <p className="callout-title">{title}</p>
      <div className="callout-body">{children}</div>
    </aside>
  );
}

/** Prose wrapper for long-form content (legal, help articles). */
export function Prose({ children }: { children: ReactNode }) {
  return <div className="prose">{children}</div>;
}
