import { useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { Badge, Button, EmptyState, KV, Meter, Note, Panel, type Tone } from "../../components/ui.tsx";
import { usePermission } from "../../state/session.tsx";
import type { CommsParticipant, CommsSlot } from "./types.ts";

/** A slot's state in words. */
export function slotState(s: CommsSlot): { tone: Tone; text: string } {
  switch (s.state) {
    case "ready":
      return { tone: "ok", text: "Ready: the buffer holds the delay" };
    case "buffering":
      return { tone: "info", text: s.readyInMs !== null ? `Buffering: ready in ${Math.max(1, Math.ceil(s.readyInMs / 1000))} s` : "Buffering" };
    case "connecting":
      return { tone: "warn", text: "Connecting: TeamSpeak tab found, not captured yet" };
    case "waiting":
      return { tone: "warn", text: "Waiting for its TeamSpeak tab" };
    default:
      return { tone: "neutral", text: "Team Comms is off" };
  }
}

/** −60…0 dBFS as 0…1 for a meter. */
const meterOf = (db: number | null | undefined) => (db === null || db === undefined || db <= -60 ? 0 : Math.min(1, (db + 60) / 60));
export const fmtDelay = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

/** One team's TeamSpeak connection, buffer, delay and people, with what each output includes. */
export function TeamPanel({ slot, people, delayMs, onChanged }: { slot: CommsSlot; people: CommsParticipant[]; delayMs: number; onChanged: () => void }) {
  const st = slotState(slot);
  const tab = slot.tab;
  const name = slot.team?.name ?? `Team ${slot.id}`;
  return (
    <Panel
      title={
        <span className="row">
          {name} <span className="muted small">slot {slot.id}</span>
        </span>
      }
      subtitle={slot.team ? "By team, never by side: halftime changes nothing here." : "Activate a match: slot A is its team A, slot B its team B."}
      actions={<Badge tone={st.tone}>{st.text}</Badge>}
      className="comms-team"
    >
      <div className="stack-sm">
        <KV
          items={[
            ["TeamSpeak", tab ? `${tab.server?.name ?? tab.server?.host ?? "server"} · ${tab.channel?.name ?? "no channel"} · ${tab.status}` : slot.config.channel ? `Not connected (channel “${slot.config.channel}”)` : "No channel set"],
            ["Listener", tab?.listener ? `${tab.listener.nickname}: ${tab.listener.inputMuted && tab.listener.inputDeactivated ? "microphone off" : "microphone ON"}, ${tab.listener.outputMuted ? "DEAFENED (no capture)" : "not deafened"}${tab.listener.recording ? ", recording shown" : ""}` : "—"],
            ["Capture", tab ? (tab.capturing ? `Captured · ${people.filter((p) => p.present).length} in the channel` : "Not captured") : "—"],
            ["Delay", `${fmtDelay(delayMs)} (shared by both teams)`],
          ]}
        />
        {slot.issue ? <Note tone="warn">{slot.issue}</Note> : null}
        {slot.lost ? <Note tone="danger" title="Source lost">{slot.lost.reason}</Note> : null}
        {people.length === 0 ? (
          <EmptyState title="Nobody heard yet">People in the team's channel appear here as TeamSpeak reports them, each excluded until you include them.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-compact comms-people">
              <thead>
                <tr>
                  <th>TeamSpeak</th>
                  <th>Roster player</th>
                  <th title="Heard on the public broadcast during this team's listen-in">Broadcast</th>
                  <th title="Heard in the dedicated recording">Recording</th>
                  <th>Level</th>
                  <th>Live (not on air)</th>
                  <th>Delayed (output time)</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <PersonRow key={p.key} p={p} slot={slot} onChanged={onChanged} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

function PersonRow({ p, slot, onChanged }: { p: CommsParticipant; slot: CommsSlot; onChanged: () => void }) {
  const reason = usePermission("program.control");
  const toast = useToast();
  const [level, setLevel] = useState<number | null>(null);
  const save = async (patch: Partial<Pick<CommsParticipant, "includeBroadcast" | "includeRecording" | "levelDb" | "preview" | "playerId">>) => {
    try {
      await api.put(`/api/v1/comms/participants/${seg(p.key)}`, patch);
      onChanged();
    } catch (e) {
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  const who = p.displayName || p.nickname;
  const sig = p.delayed.signal ?? null;
  return (
    <tr className={p.present ? "" : "is-away"}>
      <td>
        <div className="comms-person">
          <strong>{p.nickname || "(no name)"}</strong>
          <span className="muted small" title="TeamSpeak identity (stable across reconnects)">
            {p.uid.length > 10 ? `${p.uid.slice(0, 8)}…` : p.uid} · {p.present ? "in the channel" : "away"}
          </span>
          {!p.includeBroadcast && !p.includeRecording && !p.playerId ? <Badge tone="warn">Excluded until included</Badge> : null}
        </div>
      </td>
      <td>
        <select aria-label={`Roster player for ${who}`} value={p.playerId ?? ""} disabled={!!reason} onChange={(e) => void save({ playerId: e.target.value || null })}>
          <option value="">Not mapped</option>
          {slot.roster.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input type="checkbox" aria-label={`Include ${who} in Broadcast`} checked={p.includeBroadcast} disabled={!!reason} onChange={(e) => void save({ includeBroadcast: e.target.checked })} />
      </td>
      <td>
        <input type="checkbox" aria-label={`Include ${who} in Recording`} checked={p.includeRecording} disabled={!!reason} onChange={(e) => void save({ includeRecording: e.target.checked })} />
      </td>
      <td>
        <div className="comms-level">
          <input
            type="range"
            min={-30}
            max={12}
            step={1}
            aria-label={`Level for ${who} (dB)`}
            value={level ?? p.levelDb}
            disabled={!!reason}
            onChange={(e) => setLevel(Number(e.target.value))}
            onPointerUp={() => level !== null && void save({ levelDb: level }).then(() => setLevel(null))}
            onKeyUp={() => level !== null && void save({ levelDb: level }).then(() => setLevel(null))}
          />
          <span className="mono small">{(level ?? p.levelDb) > 0 ? "+" : ""}{level ?? p.levelDb} dB</span>
        </div>
      </td>
      <td title="As it arrives from TeamSpeak, before the delay. Never on air.">
        <Meter value={meterOf(p.incoming.db)} tone="neutral" label={`${who}: incoming level, live, not on air`} />
        <span className="small muted">{p.incoming.talking ? "talking" : ""}</span>
      </td>
      <td title="At the outputs' time (after the delay), before inclusion: what including them would put out.">
        <Meter value={meterOf(sig?.db)} tone={sig?.speaking ? "ok" : "neutral"} label={`${who}: delayed level at the outputs' time`} />
        <span className="small muted">{sig?.speaking ? "speaking" : ""}</span>
      </td>
      <td>
        <Button size="sm" variant={p.preview ? "primary" : "secondary"} aria-pressed={p.preview} disabledReason={reason} onClick={() => void save({ preview: !p.preview })} title="Your headphones only: never the broadcast or the recording">
          {p.preview ? "Soloed" : "Solo"}
        </Button>
      </td>
    </tr>
  );
}
