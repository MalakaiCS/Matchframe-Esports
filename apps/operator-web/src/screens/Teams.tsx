import { useEffect, useMemo, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { ImportPreviewRow, Player, PlayerDetail, PlayerRow, TeamDetail, TeamRow } from "../api/types.ts";
import { AssetUpload, assetUrl } from "../components/AssetUpload.tsx";
import { ActionButton, Async, Badge, Button, Checkbox, Details, EmptyState, Field, Note, Panel, Tabs } from "../components/ui.tsx";
import { parseRosterImport } from "../lib/csv.ts";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-a.css";

type TeamDraft = { name: string; shortName: string; primaryColor: string | null; secondaryColor: string | null; region: string | null; countryCode: string | null; logoAssetId: string | null };
const EMPTY_TEAM: TeamDraft = { name: "", shortName: "", primaryColor: null, secondaryColor: null, region: null, countryCode: null, logoAssetId: null };

const roleText = (r: string) => {
  const s = r.replace("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function ColourField({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (v: string | null) => void }) {
  return (
    <Field label={label}>
      <div className="row">
        <input type="color" value={value ?? fallback} onChange={(e) => onChange(e.target.value)} />
        {value ? (
          <button className="link-btn" onClick={() => onChange(null)}>
            Clear
          </button>
        ) : (
          <span className="small muted">Not set</span>
        )}
      </div>
    </Field>
  );
}

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
        <Field label="Short name">
          <input value={d.shortName} maxLength={12} placeholder="Up to 12 characters" onChange={(e) => set({ shortName: e.target.value })} />
        </Field>
        <Field label="Region">
          <input value={d.region ?? ""} onChange={(e) => set({ region: e.target.value || null })} />
        </Field>
        <Field label="Country code">
          <input value={d.countryCode ?? ""} maxLength={2} placeholder="e.g. GB" title="Two-letter ISO country code" onChange={(e) => set({ countryCode: e.target.value.toUpperCase() || null })} />
        </Field>
        <ColourField label="Primary colour" value={d.primaryColor} fallback="#2f7cf6" onChange={(v) => set({ primaryColor: v })} />
        <ColourField label="Secondary colour" value={d.secondaryColor} fallback="#ffffff" onChange={(v) => set({ secondaryColor: v })} />
        <AssetUpload label="Logo" value={d.logoAssetId} onChange={(id) => set({ logoAssetId: id })} disabledReason={reason} />
      </div>
      <div className="form-actions">
        <ActionButton
          variant="primary"
          title={teamId ? `Saved with a revision check (revision ${revision}): if someone else edited the team, you get a conflict and can reload.` : undefined}
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
        <Panel
          title={t.name}
          subtitle={t.shortName}
          actions={
            <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/teams/${seg(t.id)}/archive`)} success={`${t.name} archived`} onDone={onChanged} disabledReason={reason} confirm={{ title: `Archive ${t.name}?`, body: "Archived teams are hidden from lists; match history keeps referring to them.", confirmLabel: "Archive" }}>
              Archive
            </ActionButton>
          }
        >
          {initial ? <TeamForm initial={initial} revision={t.revision} teamId={t.id} onSaved={reload} /> : null}
          <section className="ga-section">
            <h3 className="ga-section-title">
              Roster <span className="muted small">{t.roster.length}</span>
            </h3>
            {t.roster.length === 0 ? (
              <p className="muted">No players yet. Create them in the Players tab, then add them here.</p>
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
                        <div className="small muted">{m.player?.steamId ?? "No SteamID"}</div>
                      </td>
                      <td>{roleText(m.role)}</td>
                      <td className="small">{fmtTime(m.validFrom)}</td>
                      <td style={{ textAlign: "right" }}>
                        <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/teams/${seg(t.id)}/roster/${seg(m.playerId)}`)} success={`${m.player?.displayName ?? "Player"} left ${t.name}`} onDone={reload} disabledReason={reason} confirm={{ title: `Remove ${m.player?.displayName ?? "player"} from ${t.name}?`, body: "Closes the membership (kept in history)." }}>
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
                  <option value="">Choose…</option>
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
              <ActionButton
                title="Joining another team closes the previous membership; history is preserved"
                action={() => api.post(`/api/v1/teams/${seg(t.id)}/roster`, { playerId, role })}
                success="Roster updated"
                onDone={() => {
                  setPlayerId("");
                  reload();
                }}
                disabledReason={reason ?? (playerId ? null : "Choose a player")}
              >
                Add to roster
              </ActionButton>
            </div>
          </section>
        </Panel>
      )}
    </Async>
  );
}

function TeamsTab() {
  const [archived, setArchived] = useState(false);
  const teams = useApi<TeamRow[]>(`/api/v1/teams${archived ? "?archived=1" : ""}`);
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const [picked, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const sel = picked ?? teams.data?.[0]?.id ?? null;
  return (
    <div className="grid-1-2">
      <Panel
        title="Teams"
        actions={
          sel ? (
            <Button size="sm" disabled={creating} onClick={() => setCreating(true)}>
              New team
            </Button>
          ) : undefined
        }
      >
        <Async state={teams}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No teams yet">Create a team, then add players to its roster.</EmptyState>
            ) : (
              <ul className="select-list">
                {list.map((t) => (
                  <li key={t.id}>
                    <button
                      className={!creating && sel === t.id ? "is-selected" : ""}
                      onClick={() => {
                        setSel(t.id);
                        setCreating(false);
                      }}
                    >
                      {assetUrl(t.logoAssetId) ? <img className="thumb" src={assetUrl(t.logoAssetId)!} alt="" /> : <span className="dot" style={{ background: t.primaryColor ?? "var(--line-strong)" }} aria-hidden />}
                      <span style={{ flex: 1 }}>
                        <strong>{t.name}</strong> <span className="muted small">{t.shortName}</span>
                      </span>
                      {t.archived ? <Badge>Archived</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
        <div style={{ marginTop: 10 }}>
          <Checkbox checked={archived} onChange={setArchived} label="Show archived" />
        </div>
      </Panel>
      {creating || (!sel && teams.data) ? (
        <Panel
          title="New team"
          actions={
            sel ? (
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            ) : undefined
          }
        >
          <TeamForm
            initial={EMPTY_TEAM}
            onSaved={(id) => {
              setSel(id);
              setCreating(false);
              void teams.reload();
            }}
          />
        </Panel>
      ) : sel ? (
        <TeamDetailPanel
          key={sel}
          teamId={sel}
          players={players.data ?? []}
          onChanged={() => {
            void teams.reload();
            void players.reload();
          }}
        />
      ) : null}
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
        <Field label="SteamID64" hint="Links game data to this player">
          <input className="mono" inputMode="numeric" value={d.steamId ?? ""} placeholder="17 digits" onChange={(e) => set({ steamId: e.target.value.trim() || null })} />
        </Field>
        <Field label="Country code">
          <input value={d.countryCode ?? ""} maxLength={2} placeholder="e.g. GB" title="Two-letter ISO country code" onChange={(e) => set({ countryCode: e.target.value.toUpperCase() || null })} />
        </Field>
        <Field label="Aliases">
          <input value={aliases} placeholder="Comma separated" onChange={(e) => setAliases(e.target.value)} />
        </Field>
        <Field label="Camera source id">
          <input value={d.cameraSourceId ?? ""} onChange={(e) => set({ cameraSourceId: e.target.value || null })} placeholder="e.g. pcam-desk-3" />
        </Field>
        <AssetUpload label="Avatar" value={d.avatarAssetId} onChange={(id) => set({ avatarAssetId: id })} disabledReason={reason} />
      </div>
      <div className="row" style={{ marginTop: 8, gap: 16 }}>
        <Checkbox checked={d.photoVisible} onChange={(v) => set({ photoVisible: v })} label="Photo may be shown on air" />
        <Checkbox checked={d.cameraConsent} onChange={(v) => set({ cameraConsent: v })} label="Player-camera consent" />
      </div>
      <div className="form-actions">
        <ActionButton
          variant="primary"
          title={playerId ? `Saved with a revision check (revision ${revision}): if someone else edited the player, you get a conflict and can reload.` : undefined}
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
        <Panel title={pl.displayName} subtitle={pl.aliases.length ? `aka ${pl.aliases.join(", ")}` : undefined}>
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
          <section className="ga-section">
            <h3 className="ga-section-title">Roster history</h3>
            {pl.history.length === 0 ? (
              <p className="muted">Never rostered.</p>
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
                      <td>{roleText(h.role)}</td>
                      <td className="small">{fmtTime(h.validFrom)}</td>
                      <td className="small">{h.validTo ? fmtTime(h.validTo) : "Current"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <Details summary="Merge a duplicate into this player">
            <p className="small muted">The duplicate's roster history and SteamID move here; its name becomes an alias and the duplicate is archived.</p>
            <div className="row-end">
              <Field label="Duplicate">
                <select value={dup} onChange={(e) => setDup(e.target.value)}>
                  <option value="">Choose…</option>
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
          </Details>
        </Panel>
      )}
    </Async>
  );
}

function PlayersTab() {
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const teams = useApi<TeamRow[]>("/api/v1/teams");
  const [q, setQ] = useState("");
  const [picked, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const sel = picked ?? players.data?.[0]?.id ?? null;
  const teamName = (id: string | null) => (id ? (teams.data?.find((t) => t.id === id)?.shortName ?? "?") : null);
  return (
    <div className="grid-1-2">
      <Panel
        title="Players"
        actions={
          sel ? (
            <Button size="sm" disabled={creating} onClick={() => setCreating(true)}>
              New player
            </Button>
          ) : undefined
        }
      >
        <Async state={players}>
          {(list) => {
            const f = list.filter((p) => !q || p.displayName.toLowerCase().includes(q.toLowerCase()) || (p.steamId ?? "").includes(q) || p.aliases.some((a) => a.toLowerCase().includes(q.toLowerCase())));
            return list.length === 0 ? (
              <EmptyState title="No players yet">Create players here or import a CSV or JSON roster in the Import tab.</EmptyState>
            ) : (
              <>
                <input aria-label="Search players" placeholder="Search name or SteamID" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
                <ul className="select-list">
                  {f.map((p) => (
                    <li key={p.id}>
                      <button
                        className={!creating && sel === p.id ? "is-selected" : ""}
                        title={p.steamId ? `SteamID ${p.steamId}` : undefined}
                        onClick={() => {
                          setSel(p.id);
                          setCreating(false);
                        }}
                      >
                        {assetUrl(p.avatarAssetId) ? <img className="thumb" src={assetUrl(p.avatarAssetId)!} alt="" /> : null}
                        <span style={{ flex: 1 }}>
                          <strong>{p.displayName}</strong>
                          {p.steamId ? null : <span className="small text-warn"> · no SteamID</span>}
                        </span>
                        <span className="ga-list-meta">{teamName(p.teamId) ?? "Free agent"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            );
          }}
        </Async>
      </Panel>
      {creating || (!sel && players.data) ? (
        <Panel
          title="New player"
          actions={
            sel ? (
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            ) : undefined
          }
        >
          <PlayerForm
            initial={EMPTY_PLAYER}
            onSaved={(id) => {
              setSel(id);
              setCreating(false);
              void players.reload();
            }}
          />
        </Panel>
      ) : sel ? (
        <PlayerDetailPanel key={sel} playerId={sel} players={players.data ?? []} teams={teams.data ?? []} onChanged={() => void players.reload()} />
      ) : null}
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
    <Panel title="Import players" subtitle="CSV with a header row (displayName, realName, steamId, team, countryCode) or a JSON array">
      <input
        type="file"
        accept=".csv,.json,.txt,text/csv,application/json"
        aria-label="Load roster file"
        style={{ marginBottom: 8 }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }}
      />
      <textarea className="mono" rows={8} aria-label="Roster CSV or JSON" value={text} onChange={(e) => setText(e.target.value)} placeholder={"displayName,realName,steamId,team,countryCode\nkaizen,Kai Brown,76561198000000001,Blue Sharks,GB"} />
      <div className="form-actions">
        <ActionButton
          variant={preview ? "secondary" : "primary"}
          action={async () => {
            setParseError(null);
            setResult(null);
            let rows: Record<string, string>[];
            try {
              rows = parseRosterImport(text);
            } catch (e) {
              setParseError(e instanceof Error ? e.message : String(e));
              throw new Error("Could not parse the input as CSV or JSON", { cause: e });
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
      {result ? (
        <Note tone="ok">
          {result.created.length} created; {result.skipped.length} skipped (rows {result.skipped.map((i) => i + 1).join(", ") || "none"}).
        </Note>
      ) : null}
      {preview ? (
        <section className="ga-section">
          <h3 className="ga-section-title">
            Review <span className="muted small">Nothing has been written yet</span>
          </h3>
          <table className="table table-compact">
            <thead>
              <tr>
                <th>#</th>
                <th>Display name</th>
                <th>SteamID</th>
                <th>Team</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.row}>
                  <td>{r.row + 1}</td>
                  <td>{r.data?.displayName ?? MISSING}</td>
                  <td className="mono small">{r.data?.steamId ?? MISSING}</td>
                  <td>{r.data?.team ?? MISSING}</td>
                  <td className="small">
                    {!r.ok ? (
                      <>
                        <Badge tone="danger">Invalid</Badge> <span className="text-danger">{r.errors.join("; ")}</span>
                      </>
                    ) : r.duplicateReason ? (
                      <span className="text-warn" title={`Matches existing player ${nameOf(r.duplicateOf)}`}>
                        Duplicate ({r.duplicateReason === "steamId" ? "SteamID" : "name"}) of {nameOf(r.duplicateOf)}
                      </span>
                    ) : (
                      <span className="muted">New</span>
                    )}
                    {r.ok && r.errors.length ? <span className="text-danger"> {r.errors.join("; ")}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ga-actions">
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
              Import {okRows.length} row(s)
            </ActionButton>
            <Checkbox checked={skipDup} onChange={setSkipDup} label="Skip rows whose SteamID already exists" />
          </div>
        </section>
      ) : null}
    </Panel>
  );
}

export function TeamsScreen() {
  const [stored, setTab] = usePersistentState<"teams" | "players" | "import">("teamsTab", "teams");
  const tab = stored === "import" ? "import" : "teams";
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Teams</h1>
      </div>
      <Tabs
        label="Teams"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "teams", label: "Teams" },
          { id: "import", label: "Import roster" },
        ]}
      />
      {tab === "teams" ? <TeamsTab /> : <ImportTab />}
    </div>
  );
}

export function PlayersScreen() {
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Players</h1>
      </div>
      <PlayersTab />
    </div>
  );
}
