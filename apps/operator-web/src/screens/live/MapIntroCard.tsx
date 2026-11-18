import { api, describeError } from "../../api/index.ts";
import type { MapIntroStatus, MapIntrosResponse } from "../../api/types.ts";
import { ActionButton, Badge, Button, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { shortcutLabel } from "../../lib/replay-keys.ts";
import { Link } from "../../router.tsx";
import { usePermission } from "../../state/session.tsx";
import { introLength, MAP_INTROS_PATH } from "../replays/MapIntros.tsx";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

/**
 * Map intros in Live Control: the status line ("Next intro: Mirage, at pistol round start"), Play
 * map intro (the map in the game data) and Play next map's intro (the active match's next map,
 * before the server changes to it), and Stop while one is on air.
 */
export function MapIntroCard() {
  const intros = useApi<MapIntrosResponse>(MAP_INTROS_PATH, { refreshMs: 1000 });
  const reason = usePermission("replay.control");
  const toast = useToast();
  const status = intros.data?.status ?? null;
  const done = (r: { status: MapIntroStatus }) => intros.setData(intros.data ? { ...intros.data, status: r.status } : intros.data);
  const cur = status?.current ?? null;
  const next = status?.nextMap ?? null;
  const stop = async () => {
    try {
      done(await api.post<{ status: MapIntroStatus }>(`${MAP_INTROS_PATH}/stop`));
    } catch (e) {
      toast.push("warn", t("live.mapIntro"), describeError(e));
    }
  };
  return (
    <Panel title={t("live.mapIntro")} subtitle={status?.detail} actions={status?.running ? <Badge tone="accent">{t("live.onAir")}</Badge> : null}>
      <div className="stack-sm" aria-label={t("live.mapIntroControls")}>
        {status?.running ? (
          <div className="row">
            <Button variant="danger" disabledReason={reason} title={t("live.backToTheSceneThe")} onClick={() => void stop()}>{t("live.stop")}</Button>
            {status.playing ? <span className="small">{`${status.playing.displayName}${status.playing.isDefault ? t("live.defaultIntro") : ""} · ${introLength(status.playing.durationMs)}`}</span> : null}
          </div>
        ) : (
          <div className="row">
            <ActionButton
              variant="primary"
              action={() => api.post<{ status: MapIntroStatus }>(`${MAP_INTROS_PATH}/play`)}
              success={(r) => (r.status.running ? t("live.vIntroOnAir", { v: r.status.playing?.displayName ?? t("live.map") }) : null)}
              onDone={done}
              disabledReason={reason ?? (!status ? t("common.loading") : status.blocked)}
              title={cur ? t("live.playsMapIntro", { map: cur.displayName, shortcutLabel: shortcutLabel("F4") }) : t("live.playsCurrentIntro", { shortcutLabel: shortcutLabel("F4") })}
            >{t("live.playMapIntro")}</ActionButton>
            <ActionButton
              action={() => api.post<{ status: MapIntroStatus }>(`${MAP_INTROS_PATH}/play-next`)}
              success={(r) => (r.status.running ? t("live.vIntroOnAir", { v: r.status.playing?.displayName ?? t("live.nextMap") }) : null)}
              onDone={done}
              disabledReason={reason ?? (!status ? t("common.loading") : status.blockedNext)}
              title={next ? t("live.playsDisplaynameSIntroNow", { displayName: next.displayName }) : t("live.theNextMapInThe")}
            >
              {next ? t("live.playNextMapSIntro2", { displayName: next.displayName }) : t("live.playNextMapSIntro")}
            </ActionButton>
          </div>
        )}
        {status && !status.running && status.next !== status.detail ? <span className="small muted">{status.next}</span> : null}
        {status?.auto && !status.auto.started ? <span className="small text-warn">{status.auto.detail}</span> : null}
        <span className="small muted"><T k="live.videosAndWhenTheyStart" tags={{ link: (c) => <Link to="/replays">{c}</Link> }} /></span>
      </div>
    </Panel>
  );
}
