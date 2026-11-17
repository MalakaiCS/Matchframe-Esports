import { useEffect, useState } from "react";
import { api } from "../../api/index.ts";
import { ActionButton, Field, Mono, Note, Panel } from "../../components/ui.tsx";
import { fmtBytes } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { perLocale, t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

/** GET /api/v1/storage (services/local-engine/src/routes/storage.ts). */
export interface StorageOverview {
  folders: { replays: string | null; highlights: string | null };
  where: { replayClips: string; replayFeed: string; keptClips: string; reels: string };
  free: { replays: number | null; highlights: number | null };
  dataDir: string;
}

type Which = "replays" | "highlights";

const LABELS: Record<Which, { label: string; hint: string; pick: string }> = perLocale(() => ({
  replays: {
    label: t("replays.replayClipsAndRecording"),
    hint: t("replays.theReplayPcSClips"),
    pick: t("replays.folderForReplayClipsAnd"),
  },
  highlights: {
    label: t("replays.highlights"),
    hint: t("replays.theClipsKeptForHighlight"),
    pick: t("replays.folderForHighlightReelsAnd"),
  },
}));

/** Where replays and highlights are saved: another drive instead of the one Windows is on, say. */
export function StoragePanel() {
  const reason = usePermission("settings.manage");
  const st = useApi<StorageOverview>("/api/v1/storage");
  const [draft, setDraft] = useState<Record<Which, string>>({ replays: "", highlights: "" });
  useEffect(() => {
    if (st.data) setDraft({ replays: st.data.folders.replays ?? "", highlights: st.data.folders.highlights ?? "" });
  }, [st.data]);
  const pick = window.matchframe?.connectionMode !== "remote" ? window.matchframe?.pickDirectory : undefined;
  const save = (patch: Partial<Record<Which, string | null>>) => api.put<StorageOverview>("/api/v1/storage", patch);
  const row = (which: Which) => {
    const d = st.data;
    const chosen = d?.folders[which] ?? null;
    const free = d?.free[which];
    const where = which === "replays" ? d?.where.replayClips : d?.where.reels;
    return (
      <div key={which} className="stack-sm">
        <Field label={LABELS[which].label} hint={LABELS[which].hint}>
          <div className="row">
            <input value={draft[which]} disabled={!!reason || !d} spellCheck={false} placeholder={which === "replays" ? t("replays.matchframeSDataFolder") : t("replays.videosMatchframeHighlights")} onChange={(e) => setDraft({ ...draft, [which]: e.target.value })} />
            {pick ? (
              <ActionButton
                size="sm"
                variant="ghost"
                disabledReason={reason}
                action={async () => {
                  const dir = await pick(LABELS[which].pick);
                  return dir ? save({ [which]: dir }) : null;
                }}
                success={(r) => (r ? t("replays.folderSaved") : null)}
                onDone={() => void st.reload()}
              >{t("replays.chooseFolder")}</ActionButton>
            ) : null}
            <ActionButton size="sm" disabledReason={reason ?? (draft[which].trim() === (chosen ?? "") ? t("replays.noChange") : null)} action={() => save({ [which]: draft[which].trim() || null })} success={t("replays.folderSaved")} onDone={() => void st.reload()}>{t("replays.save")}</ActionButton>
            {chosen ? (
              <ActionButton size="sm" variant="ghost" disabledReason={reason} action={() => save({ [which]: null })} success={t("replays.backToTheDefaultFolder")} onDone={() => void st.reload()}>{t("replays.useDefault")}</ActionButton>
            ) : null}
          </div>
        </Field>
        <span className="muted small"><T k="replays.nowMonoV" values={{ mono: <Mono>{where ?? "…"}</Mono>, v: free !== null && free !== undefined ? t("replays.freeFreeOnThatDrive", { free: fmtBytes(free) }) : "" }} /></span>
      </div>
    );
  };
  return (
    <Panel title={t("replays.storage")} subtitle={t("replays.whereReplaysAndHighlightsAre")}>
      <div className="stack-sm">
        {row("replays")}
        {row("highlights")}
        <Note>{t("replays.newFilesGoToThe")}</Note>
      </div>
    </Panel>
  );
}
