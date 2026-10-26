import { describe, expect, it } from "vitest";
import type { ObserverState } from "@matchframe/contracts";
import { ControlArbiter } from "../src/index.ts";
import { FakeAdapter } from "./helpers.ts";

function setup() {
  let now = 1000;
  let id = 0;
  const clock = { get: () => now, advance: (ms: number) => (now += ms) };
  const arbiter = new ControlArbiter({ now: clock.get, newId: () => `cmd-${id++}` });
  const adapter = new FakeAdapter(clock.get);
  arbiter.setAdapter(adapter);
  arbiter.setTimeline("session", 1);
  return { arbiter, adapter, clock };
}

const observed = (steamId: string | null, mode: ObserverState["cameraMode"] = "unknown"): ObserverState => ({
  observedSteamId: steamId,
  observedSlot: null,
  cameraMode: steamId ? mode : "roaming",
  confirmedAtMonotonicMs: 0,
  providerSteamId: "obs",
  evidence: "measured",
});

describe("ControlArbiter", () => {
  it("starts disarmed: automation cannot write until explicitly resumed (also after restart)", async () => {
    const { arbiter } = setup();
    const r = await arbiter.submit({ kind: "select_player", steamId: "1", observerSlot: 1 }, { owner: "director" });
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("ownership_revoked");
  });

  it("A11: a transport acknowledgement is not a confirmation; observed feedback confirms", async () => {
    const { arbiter } = setup();
    arbiter.resumeAutomation();
    const r = await arbiter.submit({ kind: "select_player", steamId: "7", observerSlot: 7 }, { owner: "director" });
    expect(r.status).toBe("transport_acknowledged");
    expect(r.precision).toBe("transport_only");
    arbiter.observe(observed("7"));
    expect(arbiter.pending()?.status).toBe("confirmed");
    expect(arbiter.pending()?.result?.precision).toBe("observed_exact");
  });

  it("A12: a failed cut is visible, retried at most once, and never falsely confirmed", async () => {
    const { arbiter, adapter, clock } = setup();
    arbiter.resumeAutomation();
    adapter.failTransport = 5;
    const r = await arbiter.submit({ kind: "select_player", steamId: "7", observerSlot: 7 }, { owner: "director" });
    expect(r.status).toBe("failed");
    expect(adapter.calls).toHaveLength(2); // original + one bounded retry
    adapter.failTransport = 0;
    // Acknowledged but the game never shows the target: confirmation timeout, not success.
    clock.advance(10);
    await arbiter.submit({ kind: "select_player", steamId: "8", observerSlot: 8 }, { owner: "director" });
    arbiter.observe(observed("3"));
    clock.advance(2000);
    arbiter.tick();
    expect(arbiter.pending()?.status).toBe("failed");
    expect(arbiter.pending()?.result?.failureReason).toBe("confirmation_timeout");
  });

  it("A13: human takeover cancels pending commands and automation stays disarmed until resume", async () => {
    const { arbiter, adapter } = setup();
    arbiter.resumeAutomation();
    await arbiter.submit({ kind: "select_player", steamId: "7", observerSlot: 7 }, { owner: "director" });
    const genBefore = arbiter.state().generation;
    arbiter.takeover();
    expect(adapter.cancelled).toBeGreaterThan(0);
    expect(arbiter.pending()).toBeNull();
    expect(arbiter.state().generation).toBe(genBefore + 1);
    expect(arbiter.state().manualSticky).toBe(true);
    const r = await arbiter.submit({ kind: "select_player", steamId: "8", observerSlot: 8 }, { owner: "director" });
    expect(r.failureReason).toBe("ownership_revoked");
    // Resume with a countdown that the operator cancels: still manual.
    arbiter.resumeAutomation(3000);
    arbiter.cancelResume();
    expect(arbiter.automationAllowed).toBe(false);
  });

  it("A13: an unexplained POV change under automation is treated as a human takeover", async () => {
    const { arbiter } = setup();
    arbiter.resumeAutomation();
    arbiter.observe(observed("1"));
    arbiter.observe(observed("5"));
    expect(arbiter.state().manualSticky).toBe(true);
    expect(arbiter.log.some((e) => e.kind === "external_change")).toBe(true);
  });

  it("does not mistake the game's auto-switch after the observed player dies for a human takeover", () => {
    const { arbiter } = setup();
    arbiter.resumeAutomation();
    arbiter.observe(observed("1"));
    arbiter.observe(observed("2"), { previousTargetDied: true });
    expect(arbiter.automationAllowed).toBe(true);
    expect(arbiter.log.some((e) => e.kind === "game_autoswitch")).toBe(true);
  });

  it("A15: two controllers compete — only the current valid owner executes; old generations are rejected", async () => {
    const { arbiter, adapter } = setup();
    arbiter.resumeAutomation();
    // A Stream Deck (device) takes control with a lease.
    arbiter.takeover("streamdeck-1", "device", 5000);
    const director = await arbiter.submit({ kind: "select_player", steamId: "2", observerSlot: 2 }, { owner: "director" });
    expect(director.failureReason).toBe("ownership_revoked");
    const device = await arbiter.submit({ kind: "select_player", steamId: "3", observerSlot: 3 }, { owner: "device", holder: "streamdeck-1" });
    expect(device.status).toBe("transport_acknowledged");
    expect(adapter.calls.map((c) => c.target)).toEqual(["3"]);
  });

  it("A15: an expired remote/device lease reverts control to the local operator (still manual)", () => {
    const { arbiter, clock } = setup();
    arbiter.takeover("remote-1", "remote", 1000);
    clock.advance(1500);
    arbiter.tick();
    expect(arbiter.state().owner).toBe("operator");
    expect(arbiter.state().holder).toBe("local-operator");
    expect(arbiter.state().manualSticky).toBe(true);
  });

  it("rejects stale-epoch work: a new epoch cancels the pending command", async () => {
    const { arbiter } = setup();
    arbiter.resumeAutomation();
    await arbiter.submit({ kind: "select_player", steamId: "7", observerSlot: 7 }, { owner: "director" });
    arbiter.setTimeline("session", 2);
    expect(arbiter.pending()).toBeNull();
  });

  it("allows only one in-flight automated command at a time", async () => {
    const { arbiter } = setup();
    arbiter.resumeAutomation();
    await arbiter.submit({ kind: "select_player", steamId: "7", observerSlot: 7 }, { owner: "director" });
    const second = await arbiter.submit({ kind: "select_player", steamId: "8", observerSlot: 8 }, { owner: "director" });
    expect(second.failureReason).toBe("superseded");
  });

  it("emergency stop cancels everything, blocks automation, and requires explicit clearing", async () => {
    const { arbiter, adapter } = setup();
    arbiter.resumeAutomation();
    await arbiter.submit({ kind: "select_player", steamId: "7", observerSlot: 7 }, { owner: "director" });
    await arbiter.emergencyStop();
    expect(adapter.stopped).toBe(1);
    expect(arbiter.pending()).toBeNull();
    arbiter.resumeAutomation();
    expect(arbiter.automationAllowed).toBe(false);
    arbiter.clearEmergencyStop();
    arbiter.resumeAutomation();
    expect(arbiter.automationAllowed).toBe(true);
  });

  it("refuses to execute an expired command", async () => {
    const { arbiter } = setup();
    arbiter.resumeAutomation();
    const r = await arbiter.submit({ kind: "select_player", steamId: "7", observerSlot: 7 }, { owner: "director", expiresInMs: -1 });
    expect(r.failureReason).toBe("expired");
  });
});
