import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Sql } from "../db/sql.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  readonly kind: "smtp" | "outbox";
  send(msg: EmailMessage): Promise<void>;
}

/**
 * Every email is first written to the outbox table (audit trail, and the only delivery when SMTP
 * is not configured — development and tests read verification links from there).
 */
export class Mailer {
  private readonly transport: Transporter | null;
  readonly kind: "smtp" | "outbox";

  constructor(
    private readonly sql: Sql,
    smtpUrl: string | null,
    private readonly from: string,
    /** Development only: print outbox emails (they contain sign-in links) to the console. */
    private readonly logToConsole = false,
  ) {
    this.transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;
    this.kind = this.transport ? "smtp" : "outbox";
  }

  async send(msg: EmailMessage): Promise<void> {
    const { rows } = await this.sql.query<{ id: string }>("INSERT INTO outbox_emails (to_addr, subject, body_text) VALUES ($1, $2, $3) RETURNING id", [msg.to, msg.subject, msg.text]);
    if (!this.transport) {
      if (this.logToConsole) console.log(`[cloud-api] email (outbox only) to ${msg.to}: ${msg.subject}\n${msg.text}\n`);
      return;
    }
    await this.deliver(String(rows[0]!.id), msg);
  }

  /**
   * Staff: send an outbox email again (after an SMTP outage or a typo in the address was fixed).
   * Returns null when the email does not exist.
   */
  async resend(id: string): Promise<{ sent: boolean; error: string | null } | null> {
    const { rows } = await this.sql.query<{ to_addr: string; subject: string; body_text: string }>("SELECT to_addr, subject, body_text FROM outbox_emails WHERE id = $1", [id]);
    const e = rows[0];
    if (!e) return null;
    if (!this.transport) return { sent: false, error: "email delivery is not configured (SMTP_URL is not set); the email stays in the outbox" };
    return this.deliver(id, { to: e.to_addr, subject: e.subject, text: e.body_text });
  }

  private async deliver(id: string, msg: EmailMessage): Promise<{ sent: boolean; error: string | null }> {
    try {
      await this.transport!.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
      await this.sql.query("UPDATE outbox_emails SET sent_at = now(), error = NULL WHERE id = $1", [id]);
      return { sent: true, error: null };
    } catch (e) {
      const error = String(e).slice(0, 500);
      await this.sql.query("UPDATE outbox_emails SET error = $2 WHERE id = $1", [id, error]);
      return { sent: false, error };
    }
  }
}
