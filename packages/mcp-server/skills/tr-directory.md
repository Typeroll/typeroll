---
name: tr-directory
description: Import a structured directory as Pages of a content type, with custom fields, references, listing routes and reusable templates.
---

# Build a directory from structured data

All entries are Pages. The content type declares their custom field schema,
URL pattern and default Page template. A listing is another Page whose repeater
queries the same records. Do not create a parallel item model.

1. Discover capabilities, existing Pages, content types, templates and blocks.
   Use a site version for a multi-step import and pass it consistently.
2. Call `get_migration_readiness` before importing existing sites or media.
   The customer's own storage must be connected and verified first.
3. Normalize source data without inventing facts. Keep stable source identities
   in a custom field, and record Page IDs returned by creation for subsequent
   updates. Decide the final URL pattern before creating records.
4. Create a Page template with `create_page_template`, choosing a suitable
   starter or a native block tree with `template_content_slot`.
5. Create a content type with `create_content_type`. A restaurant type might
   use `/restaurants/{slug}` and fields `address`, `phone`, `cuisine`, `rating`,
   `image`, `excerpt`. Title, slug, status and block body are already Page fields.
6. Create one Page per entry with `content_type: "restaurants"`. Common metadata
   stays at the top level; custom values belong in `fields`. Use native blocks
   for the body, and the connected media storage for images.
7. Create a listing Page with `core/page_list` and `content_type: "restaurants"`.
   Configure filtering, sorting and pagination through its block schema.
   Reference fields use `page_ref`/`page_ref_list` and optional
   `ref_content_type`. Related and backlink repeaters query those Page IDs.
8. Check at least one full record, a sparse record, image handling, empty states,
   pagination and all migrated URL variants in preview and the static build.
   Save working copies before deploying the authorized version.

## Ownership and public data

Use `writable_by` on custom fields when source imports, agents, listed businesses
or portal editors have different responsibilities. `page_field_rules` covers
supported common metadata such as title. Respect HTTP 409 ownership conflicts;
retrying the same rejected write does not fix them. `rendered: false` excludes a
custom field from public rendering. Never place secrets in public block data.

The directory module is configured with `content_type`, not a separate storage
namespace. Self-service edit grants address the same Page IDs and enforce each
field's owner permissions.

For updates, `list_pages content_type="restaurants"` finds records and
`update_page page_id=... patch={fields:{...}} save=true` changes approved values.
Read each record before replacing data. For reclassification use
`change_page_content_type`; it records a revision and preserves the Page URL.
