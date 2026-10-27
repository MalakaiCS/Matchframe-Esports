// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, loginHref, matchPath, navigate, safeNext, useLocation } from "./router.tsx";
import { at } from "./test/helpers.tsx";

afterEach(cleanup);

describe("matchPath", () => {
  it("extracts and decodes params", () => {
    expect(matchPath("/orgs/:orgId/billing", "/orgs/org_1/billing")).toEqual({ orgId: "org_1" });
    expect(matchPath("/orgs/:orgId", "/orgs/a%20b")).toEqual({ orgId: "a b" });
    expect(matchPath("/", "/")).toEqual({});
  });

  it("rejects different shapes and malformed escapes", () => {
    expect(matchPath("/orgs/:orgId", "/orgs/a/billing")).toBeNull();
    expect(matchPath("/orgs/:orgId/billing", "/orgs/a/usage")).toBeNull();
    expect(matchPath("/orgs/:orgId", "/orgs/%E0%A4%A")).toBeNull();
  });
});

describe("safeNext", () => {
  it("follows same-site paths only", () => {
    expect(safeNext("/link?code=BCDF-GHJK")).toBe("/link?code=BCDF-GHJK");
    expect(safeNext("/orgs/x/billing#plans", "/")).toBe("/orgs/x/billing#plans");
  });

  it.each(["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "evil", "/\nfoo", null, ""])("falls back for %j", (n) => {
    expect(safeNext(n as string | null, "/home")).toBe("/home");
  });
});

describe("loginHref", () => {
  it("keeps where you were, but never loops on /login", () => {
    expect(loginHref("/link?code=BCDF-GHJK")).toBe("/login?next=%2Flink%3Fcode%3DBCDF-GHJK");
    expect(loginHref("/login?next=%2Fx")).toBe("/login");
    expect(loginHref("/")).toBe("/login");
  });
});

function Where() {
  const loc = useLocation();
  return (
    <p>
      path={loc.path} q={loc.query.get("q") ?? ""}
    </p>
  );
}

describe("navigation", () => {
  it("re-renders subscribers on navigate and on back/forward", () => {
    at("/start");
    render(<Where />);
    expect(screen.getByText("path=/start q=")).toBeTruthy();
    act(() => navigate("/pricing?q=1"));
    expect(screen.getByText("path=/pricing q=1")).toBeTruthy();
    expect(window.location.pathname).toBe("/pricing");
    act(() => {
      window.history.replaceState(null, "", "/account/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText("path=/account q=")).toBeTruthy();
  });

  it("replace does not add a history entry", () => {
    at("/a");
    const before = window.history.length;
    act(() => navigate("/b", { replace: true }));
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe("/b");
  });

  it("Link navigates client-side but leaves modified clicks to the browser", () => {
    at("/");
    render(
      <>
        <Link to="/pricing">Pricing</Link>
        <Where />
      </>,
    );
    const link = screen.getByRole("link", { name: "Pricing" });
    expect(link.getAttribute("href")).toBe("/pricing");
    const ctrl = fireEvent.click(link, { ctrlKey: true });
    expect(ctrl).toBe(true); // default not prevented: new tab
    expect(window.location.pathname).toBe("/");
    const plain = fireEvent.click(link);
    expect(plain).toBe(false);
    expect(screen.getByText("path=/pricing q=")).toBeTruthy();
  });
});
