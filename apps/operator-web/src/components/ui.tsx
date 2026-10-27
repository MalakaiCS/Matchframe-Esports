import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Support } from "@matchframe/contracts";
import { describeError } from "../api/index.ts";
import { SUPPORT_TEXT } from "../lib/capabilities.ts";
import { evidenceText } from "../lib/evidence.ts";
import { useToast } from "./toasts.tsx";

export type Tone = "neutral" | "info" | "ok" | "warn" | "danger" | "sim" | "accent";

export function Badge({ tone = "neutral", icon, children, title, className = "" }: { tone?: Tone; icon?: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`badge tone-${tone} ${className}`} title={title}>
      {icon ? (
        <span className="badge-icon" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

export function SupportBadge({ support, title }: { support: Support | "unknown"; title?: string }) {
  if (support === "unknown") return <Badge title={title}>UNKNOWN</Badge>;
  const s = SUPPORT_TEXT[support];
  return (
    <Badge tone={s.tone} icon={s.icon} title={title}>
      {s.text}
    </Badge>
  );
}

export function EvidenceBadge({ evidence }: { evidence: string }) {
  const e = evidenceText(evidence);
  return (
    <Badge tone={e.tone} title={e.hint} className="badge-evidence">
      {e.text}
    </Badge>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "warn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  /** When set the button is disabled and the reason is shown next to it (and announced). */
  disabledReason?: string | null;
  reasonPlacement?: "inline" | "tooltip";
}

export function Button({ variant = "secondary", size = "md", disabledReason, reasonPlacement = "inline", className = "", children, disabled, title, ...rest }: ButtonProps) {
  const id = useId();
  const reason = disabledReason ?? null;
  const btn = (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={disabled || reason !== null}
      aria-describedby={reason ? `${id}-r` : undefined}
      title={reason ?? title}
      {...rest}
    >
      {children}
    </button>
  );
  if (!reason) return btn;
  return (
    <span className={`btn-wrap ${reasonPlacement === "tooltip" ? "reason-tooltip" : ""}`}>
      {btn}
      <span id={`${id}-r`} className={reasonPlacement === "tooltip" ? "sr-only" : "disabled-reason"}>
        {reason}
      </span>
    </span>
  );
}

export interface ConfirmSpec {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  /** Ask for a free-text reason (passed to the action). */
  reasonLabel?: string;
  danger?: boolean;
}

export interface ActionButtonProps<T> extends Omit<ButtonProps, "onClick"> {
  action: (reason?: string) => Promise<T>;
  /** Toast text on success (string or function of the result). Return null to suppress. */
  success?: string | ((r: T) => string | null) | null;
  onDone?: (r: T) => void;
  confirm?: ConfirmSpec;
  /** Show the last error under the button (default true). */
  inlineError?: boolean;
}

export function ActionButton<T>({ action, success, onDone, confirm, inlineError = true, children, disabledReason, ...rest }: ActionButtonProps<T>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const run = async (reason?: string) => {
    setPending(true);
    setError(null);
    try {
      const r = await action(reason);
      const msg = typeof success === "function" ? success(r) : success === undefined ? null : success;
      if (msg) toast.push("ok", msg);
      onDone?.(r);
    } catch (e) {
      const m = describeError(e);
      setError(m);
      toast.push("danger", typeof children === "string" ? `${children} failed` : "Action failed", m);
    } finally {
      setPending(false);
    }
  };
  return (
    <span className="action">
      <Button {...rest} disabledReason={disabledReason} disabled={pending || rest.disabled} aria-busy={pending} onClick={() => (confirm ? setConfirming(true) : void run())}>
        {pending ? <span className="spinner" aria-hidden /> : null}
        {children}
      </Button>
      {inlineError && error ? (
        <span className="action-error" role="alert">
          {error}
        </span>
      ) : null}
      {confirming && confirm ? (
        <ConfirmDialog
          spec={confirm}
          onCancel={() => setConfirming(false)}
          onConfirm={(reason) => {
            setConfirming(false);
            void run(reason);
          }}
        />
      ) : null}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button:not(.modal-close)");
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={ref} tabIndex={-1}>
        <header className="modal-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <button className="modal-close" aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({ spec, onConfirm, onCancel }: { spec: ConfirmSpec; onConfirm: (reason?: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const needReason = !!spec.reasonLabel;
  return (
    <Modal
      title={spec.title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={spec.danger ? "danger" : "primary"} disabledReason={needReason && reason.trim().length < 3 ? "Enter a reason (at least 3 characters)" : null} reasonPlacement="tooltip" onClick={() => onConfirm(needReason ? reason.trim() : undefined)}>
            {spec.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {spec.body ? <div className="confirm-body">{spec.body}</div> : null}
      {needReason ? (
        <Field label={spec.reasonLabel!}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}
    </Modal>
  );
}

export function Panel({ title, actions, children, className = "", subtitle, id }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; subtitle?: ReactNode; id?: string }) {
  return (
    <section className={`panel ${className}`} id={id}>
      <header className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle ? <div className="panel-subtitle">{subtitle}</div> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <Badge tone="danger" icon="!">
        ERROR
      </Badge>
      <span className="error-text">{error}</span>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

/** Renders loading / error / children for an API resource. */
export function Async<T>({ state, children, empty }: { state: { data: T | undefined; error: string | null; loading: boolean; reload: () => Promise<void> }; children: (d: T) => ReactNode; empty?: ReactNode }) {
  if (state.data === undefined) {
    if (state.error) return <ErrorBox error={state.error} onRetry={() => void state.reload()} />;
    return state.loading ? <Loading /> : <>{empty ?? null}</>;
  }
  return (
    <>
      {state.error ? <ErrorBox error={`Refresh failed: ${state.error}`} onRetry={() => void state.reload()} /> : null}
      {children(state.data)}
    </>
  );
}

export function Field({ label, hint, children, className = "" }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <label className={`check ${disabled ? "is-disabled" : ""}`} title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          className={`tab ${t.id === value ? "is-active" : ""}`}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.id === value);
            if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length]!.id);
            if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length]!.id);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy", size = "sm" }: { text: string; label?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <Button size={size} onClick={() => void copy()}>
      {done ? "Copied ✓" : label}
    </Button>
  );
}

export function Meter({ value, max = 1, tone = "accent", label }: { value: number | null; max?: number; tone?: Tone; label?: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={`meter tone-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined} aria-label={label}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono">{children}</code>;
}

export function Note({ tone = "info", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  const tag = { neutral: "NOTE", info: "NOTE", ok: "OK", warn: "CAUTION", danger: "WARNING", sim: "SIMULATION", accent: "TIP" }[tone];
  return (
    <div className={`note tone-${tone}`}>
      <span className="note-tag">{title ?? tag}</span>
      <div className="note-body">{children}</div>
    </div>
  );
}

/** JSON textarea with parse validation. */
export function JsonEditor({ value, onChange, rows = 8, label }: { value: string; onChange: (v: string) => void; rows?: number; label: string }) {
  let err: string | null = null;
  try {
    if (value.trim()) JSON.parse(value);
  } catch (e) {
    err = e instanceof Error ? e.message : "invalid JSON";
  }
  return (
    <Field label={label} hint={err ? <span className="text-danger">Invalid JSON: {err}</span> : "JSON"}>
      <textarea className="mono" rows={rows} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} aria-invalid={!!err} />
    </Field>
  );
}

export function parseJsonOr<T>(text: string, fallback: T): { ok: true; value: T } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: fallback };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

export function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`dot tone-${tone}`} aria-hidden />;
}
