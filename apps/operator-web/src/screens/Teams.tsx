import { useEffect, useMemo, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { PlayerRow, TeamRow } from "../api/types.ts";
import { assetUrl } from "../components/AssetUpload.tsx";
import { Combobox, CountryText, Flag, TeamLogo } from "../components/forms.tsx";
import { ListHeader, SearchBox, SelectAll, SortHeader, useSelection } from "../components/listing.tsx";
import { DeleteDialog, ImportDialog } from "../components/RecordDialogs.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, EmptyState } from "../components/ui.tsx";
import { countryLabel } from "../lib/flags.ts";
import { useApi } from "../lib/hooks.ts";
import { sortRows, useListState, useRestoreScroll } from "../lib/listState.ts";
import { Link, navigate } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
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
      <label htmlFor={id} className="filter-label">
        Country
      </label>
      <Combobox id={id} options={options} value={value || null} onChange={(v) => onChange(v ?? "")} emptyLabel="All countries" placeholder="Search countries" />
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
    const list = (teams.data ?? []).filter((t) => (!q || norm(t.name).includes(q) || norm(t.shortName).includes(q)) && (!state.filters.country || t.countryCode === state.filters.country));
    return sortRows(list, state.sort, (t, k) => (k === "country" ? (t.countryCode ? countryLabel(t.countryCode) : "") : k === "players" ? t.playerCount : t[k as keyof TeamRow]));
  }, [teams.data, state]);
  const visibleIds = rows.map((t) => t.id);
  useEffect(() => selection.keep(visibleIds), [visibleIds.join(",")]);
  useRestoreScroll(state.scrollTop, teams.data !== undefined);
  const selected = [...selection.ids];
  return (
    <div className="page list-page">
      <ListHeader
        title="Teams"
        count={teams.data ? rows.length : undefined}
        actions={
          <>
            {selected.length ? (
              <Button variant="danger" onClick={() => setDeleting(selected)} disabledReason={reason}>
                Delete {selected.length} selected
              </Button>
            ) : null}
            <Button onClick={() => setImporting(true)} disabledReason={reason}>
              Import Teams
            </Button>
            <Button variant="primary" onClick={() => navigate("/teams/new")} disabledReason={reason}>
              Add Team
            </Button>
          </>
        }
      >
        <SearchBox label="Search teams" placeholder="Search team or short name" value={state.search} onChange={(search) => update({ search })} />
        <CountryFilter id="teams-country" codes={(teams.data ?? []).map((t) => t.countryCode)} value={state.filters.country} onChange={(country) => update({ filters: { ...state.filters, country } })} />
        <Checkbox checked={!!state.filters.archived} onChange={(v) => update({ filters: { ...state.filters, archived: v ? "1" : "" } })} label="Show archived" />
      </ListHeader>
      <Async state={teams}>
        {(all) =>
          all.length === 0 ? (
            <EmptyState
              title="No teams yet"
              action={
                <>
                  <Button variant="primary" onClick={() => navigate("/teams/new")} disabledReason={reason}>
                    Add Team
                  </Button>
                  <Button onClick={() => setImporting(true)} disabledReason={reason}>
                    Import Teams
                  </Button>
                </>
              }
            >
              Add each team with its name, short name, country and logo. Teams are then available in the player and match editors.
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title="No teams match">Change the search or the country filter.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table records-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <SelectAll visible={visibleIds} selection={selection} label="Select all teams shown" />
                    </th>
                    <th className="col-logo">Logo</th>
                    <SortHeader label="Team name" k="name" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Short name" k="shortName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Country" k="country" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Players" k="players" sort={state.sort} onSort={(sort) => update({ sort })} className="col-num" />
                    <th className="col-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className={selection.has(t.id) ? "is-selected" : ""}>
                      <td className="col-check">
                        <input type="checkbox" aria-label={`Select ${t.name}`} checked={selection.has(t.id)} onChange={() => selection.toggle(t.id)} />
                      </td>
                      <td className="col-logo">
                        <TeamLogo assetId={t.logoAssetId} name={t.name} size={32} />
                      </td>
                      <td>
                        <Link to={`/teams/${seg(t.id)}/edit`} className="row-link">
                          {t.name}
                        </Link>
                        {t.archived ? <Badge className="ml-6">Archived</Badge> : null}
                      </td>
                      <td>{t.shortName}</td>
                      <td>
                        <CountryText code={t.countryCode} />
                      </td>
                      <td className="col-num">{t.playerCount}</td>
                      <td className="col-actions">
                        {t.archived ? (
                          <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/teams/${seg(t.id)}/archive`, { archived: false })} success={`${t.name} restored`} onDone={() => void teams.reload()} disabledReason={reason}>
                            Restore
                          </ActionButton>
                        ) : null}
                        <Button size="sm" onClick={() => navigate(`/teams/${seg(t.id)}/edit`)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting([t.id])} disabledReason={reason} aria-label={`Delete ${t.name}`}>
                          Delete
                        </Button>
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

export function PlayerAvatar({ assetId, name, size = 32 }: { assetId: string | null | undefined; name: string; size?: number }) {
  const url = assetUrl(assetId);
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {url ? <img src={url} alt={`${name} avatar`} /> : <span aria-hidden>{name.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

/** "Won't match live CS2 data": a player without a SteamID64. */
export function NoSteamIdBadge() {
  return (
    <Badge tone="warn" title="Without a SteamID64 this player cannot be matched to the live CS2 game data. Add it in the player's editor.">
      No SteamID64 · won't match live CS2 data
    </Badge>
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
  const teamById = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);
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
  const teamOptions = useMemo(() => [{ key: "__none", label: "Unassigned" }, ...(teams.data ?? []).filter((t) => !t.archived).map((t) => ({ key: t.id, label: t.name, keywords: t.shortName, icon: <TeamLogo assetId={t.logoAssetId} size={18} name={t.name} /> }))], [teams.data]);
  const selected = [...selection.ids];
  return (
    <div className="page list-page">
      <ListHeader
        title="Players"
        count={players.data ? rows.length : undefined}
        actions={
          <>
            {selected.length ? (
              <Button variant="danger" onClick={() => setDeleting(selected)} disabledReason={reason}>
                Delete {selected.length} selected
              </Button>
            ) : null}
            <Button onClick={() => setImporting(true)} disabledReason={reason}>
              Import Players
            </Button>
            <Button variant="primary" onClick={() => navigate("/players/new")} disabledReason={reason}>
              Add Player
            </Button>
          </>
        }
      >
        <SearchBox label="Search players" placeholder="Search nickname, real name or SteamID64" value={state.search} onChange={(search) => update({ search })} />
        <div className="filter">
          <label htmlFor="players-team" className="filter-label">
            Team
          </label>
          <Combobox id="players-team" options={teamOptions} value={state.filters.team || null} onChange={(team) => update({ filters: { ...state.filters, team: team ?? "" } })} emptyLabel="All teams" placeholder="Search teams" />
        </div>
        <CountryFilter id="players-country" codes={(players.data ?? []).map((p) => p.countryCode)} value={state.filters.country} onChange={(country) => update({ filters: { ...state.filters, country } })} />
        <Checkbox checked={!!state.filters.archived} onChange={(v) => update({ filters: { ...state.filters, archived: v ? "1" : "" } })} label="Show archived" />
      </ListHeader>
      <Async state={players}>
        {(all) =>
          all.length === 0 ? (
            <EmptyState
              title="No players yet"
              action={
                <>
                  <Button variant="primary" onClick={() => navigate("/players/new")} disabledReason={reason}>
                    Add Player
                  </Button>
                  <Button onClick={() => setImporting(true)} disabledReason={reason}>
                    Import Players
                  </Button>
                </>
              }
            >
              Add players with their nickname, names, country, SteamID64 and team. The SteamID64 links a player to the live CS2 game data.
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title="No players match">Change the search or the filters.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table records-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <SelectAll visible={visibleIds} selection={selection} label="Select all players shown" />
                    </th>
                    <th className="col-logo">Avatar</th>
                    <SortHeader label="Nickname" k="displayName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="First name" k="firstName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Last name" k="lastName" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Country" k="country" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Team" k="team" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="SteamID64" k="steamId" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <th className="col-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const team = p.teamId ? teamById.get(p.teamId) : undefined;
                    return (
                      <tr key={p.id} className={selection.has(p.id) ? "is-selected" : ""}>
                        <td className="col-check">
                          <input type="checkbox" aria-label={`Select ${p.displayName}`} checked={selection.has(p.id)} onChange={() => selection.toggle(p.id)} />
                        </td>
                        <td className="col-logo">
                          <PlayerAvatar assetId={p.avatarAssetId} name={p.displayName} />
                        </td>
                        <td>
                          <Link to={`/players/${seg(p.id)}/edit`} className="row-link">
                            {p.displayName}
                          </Link>
                          {p.archived ? <Badge className="ml-6">Archived</Badge> : null}
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
                            <span className="muted">Unassigned</span>
                          )}
                        </td>
                        <td className="mono">{p.steamId ?? <NoSteamIdBadge />}</td>
                        <td className="col-actions">
                          {p.archived ? (
                            <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/players/${seg(p.id)}/archive`, { archived: false })} success={`${p.displayName} restored`} onDone={() => void players.reload()} disabledReason={reason}>
                              Restore
                            </ActionButton>
                          ) : null}
                          <Button size="sm" onClick={() => navigate(`/players/${seg(p.id)}/edit`)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleting([p.id])} disabledReason={reason} aria-label={`Delete ${p.displayName}`}>
                            Delete
                          </Button>
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
