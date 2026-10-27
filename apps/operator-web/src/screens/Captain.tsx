import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient, describeError } from "../api/client.ts";
import { resolveCaptainToken } from "../api/auth.ts";
import type { CaptainView, Me } from "../api/types.ts";
import { Logo } from "../components/icons.tsx";
import { useToast } from "../components/toasts.tsx";
import { Badge, Button, EmptyState, Loading, Note, Panel } from "../components/ui.tsx";
import { VETO_KIND_LABEL } from "./matches/Veto.tsx";

/**
 * Minimal captain veto page. Uses only the scoped captain token (never the operator token) and only
 * the captain endpoints: no telemetry, no production data.
 */
export function CaptainPage() {
  const token = useMemo(() => resolveCaptainToken(), []);
  const client = useMemo(() => createApiClient(() => token), [token]);
  const toast = useToast();
  const [matchId, setMatchId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("match"));
  const [view, setView] = useState<CaptainView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Map veto · Matchframe";
    if (!token || matchId) return;
    client
      .get<Me>("/api/v1/me")
      .then((me) => {
        if (me.role !== "captain") setError("This link is not a valid captain link (it may have expired or been revoked).");
        else if (me.scope?.matchId) setMatchId(me.scope.matchId);
      })
      .catch((e) => setError(describeError(e)));
  }, [client, token, matchId]);

  useEffect(() => {
    if (!token || !matchId) return;
    let stop = false;
    const load = () =>
      client
        .get<CaptainView>(`/api/v1/veto/${encodeURIComponent(matchId)}/captain-view`)
        .then((v) => {
          if (!stop) {
            setView(v);
            setError(null);
          }
        })
        .catch((e) => {
          if (stop) return;
          setError(e instanceof ApiError && e.status === 401 ? "This captain link is invalid or has expired. Ask the production team for a new link." : describeError(e));
        });
    void load();
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [client, token, matchId]);

  const act = async (body: { mapName?: string; side?: "CT" | "T" }) => {
    if (!view?.currentStep || !matchId) return;
    setBusy(true);
    try {
      await client.post(`/api/v1/veto/${encodeURIComponent(matchId)}/captain`, { stepOrder: view.currentStep.order, ...body });
      toast.push("ok", "Decision submitted");
      setView(await client.get<CaptainView>(`/api/v1/veto/${encodeURIComponent(matchId)}/captain-view`));
    } catch (e) {
      toast.push("danger", "Not accepted", describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="gate-brand" style={{ marginBottom: 14 }}>
      <Logo /> <span>Map veto</span>
    </div>
  );

  if (!token)
    return (
      <div className="captain-shell">
        {header}
        <Note tone="warn" title="Link incomplete">
          Open the full captain link you received from the production team (it contains a token).
        </Note>
      </div>
    );

  const cur = view?.currentStep ?? null;
  const yourTurn = !!view && !!cur && (cur.actor === view.match.yourSlot || cur.kind === "decider");
  const teamOf = (actor: "A" | "B" | null) => (!view ? "" : actor === "A" ? view.match.teamA : actor === "B" ? view.match.teamB : "automatic");

  return (
    <div className="captain-shell">
      {header}
      {error ? (
        <Note tone="danger" title="Something went wrong">
          {error}
        </Note>
      ) : null}
      {!view && !error ? <Loading label="Loading veto…" /> : null}
      {view ? (
        <div className="stack">
          <Panel title={`${view.match.teamA} vs ${view.match.teamB}`} subtitle={`You are captain of ${view.match.yourTeam}`} actions={view.complete ? <Badge tone="ok">VETO COMPLETE</Badge> : yourTurn ? <Badge tone="accent">YOUR TURN</Badge> : <Badge>WAITING</Badge>}>
            {view.complete ? (
              <EmptyState title="Veto complete">Thank you — the production team has the result.</EmptyState>
            ) : cur ? (
              <>
                <h3>
                  Step {cur.order}: {VETO_KIND_LABEL[cur.kind]} — {teamOf(cur.actor)}
                </h3>
                {!yourTurn ? (
                  <p className="muted">Waiting for {teamOf(cur.actor)}… this page updates automatically.</p>
                ) : cur.kind === "ban" || cur.kind === "pick" ? (
                  <div className="map-buttons" style={{ marginTop: 10 }}>
                    {view.remainingMaps.map((m) => (
                      <Button key={m} size="lg" variant={cur.kind === "ban" ? "danger" : "primary"} disabled={busy} onClick={() => void act({ mapName: m })}>
                        {cur.kind === "ban" ? "Ban" : "Pick"} {m}
                      </Button>
                    ))}
                  </div>
                ) : cur.kind === "side_choice" ? (
                  <div className="row" style={{ marginTop: 10 }}>
                    <span>Starting side on {[...view.decisions].reverse().find((d) => d.mapName && (d.kind === "pick" || d.kind === "decider"))?.mapName ?? "the picked map"}:</span>
                    <Button size="lg" variant="primary" disabled={busy} onClick={() => void act({ side: "CT" })}>
                      Start CT
                    </Button>
                    <Button size="lg" variant="primary" disabled={busy} onClick={() => void act({ side: "T" })}>
                      Start T
                    </Button>
                  </div>
                ) : (
                  <Button size="lg" variant="primary" disabled={busy || view.remainingMaps.length !== 1} onClick={() => void act({})}>
                    Confirm decider: {view.remainingMaps.join(", ")}
                  </Button>
                )}
              </>
            ) : null}
          </Panel>
          <Panel title="Sequence">
            <ol className="veto-steps">
              {view.steps.map((s) => {
                const d = view.decisions.find((x) => x.stepOrder === s.order);
                return (
                  <li key={s.order} className={`veto-step ${cur?.order === s.order ? "is-current" : ""}`}>
                    <div className="row">
                      <span className="muted mono">{s.order}</span>
                      <span className={`veto-kind k-${s.kind}`}>{VETO_KIND_LABEL[s.kind]}</span>
                    </div>
                    <div className="small">{teamOf(s.actor)}</div>
                    <div>{d ? <strong>{d.mapName ?? d.side}</strong> : <span className="muted small">pending</span>}</div>
                  </li>
                );
              })}
            </ol>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
