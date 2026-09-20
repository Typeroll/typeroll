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
  /** Platform correlation only; never populated from untrusted message headers. */
  deliveryId?: string;
  /** Internal forwarding only; suppress automatic replies and forwarding loops. */
  forwarded?: boolean;
}

export interface SendResult {
  ok: boolean;
  /** Provider message id when available. */
  id?: string;
  error?: string;
  /** Only an explicit provider rejection may be retried safely. */
  failure?: 'rejected' | 'retryable_rejection' | 'unknown';
}
