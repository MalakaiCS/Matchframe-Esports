import { useState } from "react";
import type { ReactNode } from "react";

/** Sortable column heading (click to sort; again to reverse). */
export function SortHeader({ label, k, sort, onSort, className = "" }: { label: string; k: string; sort: { key: string; dir: "asc" | "desc" }; onSort: (s: { key: string; dir: "asc" | "desc" }) => void; className?: string }) {
  const on = sort.key === k;
  return (
    <th className={className} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`sort-btn ${on ? "is-on" : ""}`} onClick={() => onSort({ key: k, dir: on && sort.dir === "asc" ? "desc" : "asc" })}>
        {label}
        <span className="sort-mark" aria-hidden>
          {on ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

/** Title row and toolbar of a list page: search, filters, and the page's actions. */
export function ListHeader({ title, count, actions, children }: { title: string; count?: ReactNode; actions: ReactNode; children?: ReactNode }) {
  return (
    <div className="list-head">
      <div className="list-title-row">
        <h1 className="list-title">
          {title} {count !== undefined ? <span className="list-count">{count}</span> : null}
        </h1>
        <div className="list-actions">{actions}</div>
      </div>
      {children ? <div className="list-toolbar">{children}</div> : null}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="search-box">
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Selection of table rows for bulk actions. */
export function useSelection() {
  const [ids, setIds] = useState<Set<string>>(new Set());
  return {
    ids,
    has: (id: string) => ids.has(id),
    toggle: (id: string) =>
      setIds((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    setAll: (all: string[], on: boolean) => setIds(on ? new Set(all) : new Set()),
    clear: () => setIds(new Set()),
    /** Keeps only ids still shown (after a filter or delete). */
    keep: (visible: string[]) =>
      setIds((s) => {
        const v = new Set(visible);
        const n = new Set([...s].filter((x) => v.has(x)));
        return n.size === s.size ? s : n;
      }),
  };
}

export function SelectAll({ visible, selection, label }: { visible: string[]; selection: ReturnType<typeof useSelection>; label: string }) {
  const all = visible.length > 0 && visible.every((id) => selection.has(id));
  const some = visible.some((id) => selection.has(id));
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = some && !all;
      }}
      onChange={(e) => selection.setAll(visible, e.target.checked)}
    />
  );
}
