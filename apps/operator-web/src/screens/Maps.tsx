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
    <div className="gc-form">
      <div className="form-grid">
        <Field label="Camera id" hint="a–z, 0–9 and dashes">
          <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="banana-high" />
        </Field>
        <Field label="Display name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Banana (high)" />
        </Field>
        <Field label="Coverage radius (units)">
          <input type="number" min={50} max={3000} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Camera getpos output" hint="In CS2, fly the free camera to the shot, run getpos in the console and paste the output.">
        <textarea className="mono" rows={2} value={getpos} onChange={(e) => setGetpos(e.target.value)} placeholder="setpos 1234.5 -567.0 64.0;setang 12.3 45.6 0.0" />
      </Field>
      <Field label="Focus point" hint={parsedFocus ? `Parsed: ${parsedFocus.x}, ${parsedFocus.y}, ${parsedFocus.z}` : "Where the camera looks: type x y z, or paste getpos taken standing there."}>
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
      <div className="form-actions" style={{ marginTop: 0 }}>
        <ActionButton
          variant="primary"
          action={() => api.post<CameraRecord>(`/api/v1/maps/${seg(map)}/cameras/from-getpos`, { id, displayName: name.trim(), getpos, focus: parsedFocus, coverageRadiusUnits: radius, targetRegionIds: targets, uses })}
          success={(c) => `Camera ${c.id} added — unvalidated until tested in-game`}
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
    </div>
  );
}

const TONE_TEXT: Record<string, string> = { ok: "text-ok", warn: "text-warn", danger: "text-danger", info: "", neutral: "muted" };
const VALIDATION_LABEL: Record<CameraRecord["validation"], string> = { unvalidated: "Unvalidated", preview_only: "Preview only", validated: "Validated", invalidated: "Invalidated" };
const human = (s: string) => s.replace(/_/g, " ");

function CameraRow({ map, cam, onChanged }: { map: string; cam: CameraRecord; onChanged: () => void }) {
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
          <div className="small muted" title="Placed from the map's navigation data with a clear line of sight; not yet seen in game. Validate it after a look in CS2, or switch built-in cameras off.">
            Built-in · placed from map data
          </div>
        ) : (
          <div className={`small ${TONE_TEXT[VALIDATION_TONE[cam.validation] ?? "neutral"]}`}>{VALIDATION_LABEL[cam.validation] ?? human(cam.validation)}</div>
        )}
      </td>
      <td className="small">
        <UsesPicker value={uses} onChange={setUses} disabled={!!reason} label={`Used for (${cam.displayName})`} />
      </td>
      <td>
        <div className="row">
          <select aria-label={`Validation for ${cam.displayName}`} value={validation} onChange={(e) => setValidation(e.target.value as CameraRecord["validation"])}>
            {(Object.keys(VALIDATION_LABEL) as CameraRecord["validation"][]).map((v) => (
              <option key={v} value={v}>
                {VALIDATION_LABEL[v]}
              </option>
            ))}
          </select>
          <input aria-label={`Notes for ${cam.displayName}`} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: 140 }} />
          <ActionButton
            size="sm"
            action={() => api.post<CameraRecord>(`/api/v1/maps/${seg(map)}/cameras/${seg(cam.id)}/validation`, { validation, notes, uses })}
            success={(c) => `${c.displayName}: ${human(c.validation)}`}
            onDone={onChanged}
            disabledReason={reason ?? (uses.length === 0 ? "Choose what the camera is used for" : validation === "validated" && snap?.simulated ? "Cameras cannot be validated from simulation" : validation === cam.validation && notes === (cam.notes ?? "") && sameUses(uses, cam.actionClasses) ? "No change" : null)}
          >
            Save
          </ActionButton>
        </div>
      </td>
      <td>
        <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/maps/${seg(map)}/cameras/${seg(cam.id)}`)} success="Camera removed" onDone={onChanged} disabledReason={reason} confirm={{ title: `Delete camera ${cam.displayName}?`, body: "Removes an operator-authored camera. Cameras shipped inside a map pack file stay in the pack.", danger: true, confirmLabel: "Delete" }}>
          Delete
        </ActionButton>
      </td>
    </tr>
  );
}

/** Built-in cameras and paths (placed from map data) on or off for every map. */
function BuiltInToggle({ onChanged }: { onChanged: () => void }) {
  const state = useApi<{ on: boolean }>("/api/v1/cameras/built-in");
  const reason = usePermission("metadata.write");
  const [busy, setBusy] = useState(false);
  if (!state.data) return null;
  return (
    <Checkbox
      checked={state.data.on}
      disabled={!!reason || busy}
      label="Built-in cameras"
      hint="Cameras and camera paths for every active-duty map, placed from the map's navigation data. Switch off to use only your own cameras."
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
            <th>Camera</th>
            <th>Source</th>
            <th>Occlusion</th>
            <th>Revision</th>
            <th>Last tested (build / map)</th>
            <th>Position</th>
            <th>Pitch / yaw</th>
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
          ["Map", `${d.mapName}${d.mapName === "de_synthetic" ? " (synthetic test map)" : ""}`],
          ["Revision", d.mapRevision],
          ["Radar calibration", d.radar ? <span key="r">{human(d.radar.source)} · {d.radar.verified ? "verified" : <span className="text-warn">unverified</span>}</span> : "none"],
          ["Levels", d.levels.map((l) => `${l.name} (${l.zMin}…${l.zMax})`).join(", ") || MISSING],
          ["Bombsites", d.bombsites.map((b) => `${b.site}: ${b.regionId}`).join(", ") || MISSING],
          ["Provenance", `${d.provenance.createdBy} · ${fmtTime(d.provenance.createdAt)} · ${d.provenance.sources.join(", ")}`],
        ]}
      />
      {d.regions.length ? (
        <table className="table table-compact small" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Region</th>
              <th>Kind</th>
              <th>Source</th>
              <th>Samples</th>
              <th>Validated</th>
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
                <td>{r.validated ? "yes" : <span className="text-warn">no</span>}</td>
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
  const outline = useApi<MapOutline | null>(`/api/v1/maps/${seg(map)}/outline`);
  const reason = usePermission("metadata.write");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [adding, setAdding] = useState(false);
  const reload = () => {
    void detail.reload();
    reloadList();
  };
  return (
    <Async state={detail}>
      {(d) => (
        <div className="stack">
          <Panel title={d.displayName} subtitle={`${d.mapName} · revision ${d.mapRevision}`}>
            <div className="grid-2">
              <div>
                <Async state={outline}>{(o) => (o ? <OutlineCanvas outline={o} highlight={highlight} /> : <EmptyState title="No outline">This pack has no region geometry to draw an outline from.</EmptyState>)}</Async>
                <p className="gc-caption">Schematic drawn from map-pack regions (sampled from real positions), not a game radar image.</p>
              </div>
              <div>
                <h3 className="gc-section-title">Regions ({d.regions.length})</h3>
                <ul className="list-plain small" style={{ maxHeight: 280, overflowY: "auto" }}>
                  {d.regions.map((r) => (
                    <li key={r.id} className="row" onMouseEnter={() => setHighlight(r.id)} onMouseLeave={() => setHighlight(null)}>
                      <span className="dot" style={{ background: KIND_COLOR[r.kind] ?? KIND_COLOR.other }} aria-hidden />
                      <span>{r.name}</span>
                      <span className="muted">{human(r.kind)}</span>
                      <span className="spacer" />
                      {r.validated ? null : <span className="text-warn">Unvalidated</span>}
                    </li>
                  ))}
                </ul>
                <Details summary="Pack details">
                  <PackDetails d={d} />
                </Details>
                <Details summary="Bump map revision">
                  <div className="row-end">
                    <Field label="New revision" hint="Do this when a game update changes the map. Operator cameras from older revisions become invalidated until re-tested.">
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
                </Details>
              </div>
            </div>
          </Panel>
          <Panel
            title={`Cameras (${d.cameras.length})`}
            subtitle="Cinematics use validated cameras, and the built-in cameras unless they are switched off."
            actions={
              <>
                <BuiltInToggle onChanged={reload} />
                {d.cameras.length && !adding ? (
                  <Button size="sm" onClick={() => setAdding(true)}>
                    Add camera
                  </Button>
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
                        <th>Camera</th>
                        <th>Used for</th>
                        <th>Validation</th>
                        <th aria-label="Delete" />
                      </tr>
                    </thead>
                    <tbody>
                      {d.cameras.map((c) => (
                        <CameraRow key={c.id} map={map} cam={c} onChanged={reload} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <Details summary="Pose and test details">
                  <CameraTechDetails cameras={d.cameras} />
                </Details>
              </>
            )}
            {d.cameras.length === 0 || adding ? (
              <div className={d.cameras.length ? "gc-section" : undefined}>
                <div className="gc-split">
                  <h3 className="gc-section-title">{d.cameras.length ? "Add a camera" : "No cameras yet — add one from getpos"}</h3>
                  {d.cameras.length ? (
                    <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                      Cancel
                    </Button>
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
        <span className="muted">Telemetry</span> <SupportText support={c.telemetry} />
      </span>
      <span>
        <span className="muted">Effect</span> <SupportText support={c.activationEffect} />
      </span>
      <span>
        <span className="muted">Prediction</span> {c.prediction}
      </span>
      <span>
        <span className="muted">Camera</span> <span className={c.cameraCoverage === "validated" ? "text-ok" : c.cameraCoverage === "unvalidated" ? "text-warn" : "muted"}>{c.cameraCoverage}</span>
      </span>
    </>
  );
}

const cellKey = (c: CoverageCell) => JSON.stringify([c.telemetry, c.activationEffect, c.prediction, c.cameraCoverage, c.fallback, c.evidence, c.testedRegions]);
const rowFallback = (r: CoverageRow) => (r.cells.every((c) => c.fallback === r.cells[0]?.fallback) ? (r.cells[0]?.fallback ?? null) : null);

function Coverage() {
  const cov = useApi<CoverageRow[]>("/api/v1/coverage/maps");
  return (
    <Panel title="Utility coverage" subtitle="What the Observer can follow for each grenade type, per map.">
      <Async state={cov}>
        {(rows) => {
          const everywhere = rows.length && rows.every((r) => rowFallback(r) === rowFallback(rows[0]!)) ? rowFallback(rows[0]!) : null;
          return (
            <>
              {everywhere ? <p className="small muted">Fallback for every map and grenade type: {everywhere}.</p> : null}
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table table-compact coverage">
                  <thead>
                    <tr>
                      <th style={{ width: "26%" }}>Map</th>
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
                            {r.mapPackPresent ? null : <div className="small text-warn">No map pack</div>}
                            <div className="small muted">
                              {r.regionCount} regions ({r.regionSource}) · floor grid {r.floorGrid ? "yes" : "no"} · radar {r.radarCalibration} · cameras {r.validatedCameras} validated / {r.unvalidatedCameras} not
                            </div>
                            {shared && !everywhere ? <div className="small muted">Fallback (all types): {shared}</div> : null}
                          </td>
                          {same ? (
                            <td colSpan={r.cells.length}>
                              <div className="gc-facts small" title={r.cells[0]!.evidence.length ? `Evidence: ${r.cells[0]!.evidence.join(", ")}` : undefined}>
                                <span className="muted">All types:</span>
                                <CovFacts c={r.cells[0]!} />
                              </div>
                            </td>
                          ) : (
                            r.cells.map((c) => (
                              <td key={c.grenadeType}>
                                <div className="cov-cell" title={c.evidence.length ? `Evidence: ${c.evidence.join(", ")}` : undefined}>
                                  <CovFacts c={c} />
                                  {shared ? null : <span className="muted">Fallback: {c.fallback}</span>}
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
              <Details summary="How to read this">
                <p className="small muted">Telemetry columns come from the live source&apos;s capability report (unverified during simulation or without data). Camera coverage counts validated cameras only. Nothing is upgraded by default. Hover a cell for its evidence.</p>
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
        <h1 className="page-title">Maps &amp; Cameras</h1>
      </div>
      <Tabs
        label="Maps sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "maps", label: "Maps & cameras" },
          { id: "coverage", label: "Utility coverage" },
        ]}
      />
      {tab === "coverage" ? (
        <Coverage />
      ) : (
        <Async state={maps}>
          {(list) => {
            const sel = selected ?? (list.some((m) => m.mapName === current) ? current : (list[0]?.mapName ?? null));
            return list.length === 0 ? (
              <EmptyState title="No map packs loaded">Map packs are JSON files in the app&apos;s assets/map-packs folder or the data folder&apos;s map-packs directory. The labelled simulation adds a synthetic test map when started.</EmptyState>
            ) : (
              <div className="grid-1-2">
                <Panel title="Maps">
                  <ul className="select-list">
                    {list.map((m) => {
                      const validated = m.cameras.filter((c) => c.validation === "validated").length;
                      return (
                        <li key={m.mapName}>
                          <button className={m.mapName === sel ? "is-selected" : ""} onClick={() => setSelected(m.mapName)} title={`${m.mapName} · revision ${m.revision} · ${m.regions} regions${m.synthetic ? " · synthetic test map" : ""}`}>
                            <span style={{ flex: 1 }}>
                              <span className="gc-select-name">{m.displayName}</span>
                              <div className="small muted">{m.cameras.length ? `${m.cameras.length} camera${m.cameras.length === 1 ? "" : "s"} · ${validated} validated` : "No cameras"}</div>
                            </span>
                            {m.mapName === current ? <Badge tone="ok">Live</Badge> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Panel>
                {sel ? <MapDetail key={sel} map={sel} reloadList={() => void maps.reload()} /> : null}
              </div>
            );
          }}
        </Async>
      )}
    </div>
  );
}
