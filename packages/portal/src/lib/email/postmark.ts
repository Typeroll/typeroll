// Postmark transport. Uses the HTTP API directly (no SDK dependency).
// https://postmarkapp.com/developer/user-guide/send-email-with-api

import type { EmailMessage, SendResult } from './types';

const POSTMARK_ENDPOINT = 'https://api.postmarkapp.com/email';

export async function sendViaPostmark(
  serverToken: string,
  messageStream: string | undefined,
  msg: EmailMessage,
): Promise<SendResult> {
  const body: Record<string, unknown> = {
    From: msg.from,
    To: msg.to,
    Subject: msg.subject,
    MessageStream: messageStream || 'outbound',
  };
  if (msg.cc) body.Cc = msg.cc;
  if (msg.bcc) body.Bcc = msg.bcc;
  if (msg.replyTo) body.ReplyTo = msg.replyTo;
  if (msg.html) body.HtmlBody = msg.html;
  if (msg.text) body.TextBody = msg.text;

  const res = await fetch(POSTMARK_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': serverToken,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as {
    MessageID?: string;
    Message?: string;
    ErrorCode?: number;
  };
  if (!res.ok || (json.ErrorCode != null && json.ErrorCode !== 0)) {
    return { ok: false, error: json.Message || `Postmark error (HTTP ${res.status})` };
  }
  return { ok: true, id: json.MessageID };
}
