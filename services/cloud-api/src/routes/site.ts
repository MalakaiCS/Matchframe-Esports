import { ContactRequest } from "@matchframe/cloud-contracts";
import type { CloudApp } from "../app.ts";
import type { Router } from "../http/router.ts";
import { reply } from "../http/router.ts";

/** Public website information: business details for the legal and contact pages, and the contact form. */
export function registerSiteRoutes(r: Router, app: CloudApp): void {
  r.add("GET", "/v1/site", { summary: "Business details shown on the website (company name, support email, legal effective date)" }, () => app.cfg.site);

  r.add("POST", "/v1/contact", { body: ContactRequest, summary: "Contact form: stored for the staff support inbox (and emailed to MF_SUPPORT_EMAIL when set)" }, async (ctx) => {
    app.rateLimit(app.limits.contact, `contact:${ctx.ip}`);
    const b = ctx.body;
    const user = await app.optionalUser(ctx);
    // An organisation is only recorded for a signed-in member of it.
    const orgId = user && b.orgId && (await app.roleIn(user.id, b.orgId)) ? b.orgId : null;
    const { rows } = await app.sql.query<{ id: string }>(
      "INSERT INTO contact_messages (name, email, topic, message, org_id, user_id, ip) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [b.name, b.email, b.topic, b.message, orgId, user?.id ?? null, ctx.ip],
    );
    const to = app.cfg.site.supportEmail;
    if (to) {
      await app.mailer.send({
        to,
        subject: `[${app.cfg.site.websiteName} contact · ${b.topic}] ${b.name}`,
        text: `New message from the website contact form (#${rows[0]!.id}).\n\nFrom: ${b.name} <${b.email}>\nTopic: ${b.topic}\n${user ? `Account: ${user.email} (${user.id})\n` : ""}${orgId ? `Organisation: ${orgId}\n` : ""}\n${b.message}\n\nReply to the sender directly, then mark it handled in the staff support inbox: ${app.cfg.publicUrl}/admin`,
      });
    }
    return reply({ status: 201, json: { received: true } });
  });
}
