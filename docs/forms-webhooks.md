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

## Timing and retries

The visitor's submit request never waits long for a receiver:

- Up to three webhooks of a submission get one attempt while the request is
  running, all within three seconds in total. Respond with a `2xx` status
  quickly and do slow work after responding.
- Any further webhooks, and any attempt that times out or fails transiently,
  are stored as `pending` and retried in the background: about 1 minute,
  5 minutes, 30 minutes and 2 hours after the previous attempt. After five
  attempts in total the delivery is `failed`.
- HTTP 408, 429 and 5xx responses, timeouts and network errors are
  retryable. Other 4xx responses, redirects, a destination that is not a
  public address and a removed webhook stop immediately with `failed`.
- The visitor's response never depends on webhook delivery. A submission is
  stored and confirmed even when every webhook fails.

Every attempt for one submission and webhook sends the same event id
(`Idempotency-Key`, `X-Typeroll-Event-Id`, payload `id`) and the same body,
signed with that attempt's timestamp. A request that timed out on Typeroll's
side may still have reached you, so deduplicate on the event id.

Background retries use the scheduled-work index (`scheduled_work`, kind
`form_webhook_retry`): Cloud Tasks, the in-process timer, the self-hosted
worker loop or the periodic `/api/internal/publish-sweep` runs a due retry,
so the exact time depends on that scheduler's interval (`PUBLISH_SWEEP_INTERVAL_MS`
for the worker loop; every few minutes on Cloud). Each attempt is leased on
the delivery record with a compare-and-update, so overlapping sweeps or
instances never send the same attempt twice. A retry uses the webhook's
current URL and secret; removing the webhook ends its pending retries. The
request body is kept on the delivery record only while it is pending, and the
record is removed with its submission.

Delivery status, attempt count, HTTP status, and the last operational error
appear beside the submission in the admin inbox.
