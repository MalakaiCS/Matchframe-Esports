import { useState } from "react";
import { api } from "../../api/index.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, Note, Panel } from "../../components/ui.tsx";
import { fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

interface BenchResult {
  datasetId: string;
  map: string;
  rounds: number;
  liveMinutes: number;
  kills: number;
  killsShown: number;
  meanLeadS: number | null;
  multiFragKills: number;
  multiFragKillsShown: number;
  openingKills: number;
  openingKillsShown: number;
  cuts: number;
  cutsPerMinute: number;
}
type Totals = Omit<BenchResult, "datasetId" | "map"> & { matches: number };
type VariantKey = "current" | "no_pov_model" | "no_multi_frag";
interface BenchRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  variants: { key: VariantKey; label: string }[];
  povModel: { modelId: string; maps: string[] } | null;
  results: { dataset: string; map: string; runs: Partial<Record<VariantKey, BenchResult>> }[];
  totals: Partial<Record<VariantKey, Totals>> | null;
  error: string | null;
}
interface BenchStatus {
  running: boolean;
  progress: { done: number; total: number; dataset: string | null };
  current: BenchRun | null;
  runs: BenchRun[];
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const mapName = (m: string) => m.replace(/^de_/, "").replace(/^./, (c) => c.toUpperCase());

function Row({ label, r, base }: { label: string; r: Totals | BenchResult; base?: Totals | BenchResult | null }) {
  const diff = (a: number, b: number, bt: number, at: number) => {
    if (!base || !bt || !at) return null;
    const d = Math.round((a / at - b / bt) * 100);
    return d === 0 ? null : <span className={d > 0 ? "text-ok" : "text-warn"}>{` ${d > 0 ? "+" : ""}${d}`}</span>;
  };
  return (
    <tr>
      <td>{label}</td>
      <td>
        {pct(r.killsShown, r.kills)} <span className="muted small">of {r.kills}</span>
        {base ? diff(r.killsShown, base.killsShown, base.kills, r.kills) : null}
      </td>
      <td>{pct(r.openingKillsShown, r.openingKills)}</td>
      <td>
        {pct(r.multiFragKillsShown, r.multiFragKills)} <span className="muted small">of {r.multiFragKills}</span>
        {base ? diff(r.multiFragKillsShown, base.multiFragKillsShown, base.multiFragKills, r.multiFragKills) : null}
      </td>
      <td>{r.meanLeadS === null ? "—" : `${r.meanLeadS.toFixed(1)} s`}</td>
      <td>{r.cutsPerMinute.toFixed(1)}</td>
    </tr>
  );
}

/** The replay test bench: the director replayed on read demos, scored on the kills it shows. */
export function TestBench() {
  const reason = usePermission("training.manage");
  const st = useApi<BenchStatus>(reason ? null : "/api/v1/bench", { refreshMs: 3000 });
  const [limit, setLimit] = useState(10);
  const [compare, setCompare] = useState(true);
  return (
    <Panel title="Director test bench" subtitle="Your read demos replayed through the director: how many kills it shows, and how early.">
      <Async state={st}>
        {(s) => {
          const run = s.running ? s.current : (s.runs.at(-1) ?? null);
          return (
            <>
              <p className="small muted">
                Each demo is replayed as if live (players only, CS2&apos;s delay for player switches). A kill counts as shown when the killer&apos;s or the victim&apos;s POV is on air as it happens. Lead time is how long the shot had been on that player. Multi-frags are a player&apos;s second and later kills within 10 s.
              </p>
              <div className="row-end">
                <label className="small">
                  Matches{" "}
                  <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                    {[3, 5, 10, 20, 50].map((n) => (
                      <option key={n} value={n}>
                        {n} newest
                      </option>
                    ))}
                  </select>
                </label>
                <Checkbox checked={compare} onChange={setCompare} label="Also without the demo-trained model and without multi-frag awareness (to compare)" />
                <ActionButton variant="primary" action={() => api.post<BenchRun>("/api/v1/bench/run", { limit, compare })} success="Test bench started" onDone={() => void st.reload()} disabledReason={reason ?? (s.running ? "Running" : null)}>
                  Run the test bench
                </ActionButton>
              </div>
              {s.running ? (
                <p className="small">
                  <Badge tone="accent">Running</Badge> {s.progress.done} of {s.progress.total} matches…
                </p>
              ) : null}
              {run?.error ? <Note tone="warn">{run.error}</Note> : null}
              {run?.totals?.current ? (
                <>
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>
                            {run.totals.current.matches} matches · {Math.round(run.totals.current.liveMinutes)} min live
                          </th>
                          <th>Kills shown</th>
                          <th>Opening kills</th>
                          <th>Multi-frags</th>
                          <th>Lead</th>
                          <th>Cuts / min</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.variants.map((v) => {
                          const r = run.totals?.[v.key];
                          // Differences are shown on the "as set up" row against the director without anything learned.
                          const base = v.key === "current" ? (run.totals?.no_pov_model ?? run.totals?.no_multi_frag ?? null) : null;
                          return r ? <Row key={v.key} label={v.label} r={r} base={base} /> : null;
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Details summary="Per match">
                    <div className="table-wrap">
                      <table className="table table-compact">
                        <thead>
                          <tr>
                            <th>Map</th>
                            <th>Kills shown</th>
                            <th>Opening kills</th>
                            <th>Multi-frags</th>
                            <th>Lead</th>
                            <th>Cuts / min</th>
                          </tr>
                        </thead>
                        <tbody>
                          {run.results.map((x) =>
                            x.runs.current ? <Row key={x.dataset} label={`${mapName(x.map)}${run.povModel?.maps.includes(x.map) ? " *" : ""}`} r={x.runs.current} base={x.runs.no_pov_model ?? x.runs.no_multi_frag ?? null} /> : null,
                          )}
                        </tbody>
                      </table>
                    </div>
                  </Details>
                  {run.povModel?.maps.length && run.results.some((x) => run.povModel!.maps.includes(x.map)) ? <p className="small muted">* A map the demo-trained model learned from: if it was this very match, its score there is optimistic.</p> : null}
                  <p className="small muted">Run {run.finishedAt ? fmtTime(run.finishedAt) : "now"}. Differences (green / orange) compare the director as set up with the row below it.</p>
                </>
              ) : !s.running && !run ? (
                <EmptyState title="No runs yet">Import a few demos in the Demo Library, then run the test bench. It never runs during a live broadcast.</EmptyState>
              ) : null}
            </>
          );
        }}
      </Async>
    </Panel>
  );
}
