import { useRef, useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { HudPackage } from "../../api/types.ts";
import { ActionButton, Async, Badge, Details, EmptyState, Field, KV, Panel } from "../../components/ui.tsx";
import { fmtBytes, fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";

/** Engine limit for HUD archive uploads (POST /api/v1/hud/packages/import); larger archives must be imported from a directory. */
const MAX_UPLOAD = 60 * 1024 * 1024;

export function PackagesTab() {
  const pk = useApi<HudPackage[]>("/api/v1/hud/packages");
  const reason = usePermission("hud.publish");
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dir, setDir] = useState("");
  return (
    <div className="stack">
      <Panel title={t("huds.installedPackages")}>
        <Async state={pk}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title={t("huds.noPackages")}>{t("huds.theBuiltInMatchframeHud")}</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("huds.package")}</th>
                      <th>{t("huds.version")}</th>
                      <th>{t("huds.integrity")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.manifest.name}</strong>
                          <span className="muted small"> · {p.classification === "builtin" ? "Built-in" : t("huds.imported")}</span>
                          {p.manifest.description ? <div className="small muted">{p.manifest.description}</div> : null}
                          <Details summary={t("common.details")}>
                            <KV
                              items={[
                                ["ID", <span key="id" className="mono">{p.id}</span>],
                                [t("huds.author"), p.manifest.author],
                                [t("huds.licence"), p.manifest.licence],
                                [t("huds.variants"), Object.keys(p.manifest.entryPoints).join(", ")],
                                [t("huds.permissions"), p.manifest.permissions.join(", ")],
                                [t("huds.installed"), fmtTime(p.installedAt)],
                                [t("huds.files"), p.classification === "builtin" ? t("huds.appBuild") : t("huds.countFilesHashed", { count: Object.keys(p.checksums).length })],
                              ]}
                            />
                          </Details>
                        </td>
                        <td>
                          {p.manifest.version}
                          {p.previous ? <div className="small muted">{t("huds.previousVersion", { version: p.previous.version })}</div> : null}
                        </td>
                        <td>
                          {p.verify.ok ? (
                            <span className="small text-ok">{t("huds.verified")}</span>
                          ) : (
                            <Badge tone="danger" icon="!" title={p.verify.mismatches.join(", ")}>{t("huds.countChanged", { count: p.verify.mismatches.length })}</Badge>
                          )}
                        </td>
                        <td>
                          <div className="cell-actions">
                            <ActionButton size="sm" action={() => api.post<HudPackage>(`/api/v1/hud/packages/${seg(p.id)}/rollback`)} success={(r) => t("huds.rolledBackToVersion", { version: r.manifest.version })} onDone={() => void pk.reload()} disabledReason={reason ?? (p.previous ? null : t("huds.noPreviousVersionInstalled"))} confirm={{ title: t("huds.rollBackNameToVersion", { name: p.manifest.name, version: p.previous?.version }), body: t("huds.outputsUsingThisPackageSwitch") }}>{t("huds.rollBack")}</ActionButton>
                            <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/hud/packages/${seg(p.id)}`)} success={t("huds.packageRemoved")} onDone={() => void pk.reload()} disabledReason={reason ?? (p.classification === "builtin" ? t("huds.builtInPackagesCannotBe") : null)} confirm={{ title: t("huds.removeName", { name: p.manifest.name }), body: t("huds.refusedByTheEngineWhile"), danger: true, confirmLabel: t("huds.remove") }}>{t("huds.remove")}</ActionButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Panel>
      <Panel title={t("huds.importAPackage")} subtitle={t("huds.validatedBeforeInstallAFailed")}>
        <div className="grid-2">
          <div className="row-end">
            <Field label={t("huds.archiveZipUpToMax", { MAX_UPLOAD: fmtBytes(MAX_UPLOAD) })}>
              <input ref={fileRef} type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <ActionButton
              variant="primary"
              action={async () => {
                if (!file) throw new Error(t("huds.chooseAZipFile"));
                return api.upload<HudPackage>("/api/v1/hud/packages/import", await file.arrayBuffer(), "application/zip");
              }}
              success={(p) => `Installed ${p.manifest.name} ${p.manifest.version}`}
              onDone={() => {
                setFile(null);
                if (fileRef.current) fileRef.current.value = "";
                void pk.reload();
              }}
              disabledReason={reason ?? (!file ? t("huds.chooseAZipFile") : file.size > MAX_UPLOAD ? t("huds.archiveIsSizeImportIt", { size: fmtBytes(file.size) }) : null)}
            >{t("huds.importArchive")}</ActionButton>
          </div>
          <div className="row-end">
            <Field label={t("huds.orADirectoryOnThe")}>
              <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder={t("huds.dHudsMyHud")} style={{ width: 300 }} />
            </Field>
            <ActionButton action={() => api.post<HudPackage>("/api/v1/hud/packages/import-directory", { path: dir.trim() })} success={(p) => `Installed ${p.manifest.name} ${p.manifest.version}`} onDone={() => void pk.reload()} disabledReason={reason ?? (dir.trim() ? null : t("huds.enterADirectoryPath"))}>{t("huds.importDirectory")}</ActionButton>
          </div>
        </div>
        <Details summary={t("huds.whatAPackageCanContain")}>
          <p className="small muted">{t("huds.hudPackagesAreStaticWeb", { MAX_UPLOAD: fmtBytes(MAX_UPLOAD) })}</p>
        </Details>
      </Panel>
    </div>
  );
}
