import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/index.ts";
import type { DerivedEvent, UtilityTrackerEvent } from "../../api/types.ts";
import { Badge, EmptyState, EvidenceBadge } from "../../components/ui.tsx";
import { evidenceText } from "../../lib/evidence.ts";
import type { TimelineCategory } from "../../lib/evidence.ts";
import { describeEvent } from "../../lib/evidence.ts";
import { fmtMatchTime } from "../../lib/format.ts";
import { liveStore, useLive } from "../../state/live.ts";

const FILTERS: { id: TimelineCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "kill", label: "Kills & deaths" },
  { id: "round", label: "Round" },
  { id: "bomb", label: "Bomb" },
  { id: "observer", label: "Observer" },
  { id: "damage", label: "Damage" },
  { id: "system", label: "System" },
];

function roundOf(attemptId: string | null): string | null {
  const m = attemptId ? /r(\d+)/.exec(attemptId) : null;
  return m ? `R${m[1]}` : null;
}

export function Timeline({ nameOf, limit = 120 }: { nameOf: (id: string | null | undefined) => string; limit?: number }) {
  const events = useLive((s) => s.events);
  const [filter, setFilter] = useState<TimelineCategory | "all">("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [utility, setUtility] = useState<UtilityTrackerEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ events: DerivedEvent[]; utility: UtilityTrackerEvent[] }>("/api/v1/live/events?limit=300")
      .then((r) => {
        if (cancelled) return;
        liveStore.mergeEvents(r.events);
        setUtility(r.utility);
        setLoadError(null);
      })
      .catch((e) => !cancelled && setLoadError(String(e instanceof Error ? e.message : e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const all = events.map((e) => describeEvent(e, nameOf)).reverse();
    return (filter === "all" ? all : all.filter((r) => r.category === filter)).slice(0, limit);
  }, [events, filter, nameOf, limit]);

  return (
    <div className="timeline">
      <div className="chips-row" role="group" aria-label="Timeline filter">
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip-toggle ${filter === f.id ? "is-on" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {loadError ? <p className="text-warn small">History could not be loaded ({loadError}); showing live events only.</p> : null}
      {rows.length === 0 ? (
        <EmptyState title="No match events yet">Rounds, deaths, bomb and POV changes show up here.</EmptyState>
      ) : (
        <ol className="tl-list">
          {rows.map((r) => (
            <li key={r.id} className={`tl-item cat-${r.category}`}>
              <span className="tl-time" title="Canonical match time (ingest-based)">
                {roundOf(r.roundAttemptId) ? <span className="tl-round">{roundOf(r.roundAttemptId)}</span> : null}
                {fmtMatchTime(r.matchTimeMs)}
              </span>
              <span className="tl-main">
                <span className="tl-title">{r.title}</span>
                {r.notExactKill ? (
                  <Badge tone="warn" title="This source does not report exact kill events (killer/victim/weapon). This entry is derived or estimated.">
                    NOT EXACT
                  </Badge>
                ) : null}
                {r.detail ? <span className="tl-detail">{r.detail}</span> : null}
              </span>
              <span className="tl-ev" title={`${evidenceText(r.evidence).hint} Confidence ${Math.round(r.confidence * 100)}%.`}>
                {r.evidence === "estimated" ? <EvidenceBadge evidence={r.evidence} /> : <span className="muted small">{evidenceText(r.evidence).text.toLowerCase()}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {utility.length > 0 ? (
        <details className="tl-utility">
          <summary>Utility tracker history ({utility.length} events at page load)</summary>
          <ul className="small">
            {utility
              .slice(-40)
              .reverse()
              .map((u, i) => (
                <li key={i}>
                  <strong>{u.kind}</strong> {"type" in u ? u.type : ""} {"evidence" in u ? `(${u.evidence})` : ""} {"steamId" in u ? `→ ${nameOf(u.steamId)}` : ""}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
