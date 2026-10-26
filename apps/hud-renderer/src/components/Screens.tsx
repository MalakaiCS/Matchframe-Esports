import type { HudState, HudTeam } from "@matchframe/hud-sdk";

function TeamCard({ team, big }: { team: HudTeam; big?: boolean }) {
  return (
    <div className={`mf-teamcard ${big ? "is-big" : ""}`} style={team.color ? ({ "--mf-team": team.color } as React.CSSProperties) : undefined}>
      <div className="mf-teamcard-logo">{team.logoUrl ? <img src={team.logoUrl} alt="" /> : <span>{team.shortName}</span>}</div>
      <div className="mf-teamcard-name">{team.name}</div>
    </div>
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
            <span key={i} className="mf-screen-map">
              <b>{m.displayName}</b>
              <small>{m.pickedBy === "decider" ? "Decider" : m.pickedBy === "left" ? `${state.left.shortName} pick` : m.pickedBy === "right" ? `${state.right.shortName} pick` : ""}</small>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BreakScreen({ state }: { state: HudState }) {
  const next = state.series.maps.find((m) => m.status === "upcoming");
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
      {next ? <div className="mf-screen-next">Next map: {next.displayName}</div> : null}
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
          <span key={i} className={`mf-screen-map ${m.winner ? `won-${m.winner}` : ""}`}>
            <b>{m.displayName}</b>
            <small>
              {m.scoreLeft}–{m.scoreRight}
            </small>
          </span>
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
          {v.steps.map((s) => (
            <div key={s.order} className={`mf-veto-step k-${s.kind} ${s.order === v.currentStep ? "is-current" : ""} ${s.locked ? "is-locked" : ""}`}>
              <span className="mf-veto-kind">{s.kind === "side_choice" ? "SIDE" : s.kind.toUpperCase()}</span>
              <span className="mf-veto-team">{s.team === "left" ? state.left.shortName : s.team === "right" ? state.right.shortName : "—"}</span>
              <span className="mf-veto-map">{s.mapName ?? s.side ?? (s.order === v.currentStep ? "…" : "")}</span>
            </div>
          ))}
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
