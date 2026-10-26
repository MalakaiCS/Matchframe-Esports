import { api } from "../api/index.ts";
import type { DownloadsResponse } from "../api/types.ts";
import { Alert, Card, CopyButton, ErrorState, Loading, PageHeader } from "../components/ui.tsx";
import { useResource, useTitle } from "../lib/hooks.ts";
import { Link } from "../router.tsx";

const fileName = (url: string) => decodeURIComponent(url.split("?")[0]!.split("/").pop() || "MatchframeEsports-Setup.exe");

/** Compact card for the dashboard and account page; the full details live on /download. */
export function DownloadCard() {
  const dl = useResource("downloads", api.downloads);
  const win = dl.data?.windows ?? null;
  return (
    <Card title="Download the program" actions={<Link to="/download">Details and checksum</Link>}>
      {dl.loading && !dl.data && <Loading />}
      {dl.error && <ErrorState error={dl.error} onRetry={dl.reload} />}
      {dl.data &&
        (win ? (
          <>
            <p className="muted small">Matchframe for Windows, version {win.version}.</p>
            <a className="btn btn-secondary" href={win.url} rel="noopener">
              Download for Windows
            </a>
          </>
        ) : (
          <p className="muted">The Windows installer isn't published yet{dl.data.version ? ` (upcoming version ${dl.data.version})` : ""}.</p>
        ))}
    </Card>
  );
}

function Published({ win, notesUrl }: { win: NonNullable<DownloadsResponse["windows"]>; notesUrl: string | null }) {
  const name = fileName(win.url);
  return (
    <>
      <p>
        <a className="btn btn-primary btn-lg" href={win.url} rel="noopener">
          Download for Windows
        </a>
      </p>
      <p className="muted small">
        <span className="mono">{name}</span>
        {notesUrl && (
          <>
            {" · "}
            <a href={notesUrl} rel="noopener noreferrer">
              Release notes
            </a>
          </>
        )}
      </p>
      <h3 className="h3">SHA-256 checksum</h3>
      {win.sha256 ? (
        <>
          <div className="hash">
            <code className="hash-value">{win.sha256}</code>
            <CopyButton text={win.sha256} label="Copy checksum" />
          </div>
          <p className="small">
            To check the file in PowerShell: <code>Get-FileHash .\{name} -Algorithm SHA256</code>. The result must match the value above exactly.
          </p>
        </>
      ) : (
        <Alert tone="warn">No checksum has been published for this build.</Alert>
      )}
    </>
  );
}

export function Download() {
  useTitle("Download");
  const dl = useResource("downloads", api.downloads);
  const win = dl.data?.windows ?? null;
  return (
    <>
      <PageHeader title="Download the program" subtitle="The Matchframe program for Windows. Install it on each computer that should use your organisation's plan." />
      {dl.loading && !dl.data && <Loading label="Looking up the latest build…" />}
      {dl.error && <ErrorState error={dl.error} onRetry={dl.reload} />}
      {dl.data && (
        <div className="download-grid">
          <Card title={win ? `Version ${win.version}` : "Windows installer"}>
            {win ? (
              <Published win={win} notesUrl={dl.data.notesUrl} />
            ) : (
              <Alert tone="info" title="Not published yet">
                There's no installer available yet{dl.data.version ? ` (upcoming version ${dl.data.version})` : ""}. Check back here later.
              </Alert>
            )}
          </Card>
          <Card title="Install and link">
            <Alert tone="warn" title="Unsigned build: expect a SmartScreen warning" live={false}>
              The installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC". After checking the SHA-256, choose <strong>More info</strong> then <strong>Run anyway</strong>.
            </Alert>
            <ol className="plain-steps">
              <li>Install and start Matchframe.</li>
              <li>
                In the program open <strong>Account → Link this computer</strong>. It shows a code like <code>BCDF-GHJK</code>.
              </li>
              <li>
                Enter the code at <Link to="/link">/link</Link>, choose the organisation and approve.
              </li>
            </ol>
          </Card>
        </div>
      )}
    </>
  );
}
