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
import "../styles/group-a.css";
import "../styles/records.css";

export { MatchEditorScreen } from "./matches/MatchEditor.tsx";

/** A short name from a team name: the initials of several words, or the first four letters of one. */
export function shortNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const s = words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 4);
  return s.toUpperCase();
}

const GROUPS: { id: MatchGroup; label: string; empty: string }[] = [
  { id: "current", label: "Current", empty: "No match is in progress. A match moves here when its veto or its first map starts (set its status, or record a map result)." },
  { id: "future", label: "Future", empty: "No upcoming matches. Create a match to prepare a fixture in advance." },
  { id: "ended", label: "Ended", empty: "No completed or cancelled matches yet." },
];

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function TeamCell({ team, right }: { team: TeamRow | undefined; right?: boolean }) {
  return (
    <span className={`match-team ${right ? "is-right" : ""}`}>
      <TeamLogo assetId={team?.logoAssetId} size={28} name={team?.name ?? "?"} />
      <span className="match-team-name">{team?.name ?? <span className="muted">Deleted team</span>}</span>
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
  const teamById = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);
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
        title="Matches"
        actions={
          <>
            {selected.length ? (
              <Button variant="danger" onClick={() => setDeleting(selected)} disabledReason={reason}>
                Delete {selected.length} selected
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => navigate("/matches/new")} disabledReason={reason}>
              Create Match
            </Button>
          </>
        }
      >
        <SearchBox label="Search matches" placeholder="Search teams, title or tournament" value={state.search} onChange={(search) => update({ search })} />
        <Checkbox checked={!!state.filters.archived} onChange={(v) => update({ filters: { ...state.filters, archived: v ? "1" : "" } })} label="Show archived" />
        <span className="active-summary">
          {active ? (
            <>
              <Badge tone="ok" icon="●">
                Active for HUD
              </Badge>{" "}
              {label(active)}{" "}
              <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/live/deactivate-match")} success="No match is active now" onDone={() => void matches.reload()} disabledReason={programReason}>
                Deactivate
              </ActionButton>
            </>
          ) : (
            <span className="muted small">No match is active for the HUDs.</span>
          )}
        </span>
      </ListHeader>
      <Tabs
        label="Match groups"
        value={tab}
        onChange={(t) => {
          selection.clear();
          update({ filters: { ...state.filters, tab: t } });
        }}
        tabs={GROUPS.map((g) => ({ id: g.id, label: `${g.label} (${counts[g.id]})` }))}
      />
      <Async state={matches}>
        {() =>
          all.length === 0 ? (
            <EmptyState
              title="No matches yet"
              action={
                <Button variant="primary" onClick={() => navigate("/matches/new")} disabledReason={reason}>
                  Create Match
                </Button>
              }
            >
              Create a match between two saved teams, set its format and map veto, then make it active for the broadcast.
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title={state.search ? "No matches match the search" : `No ${GROUPS.find((g) => g.id === tab)!.label.toLowerCase()} matches`}>{state.search ? "Change the search." : GROUPS.find((g) => g.id === tab)!.empty}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table records-table matches-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <SelectAll visible={visibleIds} selection={selection} label="Select all matches shown" />
                    </th>
                    <SortHeader label="Team 1" k="teamA" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <th className="col-score">Series</th>
                    <SortHeader label="Team 2" k="teamB" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Format" k="format" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Date and time" k="when" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <SortHeader label="Tournament" k="event" sort={state.sort} onSort={(sort) => update({ sort })} />
                    <th className="col-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className={`${selection.has(m.id) ? "is-selected" : ""} ${m.active ? "is-active" : ""}`}>
                      <td className="col-check">
                        <input type="checkbox" aria-label={`Select ${label(m)}`} checked={selection.has(m.id)} onChange={() => selection.toggle(m.id)} />
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
                      <td>{when(m.scheduledAt) || <span className="muted">Not scheduled</span>}</td>
                      <td>
                        {eventName(m.eventId) ?? <span className="muted">—</span>}
                        {m.title ? <div className="small muted">{m.title}</div> : null}
                        {m.archived ? <Badge>Archived</Badge> : null}
                      </td>
                      <td className="col-actions">
                        {m.active ? (
                          <Badge tone="ok" icon="●" title="HUDs and live state use this match">
                            Active
                          </Badge>
                        ) : (
                          <ActionButton
                            size="sm"
                            action={() => api.post(`/api/v1/matches/${seg(m.id)}/activate`)}
                            success={`${label(m)} is now the active match`}
                            onDone={() => void matches.reload()}
                            disabledReason={programReason ?? (m.archived ? "Restore the match first" : null)}
                            confirm={{ title: `Make ${label(m)} active?`, body: active ? `HUDs and live state switch to this match now; ${label(active)} stops being active. Its status and tab do not change.` : "HUDs and live state switch to this match now. Its status and tab do not change.", confirmLabel: "Make Active" }}
                          >
                            Make Active
                          </ActionButton>
                        )}
                        <Button size="sm" onClick={() => navigate(`/matches/${seg(m.id)}/edit`)} aria-label={`Edit ${label(m)}`}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting([m.id])} disabledReason={reason} aria-label={`Delete ${label(m)}`}>
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
