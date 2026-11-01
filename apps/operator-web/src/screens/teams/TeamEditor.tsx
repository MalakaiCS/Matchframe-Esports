import { useCallback, useMemo, useRef, useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import type { PlayerRow, StagedImage, TeamDetail, TeamRow } from "../../api/types.ts";
import { EditorShell, useEditor } from "../../components/EditorShell.tsx";
import { Combobox, CountrySelect, discardStaged, fieldErrorsOf, FormField, ImageField } from "../../components/forms.tsx";
import type { ImageValue } from "../../components/forms.tsx";
import { Badge, Button, Details, ErrorBox, Loading, Modal, Note } from "../../components/ui.tsx";
import { useDraft } from "../../lib/draft.ts";
import { useApi } from "../../lib/hooks.ts";
import { useLocation } from "../../router.tsx";
import { usePermission } from "../../state/session.tsx";
import { NoSteamIdBadge, PlayerAvatar, roleText } from "../Teams.tsx";
import "../../styles/records.css";

type TeamDraft = {
  name: string;
  shortName: string;
  countryCode: string | null;
  logoAssetId: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  region: string | null;
  sponsorMetadata: Record<string, string>;
};
const EMPTY: TeamDraft = { name: "", shortName: "", countryCode: null, logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, sponsorMetadata: {} };

/** Team id from /teams/:id/edit (null on /teams/new). */
export function editId(path: string, base: "teams" | "players" | "matches"): string | null {
  const m = new RegExp(`^/${base}/([^/]+)/edit$`).exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

function ColourField({ id, label, value, fallback, onChange }: { id: string; label: string; value: string | null; fallback: string; onChange: (v: string | null) => void }) {
  return (
    <FormField label={label} htmlFor={id}>
      <div className="row">
        <input id={id} type="color" value={value ?? fallback} onChange={(e) => onChange(e.target.value)} />
        {value ? (
          <button type="button" className="link-btn" onClick={() => onChange(null)}>
            Clear
          </button>
        ) : (
          <span className="small muted">Not set</span>
        )}
      </div>
    </FormField>
  );
}

/** Key/value fields HUDs can read (the team's `extra` in the imported-HUD API). */
function ExtraFields({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const entries = Object.entries(value);
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  return (
    <div className="ff">
      <span className="ff-label">Extra fields for HUDs</span>
      {entries.length ? (
        <table className="table table-compact kv-table">
          <tbody>
            {entries.map(([key, val]) => (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td>
                  <input aria-label={`Value of ${key}`} value={val} onChange={(e) => onChange({ ...value, [key]: e.target.value })} />
                </td>
                <td>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      const next = { ...value };
                      delete next[key];
                      onChange(next);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <span className="small muted">None. Some HUDs read extra values such as a sponsor line.</span>
      )}
      <div className="row">
        <input aria-label="New field name" placeholder="Name" value={k} onChange={(e) => setK(e.target.value)} style={{ width: 160 }} />
        <input aria-label="New field value" placeholder="Value" value={v} onChange={(e) => setV(e.target.value)} />
        <Button
          size="sm"
          disabledReason={k.trim() ? null : "Enter a name"}
          onClick={() => {
            onChange({ ...value, [k.trim()]: v });
            setK("");
            setV("");
          }}
        >
          Add field
        </Button>
      </div>
    </div>
  );
}

/** Assign existing player: choose a saved player (moving them if they are on another team). */
function AssignPlayerDialog({ team, players, teams, onClose, onDone }: { team: TeamDetail; players: PlayerRow[]; teams: TeamRow[]; onClose: () => void; onDone: () => void }) {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [role, setRole] = useState("player");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teamName = (id: string | null) => (id ? (teams.find((t) => t.id === id)?.name ?? "another team") : null);
  const options = players
    .filter((p) => p.teamId !== team.id)
    .map((p) => ({ key: p.id, label: p.displayName, keywords: `${p.firstName} ${p.lastName} ${p.steamId ?? ""}`, icon: <PlayerAvatar assetId={p.avatarAssetId} name={p.displayName} size={20} />, hint: p.teamId ? `on ${teamName(p.teamId)}: moves here` : "unassigned" }));
  const chosen = players.find((p) => p.id === playerId);
  const assign = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/v1/players/${seg(chosen.id)}`, { changes: { teamId: team.id, role }, expected: { teamId: chosen.teamId } });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Assign a player to ${team.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} disabledReason={chosen ? null : "Choose a player"} onClick={() => void assign()}>
            Assign player
          </Button>
        </>
      }
    >
      <FormField label="Player" htmlFor="assign-player">
        <Combobox id="assign-player" options={options} value={playerId} onChange={setPlayerId} placeholder="Search players" />
      </FormField>
      <FormField label="Role" htmlFor="assign-role" hint="Teams can have more than five players; substitutes and coaches are listed too.">
        <select id="assign-role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="player">Player</option>
          <option value="substitute">Substitute</option>
          <option value="stand_in">Stand-in</option>
          <option value="coach">Coach</option>
        </select>
      </FormField>
      {chosen?.teamId ? <Note tone="info">{chosen.displayName} leaves {teamName(chosen.teamId)}; that team's roster history keeps the earlier membership.</Note> : null}
      {error ? <ErrorBox error={error} /> : null}
    </Modal>
  );
}

export function TeamEditorScreen() {
  const { path } = useLocation();
  const id = editId(path, "teams");
  return id ? <TeamEditorLoader id={id} key={id} /> : <TeamEditor team={null} key="new" />;
}

function TeamEditorLoader({ id }: { id: string }) {
  const team = useApi<TeamDetail>(`/api/v1/teams/${seg(id)}`);
  if (team.data === undefined) {
    return <div className="page">{team.error ? <ErrorBox error={team.error} onRetry={() => void team.reload()} /> : <Loading label="Loading team…" />}</div>;
  }
  return <TeamEditor team={team.data} reload={() => void team.reload()} />;
}

function TeamEditor({ team, reload }: { team: TeamDetail | null; reload?: () => void }) {
  const reason = usePermission("metadata.write");
  const server = useMemo<TeamDraft | undefined>(
    () => (team ? { name: team.name, shortName: team.shortName, countryCode: team.countryCode, logoAssetId: team.logoAssetId, primaryColor: team.primaryColor, secondaryColor: team.secondaryColor, region: team.region, sponsorMetadata: team.sponsorMetadata } : undefined),
    [team],
  );
  const d = useDraft<TeamDraft>(server, EMPTY);
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<string[]>([]);
  const [assigning, setAssigning] = useState(false);
  const players = useApi<PlayerRow[]>(team ? "/api/v1/players" : null);
  const teams = useApi<TeamRow[]>(team ? "/api/v1/teams" : null);
  const savedName = useRef("");
  const dirty = d.dirty || staged !== null;

  const save = useCallback(async () => {
    setErrors({});
    setConflict([]);
    if (!d.draft.name.trim()) {
      setErrors({ name: "Enter a team name" });
      throw new Error("Enter a team name");
    }
    savedName.current = d.draft.name.trim();
    try {
      if (!team) {
        await api.post<TeamRow>("/api/v1/teams", { ...d.draft, ...(staged ? { logoStagedId: staged.stagedId } : {}) });
      } else {
        const changes = d.changes();
        const expected = d.expected();
        if (staged) expected.logoAssetId = d.original.logoAssetId;
        await api.patch<TeamRow>(`/api/v1/teams/${seg(team.id)}`, { changes, expected, ...(staged ? { logoStagedId: staged.stagedId } : {}) });
      }
      setStaged(null);
    } catch (e) {
      const f = fieldErrorsOf(e);
      setErrors(f);
      if ((e as { code?: string }).code === "field_conflict") setConflict(Object.keys(f));
      throw e;
    }
  }, [team, d, staged]);

  const editor = useEditor({
    dirty,
    backTo: "/teams",
    save,
    onDiscard: () => discardStaged(staged),
    savedMessage: () => (team ? `${savedName.current} saved` : `${savedName.current} created`),
  });
  const image: ImageValue = { assetId: d.draft.logoAssetId, staged };

  return (
    <EditorShell title={team ? `Edit ${team.name}` : "Add Team"} backTo="/teams" backLabel="Teams" crumbs={[team ? team.name : "Add Team"]} editor={editor} saveDisabledReason={reason}>
      {conflict.length ? (
        <Note tone="warn" title="Changed elsewhere">
          {conflict.map((c) => ({ name: "Team name", shortName: "Short name", countryCode: "Country", logoAssetId: "Logo" })[c] ?? c).join(", ")} changed on another screen or computer while you were editing.{" "}
          <Button
            size="sm"
            onClick={() => {
              d.reload(conflict as (keyof TeamDraft)[]);
              setConflict([]);
              setErrors({});
              reload?.();
            }}
          >
            Use the current values
          </Button>{" "}
          or keep yours: reload, then save again.
        </Note>
      ) : null}
      <section className="form-stack">
        <FormField label="Team name" htmlFor="team-name" required error={errors.name} hint="For example LITE Esports">
          <input id="team-name" value={d.draft.name} maxLength={80} aria-invalid={!!errors.name || undefined} onChange={(e) => d.set({ name: e.target.value })} autoFocus={!team} />
        </FormField>
        <FormField label="Short name" htmlFor="team-short" error={errors.shortName} hint="Up to 12 characters, for example LITE. Made from the name when left empty.">
          <input id="team-short" value={d.draft.shortName} maxLength={12} aria-invalid={!!errors.shortName || undefined} onChange={(e) => d.set({ shortName: e.target.value })} />
        </FormField>
        <FormField label="Country" htmlFor="team-country" error={errors.countryCode}>
          <CountrySelect id="team-country" value={d.draft.countryCode} onChange={(countryCode) => d.set({ countryCode })} invalid={!!errors.countryCode} />
        </FormField>
        <FormField label="Logo" htmlFor="team-logo" error={errors.logoAssetId}>
          <ImageField
            id="team-logo"
            label="Logo"
            kind="logo"
            value={image}
            disabledReason={reason}
            onChange={(v) => {
              setStaged(v.staged);
              if (!v.staged) d.set({ logoAssetId: v.assetId });
            }}
          />
        </FormField>
      </section>
      {team ? (
        <section className="assigned">
          <div className="assigned-head">
            <h2 className="section-title">
              Assigned Players <span className="muted">{team.roster.length}</span>
            </h2>
            <div className="row">
              <Button size="sm" onClick={() => setAssigning(true)} disabledReason={reason}>
                Assign Existing Player
              </Button>
              <Button size="sm" variant="primary" onClick={() => editor.leaveTo(`/players/new?teamId=${seg(team.id)}&returnTo=${seg(`/teams/${team.id}/edit`)}`)} disabledReason={reason}>
                Add Player
              </Button>
            </div>
          </div>
          {team.roster.length === 0 ? (
            <p className="muted">No players yet. Assign saved players or add a new one; substitutes and more than five players are fine.</p>
          ) : (
            <ul className="tiles">
              {team.roster.map((m) => (
                <li key={m.id}>
                  <button type="button" className="tile" onClick={() => editor.leaveTo(`/players/${seg(m.playerId)}/edit?returnTo=${seg(`/teams/${team.id}/edit`)}`)} title={`Edit ${m.player?.displayName ?? "player"}`}>
                    <PlayerAvatar assetId={m.player?.avatarAssetId} name={m.player?.displayName ?? "?"} size={56} />
                    <span className="tile-name">{m.player?.displayName ?? m.playerId}</span>
                    {m.role !== "player" ? <Badge>{roleText(m.role)}</Badge> : null}
                    {m.player && !m.player.steamId ? <NoSteamIdBadge /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p className="small muted">After the team is saved, its editor lists the assigned players and lets you assign or add players.</p>
      )}
      <Details summary="Additional details: colours, region and HUD fields" className="additional">
        <div className="form-grid">
          <ColourField id="team-primary" label="Primary colour" value={d.draft.primaryColor} fallback="#2f7cf6" onChange={(primaryColor) => d.set({ primaryColor })} />
          <ColourField id="team-secondary" label="Secondary colour" value={d.draft.secondaryColor} fallback="#ffffff" onChange={(secondaryColor) => d.set({ secondaryColor })} />
          <FormField label="Region" htmlFor="team-region">
            <input id="team-region" value={d.draft.region ?? ""} maxLength={40} onChange={(e) => d.set({ region: e.target.value || null })} />
          </FormField>
        </div>
        <ExtraFields value={d.draft.sponsorMetadata} onChange={(sponsorMetadata) => d.set({ sponsorMetadata })} />
      </Details>
      {assigning && team ? (
        <AssignPlayerDialog
          team={team}
          players={players.data ?? []}
          teams={teams.data ?? []}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            reload?.();
            void players.reload();
          }}
        />
      ) : null}
    </EditorShell>
  );
}

