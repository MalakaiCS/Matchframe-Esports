import { useEffect, useState } from "react";
import type { HudState } from "@matchframe/hud-sdk";
import { api, seg } from "../../api/index.ts";
import type { HudOutputEntry, HudPackage, MatchRow, OutputDraft, PublishedOutput } from "../../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, CopyButton, Details, EmptyState, Field, JsonEditor, KV, Panel, parseJsonOr } from "../../components/ui.tsx";
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
          <p className="muted small">Not published, so there is no public state yet.</p>
        ) : (
          <KV
            items={[
              ["Source", h.simulated ? "simulation" : "live"],
              ["Data", h.stale ? <Badge key="d" tone="danger">Stale</Badge> : `age ${fmtMs(h.dataAgeMs)}`],
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
        <Field label="Timeline">
          <select value={d.timelineProfile} onChange={(e) => set({ timelineProfile: e.target.value as OutputDraft["timelineProfile"] })}>
            <option value="live">Live</option>
            <option value="delayed">Delayed</option>
          </select>
        </Field>
        {d.timelineProfile === "delayed" ? (
          <Field label="Delay (ms)" hint="Never shows data ahead of the delayed program">
            <input type="number" min={0} step={500} value={d.delayMs} onChange={(e) => set({ delayMs: Number(e.target.value) })} />
          </Field>
        ) : null}
        <Field label="Match">
          <select value={d.matchId ?? ""} onChange={(e) => set({ matchId: e.target.value || null })}>
            <option value="">Active match</option>
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title ?? m.id}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Details summary="Output settings (JSON)">
        <JsonEditor label="Passed to the HUD as state.settings" value={settingsText} onChange={setSettingsText} rows={6} />
      </Details>
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
        title={entry.draft.name}
        subtitle={pub ? `Revision ${pub.revision} on air · published ${fmtTime(pub.publishedAt)} by ${pub.publishedBy}` : "Not published yet"}
        actions={
          <>
            {entry.dirty ? <Badge tone="warn">Unpublished changes</Badge> : null}
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
        </div>
        <p className="small muted">Add this URL to OBS as a browser source. It only receives this output's public HUD state.</p>
        <Details summary="Roll back to an earlier revision">
          <div className="row-end">
            <Field label="Revision">
              <select value={rollbackTo} onChange={(e) => setRollbackTo(e.target.value)}>
                <option value="">Choose…</option>
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
        </Details>
        <Details summary="Output ID and token">
          <div className="row">
            <span className="small">
              Output ID <code>{id}</code>
            </span>
            <ActionButton
              size="sm"
              action={() => api.post<{ url: string }>(`/api/v1/hud/outputs/${seg(id)}/rotate-token`)}
              success="Token rotated — update the OBS browser source with the new URL"
              onDone={reload}
              disabledReason={reason}
              confirm={{ title: "Rotate this output's token?", body: "Existing browser sources using the old URL stop receiving data immediately. Copy the new URL into OBS afterwards.", confirmLabel: "Rotate token", danger: true }}
            >
              Rotate token
            </ActionButton>
          </div>
        </Details>
      </Panel>
      <div className="grid-2">
        <Panel title="Draft" subtitle="Not on air until you publish">
          <DraftEditor entry={entry} packages={packages} matches={matches} onSaved={reload} />
        </Panel>
        <Panel
          title="On-air preview"
          className="gb-start"
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
            <EmptyState title={pub ? "Preview hidden" : "Not published"}>{pub ? "Turn on Show to load the browser-source page." : "Publish the draft to get an on-air revision."}</EmptyState>
          )}
          <p className="small muted" title="If it shows “HUD renderer build not found”, the built-in HUD renderer has not been built on this machine.">
            Shows the published revision, not the draft.
          </p>
          <Details summary="Public HUD state">
            <p className="small muted">Exactly what the browser source receives.</p>
            <PublicStatePreview outputId={id} />
          </Details>
        </Panel>
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
            <Panel title="Outputs" subtitle="One browser source each">
              <ul className="select-list">
                {list.map((o) => (
                  <li key={o.draft.outputId}>
                    <button className={o.draft.outputId === entry?.draft.outputId ? "is-selected" : ""} onClick={() => setSelected(o.draft.outputId)} title={`Output ID ${o.draft.outputId}${o.published ? ` · revision ${o.published.revision} on air` : ""}`}>
                      <span style={{ flex: 1 }}>
                        <strong>{o.draft.name}</strong>
                        <span className="muted small">
                          {" "}
                          · {o.draft.variant} · {o.draft.profile}
                        </span>
                      </span>
                      {!o.published ? <Badge>Not published</Badge> : o.dirty ? <Badge tone="warn">Changed</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <Details summary="New output">
                <div className="form-grid">
                  <Field label="Output ID" hint="a–z, 0–9, dash">
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
                    disabledReason={reason ?? (/^[a-z0-9-]{2,40}$/.test(newId) && newName.trim() ? null : "Enter an ID (2–40 characters: a–z, 0–9, dash) and a name")}
                  >
                    Create output
                  </ActionButton>
                </div>
              </Details>
            </Panel>
            {entry ? <OutputDetail entry={entry} packages={packages.data ?? []} matches={matches.data ?? []} reload={() => void outputs.reload()} /> : <EmptyState title="No outputs">Create an output to get a browser-source URL.</EmptyState>}
          </div>
        );
      }}
    </Async>
  );
}
