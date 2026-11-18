import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { HudLibraryEntry, HudOutputMode, HudOutputSmoothness } from "@matchframe/contracts";
import type { OverlayState } from "../../api/desktop.ts";
import { Icon } from "../../components/icons.tsx";
import { Badge, Button } from "../../components/ui.tsx";
import type { HudDisplayStatus } from "../../lib/hudLibrary.ts";
import { KIND_LABEL, OUTPUT_LABEL, OUTPUT_MODES, STATUS_INFO, resolutionLabel, stutters } from "../../lib/hudLibrary.ts";
import { useLowSpec } from "../../lib/lowSpec.ts";
import { t } from "../../i18n/index.ts";

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
  /** Shared with the organisation's other computers (account sync). */
  shared?: boolean;
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

/** Desktop / OBS / Preview indicators with the number of connected outputs of each kind, amber when one stutters or draws too few frames. */
export function OutputIndicators({ outputs, smoothness = {} }: { outputs: Record<HudOutputMode, number>; smoothness?: Partial<Record<HudOutputMode, HudOutputSmoothness>> }) {
  return (
    <span className="hud-outputs" aria-label={t("hudlib.card.activeOutputs")}>
      {OUTPUT_MODES.map((m) => {
        const s = outputs[m] ? smoothness[m] : undefined;
        const timing = s ? ` · ${t("hudlib.card.timing", { fps: s.fps, pause: s.worstPauseMs })}` : "";
        return (
          <span key={m} className={`hud-output ${outputs[m] ? "is-on" : ""} ${stutters(s) ? "is-stutter" : ""}`} title={`${OUTPUT_LABEL[m]}: ${outputs[m] ? `${t("hudlib.card.connected", { count: outputs[m] })}${timing}` : t("hudlib.card.notConnected")}`} data-output={m}>
            <span className="hud-output-dot" aria-hidden />
            {OUTPUT_LABEL[m]}
            {outputs[m] > 1 ? <span className="num"> {outputs[m]}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

/** An image drawn once onto a canvas: an animated thumbnail (GIF, animated WebP or PNG) stays still. */
function StillImage({ src, onError }: { src: string; onError(): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const failed = useRef(onError);
  failed.current = onError;
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => {
      const c = ref.current;
      if (!live || !c) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.onerror = () => live && failed.current();
    img.src = src;
    return () => {
      live = false;
      img.onload = null;
      img.onerror = null;
    };
  }, [src]);
  return <canvas ref={ref} className="hud-thumb-still" aria-hidden data-testid="hud-thumb-still" />;
}

export function Thumbnail({ entry, className = "" }: { entry: HudLibraryEntry; className?: string }) {
  const [failed, setFailed] = useState(false);
  // Low-spec mode (ADR-078): thumbnails are drawn still in the console.
  const still = useLowSpec()?.lowSpec === true;
  useEffect(() => setFailed(false), [entry.thumbnailUrl]);
  return (
    <div className={`hud-thumb ${className}`}>
      {entry.thumbnailUrl && !failed ? (
        still ? (
          <StillImage src={entry.thumbnailUrl} onError={() => setFailed(true)} />
        ) : (
          <img src={entry.thumbnailUrl} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
        )
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
    { label: t("hudlib.action.duplicate"), onClick: a.duplicate, reason: r.duplicate },
    { label: t("hudlib.action.exportZip"), onClick: a.exportZip, reason: r.exportZip },
    { label: t("hudlib.action.openFolder"), onClick: a.openFolder, reason: r.openFolder },
    { label: t("hudlib.action.removeMenu"), onClick: a.remove, reason: r.remove, danger: true },
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
        {t("hudlib.action.closeDesktop")}
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
      <Icon name="play" size={14} /> {t("hudlib.action.launch")}
    </Button>
  );
}

function SecondaryActions({ entry, actions, reasons }: Pick<HudItemProps, "entry" | "actions" | "reasons">) {
  return (
    <div className="hud-actions-secondary">
      <IconAction icon="eye" label={t("hudlib.action.preview")} onClick={actions.preview} reason={reasons.preview} />
      <IconAction icon="copy" label={t("hudlib.action.copyUrl")} onClick={actions.copyUrl} reason={reasons.copyUrl} />
      <IconAction icon="settings" label={t("hudlib.action.settings")} onClick={actions.settings} reason={reasons.settings} />
      <IconAction icon="reload" label={t("hudlib.action.reload")} onClick={actions.reload} reason={reasons.reload} />
      <IconAction icon="stop" label={t("hudlib.action.stop")} onClick={actions.stop} reason={reasons.stop} />
      <MenuButton label={t("hudlib.action.more", { name: entry.name })} items={moreItems(actions, reasons)} />
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

function Meta({ entry, shared }: { entry: HudLibraryEntry; shared?: boolean }): ReactNode {
  return (
    <span className="hud-meta">
      <span>CS2</span>
      <span>{entry.author || t("hudlib.card.unknownAuthor")}</span>
      <span>v{entry.version}</span>
      {entry.kind !== "imported" ? <span>{KIND_LABEL[entry.kind]}</span> : null}
      {shared ? (
        <span className="hud-shared" title={t("hudlib.card.sharedTitle")}>
          {t("hudlib.card.shared")}
        </span>
      ) : null}
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
        <Meta entry={entry} shared={p.shared} />
        <p className="hud-desc" title={entry.description}>
          {entry.category ? <span className="hud-category">{entry.category}</span> : null}
          {entry.description || t("hudlib.card.noDescription")}
        </p>
        <OutputIndicators outputs={p.outputs} smoothness={p.entry.smoothness} />
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
      title={reason ?? (on ? t("hudlib.card.switchOn") : t("hudlib.card.switchOff"))}
      onClick={(e) => {
        e.stopPropagation();
        if (on) actions.closeDesktop();
        else actions.launch();
      }}
    >
      <span className="switch-label">{t("hudlib.output.desktop")}</span>
      <span className="switch-track" aria-hidden>
        <span className="switch-thumb" />
      </span>
      <span className="sr-only">{on ? t("hudlib.card.closeDesktopHud") : t("hudlib.action.launch")}</span>
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
        <Meta entry={entry} shared={p.shared} />
      </div>
      <StatusBadge status={p.status} detail={p.statusDetail} />
      <OutputIndicators outputs={p.outputs} smoothness={p.entry.smoothness} />
      <div className="hud-row-actions">
        <IconAction icon="settings" label={t("hudlib.action.settings")} onClick={p.actions.settings} reason={p.reasons.settings} />
        <IconAction icon="eye" label={t("hudlib.action.preview")} onClick={p.actions.preview} reason={p.reasons.preview} />
        <IconAction icon="copy" label={t("hudlib.action.copyUrl")} onClick={p.actions.copyUrl} reason={p.reasons.copyUrl} />
        <MenuButton
          label={t("hudlib.action.more", { name: entry.name })}
          items={[
            { label: t("hudlib.action.reload"), onClick: p.actions.reload, reason: p.reasons.reload },
            { label: t("hudlib.action.stop"), onClick: p.actions.stop, reason: p.reasons.stop },
            ...moreItems(p.actions, p.reasons),
          ]}
        />
        <LaunchSwitch overlay={p.overlay} actions={p.actions} reasons={p.reasons} />
        <button type="button" className={`icon-btn hud-expand ${p.selected ? "is-open" : ""}`} aria-label={p.selected ? t("hudlib.card.hideDetails") : t("hudlib.card.showDetails")} title={p.selected ? t("hudlib.card.hideDetails") : t("common.details")} aria-expanded={p.selected} onClick={(e) => (e.stopPropagation(), p.onSelect())}>
          <Icon name="chevronDown" size={16} />
        </button>
      </div>
    </article>
  );
}
