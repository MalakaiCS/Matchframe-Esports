import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { PlayerRow, TeamRow } from "../api/types.ts";
import { ActionButton, Async, Badge, EmptyState, Note, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { usePermission } from "../state/session.tsx";

function PlayerCamRow({ p, team, onSaved }: { p: PlayerRow; team: string | null; onSaved: () => void }) {
  const reason = usePermission("metadata.write");
  const [consent, setConsent] = useState(p.cameraConsent);
  const [source, setSource] = useState(p.cameraSourceId ?? "");
  const changed = consent !== p.cameraConsent || (source || null) !== (p.cameraSourceId ?? null);
  const routable = p.cameraConsent && !!p.cameraSourceId && !!p.steamId;
  return (
    <tr>
      <td>
        <strong>{p.displayName}</strong>
        <div className="small muted mono">{p.steamId ?? "no SteamID — cannot be matched to telemetry"}</div>
      </td>
      <td>{team ?? <span className="muted">free agent</span>}</td>
      <td>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          {consent ? "Consent given" : "No consent"}
        </label>
      </td>
      <td>
        <input aria-label={`Camera source for ${p.displayName}`} value={source} onChange={(e) => setSource(e.target.value)} placeholder="source id (e.g. pcam-a3)" />
      </td>
      <td>{routable ? <Badge tone="ok">READY FOR ROUTING</Badge> : !p.cameraConsent ? <Badge>NO CONSENT</Badge> : !p.cameraSourceId ? <Badge tone="warn">NO SOURCE</Badge> : <Badge tone="warn">NO STEAMID</Badge>}</td>
      <td>
        <ActionButton size="sm" action={() => api.patch(`/api/v1/players/${seg(p.id)}`, { cameraConsent: consent, cameraSourceId: source.trim() || null, revision: p.revision })} success={`${p.displayName}: camera settings saved`} onDone={onSaved} disabledReason={reason ?? (changed ? null : "No change")} reasonPlacement="tooltip">
          Save
        </ActionButton>
      </td>
    </tr>
  );
}

export function PlayerCamerasScreen() {
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const teams = useApi<TeamRow[]>("/api/v1/teams");
  const teamName = (id: string | null) => (id ? (teams.data?.find((t) => t.id === id)?.name ?? null) : null);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Player Cameras</h1>
        <Badge tone="warn">ROUTING NOT IMPLEMENTED</Badge>
      </div>
      <Note tone="warn" title="NOT YET AVAILABLE">
        The engine has no player-camera intake or mixer yet. This page manages the per-player data the routing will use (consent and a stable camera source id); nothing here switches video.
      </Note>
      <div className="grid-2-1">
        <Panel title="Players" subtitle="Consent and camera source per stable player identity">
          <Async state={players}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No players">
                  Add players (with SteamIDs) in <Link to="/teams">Teams &amp; Players</Link> first.
                </EmptyState>
              ) : (
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Team</th>
                      <th>Consent</th>
                      <th>Camera source id</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <PlayerCamRow key={p.id} p={p} team={teamName(p.teamId)} onSaved={() => void players.reload()} />
                    ))}
                  </tbody>
                </table>
              )
            }
          </Async>
        </Panel>
        <div className="stack">
          <Panel title="Planned routing model">
            <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
              <li>Every camera feed is registered under a stable source id (e.g. a desk position), never under a player name.</li>
              <li>A player's <code>cameraSourceId</code> links their stable player id (and SteamID) to that feed.</li>
              <li>Only players with <code>cameraConsent</code> are ever routed; revoking consent removes them immediately.</li>
              <li>When the observer is confirmed on a player's POV (telemetry feedback, not a pending request), the mixer can show that player's camera picture-in-picture.</li>
              <li>Substitutes and stand-ins keep their own identity; roster changes never re-use another player's camera.</li>
            </ol>
          </Panel>
          <Panel title="Status of components">
            <table className="table table-compact">
              <tbody>
                <tr>
                  <td>Consent + source id on players</td>
                  <td>
                    <Badge tone="ok">AVAILABLE</Badge>
                  </td>
                </tr>
                <tr>
                  <td>Remote camera intake (SRT/NDI/WebRTC)</td>
                  <td>
                    <Badge tone="warn">NOT IMPLEMENTED</Badge>
                  </td>
                </tr>
                <tr>
                  <td>Camera mixer / PiP automation</td>
                  <td>
                    <Badge tone="warn">NOT IMPLEMENTED</Badge>
                  </td>
                </tr>
                <tr>
                  <td>Manual workaround</td>
                  <td className="small">Add camera sources to OBS scenes yourself and toggle them from Devices → OBS scene items.</td>
                </tr>
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}
