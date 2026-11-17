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
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import "../styles/group-b.css";

const ZONES = perLocale(() => ([
  { id: "top_bar", label: t("sponsors.topBar") },
  { id: "bottom_left", label: t("sponsors.bottomLeft") },
  { id: "bottom_right", label: t("sponsors.bottomRight") },
  { id: "scoreboard_slot", label: t("sponsors.scoreboardSlot") },
  { id: "break_fullscreen", label: t("sponsors.breakFullscreen") },
  { id: "result_banner", label: t("sponsors.resultBanner") },
] as const));

export const TRIGGERS = ["round_phase", "round_end", "bomb_state", "player_died", "kills_increased", "probable_kill_link", "game_phase", "observer_changed", "epoch_changed", "map_end", "utility_activated", "source_stale", "source_recovered", "timeout_called"] as const;
const ACTION_KINDS = ["hud_cue", "hud_variant", "obs_scene", "obs_source_visibility", "sponsor_show", "replay_bookmark", "alert"] as const;
const PROGRAM_MODES = ["LIVE", "REPLAY_PREPARED", "REPLAY_PLAYING", "STUDIO", "BREAK", "MANUAL", "DEGRADED", "HIGHLIGHTS", "MAP_INTRO"];

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
        <Field label={t("sponsors.sponsorName")}>
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t("sponsors.displaySeconds")}>
          <input type="number" min={1} value={d.displaySeconds} onChange={(e) => set({ displaySeconds: Number(e.target.value) })} />
        </Field>
        <Field label={t("sponsors.rotationWeight")} hint={t("sponsors.relativeShareOfAirtime")}>
          <input type="number" min={0.1} step={0.1} value={d.weight} onChange={(e) => set({ weight: Number(e.target.value) })} />
        </Field>
      </div>
      <fieldset style={{ marginTop: 10 }}>
        <legend>{t("sponsors.placements")}</legend>
        <div className="row">
          {ZONES.map((z) => (
            <Checkbox key={z.id} checked={d.placements.includes(z.id)} onChange={(v) => set({ placements: v ? [...d.placements, z.id] : d.placements.filter((x) => x !== z.id) })} label={z.label} />
          ))}
        </div>
        <span className="field-hint">{t("sponsors.hiddenDuringCriticalMomentsSuch")}</span>
      </fieldset>
      <fieldset>
        <legend>{t("sponsors.mediaCount", { count: d.assetIds.length })}</legend>
        <div className="row">
          {d.assetIds.map((id) => (
            <span key={id} className="pill">
              {/\.(webm|mp4)$/i.test(id) ? <span className="mono small">{id.slice(0, 10)}…</span> : <img className="thumb" src={assetUrl(id)!} alt="" />}
              <button aria-label={t("sponsors.removeMedia")} onClick={() => set({ assetIds: d.assetIds.filter((x) => x !== id) })}>
                ×
              </button>
            </span>
          ))}
          <label className="btn btn-sm btn-secondary" aria-disabled={busy || !!reason}>
            {busy ? t("sponsors.uploading") : t("sponsors.addMedia")}
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
                  toast.push("danger", t("sponsors.uploadFailed"), describeError(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <Checkbox checked={d.active} onChange={(v) => set({ active: v })} label={t("sponsors.active")} />
        <ActionButton
          variant="primary"
          action={() => (sponsorId ? api.patch<Sponsor>(`/api/v1/sponsors/${seg(sponsorId)}`, d) : api.post<Sponsor>("/api/v1/sponsors", d))}
          success={(s) => (sponsorId ? `${s.name} saved` : `${s.name} added`)}
          onDone={() => {
            if (!sponsorId) setD(EMPTY_SPONSOR);
            onSaved();
          }}
          disabledReason={reason ?? (!d.name.trim() ? t("sponsors.enterAName") : d.placements.length === 0 ? t("sponsors.chooseAtLeastOnePlacement") : null)}
        >
          {sponsorId ? t("sponsors.saveSponsor") : t("sponsors.addSponsor")}
        </ActionButton>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
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
        title={t("sponsors.sponsors")}
        subtitle={t("sponsors.activeSponsorsRotateByWeight")}
        actions={
          adding ? null : (
            <Button variant="primary" disabledReason={reason} onClick={() => setAdding(true)}>{t("sponsors.addSponsor")}</Button>
          )
        }
      >
        {adding ? (
          <div className="gb-form-block">
            <h3 className="gb-section-title">{t("sponsors.newSponsor")}</h3>
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
              adding ? null : <EmptyState title={t("sponsors.noSponsorsYet")}>{t("sponsors.addASponsorWithIts")}</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t("sponsors.sponsor")}</th>
                    <th>{t("sponsors.placements")}</th>
                    <th>{t("sponsors.rotation")}</th>
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
                            {s.active ? null : <span className="muted small">{t("sponsors.inactive")}</span>}
                          </div>
                        </td>
                        <td className="small">{s.placements.map((p) => ZONES.find((z) => z.id === p)?.label ?? p).join(", ")}</td>
                        <td className="small">{t("sponsors.displaysecondsSWeightWeight", { displaySeconds: s.displaySeconds, weight: s.weight })}</td>
                        <td>
                          <div className="cell-actions">
                            <Button size="sm" onClick={() => setEditing(s.id)} disabledReason={reason}>{t("sponsors.edit")}</Button>
                            <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/sponsors/${seg(s.id)}`)} success={t("sponsors.nameDeleted", { name: s.name })} onDone={() => void sponsors.reload()} disabledReason={reason} confirm={{ title: t("sponsors.deleteName", { name: s.name }), danger: true, confirmLabel: t("sponsors.delete") }}>{t("sponsors.delete")}</ActionButton>
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
      <Panel title={t("sponsors.deliveryLog")} subtitle={t("sponsors.displaysConfirmedByTheBrowser")}>
        <Async state={deliveries}>
          {(list) =>
            list.length === 0 ? (
              <p className="muted small">{t("sponsors.noConfirmedDisplaysYetEach")}</p>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t("sponsors.sponsor")}</th>
                    <th>{t("sponsors.output")}</th>
                    <th>{t("sponsors.zone")}</th>
                    <th>{t("sponsors.shownAt")}</th>
                    <th>{t("sponsors.duration")}</th>
                    <th>{t("sponsors.confirmed")}</th>
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
                      <td>{dl.acknowledged ? t("sponsors.yes") : <span className="text-warn">{t("sponsors.no")}</span>}</td>
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

const RULE_TEMPLATE = perLocale(() => ({
  name: t("sponsors.bombPlantedLowerThird"),
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
  action: { kind: "hud_cue", params: { cue: "bomb_planted", title: t("sponsors.bombPlanted"), durationMs: 5000 } },
  timeoutMs: 3000,
  retry: { max: 0, backoffMs: 500 },
}));

function RuleEditor({ rule, onClose, onSaved }: { rule: AutomationRule | null; onClose: () => void; onSaved: () => void }) {
  const reason = usePermission("settings.manage");
  const initial = rule ? (({ id: _id, ...rest }) => rest)(rule) : RULE_TEMPLATE;
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const parsed = parseJsonOr<Record<string, unknown>>(text, {});
  return (
    <Modal
      title={rule ? t("sponsors.editRuleName", { name: rule.name }) : t("sponsors.newAutomationRule")}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <ActionButton
            variant="primary"
            action={() => {
              if (!parsed.ok) throw new Error(parsed.error);
              return rule ? api.patch(`/api/v1/automation/rules/${seg(rule.id)}`, parsed.value) : api.post("/api/v1/automation/rules", parsed.value);
            }}
            success={rule ? t("sponsors.ruleSaved") : t("sponsors.ruleCreated")}
            onDone={() => {
              onSaved();
              onClose();
            }}
            disabledReason={reason ?? (parsed.ok ? null : t("sponsors.invalidJson"))}
          >
            {rule ? t("sponsors.saveRule") : t("sponsors.createRule")}
          </ActionButton>
        </>
      }
    >
      <p className="small muted">{t("sponsors.newRulesStartInDry")}</p>
      <JsonEditor label={t("sponsors.rule")} value={text} onChange={setText} rows={22} />
      <Details summary={t("sponsors.reference")}>
        <KV
          items={[
            [t("sponsors.triggers"), TRIGGERS.join(", ")],
            [t("sponsors.actions"), ACTION_KINDS.join(", ")],
            [
              t("sponsors.conditions"),
              <span key="c"><T k="sponsors.codeOnTheEventData" values={{ code: <code>{"{field, op: eq|neq|gte|lte|in|exists, value}"}</code> }} tags={{ code: (c) => <code>{c}</code> }} /></span>,
            ],
            [t("sponsors.programModes"), PROGRAM_MODES.join(", ")],
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
      toast.push("danger", t("sponsors.ruleUpdateFailed"), describeError(e));
    }
  };
  return (
    <div className="stack">
      <Panel
        title={t("sponsors.rules")}
        subtitle={t("sponsors.rulesReactToNewGame")}
        actions={
          <Button variant="primary" disabledReason={reason} onClick={() => setEditing("new")}>{t("sponsors.newRule")}</Button>
        }
      >
        <Async state={rules}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title={t("sponsors.noRules")}>{t("sponsors.createARuleSuchAs")}</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t("sponsors.rule")}</th>
                    <th>{t("sponsors.trigger")}</th>
                    <th>{t("sponsors.action")}</th>
                    <th>{t("sponsors.enabled")}</th>
                    <th>{t("sponsors.dryRun")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                        <Details summary={t("common.details")}>
                          <KV
                            items={[
                              [t("sponsors.conditions"), r.trigger.where.length ? r.trigger.where.map((w) => `${w.field} ${w.op} ${JSON.stringify(w.value ?? "")}`).join(" & ") : t("sponsors.none")],
                              [t("sponsors.parameters"), <span key="p" className="mono small">{JSON.stringify(r.action.params)}</span>],
                              [t("sponsors.programModes"), r.allowedProgramModes.join(", ")],
                              [t("sponsors.priority"), r.priority],
                              [t("sponsors.cooldown"), fmtMs(r.cooldownMs)],
                              [t("sponsors.timeline"), r.timeline],
                            ]}
                          />
                        </Details>
                      </td>
                      <td className="small">{r.trigger.kind}</td>
                      <td className="small">{r.action.kind}</td>
                      <td className="gb-nowrap">
                        <Checkbox checked={r.enabled} disabled={!!reason} onChange={(v) => void patch(r, { enabled: v }, `${r.name} ${v ? "enabled" : "disabled"}`)} label={r.enabled ? t("sponsors.on") : t("sponsors.off")} />
                      </td>
                      <td className="gb-nowrap">
                        <Checkbox checked={r.dryRun} disabled={!!reason} onChange={(v) => void patch(r, { dryRun: v }, t("sponsors.nameDryRunV", { name: r.name, v: v ? "on" : t("sponsors.offActionsExecute") }))} label={r.dryRun ? t("sponsors.dryRun") : t("sponsors.live")} />
                      </td>
                      <td>
                        <div className="cell-actions">
                          <Button size="sm" disabledReason={reason} onClick={() => setEditing(r)}>{t("sponsors.edit")}</Button>
                          <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/automation/rules/${seg(r.id)}`)} success={t("sponsors.ruleDeleted")} onDone={() => void rules.reload()} disabledReason={reason} confirm={{ title: t("sponsors.deleteRuleName", { name: r.name }), danger: true, confirmLabel: t("sponsors.delete") }}>{t("sponsors.delete")}</ActionButton>
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
        <Panel title={t("sponsors.eventSimulator")} subtitle={t("sponsors.sendATestEventThrough")}>
          <div className="form-grid">
            <Field label={t("sponsors.eventKind")}>
              <select value={simKind} onChange={(e) => setSimKind(e.target.value)}>
                {TRIGGERS.map((tRow) => (
                  <option key={tRow} value={tRow}>
                    {tRow}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("sponsors.programMode")}>
              <select value={simMode} onChange={(e) => setSimMode(e.target.value)}>
                <option value="">{t("sponsors.current")}</option>
                {PROGRAM_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <JsonEditor label={t("sponsors.eventData")} value={simData} onChange={setSimData} rows={4} />
          <div className="form-actions">
            <ActionButton
              variant="primary"
              action={() => api.post<RuleExecution[]>("/api/v1/automation/simulate", { kind: simKind, data: simParsed.ok ? simParsed.value : {}, ...(simMode ? { programMode: simMode } : {}) })}
              success={(r) => t("sponsors.countRuleExecutionS", { count: r.length })}
              onDone={setSimResult}
              disabledReason={reason ?? (simParsed.ok ? null : t("sponsors.invalidJson"))}
            >{t("sponsors.simulateEvent")}</ActionButton>
          </div>
          <p className="small text-warn">{t("sponsors.enabledRulesThatAreNot")}</p>
          {simResult ? (
            simResult.length === 0 ? (
              <p className="muted small">{t("sponsors.noRuleMatchedThisEvent")}</p>
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
        <Panel title={t("sponsors.ruleLog")} subtitle={t("sponsors.newestFirst")} className="gb-start">
          <Async state={log}>
            {(list) =>
              list.length === 0 ? (
                <p className="muted small">{t("sponsors.noExecutionsYet")}</p>
              ) : (
                <div style={{ maxHeight: 420, overflowY: "auto" }}>
                  <table className="table table-compact">
                    <tbody>
                      {[...list].reverse().map((x, i) => (
                        <tr key={i}>
                          <td>
                            <Badge tone={x.status === "executed" ? "ok" : x.status === "dry_run" ? "info" : x.status === "failed" ? "danger" : "neutral"}>{x.status}</Badge>
                          </td>
                          <td className="small" title={t("sponsors.eventEventid", { eventId: x.eventId })}>
                            {ruleName(x.ruleId)} → {x.action.kind}
                            {x.reason || x.attempts > 1 ? (
                              <div className="muted">
                                {x.reason ?? ""} {x.attempts > 1 ? t("sponsors.attemptsAttempts", { attempts: x.attempts }) : ""}
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
        <h1 className="page-title">{t("sponsors.sponsorsAutomation")}</h1>
      </div>
      <Tabs
        label={t("sponsors.sponsorsAndAutomation")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "sponsors", label: t("sponsors.sponsors") },
          { id: "automation", label: t("sponsors.automationRules") },
        ]}
      />
      {tab === "sponsors" ? <SponsorsTab /> : <AutomationTab />}
    </div>
  );
}
