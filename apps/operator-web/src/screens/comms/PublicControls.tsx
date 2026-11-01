import { api } from "../../api/index.ts";
import { ActionButton } from "../../components/ui.tsx";
import { usePermission } from "../../state/session.tsx";
import type { ListenInView, PublicState } from "./types.ts";

/** The state's shape and word, so it never depends on colour alone. */
const STATE_MARK: Record<PublicState, { icon: string; tag: string }> = {
  off: { icon: "○", tag: "Not on air" },
  buffering: { icon: "◔", tag: "Silent: buffering" },
  listening: { icon: "●", tag: "On air" },
  fault: { icon: "⚠", tag: "Fault: silent" },
};

/** OFF, BUFFERING — TEAM, LISTENING IN — TEAM or FAULT, in words, prominently. */
export function PublicStateBanner({ view, compact = false }: { view: ListenInView | null; compact?: boolean }) {
  const state = view?.state ?? "off";
  const mark = STATE_MARK[state];
  return (
    <div className={`comms-state comms-state-${state} ${compact ? "is-compact" : ""}`} role="status" aria-live="polite" aria-label={`Public comms: ${view?.label ?? "loading"}`}>
      <span className="comms-state-icon" aria-hidden>
        {mark.icon}
      </span>
      <div className="comms-state-text">
        <div className="comms-state-kicker">
          Public comms · <span className="comms-state-tag">{mark.tag}</span>
        </div>
        <div className="comms-state-label">{view?.label ?? "…"}</div>
        {!compact || state === "fault" ? <div className="comms-state-detail">{view?.detail ?? ""}</div> : null}
      </div>
    </div>
  );
}

/** Listen In — [each team], End Listen-In, Mute All Comms: all through the engine's one controller. */
export function ListenInButtons({ view, onDone, size = "md" }: { view: ListenInView | null; onDone: (v: ListenInView) => void; size?: "sm" | "md" | "lg" }) {
  const reason = usePermission("program.control");
  const loading = view ? null : "Loading…";
  return (
    <div className="comms-actions">
      {(view?.actions ?? []).map((a) => (
        <ActionButton key={a.teamId} size={size} variant="primary" action={() => api.post<ListenInView>("/api/v1/comms/listen-in", { teamId: a.teamId })} onDone={onDone} disabledReason={reason ?? a.disabledReason}>
          {a.label}
        </ActionButton>
      ))}
      <ActionButton size={size} action={() => api.post<ListenInView>("/api/v1/comms/listen-in/end")} onDone={onDone} disabledReason={reason ?? loading ?? view!.end.disabledReason}>
        End Listen-In
      </ActionButton>
      <ActionButton size={size} variant="danger" action={() => api.post<ListenInView>("/api/v1/comms/mute-all")} onDone={onDone} success="Public comms muted (the recording carries on)" disabledReason={reason ?? loading ?? view!.muteAll.disabledReason}>
        Mute All Comms
      </ActionButton>
    </div>
  );
}
