import { useState } from "react";
import { api } from "../../api/index.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, Note, Panel } from "../../components/ui.tsx";
import { fmtNum, fmtSec, fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

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
        {pct(r.killsShown, r.kills)} <span className="muted small">{t("training.ofKills", { kills: r.kills })}</span>
        {base ? diff(r.killsShown, base.killsShown, base.kills, r.kills) : null}
      </td>
      <td>{pct(r.openingKillsShown, r.openingKills)}</td>
      <td>
        {pct(r.multiFragKillsShown, r.multiFragKills)} <span className="muted small">{t("training.ofMultifragkills", { multiFragKills: r.multiFragKills })}</span>
        {base ? diff(r.multiFragKillsShown, base.multiFragKillsShown, base.multiFragKills, r.multiFragKills) : null}
      </td>
      <td>{r.meanLeadS === null ? "—" : fmtSec(r.meanLeadS, 1)}</td>
      <td>{fmtNum(r.cutsPerMinute, 1)}</td>
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
    <Panel title={t("training.directorTestBench")} subtitle={t("training.yourReadDemosReplayedThrough")}>
      <Async state={st}>
        {(s) => {
          const run = s.running ? s.current : (s.runs.at(-1) ?? null);
          return (
            <>
              <p className="small muted">{t("training.eachDemoIsReplayedAs")}</p>
              <div className="row-end">
                <label className="small"><T k="training.matchesSelect" values={{ select: <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                    {[3, 5, 10, 20, 50].map((n) => (
                      <option key={n} value={n}>{t("training.nNewest", { n })}</option>
                    ))}
                  </select> }} /></label>
                <Checkbox checked={compare} onChange={setCompare} label={t("training.alsoWithoutTheDemoTrained")} />
                <ActionButton variant="primary" action={() => api.post<BenchRun>("/api/v1/bench/run", { limit, compare })} success={t("training.testBenchStarted")} onDone={() => void st.reload()} disabledReason={reason ?? (s.running ? t("training.running") : null)}>{t("training.runTheTestBench")}</ActionButton>
              </div>
              {s.running ? (
                <p className="small"><T k="training.badgeDoneOfTotalMatches" values={{ badge: <Badge tone="accent">{t("training.running")}</Badge>, done: s.progress.done, total: s.progress.total }} /></p>
              ) : null}
              {run?.error ? <Note tone="warn">{run.error}</Note> : null}
              {run?.totals?.current ? (
                <>
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>{t("training.matchesMatchesLiveminutesMinLive", { matches: run.totals.current.matches, liveMinutes: Math.round(run.totals.current.liveMinutes) })}</th>
                          <th>{t("training.killsShown")}</th>
                          <th>{t("training.openingKills")}</th>
                          <th>Multi-frags</th>
                          <th>{t("training.lead")}</th>
                          <th>{t("training.cutsMin")}</th>
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
                  <Details summary={t("training.perMatch")}>
                    <div className="table-wrap">
                      <table className="table table-compact">
                        <thead>
                          <tr>
                            <th>{t("training.map")}</th>
                            <th>{t("training.killsShown")}</th>
                            <th>{t("training.openingKills")}</th>
                            <th>Multi-frags</th>
                            <th>{t("training.lead")}</th>
                            <th>{t("training.cutsMin")}</th>
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
                  {run.povModel?.maps.length && run.results.some((x) => run.povModel!.maps.includes(x.map)) ? <p className="small muted">{t("training.aMapTheDemoTrained")}</p> : null}
                  <p className="small muted">{t("training.runVDifferencesGreenOrange", { v: run.finishedAt ? fmtTime(run.finishedAt) : t("training.now") })}</p>
                </>
              ) : !s.running && !run ? (
                <EmptyState title={t("training.noRunsYet")}>{t("training.importAFewDemosIn")}</EmptyState>
              ) : null}
            </>
          );
        }}
      </Async>
    </Panel>
  );
}
