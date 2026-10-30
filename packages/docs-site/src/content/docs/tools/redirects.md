---
title: Redirects Tools
description: Manage URL redirects — essential after migrations and slug changes.
---

These tools wrap `/api/v1/sites/{siteId}/redirects`, with `/{redirectId}` for a single rule.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

Redirects are built into the static site as a Cloudflare Pages `_redirects` file. They're 301 permanent redirects by default.

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
`remaining_static` and `over_limit`. Page redirects and old file addresses share
the same limit. Publication adds media replacement rules on top, so when
`capacity.warning` is present, consolidate rules before publishing; over the
limit, publishing fails with `publication_redirect_limit`.

## `list_redirects`

Returns all configured redirects.

## `delete_redirect`

Deletes a redirect by its id from `list_redirects`.

## After a slug change

If you rename a page's slug, always create a redirect:

```
Rename the "services" page to "what-we-do" and set up a redirect from /services.
```

The AI agent handles both steps automatically when you phrase it this way.

## Redirect limits

Cloudflare Pages supports up to 2,100 redirects per site. For large migrations, the AI agent prioritises the most-trafficked URLs first.
