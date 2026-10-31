import { useEffect, useState } from "react";
import { api } from "../../api/index.ts";
import { ActionButton, Field, Mono, Note, Panel } from "../../components/ui.tsx";
import { fmtBytes } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

/** GET /api/v1/storage (services/local-engine/src/routes/storage.ts). */
export interface StorageOverview {
  folders: { replays: string | null; highlights: string | null };
  where: { replayClips: string; replayFeed: string; keptClips: string; reels: string };
  free: { replays: number | null; highlights: number | null };
  dataDir: string;
}

type Which = "replays" | "highlights";

const LABELS: Record<Which, { label: string; hint: string; pick: string }> = {
  replays: {
    label: "Replay clips and recording",
    hint: "The replay PC's clips and the replay feed's recording of its picture: what writes the most while a match is on.",
    pick: "Folder for replay clips and the replay feed's recording",
  },
  highlights: {
    label: "Highlights",
    hint: "The clips kept for highlight reels (in its \"Kept clips\" folder) and the reels themselves.",
    pick: "Folder for highlight reels and the clips kept for them",
  },
};

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
            <input value={draft[which]} disabled={!!reason || !d} spellCheck={false} placeholder={which === "replays" ? "Matchframe's data folder" : "Videos → Matchframe Highlights"} onChange={(e) => setDraft({ ...draft, [which]: e.target.value })} />
            {pick ? (
              <ActionButton
                size="sm"
                variant="ghost"
                disabledReason={reason}
                action={async () => {
                  const dir = await pick(LABELS[which].pick);
                  return dir ? save({ [which]: dir }) : null;
                }}
                success={(r) => (r ? "Folder saved" : null)}
                onDone={() => void st.reload()}
              >
                Choose folder…
              </ActionButton>
            ) : null}
            <ActionButton size="sm" disabledReason={reason ?? (draft[which].trim() === (chosen ?? "") ? "No change" : null)} action={() => save({ [which]: draft[which].trim() || null })} success="Folder saved" onDone={() => void st.reload()}>
              Save
            </ActionButton>
            {chosen ? (
              <ActionButton size="sm" variant="ghost" disabledReason={reason} action={() => save({ [which]: null })} success="Back to the default folder" onDone={() => void st.reload()}>
                Use default
              </ActionButton>
            ) : null}
          </div>
        </Field>
        <span className="muted small">
          Now: <Mono>{where ?? "…"}</Mono>
          {free !== null && free !== undefined ? ` · ${fmtBytes(free)} free on that drive` : ""}
        </span>
      </div>
    );
  };
  return (
    <Panel title="Storage" subtitle="Where replays and highlights are saved on this computer">
      <div className="stack-sm">
        {row("replays")}
        {row("highlights")}
        <Note>New files go to the new folder from then on. Clips already saved stay where they are and still play and go into reels. A folder on another drive (D:, an SSD for video) keeps this load off the drive Windows is on.</Note>
      </div>
    </Panel>
  );
}
