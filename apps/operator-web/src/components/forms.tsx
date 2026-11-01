import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { api, ApiError, describeError, seg } from "../api/index.ts";
import type { StagedImage } from "../api/types.ts";
import { countryLabel, countryOptions, flagUrl } from "../lib/flags.ts";
import { assetUrl } from "./AssetUpload.tsx";
import { Button } from "./ui.tsx";

/** A labelled form field with its own error line (the control gets `id` and aria-invalid). */
export function FormField({ label, htmlFor, hint, error, required, children, className = "" }: { label: ReactNode; htmlFor: string; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={`ff ${error ? "has-error" : ""} ${className}`}>
      <label className="ff-label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="ff-req" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <span className="ff-error" role="alert" id={`${htmlFor}-error`}>
          {error}
        </span>
      ) : hint ? (
        <span className="ff-hint">{hint}</span>
      ) : null}
    </div>
  );
}

/** Field errors from an engine validation error ({path: [field, …], message} details). */
export function fieldErrorsOf(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !Array.isArray(e.detail)) return {};
  const out: Record<string, string> = {};
  for (const d of e.detail as { path?: (string | number)[]; message?: string }[]) {
    const k = d.path?.map(String).join(".");
    if (k && d.message && !out[k]) out[k] = d.message;
    const top = d.path?.[0];
    if (top !== undefined && d.message && !out[String(top)]) out[String(top)] = d.message;
  }
  return out;
}

export function Flag({ code, size = 16 }: { code: string | null | undefined; size?: number }) {
  const url = flagUrl(code);
  if (!code) return null;
  if (!url) return <span className="flag flag-missing">{code}</span>;
  return <img className="flag" src={url} alt="" width={Math.round(size * 1.5)} height={size} title={countryLabel(code)} />;
}

export function CountryText({ code }: { code: string | null | undefined }) {
  if (!code) return <span className="muted">—</span>;
  return (
    <span className="country">
      <Flag code={code} /> {countryLabel(code)}
    </span>
  );
}

export interface ComboOption {
  key: string;
  label: string;
  /** Extra text the search also matches (short names, codes). */
  keywords?: string;
  icon?: ReactNode;
  hint?: ReactNode;
}

/**
 * Searchable single-choice dropdown (combobox): type to filter, arrow keys and Enter to choose,
 * Escape to close. `emptyLabel` adds a "none" choice (e.g. Unassigned).
 */
export function Combobox({ id, options, value, onChange, placeholder = "Search…", emptyLabel, invalid, disabled, ariaLabel }: { id: string; options: ComboOption[]; value: string | null; onChange: (key: string | null) => void; placeholder?: string; emptyLabel?: string; invalid?: boolean; disabled?: boolean; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const selected = options.find((o) => o.key === value) ?? null;
  const all = useMemo(() => (emptyLabel ? [{ key: "", label: emptyLabel } as ComboOption, ...options] : options), [emptyLabel, options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((o) => o.key !== "" && `${o.label} ${o.keywords ?? ""}`.toLowerCase().includes(q));
  }, [all, query]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);
  const choose = (o: ComboOption | undefined) => {
    if (!o) return;
    onChange(o.key === "" ? null : o.key);
    setOpen(false);
    setQuery("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      if (open) {
        e.preventDefault();
        choose(filtered[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.stopPropagation();
        setOpen(false);
        setQuery("");
      }
    }
  };
  return (
    <div className={`cbx ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""}`} ref={ref}>
      <div className="cbx-control" onMouseDown={(e) => (e.target as HTMLElement).tagName !== "INPUT" && !disabled && (e.preventDefault(), setOpen((o) => !o))}>
        {!open || !query ? (selected?.icon ? <span className="cbx-icon">{selected.icon}</span> : null) : null}
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          aria-label={ariaLabel}
          aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={selected ? selected.label : emptyLabel && value === null ? emptyLabel : placeholder}
          value={open ? query : (selected?.label ?? (value === null && emptyLabel ? emptyLabel : ""))}
          onFocus={() => {
            setOpen(true);
            setActive(Math.max(0, all.findIndex((o) => o.key === (value ?? ""))));
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKey}
        />
        <span className="cbx-caret" aria-hidden>
          ▾
        </span>
      </div>
      {open ? (
        <ul className="cbx-list" role="listbox" id={listId} ref={listRef}>
          {filtered.length === 0 ? <li className="cbx-empty">No matches</li> : null}
          {filtered.map((o, i) => (
            <li
              key={o.key || "__none"}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={(o.key || null) === value}
              className={`cbx-opt ${i === active ? "is-active" : ""} ${(o.key || null) === value ? "is-selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {o.icon ? <span className="cbx-icon">{o.icon}</span> : null}
              <span className="cbx-label">{o.label}</span>
              {o.hint ? <span className="cbx-hint">{o.hint}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CountrySelect({ id, value, onChange, invalid }: { id: string; value: string | null; onChange: (code: string | null) => void; invalid?: boolean }) {
  const options = useMemo(() => countryOptions().map((c) => ({ key: c.code, label: c.name, keywords: c.code, icon: <Flag code={c.code} /> })), []);
  return <Combobox id={id} options={options} value={value} onChange={onChange} placeholder="Search countries" emptyLabel="No country" invalid={invalid} />;
}

export interface TeamChoice {
  id: string;
  name: string;
  shortName: string;
  logoAssetId: string | null;
  archived?: boolean;
}

export function TeamLogo({ assetId, size = 28, name }: { assetId: string | null | undefined; size?: number; name?: string }) {
  const url = assetUrl(assetId);
  return (
    <span className="team-logo" style={{ width: size, height: size }}>
      {url ? <img src={url} alt={name ? `${name} logo` : ""} /> : <span className="team-logo-empty" aria-hidden>{(name ?? "?").slice(0, 2).toUpperCase()}</span>}
    </span>
  );
}

export function TeamSelect({ id, teams, value, onChange, emptyLabel, invalid, exclude, disabled }: { id: string; teams: TeamChoice[]; value: string | null; onChange: (id: string | null) => void; emptyLabel?: string; invalid?: boolean; exclude?: string | null; disabled?: boolean }) {
  const options = useMemo(
    () =>
      teams
        .filter((t) => !t.archived || t.id === value)
        .map((t) => ({ key: t.id, label: t.name, keywords: t.shortName, icon: <TeamLogo assetId={t.logoAssetId} size={20} name={t.name} />, hint: t.id === exclude ? "already the other team" : t.shortName })),
    [teams, value, exclude],
  );
  return <Combobox id={id} options={options} value={value} onChange={onChange} placeholder="Search teams" emptyLabel={emptyLabel} invalid={invalid} disabled={disabled} />;
}

export const IMAGE_LIMIT = 2 * 1024 * 1024;

export interface ImageValue {
  assetId: string | null;
  staged: StagedImage | null;
}

/** Throws away a staged upload (Cancel, Remove, Replace); the engine sweeps any it misses. */
export function discardStaged(staged: StagedImage | null | undefined): void {
  if (staged) void api.del(`/api/v1/uploads/images/${seg(staged.stagedId)}`).catch(() => undefined);
}

/**
 * Logo/avatar picker: drop or choose a PNG, JPEG or WebP (2 MB at most). The engine checks the
 * bytes and keeps the upload staged until the record is saved; the preview shows the whole image.
 */
export function ImageField({ id, label, value, onChange, kind, disabledReason }: { id: string; label: string; value: ImageValue; onChange: (v: ImageValue) => void; kind: "logo" | "avatar"; disabledReason?: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const url = value.staged?.previewUrl ?? assetUrl(value.assetId);
  const upload = async (f: File) => {
    setError(null);
    if (!/\.(png|jpe?g|webp)$/i.test(f.name) && !/^image\/(png|jpeg|webp)$/.test(f.type)) return setError(`${f.name} is not a PNG, JPEG or WebP image.`);
    if (f.size > IMAGE_LIMIT) return setError(`${f.name} is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB.`);
    setBusy(true);
    try {
      const staged = await api.upload<StagedImage>("/api/v1/uploads/images", await f.arrayBuffer(), f.type || "application/octet-stream");
      discardStaged(value.staged);
      onChange({ assetId: value.assetId, staged });
    } catch (e) {
      setError(describeError(e).replace(/^Invalid request: /, ""));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const blocked = disabledReason ?? null;
  return (
    <div
      className={`imgfield ${over ? "is-over" : ""}`}
      onDragOver={(e) => {
        if (blocked) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !blocked) void upload(f);
      }}
    >
      <div className={`imgfield-preview ${kind === "avatar" ? "is-avatar" : ""}`}>
        {url ? <img src={url} alt={`${label} preview`} /> : <span className="imgfield-empty">No {label.toLowerCase()}</span>}
      </div>
      <div className="imgfield-side">
        <p className="small">
          Drop a PNG, JPEG or WebP here, or choose a file. Up to 2 MB. A square image of at least 200 × 200 pixels works best; the whole image is shown.
        </p>
        <input id={id} ref={input} type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" className="sr-only" aria-label={`Upload ${label.toLowerCase()}`} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <div className="row">
          <Button size="sm" onClick={() => input.current?.click()} disabled={busy} disabledReason={blocked}>
            {busy ? "Uploading…" : url ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
          </Button>
          {url ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                discardStaged(value.staged);
                onChange({ assetId: null, staged: null });
                setError(null);
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
        {value.staged ? (
          <span className="small muted">
            New image, {value.staged.width} × {value.staged.height} {value.staged.type.toUpperCase()}: kept when you choose Save and Exit.
          </span>
        ) : null}
        {value.staged?.advice ? <span className="small text-warn">{value.staged.advice}</span> : null}
        {error ? (
          <span className="ff-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
