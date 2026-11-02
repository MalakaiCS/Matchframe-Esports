import { useCallback, useMemo, useRef, useState } from "react";
import { steamId64Problem } from "@matchframe/contracts/veto-entries";
import { api, seg } from "../../api/index.ts";
import type { PlayerDetail, PlayerRow, RosterMembership, StagedImage, TeamRow } from "../../api/types.ts";
import { EditorShell, useEditor } from "../../components/EditorShell.tsx";
import { Combobox, CountrySelect, discardStaged, fieldErrorsOf, FormField, ImageField, TeamSelect } from "../../components/forms.tsx";
import { ActionButton, Button, Checkbox, Details, ErrorBox, Loading, Note } from "../../components/ui.tsx";
import { useDraft } from "../../lib/draft.ts";
import { fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { Link, useLocation } from "../../router.tsx";
import { usePermission } from "../../state/session.tsx";
import { roleText } from "../Teams.tsx";
import { editId } from "./TeamEditor.tsx";
import "../../styles/records.css";

type PlayerDraft = {
  displayName: string;
  firstName: string;
  lastName: string;
  countryCode: string | null;
  steamId: string;
  teamId: string | null;
  role: RosterMembership["role"];
  avatarAssetId: string | null;
  aliases: string[];
  photoVisible: boolean;
  cameraConsent: boolean;
  cameraSourceId: string | null;
};
const EMPTY: PlayerDraft = { displayName: "", firstName: "", lastName: "", countryCode: null, steamId: "", teamId: null, role: "player", avatarAssetId: null, aliases: [], photoVisible: true, cameraConsent: false, cameraSourceId: null };
const LABEL: Record<string, string> = { displayName: "Nickname", firstName: "First name", lastName: "Last name", countryCode: "Country", steamId: "SteamID64", teamId: "Team", role: "Role", avatarAssetId: "Avatar" };

/** Where the editor returns: the list, or the team editor it was opened from. */
function returnPath(query: URLSearchParams): string {
  const r = query.get("returnTo");
  return r && /^\/teams\/[^/]+\/edit$/.test(r) ? r : "/players";
}

export function PlayerEditorScreen() {
  const { path, query } = useLocation();
  const id = editId(path, "players");
  const back = returnPath(query);
  return id ? <PlayerEditorLoader id={id} back={back} key={id} /> : <PlayerEditor player={null} back={back} presetTeam={query.get("teamId")} key="new" />;
}

function PlayerEditorLoader({ id, back }: { id: string; back: string }) {
  const p = useApi<PlayerDetail>(`/api/v1/players/${seg(id)}`);
  if (p.data === undefined) return <div className="page">{p.error ? <ErrorBox error={p.error} onRetry={() => void p.reload()} /> : <Loading label="Loading player…" />}</div>;
  return <PlayerEditor player={p.data} back={back} presetTeam={null} reload={() => void p.reload()} />;
}

function AliasesField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <FormField label="Aliases" htmlFor="player-aliases" hint="Other names this player has used (comma separated); they help merge duplicates.">
      <input
        id="player-aliases"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }}
      />
    </FormField>
  );
}

function PlayerEditor({ player, back, presetTeam, reload }: { player: PlayerDetail | null; back: string; presetTeam: string | null; reload?: () => void }) {
  const reason = usePermission("metadata.write");
  const teams = useApi<TeamRow[]>("/api/v1/teams?archived=1");
  const server = useMemo<PlayerDraft | undefined>(
    () =>
      player
        ? {
            displayName: player.displayName,
            firstName: player.firstName ?? "",
            lastName: player.lastName ?? "",
            countryCode: player.countryCode,
            steamId: player.steamId ?? "",
            teamId: player.teamId,
            role: player.role ?? "player",
            avatarAssetId: player.avatarAssetId,
            aliases: player.aliases,
            photoVisible: player.photoVisible,
            cameraConsent: player.cameraConsent,
            cameraSourceId: player.cameraSourceId,
          }
        : undefined,
    [player],
  );
  const d = useDraft<PlayerDraft>(server, { ...EMPTY, teamId: presetTeam });
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<string[]>([]);
  const [dup, setDup] = useState<string | null>(null);
  const savedName = useRef("");
  // A new player opened from a team's editor starts on that team: a change worth guarding only when edited further.
  const dirty = d.dirty || staged !== null;
  const steamProblem = d.draft.steamId.trim() ? steamId64Problem(d.draft.steamId) : null;

  const save = useCallback(async () => {
    setErrors({});
    setConflict([]);
    const local: Record<string, string> = {};
    if (!d.draft.displayName.trim()) local.displayName = "Enter a nickname";
    if (d.draft.steamId.trim() && steamId64Problem(d.draft.steamId)) local.steamId = steamId64Problem(d.draft.steamId)!;
    if (Object.keys(local).length) {
      setErrors(local);
      throw new Error(Object.values(local).join("; "));
    }
    savedName.current = d.draft.displayName.trim();
    const body = (v: Partial<PlayerDraft>) => {
      const out: Record<string, unknown> = { ...v };
      if ("steamId" in v) out.steamId = (v.steamId ?? "").trim() || null;
      if ("firstName" in v) out.firstName = (v.firstName ?? "").trim() || null;
      if ("lastName" in v) out.lastName = (v.lastName ?? "").trim() || null;
      return out;
    };
    try {
      if (!player) {
        await api.post<PlayerRow>("/api/v1/players", { ...body(d.draft), role: d.draft.teamId ? d.draft.role : null, ...(staged ? { avatarStagedId: staged.stagedId } : {}) });
      } else {
        const expected = body(d.expected());
        if (staged) expected.avatarAssetId = d.original.avatarAssetId;
        await api.patch<PlayerRow>(`/api/v1/players/${seg(player.id)}`, { changes: body(d.changes()), expected, ...(staged ? { avatarStagedId: staged.stagedId } : {}) });
      }
      setStaged(null);
    } catch (e) {
      const f = fieldErrorsOf(e);
      setErrors(f);
      if ((e as { code?: string }).code === "field_conflict") setConflict(Object.keys(f));
      throw e;
    }
  }, [player, d, staged]);

  const editor = useEditor({
    dirty,
    backTo: back,
    save,
    onDiscard: () => discardStaged(staged),
    savedMessage: () => (player ? `${savedName.current} saved` : `${savedName.current} created`),
  });
  const teamList = teams.data ?? [];
  const teamName = (id: string) => teamList.find((t) => t.id === id)?.name ?? "a deleted team";
  const backLabel = back === "/players" ? "Players" : `${teamList.find((t) => `/teams/${t.id}/edit` === back)?.name ?? "Team"}`;
  const others = useApi<PlayerRow[]>(player ? "/api/v1/players" : null);

  return (
    <EditorShell
      title={player ? `Edit ${player.displayName}` : "Add Player"}
      backTo={back}
      backLabel={backLabel}
      crumbs={[player ? player.displayName : "Add Player"]}
      editor={editor}
      saveDisabledReason={reason}
      footerNote={!d.draft.steamId.trim() ? <span className="small text-warn">Without a SteamID64 this player won't match live CS2 data.</span> : null}
    >
      {conflict.length ? (
        <Note tone="warn" title="Changed elsewhere">
          {conflict.map((c) => LABEL[c] ?? c).join(", ")} changed on another screen or computer while you were editing.{" "}
          <Button
            size="sm"
            onClick={() => {
              d.reload(conflict as (keyof PlayerDraft)[]);
              setConflict([]);
              setErrors({});
              reload?.();
            }}
          >
            Use the current values
          </Button>
        </Note>
      ) : null}
      <section className="form-stack">
        <FormField label="Nickname" htmlFor="player-nick" required error={errors.displayName} hint="The broadcast name shown on the HUD, for example Malakai. Changing it keeps the SteamID64 link.">
          <input id="player-nick" value={d.draft.displayName} maxLength={64} aria-invalid={!!errors.displayName || undefined} onChange={(e) => d.set({ displayName: e.target.value })} autoFocus={!player} />
        </FormField>
        <div className="form-pair">
          <FormField label="First name" htmlFor="player-first" error={errors.firstName}>
            <input id="player-first" value={d.draft.firstName} maxLength={60} onChange={(e) => d.set({ firstName: e.target.value })} />
          </FormField>
          <FormField label="Last name" htmlFor="player-last" error={errors.lastName}>
            <input id="player-last" value={d.draft.lastName} maxLength={60} onChange={(e) => d.set({ lastName: e.target.value })} />
          </FormField>
        </div>
        <FormField label="Country" htmlFor="player-country" error={errors.countryCode}>
          <CountrySelect id="player-country" value={d.draft.countryCode} onChange={(countryCode) => d.set({ countryCode })} invalid={!!errors.countryCode} />
        </FormField>
        <FormField
          label="Player identification (SteamID64 for CS2)"
          htmlFor="player-steam"
          error={errors.steamId ?? steamProblem}
          hint={d.draft.steamId.trim() ? "Links this player to the live in-game player. 17 digits, starting 7656119." : <span className="text-warn">No SteamID64: this player won't match live CS2 data until one is added. 17 digits, starting 7656119.</span>}
        >
          <input id="player-steam" className="mono" inputMode="numeric" placeholder="7656119…" value={d.draft.steamId} maxLength={20} aria-invalid={!!(errors.steamId ?? steamProblem) || undefined} onChange={(e) => d.set({ steamId: e.target.value.replace(/\s+/g, "") })} />
        </FormField>
        <FormField label="Team" htmlFor="player-team" error={errors.teamId} hint="Assigning or changing the team updates both teams' rosters when you save; earlier memberships stay in the history.">
          <TeamSelect id="player-team" teams={teamList} value={d.draft.teamId} onChange={(teamId) => d.set({ teamId })} emptyLabel="Unassigned" invalid={!!errors.teamId} />
        </FormField>
        <FormField
          label="Avatar"
          htmlFor="player-avatar"
          hint={
            <>
              Without one, the <Link to="/settings">default player picture</Link> is shown (Settings → General).
            </>
          }
        >
          <ImageField
            id="player-avatar"
            label="Avatar"
            kind="avatar"
            value={{ assetId: d.draft.avatarAssetId, staged }}
            disabledReason={reason}
            onChange={(v) => {
              setStaged(v.staged);
              if (!v.staged) d.set({ avatarAssetId: v.assetId });
            }}
          />
        </FormField>
      </section>
      <Details summary="Additional details: role, aliases, on-air consent, roster history" className="additional">
        <div className="form-grid">
          <FormField label="Role in the team" htmlFor="player-role" hint={d.draft.teamId ? undefined : "Applies when the player is on a team"}>
            <select id="player-role" value={d.draft.role} disabled={!d.draft.teamId} onChange={(e) => d.set({ role: e.target.value as PlayerDraft["role"] })}>
              <option value="player">Player</option>
              <option value="substitute">Substitute</option>
              <option value="stand_in">Stand-in</option>
              <option value="coach">Coach</option>
            </select>
          </FormField>
          <FormField label="Camera source id" htmlFor="player-cam">
            <input id="player-cam" value={d.draft.cameraSourceId ?? ""} placeholder="e.g. pcam-desk-3" onChange={(e) => d.set({ cameraSourceId: e.target.value || null })} />
          </FormField>
        </div>
        <AliasesField value={d.draft.aliases} onChange={(aliases) => d.set({ aliases })} />
        <div className="row" style={{ gap: 16, marginTop: 8 }}>
          <Checkbox checked={d.draft.photoVisible} onChange={(photoVisible) => d.set({ photoVisible })} label="Photo may be shown on air" />
          <Checkbox checked={d.draft.cameraConsent} onChange={(cameraConsent) => d.set({ cameraConsent })} label="Player-camera consent" />
        </div>
        {player ? (
          <>
            <h3 className="section-title">Roster history</h3>
            {player.history.length === 0 ? (
              <p className="muted small">Never on a team.</p>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Role</th>
                    <th>From</th>
                    <th>To</th>
                  </tr>
                </thead>
                <tbody>
                  {player.history.map((h) => (
                    <tr key={h.id}>
                      <td>{teamName(h.teamId)}</td>
                      <td>{roleText(h.role)}</td>
                      <td className="small">{fmtTime(h.validFrom)}</td>
                      <td className="small">{h.validTo ? fmtTime(h.validTo) : "Current"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h3 className="section-title">Merge a duplicate into this player</h3>
            <p className="small muted">The duplicate's roster history and SteamID64 move here; its nickname becomes an alias and the duplicate is archived. Applied at once.</p>
            <div className="row-end">
              <FormField label="Duplicate" htmlFor="player-dup">
                <Combobox id="player-dup" options={(others.data ?? []).filter((x) => x.id !== player.id).map((x) => ({ key: x.id, label: x.displayName, hint: x.steamId ?? "no SteamID64" }))} value={dup} onChange={setDup} placeholder="Search players" />
              </FormField>
              <ActionButton
                variant="warn"
                action={() => api.post(`/api/v1/players/${seg(player.id)}/merge`, { duplicateId: dup })}
                success="Players merged"
                onDone={() => {
                  setDup(null);
                  reload?.();
                }}
                disabledReason={reason ?? (dup ? null : "Choose the duplicate player")}
                confirm={{ title: "Merge players?", body: `Merge ${others.data?.find((x) => x.id === dup)?.displayName ?? "the duplicate"} into ${player.displayName}. This cannot be undone from the console.`, confirmLabel: "Merge", danger: true }}
              >
                Merge
              </ActionButton>
            </div>
          </>
        ) : null}
      </Details>
    </EditorShell>
  );
}
