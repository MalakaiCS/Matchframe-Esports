import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, describeError } from "../../api/index.ts";
import type { HealthResponse } from "../../api/types.ts";
import { PageHero } from "../../components/marketing.tsx";
import { Button } from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

type State = "checking" | "ok" | "degraded" | "down";

interface Check {
  state: State;
  health: HealthResponse | null;
  error: string | null;
  at: string | null;
  ms: number | null;
}

const LABEL: Record<State, string> = { checking: "Checking…", ok: "Operational", degraded: "Degraded", down: "Unavailable" };

function Row({ name, desc, state, detail }: { name: string; desc: string; state: State; detail?: string | null }) {
  return (
    <li className="status-row">
      <div>
        <p className="status-name">{name}</p>
        <p className="small muted">{desc}</p>
        {detail && <p className="small">{detail}</p>}
      </div>
      <span className={`status-pill status-${state}`}>
        <span className="status-dot" aria-hidden="true" />
        {LABEL[state]}
      </span>
    </li>
  );
}

export function Status() {
  useTitle("Status", "Live status of the Matchframe website, API and database.");
  const [c, setC] = useState<Check>({ state: "checking", health: null, error: null, at: null, ms: null });
  const live = useRef(true);
  const run = useCallback(async () => {
    setC((s) => ({ ...s, state: "checking" }));
    const t0 = performance.now();
    try {
      const h = await api.health();
      if (live.current) setC({ state: h.ok ? "ok" : "degraded", health: h, error: null, at: new Date().toISOString(), ms: Math.round(performance.now() - t0) });
    } catch (e) {
      // The API answered but a dependency failed (5xx), or it couldn't be reached at all.
      const answered = e instanceof ApiError;
      if (live.current) setC({ state: answered ? "degraded" : "down", health: null, error: describeError(e), at: new Date().toISOString(), ms: answered ? Math.round(performance.now() - t0) : null });
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void run();
    const t = setInterval(() => void run(), 60_000);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [run]);

  const apiState: State = c.state === "checking" ? "checking" : c.state === "down" ? "down" : "ok";
  const dbState: State = c.state === "checking" ? "checking" : c.health?.ok ? "ok" : c.state === "down" ? "down" : "degraded";
  const overall = c.state === "checking" ? "Checking the service…" : c.state === "ok" ? "All systems operational" : c.state === "degraded" ? "Some systems are having problems" : "The service can't be reached";

  return (
    <>
      <PageHero eyebrow="Status" title="Service status" lead="A live check of the website and its API from your browser. The Matchframe program keeps working for your broadcast even when the website is unavailable." />
      <div className="wrap section-top narrow-block">
        <section className={`status-banner status-banner-${c.state}`} aria-live="polite" aria-labelledby="status-overall">
          <span className="status-dot status-dot-lg" aria-hidden="true" />
          <div>
            <h2 id="status-overall" className="status-overall">
              {overall}
            </h2>
            <p className="small">
              {c.at ? `Last checked ${formatDateTime(c.at)}${c.ms !== null ? ` · responded in ${c.ms} ms` : ""}` : "Running the first check…"}
              {c.health?.version ? ` · API version ${c.health.version}` : ""}
            </p>
          </div>
          <Button size="sm" onClick={() => void run()} busy={c.state === "checking"}>
            Check again
          </Button>
        </section>
        <ul className="status-list">
          <Row name="Website and API" desc="Sign-in, accounts, billing pages and the program's licence and usage uploads." state={apiState} detail={c.state === "down" ? c.error : null} />
          <Row name="Database" desc="Stores accounts, organisations, usage and billing state." state={dbState} detail={c.state === "degraded" ? c.error : null} />
          <Row name="Online payments" desc="Checkout and the customer portal, provided by Stripe." state={c.state === "checking" ? "checking" : c.health ? (c.health.billingConfigured ? "ok" : "degraded") : dbState} detail={c.health && !c.health.billingConfigured ? "Online payments aren't set up on this server." : null} />
        </ul>
        <p className="small muted">
          The status refreshes every minute while this page is open. If something looks wrong, <Link to="/contact?topic=support">let us know</Link>.
        </p>
      </div>
    </>
  );
}
