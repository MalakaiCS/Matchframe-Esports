import { useEffect, useRef, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { CameraRecord, CoverageCell, CoverageRow, MapOutline, MapPackDetail, MapSummary } from "../api/types.ts";
import { ActionButton, Async, Badge, EmptyState, Field, KV, Note, Panel, SupportBadge } from "../components/ui.tsx";
import { fmtTime, GRENADE_TYPE_LABEL, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";

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
const CAMERA_USES: { id: CameraUse; label: string; hint: string }[] = [
  { id: "utility", label: "Nade camera", hint: "Full Action Observer: catches grenades landing in its coverage" },
  { id: "tactical", label: "Fight overview", hint: "Observer & Cinematics: big fights in its coverage" },
  { id: "bomb", label: "Bomb", hint: "Observer & Cinematics: bomb defuse and the last seconds of the timer" },
  { id: "establishing", label: "Establishing (freeze time)", hint: "Observer & Cinematics: wide shot during freeze time" },
];

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
      <canvas ref={ref} role="img" aria-label={`Schematic outline with ${outline.regions.length} regions`} />
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
  const missing = !/^[a-z0-9-]{3,64}$/.test(id) ? "Camera id: 3–64 chars a–z, 0–9, dash" : !name.trim() ? "Enter a display name" : !getposOk ? "Paste the camera's getpos output (setpos …; setang …)" : !parsedFocus ? "Enter the focus point as “x y z” or paste getpos taken at the focus point" : uses.length === 0 ? "Choose what the camera is used for" : null;
  return (
    <>
      <p className="small muted">In CS2, fly the free camera to the shot, run <code>getpos</code> in the console and paste the output. Then do the same standing at the point the camera should look at (or type its x y z). Coordinates are never invented.</p>
      <div className="form-grid">
        <Field label="Camera id">
          <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="banana-high" />
        </Field>
        <Field label="Display name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Banana (high)" />
        </Field>
        <Field label="Coverage radius (units)">
          <input type="number" min={50} max={3000} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Camera getpos output">
        <textarea className="mono" rows={2} value={getpos} onChange={(e) => setGetpos(e.target.value)} placeholder="setpos 1234.5 -567.0 64.0;setang 12.3 45.6 0.0" />
      </Field>
      <Field label="Focus point (x y z, or getpos at the focus point)" hint={parsedFocus ? `Parsed: ${parsedFocus.x}, ${parsedFocus.y}, ${parsedFocus.z}` : undefined}>
        <input className="mono" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="1500 -200 32" />
      </Field>
      <Field label="Used for" hint="Which Observer shots may use this camera. Establishing shots run in freeze time; the others during the round.">
        <UsesPicker value={uses} onChange={setUses} label="Used for" />
      </Field>
      {regions.length ? (
        <fieldset>
          <legend>Target regions</legend>
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
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() => api.post<CameraRecord>(`/api/v1/maps/${seg(map)}/cameras/from-getpos`, { id, displayName: name.trim(), getpos, focus: parsedFocus, coverageRadiusUnits: radius, targetRegionIds: targets, uses })}
          success={(c) => `Camera ${c.id} captured (UNVALIDATED until tested in-game)`}
          onDone={() => {
            setId("");
            setName("");
            setGetpos("");
            setFocus("");
            onCreated();
          }}
          disabledReason={reason ?? missing}
        >
          Create camera
        </ActionButton>
      </div>
    </>
  );
}

function CameraRow({ map, cam, onChanged }: { map: string; cam: CameraRecord; onChanged: () => void }) {
  const reason = usePermission("metadata.write");
  const snap = useSnapshot();
  const [validation, setValidation] = useState(cam.validation);
  const [notes, setNotes] = useState(cam.notes ?? "");
  const [uses, setUses] = useState<CameraUse[]>(cam.actionClasses);
  return (
    <tr>
      <td>
        <strong>{cam.displayName}</strong>
        <div className="muted small mono">{cam.id}</div>
        <div className="small muted">from {cam.capturedFrom.replace("_", " ")}</div>
      </td>
      <td>
        <Badge tone={VALIDATION_TONE[cam.validation] ?? "neutral"}>{cam.validation.replace("_", " ")}</Badge>
        <div className="small muted">occlusion: {cam.occlusionValidation.replace("_", " ")}</div>
      </td>
      <td className="small">
        rev {cam.mapRevision}
        <div className="muted">
          tested build {cam.lastTestedGameBuild ?? MISSING} / map {cam.lastTestedMapVersion ?? MISSING}
        </div>
      </td>
      <td className="small">
        <UsesPicker value={uses} onChange={setUses} disabled={!!reason} label={`Used for (${cam.displayName})`} />
      </td>
      <td className="small mono">
        {cam.position.x.toFixed(0)}, {cam.position.y.toFixed(0)}, {cam.position.z.toFixed(0)}
        <div className="muted">
          pitch {cam.pitch.toFixed(1)} yaw {cam.yaw.toFixed(1)}
        </div>
      </td>
      <td>
        <div className="row">
          <select aria-label={`Validation for ${cam.displayName}`} value={validation} onChange={(e) => setValidation(e.target.value as CameraRecord["validation"])}>
            <option value="unvalidated">unvalidated</option>
            <option value="preview_only">preview only</option>
            <option value="validated">validated</option>
            <option value="invalidated">invalidated</option>
          </select>
          <input aria-label="Notes" placeholder="notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: 140 }} />
          <ActionButton
            size="sm"
            action={() => api.post<CameraRecord>(`/api/v1/maps/${seg(map)}/cameras/${seg(cam.id)}/validation`, { validation, notes, uses })}
            success={(c) => `${c.displayName}: ${c.validation}`}
            onDone={onChanged}
            disabledReason={reason ?? (uses.length === 0 ? "Choose what the camera is used for" : validation === "validated" && snap?.simulated ? "Cameras cannot be validated from simulation" : validation === cam.validation && notes === (cam.notes ?? "") && sameUses(uses, cam.actionClasses) ? "No change" : null)}
            reasonPlacement="tooltip"
          >
            Save
          </ActionButton>
          <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/maps/${seg(map)}/cameras/${seg(cam.id)}`)} success="Camera removed" onDone={onChanged} disabledReason={reason} reasonPlacement="tooltip" confirm={{ title: `Delete camera ${cam.displayName}?`, body: "Removes an operator-authored camera. Cameras shipped inside a map pack file stay in the pack.", danger: true, confirmLabel: "Delete" }}>
            Delete
          </ActionButton>
        </div>
      </td>
    </tr>
  );
}

function MapDetail({ map, reloadList }: { map: string; reloadList: () => void }) {
  const detail = useApi<MapPackDetail>(`/api/v1/maps/${seg(map)}`);
  const outline = useApi<MapOutline | null>(`/api/v1/maps/${seg(map)}/outline`);
  const reason = usePermission("metadata.write");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const reload = () => {
    void detail.reload();
    reloadList();
  };
  return (
    <Async state={detail}>
      {(d) => (
        <div className="stack">
          <div className="grid-2">
            <Panel title={`${d.displayName} — schematic outline`} subtitle="Generated from map-pack regions (sampled from real positions), not a game radar image">
              <Async state={outline}>{(o) => (o ? <OutlineCanvas outline={o} highlight={highlight} /> : <EmptyState title="No schematic geometry">This pack has no region geometry to draw an outline from.</EmptyState>)}</Async>
            </Panel>
            <div className="stack">
              <Panel title="Map pack">
                <KV
                  items={[
                    ["Map", <span key="m">{d.mapName} {d.mapName === "de_synthetic" ? <Badge tone="sim">SYNTHETIC</Badge> : null}</span>],
                    ["Revision", d.mapRevision],
                    ["Radar calibration", d.radar ? <span key="r">{d.radar.source.replace(/_/g, " ")} {d.radar.verified ? <Badge tone="ok">VERIFIED</Badge> : <Badge tone="warn">UNVERIFIED</Badge>}</span> : "none"],
                    ["Levels", d.levels.map((l) => `${l.name} (${l.zMin}…${l.zMax})`).join(", ") || MISSING],
                    ["Bombsites", d.bombsites.map((b) => `${b.site}: ${b.regionId}`).join(", ") || MISSING],
                    ["Provenance", `${d.provenance.createdBy} · ${fmtTime(d.provenance.createdAt)} · ${d.provenance.sources.join(", ")}`],
                  ]}
                />
              </Panel>
              <Panel title={`Regions (${d.regions.length})`}>
                <ul className="list-plain small" style={{ maxHeight: 240, overflowY: "auto" }}>
                  {d.regions.map((r) => (
                    <li key={r.id} className="row" onMouseEnter={() => setHighlight(r.id)} onMouseLeave={() => setHighlight(null)}>
                      <span className="dot" style={{ background: KIND_COLOR[r.kind] ?? KIND_COLOR.other }} aria-hidden />
                      <strong>{r.name}</strong> <span className="muted">{r.kind.replace("_", " ")}</span>
                      <span className="spacer" />
                      {r.validated ? <Badge tone="ok">VALIDATED</Badge> : <Badge tone="warn">UNVALIDATED</Badge>}
                      <span className="muted">
                        {r.source.replace(/_/g, " ")}
                        {r.sampleCount !== null ? ` · ${r.sampleCount} samples` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel title="Map revision">
                <p className="small muted">When the game updates this map, bump the revision: operator cameras from older revisions become INVALIDATED until re-tested.</p>
                <div className="row-end">
                  <Field label="New revision">
                    <input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder={d.mapRevision} />
                  </Field>
                  <ActionButton
                    action={() => api.post<{ invalidated: string[] }>(`/api/v1/maps/${seg(map)}/revision`, { revision: revision.trim() })}
                    success={(r) => `Revision set; ${r.invalidated.length} camera(s) invalidated`}
                    onDone={reload}
                    disabledReason={reason ?? (revision.trim() && revision.trim() !== d.mapRevision ? null : "Enter a different revision")}
                    confirm={{ title: `Set ${d.displayName} revision to ${revision}?`, body: "Cameras authored for other revisions are marked invalidated.", confirmLabel: "Bump revision" }}
                  >
                    Bump revision
                  </ActionButton>
                </div>
              </Panel>
            </div>
          </div>
          <Panel title={`Cameras (${d.cameras.length})`} subtitle="Only validated cameras are used for cinematics">
            {d.cameras.length === 0 ? (
              <EmptyState title="No cameras on this map">Author one below from in-game getpos output; it starts UNVALIDATED.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Camera</th>
                      <th>Validation</th>
                      <th>Revision / tested</th>
                      <th>Used for</th>
                      <th>Pose</th>
                      <th>Change validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.cameras.map((c) => (
                      <CameraRow key={c.id} map={map} cam={c} onChanged={reload} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel title="Author a camera from getpos">
            <CameraAuthoring map={map} regions={d.regions} onCreated={reload} />
          </Panel>
        </div>
      )}
    </Async>
  );
}

function CovCell({ c, showFallback }: { c: CoverageCell; showFallback: boolean }) {
  return (
    <div className="cov-cell" title={c.evidence.length ? `Evidence: ${c.evidence.join(", ")}` : undefined}>
      <span>
        telemetry <SupportBadge support={c.telemetry} />
      </span>
      <span>
        effect <SupportBadge support={c.activationEffect} />
      </span>
      <span>
        prediction {c.prediction} · camera{" "}
        {c.cameraCoverage === "validated" ? <Badge tone="ok">VALIDATED</Badge> : c.cameraCoverage === "unvalidated" ? <Badge tone="warn">UNVALIDATED</Badge> : <Badge>NONE</Badge>}
      </span>
      {showFallback ? <span className="muted">fallback: {c.fallback}</span> : null}
    </div>
  );
}

function Coverage() {
  const cov = useApi<CoverageRow[]>("/api/v1/coverage/maps");
  return (
    <Async state={cov}>
      {(rows) => (
        <div className="table-wrap">
          <table className="table table-compact coverage">
            <thead>
              <tr>
                <th>Map</th>
                {(rows[0]?.cells ?? []).map((c) => (
                  <th key={c.grenadeType}>{GRENADE_TYPE_LABEL[c.grenadeType] ?? c.grenadeType}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const shared = r.cells.every((c) => c.fallback === r.cells[0]?.fallback) ? (r.cells[0]?.fallback ?? null) : null;
                return (
                <tr key={r.mapName}>
                  <td>
                    <strong>{r.displayName}</strong>
                    <div className="small muted">{r.mapName}</div>
                    <div className="small">{r.mapPackPresent ? <Badge tone="ok">PACK</Badge> : <Badge tone="warn">NO PACK</Badge>}</div>
                    <div className="small muted">
                      {r.regionCount} regions ({r.regionSource}) · floor grid {r.floorGrid ? "yes" : "no"} · radar {r.radarCalibration} · cams {r.validatedCameras} validated / {r.unvalidatedCameras} not
                    </div>
                    {shared ? <div className="small">Fallback (all types): {shared}</div> : null}
                  </td>
                  {r.cells.map((c) => (
                    <td key={c.grenadeType}>
                      <CovCell c={c} showFallback={!shared} />
                    </td>
                  ))}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Async>
  );
}

export function MapsScreen() {
  const maps = useApi<MapSummary[]>("/api/v1/maps");
  const snap = useSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const current = snap?.state?.mapName ?? null;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Maps &amp; Cameras</h1>
      </div>
      <Async state={maps}>
        {(list) => {
          const sel = selected ?? (list.some((m) => m.mapName === current) ? current : (list[0]?.mapName ?? null));
          return (
            <div className="stack">
              {list.length === 0 ? (
                <EmptyState title="No map packs loaded">Map packs are JSON files in the app's assets/map-packs folder or the data folder's map-packs directory. The labelled simulation registers a synthetic test map when started.</EmptyState>
              ) : (
                <div className="grid-1-2">
                  <Panel title="Map packs">
                    <ul className="select-list">
                      {list.map((m) => (
                        <li key={m.mapName}>
                          <button className={m.mapName === sel ? "is-selected" : ""} onClick={() => setSelected(m.mapName)}>
                            <span style={{ flex: 1 }}>
                              <strong>{m.displayName}</strong> <span className="muted small">{m.mapName}</span>
                              <div className="small muted">
                                rev {m.revision} · {m.regions} regions · {m.cameras.length} cameras ({m.cameras.filter((c) => c.validation === "validated").length} validated)
                              </div>
                            </span>
                            {m.synthetic ? <Badge tone="sim">SYNTHETIC</Badge> : null}
                            {m.mapName === current ? <Badge tone="ok">LIVE</Badge> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                  {sel ? <MapDetail key={sel} map={sel} reloadList={() => void maps.reload()} /> : null}
                </div>
              )}
              <Panel title="Utility coverage matrix" subtitle="Map × grenade type: telemetry, effect, prediction, camera coverage and fallback">
                <Note tone="neutral">Telemetry columns come from the live source's capability report (unverified during simulation or without data). Camera coverage counts validated cameras only. Nothing is upgraded by default.</Note>
                <Coverage />
              </Panel>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
