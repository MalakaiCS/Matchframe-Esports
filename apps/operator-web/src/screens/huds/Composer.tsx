import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { api, seg } from "../../api/index.ts";
import type { HudOutputEntry, PublishedOutput } from "../../api/types.ts";
import { ActionButton, Async, Badge, Button, Checkbox, Field, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { previewUrl } from "./Outputs.tsx";

/** Layout elements of the built-in HUD. `hideKey` is the settings flag the renderer honours. */
export const COMPOSER_ELEMENTS = [
  { id: "scoreboard", label: "Scoreboard", hideKey: "hide.scoreboard", box: [660, 0, 600, 92] },
  { id: "history", label: "Round history", hideKey: "hide.history", box: [610, 96, 700, 40] },
  { id: "radar", label: "Radar", hideKey: "hide.radar", box: [24, 24, 320, 320] },
  { id: "killfeed", label: "Killfeed", hideKey: "hide.killfeed", box: [1436, 24, 460, 210] },
  { id: "players-left", label: "Players (left)", hideKey: "hide.players", box: [0, 690, 430, 390] },
  { id: "players-right", label: "Players (right)", hideKey: "hide.players", box: [1490, 690, 430, 390] },
  { id: "observed", label: "Observed player", hideKey: "hide.observed", box: [660, 910, 600, 150] },
] as const;

export type LayoutOffsets = Record<string, { dx: number; dy: number }>;

/** Builds the output `settings` object written by the composer (other settings are preserved). */
export function composeSettings(base: Record<string, unknown>, hidden: Record<string, boolean>, offsets: LayoutOffsets, reducedMotion: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(hidden)) {
    if (v) next[k] = true;
    else delete next[k];
  }
  const layout: LayoutOffsets = {};
  for (const [id, o] of Object.entries(offsets)) if (o.dx !== 0 || o.dy !== 0) layout[id] = { dx: Math.round(o.dx), dy: Math.round(o.dy) };
  if (Object.keys(layout).length) next.layout = layout;
  else delete next.layout;
  if (reducedMotion) next.reducedMotion = true;
  else delete next.reducedMotion;
  return next;
}

function readHidden(settings: Record<string, unknown>): Record<string, boolean> {
  const h: Record<string, boolean> = {};
  for (const el of COMPOSER_ELEMENTS) h[el.hideKey] = settings[el.hideKey] === true;
  return h;
}

function readOffsets(settings: Record<string, unknown>): LayoutOffsets {
  const raw = settings.layout;
  const out: LayoutOffsets = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const o = v as { dx?: unknown; dy?: unknown };
      if (typeof o?.dx === "number" && typeof o?.dy === "number") out[k] = { dx: o.dx, dy: o.dy };
    }
  }
  return out;
}

function Editor({ entry, reload }: { entry: HudOutputEntry; reload: () => void }) {
  const reason = usePermission("hud.publish");
  const base = entry.draft.settings;
  const [hidden, setHidden] = useState(() => readHidden(base));
  const [offsets, setOffsets] = useState<LayoutOffsets>(() => readOffsets(base));
  const [reducedMotion, setReducedMotion] = useState(base.reducedMotion === true);
  const [selected, setSelected] = useState<string>("scoreboard");
  const [underlay, setUnderlay] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; dx: number; dy: number } | null>(null);

  useEffect(() => {
    setHidden(readHidden(entry.draft.settings));
    setOffsets(readOffsets(entry.draft.settings));
    setReducedMotion(entry.draft.settings.reducedMotion === true);
  }, [entry.draft.settings]);

  const next = composeSettings(base, hidden, offsets, reducedMotion);
  const changed = JSON.stringify(next) !== JSON.stringify(base);
  const scale = () => 1920 / (stageRef.current?.getBoundingClientRect().width || 1920);
  const move = (id: string, dx: number, dy: number) => setOffsets((o) => ({ ...o, [id]: { dx, dy } }));
  const off = (id: string) => offsets[id] ?? { dx: 0, dy: 0 };
  const sel = COMPOSER_ELEMENTS.find((e) => e.id === selected)!;

  const onDown = (e: ReactPointerEvent, id: string) => {
    setSelected(id);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id, x: e.clientX, y: e.clientY, dx: off(id).dx, dy: off(id).dy };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const s = scale();
    move(d.id, Math.round((d.dx + (e.clientX - d.x) * s) / 2) * 2, Math.round((d.dy + (e.clientY - d.y) * s) / 2) * 2);
  };
  const onKey = (e: ReactKeyboardEvent, id: string) => {
    const step = e.shiftKey ? 10 : 1;
    const o = off(id);
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = map[e.key];
    if (!m) return;
    e.preventDefault();
    move(id, o.dx + m[0], o.dy + m[1]);
  };

  return (
    <div className="grid-2-1">
      <Panel title="Layout stage (1920×1080)" subtitle="Drag elements or use arrow keys (Shift = 10 px). Dashed = hidden." actions={<Checkbox checked={underlay} onChange={setUnderlay} label="Published output underneath" />}>
        <div className="stage" ref={stageRef} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
          {underlay && entry.published ? <iframe title="Published output" src={previewUrl(entry.url)} sandbox="allow-scripts allow-same-origin" tabIndex={-1} style={{ opacity: 0.55, pointerEvents: "none" }} /> : null}
          {COMPOSER_ELEMENTS.map((el) => {
            const [x, y, w, h] = el.box;
            const o = off(el.id);
            const isHidden = hidden[el.hideKey];
            return (
              <div
                key={el.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected === el.id}
                aria-label={`${el.label}${isHidden ? " (hidden)" : ""}, offset ${o.dx}, ${o.dy}`}
                className={`stage-el ${isHidden ? "is-hidden" : ""} ${selected === el.id ? "is-selected" : ""}`}
                style={{ left: `${((x + o.dx) / 1920) * 100}%`, top: `${((y + o.dy) / 1080) * 100}%`, width: `${(w / 1920) * 100}%`, height: `${(h / 1080) * 100}%` }}
                onPointerDown={(e) => onDown(e, el.id)}
                onKeyDown={(e) => onKey(e, el.id)}
                onFocus={() => setSelected(el.id)}
              >
                {el.label}
                {isHidden ? " · hidden" : ""}
              </div>
            );
          })}
        </div>
      </Panel>
      <div className="stack">
        <Panel title={`Element: ${sel.label}`}>
          <Checkbox checked={!hidden[sel.hideKey]} onChange={(v) => setHidden({ ...hidden, [sel.hideKey]: !v })} label={`Visible (${sel.hideKey})`} />
          {sel.hideKey === "hide.players" ? <p className="small muted">Both player panels share one visibility flag in the built-in HUD.</p> : null}
          <div className="form-grid">
            <Field label="Offset X (px)">
              <input type="number" value={off(sel.id).dx} onChange={(e) => move(sel.id, Number(e.target.value), off(sel.id).dy)} />
            </Field>
            <Field label="Offset Y (px)">
              <input type="number" value={off(sel.id).dy} onChange={(e) => move(sel.id, off(sel.id).dx, Number(e.target.value))} />
            </Field>
          </div>
          <div className="form-actions">
            <Button size="sm" onClick={() => move(sel.id, 0, 0)}>
              Reset position
            </Button>
          </div>
        </Panel>
        <Panel title="Output-wide">
          <Checkbox checked={reducedMotion} onChange={setReducedMotion} label="Reduced motion (reducedMotion)" />
          <div className="form-actions">
            <ActionButton
              variant="primary"
              action={() => api.patch(`/api/v1/hud/outputs/${seg(entry.draft.outputId)}`, { settings: next })}
              success="Layout saved to the draft"
              onDone={reload}
              disabledReason={reason ?? (changed ? null : "No layout changes")}
            >
              Save to draft
            </ActionButton>
            <ActionButton
              action={() => api.post<PublishedOutput>(`/api/v1/hud/outputs/${seg(entry.draft.outputId)}/publish`)}
              success={(p) => `Published revision ${p.revision}`}
              onDone={reload}
              disabledReason={reason ?? (changed ? "Save to draft first" : entry.dirty ? null : "Draft already published")}
              confirm={{ title: "Publish the draft?", body: "The browser source switches immediately; roll back from the Outputs tab if needed." }}
            >
              Publish draft
            </ActionButton>
          </div>
          {entry.dirty ? <Badge tone="warn">DRAFT DIFFERS FROM ON-AIR</Badge> : null}
          <details>
            <summary className="small">Settings that will be written</summary>
            <pre className="json-view">{JSON.stringify(next, null, 2)}</pre>
          </details>
        </Panel>
        <Note tone="warn" title="PREVIEW SCOPE">
          <strong>Implemented:</strong> element visibility (<code>hide.*</code>) and reduced motion — both applied by the built-in renderer — plus position offsets stored as <code>settings.layout</code> and applied by the built-in renderer, saved to the draft and published with revisions/rollback.
          <br />
          <strong>Not yet implemented (Full Suite):</strong> resize/scale handles, adding new layers (text, images, video), data bindings to HUD state fields, per-variant layouts, multi-step undo, and rendering the unpublished draft in the live preview (the underlay shows the published revision).
        </Note>
      </div>
    </div>
  );
}

export function ComposerTab() {
  const outputs = useApi<HudOutputEntry[]>("/api/v1/hud/outputs");
  const [selected, setSelected] = useState("main");
  return (
    <Async state={outputs}>
      {(list) => {
        const entry = list.find((o) => o.draft.outputId === selected) ?? list[0];
        return (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <Field label="Output">
                <select value={entry?.draft.outputId ?? ""} onChange={(e) => setSelected(e.target.value)}>
                  {list.map((o) => (
                    <option key={o.draft.outputId} value={o.draft.outputId}>
                      {o.draft.name} ({o.draft.outputId})
                    </option>
                  ))}
                </select>
              </Field>
              <Badge tone="info">COMPOSER (PREVIEW)</Badge>
            </div>
            {entry ? <Editor key={entry.draft.outputId} entry={entry} reload={() => void outputs.reload()} /> : <p className="muted">No outputs.</p>}
          </>
        );
      }}
    </Async>
  );
}
