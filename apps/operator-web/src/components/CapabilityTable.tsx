import type { SourceCapabilities } from "@matchframe/contracts";
import { capabilityMeta, flattenCapabilities } from "../lib/capabilities.ts";
import { fmtTime, MISSING } from "../lib/format.ts";
import { SupportBadge } from "./ui.tsx";

export function CapabilityTable({ caps, group }: { caps: SourceCapabilities | null | undefined; group?: string }) {
  const rows = flattenCapabilities(caps).filter(([k]) => !group || capabilityMeta(k).group === group);
  if (rows.length === 0) return <p className="muted">No capability report yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th>Capability</th>
            <th>Support</th>
            <th>Source</th>
            <th>Tested build</th>
            <th>Verified</th>
            <th>Limitations / precision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, c]) => {
            const meta = capabilityMeta(k);
            return (
              <tr key={k}>
                <td>
                  <strong>{meta.label}</strong>
                  <div className="muted small mono">{k}</div>
                </td>
                <td>
                  <SupportBadge support={c.support} />
                </td>
                <td>{c.sourceId ?? MISSING}</td>
                <td>{c.testedGameBuild ?? MISSING}</td>
                <td>{c.lastVerifiedAt ? fmtTime(c.lastVerifiedAt) : MISSING}</td>
                <td>
                  {c.limitations.length ? (
                    <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
                      {c.limitations.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted small">none reported</span>
                  )}
                  {c.precision ? <div className="small muted">Precision: {c.precision}</div> : null}
                  {c.support !== "supported" ? <div className="small text-warn">To verify: {meta.setupHint}</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
