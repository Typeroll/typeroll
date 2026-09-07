# Public deployment availability

Cloudflare upload completion is followed by `running / distributing`. A
successful upload alone does not advance the version's live content cutoff or
reveal live links. The editor, overview and page list display **Distributing…**
and resume verification after navigation or reload.

The Cloudflare adapter stamps a random public `X-Typeroll-Publication` response
header in the static `_headers` file. The status endpoints check generated HTML
routes on the public domain (or configured fallback) and the deployment URL.
An old HTTP 200 response cannot pass: the status and publication header must
both match. Empty publications use a small static marker file so deleting the
last page remains supported. This adds no Worker or Pages Function.

Each status request checks at most eight routes concurrently. Successful batches
are saved on the deploy job. The last batch advances the live version only if
that publication still owns the version. The saved content cutoff remains the
snapshot start time, so edits made during the build do not acquire live links.
A main-version staging upload never advances production state.

The build worker returns after upload; it does not wait for edge propagation.
The browser polls every three seconds and refreshes automatically after
confirmation, deferring refresh while the editor has unsaved changes. With no
browser or API poller open, verification resumes on the next status request.
If a check still fails more than five minutes after upload, the job becomes
`failed / availability_timeout`, keeps the link hidden and offers a retry.
Superseded uploads cannot promote the current version.

Checks use public HTTPS destinations and same-origin redirects. DNS failures,
TLS failures, unavailable pages and stale headers keep the publication pending.
This confirms availability from the portal's network location, not every CDN
edge or end-user network worldwide. Proxies that strip the publication header
and domains redirecting to another origin need configuration correction before
the check can pass.

The marker applies to the current Cloudflare adapter. Dry runs and other
adapters retain their existing completion behavior. The customer Git build
pipeline must adopt the same readiness contract when integrated; this change
does not itself move publishing to customer accounts.
