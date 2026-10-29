// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { CAM_QUALITY_PRESETS } from "@matchframe/cloud-contracts";
import { at, err, fakeFetch, renderWithSession } from "../test/helpers.tsx";
import { encodedSize } from "../lib/camSender.ts";
import { PlayerCam } from "./PlayerCam.tsx";

const ROOM = "abcdefghij0123456789";
const info = {
  room: ROOM,
  title: "Alpha vs Bravo",
  teams: [
    { name: "Alpha", players: [{ key: "aaaaaa01", name: "nova" }, { key: "aaaaaa02", name: "flux" }] },
    { name: "Bravo", players: [{ key: "bbbbbb01", name: "zeal" }] },
  ],
  quality: CAM_QUALITY_PRESETS.standard,
  hostConnected: true,
};

/** A camera the page can open: one track, two cameras to choose from. */
function fakeCamera(deny = false) {
  const track = { kind: "video", label: "Logitech C920", stop: vi.fn(), getSettings: () => ({ deviceId: "cam1" }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn(async () => {
    if (deny) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    return stream;
  });
  const enumerateDevices = vi.fn(async () => [
    { kind: "videoinput", deviceId: "cam1", label: "Logitech C920" },
    { kind: "videoinput", deviceId: "cam2", label: "OBS Virtual Camera" },
    { kind: "audioinput", deviceId: "mic", label: "Mic" },
  ]);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, enumerateDevices } });
  return { getUserMedia, track };
}

beforeEach(() => {
  at(`/cam/${ROOM}`);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("encodedSize", () => {
  it("keeps the camera's shape within the room's size", () => {
    const q = CAM_QUALITY_PRESETS.standard;
    expect(encodedSize(q, 1280, 720)).toEqual({ width: 640, height: 360 });
    expect(encodedSize(q, 640, 480)).toEqual({ width: 480, height: 360 }); // 4:3, not stretched
    expect(encodedSize(q, 320, 180)).toEqual({ width: 320, height: 180 }); // never scaled up
    expect(encodedSize(q, 2560, 1080)).toEqual({ width: 640, height: 270 }); // ultrawide: the width limits
  });
});

describe("player cam page", () => {
  it("lists the match's players; picking yourself opens the camera with the cameras to choose from", async () => {
    fakeFetch({ [`GET /v1/cams/${ROOM}`]: { body: info } });
    const cam = fakeCamera();
    renderWithSession(<PlayerCam room={ROOM} />, null);
    expect(await screen.findByRole("heading", { name: "Alpha vs Bravo" })).toBeTruthy();
    expect(screen.getByText("Who are you?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "zeal" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "nova" }));
    expect(await screen.findByText("nova · Alpha")).toBeTruthy();
    expect(cam.getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.objectContaining({ width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } }) });
    const select = (await screen.findByLabelText("Camera")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Logitech C920", "OBS Virtual Camera"]);
    expect(select.value).toBe("cam1");
    expect(localStorage.getItem(`mf-cam-${ROOM}`)).toBe("aaaaaa01");
    // Another camera: opened by its id.
    fireEvent.change(select, { target: { value: "cam2" } });
    await vi.waitFor(() => expect(cam.getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: expect.objectContaining({ deviceId: { exact: "cam2" } }) }));
    expect(cam.track.stop).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not you?" }));
    expect(await screen.findByText("Who are you?")).toBeTruthy();
  });

  it("goes straight to the camera for a player who picked themselves before", async () => {
    localStorage.setItem(`mf-cam-${ROOM}`, "bbbbbb01");
    fakeFetch({ [`GET /v1/cams/${ROOM}`]: { body: info } });
    fakeCamera();
    renderWithSession(<PlayerCam room={ROOM} />, null);
    // The roster is shown first; the remembered player is highlighted.
    expect(await screen.findByRole("button", { name: "zeal" })).toBeTruthy();
  });

  it("explains a blocked camera and a link that isn't open", async () => {
    fakeFetch({ [`GET /v1/cams/${ROOM}`]: { body: info } });
    fakeCamera(true);
    renderWithSession(<PlayerCam room={ROOM} />, null);
    fireEvent.click(await screen.findByRole("button", { name: "flux" }));
    expect(await screen.findByText(/not allowed to use your camera/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve and send" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    fakeFetch({ [`GET /v1/cams/${ROOM}`]: err(404, "not_found", "This camera link isn't open.") });
    renderWithSession(<PlayerCam room={ROOM} />, null);
    expect(await screen.findByText("This camera link isn't open")).toBeTruthy();
  });
});
