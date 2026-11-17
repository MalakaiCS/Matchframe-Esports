import { api } from "../../api/index.ts";
import { ActionButton, Badge, Button, Details, Mono, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import type { SetupChecklistView } from "./types.ts";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

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
  if (!v) return <Panel title={t("comms.setupChecklist")}>{st.error ? <Note tone="warn">{t("comms.theChecklistIsnTAvailable", { error: st.error })}</Note> : <p className="muted small">{t("comms.checking")}</p>}</Panel>;
  const done = v.steps.filter((s) => s.state === "done").length;
  const p = v.plugin;
  const open = opener();
  const installReason = manage ?? (p.bundled.binary ? null : (p.bundled.note ?? t("comms.thisBuildHasNoTeamspeak")));
  return (
    <Panel title={t("comms.setupChecklist")} subtitle={t("comms.eachStepReadsItsState")} actions={<Badge tone={done === v.steps.length ? "ok" : "warn"}>{t("comms.doneOfCountDone", { done, count: v.steps.length })}</Badge>}>
      <div className="stack-sm">
        <ol className="comms-checklist" aria-label={t("comms.teamCommsSetupSteps")}>
          {v.steps.map((s) => (
            <li key={s.id} className={`comms-check-${s.state}`}>
              <div className="row">
                <Badge tone={MARK[s.state].tone} icon={MARK[s.state].icon}>
                  {s.state === "done" ? t("comms.done") : s.state === "todo" ? t("comms.toDo") : t("comms.notChecked")}
                </Badge>
                <strong>{s.title}</strong>
              </div>
              <p className="small">{s.detail}</p>
              <Details summary={t("comms.titleDetails", { title: s.title })} open={s.state === "todo" && s.id === "teamspeak-plugin"}>
                <ul className="comms-checks">
                  {s.items.map((i) => (
                    <li key={i.label}>
                      <Badge tone={i.ok === false ? "danger" : i.ok ? "ok" : "neutral"} icon={i.ok === false ? "✗" : i.ok ? "✓" : "?"}>
                        {i.ok === false ? t("comms.toDo") : i.ok ? "OK" : t("comms.notChecked")}
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
                    success={(r) => r.lastInstall?.detail ?? t("comms.pluginInstalled")}
                    onDone={() => void st.reload()}
                    confirm={p.installed.path ? { title: t("comms.installTheTeamspeakPluginAgain"), body: t("comms.itReplacesThePluginIn"), confirmLabel: t("comms.install") } : undefined}
                  >
                    {p.installed.same ? t("comms.installTeamspeakPluginAgain") : t("comms.installTeamspeakPlugin")}
                  </ActionButton>
                  {open ? (
                    <>
                      <Button size="sm" onClick={() => void open("plugins")}>{t("comms.openTeamspeakSPluginsFolder")}</Button>
                      {p.bundled.package ? (
                        <Button size="sm" onClick={() => void open("package")}>{t("comms.showThePluginPackage")}</Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              {s.id === "teamspeak-plugin" && p.lastInstall && !p.lastInstall.ok ? <Note tone="warn">{p.lastInstall.detail}</Note> : null}
            </li>
          ))}
        </ol>
        <Details summary={t("comms.installTheTeamspeakPluginBy")}>
          <ol className="small comms-steps">
            <li>{t("comms.closeTeamspeak3")}</li>
            <li><T k="comms.doubleClickMonoTeamspeakS" values={{ mono: <Mono>{p.bundled.package ?? "matchframe-team-comms.ts3_plugin"}</Mono>, mono2: <Mono>{p.bundled.binary ?? "matchframe_comms_win64.dll"}</Mono>, mono3: <Mono>{p.installed.pluginsDir ?? "%APPDATA%\\TS3Client\\plugins"}</Mono> }} /></li>
            <li>{t("comms.startTeamspeak3ToolsOptions")}</li>
            <li>{t("comms.connectATabToEach")}</li>
          </ol>
        </Details>
      </div>
    </Panel>
  );
}
