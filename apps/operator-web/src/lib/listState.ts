import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Search, filters, sort and scroll of a list page, kept for the session in this module, so coming
 * back from an editor shows the list as it was left.
 */
export interface ListState<F extends Record<string, string>> {
  search: string;
  filters: F;
  sort: { key: string; dir: "asc" | "desc" };
  scrollTop: number;
}

const store = new Map<string, ListState<Record<string, string>>>();

/** For tests. */
export function resetListStates(): void {
  store.clear();
}

export function useListState<F extends Record<string, string>>(key: string, initial: Omit<ListState<F>, "scrollTop">) {
  const [state, setState] = useState<ListState<F>>(() => (store.get(key) as ListState<F> | undefined) ?? { ...initial, scrollTop: 0 });
  const ref = useRef(state);
  ref.current = state;
  const update = useCallback(
    (patch: Partial<Omit<ListState<F>, "scrollTop">>) => {
      setState((s) => {
        const next = { ...s, ...patch };
        store.set(key, next as ListState<Record<string, string>>);
        return next;
      });
    },
    [key],
  );
  // Remember the scroll position of the console's content area when leaving the list.
  useEffect(
    () => () => {
      const main = document.getElementById("main");
      store.set(key, { ...(ref.current as ListState<Record<string, string>>), scrollTop: main?.scrollTop ?? 0 });
    },
    [key],
  );
  return { state, update };
}

/** Restores the remembered scroll position once the list has rendered its rows. */
export function useRestoreScroll(scrollTop: number, ready: boolean): void {
  const done = useRef(false);
  useLayoutEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const main = document.getElementById("main");
    if (main && scrollTop > 0) main.scrollTop = scrollTop;
  }, [ready, scrollTop]);
}

/** Compares two values for a sortable column (text case-insensitively, empty last). */
export function compareValues(a: unknown, b: unknown): number {
  const ea = a === null || a === undefined || a === "";
  const eb = b === null || b === undefined || b === "";
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

export function sortRows<T>(rows: T[], sort: { key: string; dir: "asc" | "desc" }, value: (row: T, key: string) => unknown): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const c = compareValues(value(x, sort.key), value(y, sort.key));
    // Empty values stay last in both directions.
    const ex = value(x, sort.key);
    const ey = value(y, sort.key);
    const emptyX = ex === null || ex === undefined || ex === "";
    const emptyY = ey === null || ey === undefined || ey === "";
    if (emptyX !== emptyY) return emptyX ? 1 : -1;
    return c * sign;
  });
}
