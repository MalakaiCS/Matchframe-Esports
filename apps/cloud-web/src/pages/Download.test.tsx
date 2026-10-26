// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { fakeFetch, makeMe, renderWithSession } from "../test/helpers.tsx";
import { Download } from "./Download.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("download page", () => {
  it("links the installer as given (same-origin URLs work), with its SHA-256 and the SmartScreen note", async () => {
    const sha = "3f9a1c0be2d84e7f95b6a0c4d1e8f7a2b5c9d0e3f6a7b8c9d0e1f2a3b4c5d6e7";
    fakeFetch({ "GET /v1/downloads": { body: { windows: { url: "/downloads/MatchframeEsports-Setup-0.1.0.exe", sha256: sha, version: "0.1.0" }, notesUrl: "https://example.com/notes", version: "0.1.0" } } });
    renderWithSession(<Download />, makeMe());
    const link = await screen.findByRole("link", { name: "Download for Windows" });
    expect(link.getAttribute("href")).toBe("/downloads/MatchframeEsports-Setup-0.1.0.exe");
    expect(screen.getByText(sha)).toBeTruthy();
    expect(screen.getByText("Version 0.1.0")).toBeTruthy();
    expect(screen.getByText(/Get-FileHash \.\\MatchframeEsports-Setup-0\.1\.0\.exe -Algorithm SHA256/)).toBeTruthy();
    expect(screen.getByText(/Unsigned build: expect a SmartScreen warning/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Release notes" }).getAttribute("href")).toBe("https://example.com/notes");
  });

  it("says when nothing is published yet", async () => {
    fakeFetch({ "GET /v1/downloads": { body: { windows: null, notesUrl: null, version: "0.2.0" } } });
    renderWithSession(<Download />, makeMe());
    expect(await screen.findByText("Not published yet")).toBeTruthy();
    expect(screen.getByText(/upcoming version 0\.2\.0/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download for Windows" })).toBeNull();
  });
});
