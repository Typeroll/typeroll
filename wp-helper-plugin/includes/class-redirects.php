<?php
/**
 * Pull existing redirects out of whatever redirect plugin the customer is
 * already running. The migrator merges these into the new site's redirects
 * collection so DNS-switch day doesn't break old bookmarks/SEO links.
 *
 * Sources we recognize (best-effort — silent if the plugin isn't present):
 *
 *   - 301 Redirects (storage: option `301_redirects` => assoc array)
 *   - Redirection (storage: custom tables `{prefix}redirection_items`)
 *   - Safe Redirect Manager (storage: post type `redirect_rule`)
 *   - SEOPress Pro (storage: option `seopress_pro_redirections_settings`)
 *   - Yoast Premium (storage: option `wpseo-premium-redirects`)
 *
 * Each is normalized to { from, to, status_code, source } before returning.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_Redirects {

	/**
	 * Collect redirects from every supported source. Returns:
	 *   [ 'redirects' => [...], 'sources' => ['source-id' => count, ...] ]
	 */
	public static function collect() {
		$all     = array();
		$sources = array();

		foreach ( array(
			'301-redirects'       => array( __CLASS__, 'from_301_redirects' ),
			'redirection'         => array( __CLASS__, 'from_redirection' ),
			'safe-redirect-mgr'   => array( __CLASS__, 'from_safe_redirect_manager' ),
			'seopress'            => array( __CLASS__, 'from_seopress' ),
			'yoast-premium'       => array( __CLASS__, 'from_yoast_premium' ),
		) as $key => $cb ) {
			$found = call_user_func( $cb );
			if ( is_array( $found ) && ! empty( $found ) ) {
				foreach ( $found as $row ) {
					$row['source'] = $key;
					$all[] = $row;
				}
				$sources[ $key ] = count( $found );
			}
		}

		return array(
			'redirects' => $all,
			'sources'   => $sources,
			'total'     => count( $all ),
		);
	}

	/** "301 Redirects" plugin — option holds { "/old/" => "/new/" }. */
	private static function from_301_redirects() {
		$opt = get_option( '301_redirects', array() );
		if ( ! is_array( $opt ) ) return array();
		$out = array();
		foreach ( $opt as $from => $to ) {
			if ( ! is_string( $from ) || ! is_string( $to ) ) continue;
			$out[] = array(
				'from'        => $from,
				'to'          => $to,
				'status_code' => 301,
			);
		}
		return $out;
	}

	/** "Redirection" plugin (johngodley) — custom tables. */
	private static function from_redirection() {
		global $wpdb;
		$table = $wpdb->prefix . 'redirection_items';
		// Quick existence probe — avoid noisy SQL warnings if not installed.
		$exists = $wpdb->get_var( $wpdb->prepare( "SHOW TABLES LIKE %s", $table ) );
		if ( $exists !== $table ) return array();

		$rows = $wpdb->get_results( "SELECT url, action_data, action_code, status FROM {$table} WHERE status = 'enabled' LIMIT 5000" );
		if ( ! is_array( $rows ) ) return array();

		$out = array();
		foreach ( $rows as $r ) {
			$out[] = array(
				'from'        => (string) $r->url,
				'to'          => (string) $r->action_data,
				'status_code' => (int) ( $r->action_code ?: 301 ),
			);
		}
		return $out;
	}

	/** "Safe Redirect Manager" — stores rules as the post type redirect_rule. */
	private static function from_safe_redirect_manager() {
		if ( ! post_type_exists( 'redirect_rule' ) ) return array();
		$posts = get_posts( array(
			'post_type'      => 'redirect_rule',
			'post_status'    => 'publish',
			'posts_per_page' => 5000,
			'no_found_rows'  => true,
		) );
		$out = array();
		foreach ( $posts as $p ) {
			$from = get_post_meta( $p->ID, '_redirect_rule_from', true );
			$to   = get_post_meta( $p->ID, '_redirect_rule_to',   true );
			$code = get_post_meta( $p->ID, '_redirect_rule_status_code', true );
			if ( ! $from || ! $to ) continue;
			$out[] = array(
				'from'        => (string) $from,
				'to'          => (string) $to,
				'status_code' => (int) ( $code ?: 301 ),
			);
		}
		return $out;
	}

	/** SEOPress Pro — option `seopress_pro_redirections_settings`. */
	private static function from_seopress() {
		$opt = get_option( 'seopress_pro_redirections_settings', array() );
		if ( ! is_array( $opt ) ) return array();
		$out = array();
		foreach ( $opt as $row ) {
			if ( ! is_array( $row ) ) continue;
			$from = isset( $row['source'] ) ? $row['source'] : '';
			$to   = isset( $row['target'] ) ? $row['target'] : '';
			$code = isset( $row['type'] )   ? (int) $row['type'] : 301;
			if ( ! $from || ! $to ) continue;
			$out[] = array(
				'from'        => (string) $from,
				'to'          => (string) $to,
				'status_code' => $code,
			);
		}
		return $out;
	}

	/** Yoast SEO Premium — option `wpseo-premium-redirects` (assoc by source). */
	private static function from_yoast_premium() {
		$opt = get_option( 'wpseo-premium-redirects', array() );
		if ( ! is_array( $opt ) ) return array();
		$out = array();
		foreach ( $opt as $source => $row ) {
			if ( ! is_array( $row ) ) continue;
			$to   = isset( $row['url'] )  ? $row['url']  : '';
			$code = isset( $row['type'] ) ? (int) $row['type'] : 301;
			if ( ! $source || ! $to ) continue;
			$out[] = array(
				'from'        => (string) $source,
				'to'          => (string) $to,
				'status_code' => $code,
			);
		}
		return $out;
	}
}
