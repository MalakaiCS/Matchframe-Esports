import { useEffect, useState } from "react";
import { api, crashReportDownload } from "../../api/index.ts";
import type { AdminCrashReport, CrashProcess } from "../../api/types.ts";
import { DetailList, Pagination, Segmented } from "../../components/data.tsx";
import { Badge, Button, Card, Empty, ErrorState, Loading, PageHeader, TextField } from "../../components/ui.tsx";
import { formatBytes, formatDate, formatDateTime, formatRelative } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { Link, navigate, useLocation } from "../../router.tsx";

/** Which part of the program crashed (ADR-077). */
export const PROCESS_LABEL: Record<CrashProcess, string> = { main: "Main process", renderer: "Manager window", hud: "HUD window", engine: "Engine", native: "Native crash" };

type ProcessFilter = CrashProcess | "all";
const FILTERS: { value: ProcessFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "engine", label: "Engine" },
  { value: "renderer", label: "Manager window" },
  { value: "hud", label: "HUD window" },
  { value: "main", label: "Main process" },
  { value: "native", label: "Native" },
];
const isFilter = (v: string | null): v is ProcessFilter => FILTERS.some((f) => f.value === v);
const PAGE_SIZE = 25;

function OrgCell({ r }: { r: AdminCrashReport }) {
  if (!r.orgId) return <span className="muted">Not signed in</span>;
  return (
    <>
      <Link to={`/admin/orgs/${encodeURIComponent(r.orgId)}`}>{r.orgName ?? r.orgId}</Link>
      {r.deviceName && <span className="small muted block">{r.deviceName}</span>}
    </>
  );
}

export function AdminCrashReports() {
  useTitle("Crash reports · Admin");
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const rawProcess = query.get("process");
  const process: ProcessFilter = isFilter(rawProcess) ? rawProcess : "all";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const go = (next: { q?: string; process?: ProcessFilter; page?: number }) => {
    const p = new URLSearchParams();
    const nq = next.q ?? q;
    const np = next.process ?? process;
    const pg = next.page ?? 1;
    if (nq) p.set("q", nq);
    if (np !== "all") p.set("process", np);
    if (pg > 1) p.set("page", String(pg));
    const s = p.toString();
    navigate(`/admin/crash-reports${s ? `?${s}` : ""}`, { replace: true });
  };

  const list = useResource(`admin-crash-reports:${q}:${process}:${page}`, () => api.adminCrashReports({ q, process, page, pageSize: PAGE_SIZE }));
  const data = list.data;
  return (
    <>
      <PageHeader
        eyebrow="Staff console"
        title="Crash reports"
        subtitle="Reports programs sent after a crash (crash reports are opt-in). Each holds the program's support file and what crashed; they're deleted 90 days after they arrive."
        actions={
          <Button size="sm" onClick={() => void list.reload()} busy={list.loading}>
            Refresh
          </Button>
        }
      />
      <div className="toolbar">
        <form
          className="search-form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: text.trim(), page: 1 });
          }}
        >
          <TextField label="Search crash reports" type="search" value={text} onValue={setText} placeholder="Report ID, version, organisation, computer or error" />
          <Button type="submit">Search</Button>
        </form>
        <Segmented label="Part of the program" value={process} options={FILTERS} onChange={(f) => go({ process: f, page: 1 })} />
      </div>
      {list.loading && !data && <Loading label="Loading crash reports…" />}
      {list.error && <ErrorState error={list.error} onRetry={list.reload} />}
      {data && data.reports.length === 0 && <Empty title={q || process !== "all" ? "No crash reports match" : "No crash reports"}>{q || process !== "all" ? "Try a different search or filter." : "Reports appear here when a program with crash reports turned on sends one."}</Empty>}
      {data && data.reports.length > 0 && (
        <div className={`table-card${list.loading ? " is-loading" : ""}`}>
          <table className="rtable data-table">
            <thead>
              <tr>
                <th scope="col">Report</th>
                <th scope="col">Version</th>
                <th scope="col">Process</th>
                <th scope="col">Organisation</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((r) => (
                <tr key={r.id}>
                  <td data-label="Report">
                    <Link to={`/admin/crash-reports/${encodeURIComponent(r.id)}`} className="strong mono">
                      {r.id}
                    </Link>
                    <span className="small muted block" title={formatDateTime(r.receivedAt)}>
                      {formatRelative(r.receivedAt)}
                    </span>
                  </td>
                  <td data-label="Version">
                    {r.appVersion}
                    <span className="small muted block">{r.os}</span>
                  </td>
                  <td data-label="Process">
                    {PROCESS_LABEL[r.process] ?? r.process}
                    <span className="small muted block">{r.reason}</span>
                  </td>
                  <td data-label="Organisation">
                    <OrgCell r={r} />
                  </td>
                  <td data-label="Error" className="small">
                    {r.error ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => go({ page: p })} label="crash reports" />
        </div>
      )}
      {data && data.storedBytes > 0 && <p className="small muted">{formatBytes(data.storedBytes)} of crash reports stored.</p>}
    </>
  );
}

export function AdminCrashReportDetail({ reportId }: { reportId: string }) {
  useTitle(`${reportId} · Crash reports · Admin`);
  const detail = useResource(`admin-crash-report:${reportId}`, () => api.adminCrashReport(reportId));
  const back = (
    <p className="crumb-back">
      <Link to="/admin/crash-reports">← Crash reports</Link>
    </p>
  );
  if (detail.loading && !detail.data) return <Loading label="Loading the crash report…" />;
  if (detail.error)
    return (
      <>
        {back}
        <ErrorState error={detail.error} onRetry={detail.reload} title="Couldn't load this crash report" />
      </>
    );
  const d = detail.data;
  if (!d) return null;
  const r = d.report;
  const c = d.crash;
  const engineOutput = Array.isArray(c.detail.engineOutput) ? (c.detail.engineOutput as unknown[]).map(String) : [];
  const { engineOutput: _output, ...otherDetail } = c.detail;
  return (
    <>
      {back}
      <header className="detail-head">
        <div className="detail-head-text">
          <h1 tabIndex={-1} data-page-heading className="mono">
            {r.id}
          </h1>
          <p className="muted">
            {PROCESS_LABEL[r.process] ?? r.process} · MatchFrame {r.appVersion} · received {formatDateTime(r.receivedAt)}
          </p>
          <span className="badge-row">
            <Badge tone="danger">{r.reason}</Badge>
            {r.hasSupportFile ? <Badge tone="info">Support file</Badge> : <Badge>No support file</Badge>}
            {r.hasMinidump && <Badge tone="info">Minidump</Badge>}
          </span>
        </div>
        <div className="detail-head-actions">
          <a className="btn btn-primary btn-sm" href={crashReportDownload(r.id, "report")} download>
            Download report
          </a>
          {d.minidump && (
            <a className="btn btn-secondary btn-sm" href={crashReportDownload(r.id, "minidump")} download>
              Download minidump
            </a>
          )}
        </div>
      </header>

      <div className="detail-grid">
        <div className="stack-lg">
          <Card title="Error">
            <p className="strong">{c.error ?? "No error message (a native crash: see the minidump)."}</p>
            {c.stack && <pre className="json">{c.stack}</pre>}
          </Card>
          {engineOutput.length > 0 && (
            <Card title="The engine's last output">
              <pre className="json">{engineOutput.join("\n")}</pre>
            </Card>
          )}
          {Object.keys(otherDetail).length > 0 && (
            <Card title="Details">
              <pre className="json">{JSON.stringify(otherDetail, null, 2)}</pre>
            </Card>
          )}
        </div>
        <div className="stack-lg">
          <Card title="Crash">
            <DetailList
              items={[
                ["Process", PROCESS_LABEL[r.process] ?? r.process],
                ["Happened", formatDateTime(c.occurredAt)],
                ["Version", r.appVersion],
                ["System", `${c.os.platform} ${c.os.release} (${c.os.arch})`],
                ["Running for", c.uptimeSeconds === null ? "Unknown" : `${Math.round(c.uptimeSeconds)} s`],
                ["Program running for", c.programUptimeSeconds === null ? "Unknown" : `${Math.round(c.programUptimeSeconds)} s`],
              ]}
            />
          </Card>
          <Card title="From">
            <DetailList
              items={[
                ["Organisation", <OrgCell r={r} />],
                ["Size", `${formatBytes(r.sizeBytes)} (${formatBytes(r.storedBytes)} stored)`],
                ["Deleted on", formatDate(r.expiresAt)],
              ]}
            />
          </Card>
          <Card title="Support file">
            {d.supportFile.included ? (
              <>
                <p className="small muted">Made {d.supportFile.generatedAt ? formatDateTime(d.supportFile.generatedAt) : "at an unknown time"}. In the downloaded report:</p>
                <p className="small mono">{d.supportFile.sections.join(", ")}</p>
              </>
            ) : (
              <Empty title="No support file">The program had none to send (its engine wasn't running, or it was connected to another computer).</Empty>
            )}
            {d.minidump && (
              <p className="small">
                Minidump <span className="mono">{d.minidump.name}</span>, {formatBytes(d.minidump.size)}.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
