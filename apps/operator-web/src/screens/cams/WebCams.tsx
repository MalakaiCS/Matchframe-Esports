import { useEffect, useRef, useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { CamPlayerView, CamStatusView } from "../../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, CopyButton, Details, Field, Mono, Note, Panel } from "../../components/ui.tsx";
import { CamPreview } from "../../lib/camPreview.ts";
import { useApi } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { usePermission } from "../../state/session.tsx";

const STATE: Record<CamPlayerView["state"], { tone: "ok" | "warn" | "neutral" | "info"; label: string }> = {
  offline: { tone: "neutral", label: "No camera" },
  waiting_approval: { tone: "warn", label: "Waiting for you" },
  live: { tone: "ok", label: "On air" },
  hidden: { tone: "info", label: "Off air" },
};

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
  return <div ref={holder} className="cam-preview-tile" aria-label="Camera preview" />;
}

function PlayerCard({ p, preview, onChanged }: { p: CamPlayerView; preview: CamPreview; onChanged: () => void }) {
  const reason = usePermission("hud.publish");
  const st = STATE[p.state];
  return (
    <div className={`cam-card ${p.onAir ? "is-on" : ""}`}>
      {p.state === "offline" ? <div className="cam-preview-tile cam-preview-none">Not sending yet</div> : <Preview preview={preview} steamId={p.steamId} />}
      <div className="cam-card-body">
        <div className="cam-card-head">
          <strong>{p.name}</strong>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <div className="small muted">{p.team || " "}</div>
        {p.state !== "offline" ? (
          <div className="small muted">
            {p.camera ?? "Camera"} · {p.width}×{p.height} · {p.kbps} kbit/s{p.bufferedSec > 0 ? ` · ${p.bufferedSec.toFixed(1)} s buffered` : ""}
          </div>
        ) : null}
        <div className="cam-card-actions">
          {p.state === "waiting_approval" ? (
            <ActionButton size="sm" variant="primary" action={() => api.post(`/api/v1/cams/players/${seg(p.steamId)}/approve`)} onDone={onChanged} disabledReason={reason}>
              Put on air
            </ActionButton>
          ) : null}
          {p.state === "live" ? (
            <ActionButton size="sm" action={() => api.put(`/api/v1/cams/players/${seg(p.steamId)}/hidden`, { hidden: true })} onDone={onChanged} disabledReason={reason}>
              Take off air
            </ActionButton>
          ) : null}
          {p.state === "hidden" ? (
            <ActionButton size="sm" action={() => api.put(`/api/v1/cams/players/${seg(p.steamId)}/hidden`, { hidden: false })} onDone={onChanged} disabledReason={reason}>
              Put on air
            </ActionButton>
          ) : null}
          {p.state !== "offline" ? (
            <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/cams/players/${seg(p.steamId)}/kick`)} onDone={onChanged} disabledReason={reason} confirm={{ title: `Stop ${p.name}'s camera?`, body: "Their page shows that the production stopped their camera. They can send it again from the link." }}>
              Stop camera
            </ActionButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Player cams from the website (ADR-048): players open a link, pick themselves and a camera and
 * send it; Matchframe shows it in the HUDs and OBS, delayed to match the game.
 */
export function WebCams() {
  const reason = usePermission("settings.manage");
  const cams = useApi<CamStatusView>("/api/v1/cams", { refreshMs: 1000 });
  const [preview] = useState(() => new CamPreview());
  const [delaySec, setDelaySec] = useState<string | null>(null);
  useEffect(() => {
    preview.start();
    return () => preview.stop();
  }, [preview]);
  const save = (patch: Partial<Pick<CamStatusView, "enabled" | "delayMs" | "quality" | "autoApprove">>) => api.put<CamStatusView>("/api/v1/cams/settings", patch).then((r) => cams.setData(r));

  return (
    <Async state={cams}>
      {(c) => {
        const status = !c.enabled ? (
          <Badge>Off</Badge>
        ) : !c.signedIn ? (
          <Badge tone="warn">Sign in needed</Badge>
        ) : c.websiteConnected ? (
          <Badge tone="ok" icon="●">
            Open on the website
          </Badge>
        ) : (
          <Badge tone="warn">Connecting…</Badge>
        );
        const delay = delaySec ?? String(c.delayMs / 1000);
        const live = c.players.filter((p) => p.state !== "offline").length;
        return (
          <div className="stack">
            <Panel title="Player cams from the website" actions={status}>
              <div className="stack">
                <Checkbox
                  checked={c.enabled}
                  disabled={!!reason}
                  onChange={(v) => void save({ enabled: v })}
                  label="Player cams"
                  hint="Players open a link on the Matchframe website, pick themselves and their camera, and send it. Matchframe shows each player's cam in your HUD when the observer is on them, delayed to match the game."
                />
                {c.enabled && !c.signedIn ? (
                  <Note tone="warn">
                    Player cams go through the Matchframe website: sign this program in under <Link to="/settings/account">Settings → Account</Link>.
                  </Note>
                ) : null}
                {c.error && c.enabled ? <Note tone="warn">{c.error}</Note> : null}
                {c.link ? (
                  <Field label="Link for your players" hint="Send it to the players in this match (Discord, chat). Anyone with the link can send a camera as a player in the match, so only share it with them.">
                    <div className="cam-link-row">
                      <Mono>{c.link}</Mono>
                      <CopyButton text={c.link} label="Copy link" />
                      <ActionButton size="sm" variant="ghost" action={() => api.post<CamStatusView>("/api/v1/cams/new-link").then((r) => cams.setData(r))} disabledReason={reason} confirm={{ title: "Make a new link?", body: "The old link stops working at once, and players on it are sent away. Send everyone the new one." }}>
                        New link
                      </ActionButton>
                    </div>
                  </Field>
                ) : null}
                <div className="form-grid">
                  <Field label="Delay (seconds)" hint="Your CSTV delay (tv_delay), so faces match the game on screen. Up to 300 s.">
                    <div className="cam-link-row">
                      <input type="number" min={0} max={300} step={0.5} value={delay} onChange={(e) => setDelaySec(e.target.value)} disabled={!!reason} />
                      <ActionButton
                        size="sm"
                        action={() => save({ delayMs: Math.round(Math.max(0, Math.min(300, Number(delay) || 0)) * 1000) })}
                        onDone={() => setDelaySec(null)}
                        disabledReason={reason ?? (delaySec === null ? "No change" : null)}
                      >
                        Set delay
                      </ActionButton>
                    </div>
                  </Field>
                  <Field label="Video players send" hint={`About ${BITRATE[c.quality]} Mbit/s from each player, through the Matchframe website.`}>
                    <select value={c.quality} disabled={!!reason} onChange={(e) => void save({ quality: e.target.value as CamStatusView["quality"] })}>
                      {(Object.keys(QUALITY) as CamStatusView["quality"][]).map((q) => (
                        <option key={q} value={q}>
                          {QUALITY[q]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Checkbox checked={c.autoApprove} disabled={!!reason} onChange={(v) => void save({ autoApprove: v })} label="Put cams on air as soon as they arrive" hint="Off: each cam waits here until you put it on air (you see it first)." />
              </div>
            </Panel>
            {c.enabled ? (
              <Panel title="Players" subtitle={`${live} of ${c.players.length} sending`}>
                {c.players.length === 0 ? (
                  <p className="small muted">The players appear here from the current match (Matches) or, without one, from the game data.</p>
                ) : (
                  <div className="cam-grid">
                    {c.players.map((p) => (
                      <PlayerCard key={p.steamId} p={p} preview={preview} onChanged={() => void cams.reload()} />
                    ))}
                  </div>
                )}
                <p className="small muted">Previews here are live (not delayed); your HUDs and OBS get each cam {c.delayMs ? `${(c.delayMs / 1000).toFixed(1)} s later` : "with no delay"}.</p>
              </Panel>
            ) : null}
            {c.enabled && c.outputs ? (
              <Panel title="Where the cams show">
                <div className="stack-sm">
                  <p className="small">
                    <strong>Your HUD:</strong> LHM-format HUDs (such as kaiHUD) and Matchframe's own HUD show the observed player's cam by themselves. Reload a HUD that was open before you switched player cams on.
                  </p>
                  <Field label="OBS browser source: the observed player's cam" hint="Fills the source; transparent when that player has no cam on air.">
                    <div className="cam-link-row">
                      <Mono>{c.outputs.observed}</Mono>
                      <CopyButton text={c.outputs.observed} />
                    </div>
                  </Field>
                  <Details summary="One player's cam in OBS">
                    <p className="small muted">Replace STEAMID with the player's SteamID64:</p>
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
