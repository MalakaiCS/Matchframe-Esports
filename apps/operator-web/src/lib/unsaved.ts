import { useCallback, useEffect, useRef, useState } from "react";
import { setNavigationBlocker } from "../router.tsx";

export interface UnsavedGuard {
  /** Where the person was going when asked (null: not asking). */
  pending: (() => void) | null;
  keepEditing: () => void;
  /** Leave without saving (runs the held navigation or action). */
  discard: () => void;
  /** After a successful save: leave without asking. */
  release: () => void;
  /** Ask before an action of the page's own (Cancel, Add player…); runs it at once when nothing changed. */
  ask: (proceed: () => void) => void;
}

/**
 * Guards a form with unsaved changes: in-app navigation (links, the sidebar, Back, the browser's
 * back button) waits for the person to keep editing or discard; closing the window asks too
 * (`beforeunload`; the desktop program shows its own dialog for it).
 */
export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const [pending, setPending] = useState<{ go: () => void } | null>(null);
  const released = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const off = setNavigationBlocker((proceed) => {
      if (released.current || !dirtyRef.current) return false;
      setPending({ go: proceed });
      return true;
    });
    const onUnload = (e: BeforeUnloadEvent) => {
      if (released.current || !dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      off();
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [dirty]);

  const keepEditing = useCallback(() => setPending(null), []);
  const discard = useCallback(() => {
    const go = pending?.go;
    setPending(null);
    released.current = true;
    go?.();
  }, [pending]);
  const release = useCallback(() => {
    released.current = true;
  }, []);
  const ask = useCallback((proceed: () => void) => {
    if (!dirtyRef.current || released.current) return proceed();
    setPending({ go: proceed });
  }, []);
  return { pending: pending?.go ?? null, keepEditing, discard, release, ask };
}
