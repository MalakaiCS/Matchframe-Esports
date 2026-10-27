import { useState } from "react";
import type { FormEvent } from "react";
import type { OrgScope } from "../../App.tsx";
import { api, usagePath } from "../../api/index.ts";
import type { UsageResponse } from "../../api/types.ts";
import { AllowanceMeter } from "../../components/AllowanceMeter.tsx";
import { Button, Card, Empty, ErrorState, FormError, Hours, Loading, PageHeader, TextField } from "../../components/ui.tsx";
import { formatDateTime, formatHours, formatSessionLength, fromDateInput, toDateInput } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { navigate, useLocation } from "../../router.tsx";

const MAX_BAR_DAYS = 400;

/** Every UTC day in [from, to) with its seconds (the API groups usage by UTC day). */
export function fillDays(range: { from: string; to: string }, daily: { day: string; seconds: number }[]): { day: string; seconds: number }[] {
  const byDay = new Map(daily.map((d) => [d.day, d.seconds]));
  const start = new Date(range.from);
  const end = new Date(range.to).getTime();
  const out: { day: string; seconds: number }[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (d.getTime() < end && out.length < MAX_BAR_DAYS) {
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, seconds: byDay.get(key) ?? 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });

export function DailyBars({ days }: { days: { day: string; seconds: number }[] }) {
  const max = Math.max(0, ...days.map((d) => d.seconds));
  const total = days.reduce((s, d) => s + d.seconds, 0);
  const peak = days.find((d) => d.seconds === max && max > 0);
  const n = days.length;
  const w = 100 / Math.max(1, n);
  const summary = max === 0 ? `No automatic direction between ${dayLabel(days[0]?.day ?? "")} and ${dayLabel(days[n - 1]?.day ?? "")}.` : `Daily auto-director time over ${n} days, ${formatHours(total)} in total; busiest day ${dayLabel(peak!.day)} with ${formatHours(max)}.`;
  const ticks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0];
  return (
    <figure className="bars-figure">
      <div className="bars-wrap">
        <div className="bars-axis" aria-hidden="true">
          <span>{formatHours(max)}</span>
          <span>0 h 00</span>
        </div>
        <svg className="bars" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={summary}>
          <line x1="0" y1="39.8" x2="100" y2="39.8" className="bars-base" vectorEffect="non-scaling-stroke" />
          {days.map((d, i) => {
            const h = max > 0 ? (d.seconds / max) * 38 : 0;
            return (
              <rect key={d.day} x={i * w + w * 0.14} width={w * 0.72} y={40 - Math.max(h, d.seconds > 0 ? 0.6 : 0)} height={Math.max(h, d.seconds > 0 ? 0.6 : 0)} className="bar">
                <title>{`${dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" })}: ${formatHours(d.seconds)}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="bars-ticks" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${(t + 0.5) * w}%` }}>
            {dayLabel(days[t]?.day ?? "")}
          </span>
        ))}
      </div>
      {max > 0 && (
        <details className="bars-table">
          <summary>Show days as a table</summary>
          <table className="rtable rtable-compact">
            <thead>
              <tr>
                <th scope="col">Day (UTC)</th>
                <th scope="col">Auto-director time</th>
              </tr>
            </thead>
            <tbody>
              {days
                .filter((d) => d.seconds > 0)
                .map((d) => (
                  <tr key={d.day}>
                    <td data-label="Day">{dayLabel(d.day, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</td>
                    <td data-label="Time">
                      <Hours seconds={d.seconds} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}

function RangeForm({ initialFrom, initialTo, onApply, onReset, custom }: { initialFrom: string; initialTo: string; onApply: (from: string, to: string) => void; onReset: () => void; custom: boolean }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const f = fromDateInput(from);
    const t = fromDateInput(to, true);
    if (!f || !t) return setError("Choose both dates.");
    if (new Date(t) <= new Date(f)) return setError("The end date must be on or after the start date.");
    setError(null);
    onApply(from, to);
  }
  return (
    <form className="range-form" onSubmit={submit} noValidate>
      <TextField label="From" type="date" value={from} onValue={setFrom} />
      <TextField label="To (inclusive)" type="date" value={to} onValue={setTo} />
      <div className="range-actions">
        <Button type="submit">Apply</Button>
        {custom && (
          <Button variant="ghost" onClick={onReset}>
            Current period
          </Button>
        )}
      </div>
      <FormError error={error} />
    </form>
  );
}

function Totals({ u }: { u: UsageResponse }) {
  const total = u.daily.reduce((s, d) => s + d.seconds, 0);
  return (
    <div className="stat-row">
      <div className="stat">
        <span className="stat-label">Auto-director time in range</span>
        <span className="stat-value">
          <Hours seconds={total} />
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">Sessions</span>
        <span className="stat-value">
          {u.sessions.length}
          {u.sessions.length >= 200 ? "+" : ""}
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">Computers used</span>
        <span className="stat-value">{u.byDevice.length}</span>
      </div>
    </div>
  );
}

export function Usage({ scope }: { scope: OrgScope }) {
  useTitle("Usage");
  const { orgId } = scope;
  const { query, path } = useLocation();
  const fromQ = query.get("from") ?? "";
  const toQ = query.get("to") ?? "";
  const range = { from: fromDateInput(fromQ) ?? undefined, to: fromDateInput(toQ, true) ?? undefined };
  const custom = !!(range.from && range.to);
  const usage = useResource(`usage:${orgId}:${fromQ}:${toQ}`, () => api.usage(orgId, custom ? range : {}));
  const u = usage.data;
  const csv = usagePath(orgId, { ...(custom ? range : {}), format: "csv" });

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Auto-director hours used on live matches, as uploaded by your linked computers. Manual direction, the Observer's Off mode and simulations aren't counted."
        actions={
          <a className="btn btn-secondary" href={csv} download>
            Download CSV
          </a>
        }
      />
      {usage.loading && !u && <Loading label="Loading usage…" />}
      {usage.error && <ErrorState error={usage.error} onRetry={usage.reload} />}
      {u && (
        <div className="stack-lg">
          <Card title="Range">
            <RangeForm
              key={`${u.range.from}:${u.range.to}`}
              initialFrom={toDateInput(u.range.from)}
              initialTo={toDateInput(new Date(new Date(u.range.to).getTime() - 1).toISOString())}
              custom={custom}
              onApply={(f, t) => navigate(`${path}?from=${f}&to=${t}`)}
              onReset={() => navigate(path)}
            />
            <p className="small muted">
              Showing {formatDateTime(u.range.from)} – {formatDateTime(u.range.to)}
              {custom ? "" : " (the current period)"}. Daily bars use UTC days.
            </p>
            <Totals u={u} />
          </Card>

          <Card title="Daily auto-director time">
            <DailyBars days={fillDays(u.range, u.daily)} />
          </Card>

          <div className="two-col">
            <Card title="This period's allowance">
              <AllowanceMeter allowance={u.allowance} />
            </Card>
            <Card title="By computer">
              {u.byDevice.length === 0 ? (
                <Empty title="No usage in this range" />
              ) : (
                <table className="rtable">
                  <thead>
                    <tr>
                      <th scope="col">Computer</th>
                      <th scope="col">Time</th>
                      <th scope="col">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.byDevice.map((d) => {
                      const total = u.byDevice.reduce((s, x) => s + x.seconds, 0);
                      const share = total > 0 ? Math.round((d.seconds / total) * 100) : 0;
                      return (
                        <tr key={d.deviceId}>
                          <td data-label="Computer">{d.name}</td>
                          <td data-label="Time">
                            <Hours seconds={d.seconds} />
                          </td>
                          <td data-label="Share">
                            <span className="share">
                              <span className="share-bar" aria-hidden="true">
                                <span style={{ width: `${share}%` }} />
                              </span>
                              {share}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card title="Sessions">
            {u.sessions.length === 0 ? (
              <Empty title="No sessions in this range">Sessions appear after a linked computer uploads automatic-direction time.</Empty>
            ) : (
              <>
                {u.sessions.length >= 200 && <p className="small muted">Showing the latest 200 sessions in this range; the CSV has the same rows.</p>}
                <table className="rtable">
                  <thead>
                    <tr>
                      <th scope="col">Started</th>
                      <th scope="col">Ended</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Computer</th>
                      <th scope="col">Map</th>
                      <th scope="col">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.sessions.map((s) => (
                      <tr key={`${s.deviceId}:${s.recordId}`}>
                        <td data-label="Started">{formatDateTime(s.startedAt)}</td>
                        <td data-label="Ended">{formatDateTime(s.endedAt)}</td>
                        <td data-label="Duration">
                          <time dateTime={`PT${s.seconds}S`} title={`${s.seconds.toLocaleString()} s`}>
                            {formatSessionLength(s.seconds)}
                          </time>
                        </td>
                        <td data-label="Computer">{s.deviceName}</td>
                        <td data-label="Map">{s.mapName ?? "—"}</td>
                        <td data-label="Match">{s.matchRef ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
