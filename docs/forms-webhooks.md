# Form webhooks

Site admins can add a **Webhook** action under Forms → form → Actions. Webhooks
run after a submission reaches `complete`; the submission remains stored even
if the receiving service is temporarily unavailable.

## Configuration

- Endpoint must be a public HTTPS URL. Local and private network destinations
  are rejected.
- Fields is a comma-separated allowlist of fields declared by the form. Only
  those values leave Typeroll.
- Signing secret is encrypted at rest with `INTEGRATIONS_SECRET_KEY`, masked in
  the UI, excluded from API-key/MCP reads, and excluded from static builds.

## Request

```json
{
  "id": "evt_…",
  "type": "form.submission.completed",
  "created_at": "2026-08-24T14:00:00.000Z",
  "site_id": "example",
  "form_id": "newsletter",
  "submission_id": "…",
  "data": { "email": "person@example.com" }
}
```

Headers:

- `Idempotency-Key` and `X-Typeroll-Event-Id`: stable event id for this
  submission/action pair.
- `X-Typeroll-Event`: `form.submission.completed`.
- `X-Typeroll-Timestamp`: Unix seconds used for signing.
- `X-Typeroll-Signature`: `v1=<hex HMAC-SHA256>`.

Verify the signature over the exact bytes
`<X-Typeroll-Timestamp>.<raw request body>` using the configured secret. Check
the timestamp against a small tolerance and deduplicate on the event id.

Typeroll attempts transient failures up to three times. HTTP 408, 429, and 5xx
responses are retryable; other 4xx responses stop immediately. Delivery status,
attempt count, HTTP status, and the last operational error appear beside the
submission in the admin inbox.
