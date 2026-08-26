---
title: Redirects Tools
description: Manage URL redirects — essential after migrations and slug changes.
---

Redirects are built into the static site as a Cloudflare Pages `_redirects` file. They're 301 permanent redirects by default.

## `create_redirect`

Creates a redirect from one path to another.

```
create_redirect from_path="/about" to_path="/om-oss"
create_redirect from_path="/services.html" to_path="/tjanster"
```

Claude uses redirects automatically after:

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

Three things Typeroll will refuse, and why:

- **A `*` anywhere but the end.** Cloudflare ignores it, so the rule would look saved and do nothing.
- **A rule that would hide a live page.** Redirects are applied before files are served, so `/blogg/*` would make every real article under `/blogg/` unreachable. Narrow the prefix instead.
- **Query strings.** Redirects match the path only — an old `/?p=123` URL has nothing to key on.

## `list_redirects`

Returns all configured redirects.

## `delete_redirect`

Deletes a redirect by its from-path.

## After a slug change

If you rename a page's slug, always create a redirect:

```
Rename the "services" page to "what-we-do" and set up a redirect from /services.
```

Claude handles both steps automatically when you phrase it this way.

## Redirect limits

Cloudflare Pages supports up to 2,100 redirects per site. For large migrations, Claude prioritises the most-trafficked URLs first.
