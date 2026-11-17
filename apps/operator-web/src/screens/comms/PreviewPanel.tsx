import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, KV, Meter, Note, Panel } from "../../components/ui.tsx";
import { usePersistentState } from "../../lib/hooks.ts";
import { CommsPreviewPlayer, listOutputDevices, type PreviewDevice, type PreviewStatus } from "../../lib/commsPreview.ts";
import { usePermission } from "../../state/session.tsx";
import type { CommsParticipant } from "./types.ts";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

/** The player lives as long as the page; its status read four times a second (not on every chunk). */
function usePreview(make: () => CommsPreviewPlayer) {
  const player = useMemo(make, [make]);
  const [st, setSt] = useState<PreviewStatus>(player.status());
  useEffect(() => {
    const tRow = setInterval(() => setSt(player.status()), 250);
    const off = player.onChange((s) => {
      if (s.state !== st.state) setSt(s);
    });
    return () => {
      clearInterval(tRow);
      off();
    };
  }, [player, st.state]);
  useEffect(() => () => player.stop(), [player]);
  return { player, st };
}

const defaultPlayer = () => new CommsPreviewPlayer();

/**
 * The operator's private preview: the people soloed (Solo in the team panels), delayed like the
 * outputs, in the headphones chosen here. Never part of the public or the recording mix, never OBS.
 */
export function PreviewPanel({ people, makePlayer = defaultPlayer, listDevices = listOutputDevices }: { people: CommsParticipant[]; makePlayer?: () => CommsPreviewPlayer; listDevices?: () => Promise<PreviewDevice[]> }) {
  const reason = usePermission("program.control");
  const { player, st } = usePreview(makePlayer);
  const [devices, setDevices] = useState<PreviewDevice[] | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [device, setDevice] = usePersistentState<string>("comms.previewDevice", "");
  const [volume, setVolume] = usePersistentState<number>("comms.previewVolume", 1);
  const soloed = people.filter((p) => p.preview);
  const refresh = useCallback(
    () =>
      listDevices()
        .then((d) => {
          setDevices(d);
          setDeviceError(null);
        })
        .catch((e: unknown) => setDeviceError(e instanceof Error ? e.message : String(e))),
    [listDevices],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => player.setVolume(volume), [player, volume]);
  const on = st.state !== "off" && st.state !== "error";
  const known = !device || (devices ?? []).some((d) => d.deviceId === device);
  return (
    <Panel title={t("comms.previewInYourHeadphones")} subtitle={t("comms.onlyYouHearThisIt")} actions={<Badge tone={st.state === "playing" ? "ok" : st.state === "error" ? "danger" : "neutral"}>{st.state === "playing" ? t("comms.listening") : st.state === "connecting" ? t("comms.connecting") : st.state === "error" ? t("common.error") : t("comms.off")}</Badge>}>
      <div className="stack-sm">
        <Field label={t("comms.headphonesOutputDevice")} hint={st.state !== "off" && !st.sinkSupported ? t("comms.thisWindowCanTChoose") : t("comms.pickADeviceObsDoesn")}>
          <div className="row">
            <select
              aria-label={t("comms.headphonesOutputDevice")}
              value={known ? device : ""}
              onChange={(e) => {
                setDevice(e.target.value);
                void player.setDevice(e.target.value);
              }}
            >
              <option value="">{t("comms.systemDefaultOutput")}</option>
              {(devices ?? []).map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => void refresh()}>{t("comms.refreshDevices")}</Button>
          </div>
        </Field>
        {deviceError ? <Note tone="warn">{t("comms.couldnTListTheOutputs", { deviceError })}</Note> : null}
        <div className="row">
          {on ? (
            <Button variant="secondary" onClick={() => player.stop()}>{t("comms.stopListening")}</Button>
          ) : (
            <Button variant="primary" disabledReason={reason} onClick={() => void player.start(known ? device : "")}>{t("comms.listenInHeadphones")}</Button>
          )}
          <label className="row small"><T k="comms.volumeInput" values={{ input: <input type="range" min={0} max={2} step={0.05} aria-label={t("comms.previewVolume")} value={volume} onChange={(e) => setVolume(Number(e.target.value))} /> }} /></label>
        </div>
        <Meter value={st.levelDb <= -60 ? 0 : (st.levelDb + 60) / 60} tone={st.state === "playing" ? "ok" : "neutral"} label={t("comms.previewLevel")} />
        {st.error ? <Note tone="warn">{st.error}</Note> : null}
        <KV
          items={[
            [t("comms.soloed"), soloed.length ? soloed.map((p) => p.displayName || p.nickname).join(", ") : t("comms.nobodyPressSolo")],
            [t("comms.playback"), on ? t("comms.playbackStats", { chunks: st.chunks, underruns: st.underruns, dropped: st.dropped }) : "—"],
          ]}
        />
      </div>
    </Panel>
  );
}
