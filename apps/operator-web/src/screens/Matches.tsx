import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { EventRecord, MapInstance, MapResultResponse, Match, MatchDetail, MatchRow, PlayerRow, StatCorrection, TeamRow } from "../api/types.ts";
import { MapPoolEditor } from "../components/AssetUpload.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, EmptyState, Field, KV, Note, Panel, Tabs } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { useMapSuggestions } from "../lib/maps.ts";
import { usePermission } from "../state/session.tsx";
import { VetoBoard } from "./matches/Veto.tsx";

const STATUS_TONE: Record<string, "ok" | "info" | "warn" | "neutral" | "danger"> = { live: "ok", veto: "info", scheduled: "neutral", completed: "info", cancelled: "danger" };

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
  return (
    <>
      <div className="form-grid">
        <Field label="Team A">
          <select value={teamAId} onChange={(e) => setA(e.target.value)}>
            <option value="">choose…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Team B">
          <select value={teamBId} onChange={(e) => setB(e.target.value)}>
            <option value="">choose…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Event">
          <select value={eventId} onChange={(e) => setEvent(e.target.value)}>
            <option value="">none</option>
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
          <div className="seg" role="radiogroup" aria-label="Best of">
            {[1, 3, 5].map((n) => (
              <button key={n} role="radio" aria-checked={bestOf === n} className={`seg-btn ${bestOf === n ? "is-on" : ""}`} onClick={() => setBestOf(n)}>
                BO{n}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Regulation rounds" hint="24 = MR12">
          <input type="number" min={2} max={60} value={regulationRounds} onChange={(e) => setReg(Number(e.target.value))} />
        </Field>
        <Field label="Overtime rounds">
          <input type="number" min={2} max={20} value={overtimeRounds} disabled={!overtimeEnabled} onChange={(e) => setOtRounds(Number(e.target.value))} />
        </Field>
      </div>
      <div className="row" style={{ margin: "8px 0" }}>
        <Checkbox checked={overtimeEnabled} onChange={setOt} label="Overtime enabled" />
        <Checkbox checked={allowTie} onChange={setTie} label="Allow regulation tie" />
      </div>
      <MapPoolEditor value={mapPool} onChange={setPool} suggestions={suggestions} />
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
          {mi.isDecider ? "decider" : mi.pickedByTeamId ? `pick: ${mi.pickedByTeamId === match.teamAId ? teamA : teamB}` : ""}
          {mi.startingCtTeamId ? ` · CT start: ${mi.startingCtTeamId === match.teamAId ? teamA : teamB}` : ""}
        </div>
      </td>
      <td>
        <Badge tone={mi.status === "completed" ? "ok" : mi.status === "live" ? "info" : mi.status === "forfeited" ? "warn" : "neutral"}>{mi.status}</Badge>
        {winner ? <div className="small">winner: {winner}</div> : null}
      </td>
      <td>
        <div className="row">
          <input type="number" min={0} aria-label={`${teamA} score on ${mi.mapName}`} value={a} onChange={(e) => setA(Number(e.target.value))} style={{ width: 64 }} />
          <span>–</span>
          <input type="number" min={0} aria-label={`${teamB} score on ${mi.mapName}`} value={b} onChange={(e) => setB(Number(e.target.value))} style={{ width: 64 }} />
          <Checkbox checked={completed} onChange={setCompleted} label="Map finished" />
          <select aria-label="Forfeit winner" value={forfeit} onChange={(e) => setForfeit(e.target.value)}>
            <option value="">no forfeit</option>
            <option value={match.teamAId}>forfeit → {teamA}</option>
            <option value={match.teamBId}>forfeit → {teamB}</option>
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
            reasonPlacement="tooltip"
          >
            Save result
          </ActionButton>
        </div>
        {note ? (
          <Note tone="warn" title="SERIES NOT ADVANCED">
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
      ) : (
        <p className="muted small">No corrections recorded.</p>
      )}
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
            <option value="">(not player-specific)</option>
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
            <option value="">whole match</option>
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
          <input type="number" value={round} onChange={(e) => setRound(e.target.value)} placeholder="all" />
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
    <div className="stack">
      <Panel
        title={`${A} vs ${B}`}
        subtitle={`${match.title ?? "Untitled match"} · BO${match.format.bestOf} · MR${match.format.regulationRounds / 2}${match.format.overtimeEnabled ? ` + OT${match.format.overtimeRounds / 2}` : ""}`}
        actions={
          <>
            <Badge tone={STATUS_TONE[match.status] ?? "neutral"}>{match.status}</Badge>
            {isActive ? (
              <>
                <Badge tone="ok" icon="●">
                  ACTIVE ON AIR
                </Badge>
                <ActionButton size="sm" action={() => api.post("/api/v1/live/deactivate-match")} success="Match deactivated" onDone={reloadActive} disabledReason={programReason}>
                  Deactivate
                </ActionButton>
              </>
            ) : (
              <ActionButton size="sm" variant="primary" action={() => api.post(`/api/v1/matches/${seg(match.id)}/activate`)} success={`${A} vs ${B} is now the active match`} onDone={() => (reload(), reloadActive())} disabledReason={programReason} confirm={{ title: "Activate this match?", body: "HUDs and live state use this match's teams, series and map list. The previously active match is replaced." }}>
                Activate match
              </ActionButton>
            )}
          </>
        }
      >
        <KV
          items={[
            ["Series", <strong key="s">{`${match.seriesScoreA} – ${match.seriesScoreB}`}</strong>],
            ["Scheduled", fmtTime(match.scheduledAt)],
            ["Map pool", match.mapPool.join(", ") || MISSING],
          ]}
        />
        <div className="form-grid" style={{ marginTop: 10 }}>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as Match["status"])}>
              {["scheduled", "veto", "live", "completed", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <MapPoolEditor value={pool} onChange={setPool} suggestions={suggestions} />
        <div className="form-actions">
          <ActionButton action={() => api.patch(`/api/v1/matches/${seg(match.id)}`, { title: title || null, status, mapPool: pool, revision: match.revision })} success="Match saved" onDone={reload} disabledReason={writeReason}>
            Save match
          </ActionButton>
        </div>
      </Panel>
      <Panel title="Maps & results" subtitle="Ties and unfinished maps never advance the series">
        {match.maps.length === 0 ? (
          <EmptyState title="No maps yet">Run the veto and apply it, or add maps manually below.</EmptyState>
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
          <Field label="Add map manually">
            <select value={newMap} onChange={(e) => setNewMap(e.target.value)}>
              <option value="">choose…</option>
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
      </Panel>
      <Panel title="Stat corrections" subtitle="Operator corrections keep the source value, effective round and an audit trail">
        <Corrections match={match} players={players} />
      </Panel>
    </div>
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
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Matches &amp; Veto</h1>
        <Button variant="primary" onClick={() => setCreating(!creating)}>
          {creating ? "Close new match" : "New match"}
        </Button>
      </div>
      {creating ? (
        <Panel title="New match">
          {(teams.data?.length ?? 0) < 2 ? (
            <EmptyState title="Two teams needed">Create teams in Teams &amp; Players first.</EmptyState>
          ) : (
            <CreateMatch
              teams={teams.data ?? []}
              events={events.data ?? []}
              onCreated={(id) => {
                setCreating(false);
                setSel(id);
                void matches.reload();
              }}
            />
          )}
        </Panel>
      ) : null}
      <div className="grid-1-2" style={{ marginTop: creating ? 14 : 0 }}>
        <Panel title="Matches">
          <Async state={matches}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No matches" action={<Button onClick={() => setCreating(true)}>New match</Button>}>
                  Create a match between two teams, run the veto, then activate it for the broadcast.
                </EmptyState>
              ) : (
                <ul className="select-list">
                  {list.map((m) => (
                    <li key={m.id}>
                      <button className={sel === m.id ? "is-selected" : ""} onClick={() => setSel(m.id)}>
                        <span style={{ flex: 1 }}>
                          <strong>
                            {teamName(m.teamAId)} vs {teamName(m.teamBId)}
                          </strong>{" "}
                          <span className="muted small">
                            BO{m.format.bestOf} · {m.seriesScoreA}–{m.seriesScoreB}
                          </span>
                          <div className="small muted">{m.title ?? m.id}</div>
                        </span>
                        {active.data?.value === m.id ? <Badge tone="ok">ACTIVE</Badge> : null}
                        <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </Panel>
        {sel ? (
          <MatchDetailView key={sel} matchId={sel} teams={teams.data ?? []} players={players.data ?? []} activeId={active.data?.value ?? null} reloadList={() => void matches.reload()} reloadActive={() => void active.reload()} />
        ) : (
          <EmptyState title="Select a match">Choose a match to manage maps, results, corrections and the veto.</EmptyState>
        )}
      </div>
    </div>
  );
}
