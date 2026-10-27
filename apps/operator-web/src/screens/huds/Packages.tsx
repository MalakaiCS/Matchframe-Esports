import { useRef, useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { HudPackage } from "../../api/types.ts";
import { ActionButton, Async, Badge, EmptyState, Field, Note, Panel } from "../../components/ui.tsx";
import { fmtBytes, fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

/** The engine's default request body limit; larger archives must be imported from a directory. */
/** Engine limit for HUD archive uploads (POST /api/v1/hud/packages/import). */
const MAX_UPLOAD = 60 * 1024 * 1024;

export function PackagesTab() {
  const pk = useApi<HudPackage[]>("/api/v1/hud/packages");
  const reason = usePermission("hud.publish");
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dir, setDir] = useState("");
  return (
    <div className="stack">
      <div className="grid-2">
        <Panel title="Import a package archive (.zip)" subtitle="Validated before install; a failed import never touches the installed version">
          <div className="row-end">
            <Field label="Archive" hint={`Max ${fmtBytes(MAX_UPLOAD)} via upload (engine archive limit)`}>
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
        </Panel>
        <Panel title="Import from a directory" subtitle="Path on the engine machine (symlinks are rejected)">
          <div className="row-end">
            <Field label="Directory">
              <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="D:\HUDs\my-hud" style={{ width: 340 }} />
            </Field>
            <ActionButton action={() => api.post<HudPackage>("/api/v1/hud/packages/import-directory", { path: dir.trim() })} success={(p) => `Installed ${p.manifest.name} ${p.manifest.version}`} onDone={() => void pk.reload()} disabledReason={reason ?? (dir.trim() ? null : "Enter a directory path")}>
              Import directory
            </ActionButton>
          </div>
        </Panel>
      </div>
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
                      <th>Author / licence</th>
                      <th>Type</th>
                      <th>Integrity</th>
                      <th>Variants</th>
                      <th>Permissions</th>
                      <th>Installed</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.manifest.name}</strong>
                          <div className="muted small mono">{p.id}</div>
                          {p.manifest.description ? <div className="small muted">{p.manifest.description}</div> : null}
                        </td>
                        <td>
                          {p.manifest.version}
                          {p.previous ? <div className="small muted">previous {p.previous.version}</div> : null}
                        </td>
                        <td>
                          {p.manifest.author}
                          <div className="small muted">{p.manifest.licence}</div>
                        </td>
                        <td>{p.classification === "builtin" ? <Badge tone="accent">BUILT-IN</Badge> : <Badge>IMPORTED</Badge>}</td>
                        <td>
                          {p.verify.ok ? (
                            <Badge tone="ok" icon="✓">
                              VERIFIED
                            </Badge>
                          ) : (
                            <Badge tone="danger" icon="!" title={p.verify.mismatches.join(", ")}>
                              {p.verify.mismatches.length} CHANGED
                            </Badge>
                          )}
                          <div className="small muted">{p.classification === "builtin" ? "app build" : `${Object.keys(p.checksums).length} files hashed`}</div>
                        </td>
                        <td className="small">{Object.keys(p.manifest.entryPoints).join(", ")}</td>
                        <td className="small">{p.manifest.permissions.join(", ")}</td>
                        <td className="small">{fmtTime(p.installedAt)}</td>
                        <td>
                          <div className="cell-actions">
                            <ActionButton size="sm" action={() => api.post<HudPackage>(`/api/v1/hud/packages/${seg(p.id)}/rollback`)} success={(r) => `Rolled back to ${r.manifest.version}`} onDone={() => void pk.reload()} disabledReason={reason ?? (p.previous ? null : "No previous version installed")} reasonPlacement="tooltip" confirm={{ title: `Roll back ${p.manifest.name} to ${p.previous?.version}?`, body: "Outputs using this package switch to the previous version immediately." }}>
                              Roll back
                            </ActionButton>
                            <ActionButton size="sm" variant="danger" action={() => api.del(`/api/v1/hud/packages/${seg(p.id)}`)} success="Package removed" onDone={() => void pk.reload()} disabledReason={reason ?? (p.classification === "builtin" ? "Built-in packages cannot be removed" : null)} reasonPlacement="tooltip" confirm={{ title: `Remove ${p.manifest.name}?`, body: "Refused by the engine while a published output uses it.", danger: true, confirmLabel: "Remove" }}>
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
      <Note tone="neutral" title="PACKAGES">
        HUD packages are static web assets (HTML/JS/CSS/images/fonts). Nothing is executed during install; executables and scripts outside the allow-list are rejected. Packages receive only the public HUD state.
      </Note>
    </div>
  );
}
