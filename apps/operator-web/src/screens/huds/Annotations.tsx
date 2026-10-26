import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { api } from "../../api/index.ts";
import type { HudAnnotation, HudOutputEntry } from "../../api/types.ts";
import { ActionButton, Badge, Button, Checkbox, Field, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { previewUrl } from "./Outputs.tsx";

/** Drops points closer than `minDist` (normalized units) and caps the count at the engine limit (500). */
export function simplifyPoints(points: [number, number][], minDist = 0.004, max = 500): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) out.push([Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]);
  }
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]!);
}

export function AnnotationsTab() {
  const reason = usePermission("hud.publish");
  const draft = useApi<{ key: string; value: HudAnnotation[] | null }>("/api/v1/settings/hud.annotationsDraft");
  const outputs = useApi<HudOutputEntry[]>("/api/v1/hud/outputs");
  const [items, setItems] = useState<HudAnnotation[]>([]);
  const [tool, setTool] = useState<"pencil" | "arrow">("arrow");
  const [color, setColor] = useState("#ffd23f");
  const [expiry, setExpiry] = useState("15");
  const [underlay, setUnderlay] = useState(true);
  const [current, setCurrent] = useState<[number, number][] | null>(null);
  const [onAir, setOnAir] = useState<boolean | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!loaded.current && draft.data) {
      loaded.current = true;
      setItems(draft.data.value ?? []);
    }
  }, [draft.data]);

  const pos = (e: ReactPointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const finish = () => {
    if (!current || current.length < 2) return setCurrent(null);
    const pts = tool === "arrow" ? [current[0]!, current[current.length - 1]!] : simplifyPoints(current);
    if (items.length >= 50) return setCurrent(null);
    setItems([...items, { id: `a${Date.now().toString(36)}${items.length}`, kind: tool, points: pts, color, expiresAtMs: null }]);
    setCurrent(null);
  };
  const withExpiry = (list: HudAnnotation[]) => list.map((a) => ({ ...a, expiresAtMs: expiry ? Date.now() + Number(expiry) * 1000 : null }));
  const main = outputs.data?.find((o) => o.draft.outputId === "main") ?? outputs.data?.[0];
  const poly = (pts: [number, number][]) => pts.map(([x, y]) => `${x * 1920},${y * 1080}`).join(" ");

  return (
    <div className="grid-2-1">
      <Panel title="Telestrator" subtitle="Draw on the 1920×1080 stage; coordinates are normalized and rendered by the HUD">
        <div className="stage">
          {underlay && main?.published ? <iframe title="On-air HUD underlay" src={previewUrl(main.url)} sandbox="allow-scripts allow-same-origin" tabIndex={-1} /> : null}
          <svg
            ref={svgRef}
            className="stage-annot"
            viewBox="0 0 1920 1080"
            role="img"
            aria-label={`Annotation canvas with ${items.length} drawing(s). Draw with the pointer.`}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setCurrent([pos(e)]);
            }}
            onPointerMove={(e) => current && setCurrent([...current, pos(e)])}
            onPointerUp={finish}
            onPointerLeave={() => current && finish()}
          >
            <defs>
              <marker id="op-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
              </marker>
            </defs>
            {items.map((a) => (
              <polyline key={a.id} points={poly(a.points)} stroke={a.color} strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" markerEnd={a.kind === "arrow" ? "url(#op-arrow)" : undefined} />
            ))}
            {current && current.length > 1 ? <polyline points={poly(tool === "arrow" ? [current[0]!, current[current.length - 1]!] : current)} stroke={color} strokeWidth={6} fill="none" strokeDasharray="12 8" markerEnd={tool === "arrow" ? "url(#op-arrow)" : undefined} /> : null}
          </svg>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="seg" role="radiogroup" aria-label="Drawing tool">
            {(["arrow", "pencil"] as const).map((t) => (
              <button key={t} role="radio" aria-checked={tool === t} className={`seg-btn ${tool === t ? "is-on" : ""}`} onClick={() => setTool(t)}>
                {t === "arrow" ? "Arrow" : "Pencil"}
              </button>
            ))}
          </div>
          <Field label="Colour">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
          <Field label="Expires after (s)" hint="empty = until cleared">
            <input type="number" min={1} value={expiry} onChange={(e) => setExpiry(e.target.value)} style={{ width: 110 }} />
          </Field>
          <Checkbox checked={underlay} onChange={setUnderlay} label="Show on-air HUD underneath" />
          <Button onClick={() => setItems(items.slice(0, -1))} disabled={items.length === 0}>
            Undo
          </Button>
          <Button onClick={() => setItems([])} disabled={items.length === 0}>
            Clear canvas
          </Button>
        </div>
      </Panel>
      <div className="stack">
        <Panel title="Publish" actions={onAir === null ? null : onAir ? <Badge tone="danger" icon="●">ON AIR</Badge> : <Badge>OFF AIR</Badge>}>
          <p className="small muted">{items.length} drawing(s) in the draft (max 50).</p>
          <div className="row">
            <ActionButton
              variant="primary"
              action={() => api.put<{ onAir: boolean; count: number }>("/api/v1/hud/annotations", { annotations: withExpiry(items), onAir: true })}
              success={(r) => `${r.count} annotation(s) on air${expiry ? ` for ${expiry} s` : ""}`}
              onDone={() => setOnAir(true)}
              disabledReason={reason ?? (items.length ? null : "Draw something first")}
            >
              Put on air
            </ActionButton>
            <ActionButton action={() => api.put("/api/v1/hud/annotations", { annotations: items, onAir: false })} success="Draft saved; annotations taken off air" onDone={() => setOnAir(false)} disabledReason={reason}>
              Save draft &amp; take off air
            </ActionButton>
          </div>
          <Note tone="neutral">Expiry uses this computer's clock (the engine runs on the same machine). Annotations render on every output whose profile is not “clean”.</Note>
        </Panel>
        <Panel title="Drawings">
          {items.length === 0 ? (
            <p className="muted small">Nothing drawn. Choose Arrow or Pencil and drag on the stage.</p>
          ) : (
            <ul className="list-plain">
              {items.map((a, i) => (
                <li key={a.id} className="row">
                  <span className="dot" style={{ background: a.color }} aria-hidden />
                  <span style={{ flex: 1 }}>
                    #{i + 1} {a.kind} · {a.points.length} pts
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((x) => x.id !== a.id))} aria-label={`Delete drawing ${i + 1}`}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
