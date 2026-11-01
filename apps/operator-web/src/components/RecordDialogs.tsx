import { useEffect, useRef, useState } from "react";
import { api, describeError, seg } from "../api/index.ts";
import type { DeleteImpact, ImportPreview } from "../api/types.ts";
import { useToast } from "./toasts.tsx";
import { Badge, Button, Loading, Modal, Note } from "./ui.tsx";

type Kind = "teams" | "players" | "matches";
const NOUN: Record<Kind, [string, string]> = { teams: ["team", "teams"], players: ["player", "players"], matches: ["match", "matches"] };
const plural = (k: Kind, n: number) => `${n} ${NOUN[k][n === 1 ? 0 : 1]}`;

/**
 * Delete confirmation for one or more records: names each record and what deleting it changes.
 * Records something still depends on are not deleted; the dialog explains why and offers Archive
 * (hidden from lists, history kept) instead. Nothing is ever deleted along with them silently.
 */
export function DeleteDialog({ kind, ids, onClose, onDone }: { kind: Kind; ids: string[]; onClose: () => void; onDone: () => void }) {
  const [impacts, setImpacts] = useState<DeleteImpact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    api
      .post<{ records: DeleteImpact[] }>(`/api/v1/${kind}/delete-preview`, { ids })
      .then((r) => setImpacts(r.records))
      .catch((e) => setError(describeError(e)));
  }, [kind, ids]);
  const deletable = impacts?.filter((i) => i.deletable) ?? [];
  const blocked = impacts?.filter((i) => !i.deletable) ?? [];
  const run = async (what: "delete" | "archive") => {
    setBusy(true);
    setError(null);
    try {
      if (what === "delete") {
        await api.post(`/api/v1/${kind}/delete`, { ids: deletable.map((d) => d.id) });
        toast.push("ok", `Deleted ${deletable.length === 1 ? deletable[0]!.label : plural(kind, deletable.length)}`);
      } else {
        for (const b of blocked) await api.post(`/api/v1/${kind}/${seg(b.id)}/archive`, { archived: true });
        toast.push("ok", `Archived ${blocked.length === 1 ? blocked[0]!.label : plural(kind, blocked.length)}`, "Archived records are hidden from lists; their history is kept.");
      }
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const title = ids.length === 1 ? `Delete ${impacts?.[0]?.label ?? NOUN[kind][0]}?` : `Delete ${plural(kind, ids.length)}?`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={ids.length > 1}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {blocked.length ? (
            <Button variant="warn" disabled={busy} onClick={() => void run("archive")}>
              Archive {blocked.length === 1 ? blocked[0]!.label : `the ${blocked.length} blocked`} instead
            </Button>
          ) : null}
          {deletable.length ? (
            <Button variant="danger" disabled={busy} onClick={() => void run("delete")}>
              {blocked.length ? `Delete the ${plural(kind, deletable.length)} that can be deleted` : ids.length === 1 ? "Delete" : `Delete ${plural(kind, deletable.length)}`}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? (
        <Note tone="danger" title="Not deleted">
          {error}
        </Note>
      ) : null}
      {!impacts && !error ? <Loading label="Checking what uses these records…" /> : null}
      {impacts ? (
        <ul className="impact-list">
          {impacts.map((i) => (
            <li key={i.id} className={`impact ${i.deletable ? "" : "is-blocked"}`}>
              <div className="impact-head">
                <strong>{i.label}</strong> {i.deletable ? <Badge tone="danger">Will be deleted</Badge> : <Badge tone="warn">Cannot be deleted</Badge>}
              </div>
              {i.blockers.length ? (
                <ul className="impact-lines">
                  {i.blockers.map((b) => (
                    <li key={b} className="text-warn">
                      {b}
                    </li>
                  ))}
                </ul>
              ) : null}
              {i.deletable && i.effects.length ? (
                <ul className="impact-lines">
                  {i.effects.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : i.deletable ? (
                <ul className="impact-lines">
                  <li>Nothing else refers to it.</li>
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {blocked.length ? <p className="small muted">Archive hides a record from lists and pickers but keeps it for history (matches, rosters and results that refer to it). Deleting cannot be undone.</p> : impacts ? <p className="small muted">Deleting cannot be undone.</p> : null}
    </Modal>
  );
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const COLUMNS: Record<"teams" | "players", [string, string][]> = {
  teams: [
    ["name", "Team name"],
    ["shortName", "Short name"],
    ["country", "Country"],
  ],
  players: [
    ["displayName", "Nickname"],
    ["firstName", "First name"],
    ["lastName", "Last name"],
    ["country", "Country"],
    ["steamId", "SteamID64"],
    ["team", "Team"],
  ],
};

/**
 * Spreadsheet import: download the template, upload a filled-in .xlsx, review every row (errors
 * per row; nothing written yet), then import. Rows with errors are never imported.
 */
export function ImportDialog({ kind, onClose, onDone }: { kind: "teams" | "players"; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<{ name: string; data: ArrayBuffer } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const load = async (f: File) => {
    setError(null);
    setPreview(null);
    if (!/\.xlsx$/i.test(f.name)) return setError(`${f.name} is not an .xlsx file. Save the spreadsheet as Excel Workbook (.xlsx).`);
    const data = await f.arrayBuffer();
    setFile({ name: f.name, data });
    setBusy(true);
    try {
      setPreview(await api.upload<ImportPreview>(`/api/v1/import/${kind}/preview`, data, TYPE));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.upload<{ created: string[]; skippedRows: number[] }>(`/api/v1/import/${kind}/commit${preview.invalid ? "?skipInvalid=1" : ""}`, file.data, TYPE);
      toast.push("ok", `Imported ${r.created.length} ${kind === "teams" ? (r.created.length === 1 ? "team" : "teams") : r.created.length === 1 ? "player" : "players"}`, r.skippedRows.length ? `Skipped rows ${r.skippedRows.join(", ")} (errors).` : undefined);
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const cols = COLUMNS[kind];
  return (
    <Modal
      title={`Import ${kind}`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} disabledReason={!preview ? "Upload a filled-in template first" : preview.valid === 0 ? "No rows without errors to import" : null} onClick={() => void commit()}>
            {preview && preview.invalid ? `Import ${preview.valid} valid row${preview.valid === 1 ? "" : "s"}, skip ${preview.invalid}` : `Import ${preview?.valid ?? ""} row${preview?.valid === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <ol className="import-steps">
        <li>
          <Button
            size="sm"
            onClick={() =>
              void api
                .download(`/api/v1/import/${kind}/template.xlsx`)
                .then((d) => saveBlob(d.blob, d.filename ?? `MatchFrame ${kind} import template.xlsx`))
                .catch((e) => setError(describeError(e)))
            }
          >
            Download the template
          </Button>{" "}
          <span className="small muted">
            {kind === "players" ? "Import teams first: each player's Team must be an existing team's name, short name or id. Keep the SteamID64 column as Text." : "One team per row; teams that already exist are reported, not created again."}
          </span>
        </li>
        <li>
          <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label="Choose .xlsx file" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
          <Button size="sm" variant={file ? "secondary" : "primary"} onClick={() => input.current?.click()} disabled={busy}>
            {file ? "Choose another file" : "Upload a filled-in .xlsx"}
          </Button>{" "}
          {file ? <span className="small mono">{file.name}</span> : null}
        </li>
        <li>Check the rows below, then import. Nothing is written until you import.</li>
      </ol>
      {error ? (
        <Note tone="danger" title="Import problem">
          {error}
        </Note>
      ) : null}
      {busy && !preview ? <Loading label="Reading the spreadsheet…" /> : null}
      {preview ? (
        <>
          <p className="small">
            {preview.total} row{preview.total === 1 ? "" : "s"}: <strong className="text-ok">{preview.valid} ready</strong>
            {preview.invalid ? (
              <>
                , <strong className="text-danger">{preview.invalid} with errors</strong> (not imported)
              </>
            ) : null}
            {preview.ignoredColumns.length ? <span className="muted"> · Ignored columns: {preview.ignoredColumns.join(", ")}</span> : null}
          </p>
          <div className="import-table-wrap">
            <table className="table table-compact import-table">
              <thead>
                <tr>
                  <th>Row</th>
                  {cols.map(([, h]) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>Check</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row} className={r.errors.length ? "is-error" : ""}>
                    <td className="mono">{r.row}</td>
                    {cols.map(([k]) => (
                      <td key={k} className={k === "steamId" ? "mono" : ""}>
                        {r.values[k] || <span className="muted">—</span>}
                      </td>
                    ))}
                    <td>{r.errors.length ? <span className="text-danger">{r.errors.join(" · ")}</span> : <Badge tone="ok">Ready</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
