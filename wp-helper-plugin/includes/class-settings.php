<?php
/**
 * Settings page under Settings → Typeroll.
 *
 * Shows the current API key, lets the admin rotate it, and prints the URL
 * the customer pastes into the Typeroll migration form.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_Settings {

	const PAGE_SLUG = 'typeroll-helper';

	public static function register_menu() {
		add_options_page(
			'Typeroll Migration',
			'Typeroll',
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render' )
		);
	}

	public static function register_settings() {
		// Form submissions for rotate / nothing else stored here.
		if (
			isset( $_POST['typeroll_rotate_key'] )
			&& current_user_can( 'manage_options' )
			&& check_admin_referer( 'typeroll_rotate_key' )
		) {
			Typeroll_Helper_Auth::rotate_api_key();
			add_settings_error(
				'typeroll_helper',
				'key_rotated',
				'API key rotated. Update your Typeroll migration with the new key.',
				'updated'
			);
		}
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) return;
		$api_key  = Typeroll_Helper_Auth::get_api_key();
		$rest_url = esc_url( rest_url( 'typeroll/v1/info' ) );
		?>
		<div class="wrap">
			<h1>Typeroll Migration Helper</h1>
			<?php settings_errors( 'typeroll_helper' ); ?>
			<p>
				This plugin exposes your WordPress content to the Typeroll migrator
				via a single authenticated REST endpoint. Read-only — it never modifies
				your content.
			</p>

			<h2>API key</h2>
			<p>Paste this into your Typeroll site's migration form, along with the URL of this site.</p>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="tr-api-key">API key</label></th>
					<td>
						<input
							id="tr-api-key"
							type="text"
							readonly
							value="<?php echo esc_attr( $api_key ); ?>"
							onclick="this.select()"
							style="width: 28em; font-family: ui-monospace, Menlo, monospace;"
						/>
					</td>
				</tr>
				<tr>
					<th scope="row">REST namespace</th>
					<td>
						<code><?php echo esc_html( rest_url( 'typeroll/v1/' ) ); ?></code>
					</td>
				</tr>
				<tr>
					<th scope="row">Health check</th>
					<td>
						<a href="<?php echo esc_url( add_query_arg( 'key', $api_key, $rest_url ) ); ?>" target="_blank" rel="noopener">
							<?php echo esc_html( $rest_url ); ?>
						</a>
						<p class="description">Should return your site name, WP version, and whether ACF is detected.</p>
					</td>
				</tr>
			</table>

			<h2>Rotate key</h2>
			<p>Replaces the current API key. The old one stops working immediately. Update your Typeroll migration with the new key after rotating.</p>
			<form method="post">
				<?php wp_nonce_field( 'typeroll_rotate_key' ); ?>
				<input type="hidden" name="typeroll_rotate_key" value="1" />
				<?php submit_button( 'Rotate API key', 'secondary', 'submit', false ); ?>
			</form>

			<h2>What the migrator reads</h2>
			<ul>
				<li>All published pages and posts.</li>
				<li>All custom post types — including those <em>not</em> exposed via the standard <code>show_in_rest</code>.</li>
				<li>ACF field values and field-group schemas (when ACF is installed).</li>
				<li>Native post meta (excluding underscore-prefixed internal keys).</li>
				<li>Featured images, full URLs, alt text, and all generated sizes.</li>
				<li>Taxonomies (categories, tags, custom).</li>
				<li>Navigation menus and menu items.</li>
				<li>Page-builder data (Elementor / Breakdance) exposed as raw JSON for future conversion.</li>
			</ul>

			<p><strong>Read-only.</strong> This plugin does not write to your content or modify WordPress behavior in any way.</p>
		</div>
		<?php
	}
}
