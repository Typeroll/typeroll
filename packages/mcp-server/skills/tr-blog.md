---
name: tr-blog
description: Set up a blog, news section or dated article series using Pages, a content type, shared templates and a dynamic listing.
---

# Build a blog with Pages

Every article is a Page. A Content type supplies its extra fields, URL pattern
and default template. Do not create a separate item store or generate listing
HTML by hand.

1. Read `get_site_capabilities`, `list_block_types`, `list_content_types` and
   `list_page_templates`. For a substantial change, create a site version and
   pass its ID as `version` on every supported operation.
2. Create an editable shared template:

```json
{ "name": "article-layout", "label": "Article", "starter": "article", "status": "published" }
```

Send it to `create_page_template`. Use block tools with
`target: { kind: "template", id: "article-layout" }` to refine the layout.

3. Call `create_content_type`:

```json
{
  "name": "articles", "label_singular": "Article", "label_plural": "Articles",
  "route_template": "/articles/{slug}", "template": "article-layout",
  "sort_field": "date_published", "sort_dir": "desc",
  "fields": [
    { "name": "excerpt", "label": "Summary", "type": "textarea" },
    { "name": "featured_image", "label": "Cover image", "type": "image" }
  ]
}
```

Title, slug, author, date, SEO, status and body are built-in Page values. Keep
only custom values in `fields`.

4. Call `create_page` for each article with its `title`, `slug`,
   `content_type: "articles"`, `status`, `date_published`, `fields` and `blocks`.
   Use native heading, prose, image, list and table blocks. Store its returned
   Page ID; use it for every later operation.
5. Create the archive as another Page with `core/page_list`, using
   `data: { content_type: "articles", sort_by: "date_published", sort_order: "desc", paginate: 10 }`.
   A homepage teaser can use `limit: 6` instead. Both resolve saved Pages at
   render time; adding an article needs no listing regeneration.
6. Link to the archive from navigation. Preview representative articles and
   the archive on desktop and mobile with `get_preview_link page_id=...`.
7. Save any working copies before publication. `update_page` and block edits
   need `save: true` or `commit_working_copy`; new Pages and template definitions
   are saved immediately. Deploy only within the user's authorized scope and
   verify the returned job and public URL.

Use the organization's connected media storage before importing remote images.
Do not hardcode a Typeroll media hostname. Use the returned media URL.

A published Page with complete route tokens becomes one static detail page.
Draft/review Pages stay private. Unlisted Pages have a public URL but are omitted
from listings and search indexes. The selected version's robots policy applies.
