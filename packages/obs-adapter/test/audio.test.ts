import { describe, expect, it } from "vitest";
import type { ObsClientLike } from "../src/obs.ts";
import { ObsManager } from "../src/obs.ts";

/** A stand-in OBS with three inputs, one without audio (OBS refuses its volume and mute, as obs-websocket 5 does). */
function audioObs() {
  const audio: Record<string, { mul: number; muted: boolean }> = { "Desktop Audio": { mul: 0.5, muted: false }, Mic: { mul: 1, muted: true } };
  const calls: [string, Record<string, unknown>][] = [];
  const client = {
    on: () => undefined,
    off: () => undefined,
    connect: async () => ({}),
    disconnect: async () => undefined,
    call: async (req: string, d: Record<string, unknown> = {}) => {
      calls.push([req, d]);
      const a = audio[String(d.inputName)];
      if (req === "GetInputList") return { inputs: [{ inputName: "Desktop Audio", inputKind: "wasapi_output_capture" }, { inputName: "Mic", inputKind: "wasapi_input_capture" }, { inputName: "Logo", inputKind: "image_source" }] };
      if (req.includes("Input") && req !== "GetInputList" && !a) throw new Error("The specified input does not support audio.");
      if (req === "GetInputVolume") return { inputVolumeMul: a!.mul, inputVolumeDb: 20 * Math.log10(a!.mul) };
      if (req === "GetInputMute") return { inputMuted: a!.muted };
      if (req === "SetInputVolume") a!.mul = d.inputVolumeMul !== undefined ? Number(d.inputVolumeMul) : 10 ** (Number(d.inputVolumeDb) / 20);
      if (req === "SetInputMute") a!.muted = d.inputMuted === true;
      return {};
    },
  } as unknown as ObsClientLike;
  const obs = new ObsManager(client);
  obs.state.connected = true;
  return { obs, audio, calls };
}

describe("OBS input audio", () => {
  it("lists only the inputs with audio, with their volume and mute", async () => {
    const { obs } = audioObs();
    const list = await obs.audioInputs();
    expect(list.map((i) => [i.name, i.kind, i.mul, Math.round(i.db * 10) / 10, i.muted])).toEqual([
      ["Desktop Audio", "wasapi_output_capture", 0.5, -6, false],
      ["Mic", "wasapi_input_capture", 1, 0, true],
    ]);
  });

  it("sets a volume exactly as a multiplier (or in dB), and the mute, only what is given", async () => {
    const { obs, audio, calls } = audioObs();
    await obs.setInputVolume("Desktop Audio", { mul: 0.123456 });
    expect(audio["Desktop Audio"]!.mul).toBe(0.123456);
    await obs.setInputVolume("Desktop Audio", { db: -20, muted: true });
    expect(audio["Desktop Audio"]).toEqual({ mul: 10 ** -1, muted: true });
    calls.length = 0;
    await obs.setInputVolume("Mic", { muted: false });
    expect(calls.map(([r]) => r)).toEqual(["SetInputMute"]);
    // OBS's limits: no more than +26 dB (a multiplier of 20).
    await obs.setInputVolume("Mic", { mul: 50 });
    expect(audio.Mic!.mul).toBe(20);
    await expect(obs.inputVolume("Logo")).rejects.toThrow(/does not support audio/);
  });
});
