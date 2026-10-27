/** Titles of the legal documents (kept apart from their text so menus don't load it). */
export const LEGAL_INDEX = [
  { slug: "terms", title: "Terms of Service" },
  { slug: "privacy", title: "Privacy Policy" },
  { slug: "cookies", title: "Cookie Policy" },
  { slug: "refunds", title: "Refund and Cancellation Policy" },
  { slug: "acceptable-use", title: "Acceptable Use Policy" },
  { slug: "eula", title: "End User Licence Agreement" },
] as const;

export type LegalSlug = (typeof LEGAL_INDEX)[number]["slug"];

export const legalTitle = (slug: LegalSlug): string => LEGAL_INDEX.find((d) => d.slug === slug)!.title;
