import type { ReactNode } from "react";
import { Button } from "./ui.tsx";

/** "Showing 26–50 of 132" with previous/next buttons. */
export function Pagination({ page, pageSize, total, onPage, label = "results" }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; label?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Pagination">
      <p className="pager-info" aria-live="polite">
        {total === 0 ? `No ${label}` : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()} ${label}`}
      </p>
      <div className="pager-buttons">
        <Button size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          <span aria-hidden="true">‹</span> Previous
        </Button>
        <span className="pager-page">
          Page {Math.min(page, pages)} of {pages}
        </span>
        <Button size="sm" onClick={() => onPage(page + 1)} disabled={page >= pages}>
          Next <span aria-hidden="true">›</span>
        </Button>
      </div>
    </nav>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** A row of toggle buttons for a single choice (filters). */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: SegmentOption<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="segment" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="segment-count">{o.count.toLocaleString()}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatCard({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "brand" | "ok" | "warn" | "danger" }) {
  return (
    <div className={`stat-card${tone ? ` stat-card-${tone}` : ""}`}>
      <p className="stat-card-label">{label}</p>
      <p className="stat-card-value">{value}</p>
      {sub && <p className="stat-card-sub">{sub}</p>}
    </div>
  );
}

/** Key/value rows for detail pages. */
export function DetailList({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Two-letter avatar from a name or email. */
export function Initials({ name }: { name: string }) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const text = ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
  return (
    <span className="avatar" aria-hidden="true">
      {text}
    </span>
  );
}
