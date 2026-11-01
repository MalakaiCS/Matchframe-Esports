import { useCallback, useMemo, useRef, useState } from "react";
import type { EventStage, Match, MatchFormat, VetoEntry } from "@matchframe/contracts";
import { planMaps, sideChooser, validateSeriesScore, validateVetoEntries, vetoComplete, winsNeeded } from "@matchframe/contracts/veto-entries";
import { api, seg } from "../../api/index.ts";
import type { EventRecord, MatchDetail, PlayerRow, TeamRow } from "../../api/types.ts";
import { MapPoolEditor } from "../../components/AssetUpload.tsx";
import { EditorShell, useEditor } from "../../components/EditorShell.tsx";
import { Combobox, fieldErrorsOf, FormField, TeamLogo, TeamSelect } from "../../components/forms.tsx";
import { ActionButton, Badge, Button, Checkbox, Details, ErrorBox, Loading, Modal, Note } from "../../components/ui.tsx";
import { sameValue, useDraft } from "../../lib/draft.ts";
import { useApi } from "../../lib/hooks.ts";
import { makeMatchArt } from "../../lib/match-art/make.ts";
import { useLocation } from "../../router.tsx";
import { usePermission } from "../../state/session.tsx";
import { editId } from "../teams/TeamEditor.tsx";
import { MatchArtPanel } from "./MatchArt.tsx";
import { Corrections, MapResults } from "./Results.tsx";
import { VetoBoard } from "./Veto.tsx";
import "../../styles/records.css";

type MatchDraft = {
  teamAId: string | null;
  teamBId: string | null;
  format: MatchFormat;
  scheduledAt: string | null;
  eventId: string | null;
  stageId: string | null;
  title: string | null;
  mapPool: string[];
  veto: VetoEntry[];
  seriesScoreA: number;
  seriesScoreB: number;
  status: Match["status"];
};
const DEFAULT_FORMAT: MatchFormat = { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false };
const EMPTY: MatchDraft = { teamAId: null, teamBId: null, format: DEFAULT_FORMAT, scheduledAt: null, eventId: null, stageId: null, title: null, mapPool: [], veto: [], seriesScoreA: 0, seriesScoreB: 0, status: "scheduled" };
const LABEL: Record<string, string> = { teamAId: "Team 1", teamBId: "Team 2", format: "Format", scheduledAt: "Date and time", eventId: "Tournament", stageId: "Stage", title: "Title", mapPool: "Map pool", veto: "Map veto", seriesScoreA: "Series score", seriesScoreB: "Series score", status: "Status" };
const TYPE_LABEL: Record<VetoEntry["type"], string> = { pick: "Pick", ban: "Ban", decider: "Decider" };

export const mapLabel = (m: string, names: Map<string, string>) => names.get(m) ?? m.replace(/^de_/, "").replace(/^\w/, (c) => c.toUpperCase());

/** ISO time → the value of a datetime-local input (local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

let entrySeq = 0;
const newEntryId = () => `ve_${Date.now().toString(36)}${(entrySeq++).toString(36)}`;

export function MatchEditorScreen() {
  const { path } = useLocation();
  const id = editId(path, "matches");
  return id ? <MatchEditorLoader id={id} key={id} /> : <MatchEditor match={null} key="new" />;
}

function MatchEditorLoader({ id }: { id: string }) {
  // Polled, so live results and captain veto decisions reach the open form (merged into fields not edited here).
  const m = useApi<MatchDetail>(`/api/v1/matches/${seg(id)}`, { refreshMs: 5000 });
  if (m.data === undefined) return <div className="page">{m.error ? <ErrorBox error={m.error} onRetry={() => void m.reload()} /> : <Loading label="Loading match…" />}</div>;
  return <MatchEditor match={m.data} reload={() => void m.reload()} />;
}

/** Edit one veto entry: Pick / Ban / Decider, team, map, the opponent's starting side and Reversed sides. */
function VetoEntryDialog({ entries, index, teamA, teamB, pool, names, onSave, onRemove, onClose }: { entries: VetoEntry[]; index: number | null; teamA: TeamRow; teamB: TeamRow; pool: string[]; names: Map<string, string>; onSave: (e: VetoEntry) => void; onRemove?: () => void; onClose: () => void }) {
  const initial: VetoEntry = useMemo(() => {
    if (index !== null) return entries[index]!;
    const last = entries[entries.length - 1];
    const team = last?.teamId === teamA.id ? teamB.id : teamA.id;
    return { id: newEntryId(), type: "ban", teamId: team, mapName: "", sideChoice: null, reversedSides: false };
  }, [entries, index, teamA.id, teamB.id]);
  const [e, setE] = useState<VetoEntry>(initial);
  const others = entries.filter((_, i) => i !== index);
  const used = new Map(others.map((x) => [x.mapName, entries.indexOf(x) + 1]));
  const list = index === null ? [...entries, e] : entries.map((x, i) => (i === index ? e : x));
  const at = index ?? entries.length;
  const chooser = e.type === "ban" ? null : sideChooser(list, at, teamA.id, teamB.id);
  const chooserName = chooser === teamA.id ? teamA.name : chooser === teamB.id ? teamB.name : null;
  const issues = validateVetoEntries(list, { teamAId: teamA.id, teamBId: teamB.id, bestOf: 99, pool }).filter((x) => x.index === at);
  const options = pool.map((m) => ({ key: m, label: mapLabel(m, names), keywords: m, hint: used.has(m) ? `used in entry ${used.get(m)}` : undefined }));
  const set = (p: Partial<VetoEntry>) => setE((x) => ({ ...x, ...p }));
  return (
    <Modal
      title={index === null ? "Add veto entry" : `Edit veto entry ${index + 1}`}
      onClose={onClose}
      footer={
        <>
          {onRemove ? (
            <Button variant="danger" onClick={onRemove} className="mr-auto">
              Remove entry
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabledReason={!e.mapName ? "Choose a map" : issues[0]?.message ?? null} onClick={() => onSave(e)}>
            {index === null ? "Add entry" : "Save entry"}
          </Button>
        </>
      }
    >
      <div className="ff">
        <span className="ff-label" id="ve-type-l">
          Action
        </span>
        <div className="seg" role="radiogroup" aria-labelledby="ve-type-l">
          {(["pick", "ban", "decider"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={e.type === t}
              className={`seg-btn ${e.type === t ? "is-on" : ""}`}
              onClick={() => set({ type: t, teamId: t === "decider" ? null : (e.teamId ?? teamA.id), sideChoice: t === "ban" ? null : e.sideChoice, reversedSides: t === "ban" ? false : e.reversedSides })}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="ff">
        <span className="ff-label" id="ve-team-l">
          {e.type === "ban" ? "Banned by" : e.type === "pick" ? "Picked by" : "Team"}
        </span>
        {e.type === "decider" ? (
          <span className="small muted">The decider is the map left over; no team picks it.</span>
        ) : (
          <div className="seg" role="radiogroup" aria-labelledby="ve-team-l">
            {[teamA, teamB].map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={e.teamId === t.id} className={`seg-btn seg-team ${e.teamId === t.id ? "is-on" : ""}`} onClick={() => set({ teamId: t.id })}>
                <TeamLogo assetId={t.logoAssetId} size={18} name={t.name} /> {t.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <FormField label="Map" htmlFor="ve-map" error={issues.find((x) => x.field === "mapName")?.message}>
        <Combobox id="ve-map" options={options} value={e.mapName || null} onChange={(m) => set({ mapName: m ?? "" })} placeholder="Search the map pool" />
      </FormField>
      {e.type !== "ban" ? (
        <>
          <div className="ff">
            <span className="ff-label" id="ve-side-l">
              {chooserName ? `Starting side chosen by ${chooserName}` : "Opponent's starting side"}
            </span>
            <div className="seg" role="radiogroup" aria-labelledby="ve-side-l">
              {(
                [
                  ["CT", "CT"],
                  ["T", "T"],
                  [null, "Not chosen"],
                ] as const
              ).map(([v, label]) => (
                <button key={label} type="button" role="radio" aria-checked={e.sideChoice === v} className={`seg-btn ${e.sideChoice === v ? "is-on" : ""}`} onClick={() => set({ sideChoice: v })}>
                  {label}
                </button>
              ))}
            </div>
            <span className="ff-hint">{e.type === "decider" ? "On the decider the team that did not make the last ban chooses." : "The team that did not pick the map chooses its starting side."}</span>
          </div>
          <Checkbox checked={e.reversedSides} onChange={(reversedSides) => set({ reversedSides })} label="Reversed sides (swap the starting sides shown for this map)" />
        </>
      ) : null}
      {issues.filter((x) => x.field !== "mapName").map((x) => (
        <p key={x.message} className="ff-error">
          {x.message}
        </p>
      ))}
    </Modal>
  );
}

function SideText({ entries, index, a, b }: { entries: VetoEntry[]; index: number; a: TeamRow; b: TeamRow }) {
  const e = entries[index]!;
  if (e.type === "ban") return <span className="muted">—</span>;
  const chooser = sideChooser(entries, index, a.id, b.id);
  const name = chooser === a.id ? a.shortName || a.name : chooser === b.id ? b.shortName || b.name : null;
  const ct = planMaps(entries, a.id, b.id).find((p) => p.entryId === e.id)?.startingCtTeamId;
  const ctName = ct === a.id ? a.shortName || a.name : ct === b.id ? b.shortName || b.name : null;
  return (
    <span>
      {e.sideChoice ? (
        <>
          {name ?? "Opponent"} chose <strong className={e.sideChoice === "CT" ? "text-ct" : "text-t"}>{e.sideChoice}</strong>
          {ctName ? <span className="muted small"> · {ctName} starts CT</span> : null}
        </>
      ) : (
        <span className="muted">Side not chosen</span>
      )}
      {e.reversedSides ? <Badge className="ml-6">Reversed sides</Badge> : null}
    </span>
  );
}

function MatchEditor({ match, reload }: { match: MatchDetail | null; reload?: () => void }) {
  const reason = usePermission("metadata.write");
  const programReason = usePermission("program.control");
  const teams = useApi<TeamRow[]>("/api/v1/teams?archived=1");
  const events = useApi<EventRecord[]>("/api/v1/events");
  const appPool = useApi<{ maps: { mapName: string; displayName: string }[]; known: string[] }>("/api/v1/map-pool");
  const players = useApi<PlayerRow[]>(match ? "/api/v1/players" : null);
  const server = useMemo<MatchDraft | undefined>(
    () =>
      match
        ? { teamAId: match.teamAId, teamBId: match.teamBId, format: match.format, scheduledAt: match.scheduledAt, eventId: match.eventId, stageId: match.stageId, title: match.title, mapPool: match.mapPool, veto: match.vetoEntries, seriesScoreA: match.seriesScoreA, seriesScoreB: match.seriesScoreB, status: match.status }
        : undefined,
    [match],
  );
  const d = useDraft<MatchDraft>(server, EMPTY);
  const stages = useApi<EventStage[]>(d.draft.eventId ? `/api/v1/stages?eventId=${seg(d.draft.eventId)}` : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<string[]>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const createdId = useRef<string | null>(null);
  const teamList = teams.data ?? [];
  const teamA = teamList.find((t) => t.id === d.draft.teamAId) ?? null;
  const teamB = teamList.find((t) => t.id === d.draft.teamBId) ?? null;
  const names = useMemo(() => new Map((appPool.data?.maps ?? []).map((m) => [m.mapName, m.displayName])), [appPool.data]);
  const event = (events.data ?? []).find((e) => e.id === d.draft.eventId);
  const pool = d.draft.mapPool.length ? d.draft.mapPool : event?.mapPool.length ? event.mapPool : (appPool.data?.maps.map((m) => m.mapName) ?? []);
  const poolSource = d.draft.mapPool.length ? "this match's pool" : event?.mapPool.length ? `${event.name}'s pool` : "the CS2 map pool";
  const bestOf = d.draft.format.bestOf;
  const issues = teamA && teamB ? validateVetoEntries(d.draft.veto, { teamAId: teamA.id, teamBId: teamB.id, bestOf, pool }) : [];
  const playedCount = d.draft.veto.filter((e) => e.type !== "ban").length;
  const complete = vetoComplete(d.draft.veto, bestOf);
  const scoreProblem = validateSeriesScore(d.draft.seriesScoreA, d.draft.seriesScoreB, bestOf);
  const fromMaps = match?.seriesFromMaps ?? { a: 0, b: 0 };
  const same = !!d.draft.teamAId && d.draft.teamAId === d.draft.teamBId;

  const save = useCallback(async () => {
    setErrors({});
    setConflict([]);
    const local: Record<string, string> = {};
    if (!d.draft.teamAId) local.teamAId = "Choose Team 1";
    if (!d.draft.teamBId) local.teamBId = "Choose Team 2";
    if (d.draft.teamAId && d.draft.teamAId === d.draft.teamBId) local.teamBId = "Team 1 and Team 2 must be different teams";
    if (scoreProblem) local.seriesScoreA = scoreProblem;
    if (issues.length) local.veto = issues[0]!.message;
    if (Object.keys(local).length) {
      setErrors(local);
      throw new Error(Object.values(local)[0]);
    }
    try {
      if (!match) {
        const m = await api.post<MatchDetail>("/api/v1/matches", d.draft);
        createdId.current = m.id;
        // Thumbnails and stingers for the new match, made in the background.
        void makeMatchArt(m.id);
      } else {
        await api.patch<MatchDetail>(`/api/v1/matches/${seg(match.id)}`, { changes: d.changes(), expected: d.expected() });
      }
    } catch (e) {
      const f = fieldErrorsOf(e);
      setErrors(f);
      if ((e as { code?: string }).code === "field_conflict") setConflict(Object.keys(f).filter((k) => !k.includes(".")));
      throw e;
    }
  }, [match, d, scoreProblem, issues]);
  const editor = useEditor({ dirty: d.dirty, backTo: "/matches", save, savedMessage: () => (match ? "Match saved" : "Match created") });
  const setEntries = (veto: VetoEntry[]) => d.set({ veto });
  const move = (i: number, by: number) => {
    const v = [...d.draft.veto];
    const [x] = v.splice(i, 1);
    v.splice(i + by, 0, x!);
    setEntries(v);
  };
  const vetoErr = errors.veto;
  const sourceNote =
    match && sameValue(d.draft.veto, d.original.veto) && match.vetoSource === "captain"
      ? `These entries come from the captain veto (${match.captainDecisions} decisions). Changes you save are kept as a manual correction (audited) and take precedence.`
      : match && match.vetoSource === "maps" && sameValue(d.draft.veto, d.original.veto)
        ? "These entries were made from the match's maps."
        : null;

  return (
    <EditorShell
      title={match ? `Edit match: ${teamA?.name ?? "Team 1"} vs ${teamB?.name ?? "Team 2"}` : "Create Match"}
      subtitle={
        match ? (
          <span className="row">
            {match.active ? (
              <Badge tone="ok" icon="●" title="HUDs and live state use this match">
                Active for HUD
              </Badge>
            ) : (
              <ActionButton size="sm" action={() => api.post(`/api/v1/matches/${seg(match.id)}/activate`)} success="Match is now active for the HUDs" onDone={() => reload?.()} disabledReason={programReason} confirm={{ title: "Make this match active?", body: "HUDs and live state switch to this match now. Any other active match stops being active. The match's status and tab do not change.", confirmLabel: "Make Active" }}>
                Make Active
              </ActionButton>
            )}
          </span>
        ) : null
      }
      backTo="/matches"
      backLabel="Matches"
      crumbs={[match ? `${teamA?.shortName ?? "?"} vs ${teamB?.shortName ?? "?"}` : "Create Match"]}
      editor={editor}
      saveDisabledReason={reason}
      footerNote={teamA && teamB && !complete ? <span className="small muted">The veto is not complete yet; you can save now and finish it later.</span> : null}
    >
      {conflict.length ? (
        <Note tone="warn" title="Changed elsewhere">
          {[...new Set(conflict.map((c) => LABEL[c] ?? c))].join(", ")} changed while you were editing (a live result, the captain veto or another computer).{" "}
          <Button
            size="sm"
            onClick={() => {
              d.reload(conflict as (keyof MatchDraft)[]);
              setConflict([]);
              setErrors({});
              reload?.();
            }}
          >
            Use the current values
          </Button>
        </Note>
      ) : null}
      <div className="match-layout">
        <section className="match-side" aria-label="Teams, score and format">
          <FormField label="Team 1" htmlFor="m-team-a" required error={errors.teamAId}>
            <TeamSelect id="m-team-a" teams={teamList} value={d.draft.teamAId} exclude={d.draft.teamBId} onChange={(teamAId) => d.set({ teamAId })} invalid={!!errors.teamAId} />
          </FormField>
          <FormField label="Team 2" htmlFor="m-team-b" required error={errors.teamBId ?? (same ? "Team 1 and Team 2 must be different teams" : null)}>
            <TeamSelect id="m-team-b" teams={teamList} value={d.draft.teamBId} exclude={d.draft.teamAId} onChange={(teamBId) => d.set({ teamBId })} invalid={!!errors.teamBId || same} />
          </FormField>
          <div className="versus" aria-label="Series score">
            {[
              ["seriesScoreA", teamA, "Team 1"],
              ["seriesScoreB", teamB, "Team 2"],
            ].map(([key, t, fallback], i) => {
              const k = key as "seriesScoreA" | "seriesScoreB";
              const team = t as TeamRow | null;
              const v = d.draft[k];
              return (
                <div key={k} className={`versus-team ${i === 1 ? "is-right" : ""}`}>
                  <TeamLogo assetId={team?.logoAssetId} size={64} name={team?.name ?? (fallback as string)} />
                  <span className="versus-name">{team?.name ?? <span className="muted">{fallback as string}</span>}</span>
                  <div className="score-step">
                    <button type="button" aria-label={`${team?.name ?? fallback} series wins minus one`} disabled={v <= 0} onClick={() => d.set({ [k]: v - 1 } as Partial<MatchDraft>)}>
                      −
                    </button>
                    <input aria-label={`${team?.name ?? fallback} series wins`} className="score-input" type="number" min={0} max={winsNeeded(bestOf)} value={v} onChange={(e) => d.set({ [k]: Math.max(0, Number(e.target.value) || 0) } as Partial<MatchDraft>)} />
                    <button type="button" aria-label={`${team?.name ?? fallback} series wins plus one`} disabled={v >= winsNeeded(bestOf)} onClick={() => d.set({ [k]: v + 1 } as Partial<MatchDraft>)}>
                      +
                    </button>
                  </div>
                </div>
              );
            })}
            <span className="versus-vs" aria-hidden>
              VS
            </span>
          </div>
          <p className={`small ${scoreProblem || errors.seriesScoreA ? "ff-error" : "muted"}`} role={scoreProblem ? "alert" : undefined}>
            {scoreProblem ??
              errors.seriesScoreA ??
              `Series wins are maps won (first to ${winsNeeded(bestOf)}), not round scores.${match ? ` From completed maps: ${fromMaps.a}–${fromMaps.b}${d.draft.seriesScoreA !== fromMaps.a || d.draft.seriesScoreB !== fromMaps.b ? "; the difference is kept as a manual correction" : ""}.` : ""}`}
          </p>
          <div className="ff">
            <span className="ff-label" id="m-bo-l">
              Format
            </span>
            <div className="seg" role="radiogroup" aria-labelledby="m-bo-l">
              {[1, 2, 3, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={bestOf === n} className={`seg-btn ${bestOf === n ? "is-on" : ""}`} onClick={() => d.set({ format: { ...d.draft.format, bestOf: n } })}>
                  BO{n}
                </button>
              ))}
            </div>
          </div>
          <FormField label="Date and time" htmlFor="m-when" error={errors.scheduledAt} hint="Scheduling never makes a match active; use Make Active.">
            <input id="m-when" type="datetime-local" value={toLocalInput(d.draft.scheduledAt)} onChange={(e) => d.set({ scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : null })} />
          </FormField>
          <FormField label="Tournament" htmlFor="m-event" error={errors.eventId}>
            <select id="m-event" value={d.draft.eventId ?? ""} onChange={(e) => d.set({ eventId: e.target.value || null, stageId: null })}>
              <option value="">None</option>
              {(events.data ?? []).map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </FormField>
          {d.draft.eventId ? (
            <FormField label="Stage" htmlFor="m-stage" error={errors.stageId}>
              <select id="m-stage" value={d.draft.stageId ?? ""} onChange={(e) => d.set({ stageId: e.target.value || null })}>
                <option value="">None</option>
                {(stages.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
          <FormField label="Title" htmlFor="m-title">
            <input id="m-title" value={d.draft.title ?? ""} maxLength={120} placeholder="e.g. Grand final" onChange={(e) => d.set({ title: e.target.value || null })} />
          </FormField>
        </section>
        <section className="match-veto" aria-label="Map veto">
          <div className="veto-head">
            <h2 className="section-title">Map veto</h2>
            {teamA && teamB ? (
              <>
                <span className={`small ${complete ? "text-ok" : "muted"}`}>
                  {playedCount} of {bestOf} map{bestOf === 1 ? "" : "s"} chosen{complete ? " · complete" : ""}
                </span>
                <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing("new")} disabledReason={complete && playedCount >= bestOf && d.draft.veto.some((e) => e.type === "decider") ? "The veto is complete (the decider ends it)" : null}>
                  Add entry
                </Button>
              </>
            ) : null}
          </div>
          {!teamA || !teamB ? (
            <div className="veto-empty">
              <strong>Choose Team 1 and Team 2 first.</strong>
              <p className="muted">Then add the veto in order: each ban and pick with the team that made it, the opponent's starting side, and the decider. You can save before the veto is complete.</p>
            </div>
          ) : (
            <>
              {sourceNote ? <p className="small muted">{sourceNote}</p> : null}
              {vetoErr ? <p className="ff-error">{vetoErr}</p> : null}
              {issues.filter((x) => x.index === null).map((x) => (
                <p key={x.message} className="ff-error">
                  {x.message}
                </p>
              ))}
              {d.draft.veto.length === 0 ? (
                <div className="veto-empty">
                  <strong>No veto entries yet.</strong>
                  <p className="muted">
                    Add each ban, pick and the decider in order. Maps come from {poolSource} ({pool.length} maps).
                  </p>
                </div>
              ) : (
                <table className="table veto-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Map</th>
                      <th>Action</th>
                      <th>Team</th>
                      <th>Starting side</th>
                      <th>
                        <span className="sr-only">Edit</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.draft.veto.map((e, i) => {
                      const team = e.teamId === teamA.id ? teamA : e.teamId === teamB.id ? teamB : null;
                      const rowIssues = issues.filter((x) => x.index === i);
                      return (
                        <tr key={e.id} className={rowIssues.length ? "is-error" : ""}>
                          <td className="mono">{i + 1}</td>
                          <td>
                            <strong>{mapLabel(e.mapName, names)}</strong>
                            {rowIssues.map((x) => (
                              <div key={x.message} className="ff-error small">
                                {x.message}
                              </div>
                            ))}
                          </td>
                          <td>
                            <span className={`veto-kind k-${e.type}`}>{TYPE_LABEL[e.type]}</span>
                          </td>
                          <td>
                            {team ? (
                              <span className="team-cell">
                                <TeamLogo assetId={team.logoAssetId} size={20} name={team.name} /> {team.name}
                              </span>
                            ) : (
                              <span className="muted">{e.type === "decider" ? "Left over" : "—"}</span>
                            )}
                          </td>
                          <td>
                            <SideText entries={d.draft.veto} index={i} a={teamA} b={teamB} />
                          </td>
                          <td className="col-actions">
                            <Button size="sm" variant="ghost" aria-label={`Move entry ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                              ↑
                            </Button>
                            <Button size="sm" variant="ghost" aria-label={`Move entry ${i + 1} down`} disabled={i === d.draft.veto.length - 1} onClick={() => move(i, 1)}>
                              ↓
                            </Button>
                            <Button size="sm" onClick={() => setEditing(i)} aria-label={`Edit entry ${i + 1}`}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEntries(d.draft.veto.filter((_, j) => j !== i))} aria-label={`Remove entry ${i + 1}`}>
                              Remove
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {d.draft.veto.length ? (
                <p className="small muted">
                  Maps played, in order: {planMaps(d.draft.veto, teamA.id, teamB.id).map((p) => mapLabel(p.mapName, names)).join(", ") || "none yet"}. Saving keeps the results of maps already played; a map with a result cannot be replaced.
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
      <Details summary="Additional details: round rules, map pool and status" className="additional">
        <div className="form-grid">
          <FormField label="Regulation rounds" htmlFor="m-reg" hint="24 = MR12">
            <input id="m-reg" type="number" min={2} max={60} value={d.draft.format.regulationRounds} onChange={(e) => d.set({ format: { ...d.draft.format, regulationRounds: Number(e.target.value) } })} />
          </FormField>
          <FormField label="Overtime rounds" htmlFor="m-ot">
            <input id="m-ot" type="number" min={2} max={20} value={d.draft.format.overtimeRounds} disabled={!d.draft.format.overtimeEnabled} onChange={(e) => d.set({ format: { ...d.draft.format, overtimeRounds: Number(e.target.value) } })} />
          </FormField>
          <FormField label="Status" htmlFor="m-status" hint="Sets the tab: Future, Current or Ended. Independent of Active for HUD.">
            <select id="m-status" value={d.draft.status} onChange={(e) => d.set({ status: e.target.value as Match["status"] })}>
              <option value="scheduled">Scheduled</option>
              <option value="veto">Veto in progress</option>
              <option value="live">Live</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </FormField>
        </div>
        <div className="row" style={{ gap: 16, margin: "8px 0" }}>
          <Checkbox checked={d.draft.format.overtimeEnabled} onChange={(overtimeEnabled) => d.set({ format: { ...d.draft.format, overtimeEnabled } })} label="Overtime enabled" />
          <Checkbox checked={d.draft.format.allowTie} onChange={(allowTie) => d.set({ format: { ...d.draft.format, allowTie } })} label="Allow regulation tie" />
        </div>
        <MapPoolEditor value={d.draft.mapPool} onChange={(mapPool) => d.set({ mapPool })} suggestions={appPool.data?.known ?? []} />
        <p className="small muted">Empty: the tournament's pool, else the CS2 map pool ({(appPool.data?.maps ?? []).map((m) => m.displayName).join(", ")}). New matches keep the pool they were created with.</p>
      </Details>
      {match ? (
        <>
          <Details summary={`Maps and results (${match.maps.length}) · applied at once`} className="additional">
            <MapResults match={match} teamA={teamA?.name ?? "Team 1"} teamB={teamB?.name ?? "Team 2"} onSaved={() => reload?.()} />
          </Details>
          <Details summary={`Stat corrections${match.corrections.length ? ` (${match.corrections.length})` : ""} · applied at once`} className="additional">
            <Corrections match={match} players={players.data ?? []} />
          </Details>
          <Details summary="Captain veto and captain links · applied at once" className="additional">
            <VetoBoard match={match} teamA={teamA} teamB={teamB} onMapsChanged={() => reload?.()} />
          </Details>
          <Details summary="Thumbnails and stingers" className="additional">
            <MatchArtPanel matchId={match.id} teams={`${teamA?.shortName ?? "A"}-vs-${teamB?.shortName ?? "B"}`} />
          </Details>
        </>
      ) : null}
      {editing !== null && teamA && teamB ? (
        <VetoEntryDialog
          entries={d.draft.veto}
          index={editing === "new" ? null : editing}
          teamA={teamA}
          teamB={teamB}
          pool={pool}
          names={names}
          onClose={() => setEditing(null)}
          onRemove={editing === "new" ? undefined : () => (setEntries(d.draft.veto.filter((_, j) => j !== editing)), setEditing(null))}
          onSave={(entry) => {
            setEntries(editing === "new" ? [...d.draft.veto, entry] : d.draft.veto.map((x, j) => (j === editing ? entry : x)));
            setEditing(null);
          }}
        />
      ) : null}
    </EditorShell>
  );
}
