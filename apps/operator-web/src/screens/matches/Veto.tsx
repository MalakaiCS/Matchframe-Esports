import { useState } from "react";
import type { Side } from "@matchframe/contracts";
import { api, seg } from "../../api/index.ts";
import type { MatchDetail, TeamRow, VetoStatusResponse, VetoStep } from "../../api/types.ts";
import { ActionButton, Async, Badge, Button, CopyButton, Field, JsonEditor, Note, Panel, parseJsonOr } from "../../components/ui.tsx";
import { fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

export const VETO_KIND_LABEL: Record<string, string> = { ban: "Ban", pick: "Pick", decider: "Decider", side_choice: "Side choice" };

export function stepActorName(step: VetoStep, teamA: string, teamB: string): string {
  return step.actor === "A" ? teamA : step.actor === "B" ? teamB : "automatic";
}

function CaptainLinks({ match, teamA, teamB }: { match: MatchDetail; teamA: TeamRow | null; teamB: TeamRow | null }) {
  const reason = usePermission("settings.manage");
  const [ttl, setTtl] = useState("6");
  const [links, setLinks] = useState<Record<string, string>>({});
  const issue = (team: TeamRow | null) => (
    <div className="row" key={team?.id ?? "x"}>
      <strong style={{ minWidth: 140 }}>{team?.name ?? "?"}</strong>
      <ActionButton
        size="sm"
        action={() => api.post<{ id: string; token: string }>("/api/v1/tokens", { role: "captain", label: `Captain ${team?.shortName ?? ""} · ${match.title ?? match.id}`.slice(0, 80), matchId: match.id, teamId: team!.id, ttlHours: Number(ttl) })}
        success="Captain link issued (shown once)"
        onDone={(t) => setLinks({ ...links, [team!.id]: `${window.location.origin}/captain?match=${encodeURIComponent(match.id)}&token=${t.token}` })}
        disabledReason={reason ?? (team ? null : "Team missing")}
        reasonPlacement="tooltip"
      >
        Issue link
      </ActionButton>
      {team && links[team.id] ? (
        <span className="url-box" style={{ flex: 1 }}>
          <input readOnly value={links[team.id]} aria-label={`Captain link for ${team.name}`} onFocus={(e) => e.target.select()} />
          <CopyButton text={links[team.id]!} />
        </span>
      ) : null}
    </div>
  );
  return (
    <>
      <p className="small muted">A captain link is a token scoped to this match and one team. Captains see only veto information and can act only on their own turns. Revoke links in Devices → Tokens.</p>
      <Field label="Link valid for">
        <select value={ttl} onChange={(e) => setTtl(e.target.value)} style={{ width: 160 }}>
          <option value="2">2 hours</option>
          <option value="6">6 hours</option>
          <option value="12">12 hours</option>
          <option value="24">24 hours</option>
        </select>
      </Field>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        {issue(teamA)}
        {issue(teamB)}
      </div>
    </>
  );
}

export function VetoBoard({ match, teamA, teamB, onMapsChanged }: { match: MatchDetail; teamA: TeamRow | null; teamB: TeamRow | null; onMapsChanged: () => void }) {
  const reason = usePermission("metadata.write");
  const veto = useApi<VetoStatusResponse>(`/api/v1/veto/${seg(match.id)}`, { refreshMs: 3000 });
  const [reviseStep, setReviseStep] = useState("");
  const [reviseMap, setReviseMap] = useState("");
  const [reviseSide, setReviseSide] = useState<Side | "">("");
  const [seqText, setSeqText] = useState("");
  const A = teamA?.name ?? "Team A";
  const B = teamB?.name ?? "Team B";
  const teamIdOf = (actor: "A" | "B" | null) => (actor === "A" ? match.teamAId : actor === "B" ? match.teamBId : null);
  return (
    <Async
      state={veto}
      empty={null}
    >
      {(v) => {
        const cur = v.currentStep;
        const decided = (order: number) => v.decisions.find((d) => d.stepOrder === order);
        const act = (body: Record<string, unknown>) => api.post(`/api/v1/veto/${seg(match.id)}/act`, { stepOrder: cur!.order, teamId: teamIdOf(cur!.actor), ...body });
        const reviseTarget = v.decisions.find((d) => String(d.stepOrder) === reviseStep);
        const seq = parseJsonOr<{ steps: VetoStep[] } | VetoStep[]>(seqText, []);
        return (
          <div className="stack">
            <Panel title="Veto board" subtitle={`BO${match.format.bestOf} · pool ${match.mapPool.length} maps · ${v.complete ? "complete" : `step ${cur?.order} of ${v.steps.length}`}`} actions={v.complete ? <Badge tone="ok">COMPLETE</Badge> : <Badge tone="info">IN PROGRESS</Badge>}>
              <ol className="veto-steps">
                {v.steps.map((s) => {
                  const d = decided(s.order);
                  return (
                    <li key={s.order} className={`veto-step ${cur?.order === s.order ? "is-current" : ""} ${d ? "is-done" : ""}`}>
                      <div className="row">
                        <span className="muted mono">{s.order}</span>
                        <span className={`veto-kind k-${s.kind}`}>{VETO_KIND_LABEL[s.kind]}</span>
                        {cur?.order === s.order ? <Badge tone="accent">NOW</Badge> : null}
                      </div>
                      <div className="small">{stepActorName(s, A, B)}</div>
                      <div>{d ? <strong>{d.mapName ?? d.side ?? "—"}</strong> : <span className="muted small">pending</span>}</div>
                    </li>
                  );
                })}
              </ol>
              {cur ? (
                <div style={{ marginTop: 12 }}>
                  <h3>
                    Step {cur.order}: {VETO_KIND_LABEL[cur.kind]} — {stepActorName(cur, A, B)}
                  </h3>
                  {cur.kind === "ban" || cur.kind === "pick" ? (
                    <div className="map-buttons" style={{ marginTop: 8 }}>
                      {v.remainingMaps.map((m) => (
                        <ActionButton key={m} variant={cur.kind === "ban" ? "danger" : "primary"} action={() => act({ mapName: m })} success={`${stepActorName(cur, A, B)} ${cur.kind === "ban" ? "banned" : "picked"} ${m}`} onDone={() => void veto.reload()} disabledReason={reason} reasonPlacement="tooltip">
                          {cur.kind === "ban" ? "Ban" : "Pick"} {m}
                        </ActionButton>
                      ))}
                    </div>
                  ) : null}
                  {cur.kind === "side_choice" ? (
                    <div className="row" style={{ marginTop: 8 }}>
                      {(["CT", "T"] as const).map((sd) => (
                        <ActionButton key={sd} variant="primary" action={() => act({ side: sd })} success={`${stepActorName(cur, A, B)} chose ${sd}`} onDone={() => void veto.reload()} disabledReason={reason}>
                          Start {sd}
                        </ActionButton>
                      ))}
                      <span className="small muted">for {v.pickedMaps[v.pickedMaps.length - 1]?.mapName ?? "the last picked map"}</span>
                    </div>
                  ) : null}
                  {cur.kind === "decider" ? (
                    <ActionButton variant="primary" action={() => act({})} success="Decider locked" onDone={() => void veto.reload()} disabledReason={reason ?? (v.remainingMaps.length === 1 ? null : `Decider needs exactly one remaining map (have ${v.remainingMaps.length})`)}>
                      Lock decider: {v.remainingMaps.join(", ")}
                    </ActionButton>
                  ) : null}
                </div>
              ) : null}
            </Panel>
            <div className="grid-2">
              <Panel title="Result">
                {v.pickedMaps.length === 0 ? (
                  <p className="muted small">No maps picked yet.</p>
                ) : (
                  <ol>
                    {v.pickedMaps.map((p) => (
                      <li key={p.mapName}>
                        <strong>{p.mapName}</strong> — {p.decider ? "decider" : `picked by ${p.pickedBy === "A" ? A : B}`}
                        {p.startingSide ? ` · ${p.startingSide.team === "A" ? A : B} start ${p.startingSide.side}` : ""}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="form-actions">
                  <ActionButton variant="primary" action={() => api.post<{ maps: unknown[] }>(`/api/v1/veto/${seg(match.id)}/apply-to-maps`)} success={(r) => `${r.maps.length} map(s) written to the match`} onDone={onMapsChanged} disabledReason={reason ?? (v.complete ? null : "Finish the veto first")} confirm={{ title: "Apply veto result to the match maps?", body: "Replaces the match's map list with the veto picks (scores reset to 0–0)." }}>
                    Apply to match maps
                  </ActionButton>
                  <ActionButton
                    variant="warn"
                    action={(why) => api.post(`/api/v1/veto/${seg(match.id)}/reset`, { reason: why })}
                    success="Veto reset"
                    onDone={() => void veto.reload()}
                    disabledReason={reason ?? (v.decisions.length ? null : "Nothing to reset")}
                    confirm={{ title: "Reset the veto?", body: "Deletes all veto decisions for this match. The reason is written to the audit log.", reasonLabel: "Reason", danger: true, confirmLabel: "Reset veto" }}
                  >
                    Reset veto…
                  </ActionButton>
                </div>
              </Panel>
              <Panel title="Revise a decision" subtitle="Audited correction; the original stays in history">
                <div className="form-grid">
                  <Field label="Step">
                    <select value={reviseStep} onChange={(e) => setReviseStep(e.target.value)}>
                      <option value="">choose…</option>
                      {v.decisions.map((d) => (
                        <option key={d.id} value={d.stepOrder}>
                          {d.stepOrder} · {VETO_KIND_LABEL[d.kind]} · {d.mapName ?? d.side}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {reviseTarget && reviseTarget.kind !== "side_choice" ? (
                    <Field label="New map">
                      <select value={reviseMap} onChange={(e) => setReviseMap(e.target.value)}>
                        <option value="">choose…</option>
                        {match.mapPool.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                  {reviseTarget?.kind === "side_choice" ? (
                    <Field label="New side">
                      <select value={reviseSide} onChange={(e) => setReviseSide(e.target.value as Side | "")}>
                        <option value="">choose…</option>
                        <option value="CT">CT</option>
                        <option value="T">T</option>
                      </select>
                    </Field>
                  ) : null}
                </div>
                <div className="form-actions">
                  <ActionButton
                    action={(why) => api.post(`/api/v1/veto/${seg(match.id)}/revise`, { stepOrder: Number(reviseStep), teamId: reviseTarget!.teamId, mapName: reviseTarget!.kind === "side_choice" ? null : reviseMap, side: reviseTarget!.kind === "side_choice" ? reviseSide : null, reason: why })}
                    success="Decision revised"
                    onDone={() => void veto.reload()}
                    disabledReason={reason ?? (!reviseTarget ? "Choose a decided step" : reviseTarget.kind === "side_choice" ? (reviseSide ? null : "Choose a side") : reviseMap ? null : "Choose a map")}
                    confirm={{ title: `Revise step ${reviseStep}?`, reasonLabel: "Reason (audited)", confirmLabel: "Revise" }}
                  >
                    Revise…
                  </ActionButton>
                </div>
              </Panel>
            </div>
            <Panel title="History (including revisions)">
              {v.history.length === 0 ? (
                <p className="muted small">No decisions yet.</p>
              ) : (
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Action</th>
                      <th>Team</th>
                      <th>Decision</th>
                      <th>By</th>
                      <th>At</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.history.map((d) => (
                      <tr key={d.id}>
                        <td>{d.stepOrder}</td>
                        <td>{VETO_KIND_LABEL[d.kind]}</td>
                        <td>{d.teamId === match.teamAId ? A : d.teamId === match.teamBId ? B : "—"}</td>
                        <td>{d.mapName ?? d.side ?? "—"}</td>
                        <td className="small">{d.decidedBy}</td>
                        <td className="small">{fmtTime(d.decidedAt)}</td>
                        <td>
                          {d.supersededBy ? <Badge tone="warn">SUPERSEDED</Badge> : <Badge tone="ok">ACTIVE</Badge>} {d.revisionOf ? <Badge tone="info">REVISION</Badge> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
            <div className="grid-2">
              <Panel title="Captain links">
                <CaptainLinks match={match} teamA={teamA} teamB={teamB} />
              </Panel>
              <Panel title="Custom sequence" subtitle="Only before the first decision">
                {!seqText ? (
                  <Button size="sm" onClick={() => setSeqText(JSON.stringify(v.steps, null, 2))}>
                    Edit sequence as JSON
                  </Button>
                ) : (
                  <>
                    <JsonEditor label="Steps [{order, kind: ban|pick|decider|side_choice, actor: A|B|null}]" value={seqText} onChange={setSeqText} rows={10} />
                    <div className="form-actions">
                      <ActionButton
                        action={() => {
                          if (!seq.ok) throw new Error(seq.error);
                          const steps = Array.isArray(seq.value) ? seq.value : seq.value.steps;
                          return api.put(`/api/v1/veto/${seg(match.id)}/sequence`, { steps });
                        }}
                        success="Veto sequence saved"
                        onDone={() => {
                          setSeqText("");
                          void veto.reload();
                        }}
                        disabledReason={reason ?? (v.decisions.length ? "The veto has started — reset it first" : seq.ok ? null : "Invalid JSON")}
                      >
                        Save sequence
                      </ActionButton>
                      <Button onClick={() => setSeqText("")}>Cancel</Button>
                    </div>
                  </>
                )}
              </Panel>
            </div>
            {match.mapPool.length < match.format.bestOf ? <Note tone="warn">The map pool ({match.mapPool.length}) is smaller than best-of {match.format.bestOf}: extend it in the match details.</Note> : null}
          </div>
        );
      }}
    </Async>
  );
}
