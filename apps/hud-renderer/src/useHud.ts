import { useEffect, useRef, useState } from "react";
import type { HudState } from "@matchframe/hud-sdk";
import { HudClient } from "@matchframe/hud-sdk";

export interface HudFeed {
  state: HudState | null;
  receivedAt: number;
  status: "connecting" | "open" | "closed";
  ackSponsor: (sponsorId: string, zone: string) => void;
}

export function useHud(wsUrl: string): HudFeed {
  const client = useRef<HudClient | null>(null);
  const [feed, setFeed] = useState<HudFeed>({ state: null, receivedAt: 0, status: "connecting", ackSponsor: (id, zone) => client.current?.ackSponsor(id, zone) });
  useEffect(() => {
    const c = new HudClient({
      url: wsUrl,
      onState: (state, receivedAt) => setFeed((f) => ({ ...f, state, receivedAt })),
      onStatus: (status) => setFeed((f) => ({ ...f, status })),
    });
    client.current = c;
    c.start();
    return () => c.stop();
  }, [wsUrl]);
  return feed;
}

/** Re-renders at the given interval (for clocks that advance locally between updates). */
export function useTicker(ms: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
