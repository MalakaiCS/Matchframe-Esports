import { useEffect, useRef, useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { CamPlayerView, CamStatusView } from "../../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, CopyButton, Details, Field, Mono, Note, Panel } from "../../components/ui.tsx";
import { CamPreview } from "../../lib/camPreview.ts";
import { useApi } from "../../lib/hooks.ts";
import { useLowSpec } from "../../lib/lowSpec.ts";
import { Link } from "../../router.tsx";
import { usePermission } from "../../state/session.tsx";
import { perLocale, t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

const STATE: Record<CamPlayerView["state"], { tone: "ok" | "warn" | "neutral" | "info"; label: string }> = perLocale(() => ({
  offline: { tone: "neutral", label: t("cams.noCamera") },
  waiting_approval: { tone: "warn", label: t("cams.waitingForYou") },
  live: { tone: "ok", label: t("cams.onAir") },
  hidden: { tone: "info", label: t("cams.offAir") },
}));

const QUALITY: Record<CamStatusView["quality"], string> = {
  low: "Low (480×270)",
  standard: "Standard (640×360)",
  high: "High (1280×720)",
};
const BITRATE: Record<CamStatusView["quality"], string> = { low: "0.4", standard: "0.7", high: "1.8" };

/** One player's preview: the cam as it arrives (not delayed). */
function Preview({ preview, steamId }: { preview: CamPreview; steamId: string }) {
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = preview.canvas(steamId);
    holder.current?.appendChild(c);
    return () => c.remove();
  }, [preview, steamId]);
  return <div ref={holder} className="cam-preview-tile" aria-label={t("cams.cameraPreview")} />;
}

function PlayerCard({ p, preview, onChanged }: { p: CamPlayerView; preview: CamPreview | null; onChanged: () => void }) {
  const reason = usePermission("hud.publish");
  const st = STATE[p.state];
  return (
    <div className={`cam-card ${p.onAir ? "is-on" : ""}`}>
      {p.state === "offline" ? <div className="cam-preview-tile cam-preview-none">{t("cams.notSendingYet")}</div> : preview ? <Preview preview={preview} steamId={p.steamId} /> : <div className="cam-preview-tile cam-preview-none">{t("cams.previewOff")}</div>}
      <div className="cam-card-body">
        <div className="cam-card-head">
          <strong>{p.name}</strong>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <div className="small muted">{p.team || " "}</div>
        {p.state !== "offline" ? (
          <div className="small muted">
            {p.camera ?? t("cams.camera")} · {p.width}×{p.height} · {p.kbps} kbit/s{p.bufferedSec > 0 ? t("cams.tofixedSBuffered", { toFixed: p.bufferedSec.toFixed(1) }) : ""}
          </div>
        ) : null}
        <div className="cam-card-actions">
          {p.state === "waiting_approval" ? (
            <ActionButton size="sm" variant="primary" action={() => api.post(`/api/v1/cams/players/${seg(p.steamId)}/approve`)} onDone={onChanged} disabledReason={reason}>{t("cams.putOnAir")}</ActionButton>
          ) : null}
          {p.state === "live" ? (
            <ActionButton size="sm" action={() => api.put(`/api/v1/cams/players/${seg(p.steamId)}/hidden`, { hidden: true })} onDone={onChanged} disabledReason={reason}>{t("cams.takeOffAir")}</ActionButton>
          ) : null}
          {p.state === "hidden" ? (
            <ActionButton size="sm" action={() => api.put(`/api/v1/cams/players/${seg(p.steamId)}/hidden`, { hidden: false })} onDone={onChanged} disabledReason={reason}>{t("cams.putOnAir")}</ActionButton>
          ) : null}
          {p.state !== "offline" ? (
            <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/cams/players/${seg(p.steamId)}/kick`)} onDone={onChanged} disabledReason={reason} confirm={{ title: t("cams.stopNameSCamera", { name: p.name }), body: t("cams.theirPageShowsThatThe") }}>{t("cams.stopCamera")}</ActionButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Player cams from the website (ADR-048): players open a link, pick themselves and a camera and
 * send it; MatchFrame shows it in the HUDs and OBS, delayed to match the game.
 */
export function WebCams() {
  const reason = usePermission("settings.manage");
  const cams = useApi<CamStatusView>("/api/v1/cams", { refreshMs: 1000 });
  const [preview] = useState(() => new CamPreview());
  const [delaySec, setDelaySec] = useState<string | null>(null);
  // Low-spec mode (ADR-078): no live previews unless asked for.
  const lowSpec = useLowSpec()?.lowSpec === true;
  const [previewChoice, setPreviewChoice] = useState<boolean | null>(null);
  const showPreviews = previewChoice ?? !lowSpec;
  useEffect(() => {
    if (!showPreviews) return;
    preview.start();
    return () => preview.stop();
  }, [preview, showPreviews]);
  const save = (patch: Partial<Pick<CamStatusView, "enabled" | "delayMs" | "quality" | "autoApprove">>) => api.put<CamStatusView>("/api/v1/cams/settings", patch).then((r) => cams.setData(r));

  return (
    <Async state={cams}>
      {(c) => {
        const status = !c.enabled ? (
          <Badge>{t("cams.off")}</Badge>
        ) : !c.signedIn ? (
          <Badge tone="warn">{t("cams.signInNeeded")}</Badge>
        ) : c.websiteConnected ? (
          <Badge tone="ok" icon="●">{t("cams.openOnTheWebsite")}</Badge>
        ) : (
          <Badge tone="warn">{t("cams.connecting")}</Badge>
        );
        const delay = delaySec ?? String(c.delayMs / 1000);
        const live = c.players.filter((p) => p.state !== "offline").length;
        return (
          <div className="stack">
            <Panel title={t("cams.playerCamsFromTheWebsite")} actions={status}>
              <div className="stack">
                <Checkbox
                  checked={c.enabled}
                  disabled={!!reason}
                  onChange={(v) => void save({ enabled: v })}
                  label={t("cams.playerCams2")}
                  hint={t("cams.playersOpenALinkOn")}
                />
                {c.enabled && !c.signedIn ? (
                  <Note tone="warn"><T k="cams.playerCamsGoThroughThe" tags={{ link: (c) => <Link to="/settings/account">{c}</Link> }} /></Note>
                ) : null}
                {c.error && c.enabled ? <Note tone="warn">{c.error}</Note> : null}
                {c.link ? (
                  <Field label={t("cams.linkForYourPlayers")} hint={t("cams.sendItToThePlayers")}>
                    <div className="cam-link-row">
                      <Mono>{c.link}</Mono>
                      <CopyButton text={c.link} label={t("cams.copyLink")} />
                      <ActionButton size="sm" variant="ghost" action={() => api.post<CamStatusView>("/api/v1/cams/new-link").then((r) => cams.setData(r))} disabledReason={reason} confirm={{ title: t("cams.makeANewLink"), body: t("cams.theOldLinkStopsWorking") }}>{t("cams.newLink")}</ActionButton>
                    </div>
                  </Field>
                ) : null}
                <div className="form-grid">
                  <Field label={t("cams.delaySeconds")} hint={t("cams.yourCstvDelayTvDelay")}>
                    <div className="cam-link-row">
                      <input type="number" min={0} max={300} step={0.5} value={delay} onChange={(e) => setDelaySec(e.target.value)} disabled={!!reason} />
                      <ActionButton
                        size="sm"
                        action={() => save({ delayMs: Math.round(Math.max(0, Math.min(300, Number(delay) || 0)) * 1000) })}
                        onDone={() => setDelaySec(null)}
                        disabledReason={reason ?? (delaySec === null ? t("cams.noChange") : null)}
                      >{t("cams.setDelay")}</ActionButton>
                    </div>
                  </Field>
                  <Field label={t("cams.videoPlayersSend")} hint={t("cams.aboutBitrateMbitSFrom", { BITRATE: BITRATE[c.quality] })}>
                    <select value={c.quality} disabled={!!reason} onChange={(e) => void save({ quality: e.target.value as CamStatusView["quality"] })}>
                      {(Object.keys(QUALITY) as CamStatusView["quality"][]).map((q) => (
                        <option key={q} value={q}>
                          {QUALITY[q]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Checkbox checked={c.autoApprove} disabled={!!reason} onChange={(v) => void save({ autoApprove: v })} label={t("cams.putCamsOnAirAs")} hint={t("cams.offEachCamWaitsHere")} />
              </div>
            </Panel>
            {c.enabled ? (
              <Panel title={t("cams.players")} subtitle={t("cams.liveOfCountSending", { live, count: c.players.length })} actions={<Checkbox checked={showPreviews} onChange={setPreviewChoice} label={t("cams.livePreviews")} hint={lowSpec ? t("cams.offByDefaultInLow") : t("cams.eachCamAsItArrives")} />}>
                {c.players.length === 0 ? (
                  <p className="small muted">{t("cams.thePlayersAppearHereFrom")}</p>
                ) : (
                  <div className="cam-grid">
                    {c.players.map((p) => (
                      <PlayerCard key={p.steamId} p={p} preview={showPreviews ? preview : null} onChanged={() => void cams.reload()} />
                    ))}
                  </div>
                )}
                <p className="small muted">{t("cams.previewsHereAreLiveNot", { v: c.delayMs ? t("cams.tofixedSLater", { toFixed: (c.delayMs / 1000).toFixed(1) }) : t("cams.withNoDelay") })}</p>
              </Panel>
            ) : null}
            {c.enabled && c.outputs ? (
              <Panel title={t("cams.whereTheCamsShow")}>
                <div className="stack-sm">
                  <p className="small"><T k="cams.yourHudImportedHudsHud" tags={{ b: (c) => <strong>{c}</strong> }} /></p>
                  <Field label={t("cams.obsBrowserSourceTheObserved")} hint={t("cams.fillsTheSourceTransparentWhen")}>
                    <div className="cam-link-row">
                      <Mono>{c.outputs.observed}</Mono>
                      <CopyButton text={c.outputs.observed} />
                    </div>
                  </Field>
                  <Details summary={t("cams.onePlayerSCamIn")}>
                    <p className="small muted">{t("cams.replaceSteamidWithThePlayer")}</p>
                    <div className="cam-link-row">
                      <Mono>{c.outputs.player}</Mono>
                      <CopyButton text={c.outputs.player} />
                    </div>
                  </Details>
                </div>
              </Panel>
            ) : null}
          </div>
        );
      }}
    </Async>
  );
}
