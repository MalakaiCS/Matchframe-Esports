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
import { perLocale, t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";
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
const LABEL: Record<string, string> = perLocale(() => ({ displayName: t("teams.nickname"), firstName: t("teams.firstName"), lastName: t("teams.lastName"), countryCode: t("teams.country"), steamId: "SteamID64", teamId: t("teams.team"), role: t("teams.role"), avatarAssetId: t("teams.avatar") }));

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
  if (p.data === undefined) return <div className="page">{p.error ? <ErrorBox error={p.error} onRetry={() => void p.reload()} /> : <Loading label={t("teams.loadingPlayer")} />}</div>;
  return <PlayerEditor player={p.data} back={back} presetTeam={null} reload={() => void p.reload()} />;
}

function AliasesField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <FormField label={t("teams.aliases")} htmlFor="player-aliases" hint={t("teams.otherNamesThisPlayerHas")}>
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
    if (!d.draft.displayName.trim()) local.displayName = t("teams.enterANickname");
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
  const teamName = (id: string) => teamList.find((tRow) => tRow.id === id)?.name ?? t("teams.aDeletedTeam");
  const backLabel = back === "/players" ? t("teams.players") : (teamList.find((tRow) => `/teams/${tRow.id}/edit` === back)?.name ?? t("teams.team"));
  const others = useApi<PlayerRow[]>(player ? "/api/v1/players" : null);

  return (
    <EditorShell
      title={player ? t("teams.editDisplayname", { displayName: player.displayName }) : t("teams.addPlayer")}
      backTo={back}
      backLabel={backLabel}
      crumbs={[player ? player.displayName : t("teams.addPlayer")]}
      editor={editor}
      saveDisabledReason={reason}
      footerNote={!d.draft.steamId.trim() ? <span className="small text-warn">{t("teams.withoutASteamid64ThisPlayer2")}</span> : null}
    >
      {conflict.length ? (
        <Note tone="warn" title={t("teams.changedElsewhere")}><T k="teams.joinChangedOnAnotherScreen" values={{ join: conflict.map((c) => LABEL[c] ?? c).join(", "), button: <Button
            size="sm"
            onClick={() => {
              d.reload(conflict as (keyof PlayerDraft)[]);
              setConflict([]);
              setErrors({});
              reload?.();
            }}
          >{t("teams.useTheCurrentValues")}</Button> }} /></Note>
      ) : null}
      <section className="form-stack">
        <FormField label={t("teams.nickname")} htmlFor="player-nick" required error={errors.displayName} hint={t("teams.theBroadcastNameShownOn")}>
          <input id="player-nick" value={d.draft.displayName} maxLength={64} aria-invalid={!!errors.displayName || undefined} onChange={(e) => d.set({ displayName: e.target.value })} autoFocus={!player} />
        </FormField>
        <div className="form-pair">
          <FormField label={t("teams.firstName")} htmlFor="player-first" error={errors.firstName}>
            <input id="player-first" value={d.draft.firstName} maxLength={60} onChange={(e) => d.set({ firstName: e.target.value })} />
          </FormField>
          <FormField label={t("teams.lastName")} htmlFor="player-last" error={errors.lastName}>
            <input id="player-last" value={d.draft.lastName} maxLength={60} onChange={(e) => d.set({ lastName: e.target.value })} />
          </FormField>
        </div>
        <FormField label={t("teams.country")} htmlFor="player-country" error={errors.countryCode}>
          <CountrySelect id="player-country" value={d.draft.countryCode} onChange={(countryCode) => d.set({ countryCode })} invalid={!!errors.countryCode} />
        </FormField>
        <FormField
          label={t("teams.playerIdentificationSteamid64ForCs2")}
          htmlFor="player-steam"
          error={errors.steamId ?? steamProblem}
          hint={d.draft.steamId.trim() ? t("teams.linksThisPlayerToThe") : <span className="text-warn">{t("teams.noSteamid64ThisPlayerWon")}</span>}
        >
          <input id="player-steam" className="mono" inputMode="numeric" placeholder="7656119…" value={d.draft.steamId} maxLength={20} aria-invalid={!!(errors.steamId ?? steamProblem) || undefined} onChange={(e) => d.set({ steamId: e.target.value.replace(/\s+/g, "") })} />
        </FormField>
        <FormField label={t("teams.team")} htmlFor="player-team" error={errors.teamId} hint={t("teams.assigningOrChangingTheTeam")}>
          <TeamSelect id="player-team" teams={teamList} value={d.draft.teamId} onChange={(teamId) => d.set({ teamId })} emptyLabel={t("teams.unassigned")} invalid={!!errors.teamId} />
        </FormField>
        <FormField
          label={t("teams.avatar")}
          htmlFor="player-avatar"
          hint={
            <><T k="teams.withoutOneTheDefaultPlayer" tags={{ link: (c) => <Link to="/settings">{c}</Link> }} /></>
          }
        >
          <ImageField
            id="player-avatar"
            label={t("teams.avatar")}
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
      <Details summary={t("teams.additionalDetailsRoleAliasesOn")} className="additional">
        <div className="form-grid">
          <FormField label={t("teams.roleInTheTeam")} htmlFor="player-role" hint={d.draft.teamId ? undefined : t("teams.appliesWhenThePlayerIs")}>
            <select id="player-role" value={d.draft.role} disabled={!d.draft.teamId} onChange={(e) => d.set({ role: e.target.value as PlayerDraft["role"] })}>
              <option value="player">{t("teams.player")}</option>
              <option value="substitute">{t("teams.substitute")}</option>
              <option value="stand_in">Stand-in</option>
              <option value="coach">{t("teams.coach")}</option>
            </select>
          </FormField>
          <FormField label={t("teams.cameraSourceId")} htmlFor="player-cam">
            <input id="player-cam" value={d.draft.cameraSourceId ?? ""} placeholder={t("teams.eGPcamDesk3")} onChange={(e) => d.set({ cameraSourceId: e.target.value || null })} />
          </FormField>
        </div>
        <AliasesField value={d.draft.aliases} onChange={(aliases) => d.set({ aliases })} />
        <div className="row" style={{ gap: 16, marginTop: 8 }}>
          <Checkbox checked={d.draft.photoVisible} onChange={(photoVisible) => d.set({ photoVisible })} label={t("teams.photoMayBeShownOn")} />
          <Checkbox checked={d.draft.cameraConsent} onChange={(cameraConsent) => d.set({ cameraConsent })} label={t("teams.playerCameraConsent")} />
        </div>
        {player ? (
          <>
            <h3 className="section-title">{t("teams.rosterHistory")}</h3>
            {player.history.length === 0 ? (
              <p className="muted small">{t("teams.neverOnATeam")}</p>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t("teams.team")}</th>
                    <th>{t("teams.role")}</th>
                    <th>{t("teams.from")}</th>
                    <th>{t("teams.to")}</th>
                  </tr>
                </thead>
                <tbody>
                  {player.history.map((h) => (
                    <tr key={h.id}>
                      <td>{teamName(h.teamId)}</td>
                      <td>{roleText(h.role)}</td>
                      <td className="small">{fmtTime(h.validFrom)}</td>
                      <td className="small">{h.validTo ? fmtTime(h.validTo) : t("teams.current")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h3 className="section-title">{t("teams.mergeADuplicateIntoThis")}</h3>
            <p className="small muted">{t("teams.theDuplicateSRosterHistory")}</p>
            <div className="row-end">
              <FormField label={t("teams.duplicate")} htmlFor="player-dup">
                <Combobox id="player-dup" options={(others.data ?? []).filter((x) => x.id !== player.id).map((x) => ({ key: x.id, label: x.displayName, hint: x.steamId ?? t("teams.noSteamid64") }))} value={dup} onChange={setDup} placeholder={t("teams.searchPlayers")} />
              </FormField>
              <ActionButton
                variant="warn"
                action={() => api.post(`/api/v1/players/${seg(player.id)}/merge`, { duplicateId: dup })}
                success={t("teams.playersMerged")}
                onDone={() => {
                  setDup(null);
                  reload?.();
                }}
                disabledReason={reason ?? (dup ? null : t("teams.chooseTheDuplicatePlayer"))}
                confirm={{ title: t("teams.mergePlayers"), body: t("teams.mergeVIntoDisplaynameThis", { v: others.data?.find((x) => x.id === dup)?.displayName ?? t("teams.theDuplicate"), displayName: player.displayName }), confirmLabel: t("teams.merge"), danger: true }}
              >{t("teams.merge")}</ActionButton>
            </div>
          </>
        ) : null}
      </Details>
    </EditorShell>
  );
}
