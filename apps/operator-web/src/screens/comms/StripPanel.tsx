import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { AssetUpload } from "../../components/AssetUpload.tsx";
import { useToast } from "../../components/toasts.tsx";
import { Button, Checkbox, CopyButton, Details, Field, Note, Panel } from "../../components/ui.tsx";
import { usePermission } from "../../state/session.tsx";
import { StripCard } from "./StripCard.tsx";
import type { CommsView, PortraitCrop, StripAnchor, StripSettings, StripStatus } from "./types.ts";
import { perLocale, t } from "../../i18n/index.ts";

type Reload = () => void;

const ANCHORS: [StripAnchor, string][] = perLocale(() => ([
  ["bottom-center", t("comms.bottomCentre")],
  ["bottom-left", t("comms.bottomLeft")],
  ["bottom-right", t("comms.bottomRight")],
  ["top-center", t("comms.topCentre")],
  ["top-left", t("comms.topLeft")],
  ["top-right", t("comms.topRight")],
]));

const PICTURE: Record<StripStatus["cards"][number]["picture"], string> = perLocale(() => ({
  own: t("comms.rosterPicture"),
  "hud-default": t("comms.hudImagesDefaultPicture"),
  placeholder: t("comms.placeholderPictureTeamCommsElse"),
  silhouette: t("comms.matchframeSSilhouette"),
}));

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
      toast.push("danger", t("comms.notSaved"), describeError(e));
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
    <Panel title={t("comms.speakerStripRecordingOnly")} subtitle={t("comms.theIncludedPeopleOfThe")}>
      <div className="stack-sm">
        <div className="strip-preview" aria-label={t("comms.speakerStripNow")}>
          {st.cards.length === 0 ? (
            <p className="muted small">{t("comms.noCardsV", { v: view.recorder.settings.teamId ? t("comms.nobodyOfTheRecordingTeam") : t("comms.chooseTheRecordingTeam") })}</p>
          ) : (
            st.cards.map((c) => (
              <figure key={c.id} className="strip-preview-card">
                <StripCard name={c.name} pictureUrl={c.pictureUrl} crop={c.crop} speaking={lit.has(c.name)} settings={s} size={72} />
                <figcaption className="small">
                  {c.name}
                  {lit.has(c.name) ? t("comms.speaking") : ""}
                </figcaption>
              </figure>
            ))
          )}
        </div>
        {st.warning ? <Note tone="warn">{st.warning}</Note> : null}
        <p className="small">{t("comms.vAddressForTheRecording", { v: st.pages ? t("comms.stripPagesConnected", { count: st.pages }) : t("comms.noStripPageConnectedSet") })}</p>
        <div className="row">
          <input readOnly value={st.url} aria-label={t("comms.speakerStripAddress")} spellCheck={false} />
          <CopyButton text={st.url} />
        </div>
        <div className="row-end">
          <Field label={t("comms.anchor")}>
            <select aria-label={t("comms.anchor")} value={s.anchor} disabled={!!reason} onChange={(e) => void save({ anchor: e.target.value as StripAnchor })}>
              {ANCHORS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {num("offsetX", t("comms.acrossPx"), -1920, 1920)}
          {num("offsetY", t("comms.fromTheEdgePx"), 0, 1080)}
          {num("cardPx", t("comms.cardSizePx"), 48, 400)}
          {num("gapPx", t("comms.spacingPx"), 0, 200)}
          {num("borderPx", t("comms.framePx"), 1, 30)}
        </div>
        <div className="row-end">
          <Field label={t("comms.speakingColour")}>
            <input type="color" aria-label={t("comms.speakingColour")} value={s.activeColor.toLowerCase()} disabled={!!reason} onChange={(e) => void save({ activeColor: e.target.value.toUpperCase() })} />
          </Field>
          <Field label={t("comms.silentColour")}>
            <input type="color" aria-label={t("comms.silentColour")} value={s.idleColor.toLowerCase()} disabled={!!reason} onChange={(e) => void save({ idleColor: e.target.value.toUpperCase() })} />
          </Field>
          {num("releaseMs", t("comms.releaseMs"), 0, 3000, t("comms.litThisLongAfterThe"))}
          {num("attackMs", t("comms.attackMs"), 0, 500, t("comms.speakingThisLongBeforeIt"))}
          {num("timingOffsetMs", t("comms.timingOffsetMs"), -1000, 2000, t("comms.laterOrEarlierThanThe"))}
        </div>
        <div className="row">
          <Checkbox checked={s.labels} disabled={!!reason} label={t("comms.namesUnderThePortraits")} hint={t("comms.offByDefault")} onChange={(v) => void save({ labels: v })} />
          <Checkbox checked={s.useHudDefaults} disabled={!!reason} label={t("comms.hudImagesDefaultPlayerPictures")} hint={t("comms.forMappedPlayersWithoutA")} onChange={(v) => void save({ useHudDefaults: v })} />
        </div>
        <AssetUpload label={t("comms.placeholderSilhouetteAnyoneWithoutA")} value={s.placeholderAssetId} disabledReason={reason} onChange={(id) => void save({ placeholderAssetId: id })} />
        <Details summary={t("comms.portraitCrops")}>
          <div className="stack-sm">
            {st.cards.length === 0 ? <p className="muted small">{t("comms.theRecordingTeamSIncluded")}</p> : null}
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
      toast.push("danger", t("comms.cropNotSaved"), describeError(e));
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
        <Button size="sm" variant="ghost" disabledReason={disabledReason} onClick={() => void put(null)}>{t("comms.resetCrop")}</Button>
      </div>
    </div>
  );
}
