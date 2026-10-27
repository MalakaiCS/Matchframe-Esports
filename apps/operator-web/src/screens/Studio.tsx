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

const KINDS: RundownCue["kind"][] = ["intro", "caster_card", "match_preview", "veto", "live_match", "break", "highlights", "results", "closing", "custom"];

/** Program mode a rundown cue puts on air. */
export function programModeForCue(kind: RundownCue["kind"]): "LIVE" | "BREAK" | "STUDIO" {
  if (kind === "live_match") return "LIVE";
  if (kind === "break") return "BREAK";
  return "STUDIO";
}

/** "REPLAY_PREPARED" → "replay prepared". */
function modeWord(s: string): string {
  return s.replace(/_/g, " ").toLowerCase();
}

/** "caster_card" → "Caster card". */
function sentence(s: string): string {
  const t = modeWord(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
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
        <Field label="Title">
          <input value={d.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Kind" hint={`Takes program to ${modeWord(programModeForCue(d.kind))}`}>
          <select value={d.kind} onChange={(e) => set({ kind: e.target.value as RundownCue["kind"] })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {sentence(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Duration (s)">
          <input type="number" min={0} value={d.durationSec ?? ""} onChange={(e) => set({ durationSec: e.target.value === "" ? null : Number(e.target.value) })} />
        </Field>
        <Field label="HUD variant">
          <select value={d.hudVariant ?? ""} onChange={(e) => set({ hudVariant: e.target.value || null })}>
            <option value="">None</option>
            {HUD_VARIANTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="OBS scene">
          <input list="rundown-scenes" value={d.obsScene ?? ""} onChange={(e) => set({ obsScene: e.target.value || null })} />
          <datalist id="rundown-scenes">
            {scenes.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Automation">
          <select value={d.automation} onChange={(e) => set({ automation: e.target.value as RundownCue["automation"] })}>
            <option value="manual">Manual take</option>
            <option value="auto_next">Auto-advance next after take</option>
          </select>
        </Field>
      </div>
      <Field label="Notes" hint="Shown as the HUD cue subtitle" className="mt">
        <input value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <div className="form-actions">
        <Checkbox checked={d.ready} onChange={(v) => set({ ready: v })} label="Ready" />
        <ActionButton variant="primary" action={() => onSubmit(d)} success={`${submitLabel}: ${d.title}`} onDone={() => setD(EMPTY)} disabledReason={reason ?? (d.title.trim() ? null : "Enter a title")}>
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
    if (!c) throw new Error("No next cue");
    const steps: string[] = [];
    const mode = programModeForCue(c.kind);
    const current = program.data?.mode as ProgramMode | undefined;
    if (mode === "LIVE") {
      if (current !== "LIVE") {
        const t = await api.post<ProgramTransition>("/api/v1/program/return-live");
        steps.push(`program → ${modeWord(t.to)}${t.confirmed ? "" : " (not confirmed by mixer)"}`);
      } else steps.push("program already live");
    } else {
      const t = await api.post<ProgramTransition>("/api/v1/program/cues", { mode });
      steps.push(`program → ${modeWord(t.to)}${t.confirmed ? "" : " (not confirmed by mixer)"}${t.detail ? `: ${t.detail}` : ""}`);
    }
    if (c.obsScene && obs.data?.state.connected) {
      const r = await api.post<{ confirmed: boolean }>("/api/v1/obs/program", { scene: c.obsScene });
      steps.push(`OBS scene ${c.obsScene}${r.confirmed ? "" : " (not confirmed)"}`);
    }
    if (c.kind !== "live_match") {
      await api.post("/api/v1/hud/cues", { kind: c.kind, title: c.title, subtitle: c.notes || null, durationMs: c.durationSec ? c.durationSec * 1000 : null, data: { rundownCueId: c.id, hudVariant: c.hudVariant } });
      steps.push("HUD cue shown");
    }
    await savePosition({ onAir: c.id, next: after(c.id) });
    return `${c.title} on air: ${steps.join(" · ")}`;
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
      toast.push("danger", "Reorder failed", String(e instanceof Error ? e.message : e));
    }
  };

  const nextMode = nextCue ? programModeForCue(nextCue.kind) : null;
  const unmapped = nextMode && nextMode !== "LIVE" && program.data && !program.data.scenes[nextMode] ? nextMode : null;
  const takeReason =
    programReason ??
    hudReason ??
    settingsReason ??
    (!nextCue ? "No next cue: add cues or press Next" : !nextCue.ready ? `“${nextCue.title}” is not marked ready` : unmapped ? `No OBS scene is mapped for ${modeWord(unmapped)}: map it in Setup → Program scene mapping` : null);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Studio &amp; Rundown</h1>
      </div>
      <div className="grid-2-1">
        <div className="stack">
          <Panel
            title="Rundown"
            subtitle="Take puts the next cue on air (program mode and HUD cue)"
            actions={
              <>
                <ActionButton action={() => savePosition({ onAir: position.onAir, next: after(position.next) })} success="Next cue advanced" disabledReason={settingsReason ?? (list.length ? null : "No cues")}>
                  Next ▸
                </ActionButton>
                <ActionButton variant="primary" size="lg" action={take} success={(m) => m} disabledReason={takeReason}>
                  Take
                </ActionButton>
              </>
            }
          >
            <Async state={cues}>
              {() =>
                list.length === 0 ? (
                  <EmptyState title="Empty rundown">Add the show's segments below, mark them ready, then use Next and Take.</EmptyState>
                ) : (
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Cue</th>
                        <th>Kind</th>
                        <th>Duration</th>
                        <th>HUD / OBS</th>
                        <th>Ready</th>
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
                                submitLabel="Save cue"
                                onSubmit={async (d) => {
                                  await api.patch(`/api/v1/rundown/${seg(c.id)}`, d);
                                  setEditing(null);
                                  await cues.reload();
                                }}
                              />
                              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                            </td>
                          </tr>
                        ) : (
                          <tr key={c.id} className={c.id === position.next ? "is-selected" : ""}>
                            <td>{i + 1}</td>
                            <td>
                              <strong>{c.title}</strong> {c.id === position.onAir ? <Badge tone="danger" icon="●">On air</Badge> : null} {c.id === position.next ? <Badge tone="accent">Next</Badge> : null}
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
                                      .catch((err) => toast.push("danger", "Update failed", String(err)))
                                  }
                                />
                                {c.ready ? "Ready" : "Not ready"}
                              </label>
                            </td>
                            <td>
                              <div className="cell-actions">
                                <ActionButton size="sm" action={() => savePosition({ onAir: position.onAir, next: c.id })} success={`Next: ${c.title}`} disabledReason={settingsReason}>
                                  Set next
                                </ActionButton>
                                <Button size="sm" variant="ghost" onClick={() => setEditing(c.id)} disabledReason={writeReason}>
                                  Edit
                                </Button>
                                <Button size="sm" variant="ghost" aria-label={`Move ${c.title} up`} disabled={i === 0 || !!writeReason} onClick={() => void move(c, -1)}>
                                  ↑
                                </Button>
                                <Button size="sm" variant="ghost" aria-label={`Move ${c.title} down`} disabled={i === list.length - 1 || !!writeReason} onClick={() => void move(c, 1)}>
                                  ↓
                                </Button>
                                <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/rundown/${seg(c.id)}`)} success="Cue deleted" onDone={() => void cues.reload()} disabledReason={writeReason} confirm={{ title: `Delete cue “${c.title}”?`, danger: true, confirmLabel: "Delete" }}>
                                  Delete
                                </ActionButton>
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
          <Panel title="Add cue">
            <CueForm
              initial={EMPTY}
              scenes={scenes}
              submitLabel="Add cue"
              onSubmit={async (d) => {
                await api.post("/api/v1/rundown", { ...d, order: (list[list.length - 1]?.order ?? 0) + 1 });
                await cues.reload();
              }}
            />
          </Panel>
        </div>
        <Panel title="Program" className="gb-start" actions={program.data ? <Badge tone={program.data.mode === "LIVE" ? "ok" : program.data.mode === "DEGRADED" ? "danger" : "info"}>{program.data.mode.replace("_", " ")}</Badge> : null}>
          <Async state={program}>
            {(p) => (
              <>
                <ul className="status-list">
                  <li>
                    <span className="muted">On air</span>
                    <span>{onAirCue ? onAirCue.title : MISSING}</span>
                  </li>
                  <li>
                    <span className="muted">Next</span>
                    <span>{nextCue ? `${nextCue.title}${nextCue.ready ? "" : " (not ready)"}` : MISSING}</span>
                  </li>
                </ul>
                <div className="row" style={{ marginTop: 12 }}>
                  <ActionButton action={() => api.post<ProgramTransition>("/api/v1/program/cues", { mode: "STUDIO" })} success={(t) => `Program → ${modeWord(t.to)}`} onDone={() => void program.reload()} disabledReason={programReason ?? (p.scenes.STUDIO ? null : "Map a studio scene in Setup first")}>
                    Studio
                  </ActionButton>
                  <ActionButton action={() => api.post<ProgramTransition>("/api/v1/program/cues", { mode: "BREAK" })} success={(t) => `Program → ${modeWord(t.to)}`} onDone={() => void program.reload()} disabledReason={programReason ?? (p.scenes.BREAK ? null : "Map a break scene in Setup first")}>
                    Break
                  </ActionButton>
                  <ActionButton variant="primary" action={() => api.post<ProgramTransition>("/api/v1/program/return-live")} success={(t) => `Program → ${modeWord(t.to)}${t.detail ? ` (${t.detail})` : ""}`} onDone={() => void program.reload()} disabledReason={programReason ?? (p.mode === "LIVE" ? "Already live" : null)}>
                    Return live
                  </ActionButton>
                </div>
                {!p.scenes.STUDIO || !p.scenes.BREAK ? (
                  <p className="small text-warn">
                    Studio and Break only switch when an OBS scene is mapped for them. <Link to="/setup#step-scenes">Map scenes in Setup</Link>
                  </p>
                ) : null}
                <Details summary="Scenes and owner">
                  <KV
                    items={[
                      ["Owner", `${p.owner.kind} (${p.owner.holder})`],
                      ["Live", p.scenes.LIVE ?? MISSING],
                      ["Studio", p.scenes.STUDIO ?? MISSING],
                      ["Break", p.scenes.BREAK ?? MISSING],
                      ["Replay", p.scenes.REPLAY ?? MISSING],
                    ]}
                  />
                </Details>
                <Details summary="Recent transitions">
                  <ul className="list-plain small">
                    {p.history
                      .slice(-8)
                      .reverse()
                      .map((t, i) => (
                        <li key={i}>
                          {fmtTime(t.at)} · {sentence(t.from)} → <strong>{sentence(t.to)}</strong> · {t.owner} {t.confirmed ? "" : <Badge tone="warn">Unconfirmed</Badge>} {t.detail ? <span className="muted">({t.detail})</span> : null}
                        </li>
                      ))}
                    {p.history.length === 0 ? <li className="muted">No transitions yet.</li> : null}
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
