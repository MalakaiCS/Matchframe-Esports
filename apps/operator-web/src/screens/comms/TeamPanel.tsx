import { useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { Badge, Button, EmptyState, KV, Meter, Note, Panel, type Tone } from "../../components/ui.tsx";
import { usePermission } from "../../state/session.tsx";
import type { CommsParticipant, CommsSlot } from "./types.ts";
import { t } from "../../i18n/index.ts";

/** A slot's state in words. */
export function slotState(s: CommsSlot): { tone: Tone; text: string } {
  switch (s.state) {
    case "ready":
      return { tone: "ok", text: t("comms.readyTheBufferHoldsThe") };
    case "buffering":
      return { tone: "info", text: s.readyInMs !== null ? t("comms.bufferingReadyInMaxS", { max: Math.max(1, Math.ceil(s.readyInMs / 1000)) }) : t("comms.buffering") };
    case "connecting":
      return { tone: "warn", text: t("comms.connectingTeamspeakTabFoundNot") };
    case "waiting":
      return { tone: "warn", text: t("comms.waitingForItsTeamspeakTab") };
    default:
      return { tone: "neutral", text: t("comms.teamCommsIsOff") };
  }
}

/** −60…0 dBFS as 0…1 for a meter. */
const meterOf = (db: number | null | undefined) => (db === null || db === undefined || db <= -60 ? 0 : Math.min(1, (db + 60) / 60));
export const fmtDelay = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

/** One team's TeamSpeak connection, buffer, delay and people, with what each output includes. */
export function TeamPanel({ slot, people, delayMs, onChanged }: { slot: CommsSlot; people: CommsParticipant[]; delayMs: number; onChanged: () => void }) {
  const st = slotState(slot);
  const tab = slot.tab;
  const name = slot.team?.name ?? t("comms.teamId", { id: slot.id });
  return (
    <Panel
      title={
        <span className="row">
          {name} <span className="muted small">{t("comms.slotId2", { id: slot.id })}</span>
        </span>
      }
      subtitle={slot.team ? t("comms.byTeamNeverBySide2") : t("comms.activateAMatchSlotA")}
      actions={<Badge tone={st.tone}>{st.text}</Badge>}
      className="comms-team"
    >
      <div className="stack-sm">
        <KV
          items={[
            ["TeamSpeak", tab ? `${tab.server?.name ?? tab.server?.host ?? t("comms.server")} · ${tab.channel?.name ?? t("comms.noChannel")} · ${tab.status}` : slot.config.channel ? t("comms.notConnectedChannel", { channel: slot.config.channel }) : t("comms.noChannelSet")],
            [t("comms.kvListener"), tab?.listener ? `${tab.listener.nickname}: ${tab.listener.inputMuted && tab.listener.inputDeactivated ? t("comms.micOff") : t("comms.micOn")}, ${tab.listener.outputMuted ? t("comms.deafened") : t("comms.notDeafened")}${tab.listener.recording ? t("comms.recordingShown") : ""}` : "—"],
            [t("comms.kvCapture"), tab ? (tab.capturing ? t("comms.capturedInChannel", { n: people.filter((p) => p.present).length }) : t("comms.notCaptured")) : "—"],
            [t("comms.delay"), t("comms.sharedDelay", { delay: fmtDelay(delayMs) })],
          ]}
        />
        {slot.issue ? <Note tone="warn">{slot.issue}</Note> : null}
        {slot.lost ? <Note tone="danger" title={t("comms.sourceLost")}>{slot.lost.reason}</Note> : null}
        {people.length === 0 ? (
          <EmptyState title={t("comms.nobodyHeardYet")}>{t("comms.peopleInTheTeamS")}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-compact comms-people">
              <thead>
                <tr>
                  <th>TeamSpeak</th>
                  <th>{t("comms.rosterPlayer")}</th>
                  <th title={t("comms.heardOnThePublicBroadcast")}>{t("comms.broadcast")}</th>
                  <th title={t("comms.heardInTheDedicatedRecording")}>{t("comms.recording")}</th>
                  <th>{t("comms.level")}</th>
                  <th>{t("comms.liveNotOnAir")}</th>
                  <th>{t("comms.delayedOutputTime")}</th>
                  <th>{t("comms.preview")}</th>
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
      toast.push("danger", t("comms.notSaved"), describeError(e));
    }
  };
  const who = p.displayName || p.nickname;
  const sig = p.delayed.signal ?? null;
  return (
    <tr className={p.present ? "" : "is-away"}>
      <td>
        <div className="comms-person">
          <strong>{p.nickname || t("comms.noName")}</strong>
          <span className="muted small" title={t("comms.teamspeakIdentityStableAcrossReconnects")}>
            {p.uid.length > 10 ? `${p.uid.slice(0, 8)}…` : p.uid} · {p.present ? t("comms.inTheChannel") : t("comms.away")}
          </span>
          {!p.includeBroadcast && !p.includeRecording && !p.playerId ? <Badge tone="warn">{t("comms.excludedUntilIncluded")}</Badge> : null}
        </div>
      </td>
      <td>
        <select aria-label={t("comms.rosterPlayerForWho", { who })} value={p.playerId ?? ""} disabled={!!reason} onChange={(e) => void save({ playerId: e.target.value || null })}>
          <option value="">{t("comms.notMapped")}</option>
          {slot.roster.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input type="checkbox" aria-label={t("comms.includeWhoInBroadcast", { who })} checked={p.includeBroadcast} disabled={!!reason} onChange={(e) => void save({ includeBroadcast: e.target.checked })} />
      </td>
      <td>
        <input type="checkbox" aria-label={t("comms.includeWhoInRecording", { who })} checked={p.includeRecording} disabled={!!reason} onChange={(e) => void save({ includeRecording: e.target.checked })} />
      </td>
      <td>
        <div className="comms-level">
          <input
            type="range"
            min={-30}
            max={12}
            step={1}
            aria-label={t("comms.levelForWhoDb", { who })}
            value={level ?? p.levelDb}
            disabled={!!reason}
            onChange={(e) => setLevel(Number(e.target.value))}
            onPointerUp={() => level !== null && void save({ levelDb: level }).then(() => setLevel(null))}
            onKeyUp={() => level !== null && void save({ levelDb: level }).then(() => setLevel(null))}
          />
          <span className="mono small">{t("comms.vV2Db", { v: (level ?? p.levelDb) > 0 ? "+" : "", v2: level ?? p.levelDb })}</span>
        </div>
      </td>
      <td title={t("comms.asItArrivesFromTeamspeak")}>
        <Meter value={meterOf(p.incoming.db)} tone="neutral" label={t("comms.whoIncomingLevelLiveNot", { who })} />
        <span className="small muted">{p.incoming.talking ? t("comms.talking") : ""}</span>
      </td>
      <td title={t("comms.atTheOutputsTimeAfter")}>
        <Meter value={meterOf(sig?.db)} tone={sig?.speaking ? "ok" : "neutral"} label={t("comms.whoDelayedLevelAtThe", { who })} />
        <span className="small muted">{sig?.speaking ? t("comms.speaking2") : ""}</span>
      </td>
      <td>
        <Button size="sm" variant={p.preview ? "primary" : "secondary"} aria-pressed={p.preview} disabledReason={reason} onClick={() => void save({ preview: !p.preview })} title={t("comms.yourHeadphonesOnlyNeverThe")}>
          {p.preview ? t("comms.soloed") : t("comms.solo")}
        </Button>
      </td>
    </tr>
  );
}
