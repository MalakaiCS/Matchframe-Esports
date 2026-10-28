// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionContext } from "../state/session.tsx";
import { ToastProvider } from "../components/toasts.tsx";

const made: string[] = [];
vi.mock("../lib/match-art/make.ts", () => ({
  ART_ORDER: [],
  makeMatchArt: (id: string) => {
    made.push(id);
    return Promise.resolve({ matchId: id, state: "done", step: "Done", progress: 1, made: [], error: null });
  },
  useArtJob: () => null,
}));
const { MatchesScreen, shortNameOf } = await import("./Matches.tsx");

const FORMAT = { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false };

function serve(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = new URL(url, "http://x").pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const r = routes[`${method} ${path}`];
      const out = typeof r === "function" ? (r as (b: unknown) => unknown)(body) : r;
      return new Response(JSON.stringify(out ?? { error: "not_found" }), { status: out === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const wrap = () =>
  render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role: "owner" } }}>
        <MatchesScreen />
      </SessionContext.Provider>
    </ToastProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  made.length = 0;
});

describe("Matches: creating a match", () => {
  it("makes a match from nothing: both teams created in the form, then the match, then its graphics", async () => {
    let n = 0;
    const calls = serve({
      "GET /api/v1/matches": [],
      "GET /api/v1/teams": [],
      "GET /api/v1/events": [],
      "GET /api/v1/players": [],
      "GET /api/v1/settings/live.activeMatchId": { value: null },
      "GET /api/v1/coverage/maps": [],
      "GET /api/v1/maps": [],
      "POST /api/v1/teams": (b: unknown) => ({ ...(b as object), id: `t${++n}` }),
      "POST /api/v1/matches": (b: unknown) => ({ ...(b as object), id: "m1", status: "scheduled", format: FORMAT }),
    });
    wrap();
    // No teams yet: the form shows anyway, with "New team…" picked for both sides.
    const nameA = await screen.findByLabelText(/^Team A name/);
    fireEvent.change(nameA, { target: { value: "Northern Lights" } });
    fireEvent.change(screen.getByLabelText(/^Team B name/), { target: { value: "Redline" } });
    fireEvent.change(screen.getByLabelText(/Team B short name/), { target: { value: "RDL" } });
    fireEvent.click(screen.getByText("BO1"));
    fireEvent.change(screen.getByPlaceholderText("de_mirage"), { target: { value: "de_nuke" } });
    fireEvent.click(screen.getByRole("button", { name: "Add map" }));
    fireEvent.click(screen.getByRole("button", { name: "Create match" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/matches")).toBe(true));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["/api/v1/teams", "/api/v1/teams", "/api/v1/matches"]);
    expect(posts[0]!.body).toEqual({ name: "Northern Lights", shortName: "NL" });
    expect(posts[1]!.body).toEqual({ name: "Redline", shortName: "RDL" });
    expect(posts[2]!.body).toMatchObject({ teamAId: "t1", teamBId: "t2", mapPool: ["de_nuke"], format: { bestOf: 1 } });
    // The thumbnails and stingers are made for the new match.
    await waitFor(() => expect(made).toEqual(["m1"]));
  });

  it("shows a Create match button when a match is open", async () => {
    serve({
      "GET /api/v1/matches": [{ id: "m1", teamAId: "a", teamBId: "b", format: FORMAT, status: "scheduled", seriesScoreA: 0, seriesScoreB: 0, title: null, eventId: null }],
      "GET /api/v1/teams": [
        { id: "a", name: "Alpha", shortName: "ALP" },
        { id: "b", name: "Bravo", shortName: "BRV" },
      ],
      "GET /api/v1/events": [],
      "GET /api/v1/players": [],
      "GET /api/v1/settings/live.activeMatchId": { value: null },
      "GET /api/v1/matches/m1": { id: "m1", teamAId: "a", teamBId: "b", format: FORMAT, status: "scheduled", seriesScoreA: 0, seriesScoreB: 0, title: null, eventId: null, mapPool: [], maps: [], corrections: [], revision: 1 },
      "GET /api/v1/coverage/maps": [],
      "GET /api/v1/maps": [],
    });
    wrap();
    const button = await screen.findByRole("button", { name: "Create match" });
    fireEvent.click(button);
    expect(await screen.findByText("New match")).toBeTruthy();
    // Existing teams are offered, and a new one can still be made.
    const pick = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect([...pick.options].map((o) => o.text)).toEqual(["Choose…", "Alpha", "Bravo", "New team…"]);
  });

  it("makes a short name from the team name", () => {
    expect(shortNameOf("Northern Lights")).toBe("NL");
    expect(shortNameOf("Redline")).toBe("REDL");
    expect(shortNameOf("  team   falcons esports club ")).toBe("TFEC");
  });
});
