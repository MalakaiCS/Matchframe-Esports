import { useEffect, useMemo, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { EventRecord, MatchGroup, MatchRow, TeamRow } from "../api/types.ts";
import { TeamLogo } from "../components/forms.tsx";
import { ListHeader, SearchBox, SelectAll, SortHeader, useSelection } from "../components/listing.tsx";
import { DeleteDialog } from "../components/RecordDialogs.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, EmptyState, Tabs } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { sortRows, useListState, useRestoreScroll } from "../lib/listState.ts";
import { navigate } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import { perLocale, t } from "../i18n/index.ts";
import "../styles/group-a.css";
import "../styles/records.css";

export { MatchEditorScreen } from "./matches/MatchEditor.tsx";

/** A short name from a team name: the initials of several words, or the first four letters of one. */
export function shortNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const s = words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 4);
  return s.toUpperCase();
}

const GROUPS: { id: MatchGroup; label: string; none: string; empty: string }[] = perLocale(() => ([
  { id: "current", label: t("matches.current"), none: t("matches.noCurrentMatches"), empty: t("matches.noMatchIsInProgress") },
  { id: "future", label: t("matches.future"), none: t("matches.noFutureMatches"), empty: t("matches.noUpcomingMatchesCreateA") },
  { id: "ended", label: t("matches.ended"), none: t("matches.noEndedMatches"), empty: t("matches.noCompletedOrCancelledMatches") },
]));

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function TeamCell({ team, right }: { team: TeamRow | undefined; right?: boolean }) {
  return (
    <span className={`match-team ${right ? "is-right" : ""}`}>
      <TeamLogo assetId={team?.logoAssetId} size={28} name={team?.name ?? "?"} />
      <span className="match-team-name">{team?.name ?? <span className="muted">{t("matches.deletedTeam")}</span>}</span>
    </span>
  );
}

export function MatchesScreen() {
  const reason = usePermission("metadata.write");
  const programReason = usePermission("program.control");
  const { state, update } = useListState<{ tab: string; archived: string }>("matches", { search: "", filters: { tab: "", archived: "" }, sort: { key: "when", dir: "asc" } });
  const matches = useApi<MatchRow[]>(`/api/v1/matches${state.filters.archived ? "?archived=1" : ""}`);
  const teams = useApi<TeamRow[]>("/api/v1/teams?archived=1");
  const events = useApi<EventRecord[]>("/api/v1/events");
  const selection = useSelection();
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const teamById = useMemo(() => new Map((teams.data ?? []).map((tRow) => [tRow.id, tRow])), [teams.data]);
  const eventName = (id: string | null) => (id ? (events.data ?? []).find((e) => e.id === id)?.name : undefined);
  const all = matches.data ?? [];
  const tab = (state.filters.tab as MatchGroup) || (all.some((m) => m.group === "current") ? "current" : "future");
  const counts = { current: 0, future: 0, ended: 0 } as Record<MatchGroup, number>;
  for (const m of all) counts[m.group]++;
  const active = all.find((m) => m.active);
  const rows = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    const list = (matches.data ?? []).filter((m) => {
      if (m.group !== tab) return false;
      if (!q) return true;
      const text = [teamById.get(m.teamAId)?.name, teamById.get(m.teamAId)?.shortName, teamById.get(m.teamBId)?.name, teamById.get(m.teamBId)?.shortName, m.title, eventName(m.eventId)].join(" ").toLowerCase();
      return text.includes(q);
    });
    // Future matches soonest first; ended ones most recent first unless sorted otherwise.
    return sortRows(list, state.sort, (m, k) => (k === "when" ? m.scheduledAt : k === "teamA" ? teamById.get(m.teamAId)?.name : k === "teamB" ? teamById.get(m.teamBId)?.name : k === "format" ? m.format.bestOf : k === "event" ? eventName(m.eventId) : null));
  }, [matches.data, state.search, state.sort, tab, teamById, events.data]);
  const visibleIds = rows.map((m) => m.id);
  useEffect(() => selection.keep(visibleIds), [visibleIds.join(",")]);
  useRestoreScroll(state.scrollTop, matches.data !== undefined);
  const selected = [...selection.ids];
  const label = (m: MatchRow) => `${teamById.get(m.teamAId)?.name ?? "?"} vs ${teamById.get(m.teamBId)?.name ?? "?"}`;
  return (
    <div className="page list-page">
      <ListHeader
        title={t("matches.matches")}
        actions={
          <>
            {selected.length ? (
              <Button variant="danger" onClick={() => setDeleting(selected)} disabledReason={reason}>{t("matches.deleteCountSelected", { count: selected.length })}</Button>
            ) : null}
            <Button variant="primary" onClick={() => navigate("/matches/new")} disabledReason={reason}>{t("matches.createMatch")}</Button>
          </>
        }
      >
        <SearchBox label={t("matches.searchMatches")} placeholder={t("matches.searchTeamsTitleOrTournament")} value={state.search} onChange={(search) => update({ search })} />
        <Checkbox checked={!!state.filters.archived} onChange={(v) => update({ filters: { ...state.filters, archived: v ? "1" : "" } })} label={t("matches.showArchived")} />
        <span className="active-summary">
          {active ? (
            <>
              <Badge tone="ok" icon="●">{t("matches.activeForHud")}</Badge>{" "}
              {label(active)}{" "}
              <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/live/deactivate-match")} success={t("matches.noMatchIsActiveNow")} onDone={() => void matches.reload()} disabledReason={programReason}>{t("matches.deactivate")}</ActionButton>
            </>
          ) : (
            <span className="muted small">{t("matches.noMatchIsActiveFor")}</span>
          )}
        </span>
      </ListHeader>
      <Tabs
        label={t("matches.matchGroups")}
        value={tab}
        onChange={(tRow) => {
          selection.clear();
          update({ filters: { ...state.filters, tab: tRow } });
        }}
        tabs={GROUPS.map((g) => ({ id: g.id, label: `${g.label} (${counts[g.id]})` }))}
      />
      <Async state={matches}>
        {() =>
          all.length === 0 ? (
            <EmptyState
              title={t("matches.noMatchesYet")}
              action={
                <Button variant="primary" onClick={() => navigate("/matches/new")} disabledReason={reason}>{t("matches.createMatch")}</Button>
              }
            >{t("matches.createAMatchBetweenTwo")}</EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title={state.search ? t("matches.noMatchesMatchTheSearch") : GROUPS.find((g) => g.id === tab)!.none}>{state.search ? t("matches.changeTheSearch") : GROUPS.find((g) => g.id === tab)!.empty}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table records-table matches-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <SelectAll visible={visibleIds} selection={selection} label={t("matches.selectAllMatchesShown")} />
                    </th>
                    <SortHeader label={t("matches.team1")} k="teamA" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <th className="col-score">{t("matches.series")}</th>
                    <SortHeader label={t("matches.team2")} k="teamB" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("matches.format")} k="format" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("matches.dateAndTime")} k="when" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label={t("matches.tournament")} k="event" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <th className="col-actions">
                      <span className="sr-only">{t("matches.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className={`${selection.has(m.id) ? "is-selected" : ""} ${m.active ? "is-active" : ""}`}>
                      <td className="col-check">
                        <input type="checkbox" aria-label={t("matches.selectM", { m: label(m) })} checked={selection.has(m.id)} onChange={() => selection.toggle(m.id)} />
                      </td>
                      <td>
                        <TeamCell team={teamById.get(m.teamAId)} />
                      </td>
                      <td className="col-score">
                        <span className="series-score">
                          <b className={m.seriesScoreA > m.seriesScoreB ? "is-lead" : ""}>{m.seriesScoreA}</b>
                          <i>–</i>
                          <b className={m.seriesScoreB > m.seriesScoreA ? "is-lead" : ""}>{m.seriesScoreB}</b>
                        </span>
                      </td>
                      <td>
                        <TeamCell team={teamById.get(m.teamBId)} />
                      </td>
                      <td>BO{m.format.bestOf}</td>
                      <td>{when(m.scheduledAt) || <span className="muted">{t("matches.notScheduled")}</span>}</td>
                      <td>
                        {eventName(m.eventId) ?? <span className="muted">—</span>}
                        {m.title ? <div className="small muted">{m.title}</div> : null}
                        {m.archived ? <Badge>{t("matches.archived")}</Badge> : null}
                      </td>
                      <td className="col-actions">
                        {m.active ? (
                          <Badge tone="ok" icon="●" title={t("matches.hudsAndLiveStateUse")}>{t("matches.active")}</Badge>
                        ) : (
                          <ActionButton
                            size="sm"
                            action={() => api.post(`/api/v1/matches/${seg(m.id)}/activate`)}
                            success={t("matches.mIsNowTheActive", { m: label(m) })}
                            onDone={() => void matches.reload()}
                            disabledReason={programReason ?? (m.archived ? t("matches.restoreTheMatchFirst") : null)}
                            confirm={{ title: t("matches.makeMActive", { m: label(m) }), body: active ? t("matches.hudsAndLiveStateSwitch2", { active: label(active) }) : t("matches.hudsAndLiveStateSwitch"), confirmLabel: t("matches.makeActive") }}
                          >{t("matches.makeActive")}</ActionButton>
                        )}
                        <Button size="sm" onClick={() => navigate(`/matches/${seg(m.id)}/edit`)} aria-label={t("matches.editM", { m: label(m) })}>{t("matches.edit")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting([m.id])} disabledReason={reason} aria-label={t("matches.deleteM", { m: label(m) })}>{t("matches.delete")}</Button>
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
          kind="matches"
          ids={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            selection.clear();
            void matches.reload();
          }}
        />
      ) : null}
    </div>
  );
}
