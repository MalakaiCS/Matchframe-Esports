import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "@matchframe/contracts";
import { accountIdOf, KeyboardObserverAdapter, NetconObserverAdapter, slotKey } from "../src/index.ts";

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  commandId: "c1",
  sessionId: "s",
  epoch: 1,
  owner: "director",
  ownershipGeneration: 1,
  decisionId: null,
  basedOnSequence: null,
  issuedAtMonotonicMs: 0,
  expiresAtMonotonicMs: Number.MAX_SAFE_INTEGER,
  confirmationTimeoutMs: 1000,
  ...over,
});

describe("account id conversion", () => {
  it("uses exact integer math for SteamID64", () => {
    expect(accountIdOf("76561198000000001")).toBe("39734273");
    expect(accountIdOf("76561197960265729")).toBe("1");
  });
});

describe("KeyboardObserverAdapter", () => {
  it("A14: sends no input when the observer window is not focused", async () => {
    const pressed: string[] = [];
    const a = new KeyboardObserverAdapter({ foregroundWindowTitle: () => "Notepad", pressKey: (k) => (pressed.push(k), true) }, { windowTitle: /^Counter-Strike 2$/, now: () => 0 });
    const r = await a.selectPlayer("7656", 3, ctx());
    expect(r.failureReason).toBe("window_not_focused");
    expect(pressed).toEqual([]);
  });

  it("sends the validated slot key only to the focused observer window, as transport-only", async () => {
    const pressed: string[] = [];
    const a = new KeyboardObserverAdapter({ foregroundWindowTitle: () => "Counter-Strike 2", pressKey: (k) => (pressed.push(k), true) }, { windowTitle: /^Counter-Strike 2$/, now: () => 0 });
    const r = await a.selectPlayer("7656", 0, ctx());
    expect(r.status).toBe("transport_acknowledged");
    expect(r.precision).toBe("transport_only");
    expect(pressed).toEqual(["0"]);
    expect((await a.selectPlayer("7656", null, ctx())).failureReason).toBe("target_invalid");
    expect(slotKey(12)).toBeNull();
  });

  it("reports unverified selection control and no camera control", async () => {
    const a = new KeyboardObserverAdapter({ foregroundWindowTitle: () => null, pressKey: () => true }, { windowTitle: /x/, now: () => 0 });
    const c = await a.getCapabilities();
    expect(c.playerSelectionControl.support).toBe("unverified");
    expect(c.staticCameraControl.support).toBe("unsupported");
  });
});

describe("NetconObserverAdapter", () => {
  it("writes the templated command over TCP and treats it as transport-only; never injects", async () => {
    const received: string[] = [];
    const server = createServer((sock) => sock.on("data", (d) => received.push(...d.toString().split("\n").filter(Boolean))));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port, now: () => 0 });
    const r = await a.selectPlayer("76561198000000001", 1, ctx());
    expect(r.status).toBe("transport_acknowledged");
    expect(r.precision).toBe("transport_only");
    const cam = await a.activateStaticCamera(
      { id: "c", position: { x: 1.234, y: -5, z: 10 }, pitch: 12, yaw: 90 } as never,
      ctx(),
    );
    expect(cam.status).toBe("transport_acknowledged");
    await new Promise((r) => setTimeout(r, 50));
    expect(received[0]).toBe("spec_player_by_accountid 39734273");
    expect(received[1]).toContain("spec_goto 1.23 -5 10 12 90");
    const caps = await a.getCapabilities();
    expect(caps.playerSelectionControl.support).toBe("unverified");
    expect(caps.staticCameraControl.support).toBe("unverified");
    const bad = new NetconObserverAdapter({ host: "127.0.0.1", port, now: () => 0, templates: { selectPlayer: "spec_player {steamId}" } });
    // A malicious steamId value can never smuggle extra commands.
    expect((await bad.selectPlayer("1; quit", null, ctx())).failureReason).not.toBe(null);
    await a.dispose();
    await bad.dispose();
    server.close();
  });

  it("fails cleanly when the console port is closed", async () => {
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: 1, now: () => 0, connectTimeoutMs: 300 });
    const r = await a.selectPlayer("76561198000000001", 1, ctx());
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("transport_error");
  });
});
