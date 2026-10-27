import type { ReactNode } from "react";
import type { AutoDirectorAllowance } from "@matchframe/cloud-contracts";
import { allowanceView } from "../lib/allowance.ts";
import { formatDate, formatDateTime, formatExactSeconds, formatHours } from "../lib/format.ts";
import { Alert, Hours } from "./ui.tsx";

/**
 * Auto-director hours for the current period: remaining (big), a progress bar of used/budget,
 * the breakdown with exact values, and what happens at the limit.
 */
export function AllowanceMeter({ allowance, planName, footer }: { allowance: AutoDirectorAllowance; planName?: string; footer?: ReactNode }) {
  const v = allowanceView(allowance);
  const pct = Math.round(v.fraction * 1000) / 10;
  const valueText = v.state === "over" ? `${formatHours(v.usedSeconds)} used; ${formatHours(v.overSeconds)} over the limit` : `${formatHours(v.usedSeconds)} used of ${formatHours(v.budgetSeconds)}; ${formatHours(v.remainingSeconds)} remaining`;
  return (
    <div className={`meter meter-${v.state}`}>
      <div className="meter-figures">
        <div className="meter-main">
          {v.state === "over" ? (
            <>
              <span className="meter-big meter-big-over">
                <Hours seconds={-v.overSeconds} />
              </span>
              <span className="meter-cap">over the limit</span>
            </>
          ) : (
            <>
              <span className="meter-big">
                <Hours seconds={v.remainingSeconds} />
              </span>
              <span className="meter-cap">remaining this period</span>
            </>
          )}
        </div>
        <div className="meter-side">
          <Hours seconds={v.usedSeconds} /> used of <Hours seconds={v.budgetSeconds} />
        </div>
      </div>
      <div className="meter-bar" role="progressbar" aria-label="Auto-director hours used this period" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={valueText}>
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <dl className="meter-dl">
        <div>
          <dt>Included{planName ? ` with ${planName}` : ""}</dt>
          <dd>
            <Hours seconds={allowance.includedSeconds} /> <span className="exact">{formatExactSeconds(allowance.includedSeconds)}</span>
          </dd>
        </div>
        <div>
          <dt>Hour credits available</dt>
          <dd>
            <Hours seconds={allowance.creditSeconds} /> <span className="exact">{formatExactSeconds(allowance.creditSeconds)}</span>
          </dd>
        </div>
        <div>
          <dt>Used this period</dt>
          <dd>
            <Hours seconds={allowance.usedSeconds} /> <span className="exact">{formatExactSeconds(allowance.usedSeconds)}</span>
          </dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>
            <Hours seconds={allowance.remainingSeconds} /> <span className="exact">{formatExactSeconds(allowance.remainingSeconds)}</span>
          </dd>
        </div>
        <div>
          <dt>Period</dt>
          <dd>
            {formatDate(allowance.periodStart)} – {formatDate(allowance.periodEnd)}{" "}
            <span className="exact" title={formatDateTime(allowance.periodEnd)}>
              resets {formatDateTime(allowance.periodEnd)}
            </span>
          </dd>
        </div>
      </dl>
      {v.state === "over" && (
        <Alert tone="danger" title={`Over the limit by ${formatHours(v.overSeconds)}`}>
          The auto director never stops in the middle of a map, so a map in progress was finished. It can't be re-armed until hours are added or the period resets on {formatDate(allowance.periodEnd)}. There's no charge for the overrun.
        </Alert>
      )}
      {v.state === "exhausted" && (
        <Alert tone="warn" title="No auto-director hours left">
          The auto director can't be re-armed until hours are added or the period resets on {formatDate(allowance.periodEnd)}. Manual and advisory direction keep working.
        </Alert>
      )}
      {v.state === "low" && (
        <Alert tone="warn" title="Running low">
          {formatHours(v.remainingSeconds)} left. When it runs out, automation can't be re-armed (a running map is never cut off). Add an hour pack to keep going.
        </Alert>
      )}
      {v.state === "none" && (
        <Alert tone="info" title="No auto-director hours in this plan">
          Choose a plan with auto-director hours to use the auto director on live matches.
        </Alert>
      )}
      {footer}
    </div>
  );
}
