import { useState } from "react";
import { api, describeError } from "../api/index.ts";
import type { AutoDirectorCheck, AutoDirectorStatus } from "../api/types.ts";
import { useApi } from "../lib/hooks.ts";
import { perLocale, t } from "../i18n/index.ts";
import { useLive } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { Icon } from "./icons.tsx";
import { useToast } from "./toasts.tsx";
import { Button, Checkbox } from "./ui.tsx";
import "../styles/auto-director.css";

const PHASE: Record<AutoDirectorStatus["phase"], { text: string; tone: string }> = perLocale(() => ({
  off: { text: t("autodir.phase.off"), tone: "neutral" },
  starting: { text: t("autodir.phase.starting"), tone: "info" },
  waiting: { text: t("autodir.phase.waiting"), tone: "warn" },
  running: { text: t("autodir.phase.running"), tone: "ok" },
  paused: { text: t("autodir.phase.paused"), tone: "info" },
  error: { text: t("autodir.phase.error"), tone: "danger" },
}));

const MARK: Record<AutoDirectorCheck["status"], string> = { ok: "✓", wait: "…", warn: "!", fail: "✕", skip: "–" };

const RETURN_AFTER: { sec: number; label: string }[] = perLocale(() => [
  ...[5, 8, 15, 30].map((sec) => ({ sec, label: t("common.unit.s", { n: sec }) })),
  { sec: 0, label: t("autodir.onlyStart") },
]);

/**
 * The one button: Start checks the console, game data, account, player switching and cameras, fixes
 * what it can, and directs the match (see AutoDirector in the engine). Compact on Live Control.
 */
export function AutoDirectorCard({ compact = false }: { compact?: boolean }) {
  const status = useApi<AutoDirectorStatus>("/api/v1/director/auto", { refreshMs: 1000 });
  const fullAction = useLive((s) => s.snapshot?.simulated || s.snapshot?.cloud?.fullActionObserver !== false);
  const reason = usePermission("director.control");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const st = status.data;
  const set = st?.settings ?? { cinematic: true, nadeCams: false, returnAfterSec: 8, chase: true, clutch: true };

  const call = async (fn: () => Promise<AutoDirectorStatus>, failTitle: string) => {
    setBusy(true);
    try {
      const next = await fn();
      status.setData(next);
      if (next.phase === "error") toast.push("danger", t("autodir.toast.stopped"), next.headline);
    } catch (e) {
      toast.push("danger", failTitle, describeError(e));
    } finally {
      setBusy(false);
      void status.reload();
    }
  };
  const start = () => call(() => api.post<AutoDirectorStatus>("/api/v1/director/auto/start", {}), t("autodir.toast.notStarted"));
  const stop = () => call(() => api.post<AutoDirectorStatus>("/api/v1/director/auto/stop", {}), t("autodir.toast.notStopped"));
  const save = (patch: Partial<AutoDirectorStatus["settings"]>) => call(() => api.put<AutoDirectorStatus>("/api/v1/director/auto/settings", patch), t("autodir.toast.notSaved"));

  const on = st?.on ?? false;
  const phase = PHASE[st?.phase ?? "off"];
  const checks = st?.checks ?? [];
  return (
    <section className={`autodir ${compact ? "is-compact" : ""} ${on ? "is-on" : ""}`} aria-label={t("nav.autoDirector")}>
      <div className="autodir-head">
        <div className="autodir-title">
          <Icon name="director" size={18} />
          <div>
            <strong>{t("nav.autoDirector")}</strong>
            <span className="small muted">{t("autodir.tagline")}</span>
          </div>
        </div>
        <span className={`autodir-pill tone-${phase.tone}`} role="status">
          {phase.text}
        </span>
      </div>
      <div className="autodir-main">
        {on ? (
          <Button variant="danger" size="lg" className="autodir-go" disabledReason={reason ?? (busy ? t("autodir.working") : null)} onClick={() => void stop()}>
            <Icon name="stop" size={16} /> {t("autodir.stop")}
          </Button>
        ) : (
          <Button variant="primary" size="lg" className="autodir-go" disabledReason={reason ?? (busy ? t("autodir.working") : !st ? t("common.loading") : null)} onClick={() => void start()}>
            <Icon name="play" size={16} /> {t("autodir.start")}
          </Button>
        )}
        <p className={`autodir-headline ${st?.phase === "error" ? "text-danger" : ""}`} aria-live="polite">
          {st ? st.headline : status.error ? t("autodir.unreachable", { error: status.error }) : t("common.loading")}
        </p>
      </div>
      <div className="autodir-options" role="group" aria-label={t("autodir.films")}>
        <Checkbox checked label={t("autodir.pov.label")} disabled hint={t("autodir.pov.hint")} onChange={() => undefined} />
        <Checkbox
          checked={set.cinematic || set.nadeCams}
          disabled={!!reason || busy}
          label={t("autodir.cinematic.label")}
          hint={t("autodir.cinematic.hint")}
          onChange={(v) => void save(v ? { cinematic: true } : { cinematic: false, nadeCams: false })}
        />
        <Checkbox
          checked={set.nadeCams}
          disabled={!!reason || busy || !fullAction}
          label={fullAction ? t("autodir.nade.label") : t("autodir.nade.labelTop")}
          hint={fullAction ? t("autodir.nade.hint") : t("autodir.nade.hintTop")}
          onChange={(v) => void save(v ? { nadeCams: true, cinematic: true } : { nadeCams: false })}
        />
        <Checkbox
          checked={set.chase}
          disabled={!!reason || busy}
          label={t("autodir.chase.label")}
          hint={t("autodir.chase.hint")}
          onChange={(v) => void save({ chase: v })}
        />
        <Checkbox
          checked={set.clutch}
          disabled={!!reason || busy}
          label={t("autodir.clutch.label")}
          hint={t("autodir.clutch.hint")}
          onChange={(v) => void save({ clutch: v })}
        />
        {compact || !(set.cinematic || set.nadeCams) ? null : (
          <>
            <Checkbox
              checked={set.variety !== false}
              disabled={!!reason || busy}
              label={t("autodir.variety.label")}
              hint={t("autodir.variety.hint")}
              onChange={(v) => void save({ variety: v })}
            />
            <Checkbox
              checked={set.bigMoments !== false}
              disabled={!!reason || busy}
              label={t("autodir.big.label")}
              hint={t("autodir.big.hint")}
              onChange={(v) => void save({ bigMoments: v })}
            />
            <label className="autodir-return">
              <span className="small muted">{t("autodir.winners.label")}</span>
              <select value={set.winnerShots ?? "every_round"} disabled={!!reason || busy} onChange={(e) => void save({ winnerShots: e.target.value as "every_round" | "big_rounds" | "off" })}>
                <option value="every_round">{t("autodir.winners.every")}</option>
                <option value="big_rounds">{t("autodir.winners.big")}</option>
                <option value="off">{t("autodir.winners.never")}</option>
              </select>
            </label>
            <Checkbox
              checked={set.hlaeCamera !== false}
              disabled={!!reason || busy}
              label={t("autodir.hlae.label")}
              hint={t("autodir.hlae.hint")}
              onChange={(v) => void save({ hlaeCamera: v })}
            />
            <p className="small muted">
              {st?.hlae?.connected
                ? t("autodir.hlae.connected", { count: st.hlae.shots })
                : st?.hlae?.enabled
                  ? t("autodir.hlae.waiting")
                  : set.hlaeCamera !== false
                    ? t("autodir.hlae.start")
                    : t("autodir.hlae.off")}
            </p>
          </>
        )}
        {compact ? null : (
          <label className="autodir-return">
            <span className="small muted">{t("autodir.returnAfter")}</span>
            <select value={set.returnAfterSec} disabled={!!reason || busy} onChange={(e) => void save({ returnAfterSec: Number(e.target.value) })}>
              {(RETURN_AFTER.some((r) => r.sec === set.returnAfterSec) ? RETURN_AFTER : [...RETURN_AFTER, { sec: set.returnAfterSec, label: t("common.unit.s", { n: set.returnAfterSec }) }]).map((r) => (
                <option key={r.sec} value={r.sec}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {checks.length ? (
        <ul className="autodir-checks" aria-label={t("autodir.checks")}>
          {checks.map((c) => (
            <li key={c.id} className={`autodir-check is-${c.status}`}>
              <span className="autodir-mark" aria-hidden>
                {MARK[c.status]}
              </span>
              <span className="autodir-check-label">{c.label}</span>
              <span className="autodir-check-detail small">{c.detail}</span>
            </li>
          ))}
        </ul>
      ) : compact ? null : (
        <p className="small muted autodir-help">{t("autodir.help")}</p>
      )}
    </section>
  );
}
