// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HlaeInfo, HlaeStatus } from "../../api/auth.ts";
import type { useHlae } from "../../lib/game.ts";
import { HlaeSetup } from "./LaunchSettings.tsx";

/** The HLAE block in Settings → Setup → Start CS2 (ADR-084): what it offers in each state. */

const status = (s: Partial<HlaeStatus> = {}): HlaeStatus => ({ managed: null, inUse: false, autoUpdate: true, busy: null, busyVersion: null, percent: null, latest: null, checkedAt: null, error: null, ...s });
const managed = { version: "2.193.0", dir: "C:\\mf\\hlae-program\\2.193.0", exe: "C:\\mf\\hlae-program\\2.193.0\\HLAE.exe", installedAt: "2026-11-18T12:00:00Z" };

function hlae(info: HlaeInfo | null, over: Partial<ReturnType<typeof useHlae>> = {}): ReturnType<typeof useHlae> {
  return { info, choose: vi.fn(async () => undefined), get: vi.fn(async () => info!), check: vi.fn(async () => "HLAE 2.193.0 is the latest."), setAutoUpdate: vi.fn(async () => undefined), ...over };
}

afterEach(cleanup);

describe("HLAE in Start CS2's settings", () => {
  it("offers Get HLAE first when there's none", () => {
    const h = hlae({ path: null, ok: false, problem: "HLAE isn't set up yet.", status: status() });
    render(<HlaeSetup hlae={h} reason={null} />);
    expect(screen.getByText("HLAE isn't set up yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get HLAE" }));
    expect(h.get).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose HLAE.exe…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check for a newer HLAE" })).toBeNull();
    expect(screen.getByText(/official releases on GitHub/)).toBeTruthy();
  });

  it("shows the program's HLAE with its version, the check and the setting", async () => {
    const h = hlae({ path: managed.exe, ok: true, problem: null, status: status({ managed, inUse: true }) });
    render(<HlaeSetup hlae={h} reason={null} />);
    expect(screen.getByText("HLAE 2.193.0, kept up to date by MatchFrame")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get HLAE" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check for a newer HLAE" }));
    await waitFor(() => expect(h.check).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep HLAE up to date" }));
    expect(h.setAutoUpdate).toHaveBeenCalledWith(false);
  });

  it("shows a download's progress, and the last error otherwise", () => {
    const busy = hlae({ path: null, ok: false, problem: "x", status: status({ busy: "downloading", busyVersion: "2.193.1", percent: 42 }) });
    const { unmount } = render(<HlaeSetup hlae={busy} reason={null} />);
    expect(screen.getByRole("status").textContent).toBe("Downloading HLAE 2.193.1… 42%");
    unmount();
    render(<HlaeSetup hlae={hlae({ path: null, ok: false, problem: "x", status: status({ error: "GitHub is limiting requests from this network." }) })} reason={null} />);
    expect(screen.getByText("GitHub is limiting requests from this network.")).toBeTruthy();
  });

  it("keeps an HLAE the operator chose, with Get HLAE to switch to the program's own", () => {
    render(<HlaeSetup hlae={hlae({ path: "D:\\HLAE\\HLAE.exe", ok: true, problem: null, status: status() })} reason={null} />);
    expect(screen.getByText("HLAE: D:\\HLAE\\HLAE.exe")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get HLAE" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("works with a program from before 0.13.2 (choose only)", () => {
    render(<HlaeSetup hlae={hlae({ path: null, ok: false, problem: "HLAE.exe is not chosen yet." }, { get: null, check: null, setAutoUpdate: null })} reason={null} />);
    expect(screen.queryByRole("button", { name: "Get HLAE" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose HLAE.exe…" })).toBeTruthy();
  });
});
