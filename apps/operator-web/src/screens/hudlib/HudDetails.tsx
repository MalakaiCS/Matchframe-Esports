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
import { compareVersions, defaultVariant, formFields, hudLowFps, KIND_LABEL, resolutionLabel, STUTTER_MS, stutters, VARIANT_LABEL, variantUrl, withQuery } from "../../lib/hudLibrary.ts";
import { useLowSpec } from "../../lib/lowSpec.ts";
import { Link } from "../../router.tsx";
import type { HudActionReasons, HudActions } from "./HudCard.tsx";
import { OutputIndicators, Thumbnail } from "./HudCard.tsx";
import type { PlayerRow, TeamRow } from "../../api/types.ts";
import { useApi } from "../../lib/hooks.ts";
import { useLive } from "../../state/live.ts";
import { hudPath, useRun } from "./actions.ts";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

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
  onTab(tRow: DetailsTab): void;
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
    <section className="hud-details" aria-label={t("hudlib.nameDetails", { name: entry.name })} data-testid="hud-details">
      <div className="hud-details-tabs">
        <Tabs<DetailsTab>
          label={t("hudlib.hudDetails")}
          value={p.tab}
          onChange={p.onTab}
          tabs={[
            { id: "overview", label: t("hudlib.overview") },
            { id: "appearance", label: t("hudlib.appearance") },
            { id: "outputs", label: t("hudlib.outputs") },
          ]}
        />
        <span className="hud-details-name">{entry.name}</span>
        <button type="button" className="icon-btn" aria-label={t("hudlib.closeDetails")} title={t("hudlib.closeDetails")} onClick={p.onClose}>
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
  // Low-spec mode (ADR-078): no running HUD in the console unless asked for.
  const lowSpec = useLowSpec()?.lowSpec === true;
  const [showLive, setShowLive] = useState(false);
  const url = variantUrl(entry, variant);
  const r = entry.designResolution;
  if (!url) return <Note tone="neutral">{t("hudlib.thisHudHasNoOutput")}</Note>;
  if (lowSpec && !showLive)
    return (
      <div className="hud-preview-wrap" data-testid="hud-preview-paused">
        <Thumbnail entry={entry} className="hud-preview-still" />
        <div className="row hud-preview-foot">
          <Button size="sm" onClick={() => setShowLive(true)}>{t("hudlib.showLivePreview")}</Button>
          <span className="muted small">{t("hudlib.livePreviewOffInLow", { entry: resolutionLabel(entry) })}</span>
        </div>
      </div>
    );
  return (
    <div className="hud-preview-wrap">
      <div className="hud-preview" style={{ aspectRatio: `${r.width} / ${r.height}` }}>
        <iframe key={`${url}-${checker}`} title={t("hudlib.namePreview", { name: entry.name })} src={withQuery(url, { mode: "preview", embed: "1", checker: checker ? "1" : undefined })} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
      </div>
      <div className="row hud-preview-foot">
        <Checkbox checked={checker} onChange={setChecker} label={t("hudlib.checkerboard")} hint={t("hudlib.showsTransparentAreasAsA")} />
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
        <h3 className="hud-section-title">{t("hudlib.package")}</h3>
        <KV
          items={[
            [t("hudlib.id"), <code key="id">{entry.id}</code>],
            [t("hudlib.version"), entry.previousVersion ? t("hudlib.versionPreviousPreviousversion", { version: entry.version, previousVersion: entry.previousVersion }) : entry.version],
            [t("hudlib.author"), entry.author || "—"],
            [t("hudlib.licence"), entry.licence || "—"],
            [t("hudlib.game"), "Counter-Strike 2"],
            [t("hudlib.category"), entry.category ?? "—"],
            [t("hudlib.tags"), entry.tags.length ? entry.tags.join(", ") : "—"],
            [t("hudlib.source"), KIND_LABEL[entry.kind]],
            [t("hudlib.format"), entry.runtime === "compat" ? t("hudlib.importedHudHudJsonFormat") : t("hudlib.matchframeHud")],
            [t("hudlib.designSize"), resolutionLabel(entry)],
            [t("hudlib.installed"), fmtTime(entry.installedAt)],
            [t("hudlib.lastUsed"), entry.lastUsedAt ? fmtAgo(entry.lastUsedAt) : t("hudlib.never")],
          ]}
        />
        {canRollback ? (
          <div className="row">
            <Button size="sm" disabledReason={p.editReason} onClick={() => void run(t("hudlib.rollBack"), () => api.post(`${hudPath(entry.id)}/rollback`), t("hudlib.nameIsBackOnVersion", { name: entry.name, previousVersion: entry.previousVersion })).then(p.onChanged)}>{t("hudlib.rollBackToPreviousversion", { previousVersion: entry.previousVersion })}</Button>
          </div>
        ) : null}
      </section>
      <section>
        <h3 className="hud-section-title">{t("hudlib.folder")}</h3>
        {entry.folder ? (
          <div className="hud-folder">
            <code title={entry.folder}>{entry.folder}</code>
            <Button size="sm" onClick={p.actions.openFolder} disabledReason={p.reasons.openFolder ?? null}><T k="hudlib.iconOpenFolder" values={{ icon: <Icon name="folder" size={14} /> }} /></Button>
          </div>
        ) : (
          <p className="muted">{t("hudlib.partOfTheProgramNo")}</p>
        )}
      </section>
      <section>
        <h3 className="hud-section-title">{t("hudlib.variants")}</h3>
        <ul className="hud-variants">
          {entry.variants.map((v) => (
            <li key={v} className={v === variant ? "is-selected" : ""}>
              <button type="button" className="link-btn" onClick={() => setVariant(v)} aria-pressed={v === variant}>
                {VARIANT_LABEL[v]}
              </button>
              {entry.urls[v] ? <CopyButton text={entry.urls[v]!} label={t("hudlib.copyUrl")} /> : <span className="muted small">{t("hudlib.notImplemented")}</span>}
            </li>
          ))}
        </ul>
      </section>
      {entry.views.length ? (
        <section>
          <h3 className="hud-section-title">{t("hudlib.hudPages")}</h3>
          <p className="muted small">{t("hudlib.thisHudSOwnPages")}</p>
          <ul className="hud-variants" aria-label={t("hudlib.hudPages")}>
            {entry.views.map((v) => (
              <li key={v.id}>
                <span>
                  {v.label} <span className="muted small mono">{v.id}</span>
                </span>
                <CopyButton text={v.url} label={t("hudlib.copyUrl")} />
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

/** A player from MatchFrame's players, or from the game in progress (by Steam ID). */
function PlayerPicker({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const live = useLive((s) => s.snapshot?.state?.players ?? null);
  const options = new Map<string, string>();
  for (const p of players.data ?? []) if (p.steamId) options.set(p.steamId, p.displayName);
  for (const p of live ?? []) if (p.steamId && !options.has(p.steamId)) options.set(p.steamId, t("hudlib.nameInGame", { name: p.name }));
  const v = typeof value === "string" ? value : "";
  if (v && !options.has(v)) options.set(v, v);
  return (
    <Field label={label} hint={hint}>
      <select value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{t("hudlib.none")}</option>
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
        <option value="">{t("hudlib.none")}</option>
        {(teams.data ?? []).map((tRow) => (
          <option key={tRow.id} value={tRow.id}>
            {tRow.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Uploaded images (image inputs of imported HUDs, e.g. baseboard sponsors), in order. */
function ImagesInput({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint ?? t("hudlib.pngJpgWebpSvgOr")}>
      <div className="row">
        {ids.map((id, i) => (
          <span key={`${id}-${i}`} className="row">
            <img className="thumb" src={assetUrl(id)!} alt={`${label} ${i + 1}`} />
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(ids.filter((_, j) => j !== i))} aria-label={t("hudlib.removeImageV", { v: i + 1 })}>{t("hudlib.remove2")}</Button>
          </span>
        ))}
        <label className={`btn btn-sm ${disabled || busy || ids.length >= 20 ? "is-disabled" : ""}`}>
          {busy ? t("hudlib.uploading") : t("hudlib.addImages")}
          <input
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.svg,.gif"
            className="sr-only"
            aria-label={t("hudlib.addLabel", { label })}
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

/** Panel buttons (imported hud.json-format HUDs): each sends a one-off action to the running HUD. */
function ActionButtons({ hudId, name, label, field, disabled }: { hudId: string; name: string; label: string; field: HudSettingField; disabled: boolean }) {
  const run = useRun();
  return (
    <Field label={label} hint={field.description ?? t("hudlib.sendsTheActionToThe")}>
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
          <input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} spellCheck={false} aria-label={t("hudlib.labelHex", { label })} />
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
      toast.push("ok", t("hudlib.settingsSaved"), t("hudlib.everyOutputOfThisHud"));
      onChanged();
    } catch (e) {
      toast.push("danger", t("hudlib.savingSettingsFailed"), describeError(e));
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
      <p className="muted">{t("hudlib.savedPerHudOnThis")}</p>
      {entry.presets.length ? (
        <Field label={t("hudlib.preset")} hint={t("hudlib.aLookTheHudS")}>
          <select value={presetId ?? ""} onChange={(e) => setPresetId(e.target.value || null)} disabled={disabled}>
            {entry.presets.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {fields.length === 0 ? <Note tone="neutral">{t("hudlib.thisHudHasNoSettings")}</Note> : null}
      {groups.map(([group, list]) => (
        <fieldset key={group || "_"} className="settings-group">
          {group ? <legend>{group}</legend> : null}
          {list.map(([k, f]) => (
            <SettingInput key={k} hudId={entry.id} name={k} field={f} value={draft[k] ?? f.default} onChange={(v) => set(k, v)} disabled={disabled} />
          ))}
        </fieldset>
      ))}
      <div className="row">
        <Button variant="primary" disabledReason={editReason ?? (busy ? t("hudlib.saving") : dirty ? null : t("hudlib.noChangesToSave"))} onClick={() => void save(draft)}>{t("hudlib.saveSettings")}</Button>
        <Button
          disabledReason={editReason ?? (busy ? t("hudlib.saving") : null)}
          onClick={() => {
            const d = defaultsOf(entry.settingsSchema);
            setDraft(d);
            setJson(JSON.stringify(d, null, 2));
          }}
        >{t("hudlib.resetToDefaults")}</Button>
        {dirty ? <span className="muted small">{t("hudlib.unsavedChanges")}</span> : null}
      </div>
      <Details summary={t("hudlib.advancedEditAsJson")}>
        <JsonEditor label={t("hudlib.settingsJson")} value={json} onChange={setJson} rows={10} />
        {!parsed.ok ? <p className="text-danger small">{parsed.error}</p> : null}
        <div className="row">
          <Button disabledReason={editReason ?? (!parsed.ok ? t("hudlib.fixTheJsonFirst") : busy ? t("hudlib.saving") : null)} onClick={() => parsed.ok && (setDraft(parsed.value), void save(parsed.value))}>{t("hudlib.saveJson")}</Button>
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

  if (desktopReason || !bridge) return <Note tone="neutral">{desktopReason ?? t("hudlib.desktopHudsNeedTheMatchframe")}</Note>;
  if (!overlay?.open)
    return (
      <div className="stack">
        <p className="muted">{t("hudlib.aSeparateTransparentWindowOver")}</p>
        <div className="row">
          <Button variant="primary" onClick={actions.launch} disabledReason={reasons.launch ?? null}><T k="hudlib.iconLaunchTransparentHud" values={{ icon: <Icon name="play" size={14} /> }} /></Button>
        </div>
      </div>
    );
  const configure = (label: string, patch: Parameters<DesktopHudBridge["configure"]>[1]) => void run(label, () => bridge.configure(entry.id, patch));
  const scalePct = Math.round(overlay.scale * 100);
  return (
    <div className="stack">
      <div className="row">
        <Button onClick={() => void run(overlay.visible ? "Hide" : "Show", () => bridge.setVisible(entry.id, !overlay.visible))}>
          <Icon name={overlay.visible ? "eyeOff" : "eye"} size={14} /> {overlay.visible ? t("hudlib.hide") : t("hudlib.show")}
        </Button>
        <Button variant={overlay.editing ? "warn" : "secondary"} disabledReason={overlay.locked ? t("hudlib.unlockThePositionFirst") : null} onClick={() => void run(t("hudlib.editMode"), () => bridge.setEditing(entry.id, !overlay.editing))} aria-pressed={overlay.editing}>
          {overlay.editing ? t("hudlib.doneEditing") : t("hudlib.editPosition")}
        </Button>
        <Button onClick={actions.closeDesktop}>{t("hudlib.close")}</Button>
      </div>
      {overlay.editing ? <Note tone="warn" title={t("hudlib.editMode")}>{t("hudlib.theHudWindowCanBe")}</Note> : null}
      {overlay.status === "error" ? <Note tone="danger">{overlay.error ?? t("hudlib.theDesktopHudWindowFailed")}</Note> : null}
      <Field label={t("hudlib.monitor")}>
        <select value={overlay.displayId ?? ""} onChange={(e) => configure(t("hudlib.moveToMonitor"), { displayId: Number(e.target.value), fit: "display" })}>
          {overlay.displayId === null ? <option value="">{t("common.unknown")}</option> : null}
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {displayLabel(d)}
            </option>
          ))}
        </select>
      </Field>
      <div className="row hud-scale-row">
        <Field label={t("hudlib.scale")}>
          <input type="number" min={10} max={400} step={5} defaultValue={scalePct} key={scalePct} onBlur={(e) => Number(e.target.value) !== scalePct && configure("Scale", { scale: Math.min(4, Math.max(0.1, Number(e.target.value) / 100)) })} style={{ width: 90 }} />
        </Field>
        <Button size="sm" onClick={() => configure(t("hudlib.fitToMonitor"), { fit: "display" })}>{t("hudlib.fitToMonitor")}</Button>
        <Button size="sm" onClick={() => configure(t("hudlib.actualSize"), { fit: "native" })}>
          100 %
        </Button>
      </div>
      <p className="muted small hud-hint">{t("hudlib.scalesTheDesignSizeEntry", { entry: resolutionLabel(entry) })}</p>
      <div className="row">
        <Field label="X">
          <input type="number" value={pos.x} onChange={(e) => setPos({ ...pos, x: e.target.value })} onBlur={() => Number(pos.x) !== overlay.bounds.x && configure("Move", { bounds: { x: Math.round(Number(pos.x)) } })} style={{ width: 90 }} disabled={overlay.locked} />
        </Field>
        <Field label="Y">
          <input type="number" value={pos.y} onChange={(e) => setPos({ ...pos, y: e.target.value })} onBlur={() => Number(pos.y) !== overlay.bounds.y && configure("Move", { bounds: { y: Math.round(Number(pos.y)) } })} style={{ width: 90 }} disabled={overlay.locked} />
        </Field>
        <span className="muted small num">{t("hudlib.widthHeightWindow", { width: overlay.bounds.width, height: overlay.bounds.height })}</span>
      </div>
      <Checkbox checked={overlay.locked} onChange={(v) => configure(v ? "Lock" : "Unlock", { locked: v })} label={t("hudlib.lockPositionAndSize")} hint={t("hudlib.preventsEditModeAndMoves")} />
      {entry.variants.length > 1 ? (
        <Field label={t("hudlib.variant2")}>
          <select value={overlay.variant} onChange={(e) => configure("Variant", { variant: e.target.value as HudVariant })}>
            {entry.variants.map((v) => (
              <option key={v} value={v} disabled={!entry.urls[v]}>
                {VARIANT_LABEL[v]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <p className="muted small">{t("hudlib.positionSizeAndScaleAre")}</p>
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
      <h3 className="hud-section-title">{t("hudlib.hotkeys")}</h3>
      <p className="muted small">{t("hudlib.workWhileTheGameHas")}</p>
      <div className="row">
        <Field label={t("hudlib.showHideDesktopHud")} hint={state.registered.toggle ? t("hudlib.registered") : t("hudlib.notRegisteredAnotherProgramMay")}>
          <input value={draft.toggle} onChange={(e) => setDraft({ ...draft, toggle: e.target.value })} spellCheck={false} />
        </Field>
        <Field label={t("hudlib.emergencyHideAllHudGraphics")} hint={state.registered.emergencyHide ? t("hudlib.registered") : t("hudlib.notRegisteredAnotherProgramMay")}>
          <input value={draft.emergencyHide} onChange={(e) => setDraft({ ...draft, emergencyHide: e.target.value })} spellCheck={false} />
        </Field>
      </div>
      <div className="row">
        <Button size="sm" disabledReason={changed ? null : t("hudlib.noChanges")} onClick={() => void run("Hotkeys", () => bridge.setHotkeys(draft), t("hudlib.hotkeysSaved")).then((h) => h && setState(h))}>{t("hudlib.saveHotkeys")}</Button>
      </div>
    </section>
  );
}

/** An output that stopped drawing for a moment, or drew too few frames, in the last minute: where the lag comes from, and what helps. */
function StutterNote({ entry, outputs }: { entry: HudLibraryEntry; outputs: Record<HudOutputMode, number> }) {
  const lowSpec = useLowSpec()?.lowSpec === true;
  const obs = outputs.obs ? entry.smoothness.obs : undefined;
  const desktop = outputs.desktop ? entry.smoothness.desktop : undefined;
  const bad = [stutters(obs) ? ([t("hudlib.obsBrowserSource"), obs!] as const) : null, stutters(desktop) ? ([t("hudlib.desktopHud2"), desktop!] as const) : null].filter((x) => x !== null);
  if (!bad.length) return null;
  return (
    <Note tone="warn" title={t("hudlib.theHudIsStutteringWhere")}>
      {bad.map(([where, s]) => (
        <p key={where} className="small" style={{ margin: "0 0 6px" }}><T k="hudlib.vTheGameDataReaches" values={{ v: s.worstPauseMs >= STUTTER_MS ? (
            <><T k="hudlib.theWhereStoppedDrawingFor" values={{ where, strong: <strong className="num">{t("hudlib.worstpausemsMs", { worstPauseMs: s.worstPauseMs })}</strong>, pauses: s.pauses, fps: s.fps }} /></>
          ) : (
            <><T k="hudlib.theWhereDrewOnlyStrong" values={{ where, strong: <strong className="num">{s.fps}</strong>, frameCap: hudLowFps(s.frameCap), v: s.frameCap ? t("hudlib.withLowSpecModeS", { frameCap: s.frameCap }) : "" }} /></>
          ) }} /></p>
      ))}
      {stutters(obs) ? (
        <p className="small" style={{ margin: "0 0 6px" }}><T k="hudlib.inObsSettingsAdvancedSources" values={{ v: lowSpec ? (
            <><T k="hudlib.lowSpecModeSetsUse" tags={{ b: (c) => <strong>{c}</strong> }} /></>
          ) : (
            <><T k="hudlib.inTheBrowserSourceS" tags={{ b: (c) => <strong>{c}</strong> }} /></>
          ) }} tags={{ b: (c) => <strong>{c}</strong> }} /></p>
      ) : null}
      {stutters(desktop) ? (
        <p className="small" style={{ margin: "0 0 6px" }}><T k="hudlib.runCs2InFullscreenWindowed" tags={{ code: (c) => <code>{c}</code> }} /></p>
      ) : null}
      {!lowSpec ? (
        <p className="small" style={{ margin: 0 }}><T k="hudlib.cs2ObsAndMatchframeOn" tags={{ link: (c) => <Link to="/settings">{c}</Link> }} /></p>
      ) : null}
    </Note>
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
      <OutputIndicators outputs={p.outputs} smoothness={entry.smoothness} />
      <StutterNote entry={entry} outputs={p.outputs} />
      {newer ? <Note tone="neutral">{t("hudlib.thisHudWasRolledBack")}</Note> : null}
      <section>
        <h3 className="hud-section-title">{t("hudlib.desktopHud")}</h3>
        <DesktopControls {...p} />
      </section>
      <section>
        <h3 className="hud-section-title">{t("hudlib.obsBrowserSource")}</h3>
        <p className="muted small"><T k="hudlib.addABrowserSourceWith" values={{ strong: <strong className="num">{r.width}</strong>, strong2: <strong className="num">{r.height}</strong> }} /></p>
        {entry.variants.length > 1 ? (
          <Field label={t("hudlib.variant2")}>
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
            <CopyButton text={url} label={t("hudlib.copyUrl")} />
          </div>
        ) : (
          <Note tone="neutral">{t("hudlib.noObsOutputForThis")}</Note>
        )}
        <div className="row">
          <span className="muted small">{t("hudlib.theAddressContainsThisHud")}</span>
          <Button
            size="sm"
            disabledReason={p.editReason}
            onClick={() => void run(t("hudlib.newAccessKey"), () => api.post(`${hudPath(entry.id)}/rotate-token`), t("hudlib.newAccessKeyMadeUpdate")).then(p.onChanged)}
          >{t("hudlib.newAccessKey")}</Button>
        </div>
      </section>
      <section>
        <h3 className="hud-section-title">{t("hudlib.previewWindow")}</h3>
        <div className="row">
          <Button onClick={p.actions.preview} disabledReason={p.reasons.preview ?? null}><T k="hudlib.iconOpenPreviewWindow" values={{ icon: <Icon name="eye" size={14} /> }} /></Button>
          {p.overlay?.previews ? (
            <Button disabledReason={desktopReason} onClick={() => bridge && void bridge.closePreviews(entry.id)}>{t("hudlib.closePreviewsPreviews", { previews: p.overlay.previews })}</Button>
          ) : null}
        </div>
      </section>
      <Hotkeys bridge={bridge} desktopReason={desktopReason} />
    </div>
  );
}
