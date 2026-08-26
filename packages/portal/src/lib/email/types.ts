// A provider-agnostic outbound email. Connectors translate this into their
// own wire shape (Postmark JSON, SMTP envelope).
export interface EmailMessage {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  /** HTML body. At least one of html/text must be present. */
  html?: string;
  /** Plain-text body. */
  text?: string;
}

export interface SendResult {
  ok: boolean;
  /** Provider message id when available. */
  id?: string;
  error?: string;
}
