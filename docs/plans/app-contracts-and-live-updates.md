# App contracts and live updates

Status: proposal for decision (2026-11-11). Nothing here is built yet.

## Why

On 2026-11-11 a Recurring Events version change broke the event box on
autopilot.se until the site was republished, and every app change since has
needed a site publication: changing what the box shows (0.1.6) meant a new app
release, switching the installation's version by hand, a dry run and a
publication. That cost grows with every site and every app release, although
the content these apps show is fetched live anyway.

The cause is what a publication freezes, not what the apps need:

- the component's JavaScript is copied into the publication;
- the published page calls a versioned app address (one Worker per release,
  for example `…-v0-1-5`), and form targets post to it;
- the installation's version and its `api_base` are set per site.

Core 0.3.25 made a version switch safe (the old release keeps serving the live
publication until the next one, `published_version`), but it still takes a
publication to get the new release live.

Parts of the target model already exist in Core: an installation is "a timeless
trust relationship, not a permanent pin" and runtime selects the newest
compatible release, and `granted_scopes` never expand with a release
(see [extensions](../extensions.md#installation-and-release-policy)).

## Decision

### 1. Contract versions

Each app declares a contract version, an integer that changes extremely rarely.
The contract is everything a published site or Core depends on:

- component ids and the mount markup (section 3);
- form endpoints, their parameters and response envelopes;
- the shape of data built into a publication (section 5);
- configuration keys the app cannot work without;
- permissions the app cannot work without (section 6);
- what the app's stored data must keep readable (section 7).

The registry refuses a release that breaks its contract, the way the Core and
Cloud contract check refuses an incompatible pin today. A breaking change is a
new contract, which existing sites adopt explicitly.

### 2. Always the latest release within a contract

There is no per-site version setting. An installation binds to an app and a
contract; visitors always get the newest release of that contract. One stable
address serves each contract instead of one Worker per release, so a retired
release cannot be reached at all (this also removes the class of fault behind
the 2026-09-22 incident).

A release reaches sites the way Core does: staging qualification, then a
gradual rollout (0 → 10 → 100 %) with automatic rollback, and a global rollback
that takes effect at once. No site is published for it.

### 3. Minimal markup

A published page holds only the mount point, which never needs to change within
a contract:

```html
<div
  data-tr-app="com.typeroll.recurring-events"
  data-tr-installation="inst_…"
  data-tr-component="next-occurrence"
  data-tr-variant="lunch-page"
  data-tr-reserve="160"
>
  <noscript><a href="#anmalan">Anmäl dig</a></noscript>
</div>
```

A stable loader for the contract fetches the current component and renders
everything else: content, layout and the component's CSS. Two optional
attributes are part of the contract:

- `data-tr-reserve`: an approximate height in px, so the page does not jump
  while the component loads (layout shift counts in Core Web Vitals);
- a no-JavaScript fallback inside the mount, typically a link to the form.

No settings are serialized into the markup.

### 4. Named variants

Settings live in the app's admin screen, grouped in named variants (for example
`standard`, `lunch-page`). The markup names a variant; without the attribute the
component uses `standard`. Several pages can share a variant, and copying a page
copies a reference, not settings, so nothing is shared by accident.

A variant change is live at once on every page that uses it, so the admin
screen previews a variant before it is saved. The page editor shows which
variant a mount uses and links to it.

### 5. Two kinds of app content

- **Dynamic:** forms, bookings, unsubscribe, the next date, availability. It is
  fetched when the page loads, never built and never triggers a publication.
  Search engines see the page's own text, so the page itself should state what
  matters for search (what the event is, where and how often); the app adds what
  changes.
- **Built in:** content that is the page, such as directory listings. It is
  built into the publication through build derivations, as today, and is the
  only kind of app content that can call for a publication. When and how such
  publications are batched is decided separately.

### 6. Optional permissions

A new permission in a release is optional. The features that need it stay off
until a site administrator grants it, and the app works as before without it.
Only a permission the app cannot work without is a contract change.

### 7. Stored data

All releases of a contract share the app's data, as the per-app databases
already do. Changes within a contract are additive (expand, then contract in a
later release); nothing a running release reads is removed or renamed.

## What changes

| Today                                                 | With contracts                                     |
| ----------------------------------------------------- | -------------------------------------------------- |
| Version set per installation, `api_base` per version  | Installation binds to app + contract               |
| One Worker per release                                | One stable address per contract                    |
| Component JS frozen into the publication              | Loader fetches the current component               |
| Props in markup                                       | Named variant in markup, settings in the app admin |
| App release → switch + dry run + publication per site | App release → staged rollout, no publication       |
| New scopes need a new grant before use                | Same, but the release must work without them       |

## Risks

- **Every site gets a bad release at once.** Staging qualification, gradual
  rollout with automatic rollback, and an immediate global rollback; the
  rollout should watch error rates on the component and its API.
- **The live site changes without a publication.** For dynamic content this was
  already true of the data; it now also holds for the component code. The
  publication still verifies everything it builds.
- **Caching.** The loader must not pin a stale component for long: a short
  cache for the loader and content-hashed component files.
- **Search.** Unchanged for dynamic content compared with today; built-in
  content keeps being in the HTML.
- **Third-party apps.** The extension model is public Core, so the contract
  applies to every app developer, not only Typeroll's private apps.

## Migration

1. Core: a `contract` field in the manifest, the per-contract loader, the
   minimal mount with `data-tr-variant`, and registry compatibility checks. The
   current frozen mode keeps working for existing publications until a site is
   republished.
2. Cloud: route each contract to its latest release; retire per-release Worker
   configurations and the per-site `api_base`.
3. Recurring Events first: move `series_id` and `link_label` into variants, with
   `standard` as the default.
4. autopilot.se: one publication to switch to the new markup; after that, app
   releases reach it without publications.

## Open questions

- Where the loader is served from (the site's own domain or the app's) and the
  content security policy that follows.
- The publication policy for built-in content (batching, triggers).
- Whether some sites will need to hold a release (not planned now).
- How the page editor previews a variant.
