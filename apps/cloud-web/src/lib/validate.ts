interface IssueLike {
  code?: string;
  path: PropertyKey[];
  message: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  format?: string;
  origin?: string;
}

function friendly(i: IssueLike): string {
  if (i.code === "too_small" && i.origin === "string") return Number(i.minimum) <= 1 ? "Required." : i.message.startsWith("Too small") ? `At least ${String(i.minimum)} characters.` : sentenceCase(i.message);
  if (i.code === "too_big" && i.origin === "string") return `At most ${String(i.maximum)} characters.`;
  if (i.code === "invalid_format" && i.format === "email") return "Enter a valid email address.";
  if (i.code === "invalid_type") return "Required.";
  return sentenceCase(i.message);
}

function sentenceCase(s: string): string {
  const t = s.trim();
  const c = t ? t[0]!.toUpperCase() + t.slice(1) : t;
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/** Any zod schema (structurally typed so the site needs no direct zod dependency). */
export interface SafeParser {
  safeParse(v: unknown): { success: true } | { success: false; error: { issues: readonly unknown[] } };
}

/**
 * Validates form values against a shared contract schema (the same zod schema the API uses) and
 * returns one friendly message per top-level field; empty when valid.
 */
export function validate(schema: SafeParser, values: unknown): Record<string, string> {
  const r = schema.safeParse(values);
  const out: Record<string, string> = {};
  if (r.success) return out;
  for (const issue of r.error.issues as IssueLike[]) {
    const key = String(issue.path[0] ?? "");
    if (!out[key]) out[key] = friendly(issue);
  }
  return out;
}
