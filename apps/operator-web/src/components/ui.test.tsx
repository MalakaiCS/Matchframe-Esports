// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../api/client.ts";
import { ToastProvider } from "./toasts.tsx";
import { ActionButton, Button, EvidenceBadge, SupportBadge } from "./ui.tsx";

afterEach(cleanup);

describe("Button", () => {
  it("is disabled and shows the reason as visible, announced text", () => {
    render(<Button disabledReason="Static cameras: unverified — run the camera test in Setup">REQUEST CINEMATIC</Button>);
    const btn = screen.getByRole("button", { name: "REQUEST CINEMATIC" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByText("Static cameras: unverified — run the camera test in Setup");
    expect(btn.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("is enabled without a reason", () => {
    render(<Button>HOLD</Button>);
    expect((screen.getByRole("button", { name: "HOLD" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ActionButton", () => {
  it("shows a readable engine error inline and in a toast", async () => {
    render(
      <ToastProvider>
        <ActionButton
          action={async () => {
            throw new ApiError(409, "not_approved", "only approved clips can be played");
          }}
        >
          Play
        </ActionButton>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Conflict: only approved clips can be played"));
    expect(screen.getByText("Play failed")).toBeTruthy();
  });

  it("asks for confirmation (and a reason) before running", async () => {
    let got: string | undefined;
    render(
      <ToastProvider>
        <ActionButton action={async (r) => (got = r)} confirm={{ title: "Reset the veto?", reasonLabel: "Reason" }} success="Veto reset">
          Reset veto
        </ActionButton>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset veto" }));
    expect(screen.getByRole("dialog", { name: "Reset the veto?" })).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "wrong map banned" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(got).toBe("wrong map banned"));
    await waitFor(() => expect(screen.getByText("Veto reset")).toBeTruthy());
  });
});

describe("badges", () => {
  it("always pair state with text", () => {
    render(
      <>
        <SupportBadge support="unverified" />
        <EvidenceBadge evidence="estimated" />
      </>,
    );
    expect(screen.getByText("UNVERIFIED")).toBeTruthy();
    expect(screen.getByText("ESTIMATED")).toBeTruthy();
  });
});
