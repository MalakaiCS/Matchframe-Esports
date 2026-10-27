import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { AutomationRule, RuleExecution, Sponsor, SponsorDelivery } from "../api/types.ts";
import { assetUrl, uploadAsset } from "../components/AssetUpload.tsx";
import { useToast } from "../components/toasts.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, Details, EmptyState, Field, JsonEditor, KV, Modal, Panel, parseJsonOr, Tabs } from "../components/ui.tsx";
import { describeError } from "../api/index.ts";
import { fmtMs, fmtTime } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-b.css";

const ZONES = [
  { id: "top_bar", label: "Top bar" },
  { id: "bottom_left", label: "Bottom left" },
  { id: "bottom_right", label: "Bottom right" },
  { id: "scoreboard_slot", label: "Scoreboard slot" },
  { id: "break_fullscreen", label: "Break fullscreen" },
  { id: "result_banner", label: "Result banner" },
] as const;

export const TRIGGERS = ["round_phase", "round_end", "bomb_state", "player_died", "kills_increased", "probable_kill_link", "game_phase", "observer_changed", "epoch_changed", "map_end", "utility_activated", "source_stale", "source_recovered", "timeout_called"] as const;
const ACTION_KINDS = ["hud_cue", "hud_variant", "obs_scene", "obs_source_visibility", "sponsor_show", "replay_bookmark", "alert"] as const;
const PROGRAM_MODES = ["LIVE", "REPLAY_PREPARED", "REPLAY_PLAYING", "STUDIO", "BREAK", "MANUAL", "DEGRADED"];

type SponsorDraft = Omit<Sponsor, "id">;
const EMPTY_SPONSOR: SponsorDraft = { name: "", assetIds: [], placements: [], displaySeconds: 10, weight: 1, active: true };

function SponsorForm({ initial, sponsorId, onSaved, onCancel }: { initial: SponsorDraft; sponsorId?: string; onSaved: () => void; onCancel?: () => void }) {
  const reason = usePermission("metadata.write");
  const toast = useToast();
  const [d, setD] = useState<SponsorDraft>(initial);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<SponsorDraft>) => setD({ ...d, ...p });
  return (
    <>
      <div className="form-grid">
        <Field label="Sponsor name">
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Display seconds">
          <input type="number" min={1} value={d.displaySeconds} onChange={(e) => set({ displaySeconds: Number(e.target.value) })} />
        </Field>
        <Field label="Rotation weight" hint="Relative share of airtime">
          <input type="number" min={0.1} step={0.1} value={d.weight} onChange={(e) => set({ weight: Number(e.target.value) })} />
        </Field>
      </div>
      <fieldset style={{ marginTop: 10 }}>
        <legend>Placements</legend>
        <div className="row">
          {ZONES.map((z) => (
            <Checkbox key={z.id} checked={d.placements.includes(z.id)} onChange={(v) => set({ placements: v ? [...d.placements, z.id] : d.placements.filter((x) => x !== z.id) })} label={z.label} />
          ))}
        </div>
        <span className="field-hint">Hidden during critical moments (such as a planted bomb) and on clean-feed outputs.</span>
      </fieldset>
      <fieldset>
        <legend>Media ({d.assetIds.length})</legend>
        <div className="row">
          {d.assetIds.map((id) => (
            <span key={id} className="pill">
              {/\.(webm|mp4)$/i.test(id) ? <span className="mono small">{id.slice(0, 10)}…</span> : <img className="thumb" src={assetUrl(id)!} alt="" />}
              <button aria-label="Remove media" onClick={() => set({ assetIds: d.assetIds.filter((x) => x !== id) })}>
                ×
              </button>
            </span>
          ))}
          <label className="btn btn-sm btn-secondary" aria-disabled={busy || !!reason}>
            {busy ? "Uploading…" : "Add media"}
            <input
              type="file"
              className="sr-only"
              accept=".png,.jpg,.jpeg,.webp,.svg,.gif,.webm,.mp4"
              disabled={busy || !!reason}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setBusy(true);
                try {
                  const r = await uploadAsset(f);
                  set({ assetIds: [...d.assetIds, r.assetId] });
                } catch (err) {
                  toast.push("danger", "Upload failed", describeError(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <Checkbox checked={d.active} onChange={(v) => set({ active: v })} label="Active" />
        <ActionButton
          variant="primary"
          action={() => (sponsorId ? api.patch<Sponsor>(`/api/v1/sponsors/${seg(sponsorId)}`, d) : api.post<Sponsor>("/api/v1/sponsors", d))}
          success={(s) => (sponsorId ? `${s.name} saved` : `${s.name} added`)}
          onDone={() => {
            if (!sponsorId) setD(EMPTY_SPONSOR);
            onSaved();
          }}
          disabledReason={reason ?? (!d.name.trim() ? "Enter a name" : d.placements.length === 0 ? "Choose at least one placement" : null)}
        >
          {sponsorId ? "Save sponsor" : "Add sponsor"}
        </ActionButton>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </>
  );
}

function SponsorsTab() {
  const sponsors = useApi<Sponsor[]>("/api/v1/sponsors");
  const deliveries = useApi<SponsorDelivery[]>("/api/v1/sponsors/deliveries", { refreshMs: 10000 });
  const reason = usePermission("metadata.write");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const name = (id: string) => sponsors.data?.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="stack">
      <Panel
        title="Sponsors"
        subtitle="Active sponsors rotate by weight"
        actions={
          adding ? null : (
            <Button variant="primary" disabledReason={reason} onClick={() => setAdding(true)}>
              Add sponsor
            </Button>
          )
        }
      >
        {adding ? (
          <div className="gb-form-block">
            <h3 className="gb-section-title">New sponsor</h3>
            <SponsorForm
              initial={EMPTY_SPONSOR}
              onSaved={() => {
                setAdding(false);
                void sponsors.reload();
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : null}
        <Async state={sponsors}>
          {(list) =>
            list.length === 0 ? (
              adding ? null : <EmptyState title="No sponsors yet">Add a sponsor with its logo or media and the HUD zones it may appear in.</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Sponsor</th>
                    <th>Placements</th>
                    <th>Rotation</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) =>
                    editing === s.id ? (
                      <tr key={s.id}>
                        <td colSpan={4}>
                          <SponsorForm
                            initial={s}
                            sponsorId={s.id}
                            onSaved={() => {
                              setEditing(null);
                              void sponsors.reload();
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <tr key={s.id}>
                        <td>
                          <div className="row">
                            {s.assetIds[0] && !/\.(webm|mp4)$/i.test(s.assetIds[0]) ? <img className="thumb" src={assetUrl(s.assetIds[0])!} alt="" /> : null}
                            <strong>{s.name}</strong>
                            {s.active ? null : <span className="muted small">Inactive</span>}
                          </div>
                        </td>
                        <td className="small">{s.placements.map((p) => ZONES.find((z) => z.id === p)?.label ?? p).join(", ")}</td>
                        <td className="small">
                          {s.displaySeconds}s · weight {s.weight}
                        </td>
                        <td>
                          <div className="cell-actions">
                            <Button size="sm" onClick={() => setEditing(s.id)} disabledReason={reason}>
                              Edit
                            </Button>
                            <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/sponsors/${seg(s.id)}`)} success={`${s.name} deleted`} onDone={() => void sponsors.reload()} disabledReason={reason} confirm={{ title: `Delete ${s.name}?`, danger: true, confirmLabel: "Delete" }}>
                              Delete
                            </ActionButton>
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )
          }
        </Async>
      </Panel>
      <Panel title="Delivery log" subtitle="Displays confirmed by the browser sources, not just scheduled">
        <Async state={deliveries}>
          {(list) =>
            list.length === 0 ? (
              <p className="muted small">No confirmed displays yet. Each time a HUD output shows a sponsor, it reports back here.</p>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Sponsor</th>
                    <th>Output</th>
                    <th>Zone</th>
                    <th>Shown at</th>
                    <th>Duration</th>
                    <th>Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {list.slice(0, 200).map((dl, i) => (
                    <tr key={i}>
                      <td>{name(dl.sponsorId)}</td>
                      <td>{dl.outputId}</td>
                      <td>{ZONES.find((z) => z.id === dl.zone)?.label ?? dl.zone}</td>
                      <td className="small">{fmtTime(dl.shownAt)}</td>
                      <td>{fmtMs(dl.durationMs)}</td>
                      <td>{dl.acknowledged ? "Yes" : <span className="text-warn">No</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Async>
      </Panel>
    </div>
  );
}

const RULE_TEMPLATE = {
  name: "Bomb planted lower third",
  enabled: true,
  dryRun: true,
  trigger: { kind: "bomb_state", where: [{ field: "data.to", op: "eq", value: "planted" }] },
  conditions: [],
  requiredCapabilities: [],
  cooldownMs: 10000,
  debounceMs: 0,
  dedupeKey: "{eventId}",
  priority: 50,
  allowedProgramModes: ["LIVE"],
  timeline: "program",
  action: { kind: "hud_cue", params: { cue: "bomb_planted", title: "Bomb planted", durationMs: 5000 } },
  timeoutMs: 3000,
  retry: { max: 0, backoffMs: 500 },
};

function RuleEditor({ rule, onClose, onSaved }: { rule: AutomationRule | null; onClose: () => void; onSaved: () => void }) {
  const reason = usePermission("settings.manage");
  const initial = rule ? (({ id: _id, ...rest }) => rest)(rule) : RULE_TEMPLATE;
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const parsed = parseJsonOr<Record<string, unknown>>(text, {});
  return (
    <Modal
      title={rule ? `Edit rule: ${rule.name}` : "New automation rule"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <ActionButton
            variant="primary"
            action={() => {
              if (!parsed.ok) throw new Error(parsed.error);
              return rule ? api.patch(`/api/v1/automation/rules/${seg(rule.id)}`, parsed.value) : api.post("/api/v1/automation/rules", parsed.value);
            }}
            success={rule ? "Rule saved" : "Rule created"}
            onDone={() => {
              onSaved();
              onClose();
            }}
            disabledReason={reason ?? (parsed.ok ? null : "Invalid JSON")}
          >
            {rule ? "Save rule" : "Create rule"}
          </ActionButton>
        </>
      }
    >
      <p className="small muted">New rules start in dry run. Check them with the event simulator before going live.</p>
      <JsonEditor label="Rule" value={text} onChange={setText} rows={22} />
      <Details summary="Reference">
        <KV
          items={[
            ["Triggers", TRIGGERS.join(", ")],
            ["Actions", ACTION_KINDS.join(", ")],
            [
              "Conditions",
              <span key="c">
                <code>{"{field, op: eq|neq|gte|lte|in|exists, value}"}</code> on the event (<code>data.*</code>)
              </span>,
            ],
            ["Program modes", PROGRAM_MODES.join(", ")],
          ]}
        />
      </Details>
    </Modal>
  );
}

function AutomationTab() {
  const rules = useApi<AutomationRule[]>("/api/v1/automation/rules");
  const log = useApi<RuleExecution[]>("/api/v1/automation/log", { refreshMs: 3000 });
  const reason = usePermission("settings.manage");
  const toast = useToast();
  const [editing, setEditing] = useState<AutomationRule | "new" | null>(null);
  const [simKind, setSimKind] = useState<string>("bomb_state");
  const [simData, setSimData] = useState('{"to": "planted", "site": "A"}');
  const [simMode, setSimMode] = useState("");
  const [simResult, setSimResult] = useState<RuleExecution[] | null>(null);
  const simParsed = parseJsonOr<Record<string, unknown>>(simData, {});
  const ruleName = (id: string) => rules.data?.find((r) => r.id === id)?.name ?? id;
  const patch = async (r: AutomationRule, body: Partial<AutomationRule>, msg: string) => {
    try {
      await api.patch(`/api/v1/automation/rules/${seg(r.id)}`, body);
      toast.push("ok", msg);
      await rules.reload();
    } catch (e) {
      toast.push("danger", "Rule update failed", describeError(e));
    }
  };
  return (
    <div className="stack">
      <Panel
        title="Rules"
        subtitle="Rules react to new game events; past events are never replayed"
        actions={
          <Button variant="primary" disabledReason={reason} onClick={() => setEditing("new")}>
            New rule
          </Button>
        }
      >
        <Async state={rules}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No rules">Create a rule, such as showing a cue when the bomb is planted. Start in dry run.</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Trigger</th>
                    <th>Action</th>
                    <th>Enabled</th>
                    <th>Dry run</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                        <Details summary="Details">
                          <KV
                            items={[
                              ["Conditions", r.trigger.where.length ? r.trigger.where.map((w) => `${w.field} ${w.op} ${JSON.stringify(w.value ?? "")}`).join(" & ") : "None"],
                              ["Parameters", <span key="p" className="mono small">{JSON.stringify(r.action.params)}</span>],
                              ["Program modes", r.allowedProgramModes.join(", ")],
                              ["Priority", r.priority],
                              ["Cooldown", fmtMs(r.cooldownMs)],
                              ["Timeline", r.timeline],
                            ]}
                          />
                        </Details>
                      </td>
                      <td className="small">{r.trigger.kind}</td>
                      <td className="small">{r.action.kind}</td>
                      <td className="gb-nowrap">
                        <Checkbox checked={r.enabled} disabled={!!reason} onChange={(v) => void patch(r, { enabled: v }, `${r.name} ${v ? "enabled" : "disabled"}`)} label={r.enabled ? "On" : "Off"} />
                      </td>
                      <td className="gb-nowrap">
                        <Checkbox checked={r.dryRun} disabled={!!reason} onChange={(v) => void patch(r, { dryRun: v }, `${r.name}: dry run ${v ? "on" : "off (actions execute)"}`)} label={r.dryRun ? "Dry run" : "Live"} />
                      </td>
                      <td>
                        <div className="cell-actions">
                          <Button size="sm" disabledReason={reason} onClick={() => setEditing(r)}>
                            Edit
                          </Button>
                          <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/automation/rules/${seg(r.id)}`)} success="Rule deleted" onDone={() => void rules.reload()} disabledReason={reason} confirm={{ title: `Delete rule “${r.name}”?`, danger: true, confirmLabel: "Delete" }}>
                            Delete
                          </ActionButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Async>
      </Panel>
      <div className="grid-2">
        <Panel title="Event simulator" subtitle="Send a test event through the rules to see what fires">
          <div className="form-grid">
            <Field label="Event kind">
              <select value={simKind} onChange={(e) => setSimKind(e.target.value)}>
                {TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Program mode">
              <select value={simMode} onChange={(e) => setSimMode(e.target.value)}>
                <option value="">Current</option>
                {PROGRAM_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <JsonEditor label="Event data" value={simData} onChange={setSimData} rows={4} />
          <div className="form-actions">
            <ActionButton
              variant="primary"
              action={() => api.post<RuleExecution[]>("/api/v1/automation/simulate", { kind: simKind, data: simParsed.ok ? simParsed.value : {}, ...(simMode ? { programMode: simMode } : {}) })}
              success={(r) => `${r.length} rule execution(s)`}
              onDone={setSimResult}
              disabledReason={reason ?? (simParsed.ok ? null : "Invalid JSON")}
            >
              Simulate event
            </ActionButton>
          </div>
          <p className="small text-warn">Enabled rules that are not in dry run execute their real action.</p>
          {simResult ? (
            simResult.length === 0 ? (
              <p className="muted small">No rule matched this event.</p>
            ) : (
              <ul className="list-plain small">
                {simResult.map((x, i) => (
                  <li key={i}>
                    <Badge tone={x.status === "executed" ? "ok" : x.status === "dry_run" ? "info" : x.status === "failed" ? "danger" : "neutral"}>{x.status}</Badge> {ruleName(x.ruleId)} → {x.action.kind} {x.reason ? <span className="muted">({x.reason})</span> : null}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </Panel>
        <Panel title="Rule log" subtitle="Newest first" className="gb-start">
          <Async state={log}>
            {(list) =>
              list.length === 0 ? (
                <p className="muted small">No executions yet.</p>
              ) : (
                <div style={{ maxHeight: 420, overflowY: "auto" }}>
                  <table className="table table-compact">
                    <tbody>
                      {[...list].reverse().map((x, i) => (
                        <tr key={i}>
                          <td>
                            <Badge tone={x.status === "executed" ? "ok" : x.status === "dry_run" ? "info" : x.status === "failed" ? "danger" : "neutral"}>{x.status}</Badge>
                          </td>
                          <td className="small" title={`Event ${x.eventId}`}>
                            {ruleName(x.ruleId)} → {x.action.kind}
                            {x.reason || x.attempts > 1 ? (
                              <div className="muted">
                                {x.reason ?? ""} {x.attempts > 1 ? `· ${x.attempts} attempts` : ""}
                              </div>
                            ) : null}
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
      </div>
      {editing ? <RuleEditor rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void rules.reload()} /> : null}
    </div>
  );
}

export function SponsorsScreen() {
  const [tab, setTab] = usePersistentState<"sponsors" | "automation">("sponsorsTab", "sponsors");
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Sponsors &amp; Automation</h1>
      </div>
      <Tabs
        label="Sponsors and automation"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "sponsors", label: "Sponsors" },
          { id: "automation", label: "Automation rules" },
        ]}
      />
      {tab === "sponsors" ? <SponsorsTab /> : <AutomationTab />}
    </div>
  );
}
