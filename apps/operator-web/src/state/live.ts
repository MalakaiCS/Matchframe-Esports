import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DirectorDecision, SourceCapabilities } from "@matchframe/contracts";
import { api } from "../api/index.ts";
import { getOperatorToken } from "../api/auth.ts";
import type { ArbiterEvent, DerivedEvent, EngineAlert, EventEnvelope, Me, OperatorSnapshot } from "../api/types.ts";
import type { SocketInfo, SocketStatus } from "../api/ws.ts";
import { OperatorSocket } from "../api/ws.ts";
import { EngineClock } from "../lib/clock.ts";

export interface AlertItem extends EngineAlert {
  id: string;
  at: number;
  count: number;
}

export interface LiveState {
  status: SocketStatus;
  info: SocketInfo;
  snapshot: OperatorSnapshot | null;
  /** Client time the latest snapshot arrived. */
  snapshotAt: number;
  sessionId: string | null;
  epoch: number | null;
  /** Client time the telemetry sequence last advanced (a new packet was ingested). */
  sequenceChangedAt: number;
  events: DerivedEvent[];
  alerts: AlertItem[];
  arbiterLog: ArbiterEvent[];
  decisions: DirectorDecision[];
  capabilitiesAt: number;
}

const MAX_EVENTS = 600;

const initial: LiveState = {
  status: "idle",
  info: { attempt: 0, nextRetryInMs: null, lastError: null },
  snapshot: null,
  snapshotAt: 0,
  sessionId: null,
  epoch: null,
  sequenceChangedAt: 0,
  events: [],
  alerts: [],
  arbiterLog: [],
  decisions: [],
  capabilitiesAt: 0,
};

export class LiveStore {
  state: LiveState = initial;
  readonly clock = new EngineClock();
  private readonly listeners = new Set<() => void>();
  private readonly seenEvents = new Set<string>();
  private alertSeq = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  reset(): void {
    this.seenEvents.clear();
    this.clock.reset();
    this.set({ ...initial });
  }

  mergeEvents(evs: DerivedEvent[]): void {
    const fresh = evs.filter((e) => !this.seenEvents.has(e.eventId));
    if (fresh.length === 0) return;
    for (const e of fresh) this.seenEvents.add(e.eventId);
    const merged = [...this.state.events, ...fresh].sort((a, b) => a.receivedAtMonotonicMs - b.receivedAtMonotonicMs);
    const trimmed = merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
    if (trimmed.length < merged.length) {
      this.seenEvents.clear();
      for (const e of trimmed) this.seenEvents.add(e.eventId);
    }
    this.set({ events: trimmed });
  }

  pushAlert(a: EngineAlert, now = Date.now()): void {
    const existing = this.state.alerts.find((x) => x.code === a.code && x.message === a.message);
    if (existing) {
      this.set({ alerts: this.state.alerts.map((x) => (x === existing ? { ...x, at: now, count: x.count + 1, level: a.level } : x)) });
      return;
    }
    const item: AlertItem = { ...a, id: `al${++this.alertSeq}`, at: now, count: 1 };
    this.set({ alerts: [item, ...this.state.alerts].slice(0, 50) });
  }

  dismissAlert(id: string): void {
    this.set({ alerts: this.state.alerts.filter((a) => a.id !== id) });
  }

  /** Handles one message from the operator socket. */
  handle(msg: unknown, now = Date.now()): void {
    const env = msg as EventEnvelope<unknown> & { type?: string };
    if (!env || typeof env !== "object" || typeof env.topic !== "string") return;
    const sessionChanged = this.state.sessionId !== null && env.sessionId !== this.state.sessionId;
    if (sessionChanged) {
      this.seenEvents.clear();
      this.state = { ...this.state, events: [], decisions: [], arbiterLog: [] };
    }
    switch (env.topic) {
      case "state.snapshot": {
        const snap = env.payload as OperatorSnapshot;
        const prevSeq = this.state.snapshot?.state?.sequence ?? null;
        const seq = snap.state?.sequence ?? null;
        if (snap.state) this.clock.observe(now, snap.state.time.receivedAtMonotonicMs, `${snap.state.sessionId}:${snap.state.epoch}`);
        this.set({
          snapshot: snap,
          snapshotAt: now,
          sessionId: env.sessionId,
          epoch: env.epoch,
          sequenceChangedAt: seq !== prevSeq || sessionChanged ? now : this.state.sequenceChangedAt,
        });
        return;
      }
      case "director.decision":
        this.set({ decisions: [...this.state.decisions, env.payload as DirectorDecision].slice(-60) });
        return;
      case "observer.command":
        this.set({ arbiterLog: [...this.state.arbiterLog, env.payload as ArbiterEvent].slice(-120) });
        return;
      case "alerts":
        this.pushAlert(env.payload as EngineAlert, now);
        return;
      case "events":
        this.mergeEvents(env.payload as DerivedEvent[]);
        return;
      case "capabilities":
        if (this.state.snapshot) this.set({ snapshot: { ...this.state.snapshot, capabilities: env.payload as SourceCapabilities }, capabilitiesAt: now });
        return;
      default:
        return;
    }
  }
}

export const liveStore = new LiveStore();

let socket: OperatorSocket | null = null;

function wsUrl(): string | null {
  const token = getOperatorToken();
  if (!token) return null;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
}

export function startLive(): void {
  if (socket) return;
  socket = new OperatorSocket({
    url: wsUrl,
    onMessage: (m) => liveStore.handle(m),
    onStatus: (status, info) => liveStore.set({ status, info }),
    checkAuth: async () => {
      try {
        const me = await api.get<Me>("/api/v1/me");
        return me.role !== null;
      } catch {
        return true; // engine unreachable: keep retrying
      }
    },
  });
  socket.start();
}

export function stopLive(): void {
  socket?.stop();
  socket = null;
}

export function reconnectLive(): void {
  socket?.reconnectNow();
}

/** Subscribes to a slice of the live store. The selector result is cached per store state. */
export function useLive<T>(selector: (s: LiveState) => T): T {
  const cache = useRef<{ state: LiveState | null; value: T | undefined; selector: typeof selector | null }>({ state: null, value: undefined, selector: null });
  return useSyncExternalStore(liveStore.subscribe, () => {
    const c = cache.current;
    if (c.state !== liveStore.state || c.selector !== selector) {
      c.state = liveStore.state;
      c.selector = selector;
      c.value = selector(liveStore.state);
    }
    return c.value as T;
  });
}

const selectSnapshot = (s: LiveState) => s.snapshot;
export function useSnapshot(): OperatorSnapshot | null {
  return useLive(selectSnapshot);
}

/** Re-renders every `ms` and returns the current client time. */
export function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Estimated engine monotonic time, ticking. */
export function useEngineNow(ms = 250): number | null {
  const now = useNow(ms);
  return liveStore.clock.engineNow(now);
}
