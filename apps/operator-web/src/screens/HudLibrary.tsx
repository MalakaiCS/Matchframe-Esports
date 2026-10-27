import { useMemo, useRef, useState } from "react";
import type { HudLibrary, HudLibraryEntry } from "@matchframe/contracts";
import { api, ApiError, describeError } from "../api/index.ts";
import { desktopHud } from "../api/desktop.ts";
import { Icon } from "../components/icons.tsx";
import { useToast } from "../components/toasts.tsx";
import { Button, ConfirmDialog, EmptyState, ErrorBox, Loading, Modal, Note } from "../components/ui.tsx";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import type { HudDisplayStatus, HudSort } from "../lib/hudLibrary.ts";
import { copyText, defaultVariant, desktopReason as desktopReasonOf, filterHuds, hudStatus, NO_CATEGORY, outputCounts, resolutionLabel, SORT_LABEL, sortHuds, STATUS_INFO, STATUS_ORDER, toArrayBuffer, useDesktopOverlays, variantUrl } from "../lib/hudLibrary.ts";
import { useLive } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { BUILTIN_REASON, exportHud, hudPath, launchHud, LIBRARY_PATH, reloadHud, stopHud, useRun } from "./hudlib/actions.ts";
import type { HudActionReasons, HudActions } from "./hudlib/HudCard.tsx";
import { HudCard, HudRow } from "./hudlib/HudCard.tsx";
import type { DetailsTab } from "./hudlib/HudDetails.tsx";
import { HudDetails } from "./hudlib/HudDetails.tsx";
import "../styles/hud-library.css";

type View = "grid" | "list";
type OnConflict = "replace" | "copy";

/** An import waiting for the operator's decision because the HUD id is already installed. */
interface PendingImport {
  label: string;
  detail: { id: string; installedVersion: string; incomingVersion: string; builtin: boolean };
  retry(onConflict: OnConflict): Promise<HudLibraryEntry>;
}

function conflictOf(e: unknown): PendingImport["detail"] | null {
  if (!(e instanceof ApiError) || e.status !== 409 || (e.code !== "duplicate_id" && e.code !== "builtin")) return null;
  const d = e.detail as Partial<PendingImport["detail"]> | null;
  return d && typeof d.id === "string" ? { id: d.id, installedVersion: String(d.installedVersion ?? "?"), incomingVersion: String(d.incomingVersion ?? "?"), builtin: d.builtin === true } : null;
}

function ConflictDialog({ pending, onDone, onCancel }: { pending: PendingImport; onDone: (e: HudLibraryEntry, how: OnConflict) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState<OnConflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { detail } = pending;
  const cmp = detail.incomingVersion === detail.installedVersion ? "the same version as" : "a different version from";
  const go = (how: OnConflict) => {
    setBusy(how);
    setError(null);
    pending
      .retry(how)
      .then((e) => onDone(e, how))
      .catch((e) => setError(describeError(e)))
      .finally(() => setBusy(null));
  };
  return (
    <Modal
      title="This HUD is already installed"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button onClick={() => go("copy")} disabledReason={busy ? "Importing…" : null}>
            Import as a copy
          </Button>
          <Button variant="primary" onClick={() => go("replace")} disabledReason={detail.builtin ? "The built-in HUD cannot be replaced" : busy ? "Importing…" : null}>
            Update to {detail.incomingVersion}
          </Button>
        </>
      }
    >
      <p>
        <strong>{pending.label}</strong> has the id <code>{detail.id}</code>, which is installed with version <strong>{detail.installedVersion}</strong>. The package is {cmp} the installed one (<strong>{detail.incomingVersion}</strong>).
      </p>
      <ul className="muted">
        <li>
          <strong>Update</strong> installs it over the current version, keeps its settings and reloads its outputs. You can roll back to {detail.installedVersion} from the details panel.
        </li>
        <li>
          <strong>Import as a copy</strong> installs it next to the current one with a new id.
        </li>
      </ul>
      {error ? <Note tone="danger">{error}</Note> : null}
    </Modal>
  );
}

function Toolbar(p: {
  q: string;
  setQ: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  categories: string[];
  hasUncategorised: boolean;
  status: string;
  setStatus: (v: string) => void;
  sort: HudSort;
  setSort: (v: HudSort) => void;
  view: View;
  setView: (v: View) => void;
}) {
  return (
    <div className="hudlib-toolbar" role="search">
      <label className="hudlib-search">
        <Icon name="search" size={16} />
        <span className="sr-only">Search HUDs</span>
        <input type="search" placeholder="Search by name, author or tag" value={p.q} onChange={(e) => p.setQ(e.target.value)} />
      </label>
      <label className="hudlib-filter">
        <span>Game</span>
        <select value="cs2" onChange={() => undefined} aria-label="Game">
          <option value="cs2">Counter-Strike 2</option>
        </select>
      </label>
      <label className="hudlib-filter">
        <span>Category</span>
        <select value={p.category} onChange={(e) => p.setCategory(e.target.value)} aria-label="Category">
          <option value="all">All</option>
          {p.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {p.hasUncategorised ? <option value={NO_CATEGORY}>No category</option> : null}
        </select>
      </label>
      <label className="hudlib-filter">
        <span>Status</span>
        <select value={p.status} onChange={(e) => p.setStatus(e.target.value)} aria-label="Status">
          <option value="all">All</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_INFO[s].label}
            </option>
          ))}
        </select>
      </label>
      <label className="hudlib-filter">
        <span>Sort</span>
        <select value={p.sort} onChange={(e) => p.setSort(e.target.value as HudSort)} aria-label="Sort">
          {(Object.keys(SORT_LABEL) as HudSort[]).map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <div className="seg" role="group" aria-label="View">
        <button type="button" className={`seg-btn ${p.view === "grid" ? "is-on" : ""}`} aria-pressed={p.view === "grid"} onClick={() => p.setView("grid")} title="Grid">
          <Icon name="grid" size={16} />
          <span className="sr-only">Grid</span>
        </button>
        <button type="button" className={`seg-btn ${p.view === "list" ? "is-on" : ""}`} aria-pressed={p.view === "list"} onClick={() => p.setView("list")} title="List">
          <Icon name="list" size={16} />
          <span className="sr-only">List</span>
        </button>
      </div>
    </div>
  );
}

/**
 * HUD Library (the program's start page): the HUDs installed on this computer, each ready to run as
 * a transparent desktop window over the game, an OBS browser source or a preview.
 */
export function HudLibraryScreen() {
  const lib = useApi<HudLibrary>(LIBRARY_PATH, { refreshMs: 3000 });
  const bridge = desktopHud();
  const overlays = useDesktopOverlays(bridge);
  const simulated = useLive((s) => s.snapshot?.simulated ?? false);
  const toast = useToast();
  const run = useRun();
  const editReason = usePermission("hud.publish");
  const simReason = usePermission("settings.manage");
  const desktopReason = desktopReasonOf(bridge);
  const local = !!bridge?.available;

  const [q, setQ] = useState("");
  const [category, setCategory] = usePersistentState("hudlibCategory", "all");
  const [status, setStatus] = usePersistentState("hudlibStatus", "all");
  const [sort, setSort] = usePersistentState<HudSort>("hudlibSort", "name");
  const [view, setView] = usePersistentState<View>("hudlibView", "grid");
  const [selectedId, setSelectedId] = usePersistentState<string | null>("hudlibSelected", null);
  const [tab, setTab] = useState<DetailsTab>("overview");
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [removing, setRemoving] = useState<HudLibraryEntry | null>(null);
  const [busyImport, setBusyImport] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const huds = useMemo(() => lib.data?.huds ?? [], [lib.data]);
  const overlayOf = useMemo(() => new Map(overlays.map((o) => [o.hudId, o])), [overlays]);
  const statusOf = (e: HudLibraryEntry): { status: HudDisplayStatus; detail: string | null } => hudStatus(e, overlayOf.get(e.id));
  const categories = useMemo(() => [...new Set(huds.map((h) => h.category).filter((c): c is string => !!c))].sort(), [huds]);
  const shown = sortHuds(
    filterHuds(huds, { q, game: "all", category, status }, (e) => statusOf(e).status),
    sort,
  );
  const selected = huds.find((h) => h.id === selectedId) ?? null;

  // ---------------------------------------------------------------- import

  const imported = (e: HudLibraryEntry, how: "installed" | OnConflict) => {
    setPending(null);
    setSelectedId(e.id);
    setTab("overview");
    toast.push("ok", how === "replace" ? `${e.name} updated to ${e.version}` : how === "copy" ? `${e.name} imported as a copy` : `${e.name} imported`, how === "replace" ? "Its outputs reload with the new version." : "Saved in your HUD library; it keeps working if the original file is moved or deleted.");
    void lib.reload();
  };

  const importWith = async (label: string, send: (onConflict: "fail" | OnConflict) => Promise<HudLibraryEntry>) => {
    setBusyImport(true);
    try {
      imported(await send("fail"), "installed");
    } catch (e) {
      const detail = conflictOf(e);
      if (detail) setPending({ label, detail, retry: (how) => send(how) });
      else toast.push("danger", `Importing ${label} failed`, describeError(e));
    } finally {
      setBusyImport(false);
    }
  };

  const uploadZip = (name: string, bytes: ArrayBuffer) => importWith(name, (onConflict) => api.upload<HudLibraryEntry>(`${LIBRARY_PATH}/import?onConflict=${onConflict}`, bytes, "application/zip"));

  const importZip = async () => {
    if (!bridge) return fileInput.current?.click();
    try {
      const picked = await bridge.pickZip();
      if (picked) await uploadZip(picked.name, toArrayBuffer(picked.bytes));
    } catch (e) {
      toast.push("danger", "Import HUD ZIP failed", describeError(e));
    }
  };

  const importFolder = async () => {
    if (!bridge) return;
    try {
      const path = await bridge.pickFolder();
      if (path) await importWith(path.split(/[\\/]/).filter(Boolean).pop() ?? path, (onConflict) => api.post<HudLibraryEntry>(`${LIBRARY_PATH}/import-folder`, { path, onConflict }));
    } catch (e) {
      toast.push("danger", "Import HUD Folder failed", describeError(e));
    }
  };

  // ---------------------------------------------------------------- per-HUD actions

  const actionsFor = (e: HudLibraryEntry): HudActions => ({
    launch: () => void run("Launch Transparent HUD", () => launchHud(bridge, e, overlayOf.get(e.id)?.variant ?? defaultVariant(e))).then(() => lib.reload()),
    closeDesktop: () => bridge && void run("Close Desktop HUD", () => bridge.close(e.id)),
    preview: () => {
      if (bridge && local) void run("Preview", () => bridge.openPreview(e.id, { variant: defaultVariant(e), checker: true }));
      else {
        setSelectedId(e.id);
        setTab("overview");
      }
    },
    copyUrl: () => {
      const url = variantUrl(e, defaultVariant(e));
      if (!url) return;
      void copyText(url).then(() => toast.push("ok", "OBS Browser URL copied", `Add a Browser Source with this URL at ${resolutionLabel(e)} (width × height), above your Game Capture.`));
    },
    settings: () => {
      setSelectedId(e.id);
      setTab("appearance");
    },
    reload: () => void run("Reload", () => reloadHud(e), `${e.name} reloaded on every output`).then(() => lib.reload()),
    stop: () => void run("Stop", () => stopHud(bridge, e), `${e.name} stopped. OBS sources stay connected but show nothing until you launch or start it again.`).then(() => lib.reload()),
    duplicate: () => void run("Duplicate", () => api.post<HudLibraryEntry>(`${hudPath(e.id)}/duplicate`), (c) => `Duplicated as ${c.name}`).then((c) => c && (setSelectedId(c.id), void lib.reload())),
    exportZip: () => void run("Export ZIP", () => exportHud(bridge, e), (name) => (name ? `Exported ${name}` : null)),
    openFolder: () => bridge && void run("Open Folder", () => bridge.openHudFolder(e.id)),
    remove: () => setRemoving(e),
  });

  const reasonsFor = (e: HudLibraryEntry): HudActionReasons => {
    const builtin = e.kind === "builtin";
    const err = e.status === "error" ? (e.error ?? "This HUD failed verification") : null;
    return {
      launch: editReason ?? desktopReason ?? err,
      closeDesktop: desktopReason,
      preview: err,
      copyUrl: variantUrl(e, defaultVariant(e)) ? null : "This HUD has no OBS output",
      reload: editReason ?? err,
      stop: editReason ?? (e.stopped && !overlayOf.get(e.id) ? "Already stopped" : null),
      duplicate: editReason ?? (builtin ? BUILTIN_REASON.duplicate : null),
      exportZip: builtin ? BUILTIN_REASON.export : null,
      openFolder: builtin ? BUILTIN_REASON.folder : !bridge ? "Opening folders needs the Matchframe program" : !local ? "The HUD folders are on the production computer" : null,
      remove: editReason ?? (builtin ? BUILTIN_REASON.remove : null),
    };
  };

  const hideAll = async (hidden: boolean) => {
    await api.post(`${LIBRARY_PATH}/visibility`, { hidden });
    if (bridge && local) await (hidden ? bridge.hideAll() : bridge.showAll()).catch(() => undefined);
    await lib.reload();
  };

  // ---------------------------------------------------------------- render

  const itemProps = (e: HudLibraryEntry) => {
    const st = statusOf(e);
    const overlay = overlayOf.get(e.id);
    return {
      entry: e,
      status: st.status,
      statusDetail: st.detail,
      outputs: outputCounts(e, overlay),
      overlay,
      selected: e.id === selectedId,
      onSelect: () => setSelectedId(e.id === selectedId ? null : e.id),
      actions: actionsFor(e),
      reasons: reasonsFor(e),
    };
  };

  return (
    <div className={`page hudlib ${selected ? "has-details" : ""}`} data-testid="hud-library">
      <div className="hudlib-head">
        <div>
          <h1 className="page-title">HUD Library</h1>
          <p className="muted small">{lib.data ? `${huds.length} HUD${huds.length === 1 ? "" : "s"} ${local || !bridge ? "on this computer" : "on the production computer"}` : " "}</p>
        </div>
        <div className="hudlib-actions">
          <Button variant="primary" onClick={() => void importZip()} disabledReason={editReason ?? (busyImport ? "Importing…" : null)}>
            <Icon name="upload" size={14} /> Import HUD ZIP
          </Button>
          <Button onClick={() => void importFolder()} disabledReason={editReason ?? (!bridge ? "Importing a folder needs the Matchframe program" : !local ? "Folders can be imported only on the production computer; import a ZIP instead" : busyImport ? "Importing…" : null)}>
            <Icon name="folder" size={14} /> Import HUD Folder
          </Button>
          <Button onClick={() => bridge && void run("Open HUDs Folder", () => bridge.openHudsFolder())} disabledReason={!bridge ? "Opening folders needs the Matchframe program" : !local ? "The HUD folder is on the production computer" : null}>
            Open HUDs Folder
          </Button>
          {simulated ? (
            <Button variant="warn" onClick={() => void run("Stop Test Data", () => api.post("/api/v1/simulation/stop"), "Test data stopped")} disabledReason={simReason}>
              Stop Test Data
            </Button>
          ) : (
            <Button onClick={() => void run("Run Test Data", () => api.post("/api/v1/simulation/start", { startOffsetSec: 25 }), "Test data running: a labelled simulation feeds every HUD output")} disabledReason={simReason} title="Feeds every HUD with labelled test data (a synthetic match), without CS2">
              <Icon name="play" size={14} /> Run Test Data
            </Button>
          )}
          <Button variant={lib.data?.hiddenAll ? "warn" : "ghost"} onClick={() => void run(lib.data?.hiddenAll ? "Show HUD graphics" : "Hide all HUD graphics", () => hideAll(!lib.data?.hiddenAll))} disabledReason={editReason ?? (lib.data ? null : "Loading…")} aria-pressed={!!lib.data?.hiddenAll} title="Hides every HUD graphic at once: desktop HUDs, previews and OBS sources (Emergency hide)">
            <Icon name={lib.data?.hiddenAll ? "eye" : "eyeOff"} size={14} /> {lib.data?.hiddenAll ? "Show all HUDs" : "Hide all"}
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          aria-label="HUD package ZIP"
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            ev.target.value = "";
            if (f) void f.arrayBuffer().then((b) => uploadZip(f.name, b));
          }}
        />
      </div>
      {lib.data?.hiddenAll ? (
        <Note tone="warn" title="All HUD graphics are hidden">
          Desktop HUDs, previews and OBS sources show nothing until you click Show all HUDs (or press the emergency hide hotkey again).
        </Note>
      ) : null}
      {desktopReason && bridge ? <Note tone="neutral">{desktopReason}. The library, OBS browser sources and previews still work.</Note> : null}
      <Toolbar q={q} setQ={setQ} category={category} setCategory={setCategory} categories={categories} hasUncategorised={huds.some((h) => !h.category)} status={status} setStatus={setStatus} sort={sort} setSort={setSort} view={view} setView={setView} />
      <div className="hudlib-body">
        <div className="hudlib-items">
          {!lib.data ? (
            lib.error ? (
              <ErrorBox error={lib.error} onRetry={() => void lib.reload()} />
            ) : (
              <Loading label="Loading HUDs…" />
            )
          ) : huds.length === 0 ? (
            <EmptyState title="No HUDs yet" action={<Button onClick={() => void importZip()}>Import HUD ZIP</Button>}>
              Import a HUD package (a ZIP with a manifest.json) to get started.
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState
              title="No HUDs match"
              action={
                <Button
                  onClick={() => {
                    setQ("");
                    setCategory("all");
                    setStatus("all");
                  }}
                >
                  Clear filters
                </Button>
              }
            >
              Nothing matches the search and filters.
            </EmptyState>
          ) : view === "grid" ? (
            <div className="hud-grid">
              {shown.map((e) => (
                <HudCard key={e.id} {...itemProps(e)} />
              ))}
            </div>
          ) : (
            <div className="hud-list" role="table" aria-label="HUDs">
              <div className="hud-row hud-row-head" role="row">
                <span />
                <span role="columnheader">Name</span>
                <span role="columnheader">Category</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Outputs</span>
                <span role="columnheader" className="sr-only">
                  Actions
                </span>
              </div>
              {shown.map((e) => (
                <HudRow key={e.id} {...itemProps(e)} />
              ))}
            </div>
          )}
        </div>
        {selected ? (
          <HudDetails
            {...itemProps(selected)}
            bridge={bridge}
            desktopReason={desktopReason}
            editReason={editReason}
            tab={tab}
            onTab={setTab}
            onClose={() => setSelectedId(null)}
            onChanged={() => void lib.reload()}
          />
        ) : null}
      </div>
      {pending ? <ConflictDialog pending={pending} onDone={imported} onCancel={() => setPending(null)} /> : null}
      {removing ? (
        <ConfirmDialog
          spec={{
            title: `Remove ${removing.name}?`,
            body: (
              <p>
                Removes the HUD and its settings from this computer, closes its desktop and preview windows and disconnects its OBS sources. {removing.kind === "sample" ? "Sample HUDs are not installed again automatically." : "Export it first if you want to keep a copy."}
              </p>
            ),
            confirmLabel: "Remove",
            danger: true,
          }}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const e = removing;
            setRemoving(null);
            void run(
              "Remove",
              async () => {
                if (bridge && local) await Promise.allSettled([bridge.close(e.id), bridge.closePreviews(e.id)]);
                await api.del(hudPath(e.id));
              },
              `${e.name} removed`,
            ).then(() => {
              if (selectedId === e.id) setSelectedId(null);
              void lib.reload();
            });
          }}
        />
      ) : null}
    </div>
  );
}
