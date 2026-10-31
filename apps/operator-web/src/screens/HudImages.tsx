import { useRef, useState } from "react";
import { api, describeError } from "../api/index.ts";
import { assetUrl, uploadAsset } from "../components/AssetUpload.tsx";
import { Icon } from "../components/icons.tsx";
import { useToast } from "../components/toasts.tsx";
import { Button, ErrorBox, Loading, Note, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import "../styles/hud-library.css";

export const HUD_ART_PATH = "/api/v1/hud/art";
const PLAYER_SLOTS = 5;
const PICTURE_TYPES = ".png,.jpg,.jpeg,.webp,.svg,.gif";

/** HUD images as the engine stores them (asset ids). */
export interface HudArtSetting {
  defaultPlayers: { ct: string[]; t: string[] };
  maps: Record<string, { logo: string | null; image: string | null }>;
  icons: { dead: string | null };
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
      <div className={`hudimg-preview is-${shape}`}>{url ? <img src={url} alt={`${label} preview`} /> : <span>{hint ?? "None"}</span>}</div>
      <span className="hudimg-label">{label}</span>
      <div className="hudimg-actions">
        <input
          ref={input}
          type="file"
          accept={PICTURE_TYPES}
          className="sr-only"
          aria-label={`Upload ${label}`}
          disabled={!!reason}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onPick(f);
          }}
        />
        <Button size="sm" onClick={() => input.current?.click()} disabledReason={reason} title="PNG, JPG, WebP, SVG or GIF">
          <Icon name="upload" size={14} />
          {url ? "Replace" : "Upload"}
        </Button>
        {url ? (
          <Button size="sm" variant="ghost" onClick={onRemove} disabledReason={reason} aria-label={`Remove ${label}`}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * HUD images (from the HUD Library): default player pictures for each side, the dead-player icon,
 * and a logo and picture per map. Every Matchframe HUD uses them where it has no picture of its own;
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
    if (art) void save(key, "HUD images not saved", async () => change(art));
  };
  const upload = (key: string, f: File, place: (a: HudArtSetting, assetId: string) => HudArtSetting) => {
    if (!art) return;
    if (!/\.(png|jpe?g|webp|svg|gif)$/i.test(f.name)) {
      toast.push("danger", `${f.name} is not a picture`, "Use a PNG, JPG, WebP, SVG or GIF file.");
      return;
    }
    void save(key, `Uploading ${f.name} failed`, async () => place(art, (await uploadAsset(f)).assetId));
  };
  const reasonFor = (key: string, extra: string | null = null) => editReason ?? (busy === key ? "Saving…" : busy ? "Saving another picture…" : extra);

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
          reason={reasonFor(key, i > ids.length ? `Add ${side === "ct" ? "CT" : "T"} player ${ids.length + 1}'s picture first` : null)}
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
        <h1 className="page-title">HUD images</h1>
        <Link to="/" className="btn btn-ghost btn-sm">
          <Icon name="chevronLeft" size={14} />
          HUD Library
        </Link>
      </div>
      <Note tone="info">Every Matchframe HUD uses these when a player, map or mark has no picture of its own. Add only images you have the right to use.</Note>
      {!res.data ? (
        res.error ? (
          <ErrorBox error={res.error} onRetry={() => void res.reload()} />
        ) : (
          <Loading label="Loading HUD images…" />
        )
      ) : (
        <>
          <Panel title="Player pictures" subtitle="For players without their own photo, by the side they play: player 1 of a team (observer slot order) takes picture 1, and so on; with fewer pictures they repeat.">
            <div className="hudimg-sides">
              <section aria-label="CT player pictures" className="hudimg-side is-ct">
                <h3>Counter-Terrorists</h3>
                <div className="hudimg-row">{playerSlots("ct")}</div>
              </section>
              <section aria-label="T player pictures" className="hudimg-side is-t">
                <h3>Terrorists</h3>
                <div className="hudimg-row">{playerSlots("t")}</div>
              </section>
            </div>
          </Panel>
          <Panel title="Marks" subtitle="Replaces a HUD's own mark.">
            <div className="hudimg-row">
              <ImageSlot
                label="Dead player icon"
                assetId={art!.icons.dead}
                shape="square"
                reason={reasonFor("dead")}
                onPick={(f) => upload("dead", f, (a, id) => ({ ...a, icons: { dead: id } }))}
                onRemove={() => remove("dead", (a) => ({ ...a, icons: { dead: null } }))}
              />
            </div>
          </Panel>
          <Panel title="Maps" subtitle="Shown on series and veto tiles: a logo and a picture for each map.">
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
          <p className="muted small">HUD images are saved on this computer (account sync does not share them yet). LHM-format HUDs such as kaiHUD keep their own pictures.</p>
        </>
      )}
    </div>
  );
}
