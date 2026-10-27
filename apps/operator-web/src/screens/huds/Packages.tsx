import { useRef, useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { HudPackage } from "../../api/types.ts";
import { ActionButton, Async, Badge, Details, EmptyState, Field, KV, Panel } from "../../components/ui.tsx";
import { fmtBytes, fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

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
      <Panel title="Installed packages">
        <Async state={pk}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No packages">The built-in Matchframe HUD registers on engine start.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Package</th>
                      <th>Version</th>
                      <th>Integrity</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.manifest.name}</strong>
                          <span className="muted small"> · {p.classification === "builtin" ? "Built-in" : "Imported"}</span>
                          {p.manifest.description ? <div className="small muted">{p.manifest.description}</div> : null}
                          <Details summary="Details">
                            <KV
                              items={[
                                ["ID", <span key="id" className="mono">{p.id}</span>],
                                ["Author", p.manifest.author],
                                ["Licence", p.manifest.licence],
                                ["Variants", Object.keys(p.manifest.entryPoints).join(", ")],
                                ["Permissions", p.manifest.permissions.join(", ")],
                                ["Installed", fmtTime(p.installedAt)],
                                ["Files", p.classification === "builtin" ? "app build" : `${Object.keys(p.checksums).length} files hashed`],
                              ]}
                            />
                          </Details>
                        </td>
                        <td>
                          {p.manifest.version}
                          {p.previous ? <div className="small muted">previous {p.previous.version}</div> : null}
                        </td>
                        <td>
                          {p.verify.ok ? (
                            <span className="small text-ok">✓ Verified</span>
                          ) : (
                            <Badge tone="danger" icon="!" title={p.verify.mismatches.join(", ")}>
                              {p.verify.mismatches.length} changed
                            </Badge>
                          )}
                        </td>
                        <td>
                          <div className="cell-actions">
                            <ActionButton size="sm" action={() => api.post<HudPackage>(`/api/v1/hud/packages/${seg(p.id)}/rollback`)} success={(r) => `Rolled back to ${r.manifest.version}`} onDone={() => void pk.reload()} disabledReason={reason ?? (p.previous ? null : "No previous version installed")} confirm={{ title: `Roll back ${p.manifest.name} to ${p.previous?.version}?`, body: "Outputs using this package switch to the previous version immediately." }}>
                              Roll back
                            </ActionButton>
                            <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/hud/packages/${seg(p.id)}`)} success="Package removed" onDone={() => void pk.reload()} disabledReason={reason ?? (p.classification === "builtin" ? "Built-in packages cannot be removed" : null)} confirm={{ title: `Remove ${p.manifest.name}?`, body: "Refused by the engine while a published output uses it.", danger: true, confirmLabel: "Remove" }}>
                              Remove
                            </ActionButton>
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
      <Panel title="Import a package" subtitle="Validated before install; a failed import leaves the installed version untouched">
        <div className="grid-2">
          <div className="row-end">
            <Field label={`Archive (.zip, up to ${fmtBytes(MAX_UPLOAD)})`}>
              <input ref={fileRef} type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <ActionButton
              variant="primary"
              action={async () => {
                if (!file) throw new Error("Choose a .zip file");
                return api.upload<HudPackage>("/api/v1/hud/packages/import", await file.arrayBuffer(), "application/zip");
              }}
              success={(p) => `Installed ${p.manifest.name} ${p.manifest.version}`}
              onDone={() => {
                setFile(null);
                if (fileRef.current) fileRef.current.value = "";
                void pk.reload();
              }}
              disabledReason={reason ?? (!file ? "Choose a .zip file" : file.size > MAX_UPLOAD ? `Archive is ${fmtBytes(file.size)}: import it from a directory instead` : null)}
            >
              Import archive
            </ActionButton>
          </div>
          <div className="row-end">
            <Field label="Or a directory on the engine machine">
              <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="D:\HUDs\my-hud" style={{ width: 300 }} />
            </Field>
            <ActionButton action={() => api.post<HudPackage>("/api/v1/hud/packages/import-directory", { path: dir.trim() })} success={(p) => `Installed ${p.manifest.name} ${p.manifest.version}`} onDone={() => void pk.reload()} disabledReason={reason ?? (dir.trim() ? null : "Enter a directory path")}>
              Import directory
            </ActionButton>
          </div>
        </div>
        <Details summary="What a package can contain">
          <p className="small muted">
            HUD packages are static web assets (HTML, JS, CSS, images, fonts). Nothing is executed during install; executables, scripts outside the allow-list and symlinks are rejected. Packages receive only the public HUD state. Archives larger than {fmtBytes(MAX_UPLOAD)} must be imported from a directory.
          </p>
        </Details>
      </Panel>
    </div>
  );
}
