import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, KV, Meter, Note, Panel } from "../../components/ui.tsx";
import { usePersistentState } from "../../lib/hooks.ts";
import { CommsPreviewPlayer, listOutputDevices, type PreviewDevice, type PreviewStatus } from "../../lib/commsPreview.ts";
import { usePermission } from "../../state/session.tsx";
import type { CommsParticipant } from "./types.ts";

/** The player lives as long as the page; its status read four times a second (not on every chunk). */
function usePreview(make: () => CommsPreviewPlayer) {
  const player = useMemo(make, [make]);
  const [st, setSt] = useState<PreviewStatus>(player.status());
  useEffect(() => {
    const t = setInterval(() => setSt(player.status()), 250);
    const off = player.onChange((s) => {
      if (s.state !== st.state) setSt(s);
    });
    return () => {
      clearInterval(t);
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
    <Panel title="Preview in your headphones" subtitle="Only you hear this. It never goes to OBS, the broadcast or the recording." actions={<Badge tone={st.state === "playing" ? "ok" : st.state === "error" ? "danger" : "neutral"}>{st.state === "playing" ? "Listening" : st.state === "connecting" ? "Connecting" : st.state === "error" ? "Error" : "Off"}</Badge>}>
      <div className="stack-sm">
        <Field label="Headphones (output device)" hint={st.state !== "off" && !st.sinkSupported ? "This window can't choose an output device: the preview plays on the system default." : "Pick a device OBS doesn't capture (Desktop Audio is off in the documented setup)."}>
          <div className="row">
            <select
              aria-label="Headphones (output device)"
              value={known ? device : ""}
              onChange={(e) => {
                setDevice(e.target.value);
                void player.setDevice(e.target.value);
              }}
            >
              <option value="">System default output</option>
              {(devices ?? []).map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => void refresh()}>
              Refresh devices
            </Button>
          </div>
        </Field>
        {deviceError ? <Note tone="warn">Couldn't list the outputs: {deviceError}</Note> : null}
        <div className="row">
          {on ? (
            <Button variant="secondary" onClick={() => player.stop()}>
              Stop listening
            </Button>
          ) : (
            <Button variant="primary" disabledReason={reason} onClick={() => void player.start(known ? device : "")}>
              Listen in headphones
            </Button>
          )}
          <label className="row small">
            Volume
            <input type="range" min={0} max={2} step={0.05} aria-label="Preview volume" value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
        </div>
        <Meter value={st.levelDb <= -60 ? 0 : (st.levelDb + 60) / 60} tone={st.state === "playing" ? "ok" : "neutral"} label="Preview level" />
        {st.error ? <Note tone="warn">{st.error}</Note> : null}
        <KV
          items={[
            ["Soloed", soloed.length ? soloed.map((p) => p.displayName || p.nickname).join(", ") : "Nobody: press Solo next to a person"],
            ["Playback", on ? `${st.chunks} chunks · ${st.underruns} gaps · ${st.dropped} dropped` : "—"],
          ]}
        />
      </div>
    </Panel>
  );
}
