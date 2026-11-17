// @vitest-environment node
import { describe, expect, it } from "vitest";

/** scripts/i18n-check.mjs as a test (ADR-082): keys, stray keys, placeholders and plural forms in every catalog. */
describe("translation catalogs", () => {
  it("pass scripts/i18n-check.mjs", async () => {
    // A file URL (not a module path) keeps TypeScript from resolving the plain .mjs script, and works from either test config's root.
    const script = new URL("../../../../scripts/i18n-check.mjs", import.meta.url).href;
    const { checkCatalogs } = (await import(/* @vite-ignore */ script)) as { checkCatalogs(): { problems: string[]; stats: { console: number; desktop: number } } };
    const { problems, stats } = checkCatalogs();
    expect(problems).toEqual([]);
    expect(stats.console).toBeGreaterThan(400);
    expect(stats.desktop).toBeGreaterThan(100);
  });
});
