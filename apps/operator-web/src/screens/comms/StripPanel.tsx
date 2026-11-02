import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { AssetUpload } from "../../components/AssetUpload.tsx";
import { useToast } from "../../components/toasts.tsx";
import { Button, Checkbox, CopyButton, Details, Field, Note, Panel } from "../../components/ui.tsx";
import { usePermission } from "../../state/session.tsx";
import { StripCard } from "./StripCard.tsx";
import type { CommsView, PortraitCrop, StripAnchor, StripSettings, StripStatus } from "./types.ts";

type Reload = () => void;

const ANCHORS: [StripAnchor, string][] = [
  ["bottom-center", "Bottom centre"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
  ["top-center", "Top centre"],
  ["top-left", "Top left"],
  ["top-right", "Top right"],
];

const PICTURE: Record<StripStatus["cards"][number]["picture"], string> = {
  own: "roster picture",
  "hud-default": "HUD images' default picture",
  placeholder: "placeholder picture (Team Comms, else the default player picture)",
  silhouette: "MatchFrame's silhouette",
};

/**
 * The recording's speaker strip (ADR-068): the cards as they are now (who is lit), its look and
 * place, its timing, the placeholder and each portrait's crop. Only ever in the recording's scene.
 */
export function StripPanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const st = view.strip;
  const s = st.settings;
  const reason = usePermission("program.control");
  const toast = useToast();
  const save = async (patch: Partial<Omit<StripSettings, "crops">>) => {
    try {
      await api.put("/api/v1/comms/strip", patch);
      onChanged();
    } catch (e) {
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  const lit = new Set(st.speaking);
  const num = (k: "offsetX" | "offsetY" | "cardPx" | "gapPx" | "borderPx" | "attackMs" | "releaseMs" | "timingOffsetMs", label: string, min: number, max: number, hint?: string) => (
    <Field label={label} hint={hint}>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        defaultValue={s[k]}
        key={`${k}-${s[k]}`}
        disabled={!!reason}
        style={{ width: 96 }}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= min && v <= max && v !== s[k]) void save({ [k]: v });
        }}
      />
    </Field>
  );
  return (
    <Panel title="Speaker strip (recording only)" subtitle="The included people of the recording's team, grey while silent, in colour with a green frame while their voice is in the recording. Never on the public output.">
      <div className="stack-sm">
        <div className="strip-preview" aria-label="Speaker strip now">
          {st.cards.length === 0 ? (
            <p className="muted small">No cards: {view.recorder.settings.teamId ? "nobody of the recording team is included in the recording." : "choose the recording team."}</p>
          ) : (
            st.cards.map((c) => (
              <figure key={c.id} className="strip-preview-card">
                <StripCard name={c.name} pictureUrl={c.pictureUrl} crop={c.crop} speaking={lit.has(c.name)} settings={s} size={72} />
                <figcaption className="small">
                  {c.name}
                  {lit.has(c.name) ? " · speaking" : ""}
                </figcaption>
              </figure>
            ))
          )}
        </div>
        {st.warning ? <Note tone="warn">{st.warning}</Note> : null}
        <p className="small">
          {st.pages ? `${st.pages} strip page${st.pages === 1 ? "" : "s"} connected (OBS's is one).` : "No strip page connected: set up the recording scene in OBS."} Address for the recording scene only (its own token):
        </p>
        <div className="row">
          <input readOnly value={st.url} aria-label="Speaker strip address" spellCheck={false} />
          <CopyButton text={st.url} />
        </div>
        <div className="row-end">
          <Field label="Anchor">
            <select aria-label="Anchor" value={s.anchor} disabled={!!reason} onChange={(e) => void save({ anchor: e.target.value as StripAnchor })}>
              {ANCHORS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {num("offsetX", "Across (px)", -1920, 1920)}
          {num("offsetY", "From the edge (px)", 0, 1080)}
          {num("cardPx", "Card size (px)", 48, 400)}
          {num("gapPx", "Spacing (px)", 0, 200)}
          {num("borderPx", "Frame (px)", 1, 30)}
        </div>
        <div className="row-end">
          <Field label="Speaking colour">
            <input type="color" aria-label="Speaking colour" value={s.activeColor.toLowerCase()} disabled={!!reason} onChange={(e) => void save({ activeColor: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Silent colour">
            <input type="color" aria-label="Silent colour" value={s.idleColor.toLowerCase()} disabled={!!reason} onChange={(e) => void save({ idleColor: e.target.value.toUpperCase() })} />
          </Field>
          {num("releaseMs", "Release (ms)", 0, 3000, "Lit this long after the voice stops.")}
          {num("attackMs", "Attack (ms)", 0, 500, "Speaking this long before it lights.")}
          {num("timingOffsetMs", "Timing offset (ms)", -1000, 2000, "Later (+) or earlier (−) than the comms, as measured in a recording.")}
        </div>
        <div className="row">
          <Checkbox checked={s.labels} disabled={!!reason} label="Names under the portraits" hint="Off by default." onChange={(v) => void save({ labels: v })} />
          <Checkbox checked={s.useHudDefaults} disabled={!!reason} label="HUD images' default player pictures" hint="For mapped players without a picture." onChange={(v) => void save({ useHudDefaults: v })} />
        </div>
        <AssetUpload label="Placeholder silhouette (anyone without a portrait)" value={s.placeholderAssetId} disabledReason={reason} onChange={(id) => void save({ placeholderAssetId: id })} />
        <Details summary="Portrait crops">
          <div className="stack-sm">
            {st.cards.length === 0 ? <p className="muted small">The recording team's included people appear here.</p> : null}
            {st.cards.map((c) => (
              <CropEditor key={c.cropKey} name={c.name} picture={PICTURE[c.picture]} pictureUrl={c.pictureUrl} crop={c.crop} cropKey={c.cropKey} settings={s} disabledReason={reason} onChanged={onChanged} />
            ))}
          </div>
        </Details>
      </div>
    </Panel>
  );
}

function CropEditor({ name, picture, pictureUrl, crop, cropKey, settings, disabledReason, onChanged }: { name: string; picture: string; pictureUrl: string; crop: PortraitCrop; cropKey: string; settings: StripSettings; disabledReason: string | null; onChanged: Reload }) {
  const [c, setC] = useState(crop);
  const toast = useToast();
  // The page refreshes every 300 ms: only a changed crop (not a new object with the same values) resets the sliders.
  useEffect(() => setC({ x: crop.x, y: crop.y, zoom: crop.zoom }), [crop.x, crop.y, crop.zoom]);
  const put = async (next: PortraitCrop | null) => {
    try {
      await api.put("/api/v1/comms/strip/crop", { key: cropKey, crop: next });
      onChanged();
    } catch (e) {
      toast.push("danger", "Crop not saved", describeError(e));
    }
  };
  const slider = (k: keyof PortraitCrop, label: string, min: number, max: number, step: number) => (
    <label className="comms-level small">
      {label}
      <input type="range" aria-label={`${name}: ${label}`} min={min} max={max} step={step} value={c[k]} disabled={!!disabledReason} onChange={(e) => setC({ ...c, [k]: Number(e.target.value) })} onMouseUp={() => void put(c)} onTouchEnd={() => void put(c)} onKeyUp={() => void put(c)} />
    </label>
  );
  return (
    <div className="strip-crop row">
      <StripCard name={name} pictureUrl={pictureUrl} crop={c} speaking={false} settings={settings} size={96} />
      <div className="stack-sm">
        <strong>{name}</strong>
        <span className="muted small">{picture}</span>
        {slider("x", "Across", 0, 100, 1)}
        {slider("y", "Down", 0, 100, 1)}
        {slider("zoom", "Zoom", 1, 3, 0.05)}
        <Button size="sm" variant="ghost" disabledReason={disabledReason} onClick={() => void put(null)}>
          Reset crop
        </Button>
      </div>
    </div>
  );
}
