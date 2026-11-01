import { useCallback, useEffect, useRef, useState } from "react";

const stable = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
export const sameValue = (a: unknown, b: unknown) => stable(a) === stable(b);

export interface Draft<T extends Record<string, unknown>> {
  draft: T;
  /** The values the form loaded (per field; updated by live merges of fields not edited here). */
  original: T;
  set: (patch: Partial<T>) => void;
  dirty: boolean;
  /** Fields edited here, with their new values. */
  changes: () => Partial<T>;
  /** The loaded values of the edited fields (the engine checks them: someone else may have changed one). */
  expected: () => Partial<T>;
  /** Takes the server's values for these fields (after a conflict). */
  reload: (fields: (keyof T)[]) => void;
}

/**
 * An editor's working copy. When the record changes elsewhere while the form is open (a live
 * result, another computer), fields not edited here follow the new values; edited fields keep the
 * person's values, and the save's per-field check reports the clash instead of overwriting.
 */
export function useDraft<T extends Record<string, unknown>>(server: T | undefined, empty: T): Draft<T> {
  const [draft, setDraft] = useState<T>(server ?? empty);
  const [original, setOriginal] = useState<T>(server ?? empty);
  const seen = useRef<T | undefined>(server);
  const latest = useRef(server);
  latest.current = server;
  useEffect(() => {
    if (!server || (seen.current && sameValue(seen.current, server))) return;
    const first = seen.current === undefined;
    seen.current = server;
    if (first) {
      setDraft(server);
      setOriginal(server);
      return;
    }
    setDraft((d) => {
      const next = { ...d };
      for (const k of Object.keys(server) as (keyof T)[]) if (sameValue(d[k], original[k])) next[k] = server[k];
      return next;
    });
    setOriginal((o) => {
      const next = { ...o };
      for (const k of Object.keys(server) as (keyof T)[]) if (sameValue(draft[k], o[k])) next[k] = server[k];
      return next;
    });
  }, [server, draft, original]);
  const set = useCallback((patch: Partial<T>) => setDraft((d) => ({ ...d, ...patch })), []);
  const changed = (Object.keys(draft) as (keyof T)[]).filter((k) => !sameValue(draft[k], original[k]));
  const changes = useCallback(() => Object.fromEntries(changed.map((k) => [k, draft[k]])) as Partial<T>, [changed, draft]);
  const expected = useCallback(() => Object.fromEntries(changed.map((k) => [k, original[k]])) as Partial<T>, [changed, original]);
  const reload = useCallback((fields: (keyof T)[]) => {
    const s = latest.current;
    if (!s) return;
    setDraft((d) => ({ ...d, ...Object.fromEntries(fields.map((k) => [k, s[k]])) }));
    setOriginal((o) => ({ ...o, ...Object.fromEntries(fields.map((k) => [k, s[k]])) }));
  }, []);
  return { draft, original, set, dirty: changed.length > 0, changes, expected, reload };
}
