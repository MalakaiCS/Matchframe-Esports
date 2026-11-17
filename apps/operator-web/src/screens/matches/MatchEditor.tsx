import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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
import { perLocale, t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";
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
const LABEL: Record<string, string> = perLocale(() => ({ teamAId: "Team 1", teamBId: "Team 2", format: "Format", scheduledAt: t("matches.dateAndTime"), eventId: "Tournament", stageId: "Stage", title: t("matches.title"), mapPool: t("matches.mapPool"), veto: t("matches.mapVeto"), seriesScoreA: t("matches.seriesScore"), seriesScoreB: t("matches.seriesScore"), status: "Status" }));
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

/** A collapsed section whose content (live panels that poll the engine) mounts only once it is opened. */
function LazyDetails({ summary, className = "", children }: { summary: ReactNode; className?: string; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className={`details ${className}`} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setOpened(true)}>
      <summary>{summary}</summary>
      <div className="details-body">{opened ? children : null}</div>
    </details>
  );
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
  if (m.data === undefined) return <div className="page">{m.error ? <ErrorBox error={m.error} onRetry={() => void m.reload()} /> : <Loading label={t("matches.loadingMatch")} />}</div>;
  return <MatchEditor match={m.data} reload={() => void m.reload()} />;
}

/** Edit one veto entry: Pick / Ban / Decider, team, map, the opponent's starting side and Reversed sides. */
function VetoEntryDialog({ entries, index, teamA, teamB, pool, bestOf, names, onSave, onRemove, onClose }: { entries: VetoEntry[]; index: number | null; teamA: TeamRow; teamB: TeamRow; pool: string[]; bestOf: number; names: Map<string, string>; onSave: (e: VetoEntry) => void; onRemove?: () => void; onClose: () => void }) {
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
  // Map, team and side problems block the entry; order problems (a decider too early) are shown and can be fixed by moving entries.
  const issues = validateVetoEntries(list, { teamAId: teamA.id, teamBId: teamB.id, bestOf, pool }).filter((x) => x.index === at);
  const blocking = issues.filter((x) => x.field !== "type");
  const options = pool.map((m) => ({ key: m, label: mapLabel(m, names), keywords: m, hint: used.has(m) ? t("matches.usedInEntryM", { m: used.get(m) }) : undefined }));
  const set = (p: Partial<VetoEntry>) => setE((x) => ({ ...x, ...p }));
  return (
    <Modal
      title={index === null ? t("matches.addVetoEntry") : t("matches.editVetoEntryV", { v: index + 1 })}
      onClose={onClose}
      footer={
        <>
          {onRemove ? (
            <Button variant="danger" onClick={onRemove} className="mr-auto">{t("matches.removeEntry")}</Button>
          ) : null}
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabledReason={!e.mapName ? t("matches.chooseAMap") : (blocking[0]?.message ?? null)} onClick={() => onSave(e)}>
            {index === null ? t("matches.addEntry") : t("matches.saveEntry")}
          </Button>
        </>
      }
    >
      <div className="ff">
        <span className="ff-label" id="ve-type-l">{t("matches.action")}</span>
        <div className="seg" role="radiogroup" aria-labelledby="ve-type-l">
          {(["pick", "ban", "decider"] as const).map((tRow) => (
            <button
              key={tRow}
              type="button"
              role="radio"
              aria-checked={e.type === tRow}
              className={`seg-btn ${e.type === tRow ? "is-on" : ""}`}
              onClick={() => set({ type: tRow, teamId: tRow === "decider" ? null : (e.teamId ?? teamA.id), sideChoice: tRow === "ban" ? null : e.sideChoice, reversedSides: tRow === "ban" ? false : e.reversedSides })}
            >
              {TYPE_LABEL[tRow]}
            </button>
          ))}
        </div>
      </div>
      <div className="ff">
        <span className="ff-label" id="ve-team-l">
          {e.type === "ban" ? t("matches.bannedBy") : e.type === "pick" ? t("matches.pickedBy") : t("matches.team")}
        </span>
        {e.type === "decider" ? (
          <span className="small muted">{t("matches.theDeciderIsTheMap")}</span>
        ) : (
          <div className="seg" role="radiogroup" aria-labelledby="ve-team-l">
            {[teamA, teamB].map((tRow) => (
              <button key={tRow.id} type="button" role="radio" aria-checked={e.teamId === tRow.id} className={`seg-btn seg-team ${e.teamId === tRow.id ? "is-on" : ""}`} onClick={() => set({ teamId: tRow.id })}>
                <TeamLogo assetId={tRow.logoAssetId} size={18} name={tRow.name} /> {tRow.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <FormField label={t("matches.map")} htmlFor="ve-map" error={issues.find((x) => x.field === "mapName")?.message}>
        <Combobox id="ve-map" options={options} value={e.mapName || null} onChange={(m) => set({ mapName: m ?? "" })} placeholder={t("matches.searchTheMapPool")} />
      </FormField>
      {e.type !== "ban" ? (
        <>
          <div className="ff">
            <span className="ff-label" id="ve-side-l">
              {chooserName ? t("matches.startingSideChosenByChoosername", { chooserName }) : t("matches.opponentSStartingSide")}
            </span>
            <div className="seg" role="radiogroup" aria-labelledby="ve-side-l">
              {(
                [
                  ["CT", "CT"],
                  ["T", "T"],
                  [null, t("matches.notChosen")],
                ] as const
              ).map(([v, label]) => (
                <button key={label} type="button" role="radio" aria-checked={e.sideChoice === v} className={`seg-btn ${e.sideChoice === v ? "is-on" : ""}`} onClick={() => set({ sideChoice: v })}>
                  {label}
                </button>
              ))}
            </div>
            <span className="ff-hint">{e.type === "decider" ? t("matches.onTheDeciderTheTeam") : t("matches.theTeamThatDidNot")}</span>
          </div>
          <Checkbox checked={e.reversedSides} onChange={(reversedSides) => set({ reversedSides })} label={t("matches.reversedSidesSwapTheStarting")} />
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
        <><T k="matches.vChoseStrongV2" values={{ v: name ?? t("matches.opponent"), strong: <strong className={e.sideChoice === "CT" ? "text-ct" : "text-t"}>{e.sideChoice}</strong>, v2: ctName ? <span className="muted small">{t("matches.ctnameStartsCt", { ctName })}</span> : null }} /></>
      ) : (
        <span className="muted">{t("matches.sideNotChosen")}</span>
      )}
      {e.reversedSides ? <Badge className="ml-6">{t("matches.reversedSides")}</Badge> : null}
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
  const teamA = teamList.find((tRow) => tRow.id === d.draft.teamAId) ?? null;
  const teamB = teamList.find((tRow) => tRow.id === d.draft.teamBId) ?? null;
  const names = useMemo(() => new Map((appPool.data?.maps ?? []).map((m) => [m.mapName, m.displayName])), [appPool.data]);
  const event = (events.data ?? []).find((e) => e.id === d.draft.eventId);
  const pool = d.draft.mapPool.length ? d.draft.mapPool : event?.mapPool.length ? event.mapPool : (appPool.data?.maps.map((m) => m.mapName) ?? []);
  const poolSource = d.draft.mapPool.length ? t("matches.thisMatchSPool") : event?.mapPool.length ? t("matches.nameSPool", { name: event.name }) : t("matches.theCs2MapPool");
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
    if (!d.draft.teamAId) local.teamAId = t("matches.chooseTeam1");
    if (!d.draft.teamBId) local.teamBId = t("matches.chooseTeam2");
    if (d.draft.teamAId && d.draft.teamAId === d.draft.teamBId) local.teamBId = t("matches.team1AndTeam2");
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
  const editor = useEditor({ dirty: d.dirty, backTo: "/matches", save, savedMessage: () => (match ? t("matches.matchSaved") : t("matches.matchCreated")) });
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
      ? t("matches.theseEntriesComeFromThe", { captainDecisions: match.captainDecisions })
      : match && match.vetoSource === "maps" && sameValue(d.draft.veto, d.original.veto)
        ? t("matches.theseEntriesWereMadeFrom")
        : null;

  return (
    <EditorShell
      title={match ? t("matches.editMatchVVsV2", { v: teamA?.name ?? "Team 1", v2: teamB?.name ?? "Team 2" }) : t("matches.createMatch")}
      subtitle={
        match ? (
          <span className="row">
            {match.active ? (
              <Badge tone="ok" icon="●" title={t("matches.hudsAndLiveStateUse")}>{t("matches.activeForHud")}</Badge>
            ) : (
              <ActionButton size="sm" action={() => api.post(`/api/v1/matches/${seg(match.id)}/activate`)} success={t("matches.matchIsNowActiveFor")} onDone={() => reload?.()} disabledReason={programReason} confirm={{ title: t("matches.makeThisMatchActive"), body: t("matches.hudsAndLiveStateSwitch3"), confirmLabel: t("matches.makeActive") }}>{t("matches.makeActive")}</ActionButton>
            )}
          </span>
        ) : null
      }
      backTo="/matches"
      backLabel={t("nav.matches")}
      crumbs={[match ? `${teamA?.shortName ?? "?"} vs ${teamB?.shortName ?? "?"}` : t("nav.createMatch")]}
      editor={editor}
      saveDisabledReason={reason}
      footerNote={teamA && teamB && !complete ? <span className="small muted">{t("matches.theVetoIsNotComplete")}</span> : null}
    >
      {conflict.length ? (
        <Note tone="warn" title={t("matches.changedElsewhere")}><T k="matches.joinChangedWhileYouWere" values={{ join: [...new Set(conflict.map((c) => LABEL[c] ?? c))].join(", "), button: <Button
            size="sm"
            onClick={() => {
              d.reload(conflict as (keyof MatchDraft)[]);
              setConflict([]);
              setErrors({});
              reload?.();
            }}
          >{t("matches.useTheCurrentValues")}</Button> }} /></Note>
      ) : null}
      <div className="match-layout">
        <section className="match-side" aria-label={t("matches.teamsScoreAndFormat")}>
          <FormField label={t("matches.team1")} htmlFor="m-team-a" required error={errors.teamAId}>
            <TeamSelect id="m-team-a" teams={teamList} value={d.draft.teamAId} exclude={d.draft.teamBId} onChange={(teamAId) => d.set({ teamAId })} invalid={!!errors.teamAId} />
          </FormField>
          <FormField label={t("matches.team2")} htmlFor="m-team-b" required error={errors.teamBId ?? (same ? t("matches.team1AndTeam2") : null)}>
            <TeamSelect id="m-team-b" teams={teamList} value={d.draft.teamBId} exclude={d.draft.teamAId} onChange={(teamBId) => d.set({ teamBId })} invalid={!!errors.teamBId || same} />
          </FormField>
          <div className="versus" aria-label={t("matches.seriesScore")}>
            {[
              ["seriesScoreA", teamA, "Team 1"],
              ["seriesScoreB", teamB, "Team 2"],
            ].map(([key, tRow, fallback], i) => {
              const k = key as "seriesScoreA" | "seriesScoreB";
              const team = tRow as TeamRow | null;
              const v = d.draft[k];
              return (
                <div key={k} className={`versus-team ${i === 1 ? "is-right" : ""}`}>
                  <TeamLogo assetId={team?.logoAssetId} size={64} name={team?.name ?? (fallback as string)} />
                  <span className="versus-name">{team?.name ?? <span className="muted">{fallback as string}</span>}</span>
                  <div className="score-step">
                    <button type="button" aria-label={t("matches.vSeriesWinsMinusOne", { v: team?.name ?? (fallback as string) })} disabled={v <= 0} onClick={() => d.set({ [k]: v - 1 } as Partial<MatchDraft>)}>
                      −
                    </button>
                    <input aria-label={t("matches.vSeriesWins", { v: team?.name ?? (fallback as string) })} className="score-input" type="number" min={0} max={winsNeeded(bestOf)} value={v} onChange={(e) => d.set({ [k]: Math.max(0, Number(e.target.value) || 0) } as Partial<MatchDraft>)} />
                    <button type="button" aria-label={t("matches.vSeriesWinsPlusOne", { v: team?.name ?? (fallback as string) })} disabled={v >= winsNeeded(bestOf)} onClick={() => d.set({ [k]: v + 1 } as Partial<MatchDraft>)}>
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
              t("matches.seriesWinsAreMapsWon", { bestOf: winsNeeded(bestOf), v: match ? t("matches.fromCompletedMapsAB", { a: fromMaps.a, b: fromMaps.b, v: d.draft.seriesScoreA !== fromMaps.a || d.draft.seriesScoreB !== fromMaps.b ? t("matches.manualCorrectionSuffix") : "" }) : "" })}
          </p>
          <div className="ff">
            <span className="ff-label" id="m-bo-l">{t("matches.format")}</span>
            <div className="seg" role="radiogroup" aria-labelledby="m-bo-l">
              {[1, 2, 3, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={bestOf === n} className={`seg-btn ${bestOf === n ? "is-on" : ""}`} onClick={() => d.set({ format: { ...d.draft.format, bestOf: n } })}>
                  BO{n}
                </button>
              ))}
            </div>
          </div>
          <FormField label={t("matches.dateAndTime")} htmlFor="m-when" error={errors.scheduledAt} hint={t("matches.schedulingNeverMakesAMatch")}>
            <input id="m-when" type="datetime-local" value={toLocalInput(d.draft.scheduledAt)} onChange={(e) => d.set({ scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : null })} />
          </FormField>
          <FormField label={t("matches.tournament")} htmlFor="m-event" error={errors.eventId}>
            <select id="m-event" value={d.draft.eventId ?? ""} onChange={(e) => d.set({ eventId: e.target.value || null, stageId: null })}>
              <option value="">{t("matches.none")}</option>
              {(events.data ?? []).map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </FormField>
          {d.draft.eventId ? (
            <FormField label={t("matches.stage")} htmlFor="m-stage" error={errors.stageId}>
              <select id="m-stage" value={d.draft.stageId ?? ""} onChange={(e) => d.set({ stageId: e.target.value || null })}>
                <option value="">{t("matches.none")}</option>
                {(stages.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
          <FormField label={t("matches.title")} htmlFor="m-title">
            <input id="m-title" value={d.draft.title ?? ""} maxLength={120} placeholder={t("matches.eGGrandFinal")} onChange={(e) => d.set({ title: e.target.value || null })} />
          </FormField>
        </section>
        <section className="match-veto" aria-label={t("matches.mapVeto")}>
          <div className="veto-head">
            <h2 className="section-title">{t("matches.mapVeto")}</h2>
            {teamA && teamB ? (
              <>
                <span className={`small ${complete ? "text-ok" : "muted"}`}>{t("matches.mapsChosen", { playedCount, count: bestOf, v2: complete ? t("matches.complete") : "" })}</span>
                <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing("new")} disabledReason={complete && playedCount >= bestOf && d.draft.veto.some((e) => e.type === "decider") ? t("matches.theVetoIsCompleteThe") : null}>{t("matches.addEntry")}</Button>
              </>
            ) : null}
          </div>
          {!teamA || !teamB ? (
            <div className="veto-empty">
              <strong>{t("matches.chooseTeam1AndTeam")}</strong>
              <p className="muted">{t("matches.thenAddTheVetoIn")}</p>
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
                  <strong>{t("matches.noVetoEntriesYet")}</strong>
                  <p className="muted">{t("matches.addEachBanPickAnd", { poolSource, count: pool.length })}</p>
                </div>
              ) : (
                <table className="table veto-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t("matches.map")}</th>
                      <th>{t("matches.action")}</th>
                      <th>{t("matches.team")}</th>
                      <th>{t("matches.startingSide")}</th>
                      <th>
                        <span className="sr-only">{t("matches.edit")}</span>
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
                              <span className="muted">{e.type === "decider" ? t("matches.leftOver") : "—"}</span>
                            )}
                          </td>
                          <td>
                            <SideText entries={d.draft.veto} index={i} a={teamA} b={teamB} />
                          </td>
                          <td className="col-actions">
                            <Button size="sm" variant="ghost" aria-label={t("matches.moveEntryVUp", { v: i + 1 })} disabled={i === 0} onClick={() => move(i, -1)}>
                              ↑
                            </Button>
                            <Button size="sm" variant="ghost" aria-label={t("matches.moveEntryVDown", { v: i + 1 })} disabled={i === d.draft.veto.length - 1} onClick={() => move(i, 1)}>
                              ↓
                            </Button>
                            <Button size="sm" onClick={() => setEditing(i)} aria-label={t("matches.editEntryV", { v: i + 1 })}>{t("matches.edit")}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEntries(d.draft.veto.filter((_, j) => j !== i))} aria-label={t("matches.removeEntryV", { v: i + 1 })}>{t("matches.remove")}</Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {d.draft.veto.length ? (
                <p className="small muted">{t("matches.mapsPlayedInOrderV", { v: planMaps(d.draft.veto, teamA.id, teamB.id).map((p) => mapLabel(p.mapName, names)).join(", ") || t("matches.noneYet") })}</p>
              ) : null}
            </>
          )}
        </section>
      </div>
      <Details summary={t("matches.additionalDetailsRoundRulesMap")} className="additional">
        <div className="form-grid">
          <FormField label={t("matches.regulationRounds")} htmlFor="m-reg" hint="24 = MR12">
            <input id="m-reg" type="number" min={2} max={60} value={d.draft.format.regulationRounds} onChange={(e) => d.set({ format: { ...d.draft.format, regulationRounds: Number(e.target.value) } })} />
          </FormField>
          <FormField label={t("matches.overtimeRounds")} htmlFor="m-ot">
            <input id="m-ot" type="number" min={2} max={20} value={d.draft.format.overtimeRounds} disabled={!d.draft.format.overtimeEnabled} onChange={(e) => d.set({ format: { ...d.draft.format, overtimeRounds: Number(e.target.value) } })} />
          </FormField>
          <FormField label={t("matches.status")} htmlFor="m-status" hint={t("matches.setsTheTabFutureCurrent")}>
            <select id="m-status" value={d.draft.status} onChange={(e) => d.set({ status: e.target.value as Match["status"] })}>
              <option value="scheduled">{t("matches.scheduled")}</option>
              <option value="veto">{t("matches.vetoInProgress")}</option>
              <option value="live">{t("matches.live")}</option>
              <option value="completed">{t("matches.completed")}</option>
              <option value="cancelled">{t("matches.cancelled")}</option>
            </select>
          </FormField>
        </div>
        <div className="row" style={{ gap: 16, margin: "8px 0" }}>
          <Checkbox checked={d.draft.format.overtimeEnabled} onChange={(overtimeEnabled) => d.set({ format: { ...d.draft.format, overtimeEnabled } })} label={t("matches.overtimeEnabled")} />
          <Checkbox checked={d.draft.format.allowTie} onChange={(allowTie) => d.set({ format: { ...d.draft.format, allowTie } })} label={t("matches.allowRegulationTie")} />
        </div>
        <MapPoolEditor value={d.draft.mapPool} onChange={(mapPool) => d.set({ mapPool })} suggestions={appPool.data?.known ?? []} />
        <p className="small muted">{t("matches.emptyTheTournamentSPool", { join: (appPool.data?.maps ?? []).map((m) => m.displayName).join(", ") })}</p>
      </Details>
      {match ? (
        <>
          <LazyDetails summary={t("matches.mapsAndResultsCountApplied", { count: match.maps.length })} className="additional">
            <MapResults match={match} teamA={teamA?.name ?? "Team 1"} teamB={teamB?.name ?? "Team 2"} onSaved={() => reload?.()} />
          </LazyDetails>
          <LazyDetails summary={t("matches.statCorrectionsVAppliedAt", { v: match.corrections.length ? ` (${match.corrections.length})` : "" })} className="additional">
            <Corrections match={match} players={players.data ?? []} />
          </LazyDetails>
          <LazyDetails summary={t("matches.captainVetoAndCaptainLinks")} className="additional">
            <VetoBoard match={match} teamA={teamA} teamB={teamB} onMapsChanged={() => reload?.()} />
          </LazyDetails>
          <LazyDetails summary={t("matches.thumbnailsAndStingers")} className="additional">
            <MatchArtPanel matchId={match.id} teams={`${teamA?.shortName ?? "A"}-vs-${teamB?.shortName ?? "B"}`} />
          </LazyDetails>
        </>
      ) : null}
      {editing !== null && teamA && teamB ? (
        <VetoEntryDialog
          entries={d.draft.veto}
          index={editing === "new" ? null : editing}
          teamA={teamA}
          teamB={teamB}
          pool={pool}
          bestOf={bestOf}
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
