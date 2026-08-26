# Typeroll Helper (WordPress plugin)

Companion plugin to the [Typeroll](https://typeroll.com) migrator. Exposes the customer's WordPress content via a single authenticated REST namespace — including custom post types, ACF fields, and featured media — so the migrator works regardless of how the source site's REST API is configured.

**Read-only.** The plugin never writes to your content.

## Why this exists

The standard WP REST API at `/wp-json/wp/v2/` only exposes:

- Post types where `show_in_rest: true` (often not the case for plugins' custom types)
- Native post meta where `register_post_meta(..., 'show_in_rest' => true)` was set (rare)
- ACF fields only if the customer enabled the per-group REST checkbox (ACF 5.11+) or installed "ACF to REST API"

Most production WP sites don't have all of that set up. This plugin sidesteps the issue by walking the database directly and serving the data through its own REST namespace.

## Endpoints

All authenticated via `X-Typeroll-Key` header or `?key=` query parameter.

| Endpoint | Purpose |
|---|---|
| `GET /wp-json/typeroll/v1/info` | Site name, WP version, ACF presence — useful for the migrator's connection check. |
| `GET /wp-json/typeroll/v1/post-types` | Every registered post type with item counts. |
| `GET /wp-json/typeroll/v1/items/{type}?page=&per_page=` | Items of a post type. Includes rendered content, featured image, ACF values, post meta, taxonomies, builder data. Returns `X-WP-Total` and `X-WP-TotalPages` headers. |
| `GET /wp-json/typeroll/v1/items/{type}/{id}` | One item with the same shape. |
| `GET /wp-json/typeroll/v1/acf/groups/{post_id}` | ACF field-group schema applicable to a post — for inferring the matching Typeroll collection schema. |
| `GET /wp-json/typeroll/v1/menus` | Navigation menus and their items, hierarchical. |

## Installation

1. Build the plugin zip (see below) or download a release.
2. In WordPress admin: **Plugins → Add New → Upload Plugin → choose zip → Install Now → Activate**.
3. Go to **Settings → Typeroll** and copy the API key.
4. In Typeroll, when starting a migration, paste the WP URL and the API key.

### Building the zip locally

The plugin is just PHP — no build step. To package it as a WP-installable zip:

```bash
cd wp-helper-plugin
zip -r ../typeroll-helper-0.1.0.zip . -x "*.git*" -x "*.DS_Store"
```

## Repo layout

```
wp-helper-plugin/
├── typeroll-helper.php   Main plugin file (header + bootstrap)
├── includes/
│   ├── class-auth.php       API key generation / verification
│   ├── class-content.php    Post-type enumeration + per-item description
│   ├── class-acf.php        ACF detection + value normalization
│   ├── class-media.php      Attachment → portable description
│   ├── class-rest-api.php   Route registration
│   └── class-settings.php   Admin page (Settings → Typeroll)
├── readme.txt               WordPress.org-style readme
├── README.md                This file
└── LICENSE                  GPL v2 (WP plugins must be GPL-compatible)
```

## Development

This plugin sits in the Typeroll monorepo (a sibling of `packages/`, NOT inside it — `packages/` is reserved for npm workspaces). The PHP/TS language mix is fine because npm doesn't try to install non-`packages/` directories.

The plugin and the Typeroll migration workflow are open-source core
functionality. Typeroll Cloud can operate and support the same migration as a
managed service, but no separate Cloud-only plugin is required.

## Compatibility

- WordPress 6.0+
- PHP 7.4+
- ACF (Free or Pro): optional, detected at runtime
- Elementor / Breakdance: builder data is exposed as raw JSON; the TS-side converter is future work

## Security

- API key is a 48-character random string generated via `wp_generate_password()`.
- Comparison uses `hash_equals()` (constant-time).
- The settings page rotation form is protected by a WordPress nonce.
- All endpoints require a valid key — there's no anonymous access.
- The plugin makes no outbound network calls. Data only leaves your site when the migrator pulls it.

## License

GPL-2.0-or-later. Same license as WordPress itself, as required by the WP.org plugin directory.
