import { useState } from "react";
import type { FormEvent } from "react";
import { HourPack as HourPackSchema, Plan as PlanSchema } from "@matchframe/cloud-contracts";
import { api, describeError } from "../../api/index.ts";
import type { HourPack, Plan } from "../../api/types.ts";
import { Alert, Badge, Button, CheckField, ErrorState, FieldShell, FormError, Loading, TextField } from "../../components/ui.tsx";
import { formatMoney } from "../../lib/format.ts";
import { useResource } from "../../lib/hooks.ts";
import { validate } from "../../lib/validate.ts";

/** Form state keeps raw strings so partially typed numbers don't jump around. */
interface PlanForm {
  id: string;
  name: string;
  description: string;
  priceMonthlyCents: string;
  currency: string;
  includedAutoDirectorHours: string;
  autoDirector: boolean;
  learnedDirectorShadow: boolean;
  maxDevices: string;
  maxMembers: string;
  stripePriceId: string;
  public: boolean;
  sortOrder: string;
}

interface PackForm {
  id: string;
  name: string;
  hours: string;
  priceCents: string;
  currency: string;
  stripePriceId: string;
  validDays: string;
  public: boolean;
}

const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

export function planToForm(p: Plan | null): PlanForm {
  return {
    id: p?.id ?? "",
    name: p?.name ?? "",
    description: p?.description ?? "",
    priceMonthlyCents: p?.priceMonthlyCents === null || p === null ? "" : String(p.priceMonthlyCents),
    currency: p?.currency ?? "usd",
    includedAutoDirectorHours: String(p?.includedAutoDirectorHours ?? 0),
    autoDirector: p?.features.autoDirector ?? true,
    learnedDirectorShadow: p?.features.learnedDirectorShadow ?? false,
    maxDevices: String(p?.features.maxDevices ?? 1),
    maxMembers: String(p?.features.maxMembers ?? 2),
    stripePriceId: p?.stripePriceId ?? "",
    public: p?.public ?? true,
    sortOrder: String(p?.sortOrder ?? 0),
  };
}

/** Form → the exact Plan body the API validates (empty price = "price on request", empty Stripe id = not purchasable). */
export function formToPlan(f: PlanForm): unknown {
  return {
    id: f.id.trim(),
    name: f.name.trim(),
    description: f.description.trim(),
    priceMonthlyCents: f.priceMonthlyCents.trim() === "" ? null : num(f.priceMonthlyCents),
    currency: f.currency.trim().toLowerCase(),
    includedAutoDirectorHours: num(f.includedAutoDirectorHours),
    features: { autoDirector: f.autoDirector, learnedDirectorShadow: f.learnedDirectorShadow, maxDevices: num(f.maxDevices), maxMembers: num(f.maxMembers) },
    stripePriceId: f.stripePriceId.trim() || null,
    public: f.public,
    sortOrder: num(f.sortOrder),
  };
}

export function packToForm(h: HourPack | null): PackForm {
  return {
    id: h?.id ?? "",
    name: h?.name ?? "",
    hours: String(h?.hours ?? 10),
    priceCents: String(h?.priceCents ?? 0),
    currency: h?.currency ?? "usd",
    stripePriceId: h?.stripePriceId ?? "",
    validDays: h?.validDays === null ? "" : String(h?.validDays ?? 365),
    public: h?.public ?? true,
  };
}

export function formToPack(f: PackForm): unknown {
  return {
    id: f.id.trim(),
    name: f.name.trim(),
    hours: num(f.hours),
    priceCents: num(f.priceCents),
    currency: f.currency.trim().toLowerCase(),
    stripePriceId: f.stripePriceId.trim() || null,
    validDays: f.validDays.trim() === "" ? null : num(f.validDays),
    public: f.public,
  };
}

/** Nested feature errors ("features.maxDevices") surface on their own inputs. */
function flatErrors(schema: Parameters<typeof validate>[0], body: unknown): Record<string, string> {
  const top = validate(schema, body);
  const r = schema.safeParse(body);
  if (!r.success) {
    for (const i of r.error.issues as { path: PropertyKey[]; message: string }[]) {
      if (i.path[0] === "features" && i.path[1] !== undefined) top[String(i.path[1])] ??= i.message.startsWith("Too small") ? "Must be at least 1." : i.message.startsWith("Invalid input: expected number") ? "Enter a whole number." : i.message;
    }
  }
  delete top.features;
  return top;
}

function money(cents: string, currency: string): string {
  const n = num(cents);
  if (!Number.isFinite(n) || currency.trim().length !== 3) return "";
  return `= ${formatMoney(n, currency.trim())}`;
}

function PlanEditor({ plan, onSaved, onCancel }: { plan: Plan | null; onSaved: (p: Plan) => void; onCancel: () => void }) {
  const [f, setF] = useState<PlanForm>(() => planToForm(plan));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PlanForm>(k: K) => (v: PlanForm[K]) => setF((s) => ({ ...s, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = formToPlan(f);
    const errs = flatErrors(PlanSchema, body);
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.savePlan(PlanSchema.parse(body)));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }
  return (
    <form className="editor" onSubmit={submit} noValidate aria-label={plan ? `Edit plan ${plan.name}` : "New plan"}>
      <h3 className="h3">{plan ? `Edit plan “${plan.name}”` : "New plan"}</h3>
      <div className="editor-grid">
        <TextField label="Plan id" value={f.id} onValue={set("id")} disabled={!!plan} error={errors.id} hint={plan ? "Ids can't change; create a new plan instead." : "Lowercase letters, digits and dashes, 2–40 characters."} />
        <TextField label="Name" value={f.name} onValue={set("name")} error={errors.name} maxLength={60} />
        <FieldShell label="Description" error={errors.description} hint="Up to 500 characters, for staff reference. Plan cards show only price, hours, computers and members.">
          {({ id, describedBy, invalid }) => <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} rows={3} maxLength={500} value={f.description} onChange={(e) => set("description")(e.target.value)} />}
        </FieldShell>
        <TextField label="Display price per month (minor units, e.g. cents)" type="number" inputMode="numeric" min={0} step={1} value={f.priceMonthlyCents} onValue={set("priceMonthlyCents")} error={errors.priceMonthlyCents} hint={f.priceMonthlyCents.trim() === "" ? "Empty = “Price on request”. The amount charged is the Stripe price." : `${money(f.priceMonthlyCents, f.currency)} · the amount charged is the Stripe price.`} />
        <TextField label="Currency" value={f.currency} onValue={set("currency")} maxLength={3} error={errors.currency} hint="ISO code, e.g. usd, eur." />
        <TextField label="Included auto-director hours per period" type="number" inputMode="decimal" min={0} step="0.5" value={f.includedAutoDirectorHours} onValue={set("includedAutoDirectorHours")} error={errors.includedAutoDirectorHours} />
        <TextField label="Max linked computers" type="number" inputMode="numeric" min={1} step={1} value={f.maxDevices} onValue={set("maxDevices")} error={errors.maxDevices} />
        <TextField label="Max team members" type="number" inputMode="numeric" min={1} step={1} value={f.maxMembers} onValue={set("maxMembers")} error={errors.maxMembers} hint="Counts pending invitations." />
        <TextField label="Stripe price id" value={f.stripePriceId} onValue={set("stripePriceId")} error={errors.stripePriceId} placeholder="price_…" hint="A recurring monthly price. Empty = can't be bought online." />
        <TextField label="Sort order" type="number" inputMode="numeric" step={1} value={f.sortOrder} onValue={set("sortOrder")} error={errors.sortOrder} hint="Lower numbers are listed first." />
      </div>
      <div className="editor-checks">
        <CheckField label="Automatic direction" checked={f.autoDirector} onValue={set("autoDirector")} hint="Off = the plan includes no auto-director hours (credits are not usable either)." />
        <CheckField label="Learned-director shadow mode" checked={f.learnedDirectorShadow} onValue={set("learnedDirectorShadow")} />
        <CheckField label="Public (shown on the pricing page and purchasable)" checked={f.public} onValue={set("public")} />
      </div>
      <FormError error={error} />
      <div className="button-row">
        <Button type="submit" variant="primary" busy={busy}>
          Save plan
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function PackEditor({ pack, onSaved, onCancel }: { pack: HourPack | null; onSaved: (h: HourPack) => void; onCancel: () => void }) {
  const [f, setF] = useState<PackForm>(() => packToForm(pack));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PackForm>(k: K) => (v: PackForm[K]) => setF((s) => ({ ...s, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = formToPack(f);
    const errs = validate(HourPackSchema, body);
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.saveHourPack(HourPackSchema.parse(body)));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }
  return (
    <form className="editor" onSubmit={submit} noValidate aria-label={pack ? `Edit hour pack ${pack.name}` : "New hour pack"}>
      <h3 className="h3">{pack ? `Edit hour pack “${pack.name}”` : "New hour pack"}</h3>
      <div className="editor-grid">
        <TextField label="Pack id" value={f.id} onValue={set("id")} disabled={!!pack} error={errors.id} hint={pack ? "Ids can't change." : "Lowercase letters, digits and dashes, 2–40 characters."} />
        <TextField label="Name" value={f.name} onValue={set("name")} error={errors.name} maxLength={60} />
        <TextField label="Hours" type="number" inputMode="decimal" min={0} step="0.5" value={f.hours} onValue={set("hours")} error={errors.hours} />
        <TextField label="Display price (minor units, e.g. cents)" type="number" inputMode="numeric" min={0} step={1} value={f.priceCents} onValue={set("priceCents")} error={errors.priceCents} hint={`${money(f.priceCents, f.currency)} · the amount charged is the Stripe price.`} />
        <TextField label="Currency" value={f.currency} onValue={set("currency")} maxLength={3} error={errors.currency} />
        <TextField label="Stripe price id" value={f.stripePriceId} onValue={set("stripePriceId")} error={errors.stripePriceId} placeholder="price_…" hint="A one-time price. Empty = can't be bought online." />
        <TextField label="Valid for (days after purchase)" type="number" inputMode="numeric" min={1} step={1} value={f.validDays} onValue={set("validDays")} error={errors.validDays} hint="Empty = never expires." />
      </div>
      <div className="editor-checks">
        <CheckField label="Public (shown and purchasable)" checked={f.public} onValue={set("public")} />
      </div>
      <FormError error={error} />
      <div className="button-row">
        <Button type="submit" variant="primary" busy={busy}>
          Save hour pack
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Editing = { kind: "plan"; item: Plan | null } | { kind: "pack"; item: HourPack | null } | null;

/** Plan and hour-pack catalogue; read-only for support staff (editing needs the admin role). */
export function CatalogEditor({ readOnly = false }: { readOnly?: boolean }) {
  const cat = useResource("admin-catalog", api.catalog);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saved = (what: string) => {
    setEditing(null);
    setNotice(`${what} saved. The pricing page shows it straight away.`);
    void cat.reload();
  };
  if (cat.loading && !cat.data) return <Loading />;
  if (cat.error) return <ErrorState error={cat.error} onRetry={cat.reload} />;
  if (!cat.data) return null;
  return (
    <div className="stack-lg">
      {notice && <Alert tone="ok">{notice}</Alert>}
      <p className="small muted">Display prices are informational; customers are charged the Stripe price referenced by its id. A plan or pack is purchasable only with a Stripe price id and Stripe configured on the server.</p>
      <section aria-labelledby="cat-plans">
        <div className="section-head">
          <h3 id="cat-plans" className="h3">
            Plans
          </h3>
          {!readOnly && (
            <Button size="sm" onClick={() => setEditing({ kind: "plan", item: null })}>
              New plan
            </Button>
          )}
        </div>
        <table className="rtable">
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Price</th>
              <th scope="col">Hours</th>
              <th scope="col">Limits</th>
              <th scope="col">Stripe price</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cat.data.plans.map((p) => (
              <tr key={p.id}>
                <td data-label="Plan">
                  <span className="strong">{p.name}</span> <span className="mono small muted">{p.id}</span> {!p.public && <Badge>Hidden</Badge>}
                </td>
                <td data-label="Price">{p.priceMonthlyCents === null ? "On request" : formatMoney(p.priceMonthlyCents, p.currency)}</td>
                <td data-label="Hours">{p.features.autoDirector ? `${p.includedAutoDirectorHours} h` : "No automation"}</td>
                <td data-label="Limits">
                  {p.features.maxDevices} {p.features.maxDevices === 1 ? "computer" : "computers"} · {p.features.maxMembers} {p.features.maxMembers === 1 ? "member" : "members"}
                  {p.features.learnedDirectorShadow ? " · shadow" : ""}
                </td>
                <td data-label="Stripe price" className="mono small">
                  {p.stripePriceId ?? <Badge tone="warn">none</Badge>}
                </td>
                <td data-label="Actions" className="cell-actions">
                  {!readOnly && (
                    <Button size="sm" onClick={() => setEditing({ kind: "plan", item: p })}>
                      Edit <span className="visually-hidden">{p.name}</span>
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {editing?.kind === "plan" && <PlanEditor key={editing.item?.id ?? "new"} plan={editing.item} onCancel={() => setEditing(null)} onSaved={(p) => saved(`Plan “${p.name}”`)} />}
      </section>
      <section aria-labelledby="cat-packs">
        <div className="section-head">
          <h3 id="cat-packs" className="h3">
            Hour packs
          </h3>
          {!readOnly && (
            <Button size="sm" onClick={() => setEditing({ kind: "pack", item: null })}>
              New hour pack
            </Button>
          )}
        </div>
        <table className="rtable">
          <thead>
            <tr>
              <th scope="col">Pack</th>
              <th scope="col">Hours</th>
              <th scope="col">Price</th>
              <th scope="col">Validity</th>
              <th scope="col">Stripe price</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cat.data.hourPacks.map((h) => (
              <tr key={h.id}>
                <td data-label="Pack">
                  <span className="strong">{h.name}</span> <span className="mono small muted">{h.id}</span> {!h.public && <Badge>Hidden</Badge>}
                </td>
                <td data-label="Hours">{h.hours} h</td>
                <td data-label="Price">{formatMoney(h.priceCents, h.currency)}</td>
                <td data-label="Validity">{h.validDays ? `${h.validDays} days` : "Never expires"}</td>
                <td data-label="Stripe price" className="mono small">
                  {h.stripePriceId ?? <Badge tone="warn">none</Badge>}
                </td>
                <td data-label="Actions" className="cell-actions">
                  {!readOnly && (
                    <Button size="sm" onClick={() => setEditing({ kind: "pack", item: h })}>
                      Edit <span className="visually-hidden">{h.name}</span>
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {editing?.kind === "pack" && <PackEditor key={editing.item?.id ?? "new"} pack={editing.item} onCancel={() => setEditing(null)} onSaved={(h) => saved(`Hour pack “${h.name}”`)} />}
      </section>
    </div>
  );
}
