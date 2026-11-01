// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetListStates } from "../lib/listState.ts";
import { navigate } from "../router.tsx";
import { at, choose, MALAKAI, mount, serve, STAGED, TEAMS } from "./testkit.tsx";
import { PlayerEditorScreen, PlayersScreen, TeamEditorScreen, TeamsScreen } from "./Teams.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetListStates();
});

const pngFile = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" });

describe("Teams: list page", () => {
  it("shows logo, names, country with flag and player count; searches and filters by country", async () => {
    serve({ "GET /api/v1/teams": TEAMS });
    at("/teams");
    mount(<TeamsScreen />);
    expect(await screen.findByText("LITE Esports")).toBeTruthy();
    const row = screen.getByText("Northern Lights").closest("tr")!;
    expect(within(row).getByText("NL")).toBeTruthy();
    expect(within(row).getByText("United Kingdom")).toBeTruthy();
    expect(within(row).getByAltText("Northern Lights logo").getAttribute("src")).toBe("/assets/abc.png");
    expect(within(screen.getByText("LITE Esports").closest("tr")!).getByText("1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search teams"), { target: { value: "lite" } });
    expect(screen.queryByText("Northern Lights")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search teams"), { target: { value: "" } });
    choose(screen.getByLabelText("Country"), "United Kingdom", "united");
    expect(screen.queryByText("LITE Esports")).toBeNull();
    expect(screen.getByText("Northern Lights")).toBeTruthy();
  });

  it("confirms a bulk delete naming each team and what blocks it, and offers Archive instead", async () => {
    const calls = serve({
      "GET /api/v1/teams": TEAMS,
      "POST /api/v1/teams/delete-preview": {
        records: [
          { id: "t_lite", label: "LITE Esports", deletable: false, blockers: ["Used by 1 match: LITE Esports vs Northern Lights", "1 assigned player: Malakai. Move or unassign them first"], effects: [] },
          { id: "t_nl", label: "Northern Lights", deletable: true, blockers: [], effects: ["The logo file stays in the asset store (other records may use it)"] },
        ],
      },
      "POST /api/v1/teams/t_lite/archive": { archived: true },
      "POST /api/v1/teams/delete": { deleted: ["t_nl"] },
    });
    at("/teams");
    mount(<TeamsScreen />);
    await screen.findByText("LITE Esports");
    fireEvent.click(screen.getByLabelText("Select all teams shown"));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 2 teams?" });
    expect(await within(dialog).findByText("Used by 1 match: LITE Esports vs Northern Lights")).toBeTruthy();
    expect(within(dialog).getByText("1 assigned player: Malakai. Move or unassign them first")).toBeTruthy();
    expect(within(dialog).getByText("Cannot be deleted")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive LITE Esports instead" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/teams/t_lite/archive")).toBe(true));
    expect(calls.some((c) => c.path === "/api/v1/teams/delete")).toBe(false);
  });
});

describe("Teams: Add Team / Edit Team", () => {
  it("creates LITE Esports with country and a staged logo, then returns to Teams", async () => {
    const calls = serve({ "POST /api/v1/uploads/images": STAGED, "POST /api/v1/teams": (b: unknown) => ({ ...(b as object), id: "t_new" }) });
    at("/teams/new");
    mount(<TeamEditorScreen />);
    fireEvent.change(screen.getByLabelText(/^Team name/), { target: { value: "LITE Esports" } });
    fireEvent.change(screen.getByLabelText(/^Short name/), { target: { value: "LITE" } });
    choose(screen.getByLabelText("Country"), "Australia", "austr");
    fireEvent.change(screen.getByLabelText("Upload logo"), { target: { files: [pngFile()] } });
    expect(await screen.findByAltText("Logo preview")).toBeTruthy();
    expect((screen.getByAltText("Logo preview") as HTMLImageElement).getAttribute("src")).toBe(STAGED.previewUrl);
    // Double click: one save.
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    fireEvent.click(screen.getByRole("button", { name: /Sav/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/teams"));
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/v1/teams");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ name: "LITE Esports", shortName: "LITE", countryCode: "AU", logoStagedId: STAGED.stagedId });
  });

  it("Cancel on a new form with an image discards the upload and creates nothing", async () => {
    const calls = serve({ "POST /api/v1/uploads/images": STAGED, [`DELETE /api/v1/uploads/images/${STAGED.stagedId}`]: { discarded: true } });
    at("/teams/new");
    mount(<TeamEditorScreen />);
    fireEvent.change(screen.getByLabelText(/^Team name/), { target: { value: "Temp" } });
    fireEvent.change(screen.getByLabelText("Upload logo"), { target: { files: [pngFile()] } });
    await screen.findByAltText("Logo preview");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(window.location.pathname).toBe("/teams"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/v1/uploads/images/${STAGED.stagedId}`)).toBe(true));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/teams")).toBe(false);
  });

  it("keeps the values and shows the field error when saving fails; asks before leaving with changes", async () => {
    serve({ "POST /api/v1/teams": { status: 400, json: { error: "invalid", message: "A team named LITE Esports already exists", detail: [{ path: ["name"], message: "A team named LITE Esports already exists" }] } } });
    at("/teams/new");
    mount(<TeamEditorScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    expect(await screen.findByText("Enter a team name")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Team name/), { target: { value: "lite esports" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    expect((await screen.findAllByText(/A team named LITE Esports already exists/)).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/teams/new");
    expect((screen.getByLabelText(/^Team name/) as HTMLInputElement).value).toBe("lite esports");
    // Navigation (sidebar, links, Back) waits for a decision.
    act(() => navigate("/players"));
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(window.location.pathname).toBe("/teams/new");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(window.location.pathname).toBe("/teams/new");
    act(() => navigate("/players"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard changes" }));
    expect(window.location.pathname).toBe("/players");
  });

  it("lists assigned players as tiles, assigns an existing player, and offers to save before Add Player", async () => {
    const calls = serve({
      "GET /api/v1/teams/t_lite": { ...TEAMS[0], roster: [{ id: "m1", teamId: "t_lite", playerId: "p_mal", role: "player", validFrom: "2026-01-01", validTo: null, player: MALAKAI }] },
      "GET /api/v1/players": [MALAKAI, { ...MALAKAI, id: "p_sub", displayName: "Subby", teamId: "t_nl", steamId: "76561198000000002" }],
      "GET /api/v1/teams": TEAMS,
      "PATCH /api/v1/players/p_sub": { ...MALAKAI, id: "p_sub", teamId: "t_lite" },
    });
    at("/teams/t_lite/edit");
    mount(<TeamEditorScreen />);
    const tile = await screen.findByTitle("Edit Malakai");
    expect(within(tile).getByText("No SteamID64 · won't match live CS2 data")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Assign Existing Player" }));
    const dialog = await screen.findByRole("dialog", { name: "Assign a player to LITE Esports" });
    choose(within(dialog).getByLabelText("Player"), "Subby", "sub");
    fireEvent.change(within(dialog).getByLabelText(/^Role/), { target: { value: "substitute" } });
    expect(within(dialog).getByText(/Subby leaves Northern Lights/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign player" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ changes: { teamId: "t_lite", role: "substitute" }, expected: { teamId: "t_nl" } }));
    // Unsaved team changes are handled first.
    fireEvent.change(screen.getByLabelText(/^Short name/), { target: { value: "LT" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Player" }));
    const ask = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(within(ask).getByRole("button", { name: "Save and continue" })).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Discard changes" }));
    expect(window.location.pathname + window.location.search).toBe("/players/new?teamId=t_lite&returnTo=%2Fteams%2Ft_lite%2Fedit");
  });
});

describe("Players", () => {
  it("lists players with names, flag, team and SteamID64, marks missing SteamIDs, and filters Unassigned", async () => {
    serve({ "GET /api/v1/players": [MALAKAI, { ...MALAKAI, id: "p2", displayName: "free", firstName: "", lastName: "", realName: null, teamId: null, steamId: "76561198000000002", countryCode: null }], "GET /api/v1/teams": TEAMS });
    at("/players");
    mount(<PlayersScreen />);
    const row = (await screen.findByText("Malakai")).closest("tr")!;
    expect(within(row).getByText("Kai")).toBeTruthy();
    expect(within(row).getByText("Brown")).toBeTruthy();
    expect(within(row).getByText("Australia")).toBeTruthy();
    expect(within(row).getByText("LITE Esports")).toBeTruthy();
    expect(within(row).getByText("No SteamID64 · won't match live CS2 data")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search players"), { target: { value: "kai brown" } });
    expect(screen.queryByText("free")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search players"), { target: { value: "" } });
    choose(screen.getByLabelText("Team"), "Unassigned", "unass");
    expect(screen.queryByText("Malakai")).toBeNull();
    expect(screen.getByText("76561198000000002")).toBeTruthy();
  });

  it("adds a player on the team it was opened from, warns without a SteamID64 and shows a duplicate SteamID error", async () => {
    let n = 0;
    const calls = serve({
      "GET /api/v1/teams": TEAMS,
      "POST /api/v1/players": () => (++n === 1 ? { status: 400, json: { error: "invalid", message: "SteamID64 76561198000000001 already belongs to Malakai", detail: [{ path: ["steamId"], message: "SteamID64 76561198000000001 already belongs to Malakai" }] } } : { ...MALAKAI, id: "p_new" }),
    });
    at("/players/new?teamId=t_lite&returnTo=%2Fteams%2Ft_lite%2Fedit");
    mount(<PlayerEditorScreen />);
    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLInputElement).value).toBe("LITE Esports"));
    fireEvent.change(screen.getByLabelText(/^Nickname/), { target: { value: "Malakai" } });
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Kai" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Brown" } });
    expect(screen.getAllByText(/won't match live CS2 data/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/SteamID64/), { target: { value: "123" } });
    expect(screen.getByText("SteamID64 has 17 digits; this one has 3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/SteamID64/), { target: { value: "76561198000000001" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    expect(await screen.findByText("SteamID64 76561198000000001 already belongs to Malakai")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/SteamID64/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    await waitFor(() => expect(window.location.pathname).toBe("/teams/t_lite/edit"));
    expect(calls.filter((c) => c.method === "POST")[1]!.body).toMatchObject({ displayName: "Malakai", firstName: "Kai", lastName: "Brown", steamId: null, teamId: "t_lite", role: "player" });
  });

  it("imports a spreadsheet: row errors in the preview, then only the valid rows", async () => {
    const calls = serve({
      "GET /api/v1/players": [],
      "GET /api/v1/teams": TEAMS,
      "POST /api/v1/import/players/preview": {
        rows: [
          { row: 2, values: { displayName: "fox1", steamId: "76561198000000101", team: "LITE" }, errors: [] },
          { row: 3, values: { displayName: "fox2", team: "RF" }, errors: ['Team "RF" is ambiguous: it matches Red Fox (RF), R F Gaming (RF). Use the full team name or its id'] },
        ],
        ignoredColumns: ["Notes"],
        total: 2,
        valid: 1,
        invalid: 1,
      },
      "POST /api/v1/import/players/commit": { created: ["p1"], skippedRows: [3] },
    });
    at("/players");
    mount(<PlayersScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Import Players" }));
    const dialog = await screen.findByRole("dialog", { name: "Import players" });
    fireEvent.change(within(dialog).getByLabelText("Choose .xlsx file"), { target: { files: [new File(["x"], "roster.csv")] } });
    expect(await within(dialog).findByText(/roster.csv is not an .xlsx file/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Choose .xlsx file"), { target: { files: [new File(["PK"], "roster.xlsx")] } });
    expect(await within(dialog).findByText(/Team "RF" is ambiguous/)).toBeTruthy();
    expect(within(dialog).getByText(/Ignored columns: Notes/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import 1 valid row, skip 1" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/import/players/commit")?.query).toBe("?skipInvalid=1"));
  });

  it("edits only the changed fields, with the values loaded as preconditions", async () => {
    const calls = serve({ "GET /api/v1/players/p_mal": { ...MALAKAI, history: [] }, "GET /api/v1/teams": TEAMS, "GET /api/v1/players": [MALAKAI], "PATCH /api/v1/players/p_mal": { ...MALAKAI, teamId: "t_nl" } });
    at("/players/p_mal/edit");
    mount(<PlayerEditorScreen />);
    await screen.findByDisplayValue("Malakai");
    choose(screen.getByLabelText("Team"), "Northern Lights", "north");
    fireEvent.click(screen.getByRole("button", { name: "Save and Exit" }));
    await waitFor(() => expect(window.location.pathname).toBe("/players"));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ changes: { teamId: "t_nl" }, expected: { teamId: "t_lite" } });
  });
});
