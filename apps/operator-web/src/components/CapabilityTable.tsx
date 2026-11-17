import type { SourceCapabilities } from "@matchframe/contracts";
import { capabilityMeta, flattenCapabilities } from "../lib/capabilities.ts";
import { fmtTime, MISSING } from "../lib/format.ts";
import { SupportBadge } from "./ui.tsx";
import { t } from "../i18n/index.ts";

export function CapabilityTable({ caps, group }: { caps: SourceCapabilities | null | undefined; group?: string }) {
  const rows = flattenCapabilities(caps).filter(([k]) => !group || capabilityMeta(k).group === group);
  if (rows.length === 0) return <p className="muted">{t("director.noCapabilityReportYet")}</p>;
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th>{t("director.capability")}</th>
            <th>{t("director.support")}</th>
            <th>{t("director.notes")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, c]) => {
            const meta = capabilityMeta(k);
            const provenance = [c.sourceId, c.testedGameBuild ? `build ${c.testedGameBuild}` : null, c.lastVerifiedAt ? `verified ${fmtTime(c.lastVerifiedAt)}` : null].filter(Boolean).join(" · ");
            return (
              <tr key={k}>
                <td title={k}>
                  {meta.label}
                  {provenance ? <div className="muted small">{provenance}</div> : null}
                </td>
                <td>
                  <SupportBadge support={c.support} />
                </td>
                <td className="small">
                  {c.limitations.length ? c.limitations.join(" ") : c.support === "supported" ? <span className="muted">{MISSING}</span> : null}
                  {c.precision ? <div className="muted">{t("director.precisionPrecision", { precision: c.precision })}</div> : null}
                  {c.support !== "supported" ? <div className="muted">{t("director.toVerifySetuphint", { setupHint: meta.setupHint })}</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
