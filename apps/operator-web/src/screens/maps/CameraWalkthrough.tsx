import { useState } from "react";
import { api } from "../../api/index.ts";
import { ActionButton, Async, Badge, Button, Checkbox, Field, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

export type CameraVerdict = "keep" | "hide";

export interface WalkthroughStatus {
  running: boolean;
  mapName: string | null;
  secondsPer: number;
  index: number;
  cameras: { id: string; displayName: string; verdict: CameraVerdict | null; result: "shown" | "failed" | "pending" | null; detail: string | null }[];
}

export const VERDICT_LABEL: Record<CameraVerdict, string> = { keep: "Kept", hide: "Hidden" };

/** Keep / Hide for one camera (hidden cameras are never used by the director). */
export function VerdictButtons({ mapName, cameraId, verdict, onDone }: { mapName: string; cameraId: string; verdict: CameraVerdict | null; onDone: () => void }) {
  const reason = usePermission("metadata.write");
  const set = (v: CameraVerdict | null) => api.put("/api/v1/cameras/review", { mapName, cameraId, verdict: v });
  return (
    <div className="row">
      <ActionButton size="sm" variant={verdict === "keep" ? "primary" : "ghost"} action={() => set(verdict === "keep" ? null : "keep")} success={null} onDone={onDone} disabledReason={reason} title="Looks good on air">
        Keep
      </ActionButton>
      <ActionButton size="sm" variant={verdict === "hide" ? "danger" : "ghost"} action={() => set(verdict === "hide" ? null : "hide")} success={null} onDone={onDone} disabledReason={reason} title="Never used by the director (a tree in the way, too dark, wrong spot)">
        Hide
      </ActionButton>
    </div>
  );
}

/**
 * The camera walkthrough: every camera of the map being played in CS2, a few seconds each, with
 * Keep / Hide. The built-in checks use CS2's collision shapes, which leave out trees, wires, flags
 * and lighting; this is where those get caught.
 */
export function CameraWalkthroughPanel({ liveMap, onReviewed }: { liveMap: string | null; onReviewed: () => void }) {
  const reason = usePermission("camera.control");
  const saveReason = usePermission("metadata.write");
  const st = useApi<WalkthroughStatus>("/api/v1/cameras/walkthrough", { refreshMs: 1000 });
  const [secondsPer, setSecondsPer] = useState(4);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const post = (path: string, body?: unknown) => api.post<WalkthroughStatus>(`/api/v1/cameras/walkthrough/${path}`, body);
  return (
    <Panel title="Camera walkthrough" subtitle="See every camera in CS2, a few seconds each, and keep or hide it. Add your own from the CS2 view.">
      <Async state={st}>
        {(w) => {
          const cur = w.running ? w.cameras[w.index] : undefined;
          const done = w.cameras.filter((c) => c.verdict).length;
          return (
            <>
              {cur && w.mapName ? (
                <div className="stack">
                  <div className="row">
                    <Badge tone="accent">
                      {w.index + 1} / {w.cameras.length}
                    </Badge>
                    <b>{cur.displayName}</b>
                    {cur.result === "failed" ? <Badge tone="warn">Didn&apos;t move</Badge> : cur.result === "shown" ? <Badge tone="ok">On screen</Badge> : null}
                    {cur.verdict ? <Badge tone={cur.verdict === "keep" ? "ok" : "danger"}>{VERDICT_LABEL[cur.verdict]}</Badge> : null}
                  </div>
                  {cur.result === "failed" && cur.detail ? <p className="small muted">{cur.detail}</p> : null}
                  <div className="form-actions">
                    <ActionButton variant="primary" action={async () => { await api.put("/api/v1/cameras/review", { mapName: w.mapName, cameraId: cur.id, verdict: "keep" }); return post("next"); }} success={null} onDone={() => { void st.reload(); onReviewed(); }} disabledReason={reason}>
                      Keep, next
                    </ActionButton>
                    <ActionButton variant="danger" action={async () => { await api.put("/api/v1/cameras/review", { mapName: w.mapName, cameraId: cur.id, verdict: "hide" }); return post("next"); }} success={null} onDone={() => { void st.reload(); onReviewed(); }} disabledReason={reason}>
                      Hide, next
                    </ActionButton>
                    <Button size="sm" variant="ghost" onClick={() => void post("previous").then(() => st.reload())} disabled={!!reason || w.index === 0}>
                      Previous
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void post("next").then(() => st.reload())} disabled={!!reason}>
                      Skip
                    </Button>
                    <ActionButton size="sm" action={() => post("stop")} success="Walkthrough stopped: back on a player" onDone={() => void st.reload()} disabledReason={reason}>
                      Stop
                    </ActionButton>
                  </div>
                  <p className="small muted">
                    Moves on by itself every {w.secondsPer} s. {done} of {w.cameras.length} have a verdict.
                  </p>
                </div>
              ) : (
                <>
                  {liveMap ? null : <Note tone="info">Load a map or a demo in CS2 (Observer tools launch mode) first: the walkthrough shows the cameras of the map being played.</Note>}
                  {w.cameras.length && !w.running ? (
                    <p className="small muted">
                      Last walkthrough ({w.mapName}): {w.cameras.filter((c) => c.verdict === "keep").length} kept, {w.cameras.filter((c) => c.verdict === "hide").length} hidden, {w.cameras.filter((c) => c.result === "failed").length} didn&apos;t move.
                    </p>
                  ) : null}
                  <div className="row-end">
                    <Field label="Seconds per camera">
                      <select value={secondsPer} onChange={(e) => setSecondsPer(Number(e.target.value))}>
                        {[3, 4, 6, 8].map((n) => (
                          <option key={n} value={n}>
                            {n} s
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Checkbox checked={onlyUnreviewed} onChange={setOnlyUnreviewed} label="Only cameras without a verdict" />
                    <ActionButton variant="primary" action={() => post("start", { secondsPer, onlyUnreviewed })} success={(r) => `Walking through ${r.cameras.length} cameras on ${r.mapName}`} onDone={() => void st.reload()} disabledReason={reason ?? (liveMap ? null : "No map is being played")}>
                      Start walkthrough
                    </ActionButton>
                  </div>
                  <p className="small muted">The Auto Director stands back while it runs; Stop puts the observer back on a player.</p>
                  <div className="row-end">
                    <ActionButton
                      action={() => api.post<{ id: string; displayName: string }>("/api/v1/cameras/capture", {})}
                      success={(c) => `Saved ${c.displayName}: the Auto Director can use it in freeze time and for fights`}
                      onDone={onReviewed}
                      disabledReason={saveReason ?? (liveMap ? null : "No map is being played")}
                      title="Move the free camera in CS2 to a spot you like, then save it"
                    >
                      Save the CS2 view as a camera
                    </ActionButton>
                    <span className="small muted">or press Ctrl+Shift+F11 while CS2 is in front.</span>
                  </div>
                </>
              )}
            </>
          );
        }}
      </Async>
    </Panel>
  );
}
