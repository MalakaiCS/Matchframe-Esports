import type { HudSeriesMap, HudStageTeam, HudState, HudTeam } from "@matchframe/hud-sdk";
import { mapArt, mapBackground } from "../art.ts";

function TeamCard({ team, big }: { team: HudTeam; big?: boolean }) {
  return (
    <div className={`mf-teamcard ${big ? "is-big" : ""}`} style={team.color ? ({ "--mf-team": team.color } as React.CSSProperties) : undefined}>
      <div className="mf-teamcard-logo">{team.logoUrl ? <img src={team.logoUrl} alt="" /> : <span>{team.shortName}</span>}</div>
      <div className="mf-teamcard-name">{team.name}</div>
    </div>
  );
}

/** A series map tile: the map's picture behind it and its logo above the name when set (HUD images). */
function MapTile({ state, m, className = "", children }: { state: HudState; m: HudSeriesMap; className?: string; children: React.ReactNode }) {
  const art = mapArt(state, m.mapName);
  return (
    <span className={`mf-screen-map ${className} ${art.imageUrl ? "has-image" : ""}`} style={mapBackground(art.imageUrl)}>
      {art.logoUrl ? <img className="mf-map-logo" src={art.logoUrl} alt="" /> : null}
      <b>{m.displayName}</b>
      {children}
    </span>
  );
}

export function PreMatch({ state }: { state: HudState }) {
  return (
    <div className="mf-screen mf-prematch">
      <div className="mf-screen-eyebrow">{state.event.name ?? "Matchframe Esports"}</div>
      <div className="mf-versus">
        <TeamCard team={state.left} big />
        <div className="mf-versus-vs">VS</div>
        <TeamCard team={state.right} big />
      </div>
      {state.series.bestOf ? (
        <div className="mf-screen-maps">
          <span className="mf-series-bo">BEST OF {state.series.bestOf}</span>
          {state.series.maps.map((m, i) => (
            <MapTile key={i} state={state} m={m}>
              <small>{m.pickedBy === "decider" ? "Decider" : m.pickedBy === "left" ? `${state.left.shortName} pick` : m.pickedBy === "right" ? `${state.right.shortName} pick` : ""}</small>
            </MapTile>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BreakScreen({ state }: { state: HudState }) {
  const next = state.series.maps.find((m) => m.status === "upcoming");
  const nextLogo = next ? mapArt(state, next.mapName).logoUrl : null;
  return (
    <div className="mf-screen mf-break">
      <div className="mf-screen-eyebrow">{state.event.name ?? "Matchframe Esports"}</div>
      <div className="mf-screen-title">BREAK</div>
      <div className="mf-screen-series">
        <TeamCard team={state.left} />
        <div className="mf-screen-seriesscore">
          {state.series.left} – {state.series.right}
        </div>
        <TeamCard team={state.right} />
      </div>
      {next ? (
        <div className="mf-screen-next">
          Next map: {nextLogo ? <img className="mf-map-logo" src={nextLogo} alt="" /> : null}
          {next.displayName}
        </div>
      ) : null}
    </div>
  );
}

export function PostMap({ state }: { state: HudState }) {
  const winner = (state.left.score ?? 0) > (state.right.score ?? 0) ? state.left : (state.right.score ?? 0) > (state.left.score ?? 0) ? state.right : null;
  const rows = (t: HudTeam) =>
    [...t.players]
      .sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0))
      .map((p) => (
        <tr key={p.steamId}>
          <td className="mf-stat-name">{p.name}</td>
          <td>{p.kills ?? "–"}</td>
          <td>{p.assists ?? "–"}</td>
          <td>{p.deaths ?? "–"}</td>
          <td title="Shown only with validated damage totals">{p.adr ?? "—"}</td>
        </tr>
      ));
  return (
    <div className="mf-screen mf-postmap">
      <div className="mf-screen-eyebrow">{state.match.mapDisplayName ?? ""}</div>
      <div className="mf-screen-series">
        <TeamCard team={state.left} />
        <div className="mf-screen-seriesscore">
          {state.left.score ?? "–"} – {state.right.score ?? "–"}
        </div>
        <TeamCard team={state.right} />
      </div>
      <div className="mf-screen-title">{winner ? `${winner.name} WIN THE MAP` : "MAP RESULT"}</div>
      <div className="mf-stats">
        {[state.left, state.right].map((t) => (
          <table key={t.key} className="mf-stat-table">
            <thead>
              <tr>
                <th>{t.shortName}</th>
                <th>K</th>
                <th>A</th>
                <th>D</th>
                <th>ADR</th>
              </tr>
            </thead>
            <tbody>{rows(t)}</tbody>
          </table>
        ))}
      </div>
    </div>
  );
}

export function PostSeries({ state }: { state: HudState }) {
  const winner = state.series.left > state.series.right ? state.left : state.series.right > state.series.left ? state.right : null;
  return (
    <div className="mf-screen mf-postseries">
      <div className="mf-screen-eyebrow">{state.event.name ?? "Matchframe Esports"}</div>
      <div className="mf-screen-title">{winner ? `${winner.name} WIN THE SERIES` : "SERIES RESULT"}</div>
      <div className="mf-screen-series">
        <TeamCard team={state.left} big />
        <div className="mf-screen-seriesscore">
          {state.series.left} – {state.series.right}
        </div>
        <TeamCard team={state.right} big />
      </div>
      <div className="mf-screen-maps">
        {state.series.maps.map((m, i) => (
          <MapTile key={i} state={state} m={m} className={m.winner ? `won-${m.winner}` : ""}>
            <small>
              {m.scoreLeft}–{m.scoreRight}
            </small>
          </MapTile>
        ))}
      </div>
    </div>
  );
}

export function VetoBoard({ state }: { state: HudState }) {
  const v = state.veto;
  return (
    <div className="mf-screen mf-veto">
      <div className="mf-screen-eyebrow">MAP VETO</div>
      <div className="mf-versus">
        <TeamCard team={state.left} />
        <div className="mf-versus-vs">VS</div>
        <TeamCard team={state.right} />
      </div>
      {!v || v.steps.length === 0 ? (
        <div className="mf-screen-next">Veto not started</div>
      ) : (
        <div className="mf-veto-steps">
          {v.steps.map((s) => {
            const art = mapArt(state, s.mapName);
            return (
              <div key={s.order} className={`mf-veto-step k-${s.kind} ${s.order === v.currentStep ? "is-current" : ""} ${s.locked ? "is-locked" : ""} ${art.imageUrl ? "has-image" : ""}`} style={mapBackground(art.imageUrl)}>
                <span className="mf-veto-kind">{s.kind === "side_choice" ? "SIDE" : s.kind.toUpperCase()}</span>
                <span className="mf-veto-team">{s.team === "left" ? state.left.shortName : s.team === "right" ? state.right.shortName : "—"}</span>
                <span className="mf-veto-map">
                  {art.logoUrl ? <img className="mf-map-logo" src={art.logoUrl} alt="" /> : null}
                  {s.mapName ?? s.side ?? (s.order === v.currentStep ? "…" : "")}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ReplayFrame() {
  return (
    <div className="mf-replay">
      <span className="mf-replay-tag">REPLAY</span>
    </div>
  );
}

function StageTeam({ team, placeholder }: { team: HudStageTeam | null; placeholder?: string | null }) {
  if (!team) return <span className="mf-stage-team is-tbd">{placeholder ?? "TBD"}</span>;
  return (
    <span className="mf-stage-team">
      <span className="mf-stage-logo">{team.logoUrl ? <img src={team.logoUrl} alt="" /> : team.shortName}</span>
      <span className="mf-stage-name">{team.name}</span>
    </span>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function StandingsBoard({ state }: { state: HudState }) {
  const s = state.standings!;
  return (
    <div className="mf-screen mf-standings">
      <div className="mf-screen-eyebrow">{state.event.name ?? "Matchframe Esports"}</div>
      <div className="mf-screen-title">{s.stageName}</div>
      <table className="mf-standings-table">
        <thead>
          <tr>
            <th>#</th>
            <th className="is-team">Team</th>
            <th>P</th>
            <th>W</th>
            <th>T</th>
            <th>L</th>
            <th>Maps</th>
            <th>Rounds</th>
            <th>Pts</th>
          </tr>
        </thead>
        <tbody>
          {s.rows.map((r, i) => (
            <tr key={i} className={`${r.advancing ? "is-advancing" : ""} ${r.tied ? "is-tied" : ""}`}>
              <td className="mf-standings-pos">{r.tied ? `${r.position}=` : r.position}</td>
              <td className="is-team">
                <StageTeam team={r.team} />
              </td>
              <td>{r.played}</td>
              <td>{r.wins}</td>
              <td>{r.ties}</td>
              <td>{r.losses}</td>
              <td>{signed(r.mapDifference)}</td>
              <td>{signed(r.roundDifference)}</td>
              <td className="mf-standings-pts">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BracketBoard({ state }: { state: HudState }) {
  const b = state.bracket!;
  const rounds = [...new Set(b.nodes.map((n) => n.round))].sort((x, y) => x - y);
  return (
    <div className="mf-screen mf-bracket">
      <div className="mf-screen-eyebrow">{state.event.name ?? "Matchframe Esports"}</div>
      <div className="mf-screen-title">{b.stageName}</div>
      <div className="mf-bracket-rounds">
        {rounds.map((r) => (
          <div key={r} className="mf-bracket-round">
            {b.nodes
              .filter((n) => n.round === r)
              .map((n) => (
                <div key={n.id} className={`mf-bracket-node s-${n.status}`}>
                  <div className="mf-bracket-label">{n.label}</div>
                  {[n.a, n.b].map((side, i) => (
                    <div key={i} className={`mf-bracket-side ${side.winner ? "is-winner" : ""}`}>
                      <StageTeam team={side.team} placeholder={side.placeholder} />
                      <span className="mf-bracket-score">{side.score ?? ""}</span>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
