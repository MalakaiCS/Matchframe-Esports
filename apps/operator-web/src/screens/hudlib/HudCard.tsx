import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { HudLibraryEntry, HudOutputMode } from "@matchframe/contracts";
import type { OverlayState } from "../../api/desktop.ts";
import { Icon } from "../../components/icons.tsx";
import { Badge, Button } from "../../components/ui.tsx";
import type { HudDisplayStatus } from "../../lib/hudLibrary.ts";
import { KIND_LABEL, OUTPUT_LABEL, OUTPUT_MODES, STATUS_INFO, resolutionLabel } from "../../lib/hudLibrary.ts";

/** Actions on one HUD, shared by the card, the list row and the details panel. */
export interface HudActions {
  launch(): void;
  closeDesktop(): void;
  preview(): void;
  copyUrl(): void;
  settings(): void;
  reload(): void;
  stop(): void;
  duplicate(): void;
  exportZip(): void;
  openFolder(): void;
  remove(): void;
}

/** Why each action cannot run right now (null: it can). */
export type HudActionReasons = Partial<Record<keyof HudActions, string | null>>;

export interface HudItemProps {
  entry: HudLibraryEntry;
  status: HudDisplayStatus;
  statusDetail: string | null;
  outputs: Record<HudOutputMode, number>;
  overlay: OverlayState | undefined;
  selected: boolean;
  onSelect(): void;
  actions: HudActions;
  reasons: HudActionReasons;
}

/** Small dropdown menu (More): closes on outside click, Escape and after choosing. */
export function MenuButton({ label, items, buttonLabel, icon = "more" }: { label: string; items: { label: string; onClick: () => void; reason?: string | null; danger?: boolean }[]; buttonLabel?: string; icon?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-anchor" ref={ref}>
      <button type="button" className={buttonLabel ? "btn btn-secondary btn-md" : "icon-btn"} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
        <Icon name={icon} size={buttonLabel ? 14 : 16} />
        {buttonLabel ? ` ${buttonLabel}` : null}
      </button>
      {open ? (
        <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`menu-item ${it.danger ? "is-danger" : ""}`}
              disabled={!!it.reason}
              title={it.reason ?? undefined}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
              {it.reason ? <span className="sr-only"> ({it.reason})</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function IconAction({ icon, label, onClick, reason }: { icon: string; label: string; onClick: () => void; reason?: string | null }) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={reason ? `${label} (${reason})` : label}
      title={reason ?? label}
      disabled={!!reason}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

export function StatusBadge({ status, detail }: { status: HudDisplayStatus; detail: string | null }) {
  const info = STATUS_INFO[status];
  return (
    <Badge tone={info.tone} title={detail ?? info.hint} className={`hud-status is-${status}`}>
      {info.label}
    </Badge>
  );
}

/** Desktop / OBS / Preview indicators with the number of connected outputs of each kind. */
export function OutputIndicators({ outputs }: { outputs: Record<HudOutputMode, number> }) {
  return (
    <span className="hud-outputs" aria-label="Active outputs">
      {OUTPUT_MODES.map((m) => (
        <span key={m} className={`hud-output ${outputs[m] ? "is-on" : ""}`} title={`${OUTPUT_LABEL[m]}: ${outputs[m] ? `${outputs[m]} connected` : "not connected"}`} data-output={m}>
          <span className="hud-output-dot" aria-hidden />
          {OUTPUT_LABEL[m]}
          {outputs[m] > 1 ? <span className="num"> {outputs[m]}</span> : null}
        </span>
      ))}
    </span>
  );
}

export function Thumbnail({ entry, className = "" }: { entry: HudLibraryEntry; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [entry.thumbnailUrl]);
  return (
    <div className={`hud-thumb ${className}`}>
      {entry.thumbnailUrl && !failed ? (
        <img src={entry.thumbnailUrl} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <div className="hud-thumb-empty" aria-hidden>
          <Icon name="huds" size={30} />
        </div>
      )}
    </div>
  );
}

function moreItems(a: HudActions, r: HudActionReasons) {
  return [
    { label: "Duplicate", onClick: a.duplicate, reason: r.duplicate },
    { label: "Export ZIP", onClick: a.exportZip, reason: r.exportZip },
    { label: "Open Folder", onClick: a.openFolder, reason: r.openFolder },
    { label: "Remove…", onClick: a.remove, reason: r.remove, danger: true },
  ];
}

function PrimaryAction({ overlay, actions, reasons }: Pick<HudItemProps, "overlay" | "actions" | "reasons">) {
  if (overlay?.open)
    return (
      <Button
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          actions.closeDesktop();
        }}
        disabledReason={reasons.closeDesktop ?? null}
      >
        Close Desktop HUD
      </Button>
    );
  return (
    <Button
      size="sm"
      variant="primary"
      onClick={(e) => {
        e.stopPropagation();
        actions.launch();
      }}
      disabledReason={reasons.launch ?? null}
      className="hud-launch"
    >
      <Icon name="play" size={14} /> Launch Transparent HUD
    </Button>
  );
}

function SecondaryActions({ entry, actions, reasons }: Pick<HudItemProps, "entry" | "actions" | "reasons">) {
  return (
    <div className="hud-actions-secondary">
      <IconAction icon="eye" label="Preview" onClick={actions.preview} reason={reasons.preview} />
      <IconAction icon="copy" label="Copy OBS Browser URL" onClick={actions.copyUrl} reason={reasons.copyUrl} />
      <IconAction icon="settings" label="Settings" onClick={actions.settings} reason={reasons.settings} />
      <IconAction icon="reload" label="Reload" onClick={actions.reload} reason={reasons.reload} />
      <IconAction icon="stop" label="Stop" onClick={actions.stop} reason={reasons.stop} />
      <MenuButton label={`More actions for ${entry.name}`} items={moreItems(actions, reasons)} />
    </div>
  );
}

const selectOnKey = (onSelect: () => void) => (e: ReactKeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onSelect();
  }
};

function Meta({ entry }: { entry: HudLibraryEntry }): ReactNode {
  return (
    <span className="hud-meta">
      <span>CS2</span>
      <span>{entry.author || "Unknown author"}</span>
      <span>v{entry.version}</span>
      {entry.kind !== "imported" ? <span>{KIND_LABEL[entry.kind]}</span> : null}
    </span>
  );
}

/** Grid card: thumbnail with status, name, meta, description, outputs and the actions. */
export function HudCard(p: HudItemProps) {
  const { entry } = p;
  return (
    <article className={`hud-card ${p.selected ? "is-selected" : ""}`} data-hud={entry.id} aria-label={entry.name} aria-current={p.selected ? "true" : undefined} tabIndex={0} onClick={p.onSelect} onKeyDown={selectOnKey(p.onSelect)}>
      <div className="hud-card-media">
        <Thumbnail entry={entry} />
        <span className="hud-card-status">
          <StatusBadge status={p.status} detail={p.statusDetail} />
        </span>
        <span className="hud-card-res">{resolutionLabel(entry)}</span>
      </div>
      <div className="hud-card-body">
        <h3 className="hud-name" title={entry.name}>
          {entry.name}
        </h3>
        <Meta entry={entry} />
        <p className="hud-desc" title={entry.description}>
          {entry.category ? <span className="hud-category">{entry.category}</span> : null}
          {entry.description || "No description."}
        </p>
        <OutputIndicators outputs={p.outputs} />
      </div>
      <div className="hud-card-actions">
        <PrimaryAction overlay={p.overlay} actions={p.actions} reasons={p.reasons} />
        <SecondaryActions entry={entry} actions={p.actions} reasons={p.reasons} />
      </div>
    </article>
  );
}

/**
 * The desktop HUD as an on/off switch: on launches the transparent window over the game, off
 * closes it. OBS sources and previews are not affected.
 */
export function LaunchSwitch({ overlay, actions, reasons }: Pick<HudItemProps, "overlay" | "actions" | "reasons">) {
  const on = !!overlay?.open;
  const reason = on ? (reasons.closeDesktop ?? null) : (reasons.launch ?? null);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch hud-launch ${on ? "is-on" : ""}`}
      disabled={!!reason}
      title={reason ?? (on ? "Desktop HUD on: click to close the window over the game" : "Launch Transparent HUD: a click-through window over the game")}
      onClick={(e) => {
        e.stopPropagation();
        if (on) actions.closeDesktop();
        else actions.launch();
      }}
    >
      <span className="switch-label">Desktop</span>
      <span className="switch-track" aria-hidden>
        <span className="switch-thumb" />
      </span>
      <span className="sr-only">{on ? "Close the desktop HUD" : "Launch Transparent HUD"}</span>
    </button>
  );
}

/** List row: thumbnail, name and version, author, status, outputs, quick actions, the desktop switch and the expand arrow. */
export function HudRow(p: HudItemProps) {
  const { entry } = p;
  return (
    <article className={`hud-row ${p.selected ? "is-selected" : ""}`} data-hud={entry.id} aria-label={entry.name} aria-expanded={p.selected} tabIndex={0} onClick={p.onSelect} onKeyDown={selectOnKey(p.onSelect)}>
      <Thumbnail entry={entry} className="hud-thumb-sm" />
      <div className="hud-row-main">
        <span className="hud-name">
          {entry.name} <span className="hud-version">({entry.version})</span>
        </span>
        <Meta entry={entry} />
      </div>
      <StatusBadge status={p.status} detail={p.statusDetail} />
      <OutputIndicators outputs={p.outputs} />
      <div className="hud-row-actions">
        <IconAction icon="settings" label="Settings" onClick={p.actions.settings} reason={p.reasons.settings} />
        <IconAction icon="eye" label="Preview" onClick={p.actions.preview} reason={p.reasons.preview} />
        <IconAction icon="copy" label="Copy OBS Browser URL" onClick={p.actions.copyUrl} reason={p.reasons.copyUrl} />
        <MenuButton
          label={`More actions for ${entry.name}`}
          items={[
            { label: "Reload", onClick: p.actions.reload, reason: p.reasons.reload },
            { label: "Stop", onClick: p.actions.stop, reason: p.reasons.stop },
            ...moreItems(p.actions, p.reasons),
          ]}
        />
        <LaunchSwitch overlay={p.overlay} actions={p.actions} reasons={p.reasons} />
        <button type="button" className={`icon-btn hud-expand ${p.selected ? "is-open" : ""}`} aria-label={p.selected ? "Hide details" : "Show details"} title={p.selected ? "Hide details" : "Details"} aria-expanded={p.selected} onClick={(e) => (e.stopPropagation(), p.onSelect())}>
          <Icon name="chevronDown" size={16} />
        </button>
      </div>
    </article>
  );
}
