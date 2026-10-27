import { FEATURES } from "./features.tsx";
import { LEGAL_DOCS } from "./legal.tsx";

/** Public navigation: header menus and footer columns. Every `to` must be a real route (tested). */
export interface NavLink {
  to: string;
  label: string;
  description?: string;
}

export interface NavMenu {
  label: string;
  /** Matches the current path for the active state. */
  match: string[];
  groups: { title: string; links: NavLink[] }[];
}

export type NavItem = NavLink | NavMenu;

export const isMenu = (n: NavItem): n is NavMenu => "groups" in n;

export const HEADER_NAV: NavItem[] = [
  {
    label: "Product",
    match: ["/features", "/how-it-works", "/requirements"],
    groups: [
      {
        title: "Features",
        links: [{ to: "/features", label: "All features", description: "Everything the program does" }, ...FEATURES.map((f) => ({ to: `/features/${f.slug}`, label: f.nav }))],
      },
      {
        title: "Learn",
        links: [
          { to: "/how-it-works", label: "How it works", description: "Program, account and hours" },
          { to: "/requirements", label: "System requirements", description: "Windows, CS2, OBS and network" },
          { to: "/changelog", label: "Changelog", description: "What's new" },
        ],
      },
    ],
  },
  { to: "/use-cases", label: "Use cases" },
  { to: "/pricing", label: "Pricing" },
  {
    label: "Resources",
    match: ["/help", "/faq", "/status", "/security"],
    groups: [
      {
        title: "Resources",
        links: [
          { to: "/help", label: "Help centre", description: "Guides for your account and plan" },
          { to: "/faq", label: "FAQ", description: "Answers to common questions" },
          { to: "/status", label: "Service status", description: "Live check of the website and API" },
          { to: "/security", label: "Security", description: "How we protect your data" },
        ],
      },
    ],
  },
  { to: "/contact", label: "Contact" },
];

export const FOOTER_COLUMNS: { title: string; links: NavLink[] }[] = [
  {
    title: "Product",
    links: [
      { to: "/features", label: "Features" },
      { to: "/how-it-works", label: "How it works" },
      { to: "/requirements", label: "System requirements" },
      { to: "/use-cases", label: "Use cases" },
      { to: "/pricing", label: "Pricing" },
      { to: "/download", label: "Download" },
    ],
  },
  {
    title: "Resources",
    links: [
      { to: "/help", label: "Help centre" },
      { to: "/faq", label: "FAQ" },
      { to: "/changelog", label: "Changelog" },
      { to: "/status", label: "Status" },
      { to: "/contact?topic=support", label: "Contact support" },
    ],
  },
  {
    title: "Company",
    links: [
      { to: "/about", label: "About" },
      { to: "/contact", label: "Contact" },
      { to: "/security", label: "Security" },
    ],
  },
  {
    title: "Legal",
    links: [{ to: "/legal", label: "Legal overview" }, ...LEGAL_DOCS.map((d) => ({ to: `/legal/${d.slug}`, label: d.title }))],
  },
];
