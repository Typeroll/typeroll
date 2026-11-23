---
title: Redirects Tools
description: Manage URL redirects — essential after migrations and slug changes.
---

These tools wrap `/api/v1/sites/{siteId}/redirects`, with `/{redirectId}` for a single rule.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

Customer-account publications use Cloudflare Pages `_redirects` for native path
rules and Cloudflare Bulk Redirects for excess exact paths. Sites stay static.
Query-string sources use the in-page delivery described below. Redirects use
301 by default.

## `create_redirect`

Creates a redirect from one path to another.

```
create_redirect from_path="/about" to_path="/om-oss"
create_redirect from_path="/services.html" to_path="/tjanster"
```

The AI agent uses redirects automatically after:

- WordPress or URL migrations (old paths → new slugs)
- Page slug changes (the old path needs to redirect to the new one)

## Wildcards — retire a whole family of URLs

A migrated site's dead URLs come in shapes, not as individuals. One rule can cover all of them:

```
create_redirect from_path="/category/*" to_path="/blogg/:splat"
```

- A trailing `*` matches everything under the prefix (and the prefix itself); `:splat` inserts what was captured.
- `:name` matches exactly one segment: `from_path="/blog/:slug"` → `to_path="/artiklar/:slug"`.
- Narrower rules always win, so `/blogg/recept/*` can sit alongside `/blogg/*`.

Typical after a WordPress move:

| Old shape              | Rule                            |
| ---------------------- | ------------------------------- |
| `/category/…` archives | `/category/*` → `/blogg/:splat` |
| `/tag/…` archives      | `/tag/*` → `/blogg`             |
| `/author/…` archives   | `/author/*` → `/om-oss`         |
| Date permalinks        | `/2019/*` → `/blogg/:splat`     |

Two things Typeroll will refuse, and why:

- **A `*` anywhere but the end.** Cloudflare ignores it, so the rule would look saved and do nothing.
- **A rule that would hide a live page.** Redirects are applied before files are served, so `/blogg/*` would make every real article under `/blogg/` unreachable. Narrow the prefix instead.
- **A rule whose source and target are the same path** apart from a trailing slash or letter case, such as `/blog` → `/blog/`. Use the site's trailing-slash setting instead.
- **A rule that closes a redirect loop** with existing rules. A longer chain is saved with a `redirect_chain` warning.

### Query-string sources

Old WordPress addresses such as `/?p=123`, `/?page_id=5`, `/?cat=7` or
`/index.php?lang=de` can be redirected with an exact rule:

```json
{ "from_path": "/?p=123", "to_path": "/umzugstipps/umzug-nach-wien/" }
```

The path before `?` must be literal (no `*` or `:name`), every parameter must
be written as `key=value`, and `to_path` must be a fixed path or URL. A request
matches when it has the same path and every listed parameter with that exact
value; other parameters, such as `utm_source`, are ignored. When several rules
match, the one with the most parameters wins.

Cloudflare's `_redirects` file matches paths only, and customer sites stay
static, so these rules are not HTTP redirects. The publication embeds them in
the page that answers the path (the home page for `/?p=123`, otherwise
`404.html`), and a small script sends the visitor on with `location.replace`.
Search engines follow these redirects, but they are not a 301, and visitors
without JavaScript stay on the page. Migration coverage counts the addresses
as redirected. Hosted previews do not run them.

## Changing existing rules

A rule is identified by its `from_path`. `create_redirect` with a `from_path`
that already has a rule updates that rule in place: it keeps its id and the
address keeps redirecting throughout. Never delete and recreate a rule to change
its target, because the address would have no redirect in between.

### `update_redirect`

Changes `to_path` and/or `status_code` of a rule by its id from
`list_redirects`. The id and `from_path` stay the same. To move a rule to
another source path, create the new rule and delete the old one.

```
update_redirect redirect_id="wp-content_uploads_2019_05_a.jpg" to_path="/media/0123456789abcdef-a.jpg"
```

Over REST: `PATCH /api/v1/sites/{siteId}/redirects/{redirectId}` with
`{ "to_path": "…", "status_code": 301 }`. An edited rule counts as authored, so
automatic rule maintenance does not replace it.

### `upsert_redirects`

Creates or updates up to 1,000 rules in one call, keyed by `from_path`, for
example after media addresses change in a migration:

```json
{
  "dry_run": true,
  "redirects": [
    {
      "from_path": "/wp-content/uploads/2019/05/a.jpg",
      "to_path": "/media/0123456789abcdef-a.jpg"
    },
    {
      "from_path": "/wp-content/uploads/2019/05/b.jpg",
      "to_path": "/media/fedcba9876543210-b.jpg",
      "status_code": 301
    }
  ]
}
```

Over REST: `PUT /api/v1/sites/{siteId}/redirects`. Every rule is checked against
the Site's pages and against all rules as they will be after the call, so a loop
formed inside the batch is found. The response lists each rule with its id,
`action` (`create`, `update` or `unchanged`) and `ok`, plus a `summary` and
chain `warnings`. With `dry_run: true` nothing is written. Without it, the call
is all or nothing: if any rule fails, it returns HTTP 422 with the same per-rule
results and writes no rule. A `from_path` may appear only once per call. Run a
dry run first, fix the reported rules, then repeat the call without `dry_run`.

Each response also has `capacity`: the static and dynamic Cloudflare Pages rules
the Site's redirects emit after the call (`static`, `dynamic`, including
generated slash aliases), the limits (`limit_static` 2000, `limit_dynamic` 100),
`remaining_static` and `over_limit`. These counts describe configured rules,
before publication-only media compaction. Page redirects and old file addresses
share the same limit. Publication adds media replacement rules and can omit
individual file rules already covered by an equivalent prefix rule.

### Static overflow (Core 0.3.46 and later)

Customer-account publishing can keep more than 2,000 exact-path rules without
deleting redirects or adding a website function. The frozen publication keeps
up to 2,000 static rules in Pages and delivers excess exact paths through
Cloudflare Bulk Redirects. Slash variants, explicit destinations and HTTP status
codes are retained. `capacity.overflow_static` counts the current excess and
`bulk_required` says when Bulk access is needed. `over_limit` still describes
the Pages file budget, rather than an unconditional publication failure.

The hybrid is the default: native rules travel with each Pages deployment and
reserve the shared Bulk quota for overflow. Moving every Site's ordinary rules
into Bulk would consume that account-wide quota and its staging capacity too.

The website hostname must be proxied through a Cloudflare zone in the hosting
account. Bulk access needs **Account Filter Lists** and **Bulk URL Redirects**
read/edit permissions. An owner or administrator approves the connection update
in Organization → Publishing after the installation offers those permissions.
Self-hosted operators must first allow the scopes on their OAuth client and in
their optional publishing scopes. Existing grants do not expand automatically.

Typeroll shares two managed staging/active lists across the Organization's Sites
in an account, rather than allocating a list per Site. Account-wide URL, list
and rule quotas still apply, including the staged copy. A full quota stops the
publication with an actionable error; it never drops a rule. Customer-owned
lists and rules are not replaced. List contents are checked before the Pages
deployment, then activated after candidate verification. Domain rollback restores
only that publication's mappings and preserves other Sites and later publications.

Bulk rules apply at the proxied website address, not at an immutable
`pages.dev` candidate. Typeroll verifies their status and destination on the
website address before reporting the publication as succeeded. The website
and its media remain static. Query-string sources retain their existing
in-page delivery; arbitrary patterns remain subject to Pages' 100-dynamic-rule
limit. Earlier Core releases still reject excess Pages rules with
`publication_redirect_limit`.

## `list_redirects`

Returns all configured redirects.

## `delete_redirect`

Deletes a redirect by its id from `list_redirects`.

## Image and file addresses

Updating HTML, `srcset`, CSS backgrounds and share-image fields makes the new
site request the new file addresses directly. It does not update image search
results, external embeds or previously shared links. Preserve old public file
addresses independently of the site's current HTML; do not remove their
coverage merely because no current page references them.

Use this order when planning a media migration:

1. Keep a public address serving the same safe file where possible. A media
   item's `public_path` can preserve a legacy path. It preserves the path, not
   the hostname: moving the file to another host still needs compatible routing.
2. Use one prefix rule when the whole namespace has an established mapping and
   the remaining path and filename stay unchanged. For example,
   `/wp-content/uploads/*` can point to
   `https://images.example.com/:splat` when those files really
   exist there. Do not infer a wildcard from a partial list of imported images,
   or capture live pages or exceptions with it.
3. Keep individual mappings where destinations or HTTP statuses differ, such
   as files renamed to unrelated content-hashed names. Excess exact rules can
   use Bulk Redirects; the publisher never drops required mappings to fit a quota.

Private editor addresses and generated variants that have never been public
do not need automatic compatibility redirects. Explicitly configured redirects
remain the owner's routing decisions. Deleting a file and retiring unsafe bytes
are separate operations; this policy never republishes a deleted or unsafe file.

From **Core 0.3.48**, the publisher omits an individual literal file rule from the
frozen output only when an existing prefix or placeholder rule produces exactly
the same destination and HTTP status. It checks the actual slash policy,
generated base aliases and narrower-pattern precedence. Ambiguous and encoded
paths keep their exact rules. Sites with generated facet or archive-pagination
routes keep exact rules until their complete rendered route inventory is known.
The stored rules remain unchanged and the
publisher never invents a broader wildcard for this optimization. Older build
engines receive the already compacted redirect array in the frozen publication.

From **Core 0.3.49**, filenames are readable and immutable: new uploads use the
media root without automatic date folders; explicit and imported folders stay
intact. Managed WordPress imports declare the uploads namespace and strip its
`wp-content/uploads` (or multisite) prefix from new media paths. This permits
one uploads-prefix redirect, with exact exceptions for numbered collisions,
sanitized names and owner overrides. A borrowed WordPress image alone never
authorizes a site-wide prefix. A namespace that could hide a live page, has
unknown generated routes, or exceeds the dynamic budget uses known exact
mappings instead. Stored rules remain unchanged. Cloud needs the corresponding
platform release; self-hosted installations need to update Core.

Safe old hash-based addresses are kept as static copies. Replacing an ordinary
image reserves a new numbered filename and keeps the previous safe file; it
does not automatically add a redirect for every replaced file or generated
variant. The separate unsafe-media replacement rules still apply. A prefix
cannot discover every filename that ever existed: migration verification must
still check the agreed old URL inventory and resolve missing files explicitly.

The existing `/media/*` move to a separate media host already uses one prefix
rule. See [website and media hosts](../../guides/customer-publishing/#website-and-media-hosts).

## After a slug change

If you rename a page's slug, always create a redirect:

```
Rename the "services" page to "what-we-do" and set up a redirect from /services.
```

The AI agent handles both steps automatically when you phrase it this way.

## Redirect limits

Cloudflare Pages allows **2,000 static rules and 100 dynamic rules per Site**.
These are separate budgets, not a pool of 2,100 interchangeable rules.
Generated slash aliases, host rules and file compatibility rules count too.
Typeroll keeps native rules in Pages and places excess exact paths in Bulk
Redirects. It never prioritizes traffic by silently discarding other mappings.

Cloudflare's default Bulk quotas, checked in November 2026, are account-wide:

| Cloudflare plan | URLs across all lists | Lists | Bulk redirect rules |
| --------------- | --------------------- | ----- | ------------------- |
| Free            | 10,000                | 5     | 15                  |
| Pro             | 25,000                | 5     | 15                  |
| Business        | 50,000                | 5     | 15                  |
| Enterprise      | 1,000,000             | 25    | 50                  |

These are provider defaults, not a Typeroll allowance per Site. The account's
highest Cloudflare plan determines its quota; Enterprise limits can be agreed
separately. Check [Cloudflare's current limits](https://developers.cloudflare.com/rules/url-forwarding/#availability)
before planning capacity. All lists count, including inactive staging lists and
customer-owned lists. Typeroll's two managed lists must fit at the same time:
20,000 active mappings can require roughly 40,000 entries during staging, before
other lists are counted. A full quota stops publication with an actionable
error and preserves the configured mappings.

Static redirect overflow requires the Organization’s shared build engine. A Pages Git build without that engine keeps the native redirect limit and reports that build setup is required. Existing organization engines do not need to update automatically: the overflow plan and renderer travel with the frozen publication.
