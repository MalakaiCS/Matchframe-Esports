import { useRef, useState } from "react";
import { api, describeError } from "../api/index.ts";
import { assetUrl, uploadAsset } from "../components/AssetUpload.tsx";
import { Icon } from "../components/icons.tsx";
import { useToast } from "../components/toasts.tsx";
import { Button, ErrorBox, Loading, Note, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import { IconPackPanel } from "./IconPack.tsx";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import "../styles/hud-library.css";

export const HUD_ART_PATH = "/api/v1/hud/art";
const PLAYER_SLOTS = 5;
const PICTURE_TYPES = ".png,.jpg,.jpeg,.webp,.svg,.gif";

/** HUD images as the engine stores them (asset ids). */
export interface HudArtSetting {
  defaultPlayers: { ct: string[]; t: string[] };
  maps: Record<string, { logo: string | null; image: string | null }>;
  /** `trophy` is absent from older engines. */
  icons: { dead: string | null; trophy?: string | null };
}

export interface HudArtResponse {
  art: HudArtSetting;
  maps: { mapName: string; displayName: string }[];
}

/** One picture: preview, Upload (or Replace) and Remove. */
function ImageSlot({ label, hint, assetId, shape, onPick, onRemove, reason }: { label: string; hint?: string; assetId: string | null; shape: "portrait" | "square" | "wide"; onPick: (f: File) => void; onRemove: () => void; reason: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const url = assetUrl(assetId);
  return (
    <div className={`hudimg-slot ${url ? "is-set" : ""}`} data-slot={label}>
      <div className={`hudimg-preview is-${shape}`}>{url ? <img src={url} alt={t("images.labelPreview", { label })} /> : <span>{hint ?? t("images.none")}</span>}</div>
      <span className="hudimg-label">{label}</span>
      <div className="hudimg-actions">
        <input
          ref={input}
          type="file"
          accept={PICTURE_TYPES}
          className="sr-only"
          aria-label={t("images.uploadLabel", { label })}
          disabled={!!reason}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onPick(f);
          }}
        />
        <Button size="sm" onClick={() => input.current?.click()} disabledReason={reason} title={t("images.pngJpgWebpSvgOr")}>
          <Icon name="upload" size={14} />
          {url ? t("images.replace") : t("images.upload")}
        </Button>
        {url ? (
          <Button size="sm" variant="ghost" onClick={onRemove} disabledReason={reason} aria-label={t("images.removeLabel", { label })}>{t("images.remove")}</Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * HUD images (from the HUD Library): default player pictures for each side, the dead-player icon,
 * the trophy, and a logo and picture per map. Every MatchFrame HUD uses them where it has no picture of its own;
 * each change is saved at once and reaches running HUDs straight away.
 */
export function HudImagesScreen() {
  const res = useApi<HudArtResponse>(HUD_ART_PATH);
  const toast = useToast();
  const editReason = usePermission("hud.publish");
  const [busy, setBusy] = useState<string | null>(null);
  const art = res.data?.art;

  /** Saves the whole setting with one change; one change at a time (the other slots wait). */
  const save = async (key: string, title: string, change: () => Promise<HudArtSetting>) => {
    setBusy(key);
    try {
      res.setData(await api.put<HudArtResponse>(HUD_ART_PATH, await change()));
    } catch (e) {
      toast.push("danger", title, describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = (key: string, change: (a: HudArtSetting) => HudArtSetting) => {
    if (art) void save(key, t("images.hudImagesNotSaved"), async () => change(art));
  };
  const upload = (key: string, f: File, place: (a: HudArtSetting, assetId: string) => HudArtSetting) => {
    if (!art) return;
    if (!/\.(png|jpe?g|webp|svg|gif)$/i.test(f.name)) {
      toast.push("danger", t("images.nameIsNotAPicture", { name: f.name }), t("images.useAPngJpgWebp"));
      return;
    }
    void save(key, t("images.uploadingNameFailed", { name: f.name }), async () => place(art, (await uploadAsset(f)).assetId));
  };
  const reasonFor = (key: string, extra: string | null = null) => editReason ?? (busy === key ? t("editor.saving") : busy ? t("images.savingAnotherPicture") : extra);

  const playerSlots = (side: "ct" | "t") => {
    const ids = art?.defaultPlayers[side] ?? [];
    return Array.from({ length: PLAYER_SLOTS }, (_, i) => {
      const key = `${side}-${i}`;
      const label = `${side === "ct" ? "CT" : "T"} player ${i + 1}`;
      return (
        <ImageSlot
          key={key}
          label={label}
          assetId={ids[i] ?? null}
          shape="portrait"
          reason={reasonFor(key, i > ids.length ? t("images.addPlayerPictureFirst", { side: side === "ct" ? "CT" : "T", n: ids.length + 1 }) : null)}
          onPick={(f) =>
            upload(key, f, (a, id) => {
              const list = [...a.defaultPlayers[side]];
              list[Math.min(i, list.length)] = id;
              return { ...a, defaultPlayers: { ...a.defaultPlayers, [side]: list } };
            })
          }
          onRemove={() => remove(key, (a) => ({ ...a, defaultPlayers: { ...a.defaultPlayers, [side]: a.defaultPlayers[side].filter((_, j) => j !== i) } }))}
        />
      );
    });
  };

  const mapSlot = (mapName: string, which: "logo" | "image", label: string) => {
    const key = `${mapName}-${which}`;
    const setTo = (a: HudArtSetting, id: string | null) => ({ ...a, maps: { ...a.maps, [mapName]: { logo: a.maps[mapName]?.logo ?? null, image: a.maps[mapName]?.image ?? null, [which]: id } } });
    return <ImageSlot label={label} assetId={art?.maps[mapName]?.[which] ?? null} shape={which === "logo" ? "square" : "wide"} reason={reasonFor(key)} onPick={(f) => upload(key, f, (a, id) => setTo(a, id))} onRemove={() => remove(key, (a) => setTo(a, null))} />;
  };

  return (
    <div className="page hudimg" data-testid="hud-images">
      <div className="page-head">
        <h1 className="page-title">{t("images.hudImages")}</h1>
        <Link to="/" className="btn btn-ghost btn-sm"><T k="images.iconHudLibrary" values={{ icon: <Icon name="chevronLeft" size={14} /> }} /></Link>
      </div>
      <Note tone="info">{t("images.everyMatchframeHudUsesThese")}</Note>
      {!res.data ? (
        res.error ? (
          <ErrorBox error={res.error} onRetry={() => void res.reload()} />
        ) : (
          <Loading label={t("images.loadingHudImages")} />
        )
      ) : (
        <>
          <Panel title={t("images.playerPictures")} subtitle={t("images.forPlayersWithoutTheirOwn")}>
            <div className="hudimg-sides">
              <section aria-label={t("images.ctPlayerPictures")} className="hudimg-side is-ct">
                <h3>Counter-Terrorists</h3>
                <div className="hudimg-row">{playerSlots("ct")}</div>
              </section>
              <section aria-label={t("images.tPlayerPictures")} className="hudimg-side is-t">
                <h3>{t("images.terrorists")}</h3>
                <div className="hudimg-row">{playerSlots("t")}</div>
              </section>
            </div>
          </Panel>
          <Panel title={t("images.marks")} subtitle={t("images.theDeadPlayerIconReplaces")}>
            <div className="hudimg-row">
              <ImageSlot
                label={t("images.deadPlayerIcon")}
                assetId={art!.icons.dead}
                shape="square"
                reason={reasonFor("dead")}
                onPick={(f) => upload("dead", f, (a, id) => ({ ...a, icons: { ...a.icons, dead: id } }))}
                onRemove={() => remove("dead", (a) => ({ ...a, icons: { ...a.icons, dead: null } }))}
              />
              <ImageSlot
                label={t("images.trophy")}
                assetId={art!.icons.trophy ?? null}
                shape="portrait"
                reason={reasonFor("trophy")}
                onPick={(f) => upload("trophy", f, (a, id) => ({ ...a, icons: { ...a.icons, trophy: id } }))}
                onRemove={() => remove("trophy", (a) => ({ ...a, icons: { ...a.icons, trophy: null } }))}
              />
            </div>
          </Panel>
          <IconPackPanel />
          <Panel title={t("images.maps")} subtitle={t("images.shownOnSeriesAndVeto")}>
            <div className="hudimg-maps">
              {res.data.maps.map((m) => (
                <section key={m.mapName} className="hudimg-map" aria-label={m.displayName}>
                  <div className="hudimg-map-name">
                    <strong>{m.displayName}</strong>
                    <span className="mono small muted">{m.mapName}</span>
                  </div>
                  {mapSlot(m.mapName, "logo", `${m.displayName} logo`)}
                  {mapSlot(m.mapName, "image", `${m.displayName} picture`)}
                </section>
              ))}
            </div>
          </Panel>
          <p className="muted small">{t("images.hudImagesAreSavedOn")}</p>
        </>
      )}
    </div>
  );
}
