import { useEffect, useState } from "react";
import type { HudState } from "@matchframe/hud-sdk";
import { api, seg } from "../../api/index.ts";
import type { HudOutputEntry, HudPackage, MatchRow, OutputDraft, PublishedOutput } from "../../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, CopyButton, Details, EmptyState, Field, JsonEditor, KV, Panel, parseJsonOr } from "../../components/ui.tsx";
import { fmtMs, fmtTime, MISSING } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { useLowSpec } from "../../lib/lowSpec.ts";
import { usePermission } from "../../state/session.tsx";
import { perLocale, t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

export const HUD_VARIANTS = ["live", "compact", "replay", "veto", "pre-match", "break", "post-map", "post-series", "studio"] as const;
const PROFILES = perLocale(() => ([
  { id: "program", label: t("huds.programFull") },
  { id: "clean", label: t("huds.cleanNoSponsorsCues") },
  { id: "caster", label: t("huds.caster") },
  { id: "preview", label: t("huds.preview") },
] as const));

export function previewUrl(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + "preview=1";
}

function PublicStatePreview({ outputId }: { outputId: string }) {
  const st = useApi<HudState | null>(`/api/v1/hud/outputs/${seg(outputId)}/state`, { refreshMs: 2000 });
  return (
    <Async state={st}>
      {(h) =>
        !h ? (
          <p className="muted small">{t("huds.notPublishedSoThereIs")}</p>
        ) : (
          <KV
            items={[
              [t("huds.source"), h.simulated ? t("huds.simulation") : t("huds.live2")],
              [t("huds.data"), h.stale ? <Badge key="d" tone="danger">{t("huds.stale")}</Badge> : t("huds.ageDataagems", { dataAgeMs: fmtMs(h.dataAgeMs) })],
              [t("huds.timeline"), `${h.timeline.profile}${h.timeline.profile === "delayed" ? ` (${fmtMs(h.timeline.delayMs)})` : ""}`],
              [t("huds.match"), t("huds.vRoundV2Phase", { v: h.match.mapDisplayName ?? h.match.mapName ?? MISSING, v2: h.match.roundNumber ?? MISSING, phase: h.match.phase })],
              [t("huds.teams"), `${h.left.name} ${h.left.score ?? MISSING} – ${h.right.score ?? MISSING} ${h.right.name}`],
              [t("huds.observed"), h.observed?.name ?? t("common.none")],
              [t("huds.radar"), h.radar.available ? `${h.radar.mode}${h.radar.calibrationVerified ? " (verified)" : ""}` : t("huds.unavailableV", { v: h.radar.reason ?? "?" })],
              [t("huds.killfeed"), `${h.killfeed.mode} (${h.killfeed.entries.length})`],
              [t("huds.cuesAnnotations"), `${h.cues.length} / ${h.annotations.length}`],
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
        <Field label={t("huds.name")}>
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t("huds.hudPackage")}>
          <select value={d.packageId} onChange={(e) => set({ packageId: e.target.value })}>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.manifest.name} {p.manifest.version}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("huds.variant")}>
          <select value={d.variant} onChange={(e) => set({ variant: e.target.value as OutputDraft["variant"] })}>
            {variants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("huds.preset")}>
          <select value={d.presetId ?? ""} onChange={(e) => set({ presetId: e.target.value || null })}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("huds.profile")}>
          <select value={d.profile} onChange={(e) => set({ profile: e.target.value as OutputDraft["profile"] })}>
            {PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("huds.timeline")}>
          <select value={d.timelineProfile} onChange={(e) => set({ timelineProfile: e.target.value as OutputDraft["timelineProfile"] })}>
            <option value="live">{t("huds.live")}</option>
            <option value="delayed">{t("huds.delayed")}</option>
          </select>
        </Field>
        {d.timelineProfile === "delayed" ? (
          <Field label={t("huds.delayMs")} hint={t("huds.neverShowsDataAheadOf")}>
            <input type="number" min={0} step={500} value={d.delayMs} onChange={(e) => set({ delayMs: Number(e.target.value) })} />
          </Field>
        ) : null}
        <Field label={t("huds.match")}>
          <select value={d.matchId ?? ""} onChange={(e) => set({ matchId: e.target.value || null })}>
            <option value="">{t("huds.activeMatch")}</option>
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title ?? m.id}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Details summary={t("huds.outputSettingsJson")}>
        <JsonEditor label={t("huds.passedToTheHudAs")} value={settingsText} onChange={setSettingsText} rows={6} />
      </Details>
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() => {
            if (!parsed.ok) throw new Error(t("huds.settingsJsonIsInvalidError", { error: parsed.error }));
            const { id: _id, outputId: _o, publishedRevision: _p, ...rest } = d;
            return api.patch(`/api/v1/hud/outputs/${seg(d.outputId)}`, { ...rest, settings: parsed.value });
          }}
          success={t("huds.draftSavedNotOnAir")}
          onDone={onSaved}
          disabledReason={reason ?? (parsed.ok ? null : t("huds.fixTheSettingsJsonFirst"))}
        >{t("huds.saveDraft")}</ActionButton>
      </div>
    </>
  );
}

function OutputDetail({ entry, packages, matches, reload }: { entry: HudOutputEntry; packages: HudPackage[]; matches: MatchRow[]; reload: () => void }) {
  const reason = usePermission("hud.publish");
  const [rollbackTo, setRollbackTo] = useState<string>("");
  // Low-spec mode (ADR-078): the on-air preview stays off until shown.
  const lowSpec = useLowSpec()?.lowSpec === true;
  const [frameChoice, setShowFrame] = useState<boolean | null>(null);
  const showFrame = frameChoice ?? !lowSpec;
  const [frameKey, setFrameKey] = useState(0);
  const pub = entry.published;
  const id = entry.draft.outputId;
  return (
    <div className="stack">
      <Panel
        title={entry.draft.name}
        subtitle={pub ? t("huds.revisionRevisionOnAirPublished", { revision: pub.revision, publishedAt: fmtTime(pub.publishedAt), publishedBy: pub.publishedBy }) : t("huds.notPublishedYet")}
        actions={
          <>
            {entry.dirty ? <Badge tone="warn">{t("huds.unpublishedChanges")}</Badge> : null}
            <ActionButton
              variant="primary"
              action={() => api.post<PublishedOutput>(`/api/v1/hud/outputs/${seg(id)}/publish`)}
              success={(p) => t("huds.publishedRevisionRevisionOnAir", { revision: p.revision })}
              onDone={() => {
                reload();
                setFrameKey((k) => k + 1);
              }}
              disabledReason={reason ?? (entry.dirty ? null : t("huds.nothingToPublishTheDraft"))}
              confirm={{ title: t("huds.publishName", { name: entry.draft.name }), body: t("huds.theBrowserSourceSwitchesTo") }}
            >{t("huds.publishDraft")}</ActionButton>
          </>
        }
      >
        <div className="url-box">
          <input readOnly value={entry.url} aria-label={t("huds.outputUrl")} onFocus={(e) => e.target.select()} />
          <CopyButton text={entry.url} label={t("huds.copyUrl")} size="md" />
        </div>
        <p className="small muted">{t("huds.addThisUrlToObs")}</p>
        <Details summary={t("huds.rollBackToAnEarlier")}>
          <div className="row-end">
            <Field label={t("huds.revision")}>
              <select value={rollbackTo} onChange={(e) => setRollbackTo(e.target.value)}>
                <option value="">{t("huds.choose")}</option>
                {entry.revisions.map((r) => (
                  <option key={r.revision} value={r.revision} disabled={r.revision === pub?.revision}>
                    r{r.revision} · {fmtTime(r.publishedAt)} · {r.publishedBy}
                    {r.revision === pub?.revision ? t("huds.onAir2") : ""}
                  </option>
                ))}
              </select>
            </Field>
            <ActionButton
              action={() => api.post<PublishedOutput>(`/api/v1/hud/outputs/${seg(id)}/rollback`, { revision: Number(rollbackTo) })}
              success={(p) => t("huds.rolledBackRevisionRollbacktoRepublished", { rollbackTo, revision: p.revision })}
              onDone={() => {
                reload();
                setFrameKey((k) => k + 1);
              }}
              disabledReason={reason ?? (rollbackTo ? null : t("huds.chooseARevision"))}
              confirm={{ title: t("huds.rollBackToRevisionRollbackto", { rollbackTo }), body: t("huds.republishesThatRevisionSContent") }}
            >{t("huds.rollBack")}</ActionButton>
          </div>
        </Details>
        <Details summary={t("huds.outputIdAndToken")}>
          <div className="row">
            <span className="small"><T k="huds.outputIdCode" values={{ code: <code>{id}</code> }} /></span>
            <ActionButton
              size="sm"
              action={() => api.post<{ url: string }>(`/api/v1/hud/outputs/${seg(id)}/rotate-token`)}
              success={t("huds.tokenRotatedUpdateTheObs")}
              onDone={reload}
              disabledReason={reason}
              confirm={{ title: t("huds.rotateThisOutputSToken"), body: t("huds.existingBrowserSourcesUsingThe"), confirmLabel: t("huds.rotateToken"), danger: true }}
            >{t("huds.rotateToken")}</ActionButton>
          </div>
        </Details>
      </Panel>
      <div className="grid-2">
        <Panel title={t("huds.draft")} subtitle={t("huds.notOnAirUntilYou")}>
          <DraftEditor entry={entry} packages={packages} matches={matches} onSaved={reload} />
        </Panel>
        <Panel
          title={t("huds.onAirPreview")}
          className="gb-start"
          actions={
            <>
              <Checkbox checked={showFrame} onChange={setShowFrame} label={t("huds.show")} />
              <button className="link-btn" onClick={() => setFrameKey((k) => k + 1)}>{t("huds.reload")}</button>
            </>
          }
        >
          {showFrame && pub ? (
            <div className="preview-frame">
              <iframe key={frameKey} title={t("huds.previewOfId", { id })} src={previewUrl(entry.url)} sandbox="allow-scripts allow-same-origin" />
            </div>
          ) : (
            <EmptyState title={pub ? t("huds.previewHidden") : t("huds.notPublished")}>{pub ? t("huds.turnOnShowToLoad") : t("huds.publishTheDraftToGet")}</EmptyState>
          )}
          <p className="small muted" title={t("huds.ifItShowsHudRenderer")}>{t("huds.showsThePublishedRevisionNot")}</p>
          <Details summary={t("huds.publicHudState")}>
            <p className="small muted">{t("huds.exactlyWhatTheBrowserSource")}</p>
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
            <Panel title={t("huds.outputs")} subtitle={t("huds.oneBrowserSourceEach")}>
              <ul className="select-list">
                {list.map((o) => (
                  <li key={o.draft.outputId}>
                    <button className={o.draft.outputId === entry?.draft.outputId ? "is-selected" : ""} onClick={() => setSelected(o.draft.outputId)} title={t("huds.outputIdOutputidV", { outputId: o.draft.outputId, v: o.published ? t("huds.revisionRevisionOnAir", { revision: o.published.revision }) : "" })}>
                      <span style={{ flex: 1 }}>
                        <strong>{o.draft.name}</strong>
                        <span className="muted small">
                          {" "}
                          · {o.draft.variant} · {o.draft.profile}
                        </span>
                      </span>
                      {!o.published ? <Badge>{t("huds.notPublished")}</Badge> : o.dirty ? <Badge tone="warn">{t("huds.changed")}</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <Details summary={t("huds.newOutput")}>
                <div className="form-grid">
                  <Field label={t("huds.outputId")} hint={t("huds.aZ09Dash")}>
                    <input value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} placeholder="caster-left" />
                  </Field>
                  <Field label={t("huds.name")}>
                    <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("huds.casterDesk")} />
                  </Field>
                </div>
                <div className="form-actions">
                  <ActionButton
                    action={() => api.post<OutputDraft>("/api/v1/hud/outputs", { outputId: newId, name: newName })}
                    success={(o) => t("huds.outputOutputidCreatedPublishIt", { outputId: o.outputId })}
                    onDone={(o) => {
                      setSelected(o.outputId);
                      setNewId("");
                      setNewName("");
                      void outputs.reload();
                    }}
                    disabledReason={reason ?? (/^[a-z0-9-]{2,40}$/.test(newId) && newName.trim() ? null : t("huds.enterAnId240"))}
                  >{t("huds.createOutput")}</ActionButton>
                </div>
              </Details>
            </Panel>
            {entry ? <OutputDetail entry={entry} packages={packages.data ?? []} matches={matches.data ?? []} reload={() => void outputs.reload()} /> : <EmptyState title={t("huds.noOutputs2")}>{t("huds.createAnOutputToGet")}</EmptyState>}
          </div>
        );
      }}
    </Async>
  );
}
