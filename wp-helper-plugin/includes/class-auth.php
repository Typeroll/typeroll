<?php
/**
 * API-key authentication for the Typeroll REST namespace.
 *
 * The key is stored in wp_options under `typeroll_helper_api_key`.
 * Clients send it as either the `X-Typeroll-Key` header or a `key`
 * query parameter. Comparison uses hash_equals() to avoid timing leaks.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_Auth {

	const OPTION_NAME = 'typeroll_helper_api_key';
	const KEY_LENGTH  = 48;

	/**
	 * Make sure an API key exists. Called on plugin activation and lazily
	 * if the option is missing for any other reason.
	 */
	public static function ensure_api_key() {
		$existing = get_option( self::OPTION_NAME );
		if ( ! $existing ) {
			update_option( self::OPTION_NAME, self::generate_key() );
		}
	}

	/**
	 * Force-regenerate the key. Old key becomes invalid immediately.
	 */
	public static function rotate_api_key() {
		$new = self::generate_key();
		update_option( self::OPTION_NAME, $new );
		return $new;
	}

	public static function get_api_key() {
		$key = get_option( self::OPTION_NAME );
		if ( ! $key ) {
			self::ensure_api_key();
			$key = get_option( self::OPTION_NAME );
		}
		return $key;
	}

	/**
	 * REST permission_callback. Returns true on valid key, WP_Error otherwise.
	 *
	 * @param WP_REST_Request $request
	 * @return bool|WP_Error
	 */
	public static function check_request( $request ) {
		$presented = $request->get_header( 'x-typeroll-key' );
		if ( ! $presented ) {
			$presented = $request->get_param( 'key' );
		}
		if ( ! $presented ) {
			return new WP_Error(
				'typeroll_no_key',
				'API key required. Pass via X-Typeroll-Key header or ?key= query.',
				array( 'status' => 401 )
			);
		}
		$expected = self::get_api_key();
		// Both strings must be the same length for hash_equals to work safely.
		if ( strlen( $presented ) !== strlen( $expected ) || ! hash_equals( $expected, $presented ) ) {
			return new WP_Error(
				'typeroll_bad_key',
				'Invalid API key.',
				array( 'status' => 403 )
			);
		}
		return true;
	}

	private static function generate_key() {
		// wp_generate_password is cryptographically secure since WP 3.1.
		return wp_generate_password( self::KEY_LENGTH, false, false );
	}
}
