/** Original Matchframe glyphs: simple geometric shapes, no third-party icon artwork. */
interface P {
  size?: number;
  className?: string;
  title?: string;
}

const box = (size: number) => ({ width: size, height: size, viewBox: "0 0 24 24" });

export function GrenadeIcon({ type, size = 16, className }: P & { type: string }) {
  const common = { ...box(size), className: `mf-icon ${className ?? ""}`, role: "img" as const, "aria-label": type };
  switch (type) {
    case "weapon_hegrenade":
    case "he":
      return (
        <svg {...common}>
          <circle cx="12" cy="13" r="7" fill="currentColor" />
          <rect x="10" y="2" width="4" height="4" rx="1" fill="currentColor" />
          <path d="M12 9v4l3 2" stroke="var(--mf-ink-inverse)" strokeWidth="1.6" fill="none" />
        </svg>
      );
    case "weapon_flashbang":
    case "flashbang":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4.5" fill="currentColor" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <rect key={a} x="11.2" y="1.5" width="1.6" height="4" fill="currentColor" transform={`rotate(${a} 12 12)`} />
          ))}
        </svg>
      );
    case "weapon_smokegrenade":
    case "smoke":
      return (
        <svg {...common}>
          <circle cx="8" cy="14" r="5" fill="currentColor" />
          <circle cx="15" cy="11" r="6" fill="currentColor" />
          <circle cx="17" cy="16" r="4" fill="currentColor" />
        </svg>
      );
    case "weapon_molotov":
    case "molotov":
      return (
        <svg {...common}>
          <path d="M12 2c3 4 6 7 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 2 3 3 3-1-3 0-5 0-7z" fill="currentColor" />
        </svg>
      );
    case "weapon_incgrenade":
    case "incendiary":
      return (
        <svg {...common}>
          <path d="M12 4c2.5 3 5 5.5 5 9a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5.5.8 1.5 1.6 2.3 2.5 2.3-.7-2.3 0-4 0-5.8z" fill="currentColor" />
          <circle cx="12" cy="13" r="10" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      );
    case "weapon_decoy":
    case "decoy":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2.2" fill="none" />
          <circle cx="12" cy="12" r="2.5" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="6" fill="currentColor" />
        </svg>
      );
  }
}

export function BombIcon({ size = 16, className }: P) {
  return (
    <svg {...box(size)} className={`mf-icon ${className ?? ""}`} role="img" aria-label="bomb">
      <rect x="3" y="7" width="18" height="11" rx="2" fill="currentColor" />
      <rect x="6" y="10" width="7" height="5" fill="var(--mf-ink-inverse)" />
      <circle cx="17" cy="12.5" r="1.6" fill="var(--mf-ink-inverse)" />
    </svg>
  );
}

export function KitIcon({ size = 16, className }: P) {
  return (
    <svg {...box(size)} className={`mf-icon ${className ?? ""}`} role="img" aria-label="defuse kit">
      <path d="M4 18l8-8m-2-4l6 6m-2-8l6 6-3 3-6-6z" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function ArmorIcon({ helmet, size = 16, className }: P & { helmet: boolean }) {
  return (
    <svg {...box(size)} className={`mf-icon ${className ?? ""}`} role="img" aria-label={helmet ? "armor and helmet" : "armor"}>
      <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" fill="currentColor" />
      {helmet && <path d="M8 11h8" stroke="var(--mf-ink-inverse)" strokeWidth="2" />}
    </svg>
  );
}

export function SkullIcon({ size = 16, className }: P) {
  return (
    <svg {...box(size)} className={`mf-icon ${className ?? ""}`} role="img" aria-label="eliminated">
      <path d="M12 3a8 8 0 0 0-8 8c0 2.5 1.2 4.4 3 5.6V20h10v-3.4c1.8-1.2 3-3.1 3-5.6a8 8 0 0 0-8-8z" fill="currentColor" />
      <circle cx="9" cy="11" r="1.8" fill="var(--mf-ink-inverse)" />
      <circle cx="15" cy="11" r="1.8" fill="var(--mf-ink-inverse)" />
    </svg>
  );
}

export function EyeIcon({ size = 16, className }: P) {
  return (
    <svg {...box(size)} className={`mf-icon ${className ?? ""}`} role="img" aria-label="observed">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="currentColor" />
      <circle cx="12" cy="12" r="3.2" fill="var(--mf-ink-inverse)" />
    </svg>
  );
}

/** Headshot: a target with a centre dot. */
export function HeadshotIcon({ size = 16, className }: P) {
  return (
    <svg {...box(size)} className={`mf-icon ${className ?? ""}`} role="img" aria-label="headshot">
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="2.2" fill="none" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

/** The killer was blind: an eye with rays. */
export function BlindIcon({ size = 16, className }: P) {
  return (
    <svg {...box(size)} className={`mf-icon ${className ?? ""}`} role="img" aria-label="killer was flashed">
      <path d="M3 13s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5z" fill="currentColor" />
      <circle cx="12" cy="13" r="2.4" fill="var(--mf-ink-inverse)" />
      <path d="M12 2v3.5M5 4.5l2 2.6M19 4.5l-2 2.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
