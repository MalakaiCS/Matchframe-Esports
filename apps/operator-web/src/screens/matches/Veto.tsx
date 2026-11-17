import { useState } from "react";
import type { Side } from "@matchframe/contracts";
import { api, seg } from "../../api/index.ts";
import type { MatchDetail, TeamRow, VetoStatusResponse, VetoStep } from "../../api/types.ts";
import { ActionButton, Async, Button, CopyButton, Details, Field, JsonEditor, Note, Panel, parseJsonOr } from "../../components/ui.tsx";
import { fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { engineOrigin } from "../../lib/engine.ts";
import { perLocale, t } from "../../i18n/index.ts";
import "../../styles/group-a.css";

export const VETO_KIND_LABEL: Record<string, string> = perLocale(() => ({ ban: "Ban", pick: "Pick", decider: "Decider", side_choice: t("matches.sideChoice") }));

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
        success={t("matches.captainLinkIssuedShownOnce")}
        onDone={(tRow) => setLinks({ ...links, [team!.id]: `${engineOrigin()}/captain?match=${encodeURIComponent(match.id)}&token=${tRow.token}` })}
        disabledReason={reason ?? (team ? null : t("matches.teamMissing"))}
        aria-label={t("matches.issueLinkForV", { v: team?.name ?? "team" })}
      >{t("matches.issueLink")}</ActionButton>
      {team && links[team.id] ? (
        <span className="url-box" style={{ flex: 1 }}>
          <input readOnly value={links[team.id]} aria-label={t("matches.captainLinkForName", { name: team.name })} onFocus={(e) => e.target.select()} />
          <CopyButton text={links[team.id]!} />
        </span>
      ) : null}
    </div>
  );
  return (
    <>
      <div className="row-end">
        <Field label={t("matches.linkValidFor")}>
          <select value={ttl} onChange={(e) => setTtl(e.target.value)} style={{ width: 160 }}>
            <option value="2">{t("matches.text2Hours")}</option>
            <option value="6">{t("matches.text6Hours")}</option>
            <option value="12">{t("matches.text12Hours")}</option>
            <option value="24">{t("matches.text24Hours")}</option>
          </select>
        </Field>
      </div>
      <div className="stack" style={{ gap: 6, marginTop: 10 }}>
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
  const A = teamA?.name ?? t("matches.teamA");
  const B = teamB?.name ?? t("matches.teamB");
  const teamIdOf = (actor: "A" | "B" | null) => (actor === "A" ? match.teamAId : actor === "B" ? match.teamBId : null);
  return (
    <Async state={veto} empty={null}>
      {(v) => {
        const cur = v.currentStep;
        const decided = (order: number) => v.decisions.find((d) => d.stepOrder === order);
        const act = (body: Record<string, unknown>) => api.post(`/api/v1/veto/${seg(match.id)}/act`, { stepOrder: cur!.order, teamId: teamIdOf(cur!.actor), ...body });
        const reviseTarget = v.decisions.find((d) => String(d.stepOrder) === reviseStep);
        const seq = parseJsonOr<{ steps: VetoStep[] } | VetoStep[]>(seqText, []);
        return (
          <div className="stack">
            {match.mapPool.length < match.format.bestOf ? <Note tone="warn">{t("matches.theMapPoolCountIs", { count: match.mapPool.length, bestOf: match.format.bestOf })}</Note> : null}
            <Panel title={t("matches.veto")} subtitle={t("matches.boBestofCountMapsIn", { bestOf: match.format.bestOf, count: match.mapPool.length, v: v.complete ? t("matches.completeLower") : t("matches.stepOrderOfCount", { order: cur?.order, count: v.steps.length }) })}>
              <ol className="veto-steps">
                {v.steps.map((s) => {
                  const d = decided(s.order);
                  const isCur = cur?.order === s.order;
                  return (
                    <li key={s.order} className={`veto-step ${isCur ? "is-current" : ""} ${d ? "is-done" : ""}`} aria-current={isCur ? "step" : undefined}>
                      <div className="row">
                        <span className="muted mono">{s.order}</span>
                        <span className={`veto-kind k-${s.kind}`}>{VETO_KIND_LABEL[s.kind]}</span>
                      </div>
                      <div className="small">{stepActorName(s, A, B)}</div>
                      <div>{d ? <strong>{d.mapName ?? d.side ?? "—"}</strong> : <span className="muted small">{isCur ? t("matches.now") : t("matches.pending")}</span>}</div>
                    </li>
                  );
                })}
              </ol>
              {cur ? (
                <div style={{ marginTop: 14 }}>
                  <h3>{t("matches.stepOrderVetoKindLabel", { order: cur.order, VETO_KIND_LABEL: VETO_KIND_LABEL[cur.kind], cur: stepActorName(cur, A, B) })}</h3>
                  {cur.kind === "ban" || cur.kind === "pick" ? (
                    <div className="map-buttons" style={{ marginTop: 8 }}>
                      {v.remainingMaps.map((m) => (
                        <ActionButton key={m} variant={cur.kind === "ban" ? "danger" : "primary"} action={() => act({ mapName: m })} success={`${stepActorName(cur, A, B)} ${cur.kind === "ban" ? "banned" : "picked"} ${m}`} onDone={() => void veto.reload()} disabledReason={reason}>
                          {cur.kind === "ban" ? t("matches.ban") : t("matches.pick")} {m}
                        </ActionButton>
                      ))}
                    </div>
                  ) : null}
                  {cur.kind === "side_choice" ? (
                    <div className="row" style={{ marginTop: 8 }}>
                      {(["CT", "T"] as const).map((sd) => (
                        <ActionButton key={sd} variant="primary" action={() => act({ side: sd })} success={t("matches.curChoseSd", { cur: stepActorName(cur, A, B), sd })} onDone={() => void veto.reload()} disabledReason={reason}>{t("matches.startSd", { sd })}</ActionButton>
                      ))}
                      <span className="small muted">{t("matches.onV", { v: v.pickedMaps[v.pickedMaps.length - 1]?.mapName ?? t("matches.theLastPickedMap") })}</span>
                    </div>
                  ) : null}
                  {cur.kind === "decider" ? (
                    <div style={{ marginTop: 8 }}>
                      <ActionButton variant="primary" action={() => act({})} success={t("matches.deciderLocked")} onDone={() => void veto.reload()} disabledReason={reason ?? (v.remainingMaps.length === 1 ? null : t("matches.deciderNeedsExactlyOneRemaining", { count: v.remainingMaps.length }))}>{t("matches.lockDeciderJoin", { join: v.remainingMaps.join(", ") })}</ActionButton>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <section className="ga-section">
                <h3 className="ga-section-title">{t("matches.result")}</h3>
                {v.pickedMaps.length === 0 ? (
                  <p className="muted">{t("matches.noMapsPickedYet")}</p>
                ) : (
                  <ol style={{ margin: 0, paddingLeft: 20 }}>
                    {v.pickedMaps.map((p) => (
                      <li key={p.mapName}>
                        <strong>{p.mapName}</strong> — {p.decider ? t("matches.decider2") : t("matches.pickedByV", { v: p.pickedBy === "A" ? A : B })}
                        {p.startingSide ? t("matches.vStartSide", { v: p.startingSide.team === "A" ? A : B, side: p.startingSide.side }) : ""}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="ga-actions">
                  <ActionButton variant="primary" action={() => api.post<{ maps: unknown[] }>(`/api/v1/veto/${seg(match.id)}/apply-to-maps`)} success={(r) => t("matches.countMapSWrittenTo", { count: r.maps.length })} onDone={onMapsChanged} disabledReason={reason ?? (v.complete ? null : t("matches.finishTheVetoFirst"))} confirm={{ title: t("matches.applyVetoResultToThe"), body: t("matches.theCaptainDecisionsBecomeThe") }}>{t("matches.applyToMatchMaps")}</ActionButton>
                  <ActionButton
                    variant="ghost"
                    action={(why) => api.post(`/api/v1/veto/${seg(match.id)}/reset`, { reason: why })}
                    success={t("matches.vetoReset")}
                    onDone={() => void veto.reload()}
                    disabledReason={reason ?? (v.decisions.length ? null : t("matches.nothingToReset"))}
                    confirm={{ title: t("matches.resetTheVeto"), body: t("matches.deletesAllVetoDecisionsFor"), reasonLabel: t("matches.reason"), danger: true, confirmLabel: t("matches.resetVeto2") }}
                  >{t("matches.resetVeto")}</ActionButton>
                </div>
              </section>
              <Details summary={t("matches.reviseADecision")} className="ga-section">
                <p className="small muted">{t("matches.anAuditedCorrectionTheOriginal")}</p>
                <div className="row-end">
                  <Field label={t("matches.step")}>
                    <select value={reviseStep} onChange={(e) => setReviseStep(e.target.value)}>
                      <option value="">{t("matches.choose")}</option>
                      {v.decisions.map((d) => (
                        <option key={d.id} value={d.stepOrder}>
                          {d.stepOrder} · {VETO_KIND_LABEL[d.kind]} · {d.mapName ?? d.side}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {reviseTarget && reviseTarget.kind !== "side_choice" ? (
                    <Field label={t("matches.newMap")}>
                      <select value={reviseMap} onChange={(e) => setReviseMap(e.target.value)}>
                        <option value="">{t("matches.choose")}</option>
                        {match.mapPool.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                  {reviseTarget?.kind === "side_choice" ? (
                    <Field label={t("matches.newSide")}>
                      <select value={reviseSide} onChange={(e) => setReviseSide(e.target.value as Side | "")}>
                        <option value="">{t("matches.choose")}</option>
                        <option value="CT">CT</option>
                        <option value="T">T</option>
                      </select>
                    </Field>
                  ) : null}
                  <ActionButton
                    action={(why) => api.post(`/api/v1/veto/${seg(match.id)}/revise`, { stepOrder: Number(reviseStep), teamId: reviseTarget!.teamId, mapName: reviseTarget!.kind === "side_choice" ? null : reviseMap, side: reviseTarget!.kind === "side_choice" ? reviseSide : null, reason: why })}
                    success={t("matches.decisionRevised")}
                    onDone={() => void veto.reload()}
                    disabledReason={reason ?? (!reviseTarget ? t("matches.chooseADecidedStep") : reviseTarget.kind === "side_choice" ? (reviseSide ? null : t("matches.chooseASide")) : reviseMap ? null : t("matches.chooseAMap"))}
                    confirm={{ title: t("matches.reviseStepRevisestep", { reviseStep }), reasonLabel: t("matches.reasonAudited"), confirmLabel: t("matches.revise2") }}
                  >{t("matches.revise")}</ActionButton>
                </div>
              </Details>
              <Details summary={t("matches.historyV", { v: v.history.length ? ` (${v.history.length})` : "" })}>
                {v.history.length === 0 ? (
                  <p className="muted small">{t("matches.noDecisionsYet")}</p>
                ) : (
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>{t("matches.step")}</th>
                        <th>{t("matches.action")}</th>
                        <th>{t("matches.team")}</th>
                        <th>{t("matches.decision")}</th>
                        <th>{t("matches.by")}</th>
                        <th>{t("matches.at")}</th>
                        <th>{t("matches.status")}</th>
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
                          <td className={`small ${d.supersededBy ? "text-warn" : "muted"}`}>
                            {d.supersededBy ? t("matches.superseded") : t("matches.active")}
                            {d.revisionOf ? t("matches.revision") : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Details>
              <Details summary={t("matches.customSequence")}>
                <p className="small muted">{t("matches.onlyBeforeTheFirstDecision")}</p>
                {!seqText ? (
                  <Button size="sm" onClick={() => setSeqText(JSON.stringify(v.steps, null, 2))}>{t("matches.editSequenceAsJson")}</Button>
                ) : (
                  <>
                    <JsonEditor label={t("matches.stepsOrderKindBanPick")} value={seqText} onChange={setSeqText} rows={10} />
                    <div className="form-actions">
                      <ActionButton
                        action={() => {
                          if (!seq.ok) throw new Error(seq.error);
                          const steps = Array.isArray(seq.value) ? seq.value : seq.value.steps;
                          return api.put(`/api/v1/veto/${seg(match.id)}/sequence`, { steps });
                        }}
                        success={t("matches.vetoSequenceSaved")}
                        onDone={() => {
                          setSeqText("");
                          void veto.reload();
                        }}
                        disabledReason={reason ?? (v.decisions.length ? t("matches.theVetoHasStartedReset") : seq.ok ? null : t("matches.invalidJson"))}
                      >{t("matches.saveSequence")}</ActionButton>
                      <Button variant="ghost" onClick={() => setSeqText("")}>{t("common.cancel")}</Button>
                    </div>
                  </>
                )}
              </Details>
            </Panel>
            <Panel title={t("matches.captainLinks")} subtitle={t("matches.scopedToThisMatchAnd")}>
              <CaptainLinks match={match} teamA={teamA} teamB={teamB} />
            </Panel>
          </div>
        );
      }}
    </Async>
  );
}
