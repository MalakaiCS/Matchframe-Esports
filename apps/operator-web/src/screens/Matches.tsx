import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { EventRecord, MapInstance, MapResultResponse, Match, MatchDetail, MatchRow, PlayerRow, StatCorrection, TeamRow } from "../api/types.ts";
import { MapPoolEditor } from "../components/AssetUpload.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, Details, EmptyState, Field, Note, Panel, Tabs } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { useMapSuggestions } from "../lib/maps.ts";
import { usePermission } from "../state/session.tsx";
import { VetoBoard } from "./matches/Veto.tsx";
import "../styles/group-a.css";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function formatText(f: Match["format"]): string {
  return `BO${f.bestOf} · MR${f.regulationRounds / 2}${f.overtimeEnabled ? ` + OT${f.overtimeRounds / 2}` : ""}`;
}

function CreateMatch({ teams, events, onCreated }: { teams: TeamRow[]; events: EventRecord[]; onCreated: (id: string) => void }) {
  const reason = usePermission("metadata.write");
  const suggestions = useMapSuggestions();
  const [teamAId, setA] = useState("");
  const [teamBId, setB] = useState("");
  const [eventId, setEvent] = useState("");
  const [title, setTitle] = useState("");
  const [scheduledAt, setScheduled] = useState("");
  const [bestOf, setBestOf] = useState(3);
  const [regulationRounds, setReg] = useState(24);
  const [overtimeEnabled, setOt] = useState(true);
  const [overtimeRounds, setOtRounds] = useState(6);
  const [allowTie, setTie] = useState(false);
  const [mapPool, setPool] = useState<string[]>([]);
  useEffect(() => {
    const ev = events.find((e) => e.id === eventId);
    if (ev && ev.mapPool.length && mapPool.length === 0) setPool(ev.mapPool);
  }, [eventId, events, mapPool.length]);
  const missing = !teamAId || !teamBId ? "Choose both teams" : teamAId === teamBId ? "A match needs two different teams" : mapPool.length < bestOf ? `Map pool needs at least ${bestOf} maps for BO${bestOf}` : null;
  const rules = `MR${regulationRounds / 2}${overtimeEnabled ? ` + OT${overtimeRounds / 2}` : ", no overtime"}${allowTie ? ", ties allowed" : ""}`;
  return (
    <>
      <div className="form-grid">
        <Field label="Team A">
          <select value={teamAId} onChange={(e) => setA(e.target.value)}>
            <option value="">Choose…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Team B">
          <select value={teamBId} onChange={(e) => setB(e.target.value)}>
            <option value="">Choose…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Event">
          <select value={eventId} onChange={(e) => setEvent(e.target.value)}>
            <option value="">None</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Grand final" />
        </Field>
        <Field label="Scheduled">
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduled(e.target.value)} />
        </Field>
        <Field label="Format">
          <div className="seg" role="radiogroup" aria-label="Best of" style={{ alignSelf: "flex-start" }}>
            {[1, 3, 5].map((n) => (
              <button key={n} role="radio" aria-checked={bestOf === n} className={`seg-btn ${bestOf === n ? "is-on" : ""}`} onClick={() => setBestOf(n)}>
                BO{n}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <Details summary={`Round rules: ${rules}`}>
        <div className="form-grid">
          <Field label="Regulation rounds" hint="24 = MR12">
            <input type="number" min={2} max={60} value={regulationRounds} onChange={(e) => setReg(Number(e.target.value))} />
          </Field>
          <Field label="Overtime rounds">
            <input type="number" min={2} max={20} value={overtimeRounds} disabled={!overtimeEnabled} onChange={(e) => setOtRounds(Number(e.target.value))} />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 8, gap: 16 }}>
          <Checkbox checked={overtimeEnabled} onChange={setOt} label="Overtime enabled" />
          <Checkbox checked={allowTie} onChange={setTie} label="Allow regulation tie" />
        </div>
      </Details>
      <div style={{ marginTop: 12 }}>
        <MapPoolEditor value={mapPool} onChange={setPool} suggestions={suggestions} />
      </div>
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() =>
            api.post<Match>("/api/v1/matches", {
              teamAId,
              teamBId,
              eventId: eventId || null,
              title: title || null,
              scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
              format: { bestOf, regulationRounds, overtimeEnabled, overtimeRounds, allowTie },
              mapPool,
            })
          }
          success="Match created"
          onDone={(m) => onCreated(m.id)}
          disabledReason={reason ?? missing}
        >
          Create match
        </ActionButton>
      </div>
    </>
  );
}

function MapResultRow({ match, mi, teamA, teamB, onSaved }: { match: MatchDetail; mi: MapInstance; teamA: string; teamB: string; onSaved: () => void }) {
  const reason = usePermission("metadata.write");
  const [a, setA] = useState(mi.scoreA);
  const [b, setB] = useState(mi.scoreB);
  const [completed, setCompleted] = useState(mi.status === "completed");
  const [forfeit, setForfeit] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const winner = mi.winnerTeamId === match.teamAId ? teamA : mi.winnerTeamId === match.teamBId ? teamB : null;
  return (
    <tr>
      <td>{mi.order}</td>
      <td>
        <strong>{mi.mapName}</strong>
        <div className="small muted">
          {mi.isDecider ? "Decider" : mi.pickedByTeamId ? `Pick: ${mi.pickedByTeamId === match.teamAId ? teamA : teamB}` : ""}
          {mi.startingCtTeamId ? ` · CT start: ${mi.startingCtTeamId === match.teamAId ? teamA : teamB}` : ""}
        </div>
      </td>
      <td>
        {mi.status === "live" ? <Badge tone="info">Live</Badge> : capitalize(mi.status)}
        {winner ? <div className="small muted">Winner: {winner}</div> : null}
      </td>
      <td>
        <div className="row">
          <input type="number" min={0} aria-label={`${teamA} score on ${mi.mapName}`} value={a} onChange={(e) => setA(Number(e.target.value))} style={{ width: 64 }} />
          <span>–</span>
          <input type="number" min={0} aria-label={`${teamB} score on ${mi.mapName}`} value={b} onChange={(e) => setB(Number(e.target.value))} style={{ width: 64 }} />
          <Checkbox checked={completed} onChange={setCompleted} label="Map finished" hint="Ties and unfinished maps never advance the series" />
          <select aria-label="Forfeit winner" value={forfeit} onChange={(e) => setForfeit(e.target.value)}>
            <option value="">No forfeit</option>
            <option value={match.teamAId}>Forfeit → {teamA}</option>
            <option value={match.teamBId}>Forfeit → {teamB}</option>
          </select>
          <ActionButton
            size="sm"
            variant="primary"
            action={() => api.post<MapResultResponse>(`/api/v1/matches/${seg(match.id)}/maps/${seg(mi.id)}/result`, { scoreA: a, scoreB: b, completed, ...(forfeit ? { forfeitWinnerTeamId: forfeit } : {}) })}
            success={(r) => `Result saved · series ${r.series.a}–${r.series.b}`}
            onDone={(r) => {
              setNote(r.note);
              onSaved();
            }}
            disabledReason={reason}
          >
            Save result
          </ActionButton>
        </div>
        {note ? (
          <Note tone="warn" title="Series not advanced">
            {note}
          </Note>
        ) : null}
      </td>
    </tr>
  );
}

function Corrections({ match, players }: { match: MatchDetail; players: PlayerRow[] }) {
  const reason = usePermission("metadata.write");
  const [field, setField] = useState("kills");
  const [steamId, setSteamId] = useState("");
  const [mapId, setMapId] = useState("");
  const [src, setSrc] = useState("");
  const [corr, setCorr] = useState("");
  const [round, setRound] = useState("");
  const [why, setWhy] = useState("");
  const [list, setList] = useState<StatCorrection[]>(match.corrections);
  useEffect(() => setList(match.corrections), [match.corrections]);
  const name = (sid: string | null) => players.find((p) => p.steamId === sid)?.displayName ?? sid ?? "team/match";
  return (
    <>
      <p className="small muted">Corrections keep the source value, the round they apply from and an audit trail.</p>
      {list.length ? (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Field</th>
              <th>Player</th>
              <th>Source → corrected</th>
              <th>From round</th>
              <th>Reason</th>
              <th>By / at</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td>{c.field}</td>
                <td>{name(c.steamId)}</td>
                <td>
                  {c.sourceValue ?? MISSING} → <strong>{c.correctedValue ?? MISSING}</strong>
                </td>
                <td>{c.effectiveFromRound ?? "all"}</td>
                <td className="small">{c.reason}</td>
                <td className="small">
                  {c.operator} · {fmtTime(c.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label="Field">
          <input list="corr-fields" value={field} onChange={(e) => setField(e.target.value)} />
          <datalist id="corr-fields">
            {["kills", "deaths", "assists", "adr", "score", "mvps"].map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field label="Player">
          <select value={steamId} onChange={(e) => setSteamId(e.target.value)}>
            <option value="">Not player-specific</option>
            {players
              .filter((p) => p.steamId)
              .map((p) => (
                <option key={p.id} value={p.steamId!}>
                  {p.displayName}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Map">
          <select value={mapId} onChange={(e) => setMapId(e.target.value)}>
            <option value="">Whole match</option>
            {match.maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.order}. {m.mapName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source value">
          <input type="number" value={src} onChange={(e) => setSrc(e.target.value)} />
        </Field>
        <Field label="Corrected value">
          <input type="number" value={corr} onChange={(e) => setCorr(e.target.value)} />
        </Field>
        <Field label="Effective from round">
          <input type="number" value={round} onChange={(e) => setRound(e.target.value)} placeholder="All" />
        </Field>
        <Field label="Reason (audited)">
          <input value={why} onChange={(e) => setWhy(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <ActionButton
          action={() =>
            api.post<StatCorrection>(`/api/v1/matches/${seg(match.id)}/corrections`, {
              field,
              steamId: steamId || null,
              mapInstanceId: mapId || null,
              sourceValue: src === "" ? null : Number(src),
              correctedValue: corr === "" ? null : Number(corr),
              effectiveFromRound: round === "" ? null : Number(round),
              reason: why,
            })
          }
          success="Correction recorded"
          onDone={(c) => {
            setList([...list, c]);
            setWhy("");
          }}
          disabledReason={reason ?? (field.trim() && why.trim().length >= 3 ? null : "Enter a field and a reason (≥3 characters)")}
        >
          Record correction
        </ActionButton>
      </div>
    </>
  );
}

function MatchOverview({ match, teamA, teamB, activeId, players, reload, reloadActive }: { match: MatchDetail; teamA: TeamRow | null; teamB: TeamRow | null; activeId: string | null; players: PlayerRow[]; reload: () => void; reloadActive: () => void }) {
  const writeReason = usePermission("metadata.write");
  const programReason = usePermission("program.control");
  const suggestions = useMapSuggestions();
  const [title, setTitle] = useState(match.title ?? "");
  const [status, setStatus] = useState(match.status);
  const [pool, setPool] = useState(match.mapPool);
  const [newMap, setNewMap] = useState("");
  useEffect(() => {
    setTitle(match.title ?? "");
    setStatus(match.status);
    setPool(match.mapPool);
  }, [match]);
  const A = teamA?.name ?? "Team A";
  const B = teamB?.name ?? "Team B";
  const isActive = activeId === match.id;
  return (
    <Panel
      title={`${A} vs ${B}`}
      subtitle={[match.title ?? "Untitled match", formatText(match.format), match.scheduledAt ? fmtTime(match.scheduledAt) : null, capitalize(match.status)].filter(Boolean).join(" · ")}
      actions={
        isActive ? (
          <>
            <Badge tone="ok" icon="●" title="HUDs and live state use this match">
              Active
            </Badge>
            <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/live/deactivate-match")} success="Match deactivated" onDone={reloadActive} disabledReason={programReason}>
              Deactivate
            </ActionButton>
          </>
        ) : (
          <ActionButton size="sm" variant="primary" action={() => api.post(`/api/v1/matches/${seg(match.id)}/activate`)} success={`${A} vs ${B} is now the active match`} onDone={() => (reload(), reloadActive())} disabledReason={programReason} confirm={{ title: "Activate this match?", body: "HUDs and live state use this match's teams, series and map list. The previously active match is replaced." }}>
            Activate match
          </ActionButton>
        )
      }
    >
      <h3 className="ga-section-title">
        Maps{" "}
        <span className="muted small">
          Series {match.seriesScoreA}–{match.seriesScoreB}
        </span>
      </h3>
      {match.maps.length === 0 ? (
        <p className="muted">No maps yet. Run the veto and apply it, or add maps below.</p>
      ) : (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>#</th>
              <th>Map</th>
              <th>Status</th>
              <th>
                Score ({A} – {B})
              </th>
            </tr>
          </thead>
          <tbody>
            {match.maps.map((mi) => (
              <MapResultRow key={mi.id} match={match} mi={mi} teamA={A} teamB={B} onSaved={reload} />
            ))}
          </tbody>
        </table>
      )}
      <div className="row-end" style={{ marginTop: 10 }}>
        <Field label="Add a map">
          <select value={newMap} onChange={(e) => setNewMap(e.target.value)}>
            <option value="">Choose…</option>
            {(match.mapPool.length ? match.mapPool : suggestions).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <ActionButton
          action={() =>
            api.put(`/api/v1/matches/${seg(match.id)}/maps`, {
              maps: [...match.maps, { order: match.maps.length + 1, mapName: newMap, pickedByTeamId: null, isDecider: false, startingCtTeamId: null, status: "upcoming", scoreA: 0, scoreB: 0, winnerTeamId: null, mapRevision: null }],
            })
          }
          success="Map added"
          onDone={() => {
            setNewMap("");
            reload();
          }}
          disabledReason={writeReason ?? (newMap ? null : "Choose a map")}
        >
          Add map
        </ActionButton>
        {match.maps.length ? (
          <ActionButton variant="ghost" action={() => api.put(`/api/v1/matches/${seg(match.id)}/maps`, { maps: match.maps.slice(0, -1) })} success="Last map removed" onDone={reload} disabledReason={writeReason} confirm={{ title: `Remove map ${match.maps[match.maps.length - 1]?.mapName}?`, body: "Removes the last map and its score from the match.", danger: true }}>
            Remove last map
          </ActionButton>
        ) : null}
      </div>
      <Details summary="Edit match details" className="ga-section">
        <div className="form-grid">
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as Match["status"])}>
              {["scheduled", "veto", "live", "completed", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {capitalize(s)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <MapPoolEditor value={pool} onChange={setPool} suggestions={suggestions} />
        </div>
        <div className="form-actions">
          <ActionButton variant="primary" action={() => api.patch(`/api/v1/matches/${seg(match.id)}`, { title: title || null, status, mapPool: pool, revision: match.revision })} success="Match saved" onDone={reload} disabledReason={writeReason}>
            Save match
          </ActionButton>
        </div>
      </Details>
      <Details summary={`Stat corrections${match.corrections.length ? ` (${match.corrections.length})` : ""}`}>
        <Corrections match={match} players={players} />
      </Details>
    </Panel>
  );
}

function MatchDetailView({ matchId, teams, players, activeId, reloadList, reloadActive }: { matchId: string; teams: TeamRow[]; players: PlayerRow[]; activeId: string | null; reloadList: () => void; reloadActive: () => void }) {
  const m = useApi<MatchDetail>(`/api/v1/matches/${seg(matchId)}`);
  const [tab, setTab] = useState<"overview" | "veto">("overview");
  const reload = () => {
    void m.reload();
    reloadList();
  };
  return (
    <Async state={m}>
      {(match) => {
        const teamA = teams.find((t) => t.id === match.teamAId) ?? null;
        const teamB = teams.find((t) => t.id === match.teamBId) ?? null;
        return (
          <div>
            <Tabs
              label="Match sections"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "overview", label: "Match & maps" },
                { id: "veto", label: "Veto" },
              ]}
            />
            {tab === "overview" ? <MatchOverview match={match} teamA={teamA} teamB={teamB} activeId={activeId} players={players} reload={reload} reloadActive={reloadActive} /> : <VetoBoard match={match} teamA={teamA} teamB={teamB} onMapsChanged={reload} />}
          </div>
        );
      }}
    </Async>
  );
}

export function MatchesScreen() {
  const matches = useApi<MatchRow[]>("/api/v1/matches");
  const teams = useApi<TeamRow[]>("/api/v1/teams");
  const events = useApi<EventRecord[]>("/api/v1/events");
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const active = useApi<{ value: string | null }>("/api/v1/settings/live.activeMatchId");
  const [picked, setSel] = useState<string | null>(null);
  const sel = picked ?? active.data?.value ?? matches.data?.[0]?.id ?? null;
  const [creating, setCreating] = useState(false);
  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.shortName ?? "?";
  const showCreate = creating || (!sel && matches.data !== undefined);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Matches &amp; Veto</h1>
        {sel ? (
          <Button variant={creating ? "secondary" : "primary"} onClick={() => setCreating(!creating)}>
            {creating ? "Cancel" : "New match"}
          </Button>
        ) : null}
      </div>
      <div className="grid-1-2">
        <Panel title="Matches">
          <Async state={matches}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No matches yet">Create a match between two teams, run the veto, then activate it for the broadcast.</EmptyState>
              ) : (
                <ul className="select-list">
                  {list.map((m) => (
                    <li key={m.id}>
                      <button
                        className={!creating && sel === m.id ? "is-selected" : ""}
                        onClick={() => {
                          setSel(m.id);
                          setCreating(false);
                        }}
                      >
                        <span style={{ flex: 1 }}>
                          <strong>
                            {teamName(m.teamAId)} vs {teamName(m.teamBId)}
                          </strong>{" "}
                          <span className="muted small">
                            BO{m.format.bestOf} · {m.seriesScoreA}–{m.seriesScoreB}
                          </span>
                          <div className="small muted">
                            {m.title ?? "Untitled match"} · {capitalize(m.status)}
                          </div>
                        </span>
                        {active.data?.value === m.id ? (
                          <Badge tone="ok" title="HUDs and live state use this match">
                            Active
                          </Badge>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </Panel>
        {showCreate ? (
          <Panel title="New match">
            {teams.data === undefined ? null : teams.data.length < 2 ? (
              <EmptyState title="Two teams needed">Create teams in Teams first.</EmptyState>
            ) : (
              <CreateMatch
                teams={teams.data}
                events={events.data ?? []}
                onCreated={(id) => {
                  setCreating(false);
                  setSel(id);
                  void matches.reload();
                }}
              />
            )}
          </Panel>
        ) : sel ? (
          <MatchDetailView key={sel} matchId={sel} teams={teams.data ?? []} players={players.data ?? []} activeId={active.data?.value ?? null} reloadList={() => void matches.reload()} reloadActive={() => void active.reload()} />
        ) : null}
      </div>
    </div>
  );
}
