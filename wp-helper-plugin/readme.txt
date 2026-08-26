=== Typeroll Helper ===
Contributors: typeroll
Tags: migration, export, rest-api, acf
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Exposes WordPress content to the Typeroll migrator via a single authenticated REST endpoint. Read-only.

== Description ==

Typeroll Helper is a companion plugin for migrating from WordPress to Typeroll. It registers a single authenticated REST namespace (`/wp-json/typeroll/v1/`) that returns:

* Every post type — including custom post types not exposed via the standard `show_in_rest` setting
* ACF field values and field-group schemas (when ACF is installed)
* Native post meta (skipping internal underscore-prefixed keys)
* Featured images with full URLs, alt text, and all WP-generated sizes
* Taxonomies (categories, tags, custom)
* Navigation menus and menu items
* Page-builder data (Elementor / Breakdance raw JSON, for future structured conversion)

The plugin is **read-only**. It never writes to your content or modifies WordPress behavior.

After activation, copy the API key from **Settings → Typeroll** and paste it into your Typeroll site's migration form along with this site's URL.

== Installation ==

1. Upload the plugin zip via **Plugins → Add New → Upload Plugin**, OR copy the `typeroll-helper` folder to `/wp-content/plugins/`.
2. Activate **Typeroll Helper** in the Plugins menu.
3. Go to **Settings → Typeroll** and copy the API key.
4. In your Typeroll migration form, paste the WP site URL and the API key.

== Frequently Asked Questions ==

= Does this plugin modify my site? =

No. The plugin only reads from your database to expose data via REST. It does not register custom post types, modify content, alter your theme, or send any data anywhere on its own.

= Do I need ACF? =

No. ACF is detected at runtime; when it's not installed, the plugin simply skips the ACF sections.

= What happens to the API key on uninstall? =

The key is stored in the `wp_options` table under `typeroll_helper_api_key`. Uninstalling the plugin removes the key. Deactivating without uninstalling leaves it in place.

= Is the key encrypted? =

The key is a 48-character random string generated via `wp_generate_password()`. It's stored in plain text in `wp_options` (same as any WP option) and compared in constant time on each request. Treat it like any other API credential — don't share it; rotate it if exposed.

= Can I limit which post types are exposed? =

Not in v0.1. Future versions will add a per-type checkbox. For now, all non-internal post types are exposed.

== Changelog ==

= 0.1.0 =
* Initial release.
* `/info`, `/post-types`, `/items/{type}`, `/items/{type}/{id}`, `/acf/groups/{id}`, `/menus` endpoints.
* ACF integration with normalized image fields.
* Page-builder raw JSON for Elementor and Breakdance.
* API-key authentication with rotation.

== Upgrade Notice ==

= 0.1.0 =
Initial release.
