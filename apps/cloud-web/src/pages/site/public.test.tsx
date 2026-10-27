// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App, resolveRoute } from "../../App.tsx";
import { FEATURES } from "../../content/features.tsx";
import { FAQ, FAQ_CATEGORIES, filterFaq } from "../../content/faq.tsx";
import { HELP_ARTICLES } from "../../content/help.tsx";
import { LEGAL_DOCS } from "../../content/legal.tsx";
import { FOOTER_COLUMNS, HEADER_NAV, isMenu } from "../../content/nav.ts";
import { SessionProvider } from "../../state/session.tsx";
import { SITE, at, err, fakeFetch, makeMe, renderWithSession } from "../../test/helpers.tsx";
import { formatLegalDate } from "../legal/Legal.tsx";
import { Contact } from "./Contact.tsx";
import { Faq } from "./Faq.tsx";
import { Status } from "./Status.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const plans = { body: { plans: [{ id: "free", name: "Free", description: "", priceMonthlyCents: 0, currency: "usd", includedAutoDirectorHours: 2, features: { autoDirector: true, learnedDirectorShadow: false, maxDevices: 1, maxMembers: 2 }, public: true, sortOrder: 0, purchasable: false }], hourPacks: [], billingConfigured: false } };
const publicApi = { "GET /v1/site": { body: SITE }, "GET /v1/plans": plans, "GET /v1/health": { body: { ok: true, version: "0.1.0", database: "pglite", billingConfigured: false } } };
const ALLOWED = new Set(["/v1/site", "/v1/plans", "/v1/health"]);

const PUBLIC_PATHS = [
  "/",
  "/features",
  ...FEATURES.map((f) => `/features/${f.slug}`),
  "/how-it-works",
  "/requirements",
  "/use-cases",
  "/pricing",
  "/faq",
  "/help",
  ...HELP_ARTICLES.map((a) => `/help/${a.slug}`),
  "/contact",
  "/about",
  "/security",
  "/status",
  "/changelog",
  "/legal",
  ...LEGAL_DOCS.map((d) => `/legal/${d.slug}`),
];

function renderApp() {
  return render(
    <SessionProvider>
      <App />
    </SessionProvider>,
  );
}

describe("public pages, signed out", () => {
  it.each(PUBLIC_PATHS)("%s renders with a title and only public API calls", async (path) => {
    at(path);
    const f = fakeFetch(publicApi);
    renderApp();
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).not.toBe("Page not found");
    await waitFor(() => expect(document.title).toMatch(/Matchframe/));
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")?.length).toBeGreaterThan(40);
    // Let effects run (site details, plans, health), then check nothing else was asked for.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    for (const c of f.calls) expect(ALLOWED.has(c.url.split("?")[0]!)).toBe(true);
    expect(f.count("GET", "/v1/auth/me")).toBe(0);
  });

  it("sets a distinct document title per page", async () => {
    const titles = new Set<string>();
    for (const path of ["/features", "/features/huds", "/how-it-works", "/requirements", "/use-cases", "/faq", "/legal/privacy"]) {
      at(path);
      fakeFetch(publicApi);
      const r = renderApp();
      await screen.findByRole("heading", { level: 1 });
      titles.add(document.title);
      r.unmount();
    }
    expect(titles.size).toBe(7);
  });

  it("redirects moved addresses", async () => {
    at("/product");
    fakeFetch(publicApi);
    renderApp();
    await waitFor(() => expect(window.location.pathname).toBe("/features"));
  });

  it("shows the early-access note on the features overview", async () => {
    at("/features");
    fakeFetch(publicApi);
    renderApp();
    expect(await screen.findByText(/Matchframe is in early access/)).toBeTruthy();
    expect(screen.getByText(/haven't yet been verified on a real CS2 client/)).toBeTruthy();
  });

  it("links every capability on the overview to its details page", async () => {
    at("/features");
    fakeFetch(publicApi);
    renderApp();
    await screen.findByRole("heading", { level: 1 });
    for (const f of FEATURES) {
      const link = screen.getByRole("link", { name: `Learn more about ${f.title}` });
      expect(link.getAttribute("href")).toBe(`/features/${f.slug}`);
    }
  });

  it("feature details pages have what it does, how it works, what you need and FAQs", async () => {
    at("/features/auto-director");
    fakeFetch(publicApi);
    renderApp();
    expect(await screen.findByRole("heading", { name: "What it does" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How it works" })).toBeTruthy();
    expect(screen.getByText("What you need")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frequently asked questions" })).toBeTruthy();
    expect(screen.getByText("Does advisory mode use hours?")).toBeTruthy();
  });

  it("unknown feature or article slugs show the 404 page", async () => {
    at("/features/teleportation");
    fakeFetch(publicApi);
    renderApp();
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("navigation links", () => {
  const strip = (to: string) => to.split(/[?#]/)[0]!;

  it("every footer link resolves to a real route", () => {
    const links = FOOTER_COLUMNS.flatMap((c) => c.links);
    expect(FOOTER_COLUMNS.map((c) => c.title)).toEqual(["Product", "Resources", "Company", "Legal"]);
    for (const l of links) expect(resolveRoute(strip(l.to)), l.to).not.toBeNull();
  });

  it("every header link resolves to a real route", () => {
    const links = HEADER_NAV.flatMap((n) => (isMenu(n) ? n.groups.flatMap((g) => g.links) : [n]));
    for (const l of links) expect(resolveRoute(strip(l.to)), l.to).not.toBeNull();
  });

  it("every link rendered in the footer resolves", async () => {
    at("/about");
    fakeFetch(publicApi);
    renderApp();
    await screen.findByRole("heading", { level: 1 });
    const footer = screen.getByRole("contentinfo");
    const hrefs = within(footer)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href")!)
      .filter((h) => h.startsWith("/"));
    expect(hrefs.length).toBeGreaterThan(20);
    for (const h of hrefs) expect(resolveRoute(strip(h)), h).not.toBeNull();
    expect(within(footer).getByText(`© ${new Date().getFullYear()} ${SITE.companyName}. All rights reserved.`)).toBeTruthy();
  });

  it("the Product menu opens, lists every feature and closes with Escape", async () => {
    at("/");
    fakeFetch(publicApi);
    renderApp();
    const toggle = await screen.findByRole("button", { name: "Product" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    for (const f of FEATURES) expect(within(panel).getByRole("link", { name: new RegExp(f.nav) })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("FAQ", () => {
  it("has the requested categories and an early-access answer", () => {
    expect(FAQ_CATEGORIES.map((c) => c.title)).toEqual(["General", "Program and installation", "Auto director and hours", "HUDs and OBS", "Accounts and teams", "Billing and subscriptions", "Privacy and security", "Troubleshooting"]);
    for (const c of FAQ_CATEGORIES) expect(FAQ.filter((f) => f.category === c.id).length).toBeGreaterThanOrEqual(3);
    expect(filterFaq(FAQ, "early access").map((f) => f.id)).toContain("early-access");
  });

  it("filterFaq searches questions and answers", () => {
    expect(filterFaq(FAQ, "37210").map((f) => f.id)).toContain("no-gsi");
    expect(filterFaq(FAQ, "smartscreen code-signed").map((f) => f.id)).toEqual(["smartscreen"]);
    expect(filterFaq(FAQ, "")).toHaveLength(FAQ.length);
  });

  it("filters the page as you type and can be cleared", async () => {
    at("/faq");
    fakeFetch({});
    renderWithSession(<Faq />, null);
    const box = screen.getByRole("searchbox", { name: "Filter questions" });
    fireEvent.change(box, { target: { value: "SmartScreen" } });
    expect(screen.getByText("Why does Windows show a SmartScreen warning?")).toBeTruthy();
    expect(screen.queryByText("What counts as an auto-director hour?")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/of \d+ questions match “SmartScreen”/);
    fireEvent.change(box, { target: { value: "zzzz-nothing" } });
    expect(screen.getByText("Nothing matches that filter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "clear the filter" }));
    expect(screen.getByText("What counts as an auto-director hour?")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent).slice(0, FAQ_CATEGORIES.length)).toEqual(FAQ_CATEGORIES.map((c) => c.title));
  });
});

describe("legal documents", () => {
  it("fill in the company details and date from /v1/site", async () => {
    at("/legal/terms");
    fakeFetch(publicApi);
    renderApp();
    expect(await screen.findByText(`Last updated ${formatLegalDate("2026-10-01")}`)).toBeTruthy();
    expect(screen.getAllByText(/Northlight Media Ltd/).length).toBeGreaterThan(1);
    expect(screen.getByText(/governed by the laws of England and Wales/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "help@example.com" }).length).toBeGreaterThan(0);
  });

  it("fall back to generic wording, with a warning, when the details can't load", async () => {
    at("/legal/privacy");
    fakeFetch({ "GET /v1/site": err(500, "internal", "boom") });
    renderApp();
    expect(await screen.findByText("Company details couldn't be loaded")).toBeTruthy();
    expect(screen.getAllByText(/the operator of this website/).length).toBeGreaterThan(0);
  });

  it("formatLegalDate never shifts the day", () => {
    expect(formatLegalDate("2026-01-01", "en-GB")).toBe("1 January 2026");
    expect(formatLegalDate("not a date")).toBe("not a date");
  });
});

describe("contact form", () => {
  it("validates, then posts the message with the topic from the address", async () => {
    at("/contact?topic=billing");
    const f = fakeFetch({ "GET /v1/site": { body: SITE }, "POST /v1/contact": { status: 201, body: { received: true } } });
    renderWithSession(<Contact />, null);
    expect(await screen.findByRole("link", { name: "help@example.com" })).toBeTruthy();
    expect((screen.getByLabelText("Topic") as HTMLSelectElement).value).toBe("billing");
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Jo Rivera" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jo@example.com" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Please write at least 10 characters so we can help.")).toBeTruthy();
    expect(f.count("POST", "/v1/contact")).toBe(0);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Can I get an invoice with our VAT number?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Thanks, we've received your message")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Jo Rivera", email: "jo@example.com", topic: "billing", message: "Can I get an invoice with our VAT number?", orgId: null });
  });

  it("prefills signed-in details, sends the organisation and explains rate limits", async () => {
    at("/contact");
    const f = fakeFetch({ "GET /v1/site": { body: SITE }, "POST /v1/contact": err(429, "rate_limited", "too many requests; wait a minute and try again") });
    renderWithSession(<Contact />, makeMe());
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Riley Park");
    expect((screen.getByLabelText("Organisation") as HTMLSelectElement).value).toBe("org_1");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Our computer slot looks wrong after unlinking." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/You've sent several messages in a short time/)).toBeTruthy();
    expect((f.calls.find((c) => c.method === "POST")!.body as { orgId: string }).orgId).toBe("org_1");
  });
});

describe("status page", () => {
  it("reports operational when the health check passes", async () => {
    fakeFetch({ "GET /v1/health": { body: { ok: true, version: "0.1.0", database: "postgres", billingConfigured: true } } });
    renderWithSession(<Status />, null);
    expect(await screen.findByText("All systems operational")).toBeTruthy();
    expect(screen.getAllByText("Operational").length).toBe(3);
  });

  it("reports a degraded service when the API answers with an error", async () => {
    fakeFetch({ "GET /v1/health": err(500, "internal", "database unavailable") });
    renderWithSession(<Status />, null);
    expect(await screen.findByText("Some systems are having problems")).toBeTruthy();
  });

  it("reports an unreachable service on network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    renderWithSession(<Status />, null);
    expect(await screen.findByText("The service can't be reached")).toBeTruthy();
  });
});
