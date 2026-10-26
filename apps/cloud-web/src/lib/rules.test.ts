import { describe, expect, it } from "vitest";
import { HourPack, Plan } from "@matchframe/cloud-contracts";
import type { Member } from "../api/types.ts";
import { formToPack, formToPlan, packToForm, planToForm } from "../pages/admin/Catalog.tsx";
import { roleChangeBlocker } from "../pages/org/Team.tsx";
import { fillDays } from "../pages/org/Usage.tsx";
import { can, roleReason } from "./roles.ts";
import { validate } from "./validate.ts";
import { SignupRequest } from "@matchframe/cloud-contracts";

describe("role matrix (mirrors the API)", () => {
  it("lets only owners and billing members manage billing", () => {
    expect(["owner", "admin", "billing", "member"].filter((r) => can(r as never, "billing.manage"))).toEqual(["owner", "billing"]);
    expect(["owner", "admin", "billing", "member"].filter((r) => can(r as never, "devices.link"))).toEqual(["owner", "admin", "member"]);
    expect(["owner", "admin", "billing", "member"].filter((r) => can(r as never, "devices.revoke"))).toEqual(["owner", "admin"]);
    expect(can("staff", "billing.view")).toBe(true);
    expect(can("staff", "billing.manage")).toBe(false);
    expect(can(null, "org.view")).toBe(false);
  });

  it("explains who may act", () => {
    expect(roleReason("owner", "devices.revoke")).toBeNull();
    expect(roleReason("member", "devices.revoke")).toBe("Only owners and admins can do this (your role: member).");
    expect(roleReason("staff", "members.manage")).toMatch(/^Staff view/);
  });
});

describe("team rules", () => {
  const m = (role: Member["role"]): Member => ({ userId: "u", email: "a@b.co", displayName: "A", role, since: "2026-10-01T00:00:00Z" });
  it("protects the last owner and the owner role", () => {
    expect(roleChangeBlocker("owner", m("owner"), 1)).toBe("The only owner can't change role: make someone else an owner first.");
    expect(roleChangeBlocker("owner", m("owner"), 2)).toBeNull();
    expect(roleChangeBlocker("admin", m("owner"), 2)).toBe("Only owners can change an owner's role.");
    expect(roleChangeBlocker("admin", m("member"), 1)).toBeNull();
    expect(roleChangeBlocker("billing", m("member"), 1)).toBe("Only owners and admins can do this (your role: billing).");
  });
});

describe("catalogue forms produce bodies the API accepts", () => {
  const pro: Plan = { id: "pro", name: "Pro", description: "For regular productions.", priceMonthlyCents: 4900, currency: "usd", includedAutoDirectorHours: 40, features: { autoDirector: true, learnedDirectorShadow: true, maxDevices: 2, maxMembers: 5 }, stripePriceId: "price_pro", public: true, sortOrder: 1 };

  it("round-trips a plan", () => {
    expect(Plan.parse(formToPlan(planToForm(pro)))).toEqual(pro);
  });

  it("maps empty fields to null (price on request, not purchasable)", () => {
    const body = formToPlan({ ...planToForm(pro), priceMonthlyCents: "", stripePriceId: "  " }) as Plan;
    expect(body.priceMonthlyCents).toBeNull();
    expect(body.stripePriceId).toBeNull();
    expect(Plan.safeParse(body).success).toBe(true);
  });

  it("rejects bad ids and limits", () => {
    const r = Plan.safeParse(formToPlan({ ...planToForm(null), id: "Bad Id", name: "X", maxDevices: "0" }));
    expect(r.success).toBe(false);
    expect(validate(Plan, formToPlan({ ...planToForm(null), id: "Bad Id", name: "X" })).id).toBeTruthy();
  });

  it("round-trips an hour pack, including never-expiring credits", () => {
    const pack: HourPack = { id: "hours-10", name: "10 hours", hours: 10, priceCents: 1500, currency: "usd", stripePriceId: null, validDays: null, public: true };
    expect(HourPack.parse(formToPack(packToForm(pack)))).toEqual(pack);
    expect((formToPack({ ...packToForm(pack), validDays: "365" }) as HourPack).validDays).toBe(365);
  });
});

describe("usage days", () => {
  it("fills every UTC day of the range", () => {
    const days = fillDays({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z" }, [{ day: "2026-10-03", seconds: 600 }]);
    expect(days).toEqual([
      { day: "2026-10-01", seconds: 0 },
      { day: "2026-10-02", seconds: 0 },
      { day: "2026-10-03", seconds: 600 },
      { day: "2026-10-04", seconds: 0 },
    ]);
  });
});

describe("form validation uses the shared contracts", () => {
  it("gives one friendly message per field", () => {
    expect(validate(SignupRequest, { email: "nope", password: "short", displayName: "", orgName: "Org" })).toEqual({
      email: "Enter a valid email address.",
      password: "At least 10 characters.",
      displayName: "Required.",
    });
    expect(validate(SignupRequest, { email: "a@b.co", password: "long enough pw", displayName: "A", orgName: "Org" })).toEqual({});
  });
});
