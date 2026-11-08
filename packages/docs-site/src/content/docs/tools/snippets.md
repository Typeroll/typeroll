---
title: Live Snippet Tools
description: Keep small pieces of content outside the build, such as today's lunch or a notice, and change them on the live site without publishing.
---

These tools wrap `/api/v1/sites/{siteId}/snippets`.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

A live snippet is content outside the publication. Pages are a static build,
so every other change waits for the next publication. A snippet is saved,
sanitized and written at once as a small public file, and the live site shows
the new content within about a minute, without publishing or rebuilding.
Use it for content that changes often: today's lunch, a notice, a waiting
time.

Snippets belong to the site, not to a version, so a branch shows the same
snippets as main. A site has at most 100 snippets of at most 64 KB each.
Editors who may edit content may change them, in the portal under
**Snippets**, through these tools or through an app with the
`snippets:write` scope.

## The model

```json
{
  "id": "lunch",
  "name": "Today's lunch",
  "kind": "dated",
  "format": "html",
  "entries": [
    { "weekday": "monday", "content": "<p>Pea soup and pancakes</p>" },
    { "weekday": "tuesday", "content": "<p>Fish of the day</p>" },
    { "date": "2026-12-24", "content": "<p>Closed for Christmas Eve</p>" }
  ],
  "fallback": "<p>No lunch is served today.</p>",
  "updated_by": "editor@example.com",
  "updated_at": "2026-11-07T10:00:00.000Z"
}
```

| `kind`  | Content                                                                  |
| ------- | ------------------------------------------------------------------------ |
| `html`  | `content` is HTML, sanitized like page content when saved                |
| `text`  | `content` is plain text, escaped where it is shown                       |
| `dated` | `entries` by `weekday` or `date`, in `format` `html` (default) or `text` |

A dated snippet shows today's entry, chosen in the visitor's browser in the
site's time zone (the `time_zone` site setting). A `date` entry wins over a
`weekday` entry, and `fallback` shows on a day without one. Write a week's
lunches once a week rather than every day; the file does not change between
writes.

`updated_by` and `updated_at` are set by the server on every save.

## Showing a snippet

Place a `core/snippet` block with `snippet` set to the snippet's id where the
content should appear. The page carries the value of the latest publication,
so the content is there without script, for search engines and in print. The
browser then reads the newest file and shows it. Placing or moving the block
is a page edit that needs a publication; changing the snippet afterwards does
not.

A site field with `live: true` works the same way for one value: the
`core/site_field` block shows its newest value without a publication. See
[live fields](../site-fields/#live-fields).

## Where live files are served

Live files are served from the organization's public media bucket, next to
the site's published images, at `<media host>/live/<id>.json` (with the
organization's shared media host, under the site's media namespace). They are
cached for about a minute. The bucket gets a CORS rule that lets the site's
own addresses read them: its domains, its publication addresses and the deploy
addresses of its versions. No other origin is allowed.

Previews do not read live files. A preview link (`get_preview_link`), the
editor preview and `get_page_preview` render every snippet and live site field as it is saved at the
moment the preview is opened, so they show the newest content without a
request to the media host. Reload the preview to see a later save. (Previews
run in an isolated, opaque origin, which the CORS rule does not and should not
allow.) To check the live file itself, open the published page.

A site needs a media host for this: the site's own media host or the
organization's, set in **Publishing**. A site without one, or a hosted site,
keeps its media with the website, and its snippets change at the next
publication. Every save still succeeds and says so in `live`:

```json
{ "published": true, "url": "https://media.example.com/live/lunch.json" }
```

```json
{
  "published": false,
  "reason": "The site has no media host, so live content changes at the next publication. …"
}
```

The launch check warns when a site has snippets but no media host.

## Tools

### `list_snippets`

Every snippet of the site, and `live`: `{ base_url }` where their files are
served, or `{ base_url: null, reason }`.

### `read_snippet`

One snippet by `snippet_id`, with `live_url`, the file the live site reads.
Pass its `updated_at` to `update_snippet`.

### `update_snippet`

Creates or replaces a whole snippet. Send every field you keep. Pass
`expected_updated_at` (the `updated_at` you read, or `""` for a new one) and a
save made in between is refused with `409`. Invalid input returns `errors`
with the path of each problem, such as `entries[2].weekday`.

```
update_snippet snippet_id="lunch" name="Today's lunch" kind="dated"
  entries=[{weekday:"monday", content:"<p>Pea soup</p>"}, …]
  fallback="<p>No lunch today</p>" expected_updated_at="2026-11-07T10:00:00.000Z"
```

### `delete_snippet`

Deletes a snippet and its live file. Remove the `core/snippet` block that
shows it too; until the page is published again it keeps the published value.

## Over REST

| Method   | Path                    | Body or query                                                 |
| -------- | ----------------------- | ------------------------------------------------------------- |
| `GET`    | `/snippets`             |                                                               |
| `POST`   | `/snippets`             | `{ id?, name, kind, format?, content?, entries?, fallback? }` |
| `GET`    | `/snippets/{snippetId}` |                                                               |
| `PUT`    | `/snippets/{snippetId}` | the whole snippet and `expected_updated_at`                   |
| `DELETE` | `/snippets/{snippetId}` | `?expected_updated_at=…`                                      |

```bash
curl -X PUT https://app.typeroll.com/api/v1/sites/$SITE/snippets/notice \
  -H "Authorization: Bearer $TYPEROLL_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Notice","kind":"text","content":"Closed today for staff training"}'
```
