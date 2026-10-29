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

## `list_redirects`

Returns all configured redirects.

## `delete_redirect`

Deletes a redirect by its from-path.

## After a slug change

If you rename a page's slug, always create a redirect:

```
Rename the "services" page to "what-we-do" and set up a redirect from /services.
```

The AI agent handles both steps automatically when you phrase it this way.

## Redirect limits

Cloudflare Pages supports up to 2,100 redirects per site. For large migrations, the AI agent prioritises the most-trafficked URLs first.
