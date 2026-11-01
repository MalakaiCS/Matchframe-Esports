import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { ToastProvider } from "../components/toasts.tsx";
import { SessionContext } from "../state/session.tsx";

/** Test helpers for the record screens: a fake engine API (fetch) and combobox driving. */

export interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

type Handler = unknown | ((body: unknown, call: Call) => unknown);

/** Answers fetch from `routes` ("METHOD /path"); a handler may return { status, json } for errors. */
export function serve(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const u = new URL(url, "http://x");
      let body: unknown = undefined;
      if (typeof init.body === "string") body = JSON.parse(init.body);
      else if (init.body) body = init.body;
      const call = { method, path: u.pathname, query: u.search, body };
      calls.push(call);
      const r = routes[`${method} ${u.pathname}`];
      const out = typeof r === "function" ? (r as (b: unknown, c: Call) => unknown)(body, call) : r;
      if (out && typeof out === "object" && "status" in (out as object) && "json" in (out as object)) {
        const o = out as { status: number; json: unknown };
        return new Response(JSON.stringify(o.json), { status: o.status, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(out ?? { error: "not_found", message: `no fake for ${method} ${u.pathname}` }), { status: out === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

export function at(path: string): void {
  window.history.pushState(null, "", path);
}

export function mount(ui: ReactNode) {
  return render(
    <ToastProvider>
      <SessionContext.Provider value={{ me: { role: "owner" } }}>{ui}</SessionContext.Provider>
    </ToastProvider>,
  );
}

/** Opens a combobox, types, and picks the option with this label. */
export function choose(input: HTMLElement, label: string, type = label): void {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: type } });
  const list = document.getElementById(input.getAttribute("aria-controls")!)!;
  fireEvent.mouseDown(within(list).getByText(label));
}

export const byLabel = (re: RegExp | string) => screen.getByLabelText(re);

export const TEAMS = [
  { id: "t_lite", name: "LITE Esports", shortName: "LITE", logoAssetId: null, countryCode: "AU", primaryColor: null, secondaryColor: null, region: null, sponsorMetadata: {}, revision: 1, archived: false, playerCount: 1 },
  { id: "t_nl", name: "Northern Lights", shortName: "NL", logoAssetId: "abc.png", countryCode: "GB", primaryColor: null, secondaryColor: null, region: null, sponsorMetadata: {}, revision: 1, archived: false, playerCount: 0 },
];

export const MALAKAI = {
  id: "p_mal",
  displayName: "Malakai",
  firstName: "Kai",
  lastName: "Brown",
  realName: "Kai Brown",
  steamId: null,
  countryCode: "AU",
  avatarAssetId: null,
  aliases: [],
  photoVisible: true,
  cameraConsent: false,
  cameraSourceId: null,
  archived: false,
  revision: 1,
  teamId: "t_lite",
  role: "player",
};

export const STAGED = { stagedId: "stg_0123456789abcdef0123456789abcdef", previewUrl: "/assets/staged/stg_0123456789abcdef0123456789abcdef.png", type: "png", width: 256, height: 256, bytes: 900, advice: null };
