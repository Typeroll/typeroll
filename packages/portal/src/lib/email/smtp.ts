// SMTP transport via nodemailer.

import nodemailer from 'nodemailer';
import type { EmailMessage, SendResult } from './types';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export async function sendViaSmtp(cfg: SmtpConfig, msg: EmailMessage): Promise<SendResult> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
  });
  try {
    const info = await transport.sendMail({
      from: msg.from,
      to: msg.to,
      cc: msg.cc || undefined,
      bcc: msg.bcc || undefined,
      replyTo: msg.replyTo || undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
    return { ok: true, id: info.messageId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
