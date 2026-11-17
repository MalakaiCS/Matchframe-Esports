import { useEffect, useRef, useState } from "react";
import { api, describeError, seg } from "../api/index.ts";
import type { DeleteImpact, ImportPreview } from "../api/types.ts";
import { useToast } from "./toasts.tsx";
import { Badge, Button, Loading, Modal, Note } from "./ui.tsx";
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";

type Kind = "teams" | "players" | "matches";
/** "3 teams", in the console's language. */
const plural = (k: Kind, n: number) => (k === "teams" ? t("editor.count.teams", { count: n }) : k === "players" ? t("editor.count.players", { count: n }) : t("editor.count.matches", { count: n }));
const noun = (k: Kind) => (k === "teams" ? t("editor.noun.team") : k === "players" ? t("editor.noun.player") : t("editor.noun.match"));

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
        toast.push("ok", t("editor.deletedWhat", { what: deletable.length === 1 ? deletable[0]!.label : plural(kind, deletable.length) }));
      } else {
        for (const b of blocked) await api.post(`/api/v1/${kind}/${seg(b.id)}/archive`, { archived: true });
        toast.push("ok", t("editor.archivedWhat", { what: blocked.length === 1 ? blocked[0]!.label : plural(kind, blocked.length) }), t("editor.archivedRecordsAreHiddenFrom"));
      }
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const title = t("editor.deleteWhatQ", { what: ids.length === 1 ? (impacts?.[0]?.label ?? noun(kind)) : plural(kind, ids.length) });
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={ids.length > 1}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          {blocked.length ? (
            <Button variant="warn" disabled={busy} onClick={() => void run("archive")}>{t("editor.archiveVInstead", { v: blocked.length === 1 ? blocked[0]!.label : t("editor.theCountBlocked", { count: blocked.length }) })}</Button>
          ) : null}
          {deletable.length ? (
            <Button variant="danger" disabled={busy} onClick={() => void run("delete")}>
              {blocked.length ? t("editor.deleteTheKindThatCan", { kind: plural(kind, deletable.length) }) : ids.length === 1 ? t("editor.delete") : t("editor.deleteKind", { kind: plural(kind, deletable.length) })}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? (
        <Note tone="danger" title={t("editor.notDeleted")}>
          {error}
        </Note>
      ) : null}
      {!impacts && !error ? <Loading label={t("editor.checkingWhatUsesTheseRecords")} /> : null}
      {impacts ? (
        <ul className="impact-list">
          {impacts.map((i) => (
            <li key={i.id} className={`impact ${i.deletable ? "" : "is-blocked"}`}>
              <div className="impact-head">
                <strong>{i.label}</strong> {i.deletable ? <Badge tone="danger">{t("editor.willBeDeleted")}</Badge> : <Badge tone="warn">{t("editor.cannotBeDeleted")}</Badge>}
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
                  <li>{t("editor.nothingElseRefersToIt")}</li>
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {blocked.length ? <p className="small muted">{t("editor.archiveHidesARecordFrom")}</p> : impacts ? <p className="small muted">{t("editor.deletingCannotBeUndone")}</p> : null}
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

const COLUMNS: Record<"teams" | "players", [string, string][]> = perLocale(() => ({
  teams: [
    ["name", t("editor.teamName")],
    ["shortName", t("editor.shortName")],
    ["country", "Country"],
  ],
  players: [
    ["displayName", "Nickname"],
    ["firstName", t("editor.firstName")],
    ["lastName", t("editor.lastName")],
    ["country", "Country"],
    ["steamId", "SteamID64"],
    ["team", "Team"],
  ],
}));

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
    if (!/\.xlsx$/i.test(f.name)) return setError(t("editor.nameIsNotAnXlsx", { name: f.name }));
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
      toast.push("ok", t("editor.importedWhat", { what: plural(kind, r.created.length) }), r.skippedRows.length ? t("editor.skippedRowsJoinErrors", { join: r.skippedRows.join(", ") }) : undefined);
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
      title={kind === "teams" ? t("editor.importTeams") : t("editor.importPlayers")}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} disabledReason={!preview ? t("editor.uploadAFilledInTemplate") : preview.valid === 0 ? t("editor.noRowsWithoutErrorsTo") : null} onClick={() => void commit()}>
            {preview && preview.invalid ? t("editor.importValidSkip", { count: preview.valid, invalid: preview.invalid }) : preview ? t("editor.importRows", { count: preview.valid }) : t("editor.import")}
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
          >{t("editor.downloadTheTemplate")}</Button>{" "}
          <span className="small muted">
            {kind === "players" ? t("editor.importTeamsFirstEachPlayer") : t("editor.oneTeamPerRowTeams")}
          </span>
        </li>
        <li>
          <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label={t("editor.chooseXlsxFile")} onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
          <Button size="sm" variant={file ? "secondary" : "primary"} onClick={() => input.current?.click()} disabled={busy}>
            {file ? t("editor.chooseAnotherFile") : t("editor.uploadAFilledInXlsx")}
          </Button>{" "}
          {file ? <span className="small mono">{file.name}</span> : null}
        </li>
        <li>{t("editor.checkTheRowsBelowThen")}</li>
      </ol>
      {error ? (
        <Note tone="danger" title={t("editor.importProblem")}>
          {error}
        </Note>
      ) : null}
      {busy && !preview ? <Loading label={t("editor.readingTheSpreadsheet")} /> : null}
      {preview ? (
        <>
          <p className="small"><T k="editor.rowsSummary" values={{ count: preview.total, strong: <strong className="text-ok">{t("editor.validReady", { valid: preview.valid })}</strong>, v2: preview.invalid ? (
              <><T k="editor.strongNotImported" values={{ strong: <strong className="text-danger">{t("editor.invalidWithErrors", { invalid: preview.invalid })}</strong> }} /></>
            ) : null, v3: preview.ignoredColumns.length ? <span className="muted">{t("editor.ignoredColumnsJoin", { join: preview.ignoredColumns.join(", ") })}</span> : null }} /></p>
          <div className="import-table-wrap">
            <table className="table table-compact import-table">
              <thead>
                <tr>
                  <th>{t("editor.row")}</th>
                  {cols.map(([, h]) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>{t("editor.check")}</th>
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
                    <td>{r.errors.length ? <span className="text-danger">{r.errors.join(" · ")}</span> : <Badge tone="ok">{t("editor.ready")}</Badge>}</td>
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
