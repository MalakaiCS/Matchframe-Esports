import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { describeError } from "../api/client.ts";
import { formatExactSeconds, formatHours, isoDuration } from "../lib/format.ts";
import type { Tone } from "../lib/roles.ts";

// ---------------------------------------------------------------------------- buttons

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  /** When set, the button is disabled and this visible text says why. */
  disabledReason?: string | null;
  block?: boolean;
}

/** A button that can't act always says why, in visible text tied to it with aria-describedby. */
export function Button({ variant = "secondary", size = "md", busy = false, disabledReason, block, className, children, disabled, type = "button", "aria-describedby": describedBy, ...rest }: ButtonProps) {
  const id = useId();
  const reason = disabledReason || null;
  const cls = ["btn", `btn-${variant}`, size !== "md" ? `btn-${size}` : "", block ? "btn-block" : "", busy ? "is-busy" : "", className ?? ""].filter(Boolean).join(" ");
  const button = (
    <button type={type} className={cls} disabled={disabled || busy || !!reason} aria-busy={busy || undefined} aria-describedby={reason ? `${id}-why` : describedBy} {...rest}>
      {busy && <span className="spinner spinner-inline" aria-hidden="true" />}
      {children}
    </button>
  );
  if (!reason) return button;
  return (
    <span className={`btn-wrap${block ? " btn-wrap-block" : ""}`}>
      {button}
      <span className="why" id={`${id}-why`}>
        {reason}
      </span>
    </span>
  );
}

/** Runs an async action with a busy state; failures are shown inline (announced). */
export function ActionButton({ action, onDone, children, ...rest }: Omit<ButtonProps, "onClick"> & { action: () => Promise<unknown>; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <span className="action">
      <Button
        {...rest}
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await action();
            onDone?.();
          } catch (e) {
            if (mounted.current) setError(describeError(e));
          } finally {
            if (mounted.current) setBusy(false);
          }
        }}
      >
        {children}
      </Button>
      <span className="action-error" role="alert">
        {error}
      </span>
    </span>
  );
}

/** Two-step destructive action: the first click asks inline, the second confirms. */
export function ConfirmButton({ label, confirmLabel, question, action, onDone, disabledReason, size = "sm" }: { label: string; confirmLabel: string; question: string; action: () => Promise<unknown>; onDone?: () => void; disabledReason?: string | null; size?: ButtonProps["size"] }) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (asking) confirmRef.current?.querySelector("button")?.focus();
  }, [asking]);
  if (!asking)
    return (
      <Button size={size} variant="ghost" className="btn-danger-text" disabledReason={disabledReason} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <span className="confirm" role="group" aria-label={question}>
      <span className="confirm-q">{question}</span>
      <span ref={confirmRef} className="confirm-actions">
        <ActionButton size={size} variant="danger" action={action} onDone={() => {
          setAsking(false);
          onDone?.();
        }}>
          {confirmLabel}
        </ActionButton>
        <Button size={size} variant="ghost" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------- feedback

export function Alert({ tone = "info", title, children, actions, live = true }: { tone?: Tone; title?: ReactNode; children?: ReactNode; actions?: ReactNode; live?: boolean }) {
  const role = !live ? undefined : tone === "danger" ? "alert" : "status";
  return (
    <div className={`alert alert-${tone}`} role={role}>
      <div className="alert-body">
        {title && <p className="alert-title">{title}</p>}
        {children && <div className="alert-text">{children}</div>}
      </div>
      {actions && <div className="alert-actions">{actions}</div>}
    </div>
  );
}

/** Always-present assertive live region for a form's error, so changes are announced. */
export function FormError({ error }: { error: string | null }) {
  return (
    <div className={`form-error${error ? " has-error" : ""}`} role="alert" aria-live="assertive">
      {error}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = "Couldn't load this" }: { error: string; onRetry?: () => void; title?: string }) {
  return (
    <Alert tone="danger" title={title} actions={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined}>
      {error}
    </Alert>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-text">{children}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

// ---------------------------------------------------------------------------- layout

export function Card({ title, actions, children, className, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const hid = useId();
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || actions) && (
        <header className="card-head">
          {title && (
            <h2 className="card-title" id={hid}>
              {title}
            </h2>
          )}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: string; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 tabIndex={-1} data-page-heading>
          {title}
        </h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}

// ---------------------------------------------------------------------------- forms

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  optional?: boolean;
}

export function FieldShell({ label, hint, error, children, optional }: FieldShellProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field${error ? " field-invalid" : ""}`}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="optional"> (optional)</span>}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({ label, hint, error, optional, onValue, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & { label: string; hint?: ReactNode; error?: string | null; optional?: boolean; onValue: (v: string) => void }) {
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} onChange={(e) => onValue(e.target.value)} {...input} />}
    </FieldShell>
  );
}

export function SelectField({ label, hint, error, onValue, children, ...select }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & { label: string; hint?: ReactNode; error?: string | null; onValue: (v: string) => void }) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} onChange={(e) => onValue(e.target.value)} {...select}>
          {children}
        </select>
      )}
    </FieldShell>
  );
}

export function CheckField({ label, hint, checked, onValue, disabled }: { label: string; hint?: ReactNode; checked: boolean; onValue: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="check">
      <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={(e) => onValue(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- values

/** Auto-director time as "h mm" with the exact value in the tooltip and machine-readable duration. */
export function Hours({ seconds, className }: { seconds: number; className?: string }) {
  return (
    <time className={`hours${className ? ` ${className}` : ""}`} dateTime={isoDuration(seconds)} title={formatExactSeconds(seconds)}>
      {formatHours(seconds)}
    </time>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <>
      <Button
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? "Copied" : label}
      </Button>
      <span className="visually-hidden" role="status">
        {state === "copied" ? "Copied to the clipboard" : state === "failed" ? "Copy failed; select the text and copy it manually" : ""}
      </span>
    </>
  );
}
