# App contracts and live updates

Status: decided (2026-11-11); being built. Sections 1–7 are the model, "Interface" is the contract between Core and the apps.

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
a contract (the default markup inside it comes from the app, section 4b):

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

- `data-tr-reserve`: an approximate height in px, for components whose default
  markup does not already hold their space;
- the default markup itself, which also serves visitors without JavaScript.

No settings are serialized into the markup.

### 4. Variants defined by the app

The markup names a variant; settings never live in the markup. Core provides
the mechanism (the attribute, the editor picker, passing the variant to the
component), and each app decides which variants exist. They can be dynamic:
Recurring Events offers one variant per event series. Without the attribute the
component uses `standard`. Copying a page copies a reference, not settings.

A variant change is live at once on every page that uses it, so an app that
lets people edit variants previews a change before it is saved.

### 4b. Default markup from the app at build time

At every build Core asks the app for the default markup of each mount
(component plus variant) and writes it inside the mount. The app decides what it
is: a loading indicator, an empty form control, or content worth indexing, and
may change it in any release; it reaches a site at that site's next ordinary
build and never triggers one. When the component loads it may replace the
default markup entirely. Core does not restrict the markup of official apps:
they already run their own code on the page. If the app does not answer, the
build reuses the previous publication's markup for that mount, else leaves the
mount empty; a publication never fails on it.

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

## Scope of the first delivery

All official apps convert at once: Recurring Events, Directory, Attribution,
Advanced Design and Agency (which has no components). Only official apps can
declare a contract; Core keeps a list of trusted developer organizations. Apps
without a contract, including third-party ones, keep today's behaviour.

## Interface

**Manifest** (official apps only):

- `contract`: integer ≥ 1.
- `api.base_url`: the contract's stable address, for example
  `https://typeroll-recurring-events-production-c1.<sub>.workers.dev/v1`.
- Component `render_mode: "contract_component"` with
  `entry.module_url`: a stable ES module URL on the contract address that always
  exports the current release's `mount`. No hash: the app serves immutable,
  content-hashed files behind it.
- Component `variants`: optional `{ "path": "/variants" }` under
  `api.base_url`. Without it the component has the single variant `standard`.
- Component `default_markup`: optional `{ "path": "/default-markup" }` under
  `api.base_url`.
- Permissions may set `"optional": true`; optional scopes are granted only when
  a site administrator turns them on, and the app must work without them.

**Calls from Core to the app** (server side, signed installation assertions as
for form providers, with these purposes):

- `component_variants`: `POST {base}{variants.path}` with
  `{ component_id }` → `{ variants: [{ id, label }] }`. Used by the editor
  picker and MCP.
- `default_markup`: `POST {base}{default_markup.path}` with
  `{ mounts: [{ key, component_id, variant, language }] }` →
  `{ markup: { [key]: html } }`. Called once per build with every mount of
  the site.

**Mount markup** written by Core:
`data-tr-extension`, `data-tr-extension-installation`,
`data-tr-extension-component`, `data-tr-extension-variant`, optional
`style="min-height:…px"`, default markup inside; no `data-block-data`.

**Runtime**: `mount(element, { variant }, context)` imported from
`module_url`; `element` holds the default markup; `context.variant` equals the
variant. Everything else in `context` is unchanged.

**Installation and resolution**: an installation stores `contract`. Runtime
picks the newest published release with that contract; moving to a new contract
is the only explicit activation. `GET /extensions/self` returns `contract`.

**Forms and derivations** use `api.base_url` of the contract. The resolved
release stays in derivation digests so a new release still invalidates caches.

## Migration

1. Core: everything under Interface, behind the trusted-developer gate; the
   current behaviour stays for apps without a contract.
2. Cloud: one Worker per app contract (`typeroll-<app>-<env>-c1`) deployed by
   version upload and a staged 0 → 10 → 100 % rollout with automatic
   rollback; release assets in a shared store so both versions serve during a
   rollout; the per-release Workers replaced by stateless forwarders to the
   contract Worker (sent emails and stale pages keep working) and later removed.
3. Apps: Recurring Events (variant = series; the link text moves to the series),
   Directory and Attribution (`standard`), Advanced Design (see open
   questions), Agency (admin only).
4. Sites: existing block instances move from props to variants, and each site is
   published once to the new markup.

## Open questions

- The publication policy for built-in content (batching, triggers).
- Whether some sites will need to hold a release (not planned now).
- How the page editor previews a variant.
- Advanced Design: whether variants become saved compositions in the app.
- Whether non-Typeroll apps such as Market Engine convert later.
