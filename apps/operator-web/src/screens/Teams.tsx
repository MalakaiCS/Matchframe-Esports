import { useEffect, useMemo, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { PlayerRow, TeamRow } from "../api/types.ts";
import { assetUrl } from "../components/AssetUpload.tsx";
import { Combobox, CountryText, Flag, TeamLogo } from "../components/forms.tsx";
import { ListHeader, SearchBox, SelectAll, SortHeader, useSelection } from "../components/listing.tsx";
import { DeleteDialog, ImportDialog } from "../components/RecordDialogs.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, EmptyState } from "../components/ui.tsx";
import { useDefaultPlayerPicture } from "../lib/defaultPicture.ts";
import { countryLabel } from "../lib/flags.ts";
import { useApi } from "../lib/hooks.ts";
import { sortRows, useListState, useRestoreScroll } from "../lib/listState.ts";
import { Link, navigate } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import { t } from "../i18n/index.ts";
import "../styles/records.css";

export { TeamEditorScreen } from "./teams/TeamEditor.tsx";
export { PlayerEditorScreen } from "./teams/PlayerEditor.tsx";

const ROLE_TEXT: Record<string, string> = { player: "Player", substitute: "Substitute", coach: "Coach", stand_in: "Stand-in" };
export const roleText = (r: string | null | undefined) => (r ? (ROLE_TEXT[r] ?? r) : "");

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** Country filter: the countries present in the list, plus All. */
function CountryFilter({ id, codes, value, onChange }: { id: string; codes: (string | null)[]; value: string; onChange: (v: string) => void }) {
  const options = useMemo(
    () =>
      [...new Set(codes.filter((c): c is string => !!c))]
        .map((c) => ({ key: c, label: countryLabel(c), keywords: c, icon: <Flag code={c} /> }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [codes],
  );
  return (
    <div className="filter">
      <label htmlFor={id} className="filter-label">{t("teams.country")}</label>
      <Combobox id={id} options={options} value={value || null} onChange={(v) => onChange(v ?? "")} emptyLabel={t("teams.allCountries")} placeholder={t("teams.searchCountries")} />
    </div>
  );
}

export function TeamsScreen() {
  const reason = usePermission("metadata.write");
  const { state, update } = useListState<{ country: string; archived: string }>("teams", { search: "", filters: { country: "", archived: "" }, sort: { key: "name", dir: "asc" } });
  const teams = useApi<TeamRow[]>(`/api/v1/teams${state.filters.archived ? "?archived=1" : ""}`);
  const selection = useSelection();
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  const rows = useMemo(() => {
    const q = norm(state.search.trim());
    const list = (teams.data ?? []).filter((tRow) => (!q || norm(tRow.name).includes(q) || norm(tRow.shortName).includes(q)) && (!state.filters.country || tRow.countryCode === state.filters.country));
    return sortRows(list, state.sort, (tRow, k) => (k === "country" ? (tRow.countryCode ? countryLabel(tRow.countryCode) : "") : k === "players" ? tRow.playerCount : tRow[k as keyof TeamRow]));
  }, [teams.data, state]);
  const visibleIds = rows.map((tRow) => tRow.id);
  useEffect(() => selection.keep(visibleIds), [visibleIds.join(",")]);
  useRestoreScroll(state.scrollTop, teams.data !== undefined);
  const selected = [...selection.ids];
  return (
    <div className="page list-page">
      <ListHeader
        title={t("teams.teams")}
        count={teams.data ? rows.length : undefined}
        actions={
          <>
            {selected.length ? (
              <Button variant="danger" onClick={() => setDeleting(selected)} disabledReason={reason}>{t("teams.deleteCountSelected", { count: selected.length })}</Button>
            ) : null}
            <Button onClick={() => setImporting(true)} disabledReason={reason}>{t("teams.importTeams")}</Button>
            <Button variant="primary" onClick={() => navigate("/teams/new")} disabledReason={reason}>{t("teams.addTeam")}</Button>
          </>
        }
      >
        <SearchBox label={t("teams.searchTeams")} placeholder={t("teams.searchTeamOrShortName")} value={state.search} onChange={(search) => update({ search })} />
        <CountryFilter id="teams-country" codes={(teams.data ?? []).map((tRow) => tRow.countryCode)} value={state.filters.country} onChange={(country) => update({ filters: { ...state.filters, country } })} />
        <Checkbox checked={!!state.filters.archived} onChange={(v) => update({ filters: { ...state.filters, archived: v ? "1" : "" } })} label={t("teams.showArchived")} />
      </ListHeader>
      <Async state={teams}>
        {(all) =>
          all.length === 0 ? (
            <EmptyState
              title={t("teams.noTeamsYet")}
              action={
                <>
                  <Button variant="primary" onClick={() => navigate("/teams/new")} disabledReason={reason}>{t("teams.addTeam")}</Button>
                  <Button onClick={() => setImporting(true)} disabledReason={reason}>{t("teams.importTeams")}</Button>
                </>
              }
            >{t("teams.addEachTeamWithIts")}</EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title={t("teams.noTeamsMatch")}>{t("teams.changeTheSearchOrThe2")}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table records-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <SelectAll visible={visibleIds} selection={selection} label={t("teams.selectAllTeamsShown")} />
                    </th>
                    <th className="col-logo">{t("teams.logo")}</th>
                    <SortHeader label={t("teams.teamName")} k="name" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.shortName")} k="shortName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.country")} k="country" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.players")} k="players" sort={state.sort} onSort={(sort) => update({ sort })} className="col-num" />
                    <th className="col-actions">
                      <span className="sr-only">{t("teams.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((tRow) => (
                    <tr key={tRow.id} className={selection.has(tRow.id) ? "is-selected" : ""}>
                      <td className="col-check">
                        <input type="checkbox" aria-label={t("teams.selectName", { name: tRow.name })} checked={selection.has(tRow.id)} onChange={() => selection.toggle(tRow.id)} />
                      </td>
                      <td className="col-logo">
                        <TeamLogo assetId={tRow.logoAssetId} name={tRow.name} size={32} />
                      </td>
                      <td>
                        <Link to={`/teams/${seg(tRow.id)}/edit`} className="row-link">
                          {tRow.name}
                        </Link>
                        {tRow.archived ? <Badge className="ml-6">{t("teams.archived")}</Badge> : null}
                      </td>
                      <td>{tRow.shortName}</td>
                      <td>
                        <CountryText code={tRow.countryCode} />
                      </td>
                      <td className="col-num">{tRow.playerCount}</td>
                      <td className="col-actions">
                        {tRow.archived ? (
                          <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/teams/${seg(tRow.id)}/archive`, { archived: false })} success={t("teams.nameRestored", { name: tRow.name })} onDone={() => void teams.reload()} disabledReason={reason}>{t("teams.restore")}</ActionButton>
                        ) : null}
                        <Button size="sm" onClick={() => navigate(`/teams/${seg(tRow.id)}/edit`)}>{t("teams.edit")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting([tRow.id])} disabledReason={reason} aria-label={t("teams.deleteName", { name: tRow.name })}>{t("teams.delete")}</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
      {deleting ? (
        <DeleteDialog
          kind="teams"
          ids={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            selection.clear();
            void teams.reload();
          }}
        />
      ) : null}
      {importing ? (
        <ImportDialog
          kind="teams"
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void teams.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** A player's picture: their own, else the default player picture (Settings → General), else their initial. */
export function PlayerAvatar({ assetId, name, size = 32 }: { assetId: string | null | undefined; name: string; size?: number }) {
  const fallback = useDefaultPlayerPicture();
  const own = assetUrl(assetId);
  const url = own ?? fallback?.url ?? null;
  return (
    <span className={`avatar ${!own && url ? "is-default" : ""}`} style={{ width: size, height: size }} title={!own && url ? t("teams.defaultPlayerPicture") : undefined}>
      {url ? <img src={url} alt={own ? t("teams.nameAvatar", { name }) : t("teams.nameDefaultPlayerPicture", { name })} /> : <span aria-hidden>{name.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

/** "Won't match live CS2 data": a player without a SteamID64. */
export function NoSteamIdBadge() {
  return (
    <Badge tone="warn" title={t("teams.withoutASteamid64ThisPlayer")}>{t("teams.noSteamid64WonTMatch")}</Badge>
  );
}

export function PlayersScreen() {
  const reason = usePermission("metadata.write");
  const { state, update } = useListState<{ team: string; country: string; archived: string }>("players", { search: "", filters: { team: "", country: "", archived: "" }, sort: { key: "displayName", dir: "asc" } });
  const players = useApi<PlayerRow[]>(`/api/v1/players${state.filters.archived ? "?archived=1" : ""}`);
  const teams = useApi<TeamRow[]>("/api/v1/teams?archived=1");
  const selection = useSelection();
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  const teamById = useMemo(() => new Map((teams.data ?? []).map((tRow) => [tRow.id, tRow])), [teams.data]);
  const rows = useMemo(() => {
    const q = norm(state.search.trim());
    const f = state.filters;
    const list = (players.data ?? []).filter(
      (p) =>
        (!q || norm(p.displayName).includes(q) || norm(`${p.firstName} ${p.lastName}`).includes(q) || norm(p.realName).includes(q) || (p.steamId ?? "").includes(q) || p.aliases.some((a) => norm(a).includes(q))) &&
        (!f.team || (f.team === "__none" ? !p.teamId : p.teamId === f.team)) &&
        (!f.country || p.countryCode === f.country),
    );
    return sortRows(list, state.sort, (p, k) => (k === "team" ? (p.teamId ? teamById.get(p.teamId)?.name : "") : k === "country" ? (p.countryCode ? countryLabel(p.countryCode) : "") : p[k as keyof PlayerRow]));
  }, [players.data, state, teamById]);
  const visibleIds = rows.map((p) => p.id);
  useEffect(() => selection.keep(visibleIds), [visibleIds.join(",")]);
  useRestoreScroll(state.scrollTop, players.data !== undefined);
  const teamOptions = useMemo(() => [{ key: "__none", label: t("teams.unassigned") }, ...(teams.data ?? []).filter((tRow) => !tRow.archived).map((tRow) => ({ key: tRow.id, label: tRow.name, keywords: tRow.shortName, icon: <TeamLogo assetId={tRow.logoAssetId} size={18} name={tRow.name} /> }))], [teams.data]);
  const selected = [...selection.ids];
  return (
    <div className="page list-page">
      <ListHeader
        title={t("teams.players")}
        count={players.data ? rows.length : undefined}
        actions={
          <>
            {selected.length ? (
              <Button variant="danger" onClick={() => setDeleting(selected)} disabledReason={reason}>{t("teams.deleteCountSelected", { count: selected.length })}</Button>
            ) : null}
            <Button onClick={() => setImporting(true)} disabledReason={reason}>{t("teams.importPlayers")}</Button>
            <Button variant="primary" onClick={() => navigate("/players/new")} disabledReason={reason}>{t("teams.addPlayer")}</Button>
          </>
        }
      >
        <SearchBox label={t("teams.searchPlayers")} placeholder={t("teams.nicknameNameOrSteamid64")} value={state.search} onChange={(search) => update({ search })} />
        <div className="filter">
          <label htmlFor="players-team" className="filter-label">{t("teams.team")}</label>
          <Combobox id="players-team" options={teamOptions} value={state.filters.team || null} onChange={(team) => update({ filters: { ...state.filters, team: team ?? "" } })} emptyLabel={t("teams.allTeams")} placeholder={t("teams.searchTeams")} />
        </div>
        <CountryFilter id="players-country" codes={(players.data ?? []).map((p) => p.countryCode)} value={state.filters.country} onChange={(country) => update({ filters: { ...state.filters, country } })} />
        <Checkbox checked={!!state.filters.archived} onChange={(v) => update({ filters: { ...state.filters, archived: v ? "1" : "" } })} label={t("teams.showArchived")} />
      </ListHeader>
      <Async state={players}>
        {(all) =>
          all.length === 0 ? (
            <EmptyState
              title={t("teams.noPlayersYet")}
              action={
                <>
                  <Button variant="primary" onClick={() => navigate("/players/new")} disabledReason={reason}>{t("teams.addPlayer")}</Button>
                  <Button onClick={() => setImporting(true)} disabledReason={reason}>{t("teams.importPlayers")}</Button>
                </>
              }
            >{t("teams.addPlayersWithTheirNickname")}</EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title={t("teams.noPlayersMatch")}>{t("teams.changeTheSearchOrThe")}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table records-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <SelectAll visible={visibleIds} selection={selection} label={t("teams.selectAllPlayersShown")} />
                    </th>
                    <th className="col-logo">{t("teams.avatar")}</th>
                    <SortHeader label={t("teams.nickname")} k="displayName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.firstName")} k="firstName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.lastName")} k="lastName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.country")} k="country" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.team")} k="team" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("teams.steamid64")} k="steamId" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <th className="col-actions">
                      <span className="sr-only">{t("teams.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const team = p.teamId ? teamById.get(p.teamId) : undefined;
                    return (
                      <tr key={p.id} className={selection.has(p.id) ? "is-selected" : ""}>
                        <td className="col-check">
                          <input type="checkbox" aria-label={t("teams.selectDisplayname", { displayName: p.displayName })} checked={selection.has(p.id)} onChange={() => selection.toggle(p.id)} />
                        </td>
                        <td className="col-logo">
                          <PlayerAvatar assetId={p.avatarAssetId} name={p.displayName} />
                        </td>
                        <td>
                          <Link to={`/players/${seg(p.id)}/edit`} className="row-link">
                            {p.displayName}
                          </Link>
                          {p.archived ? <Badge className="ml-6">{t("teams.archived")}</Badge> : null}
                        </td>
                        <td>{p.firstName || <span className="muted">—</span>}</td>
                        <td>{p.lastName || <span className="muted">—</span>}</td>
                        <td>
                          <CountryText code={p.countryCode} />
                        </td>
                        <td>
                          {team ? (
                            <span className="team-cell">
                              <TeamLogo assetId={team.logoAssetId} size={20} name={team.name} /> {team.name}
                              {p.role && p.role !== "player" ? <span className="muted small"> · {roleText(p.role)}</span> : null}
                            </span>
                          ) : (
                            <span className="muted">{t("teams.unassigned")}</span>
                          )}
                        </td>
                        <td className="mono">{p.steamId ?? <NoSteamIdBadge />}</td>
                        <td className="col-actions">
                          {p.archived ? (
                            <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/players/${seg(p.id)}/archive`, { archived: false })} success={t("teams.displaynameRestored", { displayName: p.displayName })} onDone={() => void players.reload()} disabledReason={reason}>{t("teams.restore")}</ActionButton>
                          ) : null}
                          <Button size="sm" onClick={() => navigate(`/players/${seg(p.id)}/edit`)}>{t("teams.edit")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleting([p.id])} disabledReason={reason} aria-label={t("teams.deleteDisplayname", { displayName: p.displayName })}>{t("teams.delete")}</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
      {deleting ? (
        <DeleteDialog
          kind="players"
          ids={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            selection.clear();
            void players.reload();
          }}
        />
      ) : null}
      {importing ? (
        <ImportDialog
          kind="players"
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void players.reload();
          }}
        />
      ) : null}
    </div>
  );
}
