import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { describeError } from "../api/client.ts";
import type { Tone } from "../lib/roles.ts";
import { Button, FormError } from "./ui.tsx";
import type { ButtonVariant } from "./ui.tsx";

// ---------------------------------------------------------------------------- modal dialog

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: focus moves inside and is trapped there, Escape or the backdrop closes
 * it, page scrolling is paused, and focus returns to what opened it.
 */
export function Modal({ title, description, onClose, children, footer, size = "md", busy = false }: { title: ReactNode; description?: ReactNode; onClose: () => void; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg"; busy?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!busyRef.current) close.current();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
    if (items.length === 0) return;
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) close.current();
      }}
    >
      <div ref={ref} className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={description ? `${id}-d` : undefined} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="modal-head">
          <h2 className="modal-title" id={`${id}-t`}>
            {title}
          </h2>
          <button type="button" className="modal-x" onClick={() => !busyRef.current && close.current()} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {description && (
          <div className="modal-desc" id={`${id}-d`}>
            {description}
          </div>
        )}
        {children && <div className="modal-body">{children}</div>}
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirmation for an action with consequences. `onConfirm` runs with a busy state; a failure is
 * shown inside the dialog and it stays open. Extra form fields can be passed as children; return
 * a message from `validate` to block confirming.
 */
export function ConfirmDialog({ title, description, children, confirmLabel, variant = "danger", onConfirm, onClose, onDone, validate }: { title: ReactNode; description?: ReactNode; children?: ReactNode; confirmLabel: string; variant?: ButtonVariant; onConfirm: () => Promise<unknown>; onClose: () => void; onDone?: (result: unknown) => void; validate?: () => string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validate?.() ?? null;
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      const r = await onConfirm();
      setBusy(false);
      onDone?.(r);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      description={description}
      onClose={onClose}
      busy={busy}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant={variant} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="form">
        {children}
        <FormError error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- toasts

interface ToastItem {
  id: number;
  tone: Tone;
  text: ReactNode;
}

export type ToastFn = (text: ReactNode, tone?: Tone) => void;

const ToastContext = createContext<ToastFn | null>(null);
const noop: ToastFn = () => undefined;

/** Short confirmations ("Email resent") announced politely; they disappear after a few seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((t) => t.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback<ToastFn>(
    (text, tone = "ok") => {
      const id = ++seq.current;
      setItems((t) => [...t.slice(-3), { id, tone, text }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), tone === "danger" ? 9000 : 6000),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        <div aria-live="polite" className="toasts-inner">
          {items.map((t) => (
            <div key={t.id} className={`toast toast-${t.tone}`}>
              <span className="toast-text">{t.text}</span>
              <button type="button" className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                <span aria-hidden="true">×</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastContext) ?? noop;
}
