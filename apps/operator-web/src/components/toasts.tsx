import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastTone = "ok" | "info" | "warn" | "danger";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string | undefined;
}

interface ToastApi {
  push: (tone: ToastTone, title: string, body?: string) => void;
}

const Ctx = createContext<ToastApi>({ push: () => undefined });

const TONE_LABEL: Record<ToastTone, string> = { ok: "Done", info: "Info", warn: "Warning", danger: "Failed" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: ToastTone, title: string, body?: string) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-2), { id, tone, title, body }]);
      setTimeout(() => dismiss(id), tone === "danger" ? 9000 : 4500);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast tone-${t.tone}`}>
            <div className="toast-head">
              <span className="sr-only">{TONE_LABEL[t.tone]}: </span>
              <strong>{t.title}</strong>
              <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
                ×
              </button>
            </div>
            {t.body ? <div className="toast-body">{t.body}</div> : null}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(Ctx);
}
