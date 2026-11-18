import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { t } from "../i18n/index.ts";

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


export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: ToastTone, title: string, body?: string) => {
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-2), { id, tone, title, body }]);
      setTimeout(() => dismiss(id), tone === "danger" ? 9000 : 4500);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast tone-${toast.tone}`}>
            <div className="toast-head">
              <span className="sr-only">{t(`common.toast.${toast.tone}`)}: </span>
              <strong>{toast.title}</strong>
              <button className="toast-close" aria-label={t("common.dismissNotification")} onClick={() => dismiss(toast.id)}>
                ×
              </button>
            </div>
            {toast.body ? <div className="toast-body">{toast.body}</div> : null}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(Ctx);
}
