import { useEffect, useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { MapInstance, MapResultResponse, MatchDetail, PlayerRow, StatCorrection } from "../../api/types.ts";
import { ActionButton, Badge, Checkbox, Field, Note } from "../../components/ui.tsx";
import { fmtTime, MISSING } from "../../lib/format.ts";
import { usePermission } from "../../state/session.tsx";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One map's round score: entered by the operator (or corrected); the series follows completed maps only. */
function MapResultRow({ match, mi, teamA, teamB, onSaved }: { match: MatchDetail; mi: MapInstance; teamA: string; teamB: string; onSaved: () => void }) {
  const reason = usePermission("metadata.write");
  const [a, setA] = useState(mi.scoreA);
  const [b, setB] = useState(mi.scoreB);
  const [completed, setCompleted] = useState(mi.status === "completed");
  const [forfeit, setForfeit] = useState("");
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setA(mi.scoreA);
    setB(mi.scoreB);
    setCompleted(mi.status === "completed");
  }, [mi.scoreA, mi.scoreB, mi.status]);
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

export function MapResults({ match, teamA, teamB, onSaved }: { match: MatchDetail; teamA: string; teamB: string; onSaved: () => void }) {
  if (match.maps.length === 0) return <p className="muted small">No maps yet: the picks and the decider in the veto become the match's maps when it is saved.</p>;
  return (
    <table className="table table-compact">
      <thead>
        <tr>
          <th>#</th>
          <th>Map</th>
          <th>Status</th>
          <th>
            Round score ({teamA} – {teamB})
          </th>
        </tr>
      </thead>
      <tbody>
        {match.maps.map((mi) => (
          <MapResultRow key={mi.id} match={match} mi={mi} teamA={teamA} teamB={teamB} onSaved={onSaved} />
        ))}
      </tbody>
    </table>
  );
}

export function Corrections({ match, players }: { match: MatchDetail; players: PlayerRow[] }) {
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
      <p className="small muted">Corrections keep the source value, the round they apply from and an audit trail. Applied at once.</p>
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
