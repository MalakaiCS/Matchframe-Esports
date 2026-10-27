import type { AutoDirectorAllowance } from "@matchframe/cloud-contracts";

export type AllowanceState = "none" | "ok" | "low" | "exhausted" | "over";

export interface AllowanceView {
  /** Everything usable this period: included hours + hour credits drawn this period + credits still available (= used + remaining). */
  budgetSeconds: number;
  usedSeconds: number;
  /** Never negative; see overSeconds. */
  remainingSeconds: number;
  /** Usage beyond the budget that no credit covered (remainingSeconds < 0 from the API). */
  overSeconds: number;
  /** 0–1 share of the budget used (1 when over or when there is no budget but some use). */
  fraction: number;
  state: AllowanceState;
  /** Can the director be (re-)armed for automatic direction right now. */
  canArm: boolean;
}

/** Share of the budget at which the meter warns ("running low"). */
export const LOW_FRACTION = 0.85;

/**
 * The API reports remaining = max(0, included − used) + available credits − uncovered overage, so
 * used + remaining is the period's whole budget (included + credits used this period + credits
 * left). Remaining can be negative: usage that ran past the limit (a match is never cut off mid-map).
 */
export function allowanceView(a: AutoDirectorAllowance): AllowanceView {
  const used = Math.max(0, a.usedSeconds);
  const budget = Math.max(0, used + a.remainingSeconds);
  const over = a.remainingSeconds < 0 ? -a.remainingSeconds : 0;
  const remaining = Math.max(0, a.remainingSeconds);
  const fraction = budget > 0 ? Math.min(1, used / budget) : used > 0 ? 1 : 0;
  let state: AllowanceState;
  if (over > 0) state = "over";
  else if (budget === 0) state = "none";
  else if (remaining === 0) state = "exhausted";
  else if (fraction >= LOW_FRACTION) state = "low";
  else state = "ok";
  return { budgetSeconds: budget, usedSeconds: used, remainingSeconds: remaining, overSeconds: over, fraction, state, canArm: a.remainingSeconds > 0 };
}
