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
  ) {
    this.transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;
    this.kind = this.transport ? "smtp" : "outbox";
  }

  async send(msg: EmailMessage): Promise<void> {
    const { rows } = await this.sql.query<{ id: string }>("INSERT INTO outbox_emails (to_addr, subject, body_text) VALUES ($1, $2, $3) RETURNING id", [msg.to, msg.subject, msg.text]);
    if (!this.transport) return;
    try {
      await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
      await this.sql.query("UPDATE outbox_emails SET sent_at = now() WHERE id = $1", [rows[0]!.id]);
    } catch (e) {
      await this.sql.query("UPDATE outbox_emails SET error = $2 WHERE id = $1", [rows[0]!.id, String(e).slice(0, 500)]);
    }
  }
}
