import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { HudLibrary, HudLibraryEntry } from "@matchframe/contracts";
import { api, ApiError, describeError } from "../api/index.ts";
import { desktopHud } from "../api/desktop.ts";
import { AutoDirectorCard } from "../components/AutoDirectorCard.tsx";
import { Icon } from "../components/icons.tsx";
import { LowSpecSuggestion } from "../components/LowSpec.tsx";
import { useToast } from "../components/toasts.tsx";
import { Button, ConfirmDialog, EmptyState, ErrorBox, Loading, Modal, Note } from "../components/ui.tsx";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import type { HudDisplayStatus, HudSort } from "../lib/hudLibrary.ts";
import { copyText, defaultVariant, desktopReason as desktopReasonOf, filterHuds, hudStatus, NO_CATEGORY, outputCounts, resolutionLabel, SORT_LABEL, sortHuds, STATUS_INFO, STATUS_ORDER, toArrayBuffer, useDesktopOverlays, variantUrl } from "../lib/hudLibrary.ts";
import { Link } from "../router.tsx";
import { useLive } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { BUILTIN_REASON, exportHud, hudPath, launchHud, LIBRARY_PATH, reloadHud, stopHud, useRun } from "./hudlib/actions.ts";
import type { HudActionReasons, HudActions } from "./hudlib/HudCard.tsx";
import { HudCard, HudRow, MenuButton } from "./hudlib/HudCard.tsx";
import { GameCard, HudOptions } from "./hudlib/HudOptions.tsx";
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
  const same = detail.incomingVersion === detail.installedVersion;
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
      title={t("hudlib.conflict.title")}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button onClick={() => go("copy")} disabledReason={busy ? t("hudlib.importing") : null}>
            {t("hudlib.conflict.copy")}
          </Button>
          <Button variant="primary" onClick={() => go("replace")} disabledReason={detail.builtin ? t("hudlib.conflict.builtin") : busy ? t("hudlib.importing") : null}>
            {t("hudlib.conflict.update", { version: detail.incomingVersion })}
          </Button>
        </>
      }
    >
      <p>
        <T k={same ? "hudlib.conflict.bodySame" : "hudlib.conflict.bodyDifferent"} values={{ name: <strong>{pending.label}</strong>, id: <code>{detail.id}</code>, installed: <strong>{detail.installedVersion}</strong>, incoming: <strong>{detail.incomingVersion}</strong> }} />
      </p>
      <ul className="muted">
        <li>
          <T k="hudlib.conflict.updateExplain" values={{ version: detail.installedVersion }} />
        </li>
        <li>
          <T k="hudlib.conflict.copyExplain" />
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
  count: string;
  add: ReactNode;
}) {
  return (
    <div className="hudlib-toolbar" role="search">
      <label className="hudlib-search">
        <Icon name="search" size={16} />
        <span className="sr-only">{t("hudlib.toolbar.search")}</span>
        <input type="search" placeholder={t("hudlib.toolbar.searchPlaceholder")} value={p.q} onChange={(e) => p.setQ(e.target.value)} />
      </label>
      <label className="hudlib-filter">
        <span>{t("hudlib.toolbar.category")}</span>
        <select value={p.category} onChange={(e) => p.setCategory(e.target.value)} aria-label={t("hudlib.toolbar.category")}>
          <option value="all">{t("hudlib.toolbar.all")}</option>
          {p.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {p.hasUncategorised ? <option value={NO_CATEGORY}>{t("hudlib.toolbar.noCategory")}</option> : null}
        </select>
      </label>
      <label className="hudlib-filter">
        <span>{t("hudlib.toolbar.status")}</span>
        <select value={p.status} onChange={(e) => p.setStatus(e.target.value)} aria-label={t("hudlib.toolbar.status")}>
          <option value="all">{t("hudlib.toolbar.all")}</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_INFO[s].label}
            </option>
          ))}
        </select>
      </label>
      <label className="hudlib-filter">
        <span>{t("hudlib.toolbar.sort")}</span>
        <select value={p.sort} onChange={(e) => p.setSort(e.target.value as HudSort)} aria-label={t("hudlib.toolbar.sort")}>
          {(Object.keys(SORT_LABEL) as HudSort[]).map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <div className="seg" role="group" aria-label={t("hudlib.toolbar.view")}>
        <button type="button" className={`seg-btn ${p.view === "grid" ? "is-on" : ""}`} aria-pressed={p.view === "grid"} onClick={() => p.setView("grid")} title={t("hudlib.toolbar.grid")}>
          <Icon name="grid" size={16} />
          <span className="sr-only">{t("hudlib.toolbar.grid")}</span>
        </button>
        <button type="button" className={`seg-btn ${p.view === "list" ? "is-on" : ""}`} aria-pressed={p.view === "list"} onClick={() => p.setView("list")} title={t("hudlib.toolbar.list")}>
          <Icon name="list" size={16} />
          <span className="sr-only">{t("hudlib.toolbar.list")}</span>
        </button>
      </div>
      <span className="hudlib-count muted small">{p.count}</span>
      {p.add}
    </div>
  );
}

/** HUDs grouped by their category (as their manifests declare it); HUDs without one come last. */
function groupByCategory(list: HudLibraryEntry[]): { key: string; title: string; items: HudLibraryEntry[] }[] {
  const map = new Map<string, HudLibraryEntry[]>();
  for (const e of list) {
    const key = e.category ?? NO_CATEGORY;
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === NO_CATEGORY ? 1 : b === NO_CATEGORY ? -1 : a.localeCompare(b)))
    .map(([key, items]) => ({ key, title: key === NO_CATEGORY ? t("hudlib.ungrouped") : key, items }));
}

/**
 * HUD Library (the program's start page): the HUDs installed on this computer, each ready to run as
 * a transparent desktop window over the game, an OBS browser source or a preview.
 */
export function HudLibraryScreen() {
  const lib = useApi<HudLibrary>(LIBRARY_PATH, { refreshMs: 3000 });
  const bridge = desktopHud();
  const overlays = useDesktopOverlays(bridge);
  const toast = useToast();
  const run = useRun();
  const editReason = usePermission("hud.publish");
  const desktopReason = desktopReasonOf(bridge);
  const local = !!bridge?.available;
  // Account sync shares the HUDs the user imported (never samples or the built-in HUD).
  const sharing = useLive((s) => s.snapshot?.cloud?.sharing ?? false);

  const [q, setQ] = useState("");
  const [category, setCategory] = usePersistentState("hudlibCategory", "all");
  const [status, setStatus] = usePersistentState("hudlibStatus", "all");
  const [sort, setSort] = usePersistentState<HudSort>("hudlibSort", "name");
  const [view, setView] = usePersistentState<View>("hudlibView", "list");
  const [collapsed, setCollapsed] = usePersistentState<string[]>("hudlibCollapsedGroups", []);
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
    toast.push("ok", how === "replace" ? t("hudlib.toast.updated", { name: e.name, version: e.version }) : how === "copy" ? t("hudlib.toast.importedCopy", { name: e.name }) : t("hudlib.toast.imported", { name: e.name }), how === "replace" ? t("hudlib.toast.updatedBody") : t("hudlib.toast.importedBody"));
    void lib.reload();
  };

  const importWith = async (label: string, send: (onConflict: "fail" | OnConflict) => Promise<HudLibraryEntry>) => {
    setBusyImport(true);
    try {
      imported(await send("fail"), "installed");
    } catch (e) {
      const detail = conflictOf(e);
      if (detail) setPending({ label, detail, retry: (how) => send(how) });
      else toast.push("danger", t("hudlib.toast.importFailed", { name: label }), describeError(e));
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
      toast.push("danger", t("hudlib.toast.zipFailed"), describeError(e));
    }
  };

  const importFolder = async () => {
    if (!bridge) return;
    try {
      const path = await bridge.pickFolder();
      if (path) await importWith(path.split(/[\\/]/).filter(Boolean).pop() ?? path, (onConflict) => api.post<HudLibraryEntry>(`${LIBRARY_PATH}/import-folder`, { path, onConflict }));
    } catch (e) {
      toast.push("danger", t("hudlib.toast.folderFailed"), describeError(e));
    }
  };

  // ---------------------------------------------------------------- per-HUD actions

  const actionsFor = (e: HudLibraryEntry): HudActions => ({
    launch: () => void run(t("hudlib.action.launch"), () => launchHud(bridge, e, overlayOf.get(e.id)?.variant ?? defaultVariant(e))).then(() => lib.reload()),
    closeDesktop: () => bridge && void run(t("hudlib.action.closeDesktop"), () => bridge.close(e.id)),
    preview: () => {
      if (bridge && local) void run(t("hudlib.action.preview"), () => bridge.openPreview(e.id, { variant: defaultVariant(e), checker: true }));
      else {
        setSelectedId(e.id);
        setTab("overview");
      }
    },
    copyUrl: () => {
      const url = variantUrl(e, defaultVariant(e));
      if (!url) return;
      void copyText(url).then(() => toast.push("ok", t("hudlib.toast.urlCopied"), t("hudlib.toast.urlCopiedBody", { resolution: resolutionLabel(e) })));
    },
    settings: () => {
      setSelectedId(e.id);
      setTab("appearance");
    },
    reload: () => void run(t("hudlib.action.reload"), () => reloadHud(e), t("hudlib.toast.reloaded", { name: e.name })).then(() => lib.reload()),
    stop: () => void run(t("hudlib.action.stop"), () => stopHud(bridge, e), t("hudlib.toast.stopped", { name: e.name })).then(() => lib.reload()),
    duplicate: () => void run(t("hudlib.action.duplicate"), () => api.post<HudLibraryEntry>(`${hudPath(e.id)}/duplicate`), (c) => t("hudlib.toast.duplicated", { name: c.name })).then((c) => c && (setSelectedId(c.id), void lib.reload())),
    exportZip: () => void run(t("hudlib.action.exportZip"), () => exportHud(bridge, e), (name) => (name ? t("hudlib.toast.exported", { name }) : null)),
    openFolder: () => bridge && void run(t("hudlib.action.openFolder"), () => bridge.openHudFolder(e.id)),
    remove: () => setRemoving(e),
  });

  const reasonsFor = (e: HudLibraryEntry): HudActionReasons => {
    const builtin = e.kind === "builtin";
    const err = e.status === "error" ? (e.error ?? t("hudlib.reason.failedVerification")) : null;
    return {
      launch: editReason ?? desktopReason ?? err,
      closeDesktop: desktopReason,
      preview: err,
      copyUrl: variantUrl(e, defaultVariant(e)) ? null : t("hudlib.reason.noObsOutput"),
      reload: editReason ?? err,
      stop: editReason ?? (e.stopped && !overlayOf.get(e.id) ? t("hudlib.reason.alreadyStopped") : null),
      duplicate: editReason ?? (builtin ? BUILTIN_REASON.duplicate : null),
      exportZip: builtin ? BUILTIN_REASON.export : null,
      openFolder: builtin ? BUILTIN_REASON.folder : !bridge ? t("hudlib.reason.foldersNeedProgram") : !local ? t("hudlib.reason.foldersOnProduction") : null,
      remove: editReason ?? (builtin ? BUILTIN_REASON.remove : null),
    };
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
      shared: sharing && e.kind === "imported",
      onSelect: () => setSelectedId(e.id === selectedId ? null : e.id),
      actions: actionsFor(e),
      reasons: reasonsFor(e),
    };
  };

  const addItems = [
    { label: t("hudlib.add.zip"), onClick: () => void importZip(), reason: editReason ?? (busyImport ? t("hudlib.importing") : null) },
    { label: t("hudlib.add.folder"), onClick: () => void importFolder(), reason: editReason ?? (!bridge ? t("hudlib.reason.folderImportNeedsProgram") : !local ? t("hudlib.reason.folderImportProduction") : busyImport ? t("hudlib.importing") : null) },
    { label: t("hudlib.add.openFolder"), onClick: () => bridge && void run(t("hudlib.add.openFolder"), () => bridge.openHudsFolder()), reason: !bridge ? t("hudlib.reason.foldersNeedProgram") : !local ? t("hudlib.reason.folderOnProduction") : null },
  ];
  const groups = groupByCategory(shown);
  const details = (e: HudLibraryEntry) => (
    <HudDetails {...itemProps(e)} bridge={bridge} desktopReason={desktopReason} editReason={editReason} tab={tab} onTab={setTab} onClose={() => setSelectedId(null)} onChanged={() => void lib.reload()} />
  );

  return (
    <div className="page hudlib" data-testid="hud-library">
      <h1 className="page-title">{t("nav.hudLibrary")}</h1>
      {lib.data?.hiddenAll ? (
        <Note tone="warn" title={t("hudlib.hidden.title")}>
          {t("hudlib.hidden.body")}
        </Note>
      ) : null}
      {desktopReason && bridge ? <Note tone="neutral">{t("hudlib.desktop.stillWorks", { reason: desktopReason })}</Note> : null}
      <LowSpecSuggestion />
      <AutoDirectorCard />
      <div className="hudlib-cards">
        <HudOptions library={lib.data} onChanged={() => void lib.reload()} />
        <GameCard />
      </div>
      <Toolbar
        q={q}
        setQ={setQ}
        category={category}
        setCategory={setCategory}
        categories={categories}
        hasUncategorised={huds.some((h) => !h.category)}
        status={status}
        setStatus={setStatus}
        sort={sort}
        setSort={setSort}
        view={view}
        setView={setView}
        count={lib.data ? t(local || !bridge ? "hudlib.count.here" : "hudlib.count.production", { count: huds.length }) : ""}
        add={
          <>
            <Link to="/hud/images" className="btn btn-secondary btn-md" title={t("hudlib.imagesTitle")}>
              <Icon name="upload" size={14} /> {t("nav.hudImages")}
            </Link>
            <MenuButton label={t("hudlib.add.label")} buttonLabel={t("hudlib.add.label")} icon="plus" items={addItems} />
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        hidden
        aria-label={t("hudlib.zipInput")}
        onChange={(ev) => {
          const f = ev.target.files?.[0];
          ev.target.value = "";
          if (f) void f.arrayBuffer().then((b) => uploadZip(f.name, b));
        }}
      />
      <div className="hudlib-items">
        {!lib.data ? (
          lib.error ? (
            <ErrorBox error={lib.error} onRetry={() => void lib.reload()} />
          ) : (
            <Loading label={t("hudlib.loading")} />
          )
        ) : huds.length === 0 ? (
          <EmptyState title={t("hudlib.empty.title")} action={<Button onClick={() => void importZip()}>{t("hudlib.empty.import")}</Button>}>
            {t("hudlib.empty.body")}
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            title={t("hudlib.noMatch.title")}
            action={
              <Button
                onClick={() => {
                  setQ("");
                  setCategory("all");
                  setStatus("all");
                }}
              >
                {t("hudlib.noMatch.clear")}
              </Button>
            }
          >
            {t("hudlib.noMatch.body")}
          </EmptyState>
        ) : (
          groups.map((g) => {
            const open = !collapsed.includes(g.key);
            const selectedHere = selected && g.items.includes(selected) ? selected : null;
            return (
              <section key={g.key} className="hud-group" aria-label={g.title}>
                <button type="button" className={`hud-group-head ${open ? "is-open" : ""}`} aria-expanded={open} onClick={() => setCollapsed(open ? [...collapsed, g.key] : collapsed.filter((k) => k !== g.key))}>
                  <Icon name="chevronDown" size={14} />
                  <span>{g.title}</span>
                  <span className="hud-group-count">{g.items.length}</span>
                </button>
                {!open ? null : view === "grid" ? (
                  <>
                    <div className="hud-grid">
                      {g.items.map((e) => (
                        <HudCard key={e.id} {...itemProps(e)} />
                      ))}
                    </div>
                    {selectedHere ? details(selectedHere) : null}
                  </>
                ) : (
                  <div className="hud-list" aria-label={t("hudlib.groupList", { group: g.title })}>
                    {g.items.map((e) => (
                      <div key={e.id} className={`hud-list-item ${e === selectedHere ? "is-open" : ""}`}>
                        <HudRow {...itemProps(e)} />
                        {e === selectedHere ? details(e) : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
      {pending ? <ConflictDialog pending={pending} onDone={imported} onCancel={() => setPending(null)} /> : null}
      {removing ? (
        <ConfirmDialog
          spec={{
            title: t("hudlib.remove.title", { name: removing.name }),
            body: (
              <p>
                {t("hudlib.remove.body")} {removing.kind === "sample" ? t("hudlib.remove.sample") : t("hudlib.remove.exportFirst")}
              </p>
            ),
            confirmLabel: t("hudlib.remove.confirm"),
            danger: true,
          }}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const e = removing;
            setRemoving(null);
            void run(
              t("hudlib.remove.confirm"),
              async () => {
                if (bridge && local) await Promise.allSettled([bridge.close(e.id), bridge.closePreviews(e.id)]);
                await api.del(hudPath(e.id));
              },
              t("hudlib.toast.removed", { name: e.name }),
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
