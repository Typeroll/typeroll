<?php
/**
 * Plugin Name:       Typeroll Helper
 * Plugin URI:        https://typeroll.com
 * Description:       Exposes WordPress content (pages, posts, custom post types, ACF fields, featured media) to the Typeroll migrator via a single authenticated REST endpoint. Read-only — the plugin never writes to your content.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Typeroll
 * Author URI:        https://typeroll.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       typeroll-helper
 */

// Refuse to run outside WordPress.
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'TYPEROLL_HELPER_VERSION', '0.3.1' );
define( 'TYPEROLL_HELPER_PATH', plugin_dir_path( __FILE__ ) );

require_once TYPEROLL_HELPER_PATH . 'includes/class-auth.php';
require_once TYPEROLL_HELPER_PATH . 'includes/class-media.php';
require_once TYPEROLL_HELPER_PATH . 'includes/class-acf.php';
require_once TYPEROLL_HELPER_PATH . 'includes/class-seo.php';
require_once TYPEROLL_HELPER_PATH . 'includes/class-content.php';
require_once TYPEROLL_HELPER_PATH . 'includes/class-redirects.php';
require_once TYPEROLL_HELPER_PATH . 'includes/class-rest-api.php';
require_once TYPEROLL_HELPER_PATH . 'includes/class-settings.php';

// Register REST routes on the standard WP hook.
add_action( 'rest_api_init', array( 'Typeroll_Helper_Rest_API', 'register_routes' ) );

// Settings page in WP admin.
add_action( 'admin_menu', array( 'Typeroll_Helper_Settings', 'register_menu' ) );
add_action( 'admin_init', array( 'Typeroll_Helper_Settings', 'register_settings' ) );

// Activation: ensure an API key exists so the customer can copy it immediately.
register_activation_hook( __FILE__, array( 'Typeroll_Helper_Auth', 'ensure_api_key' ) );
