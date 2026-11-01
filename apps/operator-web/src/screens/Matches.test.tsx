// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetListStates } from "../lib/listState.ts";
import { at, choose, mount, serve, TEAMS } from "./testkit.tsx";

const made: string[] = [];
vi.mock("../lib/match-art/make.ts", () => ({
  ART_ORDER: [],
  makeMatchArt: (id: string) => {
    made.push(id);
    return Promise.resolve({ matchId: id, state: "done", step: "Done", progress: 1, made: [], error: null });
  },
  useArtJob: () => null,
}));
const { MatchesScreen, MatchEditorScreen, shortNameOf } = await import("./Matches.tsx");

const FORMAT = { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false };
const POOL = { maps: ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_cache"].map((m) => ({ mapName: m, displayName: m.slice(3, 4).toUpperCase() + m.slice(4) })), known: [] };
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, eventId: null, stageId: null, teamAId: "t_lite", teamBId: "t_nl", format: FORMAT, status: "scheduled", scheduledAt: "2026-11-20T08:00:00.000Z", seriesScoreA: 0, seriesScoreB: 0, mapPool: [], title: null, revision: 1, archived: false, maps: [], group: "future", active: false, ...over });
const COMMON = { "GET /api/v1/teams": TEAMS, "GET /api/v1/events": [], "GET /api/v1/map-pool": POOL, "GET /api/v1/players": [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetListStates();
  made.length = 0;
});

describe("Matches: list", () => {
  it("groups matches into Current, Future and Ended (independent of Active) and makes another match active", async () => {
    let active = "m_cur";
    const calls = serve({
      ...COMMON,
      "GET /api/v1/matches": () => [row("m_cur", { group: "current", status: "live", seriesScoreA: 1, active: active === "m_cur" }), row("m_fut", { active: active === "m_fut" }), row("m_end", { group: "ended", status: "completed", seriesScoreA: 2, seriesScoreB: 1 })],
      "POST /api/v1/matches/m_fut/activate": () => {
        active = "m_fut";
        return { active: "m_fut", previous: "m_cur" };
      },
    });
    at("/matches");
    mount(<MatchesScreen />);
    expect(await screen.findByRole("tab", { name: "Current (1)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Future (1)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Ended (1)" })).toBeTruthy();
    // The active match is on Current; it is marked, and named in the toolbar.
    const current = screen.getAllByText("LITE Esports")[0]!.closest("tr")!;
    expect(within(current).getByText("Active")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Future (1)" }));
    const future = screen.getAllByText("LITE Esports")[0]!.closest("tr")!;
    expect(within(future).getByText("BO3")).toBeTruthy();
    fireEvent.click(within(future).getByRole("button", { name: "Make Active" }));
    const dialog = await screen.findByRole("dialog", { name: "Make LITE Esports vs Northern Lights active?" });
    expect(within(dialog).getByText(/stops being active/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make Active" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/matches/m_fut/activate")).toBe(true));
    await waitFor(() => expect(within(screen.getAllByText("LITE Esports")[0]!.closest("tr")!).getByText("Active")).toBeTruthy());
    // Still in Future: activation does not change the grouping.
    expect(screen.getByRole("tab", { name: "Future (1)" })).toBeTruthy();
  });
});

describe("Matches: Create Match / Edit Match", () => {
  it("creates a match from saved teams with its format and veto (entry dialog), refusing identical opponents", async () => {
    const calls = serve({ ...COMMON, "POST /api/v1/matches": (b: unknown) => ({ ...row("m_new"), ...(b as object) }) });
    at("/matches/new");
    mount(<MatchEditorScreen />);
    expect(await screen.findByText("Choose Team 1 and Team 2 first.")).toBeTruthy();
    choose(screen.getByRole("combobox", { name: /^Team 1/ }), "LITE Esports", "lite");
    choose(screen.getByRole("combobox", { name: /^Team 2/ }), "LITE Esports", "lite");
    expect(screen.getAllByText("Team 1 and Team 2 must be different teams").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    await waitFor(() => expect(screen.getByText(/Not saved: Team 1 and Team 2 must be different teams/)).toBeTruthy());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    choose(screen.getByRole("combobox", { name: /^Team 2/ }), "Northern Lights", "north");
    fireEvent.click(screen.getByRole("radio", { name: "BO1" }));
    // Series wins are checked against the format.
    fireEvent.click(screen.getByRole("button", { name: "LITE Esports series wins plus one" }));
    expect(screen.getByRole("button", { name: "LITE Esports series wins plus one" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "LITE Esports series wins minus one" }));
    // Veto: a ban by Northern Lights, then a decider.
    fireEvent.click(await screen.findByRole("button", { name: "Add entry" }));
    let dialog = await screen.findByRole("dialog", { name: "Add veto entry" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Northern Lights/ }));
    choose(within(dialog).getByLabelText("Map"), "Mirage", "mir");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add entry" }));
    fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
    dialog = await screen.findByRole("dialog", { name: "Add veto entry" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Decider" }));
    // A map already used is marked in the list.
    fireEvent.focus(within(dialog).getByLabelText("Map"));
    expect(within(dialog).getByText("used in entry 1")).toBeTruthy();
    choose(within(dialog).getByLabelText("Map"), "Nuke", "nuk");
    fireEvent.click(within(dialog).getByRole("radio", { name: "CT" }));
    expect(within(dialog).getByText("Starting side chosen by LITE Esports")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add entry" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("Mirage")).toBeTruthy();
    expect(within(table).getByText("Decider")).toBeTruthy();
    expect(screen.getByText(/1 of 1 map chosen · complete/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: "2026-11-20T18:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    await waitFor(() => expect(window.location.pathname).toBe("/matches"));
    const body = calls.find((c) => c.method === "POST" && c.path === "/api/v1/matches")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ teamAId: "t_lite", teamBId: "t_nl", format: { bestOf: 1 }, seriesScoreA: 0, seriesScoreB: 0 });
    expect(body.veto).toMatchObject([
      { type: "ban", teamId: "t_nl", mapName: "de_mirage", sideChoice: null },
      { type: "decider", teamId: null, mapName: "de_nuke", sideChoice: "CT", reversedSides: false },
    ]);
    expect(new Date(body.scheduledAt as string).getHours()).toBe(18);
    await waitFor(() => expect(made).toEqual(["m_new"]));
  });

  it("edits a match: sends only the changed fields with their loaded values, and offers to reload after a conflict", async () => {
    const detail = { ...row("m1"), vetoEntries: [{ id: "v1", type: "ban", teamId: "t_lite", mapName: "de_inferno", sideChoice: null, reversedSides: false }], vetoSource: "match", captainDecisions: 0, pool: POOL.maps.map((m) => m.mapName), poolSource: "app", seriesFromMaps: { a: 0, b: 0 }, corrections: [] };
    let n = 0;
    const calls = serve({
      ...COMMON,
      "GET /api/v1/matches/m1": detail,
      "GET /api/v1/matches/m1/art": { items: [], obs: { transitions: {} } },
      "GET /api/v1/veto/m1": { steps: [], decisions: [], currentStep: null, remainingMaps: [], pickedMaps: [], complete: false, history: [] },
      "PATCH /api/v1/matches/m1": () => (++n === 1 ? { status: 409, json: { error: "field_conflict", message: "Date and time changed elsewhere while you were editing.", detail: [{ path: ["scheduledAt"], message: "Date and time was changed elsewhere while you were editing" }] } } : detail),
    });
    at("/matches/m1/edit");
    mount(<MatchEditorScreen />);
    expect(await screen.findByText("Edit match: LITE Esports vs Northern Lights")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Final" } });
    fireEvent.click(screen.getByRole("radio", { name: "BO5" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    expect(await screen.findByText(/changed while you were editing/)).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ changes: { title: "Final", format: { ...FORMAT, bestOf: 5 } }, expected: { title: null, format: FORMAT } });
    // The person's values stay after the failure.
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Final");
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    await waitFor(() => expect(window.location.pathname).toBe("/matches"));
  });

  it("makes a short name from the team name", () => {
    expect(shortNameOf("Northern Lights")).toBe("NL");
    expect(shortNameOf("Redline")).toBe("REDL");
    expect(shortNameOf("  team   falcons esports club ")).toBe("TFEC");
  });
});
