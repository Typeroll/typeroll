# Quote Generator pilot Extension

This is the first vertical Extension contract fixture. It demonstrates a
provisioned editor block, a vendored hash-pinned frontend bundle, recipient
URL context, memory navigation, direct provider API calls, an external admin launch,
self-host issuer pairing and lifecycle events.

The provider and asset URLs in the manifest are placeholders. Before
publishing, deploy `provider/server.mjs`, serve `frontend/` from immutable
HTTPS URLs, update the URLs, and recompute the SHA-256 hashes:

```sh
shasum -a 256 frontend/index.js frontend/index.css
```

The demo recipient URL is `/quote/?quote=demo-customer-token`. Typeroll reads
and consumes the declared query parameter before mounting the block. Internal
views use `context.navigation`, so approving the quote does not require a new
page path and does not lose the private token held by the component closure.

HTML-mode pages can mount the same installed component with its provisioned
block id:

```html
<x-extension block="extension--INSTALLATION-ID--calculator" props='{"heading":"Your quote"}' />
```

The provider sample expects `TYPEROLL_CLIENT_ID`, `TYPEROLL_CLIENT_SECRET`
and `TYPEROLL_EVENT_SECRET`. The last value must match the installation's
`event_webhook_secret`. Direct API calls are accepted only after explicit
issuer pairing and a valid short-lived Extension token.

The provider sample is deliberately storage-light. Real providers must use a
durable, tenant-scoped database, validate every Extension token and
delegated user JWT, expire customer tokens, rate-limit actions, and send mail
through their own transactional mail system.
