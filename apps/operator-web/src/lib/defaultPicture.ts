import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/index.ts";

/** The default player picture (Settings → General): shown for any player without a picture of their own. */
export interface DefaultPlayerPicture {
  assetId: string | null;
  url: string | null;
}

let current: DefaultPlayerPicture | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Loads it once for the whole console (again after `refresh`). */
function load(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api
    .get<DefaultPlayerPicture>("/api/v1/default-player-picture")
    .then((v) => {
      current = v;
      emit();
    })
    .catch(() => {
      // Not reachable yet (or no permission): players without a picture keep their initial.
      loading = null;
    });
  return loading;
}

/** After a change on the Settings page: every avatar in the console updates. */
export function setDefaultPlayerPicture(v: DefaultPlayerPicture): void {
  current = v;
  loading = Promise.resolve();
  emit();
}

export function refreshDefaultPlayerPicture(): Promise<void> {
  return load(true);
}

/** The default player picture's address, or null when none is set (or not loaded yet). */
export function useDefaultPlayerPicture(): DefaultPlayerPicture | null {
  const v = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
  useEffect(() => {
    if (!current) void load();
  }, []);
  return v;
}

/** For tests: forget the cached value. */
export function resetDefaultPlayerPicture(): void {
  current = null;
  loading = null;
  emit();
}
