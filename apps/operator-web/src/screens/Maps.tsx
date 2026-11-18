import { useEffect, useRef, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { CameraRecord, CoverageCell, CoverageRow, MapOutline, MapPackDetail, MapSummary } from "../api/types.ts";
import type { Support } from "@matchframe/contracts";
import { ActionButton, Async, Badge, Button, Checkbox, Details, EmptyState, Field, KV, Panel, Tabs } from "../components/ui.tsx";
import { SUPPORT_TEXT } from "../lib/capabilities.ts";
import { fmtTime, GRENADE_TYPE_LABEL, MISSING } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { CameraWalkthroughPanel, VerdictButtons, type CameraVerdict } from "./maps/CameraWalkthrough.tsx";
import { perLocale, t } from "../i18n/index.ts";
import "../styles/group-c.css";

const KIND_COLOR: Record<string, string> = {
  bombsite: "#c2577a",
  entrance: "#4f8fd9",
  choke: "#7e6bd6",
  corridor: "#3f7f9e",
  mid: "#3aa189",
  connector: "#5a74b8",
  spawn: "#6f8a4a",
  rotation: "#8a6fb3",
  retake_route: "#4f9bb0",
  elevated: "#9c7dd8",
  open_area: "#3d8f6e",
  other: "#5d6878",
};

const VALIDATION_TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = { validated: "ok", preview_only: "info", unvalidated: "warn", invalidated: "danger" };

type CameraUse = CameraRecord["actionClasses"][number];
/** What the Observer may use a camera for (its action classes). */
const CAMERA_USES: { id: CameraUse; label: string; hint: string }[] = perLocale(() => ([
  { id: "utility", label: t("maps.nadeCamera"), hint: t("maps.fullActionObserverCatchesGrenades") },
  { id: "tactical", label: t("maps.fightOverview"), hint: t("maps.observerCinematicsBigFightsIn") },
  { id: "bomb", label: t("maps.bomb"), hint: t("maps.observerCinematicsBombDefuseAnd") },
  { id: "establishing", label: t("maps.establishingFreezeTime"), hint: t("maps.observerCinematicsWideShotDuring") },
]));

function UsesPicker({ value, onChange, disabled, label }: { value: CameraUse[]; onChange: (v: CameraUse[]) => void; disabled?: boolean; label: string }) {
  return (
    <fieldset className="uses-picker" aria-label={label}>
      <div className="row">
        {CAMERA_USES.map((u) => (
          <label key={u.id} className="check" title={u.hint}>
            <input type="checkbox" disabled={disabled} checked={value.includes(u.id)} onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((x) => x !== u.id))} />
            {u.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const sameUses = (a: CameraUse[], b: CameraUse[]) => a.length === b.length && a.every((x) => b.includes(x));

export function OutlineCanvas({ outline, highlight }: { outline: MapOutline; highlight?: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const size = 640;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.fillStyle = "#07090c";
    g.fillRect(0, 0, size, size);
    const pad = 12;
    const s = size - pad * 2;
    for (const [u, v, w, ri] of outline.cells) {
      const r = outline.regions[ri];
      g.fillStyle = KIND_COLOR[r?.kind ?? "other"] ?? KIND_COLOR.other!;
      g.globalAlpha = highlight && r?.id !== highlight ? 0.35 : 0.85;
      g.fillRect(pad + u * s, pad + v * s, Math.max(1, w * s), Math.max(1, w * s));
    }
    for (const p of outline.polygons) {
      const r = outline.regions[p.regionIndex];
      g.globalAlpha = highlight && r?.id !== highlight ? 0.35 : 0.75;
      g.fillStyle = KIND_COLOR[r?.kind ?? "other"] ?? KIND_COLOR.other!;
      g.strokeStyle = "#e7ebf2";
      g.beginPath();
      p.points.forEach(([u, v], i) => (i === 0 ? g.moveTo(pad + u * s, pad + v * s) : g.lineTo(pad + u * s, pad + v * s)));
      g.closePath();
      g.fill();
      g.globalAlpha = 0.9;
      g.lineWidth = 1;
      g.stroke();
    }
    g.globalAlpha = 1;
    // Region labels at the centroid of their cells/polygons.
    g.font = "600 11px system-ui, sans-serif";
    g.textAlign = "center";
    outline.regions.forEach((r, ri) => {
      const pts: [number, number][] = [];
      for (const [u, v, w, i] of outline.cells) if (i === ri) pts.push([u + w / 2, v + w / 2]);
      for (const p of outline.polygons) if (p.regionIndex === ri) pts.push(...p.points);
      if (pts.length === 0) return;
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      g.fillStyle = "#000a";
      const label = r.name;
      const tw = g.measureText(label).width;
      g.fillRect(pad + cx * s - tw / 2 - 3, pad + cy * s - 9, tw + 6, 14);
      g.fillStyle = "#fff";
      g.fillText(label, pad + cx * s, pad + cy * s + 2);
    });
  }, [outline, highlight]);
  return (
    <div className="canvas-wrap">
      <canvas ref={ref} role="img" aria-label={t("maps.schematicOutlineWithCountRegions", { count: outline.regions.length })} />
    </div>
  );
}

function CameraAuthoring({ map, regions, onCreated }: { map: string; regions: MapPackDetail["regions"]; onCreated: () => void }) {
  const reason = usePermission("metadata.write");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [getpos, setGetpos] = useState("");
  const [focus, setFocus] = useState("");
  const [radius, setRadius] = useState(600);
  const [targets, setTargets] = useState<string[]>([]);
  const [uses, setUses] = useState<CameraUse[]>(["utility", "tactical"]);
  const parsedFocus = (() => {
    const m = /setpos(?:_exact)?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/i.exec(focus) ?? /^\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*$/.exec(focus);
    return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
  })();
  const getposOk = /setpos(?:_exact)?\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s*;\s*setang\s+-?[\d.]+\s+-?[\d.]+/i.test(getpos);
  const missing = !/^[a-z0-9-]{3,64}$/.test(id) ? t("maps.cameraId364Chars") : !name.trim() ? t("maps.enterADisplayName") : !getposOk ? t("maps.pasteGetpos") : !parsedFocus ? t("maps.enterTheFocusPointAs") : uses.length === 0 ? t("maps.chooseWhatTheCameraIs") : null;
  return (
    <div className="gc-form">
      <div className="form-grid">
        <Field label={t("maps.cameraId")} hint={t("maps.aZ09And")}>
          <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="banana-high" />
        </Field>
        <Field label={t("maps.displayName")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("maps.bananaHigh")} />
        </Field>
        <Field label={t("maps.coverageRadiusUnits")}>
          <input type="number" min={50} max={3000} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </Field>
      </div>
      <Field label={t("maps.cameraGetposOutput")} hint={t("maps.inCs2FlyTheFree")}>
        <textarea className="mono" rows={2} value={getpos} onChange={(e) => setGetpos(e.target.value)} placeholder={t("maps.setpos123455670")} />
      </Field>
      <Field label={t("maps.focusPoint")} hint={parsedFocus ? t("maps.parsedXYZ", { x: parsedFocus.x, y: parsedFocus.y, z: parsedFocus.z }) : t("maps.whereTheCameraLooksType")}>
        <input className="mono" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="1500 -200 32" />
      </Field>
      <Field label={t("maps.usedFor")} hint={t("maps.whichObserverShotsMayUse")}>
        <UsesPicker value={uses} onChange={setUses} label={t("maps.usedFor")} />
      </Field>
      {regions.length ? (
        <fieldset>
          <legend>{t("maps.targetRegions")}</legend>
          <div className="row">
            {regions.map((r) => (
              <label key={r.id} className="check">
                <input type="checkbox" checked={targets.includes(r.id)} onChange={(e) => setTargets(e.target.checked ? [...targets, r.id] : targets.filter((x) => x !== r.id))} />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="form-actions" style={{ marginTop: 0 }}>
        <ActionButton
          variant="primary"
          action={() => api.post<CameraRecord>(`/api/v1/maps/${seg(map)}/cameras/from-getpos`, { id, displayName: name.trim(), getpos, focus: parsedFocus, coverageRadiusUnits: radius, targetRegionIds: targets, uses })}
          success={(c) => t("maps.cameraIdAddedUnvalidatedUntil", { id: c.id })}
          onDone={() => {
            setId("");
            setName("");
            setGetpos("");
            setFocus("");
            onCreated();
          }}
          disabledReason={reason ?? missing}
        >{t("maps.createCamera")}</ActionButton>
      </div>
    </div>
  );
}

const TONE_TEXT: Record<string, string> = { ok: "text-ok", warn: "text-warn", danger: "text-danger", info: "", neutral: "muted" };
const VALIDATION_LABEL: Record<CameraRecord["validation"], string> = perLocale(() => ({ unvalidated: t("maps.unvalidated"), preview_only: t("maps.previewOnly"), validated: t("maps.validated"), invalidated: t("maps.invalidated") }));
const human = (s: string) => s.replace(/_/g, " ");

function CameraRow({ map, cam, onChanged, verdict }: { map: string; cam: CameraRecord; onChanged: () => void; verdict: CameraVerdict | null }) {
  const reason = usePermission("metadata.write");
  const snap = useSnapshot();
  const [validation, setValidation] = useState(cam.validation);
  const [notes, setNotes] = useState(cam.notes ?? "");
  const [uses, setUses] = useState<CameraUse[]>(cam.actionClasses);
  return (
    <tr>
      <td>
        {cam.displayName}
        {cam.capturedFrom === "derived_navmesh" && cam.validation === "unvalidated" ? (
          <div className="small muted" title={t("maps.placedOnCs2SWalkable")}>{t("maps.builtInPlacedFromMap")}</div>
        ) : (
          <div className={`small ${TONE_TEXT[VALIDATION_TONE[cam.validation] ?? "neutral"]}`}>{VALIDATION_LABEL[cam.validation] ?? human(cam.validation)}</div>
        )}
      </td>
      <td className="small">
        <UsesPicker value={uses} onChange={setUses} disabled={!!reason} label={t("maps.usedForDisplayname", { displayName: cam.displayName })} />
      </td>
      <td>
        <div className="row">
          <select aria-label={t("maps.validationForDisplayname", { displayName: cam.displayName })} value={validation} onChange={(e) => setValidation(e.target.value as CameraRecord["validation"])}>
            {(Object.keys(VALIDATION_LABEL) as CameraRecord["validation"][]).map((v) => (
              <option key={v} value={v}>
                {VALIDATION_LABEL[v]}
              </option>
            ))}
          </select>
          <input aria-label={t("maps.notesForDisplayname", { displayName: cam.displayName })} placeholder={t("maps.notes")} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: 140 }} />
          <ActionButton
            size="sm"
            action={() => api.post<CameraRecord>(`/api/v1/maps/${seg(map)}/cameras/${seg(cam.id)}/validation`, { validation, notes, uses })}
            success={(c) => `${c.displayName}: ${human(c.validation)}`}
            onDone={onChanged}
            disabledReason={reason ?? (uses.length === 0 ? t("maps.chooseWhatTheCameraIs") : validation === "validated" && snap?.simulated ? t("maps.camerasCannotBeValidatedFrom") : validation === cam.validation && notes === (cam.notes ?? "") && sameUses(uses, cam.actionClasses) ? t("maps.noChange") : null)}
          >{t("maps.save")}</ActionButton>
        </div>
      </td>
      <td>
        <VerdictButtons mapName={map} cameraId={cam.id} verdict={verdict} onDone={onChanged} />
      </td>
      <td>
        <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/maps/${seg(map)}/cameras/${seg(cam.id)}`)} success={t("maps.cameraRemoved")} onDone={onChanged} disabledReason={reason} confirm={{ title: t("maps.deleteCameraDisplayname", { displayName: cam.displayName }), body: t("maps.removesAnOperatorAuthoredCamera"), danger: true, confirmLabel: t("maps.delete") }}>{t("maps.delete")}</ActionButton>
      </td>
    </tr>
  );
}

/** Built-in cameras and paths (placed from map data and demos) on or off for every map. */
function BuiltInToggle({ onChanged }: { onChanged: () => void }) {
  const state = useApi<{ on: boolean }>("/api/v1/cameras/built-in");
  const reason = usePermission("metadata.write");
  const [busy, setBusy] = useState(false);
  if (!state.data) return null;
  return (
    <Checkbox
      checked={state.data.on}
      disabled={!!reason || busy}
      label={t("maps.builtInCameras")}
      hint={t("maps.camerasAndCameraPathsFor")}
      onChange={(on) => {
        setBusy(true);
        void api
          .put<{ on: boolean }>("/api/v1/cameras/built-in", { on })
          .then((r) => state.setData(r))
          .finally(() => {
            setBusy(false);
            onChanged();
          });
      }}
    />
  );
}

function CameraTechDetails({ cameras }: { cameras: CameraRecord[] }) {
  return (
    <div className="table-wrap">
      <table className="table table-compact small">
        <thead>
          <tr>
            <th>{t("maps.camera")}</th>
            <th>{t("maps.source")}</th>
            <th>{t("maps.occlusion")}</th>
            <th>{t("maps.revision")}</th>
            <th>{t("maps.lastTestedBuildMap")}</th>
            <th>{t("maps.position")}</th>
            <th>{t("maps.pitchYaw")}</th>
          </tr>
        </thead>
        <tbody>
          {cameras.map((cam) => (
            <tr key={cam.id}>
              <td className="mono">{cam.id}</td>
              <td>{human(cam.capturedFrom)}</td>
              <td>{human(cam.occlusionValidation)}</td>
              <td>{cam.mapRevision}</td>
              <td>
                {cam.lastTestedGameBuild ?? MISSING} / {cam.lastTestedMapVersion ?? MISSING}
              </td>
              <td className="mono">
                {cam.position.x.toFixed(0)}, {cam.position.y.toFixed(0)}, {cam.position.z.toFixed(0)}
              </td>
              <td className="mono">
                {cam.pitch.toFixed(1)} / {cam.yaw.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PackDetails({ d }: { d: MapPackDetail }) {
  return (
    <>
      <KV
        items={[
          [t("maps.map"), `${d.mapName}${d.mapName === "de_synthetic" ? t("maps.syntheticTestMapSuffix") : ""}`],
          [t("maps.revision"), d.mapRevision],
          [t("maps.radarCalibration"), d.radar ? <span key="r">{human(d.radar.source)} · {d.radar.verified ? t("maps.verified") : <span className="text-warn">{t("maps.unverified")}</span>}</span> : t("common.none")],
          [t("maps.levels"), d.levels.map((l) => `${l.name} (${l.zMin}…${l.zMax})`).join(", ") || MISSING],
          [t("maps.bombsites"), d.bombsites.map((b) => `${b.site}: ${b.regionId}`).join(", ") || MISSING],
          [t("maps.provenance"), `${d.provenance.createdBy} · ${fmtTime(d.provenance.createdAt)} · ${d.provenance.sources.join(", ")}`],
        ]}
      />
      {d.regions.length ? (
        <table className="table table-compact small" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>{t("maps.region")}</th>
              <th>{t("maps.kind")}</th>
              <th>{t("maps.source")}</th>
              <th>{t("maps.samples")}</th>
              <th>{t("maps.validated")}</th>
            </tr>
          </thead>
          <tbody>
            {d.regions.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.name} <span className="muted mono">{r.id}</span>
                </td>
                <td>{human(r.kind)}</td>
                <td>{human(r.source)}</td>
                <td>{r.sampleCount ?? MISSING}</td>
                <td>{r.validated ? t("common.yes") : <span className="text-warn">{t("common.no")}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function MapDetail({ map, reloadList }: { map: string; reloadList: () => void }) {
  const detail = useApi<MapPackDetail>(`/api/v1/maps/${seg(map)}`);
  const reviews = useApi<Record<string, Record<string, CameraVerdict>>>("/api/v1/cameras/review", { refreshMs: 3000 });
  const outline = useApi<MapOutline | null>(`/api/v1/maps/${seg(map)}/outline`);
  const reason = usePermission("metadata.write");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [adding, setAdding] = useState(false);
  const reload = () => {
    void detail.reload();
    void reviews.reload();
    reloadList();
  };
  return (
    <Async state={detail}>
      {(d) => (
        <div className="stack">
          <Panel title={d.displayName} subtitle={t("maps.mapnameRevisionMaprevision", { mapName: d.mapName, mapRevision: d.mapRevision })}>
            <div className="grid-2">
              <div>
                <Async state={outline}>{(o) => (o ? <OutlineCanvas outline={o} highlight={highlight} /> : <EmptyState title={t("maps.noOutline")}>{t("maps.thisPackHasNoRegion")}</EmptyState>)}</Async>
                <p className="gc-caption">{t("maps.schematicDrawnFromMapPack")}</p>
              </div>
              <div>
                <h3 className="gc-section-title">{t("maps.regionsCount", { count: d.regions.length })}</h3>
                <ul className="list-plain small" style={{ maxHeight: 280, overflowY: "auto" }}>
                  {d.regions.map((r) => (
                    <li key={r.id} className="row" onMouseEnter={() => setHighlight(r.id)} onMouseLeave={() => setHighlight(null)}>
                      <span className="dot" style={{ background: KIND_COLOR[r.kind] ?? KIND_COLOR.other }} aria-hidden />
                      <span>{r.name}</span>
                      <span className="muted">{human(r.kind)}</span>
                      <span className="spacer" />
                      {r.validated ? null : <span className="text-warn">{t("maps.unvalidated")}</span>}
                    </li>
                  ))}
                </ul>
                <Details summary={t("maps.packDetails")}>
                  <PackDetails d={d} />
                </Details>
                <Details summary={t("maps.bumpMapRevision")}>
                  <div className="row-end">
                    <Field label={t("maps.newRevision")} hint={t("maps.doThisWhenAGame")}>
                      <input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder={d.mapRevision} />
                    </Field>
                    <ActionButton
                      action={() => api.post<{ invalidated: string[] }>(`/api/v1/maps/${seg(map)}/revision`, { revision: revision.trim() })}
                      success={(r) => t("maps.revisionSetInvalidated", { count: r.invalidated.length })}
                      onDone={reload}
                      disabledReason={reason ?? (revision.trim() && revision.trim() !== d.mapRevision ? null : t("maps.enterADifferentRevision"))}
                      confirm={{ title: t("maps.setDisplaynameRevisionToRevision", { displayName: d.displayName, revision }), body: t("maps.camerasAuthoredForOtherRevisions"), confirmLabel: t("maps.bumpRevision") }}
                    >{t("maps.bumpRevision")}</ActionButton>
                  </div>
                </Details>
              </div>
            </div>
          </Panel>
          <Panel
            title={t("maps.camerasCount", { count: d.cameras.length })}
            subtitle={t("maps.cinematicsUseValidatedCamerasAnd")}
            actions={
              <>
                <BuiltInToggle onChanged={reload} />
                {d.cameras.length && !adding ? (
                  <Button size="sm" onClick={() => setAdding(true)}>{t("maps.addCamera")}</Button>
                ) : null}
              </>
            }
          >
            {d.cameras.length === 0 ? null : (
              <>
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>{t("maps.camera")}</th>
                        <th>{t("maps.usedFor")}</th>
                        <th>{t("maps.validation")}</th>
                        <th title={t("maps.seenInCs2CameraWalkthrough")}>{t("maps.inGame")}</th>
                        <th aria-label={t("maps.delete")} />
                      </tr>
                    </thead>
                    <tbody>
                      {d.cameras.map((c) => (
                        <CameraRow key={c.id} map={map} cam={c} onChanged={reload} verdict={reviews.data?.[map]?.[c.id] ?? null} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <Details summary={t("maps.poseAndTestDetails")}>
                  <CameraTechDetails cameras={d.cameras} />
                </Details>
              </>
            )}
            {d.cameras.length === 0 || adding ? (
              <div className={d.cameras.length ? "gc-section" : undefined}>
                <div className="gc-split">
                  <h3 className="gc-section-title">{d.cameras.length ? t("maps.addACamera") : t("maps.noCamerasYetAddOne")}</h3>
                  {d.cameras.length ? (
                    <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t("common.cancel")}</Button>
                  ) : null}
                </div>
                <CameraAuthoring map={map} regions={d.regions} onCreated={reload} />
              </div>
            ) : null}
          </Panel>
        </div>
      )}
    </Async>
  );
}

function SupportText({ support }: { support: Support }) {
  const s = SUPPORT_TEXT[support];
  return <span className={TONE_TEXT[s.tone]}>{s.text.charAt(0) + s.text.slice(1).toLowerCase()}</span>;
}

function CovFacts({ c }: { c: CoverageCell }) {
  return (
    <>
      <span>
        <span className="muted">{t("maps.telemetry")}</span> <SupportText support={c.telemetry} />
      </span>
      <span>
        <span className="muted">{t("maps.effect")}</span> <SupportText support={c.activationEffect} />
      </span>
      <span>
        <span className="muted">{t("maps.prediction")}</span> {c.prediction}
      </span>
      <span>
        <span className="muted">{t("maps.camera")}</span> <span className={c.cameraCoverage === "validated" ? "text-ok" : c.cameraCoverage === "unvalidated" ? "text-warn" : "muted"}>{c.cameraCoverage}</span>
      </span>
    </>
  );
}

const cellKey = (c: CoverageCell) => JSON.stringify([c.telemetry, c.activationEffect, c.prediction, c.cameraCoverage, c.fallback, c.evidence, c.testedRegions]);
const rowFallback = (r: CoverageRow) => (r.cells.every((c) => c.fallback === r.cells[0]?.fallback) ? (r.cells[0]?.fallback ?? null) : null);

function Coverage() {
  const cov = useApi<CoverageRow[]>("/api/v1/coverage/maps");
  return (
    <Panel title={t("maps.utilityCoverage")} subtitle={t("maps.whatTheObserverCanFollow")}>
      <Async state={cov}>
        {(rows) => {
          const everywhere = rows.length && rows.every((r) => rowFallback(r) === rowFallback(rows[0]!)) ? rowFallback(rows[0]!) : null;
          return (
            <>
              {everywhere ? <p className="small muted">{t("maps.fallbackForEveryMapAnd", { everywhere })}</p> : null}
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table table-compact coverage">
                  <thead>
                    <tr>
                      <th style={{ width: "26%" }}>{t("maps.map")}</th>
                      {(rows[0]?.cells ?? []).map((c) => (
                        <th key={c.grenadeType}>{GRENADE_TYPE_LABEL[c.grenadeType] ?? c.grenadeType}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const shared = rowFallback(r);
                      const same = r.cells.length > 1 && r.cells.every((c) => cellKey(c) === cellKey(r.cells[0]!));
                      return (
                        <tr key={r.mapName}>
                          <td>
                            {r.displayName} <span className="small muted">{r.mapName}</span>
                            {r.mapPackPresent ? null : <div className="small text-warn">{t("maps.noMapPack")}</div>}
                            <div className="small muted">{t("maps.regioncountRegionsRegionsourceFloorGrid", { regionCount: r.regionCount, regionSource: r.regionSource, v: r.floorGrid ? t("common.yes") : t("common.no"), radarCalibration: r.radarCalibration, validatedCameras: r.validatedCameras, unvalidatedCameras: r.unvalidatedCameras })}</div>
                            {shared && !everywhere ? <div className="small muted">{t("maps.fallbackAllTypesShared", { shared })}</div> : null}
                          </td>
                          {same ? (
                            <td colSpan={r.cells.length}>
                              <div className="gc-facts small" title={r.cells[0]!.evidence.length ? t("maps.evidenceJoin", { join: r.cells[0]!.evidence.join(", ") }) : undefined}>
                                <span className="muted">{t("maps.allTypes")}</span>
                                <CovFacts c={r.cells[0]!} />
                              </div>
                            </td>
                          ) : (
                            r.cells.map((c) => (
                              <td key={c.grenadeType}>
                                <div className="cov-cell" title={c.evidence.length ? t("maps.evidenceJoin", { join: c.evidence.join(", ") }) : undefined}>
                                  <CovFacts c={c} />
                                  {shared ? null : <span className="muted">{t("maps.fallbackFallback", { fallback: c.fallback })}</span>}
                                </div>
                              </td>
                            ))
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Details summary={t("maps.howToReadThis")}>
                <p className="small muted">{t("maps.telemetryColumnsComeFromThe")}</p>
              </Details>
            </>
          );
        }}
      </Async>
    </Panel>
  );
}

export function MapsScreen() {
  const maps = useApi<MapSummary[]>("/api/v1/maps");
  const snap = useSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = usePersistentState<"maps" | "coverage">("mapsTab", "maps");
  const current = snap?.state?.mapName ?? null;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("maps.mapsCameras2")}</h1>
      </div>
      <Tabs
        label={t("maps.mapsSections")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "maps", label: t("maps.mapsCameras") },
          { id: "coverage", label: t("maps.utilityCoverage") },
        ]}
      />
      {tab === "coverage" ? (
        <Coverage />
      ) : (
        <Async state={maps}>
          {(list) => {
            const sel = selected ?? (list.some((m) => m.mapName === current) ? current : (list[0]?.mapName ?? null));
            return list.length === 0 ? (
              <EmptyState title={t("maps.noMapPacksLoaded")}>{t("maps.mapPacksAreJsonFiles")}</EmptyState>
            ) : (
              <div className="stack">
              <CameraWalkthroughPanel liveMap={current} onReviewed={() => void maps.reload()} />
              <div className="grid-1-2">
                <Panel title={t("maps.maps")}>
                  <ul className="select-list">
                    {list.map((m) => {
                      const validated = m.cameras.filter((c) => c.validation === "validated").length;
                      return (
                        <li key={m.mapName}>
                          <button className={m.mapName === sel ? "is-selected" : ""} onClick={() => setSelected(m.mapName)} title={t("maps.mapnameRevisionRevisionRegionsRegions", { mapName: m.mapName, revision: m.revision, regions: m.regions, v: m.synthetic ? t("maps.syntheticTestMap") : "" })}>
                            <span style={{ flex: 1 }}>
                              <span className="gc-select-name">{m.displayName}</span>
                              <div className="small muted">{m.cameras.length ? t("maps.camerasValidated", { count: m.cameras.length, validated }) : t("maps.noCameras")}</div>
                            </span>
                            {m.mapName === current ? <Badge tone="ok">{t("maps.live")}</Badge> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Panel>
                {sel ? <MapDetail key={sel} map={sel} reloadList={() => void maps.reload()} /> : null}
              </div>
              </div>
            );
          }}
        </Async>
      )}
    </div>
  );
}
