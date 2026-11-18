import { useState } from "react";
import { api } from "../../api/index.ts";
import { ActionButton, Async, Badge, Button, Checkbox, Field, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { perLocale, t } from "../../i18n/index.ts";
import { fmtSec } from "../../lib/format.ts";

export type CameraVerdict = "keep" | "hide";

export interface WalkthroughStatus {
  running: boolean;
  mapName: string | null;
  secondsPer: number;
  index: number;
  cameras: { id: string; displayName: string; verdict: CameraVerdict | null; result: "shown" | "failed" | "pending" | null; detail: string | null }[];
}

export const VERDICT_LABEL: Record<CameraVerdict, string> = perLocale(() => ({ keep: t("maps.verdict.kept"), hide: t("maps.verdict.hidden") }));

/** Keep / Hide for one camera (hidden cameras are never used by the director). */
export function VerdictButtons({ mapName, cameraId, verdict, onDone }: { mapName: string; cameraId: string; verdict: CameraVerdict | null; onDone: () => void }) {
  const reason = usePermission("metadata.write");
  const set = (v: CameraVerdict | null) => api.put("/api/v1/cameras/review", { mapName, cameraId, verdict: v });
  return (
    <div className="row">
      <ActionButton size="sm" variant={verdict === "keep" ? "primary" : "ghost"} action={() => set(verdict === "keep" ? null : "keep")} success={null} onDone={onDone} disabledReason={reason} title={t("maps.looksGoodOnAir")}>{t("maps.keep")}</ActionButton>
      <ActionButton size="sm" variant={verdict === "hide" ? "danger" : "ghost"} action={() => set(verdict === "hide" ? null : "hide")} success={null} onDone={onDone} disabledReason={reason} title={t("maps.neverUsedByTheDirector")}>{t("maps.hide")}</ActionButton>
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
    <Panel title={t("maps.cameraWalkthrough")} subtitle={t("maps.seeEveryCameraInCs2")}>
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
                    {cur.result === "failed" ? <Badge tone="warn">{t("maps.didnTMove")}</Badge> : cur.result === "shown" ? <Badge tone="ok">{t("maps.onScreen")}</Badge> : null}
                    {cur.verdict ? <Badge tone={cur.verdict === "keep" ? "ok" : "danger"}>{VERDICT_LABEL[cur.verdict]}</Badge> : null}
                  </div>
                  {cur.result === "failed" && cur.detail ? <p className="small muted">{cur.detail}</p> : null}
                  <div className="form-actions">
                    <ActionButton variant="primary" action={async () => { await api.put("/api/v1/cameras/review", { mapName: w.mapName, cameraId: cur.id, verdict: "keep" }); return post("next"); }} success={null} onDone={() => { void st.reload(); onReviewed(); }} disabledReason={reason}>{t("maps.keepNext")}</ActionButton>
                    <ActionButton variant="danger" action={async () => { await api.put("/api/v1/cameras/review", { mapName: w.mapName, cameraId: cur.id, verdict: "hide" }); return post("next"); }} success={null} onDone={() => { void st.reload(); onReviewed(); }} disabledReason={reason}>{t("maps.hideNext")}</ActionButton>
                    <Button size="sm" variant="ghost" onClick={() => void post("previous").then(() => st.reload())} disabled={!!reason || w.index === 0}>{t("maps.previous")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void post("next").then(() => st.reload())} disabled={!!reason}>{t("maps.skip")}</Button>
                    <ActionButton size="sm" action={() => post("stop")} success={t("maps.walkthroughStoppedBackOnA")} onDone={() => void st.reload()} disabledReason={reason}>{t("maps.stop")}</ActionButton>
                  </div>
                  <p className="small muted">{t("maps.movesOnByItselfEvery", { secondsPer: w.secondsPer, done, count: w.cameras.length })}</p>
                </div>
              ) : (
                <>
                  {liveMap ? null : <Note tone="info">{t("maps.loadAMapOrA")}</Note>}
                  {w.cameras.length && !w.running ? (
                    <p className="small muted">{t("maps.lastWalkthroughMapnameCountKept", { mapName: w.mapName, count: w.cameras.filter((c) => c.verdict === "keep").length, count2: w.cameras.filter((c) => c.verdict === "hide").length, count3: w.cameras.filter((c) => c.result === "failed").length })}</p>
                  ) : null}
                  <div className="row-end">
                    <Field label={t("maps.secondsPerCamera")}>
                      <select value={secondsPer} onChange={(e) => setSecondsPer(Number(e.target.value))}>
                        {[3, 4, 6, 8].map((n) => (
                          <option key={n} value={n}>
                            {fmtSec(n)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Checkbox checked={onlyUnreviewed} onChange={setOnlyUnreviewed} label={t("maps.onlyCamerasWithoutAVerdict")} />
                    <ActionButton variant="primary" action={() => post("start", { secondsPer, onlyUnreviewed })} success={(r) => t("maps.walkingThroughCountCamerasOn", { count: r.cameras.length, mapName: r.mapName })} onDone={() => void st.reload()} disabledReason={reason ?? (liveMap ? null : t("maps.noMapIsBeingPlayed"))}>{t("maps.startWalkthrough")}</ActionButton>
                  </div>
                  <p className="small muted">{t("maps.theAutoDirectorStandsBack")}</p>
                  <div className="row-end">
                    <ActionButton
                      action={() => api.post<{ id: string; displayName: string }>("/api/v1/cameras/capture", {})}
                      success={(c) => t("maps.savedDisplaynameTheAutoDirector", { displayName: c.displayName })}
                      onDone={onReviewed}
                      disabledReason={saveReason ?? (liveMap ? null : t("maps.noMapIsBeingPlayed"))}
                      title={t("maps.moveTheFreeCameraIn")}
                    >{t("maps.saveTheCs2ViewAs")}</ActionButton>
                    <span className="small muted">{t("maps.orPressCtrlShiftF11")}</span>
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
