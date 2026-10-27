import { useEffect, useState } from "react";
import { ActionButton, Badge, Button, ConfirmDialog, Field, Note } from "../../components/ui.tsx";
import { HLAE_WARNING, LAUNCH_MODES, setLaunchProfile, useGameConsole, useHlae, type GameConsoleStatus, type GameLaunchMode } from "../../lib/game.ts";
import { usePermission } from "../../state/session.tsx";
import { useRun } from "../hudlib/actions.ts";

/** Asks before the HLAE mode is used for the first time (insecure CS2, VAC). */
export function HlaeWarningDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog
      spec={{
        title: "Start CS2 with HLAE?",
        body: (
          <ul className="hlae-warning">
            {HLAE_WARNING.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ),
        confirmLabel: "I understand, use HLAE",
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
  if (st.console === "connected") return { tone: st.lastApplyError ? "warn" : "ok", text: "Console connected", title: st.lastApplyError ? `Some console options were not sent: ${st.lastApplyError}` : `CS2 console on port ${st.port}: camera control and game options are live.` };
  return { tone: "neutral", text: "Console: waiting for CS2", title: `Matchframe connects to CS2's console on port ${st.port} once CS2 runs with -tools -netconport${st.lastError ? ` (last try: ${st.lastError})` : ""}. No connection after CS2 has started usually means the CS2 Workshop Tools are not installed.` };
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
  const portError = !Number.isInteger(portNum) || portNum < 1024 || portNum > 65535 ? "Use a port from 1024 to 65535" : null;
  const save = (acknowledgeInsecure?: boolean) => setLaunchProfile({ mode, netconPort: portNum, extraArgs: extra, ...(acknowledgeInsecure ? { acknowledgeInsecure } : {}) }).then(() => st.reload());
  const needsAck = mode === "hlae" && !p?.insecureAcknowledgedAt;
  const line = consoleLine(st.data);

  return (
    <div className="stack launch-settings">
      <p className="muted">Start CS2 in the HUD Library starts the game this way. Matchframe writes the game data (GSI) config first.</p>
      <fieldset className="launch-modes" disabled={!!reason}>
        <legend className="sr-only">Launch mode</legend>
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
          <Field label="Console port" hint="CS2 listens on this port on this computer only (-netconport).">
            <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} aria-invalid={!!portError} style={{ width: 110 }} />
          </Field>
          {line ? (
            <Badge tone={line.tone} title={line.title}>
              {line.text}
            </Badge>
          ) : null}
        </div>
      ) : null}
      <Field label="Extra launch options" hint="Optional, for example -novid -fullscreen. The launch mode sets -tools, -netconport, -insecure and -steam itself.">
        <input value={extra} onChange={(e) => setExtra(e.target.value)} spellCheck={false} placeholder="-novid" />
      </Field>
      {mode === "hlae" ? (
        <div className="stack">
          <Note tone="warn" title="HLAE runs CS2 insecure">
            <ul className="hlae-warning">
              {HLAE_WARNING.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Note>
          <div className="row">
            <span className={hlae.info?.ok ? "text-ok" : "muted"}>{hlae.info?.ok ? `HLAE: ${hlae.info.path}` : (hlae.info?.problem ?? "HLAE.exe can be chosen in the Matchframe program.")}</span>
            {hlae.choose ? (
              <Button onClick={() => void hlae.choose!()} disabledReason={reason}>
                Choose HLAE.exe…
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
          success={(r) => (r ? "Launch settings saved" : null)}
          disabledReason={reason ?? (mode !== "standard" ? portError : null)}
        >
          Save launch settings
        </ActionButton>
      </div>
      {askHlae ? (
        <HlaeWarningDialog
          onCancel={() => setAskHlae(false)}
          onConfirm={() => {
            setAskHlae(false);
            void run("Save launch settings", () => save(true), "Launch settings saved (HLAE)");
          }}
        />
      ) : null}
    </div>
  );
}
