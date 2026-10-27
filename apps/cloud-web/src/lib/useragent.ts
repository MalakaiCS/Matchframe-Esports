/**
 * Readable browser and operating system from a User-Agent string, for session lists ("Chrome 142
 * on Windows"). Best effort only: user agents can be spoofed and are shown as a hint, not proof.
 */
export interface DeviceInfo {
  browser: string;
  os: string;
  label: string;
}

const BROWSERS: [RegExp, string][] = [
  [/MatchframeEsports\/([\d.]+)/, "Matchframe program"],
  [/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
  [/CriOS\/(\d+)/, "Chrome"],
  [/Electron\/(\d+)/, "Electron"],
  [/Chrome\/(\d+)/, "Chrome"],
  [/Version\/(\d+)[\d.]*.*Safari\//, "Safari"],
  [/curl\/([\d.]+)/, "curl"],
];

function osOf(ua: string): string {
  if (/iPhone|iPod/.test(ua)) return "iOS";
  if (/iPad/.test(ua)) return "iPadOS";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}

export function describeUserAgent(ua: string | null | undefined): DeviceInfo {
  if (!ua || !ua.trim()) return { browser: "Unknown browser", os: "", label: "Unknown device" };
  let browser = "Unknown browser";
  for (const [re, name] of BROWSERS) {
    const m = re.exec(ua);
    if (m) {
      browser = name === "Matchframe program" || name === "curl" ? name : `${name} ${m[1]}`;
      break;
    }
  }
  const os = osOf(ua);
  return { browser, os, label: os ? `${browser} on ${os}` : browser };
}
