import { useEffect, useMemo, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { ImportPreviewRow, Player, PlayerDetail, PlayerRow, TeamDetail, TeamRow } from "../api/types.ts";
import { AssetUpload, assetUrl } from "../components/AssetUpload.tsx";
import { ActionButton, Async, Badge, Checkbox, EmptyState, Field, Note, Panel, Tabs } from "../components/ui.tsx";
import { parseRosterImport } from "../lib/csv.ts";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { usePermission } from "../state/session.tsx";

type TeamDraft = { name: string; shortName: string; primaryColor: string | null; secondaryColor: string | null; region: string | null; countryCode: string | null; logoAssetId: string | null };
const EMPTY_TEAM: TeamDraft = { name: "", shortName: "", primaryColor: null, secondaryColor: null, region: null, countryCode: null, logoAssetId: null };

function TeamForm({ initial, revision, teamId, onSaved }: { initial: TeamDraft; revision?: number; teamId?: string; onSaved: (id: string) => void }) {
  const reason = usePermission("metadata.write");
  const [d, setD] = useState<TeamDraft>(initial);
  useEffect(() => setD(initial), [initial]);
  const set = (p: Partial<TeamDraft>) => setD({ ...d, ...p });
  const missing = !d.name.trim() ? "Enter a team name" : !d.shortName.trim() || d.shortName.length > 12 ? "Short name: 1–12 characters" : d.countryCode && d.countryCode.length !== 2 ? "Country code must be 2 letters" : null;
  return (
    <>
      <div className="form-grid">
        <Field label="Name">
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Short name (≤12)">
          <input value={d.shortName} maxLength={12} onChange={(e) => set({ shortName: e.target.value })} />
        </Field>
        <Field label="Region">
          <input value={d.region ?? ""} onChange={(e) => set({ region: e.target.value || null })} />
        </Field>
        <Field label="Country (ISO-2)">
          <input value={d.countryCode ?? ""} maxLength={2} onChange={(e) => set({ countryCode: e.target.value.toUpperCase() || null })} />
        </Field>
        <Field label="Primary colour">
          <div className="row">
            <input type="color" value={d.primaryColor ?? "#2f7cf6"} onChange={(e) => set({ primaryColor: e.target.value })} />
            {d.primaryColor ? (
              <button className="link-btn" onClick={() => set({ primaryColor: null })}>
                clear
              </button>
            ) : (
              <span className="small muted">not set</span>
            )}
          </div>
        </Field>
        <Field label="Secondary colour">
          <div className="row">
            <input type="color" value={d.secondaryColor ?? "#ffffff"} onChange={(e) => set({ secondaryColor: e.target.value })} />
            {d.secondaryColor ? (
              <button className="link-btn" onClick={() => set({ secondaryColor: null })}>
                clear
              </button>
            ) : (
              <span className="small muted">not set</span>
            )}
          </div>
        </Field>
        <AssetUpload label="Logo" value={d.logoAssetId} onChange={(id) => set({ logoAssetId: id })} disabledReason={reason} />
      </div>
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() => (teamId ? api.patch<TeamRow>(`/api/v1/teams/${seg(teamId)}`, { ...d, revision }) : api.post<TeamRow>("/api/v1/teams", d))}
          success={(t) => (teamId ? `Team ${t.name} saved` : `Team ${t.name} created`)}
          onDone={(t) => {
            if (!teamId) setD(EMPTY_TEAM);
            onSaved(t.id);
          }}
          disabledReason={reason ?? missing}
        >
          {teamId ? "Save team" : "Create team"}
        </ActionButton>
        {teamId ? <span className="small muted">Saved with revision check: if someone else edited the team, you'll get a conflict and can reload.</span> : null}
      </div>
    </>
  );
}

function TeamDetailPanel({ teamId, players, onChanged }: { teamId: string; players: PlayerRow[]; onChanged: () => void }) {
  const reason = usePermission("metadata.write");
  const team = useApi<TeamDetail>(`/api/v1/teams/${seg(teamId)}`);
  const [playerId, setPlayerId] = useState("");
  const [role, setRole] = useState("player");
  const reload = () => {
    void team.reload();
    onChanged();
  };
  const initial = useMemo<TeamDraft | null>(() => (team.data ? { name: team.data.name, shortName: team.data.shortName, primaryColor: team.data.primaryColor, secondaryColor: team.data.secondaryColor, region: team.data.region, countryCode: team.data.countryCode, logoAssetId: team.data.logoAssetId } : null), [team.data]);
  return (
    <Async state={team}>
      {(t) => (
        <div className="stack">
          <Panel
            title={t.name}
            subtitle={`${t.shortName} · revision ${t.revision}`}
            actions={
              <ActionButton size="sm" variant="warn" action={() => api.post(`/api/v1/teams/${seg(t.id)}/archive`)} success={`${t.name} archived`} onDone={onChanged} disabledReason={reason} confirm={{ title: `Archive ${t.name}?`, body: "Archived teams are hidden from lists; match history keeps referring to them.", confirmLabel: "Archive" }}>
                Archive
              </ActionButton>
            }
          >
            {initial ? <TeamForm initial={initial} revision={t.revision} teamId={t.id} onSaved={reload} /> : null}
          </Panel>
          <Panel title={`Current roster (${t.roster.length})`} subtitle="Joining another team closes the previous membership; history is preserved">
            {t.roster.length === 0 ? (
              <EmptyState title="No players on this roster">Add players below (create them in the Players tab first).</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Role</th>
                    <th>Since</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {t.roster.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.player?.displayName ?? m.playerId}
                        <div className="small muted">{m.player?.steamId ?? "no SteamID"}</div>
                      </td>
                      <td>{m.role.replace("_", " ")}</td>
                      <td className="small">{fmtTime(m.validFrom)}</td>
                      <td>
                        <ActionButton size="sm" action={() => api.del(`/api/v1/teams/${seg(t.id)}/roster/${seg(m.playerId)}`)} success={`${m.player?.displayName ?? "Player"} left ${t.name}`} onDone={reload} disabledReason={reason} reasonPlacement="tooltip" confirm={{ title: `Remove ${m.player?.displayName ?? "player"} from ${t.name}?`, body: "Closes the membership (kept in history)." }}>
                          Leave
                        </ActionButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="row-end" style={{ marginTop: 10 }}>
              <Field label="Add player">
                <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
                  <option value="">choose…</option>
                  {players
                    .filter((p) => !t.roster.some((m) => m.playerId === p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                        {p.teamId ? " (on another team — will transfer)" : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Role">
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="player">Player</option>
                  <option value="substitute">Substitute</option>
                  <option value="stand_in">Stand-in</option>
                  <option value="coach">Coach</option>
                </select>
              </Field>
              <ActionButton action={() => api.post(`/api/v1/teams/${seg(t.id)}/roster`, { playerId, role })} success="Roster updated" onDone={() => {
                  setPlayerId("");
                  reload();
                }} disabledReason={reason ?? (playerId ? null : "Choose a player")}>
                Join roster
              </ActionButton>
            </div>
          </Panel>
        </div>
      )}
    </Async>
  );
}

function TeamsTab() {
  const [archived, setArchived] = useState(false);
  const teams = useApi<TeamRow[]>(`/api/v1/teams${archived ? "?archived=1" : ""}`);
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const [sel, setSel] = useState<string | null>(null);
  return (
    <div className="grid-1-2">
      <div className="stack">
        <Panel title="Teams" actions={<Checkbox checked={archived} onChange={setArchived} label="Show archived" />}>
          <Async state={teams}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No teams">Create a team below; then add players to its roster.</EmptyState>
              ) : (
                <ul className="select-list">
                  {list.map((t) => (
                    <li key={t.id}>
                      <button className={sel === t.id ? "is-selected" : ""} onClick={() => setSel(t.id)}>
                        {assetUrl(t.logoAssetId) ? <img className="thumb" src={assetUrl(t.logoAssetId)!} alt="" /> : <span className="dot" style={{ background: t.primaryColor ?? "var(--line-strong)" }} aria-hidden />}
                        <span style={{ flex: 1 }}>
                          <strong>{t.name}</strong> <span className="muted small">{t.shortName}</span>
                        </span>
                        {t.archived ? <Badge>ARCHIVED</Badge> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </Panel>
        <Panel title="New team">
          <TeamForm
            initial={EMPTY_TEAM}
            onSaved={(id) => {
              setSel(id);
              void teams.reload();
            }}
          />
        </Panel>
      </div>
      {sel ? (
        <TeamDetailPanel
          key={sel}
          teamId={sel}
          players={players.data ?? []}
          onChanged={() => {
            void teams.reload();
            void players.reload();
          }}
        />
      ) : (
        <EmptyState title="Select a team">Choose a team to edit its details and roster.</EmptyState>
      )}
    </div>
  );
}

type PlayerDraft = Pick<Player, "displayName" | "realName" | "steamId" | "countryCode" | "avatarAssetId" | "aliases" | "photoVisible" | "cameraConsent" | "cameraSourceId">;
const EMPTY_PLAYER: PlayerDraft = { displayName: "", realName: null, steamId: null, countryCode: null, avatarAssetId: null, aliases: [], photoVisible: true, cameraConsent: false, cameraSourceId: null };

function PlayerForm({ initial, playerId, revision, onSaved }: { initial: PlayerDraft; playerId?: string; revision?: number; onSaved: (id: string) => void }) {
  const reason = usePermission("metadata.write");
  const [d, setD] = useState<PlayerDraft>(initial);
  const [aliases, setAliases] = useState(initial.aliases.join(", "));
  useEffect(() => {
    setD(initial);
    setAliases(initial.aliases.join(", "));
  }, [initial]);
  const set = (p: Partial<PlayerDraft>) => setD({ ...d, ...p });
  const missing = !d.displayName.trim() ? "Enter a display name" : d.steamId && !/^\d{1,20}$/.test(d.steamId) ? "SteamID64 must be digits (kept as text)" : d.countryCode && d.countryCode.length !== 2 ? "Country code must be 2 letters" : null;
  return (
    <>
      <div className="form-grid">
        <Field label="Display name">
          <input value={d.displayName} onChange={(e) => set({ displayName: e.target.value })} />
        </Field>
        <Field label="Real name">
          <input value={d.realName ?? ""} onChange={(e) => set({ realName: e.target.value || null })} />
        </Field>
        <Field label="SteamID64" hint="17 digits; links telemetry to this player">
          <input className="mono" inputMode="numeric" value={d.steamId ?? ""} onChange={(e) => set({ steamId: e.target.value.trim() || null })} />
        </Field>
        <Field label="Country (ISO-2)">
          <input value={d.countryCode ?? ""} maxLength={2} onChange={(e) => set({ countryCode: e.target.value.toUpperCase() || null })} />
        </Field>
        <Field label="Aliases (comma separated)">
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Field>
        <AssetUpload label="Avatar" value={d.avatarAssetId} onChange={(id) => set({ avatarAssetId: id })} disabledReason={reason} />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Checkbox checked={d.photoVisible} onChange={(v) => set({ photoVisible: v })} label="Photo may be shown on air" />
        <Checkbox checked={d.cameraConsent} onChange={(v) => set({ cameraConsent: v })} label="Player-camera consent" />
        <Field label="Camera source id">
          <input value={d.cameraSourceId ?? ""} onChange={(e) => set({ cameraSourceId: e.target.value || null })} placeholder="e.g. pcam-desk-3" />
        </Field>
      </div>
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() => {
            const body = { ...d, aliases: aliases.split(",").map((s) => s.trim()).filter(Boolean) };
            return playerId ? api.patch<Player>(`/api/v1/players/${seg(playerId)}`, { ...body, revision }) : api.post<Player>("/api/v1/players", body);
          }}
          success={(p) => (playerId ? `${p.displayName} saved` : `${p.displayName} created`)}
          onDone={(p) => {
            if (!playerId) setD(EMPTY_PLAYER);
            onSaved(p.id);
          }}
          disabledReason={reason ?? missing}
        >
          {playerId ? "Save player" : "Create player"}
        </ActionButton>
      </div>
    </>
  );
}

function PlayerDetailPanel({ playerId, players, teams, onChanged }: { playerId: string; players: PlayerRow[]; teams: TeamRow[]; onChanged: () => void }) {
  const reason = usePermission("metadata.write");
  const p = useApi<PlayerDetail>(`/api/v1/players/${seg(playerId)}`);
  const [dup, setDup] = useState("");
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const initial = useMemo<PlayerDraft | null>(() => (p.data ? { displayName: p.data.displayName, realName: p.data.realName, steamId: p.data.steamId, countryCode: p.data.countryCode, avatarAssetId: p.data.avatarAssetId, aliases: p.data.aliases, photoVisible: p.data.photoVisible, cameraConsent: p.data.cameraConsent, cameraSourceId: p.data.cameraSourceId } : null), [p.data]);
  return (
    <Async state={p}>
      {(pl) => (
        <div className="stack">
          <Panel title={pl.displayName} subtitle={`revision ${pl.revision}${pl.aliases.length ? ` · aka ${pl.aliases.join(", ")}` : ""}`}>
            {initial ? (
              <PlayerForm
                initial={initial}
                playerId={pl.id}
                revision={pl.revision}
                onSaved={() => {
                  void p.reload();
                  onChanged();
                }}
              />
            ) : null}
          </Panel>
          <Panel title="Roster history">
            {pl.history.length === 0 ? (
              <p className="muted small">Never rostered.</p>
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
                  {pl.history.map((h) => (
                    <tr key={h.id}>
                      <td>{teamName(h.teamId)}</td>
                      <td>{h.role.replace("_", " ")}</td>
                      <td className="small">{fmtTime(h.validFrom)}</td>
                      <td className="small">{h.validTo ? fmtTime(h.validTo) : <Badge tone="ok">CURRENT</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="Merge a duplicate into this player">
            <p className="small muted">The duplicate's roster history and SteamID move here; its name becomes an alias and the duplicate is archived.</p>
            <div className="row-end">
              <Field label="Duplicate">
                <select value={dup} onChange={(e) => setDup(e.target.value)}>
                  <option value="">choose…</option>
                  {players
                    .filter((x) => x.id !== pl.id)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.displayName} {x.steamId ? `(${x.steamId})` : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <ActionButton
                variant="warn"
                action={() => api.post<Player>(`/api/v1/players/${seg(pl.id)}/merge`, { duplicateId: dup })}
                success={(m) => `Merged into ${m.displayName}`}
                onDone={() => {
                  setDup("");
                  void p.reload();
                  onChanged();
                }}
                disabledReason={reason ?? (dup ? null : "Choose the duplicate player")}
                confirm={{ title: "Merge players?", body: `Merge ${players.find((x) => x.id === dup)?.displayName ?? "the duplicate"} into ${pl.displayName}. This cannot be undone from the console.`, confirmLabel: "Merge", danger: true }}
              >
                Merge
              </ActionButton>
            </div>
          </Panel>
        </div>
      )}
    </Async>
  );
}

function PlayersTab() {
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const teams = useApi<TeamRow[]>("/api/v1/teams");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const teamName = (id: string | null) => (id ? (teams.data?.find((t) => t.id === id)?.shortName ?? "?") : null);
  return (
    <div className="grid-1-2">
      <div className="stack">
        <Panel title="Players" actions={<input aria-label="Search players" placeholder="Search name or SteamID" value={q} onChange={(e) => setQ(e.target.value)} />}>
          <Async state={players}>
            {(list) => {
              const f = list.filter((p) => !q || p.displayName.toLowerCase().includes(q.toLowerCase()) || (p.steamId ?? "").includes(q) || p.aliases.some((a) => a.toLowerCase().includes(q.toLowerCase())));
              return list.length === 0 ? (
                <EmptyState title="No players">Create players below or bulk-import a CSV/JSON roster in the Import tab.</EmptyState>
              ) : (
                <ul className="select-list">
                  {f.map((p) => (
                    <li key={p.id}>
                      <button className={sel === p.id ? "is-selected" : ""} onClick={() => setSel(p.id)}>
                        {assetUrl(p.avatarAssetId) ? <img className="thumb" src={assetUrl(p.avatarAssetId)!} alt="" /> : null}
                        <span style={{ flex: 1 }}>
                          <strong>{p.displayName}</strong> <span className="muted small mono">{p.steamId ?? "no SteamID"}</span>
                        </span>
                        {teamName(p.teamId) ? <Badge>{teamName(p.teamId)}</Badge> : <span className="muted small">free agent</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              );
            }}
          </Async>
        </Panel>
        <Panel title="New player">
          <PlayerForm
            initial={EMPTY_PLAYER}
            onSaved={(id) => {
              setSel(id);
              void players.reload();
            }}
          />
        </Panel>
      </div>
      {sel ? <PlayerDetailPanel key={sel} playerId={sel} players={players.data ?? []} teams={teams.data ?? []} onChanged={() => void players.reload()} /> : <EmptyState title="Select a player">Choose a player to edit details, see roster history or merge duplicates.</EmptyState>}
    </div>
  );
}

function ImportTab() {
  const reason = usePermission("metadata.write");
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null);
  const [skipDup, setSkipDup] = useState(true);
  const [result, setResult] = useState<{ created: string[]; skipped: number[] } | null>(null);
  const nameOf = (id: string | null | undefined) => players.data?.find((p) => p.id === id)?.displayName ?? id ?? "";
  const okRows = preview?.filter((r) => r.ok && r.data) ?? [];
  return (
    <div className="stack">
      <Panel title="1 · Paste or load a roster" subtitle="CSV with a header row (displayName, realName, steamId, team, countryCode) or a JSON array">
        <div className="row" style={{ marginBottom: 8 }}>
          <input
            type="file"
            accept=".csv,.json,.txt,text/csv,application/json"
            aria-label="Load roster file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
            }}
          />
        </div>
        <textarea className="mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={"displayName,realName,steamId,team,countryCode\nkaizen,Kai Brown,76561198000000001,Blue Sharks,GB"} />
        <div className="form-actions">
          <ActionButton
            variant="primary"
            action={async () => {
              setParseError(null);
              setResult(null);
              let rows: Record<string, string>[];
              try {
                rows = parseRosterImport(text);
              } catch (e) {
                setParseError(e instanceof Error ? e.message : String(e));
                throw new Error("Could not parse the input as CSV or JSON");
              }
              if (rows.length === 0) throw new Error("No rows found (CSV needs a header row)");
              return api.post<ImportPreviewRow[]>("/api/v1/import/players/preview", { rows });
            }}
            success={(r) => `${r.filter((x) => x.ok).length}/${r.length} rows valid`}
            onDone={setPreview}
            disabledReason={reason ?? (text.trim() ? null : "Paste CSV/JSON or load a file")}
          >
            Preview import
          </ActionButton>
          {parseError ? <span className="text-danger small">{parseError}</span> : null}
        </div>
      </Panel>
      {preview ? (
        <Panel title="2 · Review" subtitle="Nothing has been written yet">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>#</th>
                <th>Status</th>
                <th>Display name</th>
                <th>SteamID</th>
                <th>Team</th>
                <th>Duplicate?</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.row}>
                  <td>{r.row + 1}</td>
                  <td>{r.ok ? <Badge tone="ok">OK</Badge> : <Badge tone="danger">INVALID</Badge>}</td>
                  <td>{r.data?.displayName ?? MISSING}</td>
                  <td className="mono small">{r.data?.steamId ?? MISSING}</td>
                  <td>{r.data?.team ?? MISSING}</td>
                  <td>
                    {r.duplicateReason ? (
                      <Badge tone="warn" title={`Matches existing player ${nameOf(r.duplicateOf)}`}>
                        DUPLICATE ({r.duplicateReason === "steamId" ? "SteamID" : "name"}) → {nameOf(r.duplicateOf)}
                      </Badge>
                    ) : (
                      <span className="muted small">new</span>
                    )}
                  </td>
                  <td className="small text-danger">{r.errors.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions">
            <Checkbox checked={skipDup} onChange={setSkipDup} label="Skip rows whose SteamID already exists" />
            <ActionButton
              variant="primary"
              action={() => api.post<{ created: string[]; skipped: number[] }>("/api/v1/import/players/commit", { rows: okRows.map((r) => r.data), skipDuplicates: skipDup })}
              success={(r) => `${r.created.length} player(s) created, ${r.skipped.length} skipped`}
              onDone={(r) => {
                setResult(r);
                setPreview(null);
                void players.reload();
              }}
              disabledReason={reason ?? (okRows.length ? null : "No valid rows to import")}
              confirm={{ title: `Import ${okRows.length} player(s)?`, body: "Name-only duplicates are created as new players (merge them afterwards). Team names are matched to existing teams." }}
            >
              Commit {okRows.length} row(s)
            </ActionButton>
          </div>
        </Panel>
      ) : null}
      {result ? (
        <Note tone="ok" title="IMPORTED">
          {result.created.length} created; {result.skipped.length} skipped (rows {result.skipped.map((i) => i + 1).join(", ") || "none"}).
        </Note>
      ) : null}
    </div>
  );
}

export function TeamsScreen() {
  const [tab, setTab] = usePersistentState<"teams" | "players" | "import">("teamsTab", "teams");
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Teams &amp; Players</h1>
      </div>
      <Tabs
        label="Teams and players"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "teams", label: "Teams" },
          { id: "players", label: "Players" },
          { id: "import", label: "Import" },
        ]}
      />
      {tab === "teams" ? <TeamsTab /> : null}
      {tab === "players" ? <PlayersTab /> : null}
      {tab === "import" ? <ImportTab /> : null}
    </div>
  );
}
