import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { ObsState, ProgramMode, ProgramState, ProgramTransition, RundownCue } from "../api/types.ts";
import { useToast } from "../components/toasts.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, Details, EmptyState, Field, KV, Panel } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import "../styles/group-b.css";
import { HUD_VARIANTS } from "./huds/Outputs.tsx";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";

const KINDS: RundownCue["kind"][] = ["intro", "caster_card", "match_preview", "veto", "live_match", "break", "highlights", "results", "closing", "custom"];

/** Program mode a rundown cue puts on air. */
export function programModeForCue(kind: RundownCue["kind"]): "LIVE" | "BREAK" | "STUDIO" {
  if (kind === "live_match") return "LIVE";
  if (kind === "break") return "BREAK";
  return "STUDIO";
}

/** A program mode in words ("REPLAY_PREPARED" → "Replay prepared"). */
function modeWord(s: string): string {
  const key = `shell.programMode.${s}`;
  const w = t(key);
  return w === key ? s.replace(/_/g, " ").toLowerCase() : w;
}

/** A cue kind ("caster_card" → "Caster card"), or a program mode, in words. */
function sentence(s: string): string {
  const key = `studio.cueKind.${s}`;
  const w = t(key);
  return w === key ? modeWord(s) : w;
}

interface Position {
  onAir: string | null;
  next: string | null;
}

type CueDraft = Omit<RundownCue, "id" | "order">;
const EMPTY: CueDraft = { title: "", kind: "custom", durationSec: null, hudVariant: null, obsScene: null, notes: "", automation: "manual", ready: false };

function CueForm({ initial, onSubmit, submitLabel, scenes }: { initial: CueDraft; onSubmit: (d: CueDraft) => Promise<unknown>; submitLabel: string; scenes: string[] }) {
  const reason = usePermission("metadata.write");
  const [d, setD] = useState<CueDraft>(initial);
  const set = (p: Partial<CueDraft>) => setD({ ...d, ...p });
  return (
    <>
      <div className="form-grid">
        <Field label={t("studio.title")}>
          <input value={d.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label={t("studio.kind")} hint={t("studio.takesProgramToModeword", { modeWord: modeWord(programModeForCue(d.kind)) })}>
          <select value={d.kind} onChange={(e) => set({ kind: e.target.value as RundownCue["kind"] })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {sentence(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("studio.durationS")}>
          <input type="number" min={0} value={d.durationSec ?? ""} onChange={(e) => set({ durationSec: e.target.value === "" ? null : Number(e.target.value) })} />
        </Field>
        <Field label={t("studio.hudVariant")}>
          <select value={d.hudVariant ?? ""} onChange={(e) => set({ hudVariant: e.target.value || null })}>
            <option value="">{t("studio.none")}</option>
            {HUD_VARIANTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("studio.obsScene")}>
          <input list="rundown-scenes" value={d.obsScene ?? ""} onChange={(e) => set({ obsScene: e.target.value || null })} />
          <datalist id="rundown-scenes">
            {scenes.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label={t("studio.automation")}>
          <select value={d.automation} onChange={(e) => set({ automation: e.target.value as RundownCue["automation"] })}>
            <option value="manual">{t("studio.manualTake")}</option>
            <option value="auto_next">{t("studio.autoAdvanceNextAfterTake")}</option>
          </select>
        </Field>
      </div>
      <Field label={t("studio.notes")} hint={t("studio.shownAsTheHudCue")} className="mt">
        <input value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <div className="form-actions">
        <Checkbox checked={d.ready} onChange={(v) => set({ ready: v })} label={t("studio.ready")} />
        <ActionButton variant="primary" action={() => onSubmit(d)} success={`${submitLabel}: ${d.title}`} onDone={() => setD(EMPTY)} disabledReason={reason ?? (d.title.trim() ? null : t("studio.enterATitle"))}>
          {submitLabel}
        </ActionButton>
      </div>
    </>
  );
}

export function StudioScreen() {
  const toast = useToast();
  const cues = useApi<RundownCue[]>("/api/v1/rundown");
  const program = useApi<ProgramState>("/api/v1/program", { refreshMs: 2000 });
  const pos = useApi<{ value: Position | null }>("/api/v1/settings/ui.rundownPosition");
  const obs = useApi<{ state: ObsState }>("/api/v1/obs");
  const writeReason = usePermission("metadata.write");
  const programReason = usePermission("program.control");
  const hudReason = usePermission("hud.publish");
  const settingsReason = usePermission("settings.manage");
  const [editing, setEditing] = useState<string | null>(null);
  const list = [...(cues.data ?? [])].sort((a, b) => a.order - b.order);
  const position: Position = pos.data?.value ?? { onAir: null, next: list[0]?.id ?? null };
  const nextCue = list.find((c) => c.id === position.next) ?? null;
  const onAirCue = list.find((c) => c.id === position.onAir) ?? null;
  const scenes = obs.data?.state.scenes ?? [];

  const savePosition = (p: Position) => api.put("/api/v1/settings/ui.rundownPosition", { value: p }).then(() => pos.reload());
  const after = (id: string | null) => {
    const i = list.findIndex((c) => c.id === id);
    return i >= 0 ? (list[i + 1]?.id ?? null) : (list[0]?.id ?? null);
  };

  const take = async () => {
    const c = nextCue;
    if (!c) throw new Error(t("studio.noNextCue"));
    const steps: string[] = [];
    const mode = programModeForCue(c.kind);
    const current = program.data?.mode as ProgramMode | undefined;
    if (mode === "LIVE") {
      if (current !== "LIVE") {
        const tRow = await api.post<ProgramTransition>("/api/v1/program/return-live");
        steps.push(`${t("studio.programTo", { mode: modeWord(tRow.to) })}${tRow.confirmed ? "" : t("studio.notConfirmedByMixer")}`);
      } else steps.push(t("studio.programAlreadyLive"));
    } else {
      const tRow = await api.post<ProgramTransition>("/api/v1/program/cues", { mode });
      steps.push(`${t("studio.programTo", { mode: modeWord(tRow.to) })}${tRow.confirmed ? "" : t("studio.notConfirmedByMixer")}${tRow.detail ? `: ${tRow.detail}` : ""}`);
    }
    if (c.obsScene && obs.data?.state.connected) {
      const r = await api.post<{ confirmed: boolean }>("/api/v1/obs/program", { scene: c.obsScene });
      steps.push(t("studio.obsSceneObssceneV", { obsScene: c.obsScene, v: r.confirmed ? "" : t("studio.notConfirmed") }));
    }
    if (c.kind !== "live_match") {
      await api.post("/api/v1/hud/cues", { kind: c.kind, title: c.title, subtitle: c.notes || null, durationMs: c.durationSec ? c.durationSec * 1000 : null, data: { rundownCueId: c.id, hudVariant: c.hudVariant } });
      steps.push(t("studio.hudCueShown"));
    }
    await savePosition({ onAir: c.id, next: after(c.id) });
    return t("studio.titleOnAirJoin", { title: c.title, join: steps.join(" · ") });
  };

  const move = async (c: RundownCue, dir: -1 | 1) => {
    const i = list.findIndex((x) => x.id === c.id);
    const other = list[i + dir];
    if (!other) return;
    try {
      // One atomic request: the engine rewrites every cue's order in a single transaction.
      const ids = list.map((x) => x.id);
      [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
      await api.post("/api/v1/rundown/reorder", { ids });
      await cues.reload();
    } catch (e) {
      toast.push("danger", t("studio.reorderFailed"), String(e instanceof Error ? e.message : e));
    }
  };

  const nextMode = nextCue ? programModeForCue(nextCue.kind) : null;
  const unmapped = nextMode && nextMode !== "LIVE" && program.data && !program.data.scenes[nextMode] ? nextMode : null;
  const takeReason =
    programReason ??
    hudReason ??
    settingsReason ??
    (!nextCue ? t("studio.noNextCueAddCues") : !nextCue.ready ? t("studio.titleIsNotMarkedReady", { title: nextCue.title }) : unmapped ? t("studio.noObsSceneIsMapped", { unmapped: modeWord(unmapped) }) : null);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("studio.studioRundown")}</h1>
      </div>
      <div className="grid-2-1">
        <div className="stack">
          <Panel
            title={t("studio.rundown")}
            subtitle={t("studio.takePutsTheNextCue")}
            actions={
              <>
                <ActionButton action={() => savePosition({ onAir: position.onAir, next: after(position.next) })} success={t("studio.nextCueAdvanced")} disabledReason={settingsReason ?? (list.length ? null : t("studio.noCues"))}>{t("studio.next2")}</ActionButton>
                <ActionButton variant="primary" size="lg" action={take} success={(m) => m} disabledReason={takeReason}>{t("studio.take")}</ActionButton>
              </>
            }
          >
            <Async state={cues}>
              {() =>
                list.length === 0 ? (
                  <EmptyState title={t("studio.emptyRundown")}>{t("studio.addTheShowSSegments")}</EmptyState>
                ) : (
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>{t("studio.cue")}</th>
                        <th>{t("studio.kind")}</th>
                        <th>{t("studio.duration")}</th>
                        <th>HUD / OBS</th>
                        <th>{t("studio.ready")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((c, i) =>
                        editing === c.id ? (
                          <tr key={c.id}>
                            <td colSpan={7}>
                              <CueForm
                                initial={c}
                                scenes={scenes}
                                submitLabel={t("studio.saveCue")}
                                onSubmit={async (d) => {
                                  await api.patch(`/api/v1/rundown/${seg(c.id)}`, d);
                                  setEditing(null);
                                  await cues.reload();
                                }}
                              />
                              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
                            </td>
                          </tr>
                        ) : (
                          <tr key={c.id} className={c.id === position.next ? "is-selected" : ""}>
                            <td>{i + 1}</td>
                            <td>
                              <strong>{c.title}</strong> {c.id === position.onAir ? <Badge tone="danger" icon="●">{t("studio.onAir")}</Badge> : null} {c.id === position.next ? <Badge tone="accent">{t("studio.next")}</Badge> : null}
                              {c.notes ? <div className="small muted">{c.notes}</div> : null}
                            </td>
                            <td className="small">
                              {sentence(c.kind)}
                              <div className="muted">→ {modeWord(programModeForCue(c.kind))}</div>
                            </td>
                            <td>{c.durationSec !== null ? `${c.durationSec}s` : MISSING}</td>
                            <td className="small">
                              {c.hudVariant || c.obsScene ? `${c.hudVariant ?? MISSING} / ${c.obsScene ?? MISSING}` : MISSING}
                              {c.automation === "auto_next" ? <div className="muted">auto-advance</div> : null}
                            </td>
                            <td>
                              <label className="check gb-nowrap">
                                <input
                                  type="checkbox"
                                  checked={c.ready}
                                  disabled={!!writeReason}
                                  onChange={(e) =>
                                    void api
                                      .patch(`/api/v1/rundown/${seg(c.id)}`, { ready: e.target.checked })
                                      .then(() => cues.reload())
                                      .catch((err) => toast.push("danger", t("studio.updateFailed"), String(err)))
                                  }
                                />
                                {c.ready ? t("studio.ready") : t("studio.notReady2")}
                              </label>
                            </td>
                            <td>
                              <div className="cell-actions">
                                <ActionButton size="sm" action={() => savePosition({ onAir: position.onAir, next: c.id })} success={t("studio.nextTitle", { title: c.title })} disabledReason={settingsReason}>{t("studio.setNext")}</ActionButton>
                                <Button size="sm" variant="ghost" onClick={() => setEditing(c.id)} disabledReason={writeReason}>{t("studio.edit")}</Button>
                                <Button size="sm" variant="ghost" aria-label={t("studio.moveTitleUp", { title: c.title })} disabled={i === 0 || !!writeReason} onClick={() => void move(c, -1)}>
                                  ↑
                                </Button>
                                <Button size="sm" variant="ghost" aria-label={t("studio.moveTitleDown", { title: c.title })} disabled={i === list.length - 1 || !!writeReason} onClick={() => void move(c, 1)}>
                                  ↓
                                </Button>
                                <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/rundown/${seg(c.id)}`)} success={t("studio.cueDeleted")} onDone={() => void cues.reload()} disabledReason={writeReason} confirm={{ title: t("studio.deleteCueTitle", { title: c.title }), danger: true, confirmLabel: t("studio.delete") }}>{t("studio.delete")}</ActionButton>
                              </div>
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                )
              }
            </Async>
          </Panel>
          <Panel title={t("studio.addCue")}>
            <CueForm
              initial={EMPTY}
              scenes={scenes}
              submitLabel={t("studio.addCue")}
              onSubmit={async (d) => {
                await api.post("/api/v1/rundown", { ...d, order: (list[list.length - 1]?.order ?? 0) + 1 });
                await cues.reload();
              }}
            />
          </Panel>
        </div>
        <Panel title={t("studio.program")} className="gb-start" actions={program.data ? <Badge tone={program.data.mode === "LIVE" ? "ok" : program.data.mode === "DEGRADED" ? "danger" : "info"}>{program.data.mode.replace("_", " ")}</Badge> : null}>
          <Async state={program}>
            {(p) => (
              <>
                <ul className="status-list">
                  <li>
                    <span className="muted">{t("studio.onAir")}</span>
                    <span>{onAirCue ? onAirCue.title : MISSING}</span>
                  </li>
                  <li>
                    <span className="muted">{t("studio.next")}</span>
                    <span>{nextCue ? `${nextCue.title}${nextCue.ready ? "" : t("studio.notReady")}` : MISSING}</span>
                  </li>
                </ul>
                <div className="row" style={{ marginTop: 12 }}>
                  <ActionButton action={() => api.post<ProgramTransition>("/api/v1/program/cues", { mode: "STUDIO" })} success={(tRow) => t("live.programTo", { to: modeWord(tRow.to) })} onDone={() => void program.reload()} disabledReason={programReason ?? (p.scenes.STUDIO ? null : t("studio.mapAStudioSceneIn"))}>{t("studio.studio")}</ActionButton>
                  <ActionButton action={() => api.post<ProgramTransition>("/api/v1/program/cues", { mode: "BREAK" })} success={(tRow) => t("live.programTo", { to: modeWord(tRow.to) })} onDone={() => void program.reload()} disabledReason={programReason ?? (p.scenes.BREAK ? null : t("studio.mapABreakSceneIn"))}>{t("studio.break")}</ActionButton>
                  <ActionButton variant="primary" action={() => api.post<ProgramTransition>("/api/v1/program/return-live")} success={(tRow) => `${t("live.programTo", { to: modeWord(tRow.to) })}${tRow.detail ? ` (${tRow.detail})` : ""}`} onDone={() => void program.reload()} disabledReason={programReason ?? (p.mode === "LIVE" ? t("studio.alreadyLive") : null)}>{t("studio.returnLive")}</ActionButton>
                </div>
                {!p.scenes.STUDIO || !p.scenes.BREAK ? (
                  <p className="small text-warn"><T k="studio.studioAndBreakOnlySwitch" tags={{ link: (c) => <Link to="/settings/setup#step-scenes">{c}</Link> }} /></p>
                ) : null}
                <Details summary={t("studio.scenesAndOwner")}>
                  <KV
                    items={[
                      [t("studio.owner"), `${p.owner.kind} (${p.owner.holder})`],
                      [t("studio.live"), p.scenes.LIVE ?? MISSING],
                      [t("studio.studio"), p.scenes.STUDIO ?? MISSING],
                      [t("studio.break"), p.scenes.BREAK ?? MISSING],
                      [t("studio.replay"), p.scenes.REPLAY ?? MISSING],
                      [t("studio.highlights"), p.scenes.HIGHLIGHTS ?? MISSING],
                    ]}
                  />
                </Details>
                <Details summary={t("studio.recentTransitions")}>
                  <ul className="list-plain small">
                    {p.history
                      .slice(-8)
                      .reverse()
                      .map((tRow, i) => (
                        <li key={i}>
                          {fmtTime(tRow.at)} · {sentence(tRow.from)} → <strong>{sentence(tRow.to)}</strong> · {tRow.owner} {tRow.confirmed ? "" : <Badge tone="warn">{t("studio.unconfirmed")}</Badge>} {tRow.detail ? <span className="muted">({tRow.detail})</span> : null}
                        </li>
                      ))}
                    {p.history.length === 0 ? <li className="muted">{t("studio.noTransitionsYet")}</li> : null}
                  </ul>
                </Details>
              </>
            )}
          </Async>
        </Panel>
      </div>
    </div>
  );
}
