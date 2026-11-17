import { useEffect, useState } from "react";
import { ActionButton, Badge, Button, ConfirmDialog, Field, Note } from "../../components/ui.tsx";
import { HLAE_WARNING, LAUNCH_MODES, setLaunchProfile, useGameConsole, useHlae, type GameConsoleStatus, type GameLaunchMode } from "../../lib/game.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";
import { useRun } from "../hudlib/actions.ts";

/** Asks before the HLAE mode is used for the first time (insecure CS2, VAC). */
export function HlaeWarningDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog
      spec={{
        title: t("game.hlaeDialog.title"),
        body: (
          <ul className="hlae-warning">
            {HLAE_WARNING.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ),
        confirmLabel: t("game.hlaeDialog.confirm"),
        danger: true,
      }}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** One line on the console connection, or null in the standard mode. */
export function consoleLine(st: GameConsoleStatus | undefined): { tone: "ok" | "neutral" | "warn"; text: string; title: string } | null {
  if (!st || st.console === "off") return null;
  if (st.console === "connected") return { tone: st.lastApplyError ? "warn" : "ok", text: t("game.console.connected"), title: st.lastApplyError ? t("game.console.notSent", { error: st.lastApplyError }) : t("game.console.live", { port: st.port }) };
  return { tone: "neutral", text: t("game.console.waiting"), title: st.lastError ? t("game.console.waitingTitleError", { port: st.port, error: st.lastError }) : t("game.console.waitingTitle", { port: st.port }) };
}

/** Settings → Setup → Start CS2: launch mode, console port, extra launch options and HLAE. */
export function LaunchSettings() {
  const st = useGameConsole(3000);
  const reason = usePermission("settings.manage");
  const hlae = useHlae();
  const run = useRun();
  const p = st.data?.profile;
  const [mode, setMode] = useState<GameLaunchMode>("standard");
  const [port, setPort] = useState("2121");
  const [extra, setExtra] = useState("");
  const [askHlae, setAskHlae] = useState(false);
  const loaded = !!p;
  useEffect(() => {
    if (!p) return;
    setMode(p.mode);
    setPort(String(p.netconPort));
    setExtra(p.extraArgs);
    // Only when the saved profile first arrives; later polls must not overwrite edits.
  }, [loaded]);
  const portNum = Number(port);
  const portError = !Number.isInteger(portNum) || portNum < 1024 || portNum > 65535 ? t("game.launch.portRange") : null;
  const save = (acknowledgeInsecure?: boolean) => setLaunchProfile({ mode, netconPort: portNum, extraArgs: extra, ...(acknowledgeInsecure ? { acknowledgeInsecure } : {}) }).then(() => st.reload());
  const needsAck = mode === "hlae" && !p?.insecureAcknowledgedAt;
  const line = consoleLine(st.data);

  return (
    <div className="stack launch-settings">
      <p className="muted">{t("game.launch.intro")}</p>
      <fieldset className="launch-modes" disabled={!!reason}>
        <legend className="sr-only">{t("game.launch.mode")}</legend>
        {LAUNCH_MODES.map((m) => (
          <label key={m.id} className={`launch-mode ${mode === m.id ? "is-selected" : ""}`}>
            <input type="radio" name="launch-mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />
            <span>
              <strong>{m.label}</strong>
              <span className="muted small">{m.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode !== "standard" ? (
        <div className="row">
          <Field label={t("game.launch.port")} hint={t("game.launch.portHint")}>
            <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} aria-invalid={!!portError} style={{ width: 110 }} />
          </Field>
          {line ? (
            <Badge tone={line.tone} title={line.title}>
              {line.text}
            </Badge>
          ) : null}
        </div>
      ) : null}
      <Field label={t("game.launch.extra")} hint={t("game.launch.extraHint")}>
        <input value={extra} onChange={(e) => setExtra(e.target.value)} spellCheck={false} placeholder="-novid" />
      </Field>
      {mode === "hlae" ? (
        <div className="stack">
          <Note tone="warn" title={t("game.launch.insecure")}>
            <ul className="hlae-warning">
              {HLAE_WARNING.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Note>
          <div className="row">
            <span className={hlae.info?.ok ? "text-ok" : "muted"}>{hlae.info?.ok ? `HLAE: ${hlae.info.path}` : (hlae.info?.problem ?? t("game.launch.hlaeInProgram"))}</span>
            {hlae.choose ? (
              <Button onClick={() => void hlae.choose!()} disabledReason={reason}>
                {t("game.chooseHlae")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="row">
        <ActionButton
          variant="primary"
          action={async () => {
            if (needsAck) {
              setAskHlae(true);
              return null;
            }
            await save();
            return true;
          }}
          success={(r) => (r ? t("game.launch.saved") : null)}
          disabledReason={reason ?? (mode !== "standard" ? portError : null)}
        >
          {t("game.launch.save")}
        </ActionButton>
      </div>
      {askHlae ? (
        <HlaeWarningDialog
          onCancel={() => setAskHlae(false)}
          onConfirm={() => {
            setAskHlae(false);
            void run(t("game.launch.save"), () => save(true), t("game.launch.savedHlae"));
          }}
        />
      ) : null}
    </div>
  );
}
