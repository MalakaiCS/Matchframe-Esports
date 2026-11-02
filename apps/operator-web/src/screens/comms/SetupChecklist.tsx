import { api } from "../../api/index.ts";
import { ActionButton, Badge, Button, Details, Mono, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import type { SetupChecklistView } from "./types.ts";

type Step = SetupChecklistView["steps"][number];

/** Each step's state as a word and a shape (never colour alone). */
const MARK: Record<Step["state"], { icon: string; tone: "ok" | "warn" | "neutral" }> = {
  done: { icon: "✓", tone: "ok" },
  todo: { icon: "!", tone: "warn" },
  unknown: { icon: "?", tone: "neutral" },
};

const opener = () => (window.matchframe?.connectionMode !== "remote" ? (window.matchframe?.openTs3Folder ?? null) : null);

/**
 * The guided setup (ADR-069): TeamSpeak plugin, DistroAV, Source Record, OBS scenes, calibration, each
 * step's state read live from MatchFrame's own checks, with Install TeamSpeak plugin (the program's
 * build copied into TeamSpeak 3's plugins folder) and the folders to install it by hand.
 */
export function SetupChecklist() {
  const st = useApi<SetupChecklistView>("/api/v1/comms/setup", { refreshMs: 5000 });
  const manage = usePermission("settings.manage");
  const v = st.data;
  if (!v) return <Panel title="Setup checklist">{st.error ? <Note tone="warn">The checklist isn't available: {st.error}</Note> : <p className="muted small">Checking…</p>}</Panel>;
  const done = v.steps.filter((s) => s.state === "done").length;
  const p = v.plugin;
  const open = opener();
  const installReason = manage ?? (p.bundled.binary ? null : (p.bundled.note ?? "This build has no TeamSpeak plugin"));
  return (
    <Panel title="Setup checklist" subtitle="Each step reads its state from MatchFrame's own checks, live." actions={<Badge tone={done === v.steps.length ? "ok" : "warn"}>{`${done} of ${v.steps.length} done`}</Badge>}>
      <div className="stack-sm">
        <ol className="comms-checklist" aria-label="Team Comms setup steps">
          {v.steps.map((s) => (
            <li key={s.id} className={`comms-check-${s.state}`}>
              <div className="row">
                <Badge tone={MARK[s.state].tone} icon={MARK[s.state].icon}>
                  {s.label}
                </Badge>
                <strong>{s.title}</strong>
              </div>
              <p className="small">{s.detail}</p>
              <Details summary={`${s.title}: details`} open={s.state === "todo" && s.id === "teamspeak-plugin"}>
                <ul className="comms-checks">
                  {s.items.map((i) => (
                    <li key={i.label}>
                      <Badge tone={i.ok === false ? "danger" : i.ok ? "ok" : "neutral"} icon={i.ok === false ? "✗" : i.ok ? "✓" : "?"}>
                        {i.ok === false ? "To do" : i.ok ? "OK" : "Not checked"}
                      </Badge>{" "}
                      <strong>{i.label}</strong> <span className="small">{i.detail}</span>
                    </li>
                  ))}
                </ul>
              </Details>
              {s.id === "teamspeak-plugin" ? (
                <div className="row">
                  <ActionButton
                    variant={p.installed.same ? "secondary" : "primary"}
                    disabledReason={installReason}
                    action={() => api.post<SetupChecklistView["plugin"]>("/api/v1/comms/teamspeak-plugin/install")}
                    success={(r) => r.lastInstall?.detail ?? "Installed"}
                    onDone={() => void st.reload()}
                    confirm={p.installed.path ? { title: "Install the TeamSpeak plugin again?", body: "It replaces the plugin in TeamSpeak 3's plugins folder with this program's build. Close TeamSpeak 3 first: it holds the file while it runs.", confirmLabel: "Install" } : undefined}
                  >
                    {p.installed.same ? "Install TeamSpeak plugin again" : "Install TeamSpeak plugin"}
                  </ActionButton>
                  {open ? (
                    <>
                      <Button size="sm" onClick={() => void open("plugins")}>
                        Open TeamSpeak's plugins folder
                      </Button>
                      {p.bundled.package ? (
                        <Button size="sm" onClick={() => void open("package")}>
                          Show the plugin package
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              {s.id === "teamspeak-plugin" && p.lastInstall && !p.lastInstall.ok ? <Note tone="warn">{p.lastInstall.detail}</Note> : null}
            </li>
          ))}
        </ol>
        <Details summary="Install the TeamSpeak plugin by hand">
          <ol className="small comms-steps">
            <li>Close TeamSpeak 3.</li>
            <li>
              Double-click <Mono>{p.bundled.package ?? "matchframe-team-comms.ts3_plugin"}</Mono> (TeamSpeak's own add-on installer), or copy <Mono>{p.bundled.binary ?? "matchframe_comms_win64.dll"}</Mono> into <Mono>{p.installed.pluginsDir ?? "%APPDATA%\\TS3Client\\plugins"}</Mono>.
            </li>
            <li>Start TeamSpeak 3: Tools → Options → Add-ons → MatchFrame Team Comms enabled.</li>
            <li>Connect a tab to each team's channel (each team's TeamSpeak link is under Bridge and TeamSpeak plugin). The plugin remembers the team tabs: after a TeamSpeak restart they are listen-only and silent here at once.</li>
          </ol>
        </Details>
      </div>
    </Panel>
  );
}
