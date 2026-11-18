import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { api } from "../../api/index.ts";
import type { HudAnnotation, HudOutputEntry } from "../../api/types.ts";
import { ActionButton, Badge, Button, Checkbox, Field, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { previewUrl } from "./Outputs.tsx";
import { t } from "../../i18n/index.ts";

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
      <Panel title={t("huds.telestrator")} subtitle={t("huds.dragOnTheStageTo")}>
        <div className="stage">
          {underlay && main?.published ? <iframe title={t("huds.onAirHudUnderlay")} src={previewUrl(main.url)} sandbox="allow-scripts allow-same-origin" tabIndex={-1} /> : null}
          <svg
            ref={svgRef}
            className="stage-annot"
            viewBox="0 0 1920 1080"
            role="img"
            aria-label={t("huds.annotationCanvasWithCountDrawing", { count: items.length })}
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
          <div className="seg" role="radiogroup" aria-label={t("huds.drawingTool")}>
            {(["arrow", "pencil"] as const).map((tRow) => (
              <button key={tRow} role="radio" aria-checked={tool === tRow} className={`seg-btn ${tool === tRow ? "is-on" : ""}`} onClick={() => setTool(tRow)}>
                {tRow === "arrow" ? t("huds.arrow") : t("huds.pencil")}
              </button>
            ))}
          </div>
          <Field label={t("huds.colour")}>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
          <Field label={t("huds.expiresAfterS")} hint={t("huds.emptyUntilCleared")}>
            <input type="number" min={1} value={expiry} onChange={(e) => setExpiry(e.target.value)} style={{ width: 110 }} />
          </Field>
          <Checkbox checked={underlay} onChange={setUnderlay} label={t("huds.showOnAirHudUnderneath")} />
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => setItems(items.slice(0, -1))} disabled={items.length === 0}>{t("huds.undo")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setItems([])} disabled={items.length === 0}>{t("huds.clearCanvas")}</Button>
        </div>
      </Panel>
      <Panel title={t("huds.drawings")} className="gb-start" subtitle={t("huds.countOf50", { count: items.length })} actions={onAir === null ? null : onAir ? <Badge tone="danger" icon="●">{t("huds.onAir")}</Badge> : <Badge>{t("huds.offAir")}</Badge>}>
        <div className="row">
          <ActionButton
            variant="primary"
            action={() => api.put<{ onAir: boolean; count: number }>("/api/v1/hud/annotations", { annotations: withExpiry(items), onAir: true })}
            success={(r) => t("huds.countAnnotationSOnAir", { count: r.count, v: expiry ? t("huds.forExpiryS", { expiry }) : "" })}
            onDone={() => setOnAir(true)}
            disabledReason={reason ?? (items.length ? null : t("huds.drawSomethingFirst"))}
          >{t("huds.putOnAir")}</ActionButton>
          <ActionButton action={() => api.put("/api/v1/hud/annotations", { annotations: items, onAir: false })} success={t("huds.draftSavedAnnotationsTakenOff")} onDone={() => setOnAir(false)} disabledReason={reason}>{t("huds.saveDraftTakeOffAir")}</ActionButton>
        </div>
        <p className="small muted" title={t("huds.expiryUsesThisComputerS")}>{t("huds.shownOnEveryOutputExcept")}</p>
        {items.length === 0 ? (
          <p className="muted small">{t("huds.nothingDrawnYetChooseArrow")}</p>
        ) : (
          <ul className="list-plain">
            {items.map((a, i) => (
              <li key={a.id} className="row">
                <span className="dot" style={{ background: a.color }} aria-hidden />
                <span style={{ flex: 1 }}>{t("huds.vKindCountPts", { v: i + 1, kind: a.kind, count: a.points.length })}</span>
                <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((x) => x.id !== a.id))} aria-label={t("huds.deleteDrawingV", { v: i + 1 })}>{t("huds.delete")}</Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
