import { useEffect, useState } from "react";
import type { HudState } from "@matchframe/hud-sdk";
import { api, seg } from "../../api/index.ts";
import type { HudOutputEntry, HudPackage, MatchRow, OutputDraft, PublishedOutput } from "../../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, CopyButton, EmptyState, Field, JsonEditor, KV, Note, Panel, parseJsonOr } from "../../components/ui.tsx";
import { fmtMs, fmtTime, MISSING } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

export const HUD_VARIANTS = ["live", "compact", "replay", "veto", "pre-match", "break", "post-map", "post-series", "studio"] as const;
const PROFILES = [
  { id: "program", label: "Program (full)" },
  { id: "clean", label: "Clean (no sponsors/cues)" },
  { id: "caster", label: "Caster" },
  { id: "preview", label: "Preview" },
] as const;

export function previewUrl(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + "preview=1";
}

function PublicStatePreview({ outputId }: { outputId: string }) {
  const st = useApi<HudState | null>(`/api/v1/hud/outputs/${seg(outputId)}/state`, { refreshMs: 2000 });
  return (
    <Async state={st}>
      {(h) =>
        !h ? (
          <p className="muted small">Not published — no public state.</p>
        ) : (
          <KV
            items={[
              ["Source", h.simulated ? <Badge key="s" tone="sim">SIMULATION</Badge> : "live"],
              ["Data", h.stale ? <Badge key="d" tone="danger">STALE</Badge> : `age ${fmtMs(h.dataAgeMs)}`],
              ["Timeline", `${h.timeline.profile}${h.timeline.profile === "delayed" ? ` (${fmtMs(h.timeline.delayMs)})` : ""}`],
              ["Match", `${h.match.mapDisplayName ?? h.match.mapName ?? MISSING} · round ${h.match.roundNumber ?? MISSING} · ${h.match.phase}`],
              ["Teams", `${h.left.name} ${h.left.score ?? MISSING} – ${h.right.score ?? MISSING} ${h.right.name}`],
              ["Observed", h.observed?.name ?? "none"],
              ["Radar", h.radar.available ? `${h.radar.mode}${h.radar.calibrationVerified ? " (verified)" : ""}` : `unavailable — ${h.radar.reason ?? "?"}`],
              ["Killfeed", `${h.killfeed.mode} (${h.killfeed.entries.length})`],
              ["Cues / annotations", `${h.cues.length} / ${h.annotations.length}`],
            ]}
          />
        )
      }
    </Async>
  );
}

function DraftEditor({ entry, packages, matches, onSaved }: { entry: HudOutputEntry; packages: HudPackage[]; matches: MatchRow[]; onSaved: () => void }) {
  const reason = usePermission("hud.publish");
  const [d, setD] = useState<OutputDraft>(entry.draft);
  const [settingsText, setSettingsText] = useState(JSON.stringify(entry.draft.settings, null, 2));
  useEffect(() => {
    setD(entry.draft);
    setSettingsText(JSON.stringify(entry.draft.settings, null, 2));
  }, [entry.draft]);
  const pkg = packages.find((p) => p.id === d.packageId);
  const presets = pkg?.manifest.presets.length ? pkg.manifest.presets : [{ id: "classic", name: "Classic" }, { id: "minimal", name: "Minimal" }, { id: "arena", name: "Arena" }];
  const variants = pkg ? HUD_VARIANTS.filter((v) => v in pkg.manifest.entryPoints) : [...HUD_VARIANTS];
  const parsed = parseJsonOr<Record<string, unknown>>(settingsText, {});
  const set = (patch: Partial<OutputDraft>) => setD({ ...d, ...patch });
  return (
    <>
      <div className="form-grid">
        <Field label="Name">
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="HUD package">
          <select value={d.packageId} onChange={(e) => set({ packageId: e.target.value })}>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.manifest.name} {p.manifest.version}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Variant">
          <select value={d.variant} onChange={(e) => set({ variant: e.target.value as OutputDraft["variant"] })}>
            {variants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Preset">
          <select value={d.presetId ?? ""} onChange={(e) => set({ presetId: e.target.value || null })}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Profile">
          <select value={d.profile} onChange={(e) => set({ profile: e.target.value as OutputDraft["profile"] })}>
            {PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeline" hint="Delayed outputs never show data ahead of the delayed program">
          <select value={d.timelineProfile} onChange={(e) => set({ timelineProfile: e.target.value as OutputDraft["timelineProfile"] })}>
            <option value="live">Live</option>
            <option value="delayed">Delayed</option>
          </select>
        </Field>
        <Field label="Delay (ms)">
          <input type="number" min={0} step={500} value={d.delayMs} disabled={d.timelineProfile !== "delayed"} onChange={(e) => set({ delayMs: Number(e.target.value) })} />
        </Field>
        <Field label="Match binding">
          <select value={d.matchId ?? ""} onChange={(e) => set({ matchId: e.target.value || null })}>
            <option value="">active match</option>
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title ?? m.id}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <JsonEditor label="Output settings (passed to the HUD as state.settings)" value={settingsText} onChange={setSettingsText} rows={6} />
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() => {
            if (!parsed.ok) throw new Error(`Settings JSON is invalid: ${parsed.error}`);
            const { id: _id, outputId: _o, publishedRevision: _p, ...rest } = d;
            return api.patch(`/api/v1/hud/outputs/${seg(d.outputId)}`, { ...rest, settings: parsed.value });
          }}
          success="Draft saved (not on air until published)"
          onDone={onSaved}
          disabledReason={reason ?? (parsed.ok ? null : "Fix the settings JSON first")}
        >
          Save draft
        </ActionButton>
        <span className="small muted">Draft edits never change what is on air until you publish.</span>
      </div>
    </>
  );
}

function OutputDetail({ entry, packages, matches, reload }: { entry: HudOutputEntry; packages: HudPackage[]; matches: MatchRow[]; reload: () => void }) {
  const reason = usePermission("hud.publish");
  const [rollbackTo, setRollbackTo] = useState<string>("");
  const [showFrame, setShowFrame] = useState(true);
  const [frameKey, setFrameKey] = useState(0);
  const pub = entry.published;
  const id = entry.draft.outputId;
  return (
    <div className="stack">
      <Panel
        title={`${entry.draft.name} · ${id}`}
        subtitle={pub ? `Published revision ${pub.revision} · ${fmtTime(pub.publishedAt)} by ${pub.publishedBy}` : "Never published"}
        actions={
          <>
            {entry.dirty ? <Badge tone="warn">DRAFT DIFFERS FROM ON-AIR</Badge> : <Badge tone="ok">DRAFT = PUBLISHED</Badge>}
            <ActionButton
              variant="primary"
              action={() => api.post<PublishedOutput>(`/api/v1/hud/outputs/${seg(id)}/publish`)}
              success={(p) => `Published revision ${p.revision} — on air now`}
              onDone={() => {
                reload();
                setFrameKey((k) => k + 1);
              }}
              disabledReason={reason ?? (entry.dirty ? null : "Nothing to publish: the draft matches the published revision")}
              confirm={{ title: `Publish “${entry.draft.name}”?`, body: "The browser source switches to this draft immediately. You can roll back to any earlier revision." }}
            >
              Publish draft
            </ActionButton>
          </>
        }
      >
        <div className="url-box">
          <input readOnly value={entry.url} aria-label="Output URL" onFocus={(e) => e.target.select()} />
          <CopyButton text={entry.url} label="Copy URL" size="md" />
          <ActionButton
            variant="warn"
            action={() => api.post<{ url: string }>(`/api/v1/hud/outputs/${seg(id)}/rotate-token`)}
            success="Token rotated — update the OBS browser source with the new URL"
            onDone={reload}
            disabledReason={reason}
            confirm={{ title: "Rotate this output's token?", body: "Existing browser sources using the old URL stop receiving data immediately. Copy the new URL into OBS afterwards.", confirmLabel: "Rotate token", danger: true }}
          >
            Rotate token
          </ActionButton>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Field label="Rollback to revision">
            <select value={rollbackTo} onChange={(e) => setRollbackTo(e.target.value)}>
              <option value="">choose…</option>
              {entry.revisions.map((r) => (
                <option key={r.revision} value={r.revision} disabled={r.revision === pub?.revision}>
                  r{r.revision} · {fmtTime(r.publishedAt)} · {r.publishedBy}
                  {r.revision === pub?.revision ? " (on air)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <ActionButton
            action={() => api.post<PublishedOutput>(`/api/v1/hud/outputs/${seg(id)}/rollback`, { revision: Number(rollbackTo) })}
            success={(p) => `Rolled back: revision ${rollbackTo} republished as r${p.revision}`}
            onDone={() => {
              reload();
              setFrameKey((k) => k + 1);
            }}
            disabledReason={reason ?? (rollbackTo ? null : "Choose a revision")}
            confirm={{ title: `Roll back to revision ${rollbackTo}?`, body: "Republishes that revision's content as a new revision. On air immediately." }}
          >
            Roll back
          </ActionButton>
        </div>
      </Panel>
      <div className="grid-2">
        <Panel title="Draft" subtitle="Edit, then publish">
          <DraftEditor entry={entry} packages={packages} matches={matches} onSaved={reload} />
        </Panel>
        <div className="stack">
          <Panel
            title="Live preview (published)"
            actions={
              <>
                <Checkbox checked={showFrame} onChange={setShowFrame} label="Show" />
                <button className="link-btn" onClick={() => setFrameKey((k) => k + 1)}>
                  Reload
                </button>
              </>
            }
          >
            {showFrame && pub ? (
              <div className="preview-frame">
                <iframe key={frameKey} title={`Preview of ${id}`} src={previewUrl(entry.url)} sandbox="allow-scripts allow-same-origin" />
              </div>
            ) : (
              <EmptyState title={pub ? "Preview hidden" : "Not published"}>{pub ? "Enable Show to load the browser-source page." : "Publish the draft to get an on-air revision."}</EmptyState>
            )}
            <p className="small muted">This is the published browser-source page (not the draft). If it shows a “HUD renderer build not found” message, the built-in HUD renderer has not been built on this machine.</p>
          </Panel>
          <Panel title="Public HUD state" subtitle="Exactly what the browser source receives">
            <PublicStatePreview outputId={id} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

export function OutputsTab() {
  const outputs = useApi<HudOutputEntry[]>("/api/v1/hud/outputs", { refreshMs: 10000 });
  const packages = useApi<HudPackage[]>("/api/v1/hud/packages");
  const matches = useApi<MatchRow[]>("/api/v1/matches");
  const reason = usePermission("hud.publish");
  const [selected, setSelected] = useState<string>("main");
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  return (
    <Async state={outputs}>
      {(list) => {
        const entry = list.find((o) => o.draft.outputId === selected) ?? list[0];
        return (
          <div className="grid-1-2">
            <div className="stack">
              <Panel title="Outputs" subtitle="Each output is one browser source with its own token">
                <ul className="select-list">
                  {list.map((o) => (
                    <li key={o.draft.outputId}>
                      <button className={o.draft.outputId === entry?.draft.outputId ? "is-selected" : ""} onClick={() => setSelected(o.draft.outputId)}>
                        <span style={{ flex: 1 }}>
                          <strong>{o.draft.name}</strong>
                          <span className="muted small">
                            {" "}
                            · {o.draft.outputId} · {o.draft.variant} · {o.draft.profile}
                          </span>
                        </span>
                        {o.published ? <Badge tone="ok">r{o.published.revision}</Badge> : <Badge>DRAFT</Badge>}
                        {o.dirty ? <Badge tone="warn">CHANGED</Badge> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel title="New output">
                <div className="form-grid">
                  <Field label="Output id" hint="a–z, 0–9, dash">
                    <input value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} placeholder="caster-left" />
                  </Field>
                  <Field label="Name">
                    <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Caster desk" />
                  </Field>
                </div>
                <div className="form-actions">
                  <ActionButton
                    action={() => api.post<OutputDraft>("/api/v1/hud/outputs", { outputId: newId, name: newName })}
                    success={(o) => `Output ${o.outputId} created (publish it to go on air)`}
                    onDone={(o) => {
                      setSelected(o.outputId);
                      setNewId("");
                      setNewName("");
                      void outputs.reload();
                    }}
                    disabledReason={reason ?? (/^[a-z0-9-]{2,40}$/.test(newId) && newName.trim() ? null : "Enter an id (2–40 chars a–z 0–9 -) and a name")}
                  >
                    Create output
                  </ActionButton>
                </div>
              </Panel>
              <Note tone="neutral" title="SECURITY">
                Output URLs grant read-only access to the public HUD projection for that output only — never operator telemetry, director predictions or secrets.
              </Note>
            </div>
            {entry ? <OutputDetail entry={entry} packages={packages.data ?? []} matches={matches.data ?? []} reload={() => void outputs.reload()} /> : <EmptyState title="No outputs">Create an output to get a browser-source URL.</EmptyState>}
          </div>
        );
      }}
    </Async>
  );
}
