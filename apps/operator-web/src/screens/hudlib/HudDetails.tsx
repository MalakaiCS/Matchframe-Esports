import { useEffect, useMemo, useState } from "react";
import type { HudLibraryEntry, HudOutputMode, HudSettingField, HudVariant } from "@matchframe/contracts";
import { api, describeError } from "../../api/index.ts";
import type { DesktopHudBridge, DisplayInfo, HotkeyState, OverlayState } from "../../api/desktop.ts";
import { assetUrl, uploadAsset } from "../../components/AssetUpload.tsx";
import { Icon } from "../../components/icons.tsx";
import { useToast } from "../../components/toasts.tsx";
import { Button, Checkbox, CopyButton, Details, Field, JsonEditor, KV, Note, parseJsonOr, Tabs } from "../../components/ui.tsx";
import { fmtAgo, fmtTime } from "../../lib/format.ts";
import type { HudDisplayStatus } from "../../lib/hudLibrary.ts";
import { compareVersions, defaultVariant, formFields, KIND_LABEL, resolutionLabel, VARIANT_LABEL, variantUrl, withQuery } from "../../lib/hudLibrary.ts";
import type { HudActionReasons, HudActions } from "./HudCard.tsx";
import { OutputIndicators } from "./HudCard.tsx";
import type { PlayerRow, TeamRow } from "../../api/types.ts";
import { useApi } from "../../lib/hooks.ts";
import { useLive } from "../../state/live.ts";
import { hudPath, useRun } from "./actions.ts";

export type DetailsTab = "overview" | "appearance" | "outputs";

interface Props {
  entry: HudLibraryEntry;
  status: HudDisplayStatus;
  statusDetail: string | null;
  outputs: Record<HudOutputMode, number>;
  overlay: OverlayState | undefined;
  bridge: DesktopHudBridge | null;
  /** Why desktop windows are unavailable here (browser, remote mode), or null. */
  desktopReason: string | null;
  editReason: string | null;
  tab: DetailsTab;
  onTab(t: DetailsTab): void;
  onClose(): void;
  onChanged(): void;
  actions: HudActions;
  reasons: HudActionReasons;
}

/**
 * A HUD's details, opened under its row in the library: a larger preview, package information,
 * variants, appearance settings and output controls.
 */
export function HudDetails(p: Props) {
  const { entry } = p;
  return (
    <section className="hud-details" aria-label={`${entry.name} details`} data-testid="hud-details">
      <div className="hud-details-tabs">
        <Tabs<DetailsTab>
          label="HUD details"
          value={p.tab}
          onChange={p.onTab}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "appearance", label: "Appearance" },
            { id: "outputs", label: "Outputs" },
          ]}
        />
        <span className="hud-details-name">{entry.name}</span>
        <button type="button" className="icon-btn" aria-label="Close details" title="Close details" onClick={p.onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="hud-details-body">
        {p.tab === "overview" ? <Overview {...p} /> : null}
        {p.tab === "appearance" ? <Appearance key={entry.id} entry={entry} editReason={p.editReason} onChanged={p.onChanged} /> : null}
        {p.tab === "outputs" ? <Outputs {...p} /> : null}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ overview

function LivePreview({ entry, variant }: { entry: HudLibraryEntry; variant: HudVariant }) {
  const [checker, setChecker] = useState(true);
  const url = variantUrl(entry, variant);
  const r = entry.designResolution;
  if (!url) return <Note tone="neutral">This HUD has no output to preview.</Note>;
  return (
    <div className="hud-preview-wrap">
      <div className="hud-preview" style={{ aspectRatio: `${r.width} / ${r.height}` }}>
        <iframe key={`${url}-${checker}`} title={`${entry.name} preview`} src={withQuery(url, { mode: "preview", embed: "1", checker: checker ? "1" : undefined })} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
      </div>
      <div className="row hud-preview-foot">
        <Checkbox checked={checker} onChange={setChecker} label="Checkerboard" hint="Shows transparent areas as a checkerboard" />
        <span className="muted small">
          {resolutionLabel(entry)} · {VARIANT_LABEL[variant]}
        </span>
      </div>
    </div>
  );
}

function Overview(p: Props) {
  const { entry } = p;
  const [variant, setVariant] = useState<HudVariant>(defaultVariant(entry));
  useEffect(() => setVariant(defaultVariant(entry)), [entry.id]);
  const run = useRun();
  const canRollback = !!entry.previousVersion && entry.kind !== "builtin";
  return (
    <div className="hud-overview">
      <div className="hud-overview-media stack">
        <LivePreview entry={entry} variant={variant} />
        {entry.description ? <p className="hud-details-desc">{entry.description}</p> : null}
      </div>
      <div className="hud-overview-info stack">
      <section>
        <h3 className="hud-section-title">Package</h3>
        <KV
          items={[
            ["Id", <code key="id">{entry.id}</code>],
            ["Version", entry.previousVersion ? `${entry.version} (previous ${entry.previousVersion})` : entry.version],
            ["Author", entry.author || "—"],
            ["Licence", entry.licence || "—"],
            ["Game", "Counter-Strike 2"],
            ["Category", entry.category ?? "—"],
            ["Tags", entry.tags.length ? entry.tags.join(", ") : "—"],
            ["Source", KIND_LABEL[entry.kind]],
            ["Format", entry.runtime === "lhm" ? "LHM-format HUD (runs in LHM compatibility mode: raw game data, Matchframe's teams and players, its panel as settings)" : "Matchframe HUD"],
            ["Design size", resolutionLabel(entry)],
            ["Installed", fmtTime(entry.installedAt)],
            ["Last used", entry.lastUsedAt ? fmtAgo(entry.lastUsedAt) : "Never"],
          ]}
        />
        {canRollback ? (
          <div className="row">
            <Button size="sm" disabledReason={p.editReason} onClick={() => void run("Roll back", () => api.post(`${hudPath(entry.id)}/rollback`), `${entry.name} is back on version ${entry.previousVersion}`).then(p.onChanged)}>
              Roll back to {entry.previousVersion}
            </Button>
          </div>
        ) : null}
      </section>
      <section>
        <h3 className="hud-section-title">Folder</h3>
        {entry.folder ? (
          <div className="hud-folder">
            <code title={entry.folder}>{entry.folder}</code>
            <Button size="sm" onClick={p.actions.openFolder} disabledReason={p.reasons.openFolder ?? null}>
              <Icon name="folder" size={14} /> Open Folder
            </Button>
          </div>
        ) : (
          <p className="muted">Part of the program (no folder).</p>
        )}
      </section>
      <section>
        <h3 className="hud-section-title">Variants</h3>
        <ul className="hud-variants">
          {entry.variants.map((v) => (
            <li key={v} className={v === variant ? "is-selected" : ""}>
              <button type="button" className="link-btn" onClick={() => setVariant(v)} aria-pressed={v === variant}>
                {VARIANT_LABEL[v]}
              </button>
              {entry.urls[v] ? <CopyButton text={entry.urls[v]!} label="Copy URL" /> : <span className="muted small">not implemented</span>}
            </li>
          ))}
        </ul>
      </section>
      {entry.views.length ? (
        <section>
          <h3 className="hud-section-title">HUD pages</h3>
          <p className="muted small">This HUD's own pages. Add each one you use as another OBS Browser Source, and show it when you need it.</p>
          <ul className="hud-variants" aria-label="HUD pages">
            {entry.views.map((v) => (
              <li key={v.id}>
                <span>
                  {v.label} <span className="muted small mono">{v.id}</span>
                </span>
                <CopyButton text={v.url} label="Copy URL" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ appearance (per-HUD settings)

/** A player from Matchframe's players, or from the game in progress (by Steam ID). */
function PlayerPicker({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const live = useLive((s) => s.snapshot?.state?.players ?? null);
  const options = new Map<string, string>();
  for (const p of players.data ?? []) if (p.steamId) options.set(p.steamId, p.displayName);
  for (const p of live ?? []) if (p.steamId && !options.has(p.steamId)) options.set(p.steamId, `${p.name} (in game)`);
  const v = typeof value === "string" ? value : "";
  if (v && !options.has(v)) options.set(v, v);
  return (
    <Field label={label} hint={hint}>
      <select value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">None</option>
        {[...options].map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TeamPicker({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const teams = useApi<TeamRow[]>("/api/v1/teams");
  const v = typeof value === "string" ? value : "";
  return (
    <Field label={label} hint={hint}>
      <select value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">None</option>
        {(teams.data ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Uploaded images (LHM image inputs, e.g. kaiHUD's baseboard sponsors), in order. */
function ImagesInput({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint ?? "PNG, JPG, WebP, SVG or GIF; up to 20."}>
      <div className="row">
        {ids.map((id, i) => (
          <span key={`${id}-${i}`} className="row">
            <img className="thumb" src={assetUrl(id)!} alt={`${label} ${i + 1}`} />
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(ids.filter((_, j) => j !== i))} aria-label={`Remove image ${i + 1}`}>
              Remove
            </Button>
          </span>
        ))}
        <label className={`btn btn-sm ${disabled || busy || ids.length >= 20 ? "is-disabled" : ""}`}>
          {busy ? "Uploading…" : "Add images"}
          <input
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.svg,.gif"
            className="sr-only"
            aria-label={`Add ${label}`}
            disabled={disabled || busy || ids.length >= 20}
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (!files.length) return;
              setBusy(true);
              setError(null);
              try {
                const added: string[] = [];
                for (const f of files) added.push((await uploadAsset(f)).assetId);
                onChange([...ids, ...added].slice(0, 20));
              } catch (err) {
                setError(describeError(err));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      </div>
      {error ? <span className="action-error">{error}</span> : null}
    </Field>
  );
}

/** Panel buttons (LHM-format HUDs): each sends a one-off action to the running HUD. */
function ActionButtons({ hudId, name, label, field, disabled }: { hudId: string; name: string; label: string; field: HudSettingField; disabled: boolean }) {
  const run = useRun();
  return (
    <Field label={label} hint={field.description ?? "Sends the action to the HUD straight away."}>
      <div className="row">
        {(field.options ?? []).map((o) => (
          <Button key={o.value} size="sm" disabled={disabled} onClick={() => void run(o.label, () => api.post(`${hudPath(hudId)}/action`, { key: name, value: o.value }), `${o.label}: sent`)}>
            {o.label}
          </Button>
        ))}
      </div>
    </Field>
  );
}

function SettingInput({ hudId, name, field, value, onChange, disabled }: { hudId: string; name: string; field: HudSettingField; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const label = field.label ?? name;
  const hint = field.description;
  if (field.type === "player") return <PlayerPicker label={label} hint={hint} value={value} onChange={onChange} disabled={disabled} />;
  if (field.type === "team") return <TeamPicker label={label} hint={hint} value={value} onChange={onChange} disabled={disabled} />;
  if (field.type === "action") return <ActionButtons hudId={hudId} name={name} label={label} field={field} disabled={disabled} />;
  if (field.type === "images") return <ImagesInput label={label} hint={hint} value={value} onChange={onChange} disabled={disabled} />;
  if (field.type === "boolean") return <Checkbox checked={value === true} onChange={onChange} label={label} hint={hint} disabled={disabled} />;
  if (field.type === "select")
    return (
      <Field label={label} hint={hint}>
        <select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  if (field.type === "color")
    return (
      <Field label={label} hint={hint}>
        <span className="color-input">
          <input type="color" value={typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
          <input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} spellCheck={false} aria-label={`${label} (hex)`} />
        </span>
      </Field>
    );
  if (field.type === "number")
    return (
      <Field label={label} hint={hint}>
        <input
          type={field.min !== undefined && field.max !== undefined ? "range" : "number"}
          min={field.min}
          max={field.max}
          step={field.step ?? "any"}
          value={typeof value === "number" ? value : Number(field.default ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
        />
        {field.min !== undefined && field.max !== undefined ? <span className="muted small num"> {typeof value === "number" ? value : String(field.default ?? "")}</span> : null}
      </Field>
    );
  return (
    <Field label={label} hint={hint}>
      <input value={typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    </Field>
  );
}

function defaultsOf(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(schema)) if (f && typeof f === "object" && "default" in f) out[k] = (f as { default: unknown }).default;
  return out;
}

function Appearance({ entry, editReason, onChanged }: { entry: HudLibraryEntry; editReason: string | null; onChanged: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...entry.settings }));
  const [presetId, setPresetId] = useState<string | null>(entry.presetId);
  const [json, setJson] = useState(() => JSON.stringify(entry.settings, null, 2));
  const [busy, setBusy] = useState(false);
  const fields = useMemo(() => formFields(entry.settingsSchema), [entry.settingsSchema]);
  const groups = useMemo(() => {
    const m = new Map<string, [string, HudSettingField][]>();
    for (const f of fields) {
      const g = f[1].group ?? "";
      m.set(g, [...(m.get(g) ?? []), f]);
    }
    return [...m.entries()];
  }, [fields]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(entry.settings) || presetId !== entry.presetId;
  // Another window (or an import) changed the saved settings: follow them unless there are unsaved edits.
  useEffect(() => {
    if (dirty) return;
    setDraft({ ...entry.settings });
    setPresetId(entry.presetId);
    setJson(JSON.stringify(entry.settings, null, 2));
  }, [entry.settings, entry.presetId]);

  const save = async (settings: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.put(`${hudPath(entry.id)}/settings`, { settings, ...(entry.presets.length ? { presetId } : {}) });
      toast.push("ok", "Settings saved", "Every output of this HUD shows the change now.");
      onChanged();
    } catch (e) {
      toast.push("danger", "Saving settings failed", describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: string, v: unknown) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    setJson(JSON.stringify(next, null, 2));
  };
  const parsed = parseJsonOr<Record<string, unknown>>(json, {});
  const disabled = !!editReason || busy;
  return (
    <div className="stack">
      <p className="muted">Saved per HUD on this computer. Saving applies the change live to the desktop HUD, OBS sources and previews; nothing reloads.</p>
      {entry.presets.length ? (
        <Field label="Preset" hint="A look the HUD's author prepared; your settings below apply on top.">
          <select value={presetId ?? ""} onChange={(e) => setPresetId(e.target.value || null)} disabled={disabled}>
            {entry.presets.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {fields.length === 0 ? <Note tone="neutral">This HUD has no settings form. Advanced settings can still be edited as JSON below.</Note> : null}
      {groups.map(([group, list]) => (
        <fieldset key={group || "_"} className="settings-group">
          {group ? <legend>{group}</legend> : null}
          {list.map(([k, f]) => (
            <SettingInput key={k} hudId={entry.id} name={k} field={f} value={draft[k] ?? f.default} onChange={(v) => set(k, v)} disabled={disabled} />
          ))}
        </fieldset>
      ))}
      <div className="row">
        <Button variant="primary" disabledReason={editReason ?? (busy ? "Saving…" : dirty ? null : "No changes to save")} onClick={() => void save(draft)}>
          Save settings
        </Button>
        <Button
          disabledReason={editReason ?? (busy ? "Saving…" : null)}
          onClick={() => {
            const d = defaultsOf(entry.settingsSchema);
            setDraft(d);
            setJson(JSON.stringify(d, null, 2));
          }}
        >
          Reset to defaults
        </Button>
        {dirty ? <span className="muted small">Unsaved changes</span> : null}
      </div>
      <Details summary="Advanced: edit as JSON">
        <JsonEditor label="Settings (JSON)" value={json} onChange={setJson} rows={10} />
        {!parsed.ok ? <p className="text-danger small">{parsed.error}</p> : null}
        <div className="row">
          <Button disabledReason={editReason ?? (!parsed.ok ? "Fix the JSON first" : busy ? "Saving…" : null)} onClick={() => parsed.ok && (setDraft(parsed.value), void save(parsed.value))}>
            Save JSON
          </Button>
        </div>
      </Details>
    </div>
  );
}

// ------------------------------------------------------------------ outputs

function displayLabel(d: DisplayInfo): string {
  return `${d.label}${d.primary ? " (main)" : ""} · ${d.pixels.width}×${d.pixels.height} · ${Math.round(d.scaleFactor * 100)} %`;
}

function DesktopControls({ entry, overlay, bridge, desktopReason, actions, reasons }: Props) {
  const run = useRun();
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [pos, setPos] = useState<{ x: string; y: string }>({ x: "", y: "" });
  useEffect(() => {
    if (!bridge || desktopReason) return;
    let alive = true;
    void bridge
      .displays()
      .then((d) => alive && setDisplays(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bridge, desktopReason, overlay?.displayId]);
  useEffect(() => {
    if (overlay) setPos({ x: String(overlay.bounds.x), y: String(overlay.bounds.y) });
  }, [overlay?.bounds.x, overlay?.bounds.y]);

  if (desktopReason || !bridge) return <Note tone="neutral">{desktopReason ?? "Desktop HUDs need the Matchframe program."}</Note>;
  if (!overlay?.open)
    return (
      <div className="stack">
        <p className="muted">A separate transparent window over the game: always on top, click-through and never takes keyboard focus. Use the game's Fullscreen Windowed (borderless) mode; exclusive fullscreen is not supported.</p>
        <div className="row">
          <Button variant="primary" onClick={actions.launch} disabledReason={reasons.launch ?? null}>
            <Icon name="play" size={14} /> Launch Transparent HUD
          </Button>
        </div>
      </div>
    );
  const configure = (label: string, patch: Parameters<DesktopHudBridge["configure"]>[1]) => void run(label, () => bridge.configure(entry.id, patch));
  const scalePct = Math.round(overlay.scale * 100);
  return (
    <div className="stack">
      <div className="row">
        <Button onClick={() => void run(overlay.visible ? "Hide" : "Show", () => bridge.setVisible(entry.id, !overlay.visible))}>
          <Icon name={overlay.visible ? "eyeOff" : "eye"} size={14} /> {overlay.visible ? "Hide" : "Show"}
        </Button>
        <Button variant={overlay.editing ? "warn" : "secondary"} disabledReason={overlay.locked ? "Unlock the position first" : null} onClick={() => void run("Edit mode", () => bridge.setEditing(entry.id, !overlay.editing))} aria-pressed={overlay.editing}>
          {overlay.editing ? "Done editing" : "Edit position"}
        </Button>
        <Button onClick={actions.closeDesktop}>Close</Button>
      </div>
      {overlay.editing ? <Note tone="warn" title="Edit mode">The HUD window can be dragged now and catches the mouse. Click Done editing to make it click-through again.</Note> : null}
      {overlay.status === "error" ? <Note tone="danger">{overlay.error ?? "The desktop HUD window failed to load."}</Note> : null}
      <Field label="Monitor">
        <select value={overlay.displayId ?? ""} onChange={(e) => configure("Move to monitor", { displayId: Number(e.target.value), fit: "display" })}>
          {overlay.displayId === null ? <option value="">Unknown</option> : null}
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {displayLabel(d)}
            </option>
          ))}
        </select>
      </Field>
      <div className="row hud-scale-row">
        <Field label="Scale (%)">
          <input type="number" min={10} max={400} step={5} defaultValue={scalePct} key={scalePct} onBlur={(e) => Number(e.target.value) !== scalePct && configure("Scale", { scale: Math.min(4, Math.max(0.1, Number(e.target.value) / 100)) })} style={{ width: 90 }} />
        </Field>
        <Button size="sm" onClick={() => configure("Fit to monitor", { fit: "display" })}>
          Fit to monitor
        </Button>
        <Button size="sm" onClick={() => configure("Actual size", { fit: "native" })}>
          100 %
        </Button>
      </div>
      <p className="muted small hud-hint">Scales the design size {resolutionLabel(entry)} evenly; the HUD is never stretched.</p>
      <div className="row">
        <Field label="X">
          <input type="number" value={pos.x} onChange={(e) => setPos({ ...pos, x: e.target.value })} onBlur={() => Number(pos.x) !== overlay.bounds.x && configure("Move", { bounds: { x: Math.round(Number(pos.x)) } })} style={{ width: 90 }} disabled={overlay.locked} />
        </Field>
        <Field label="Y">
          <input type="number" value={pos.y} onChange={(e) => setPos({ ...pos, y: e.target.value })} onBlur={() => Number(pos.y) !== overlay.bounds.y && configure("Move", { bounds: { y: Math.round(Number(pos.y)) } })} style={{ width: 90 }} disabled={overlay.locked} />
        </Field>
        <span className="muted small num">
          {overlay.bounds.width}×{overlay.bounds.height} window
        </span>
      </div>
      <Checkbox checked={overlay.locked} onChange={(v) => configure(v ? "Lock" : "Unlock", { locked: v })} label="Lock position and size" hint="Prevents edit mode and moves until unlocked" />
      {entry.variants.length > 1 ? (
        <Field label="Variant">
          <select value={overlay.variant} onChange={(e) => configure("Variant", { variant: e.target.value as HudVariant })}>
            {entry.variants.map((v) => (
              <option key={v} value={v} disabled={!entry.urls[v]}>
                {VARIANT_LABEL[v]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <p className="muted small">Position, size and scale are remembered for this HUD on this computer.</p>
    </div>
  );
}

function Hotkeys({ bridge, desktopReason }: { bridge: DesktopHudBridge | null; desktopReason: string | null }) {
  const run = useRun();
  const [state, setState] = useState<HotkeyState | null>(null);
  const [draft, setDraft] = useState({ toggle: "", emergencyHide: "" });
  useEffect(() => {
    if (!bridge || desktopReason) return;
    void bridge
      .hotkeys()
      .then((h) => {
        setState(h);
        setDraft({ toggle: h.toggle, emergencyHide: h.emergencyHide });
      })
      .catch(() => undefined);
  }, [bridge, desktopReason]);
  if (!bridge || desktopReason || !state) return null;
  const changed = draft.toggle !== state.toggle || draft.emergencyHide !== state.emergencyHide;
  return (
    <section>
      <h3 className="hud-section-title">Hotkeys</h3>
      <p className="muted small">Work while the game has focus. Use Electron accelerator names, for example CommandOrControl+Shift+H.</p>
      <div className="row">
        <Field label="Show / hide desktop HUD" hint={state.registered.toggle ? "Registered" : "Not registered: another program may use it"}>
          <input value={draft.toggle} onChange={(e) => setDraft({ ...draft, toggle: e.target.value })} spellCheck={false} />
        </Field>
        <Field label="Emergency hide (all HUD graphics, OBS too)" hint={state.registered.emergencyHide ? "Registered" : "Not registered: another program may use it"}>
          <input value={draft.emergencyHide} onChange={(e) => setDraft({ ...draft, emergencyHide: e.target.value })} spellCheck={false} />
        </Field>
      </div>
      <div className="row">
        <Button size="sm" disabledReason={changed ? null : "No changes"} onClick={() => void run("Hotkeys", () => bridge.setHotkeys(draft), "Hotkeys saved").then((h) => h && setState(h))}>
          Save hotkeys
        </Button>
      </div>
    </section>
  );
}

function Outputs(p: Props) {
  const { entry, bridge, desktopReason } = p;
  const run = useRun();
  const [variant, setVariant] = useState<HudVariant>(defaultVariant(entry));
  const url = variantUrl(entry, variant);
  const r = entry.designResolution;
  const newer = entry.previousVersion && compareVersions(entry.version, entry.previousVersion) < 0;
  return (
    <div className="stack">
      <OutputIndicators outputs={p.outputs} />
      {newer ? <Note tone="neutral">This HUD was rolled back to an older version.</Note> : null}
      <section>
        <h3 className="hud-section-title">Desktop HUD</h3>
        <DesktopControls {...p} />
      </section>
      <section>
        <h3 className="hud-section-title">OBS browser source</h3>
        <p className="muted small">
          Add a Browser Source with this URL, width <strong className="num">{r.width}</strong> and height <strong className="num">{r.height}</strong>, above your Game Capture. The page has a transparent background and shows only the HUD.
        </p>
        {entry.variants.length > 1 ? (
          <Field label="Variant">
            <select value={variant} onChange={(e) => setVariant(e.target.value as HudVariant)}>
              {entry.variants.map((v) => (
                <option key={v} value={v} disabled={!entry.urls[v]}>
                  {VARIANT_LABEL[v]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {url ? (
          <div className="hud-url">
            <code title={url}>{url}</code>
            <CopyButton text={url} label="Copy URL" />
          </div>
        ) : (
          <Note tone="neutral">No OBS output for this variant.</Note>
        )}
        <div className="row">
          <span className="muted small">The address contains this HUD's access key. If it leaks, make a new one; sources with the old address stop working.</span>
          <Button
            size="sm"
            disabledReason={p.editReason}
            onClick={() => void run("New access key", () => api.post(`${hudPath(entry.id)}/rotate-token`), "New access key made: update the URL in OBS").then(p.onChanged)}
          >
            New access key
          </Button>
        </div>
      </section>
      <section>
        <h3 className="hud-section-title">Preview window</h3>
        <div className="row">
          <Button onClick={p.actions.preview} disabledReason={p.reasons.preview ?? null}>
            <Icon name="eye" size={14} /> Open preview window
          </Button>
          {p.overlay?.previews ? (
            <Button disabledReason={desktopReason} onClick={() => bridge && void bridge.closePreviews(entry.id)}>
              Close previews ({p.overlay.previews})
            </Button>
          ) : null}
        </div>
      </section>
      <Hotkeys bridge={bridge} desktopReason={desktopReason} />
    </div>
  );
}
