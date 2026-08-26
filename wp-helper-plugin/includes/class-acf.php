<?php
/**
 * ACF (Advanced Custom Fields) integration.
 *
 * Detects ACF at runtime and exposes per-post field values plus field-group
 * schema. When ACF isn't installed, these methods return empty arrays — the
 * rest of the migrator still works against native post_meta.
 *
 * We resolve ACF values via get_fields(), which:
 *   - Honors field groups / location rules.
 *   - Returns relationship/post-object fields as nested objects.
 *   - Returns image fields as full attachment arrays (when configured to
 *     return "Image Array") or as IDs/URLs depending on field settings.
 *
 * For consistency the migrator-facing format normalizes:
 *   image fields  → attachment description (via Typeroll_Helper_Media::describe)
 *   gallery fields → array of attachment descriptions
 *   relationship   → array of post IDs (the migrator can deref later if needed)
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_ACF {

	public static function is_active() {
		return function_exists( 'acf_get_field_groups' ) && function_exists( 'get_fields' );
	}

	/**
	 * Fetch all ACF values for a post, normalized so the migrator can consume them
	 * without needing to know ACF internals.
	 *
	 * @param int $post_id
	 * @return array
	 */
	public static function fields_for_post( $post_id ) {
		if ( ! self::is_active() ) return array();
		$raw = get_fields( (int) $post_id );
		if ( ! is_array( $raw ) ) return array();
		return self::normalize_value( $raw );
	}

	/**
	 * Return the field-group schema applicable to a post — useful for the
	 * migrator to build a matching Typeroll collection schema.
	 *
	 * @param int $post_id
	 * @return array list of { key, label, name, type, sub_fields[] }
	 */
	public static function field_groups_for_post( $post_id ) {
		if ( ! self::is_active() ) return array();
		$groups = acf_get_field_groups( array( 'post_id' => (int) $post_id ) );
		if ( ! is_array( $groups ) ) return array();

		$out = array();
		foreach ( $groups as $group ) {
			$fields = acf_get_fields( $group );
			$out[] = array(
				'key'         => $group['key'] ?? '',
				'title'       => $group['title'] ?? '',
				'description' => $group['description'] ?? '',
				'fields'      => is_array( $fields ) ? self::normalize_field_defs( $fields ) : array(),
			);
		}
		return $out;
	}

	private static function normalize_field_defs( $fields ) {
		$out = array();
		foreach ( $fields as $f ) {
			$entry = array(
				'key'      => $f['key']   ?? '',
				'name'     => $f['name']  ?? '',
				'label'    => $f['label'] ?? '',
				'type'     => $f['type']  ?? '',
				'required' => ! empty( $f['required'] ),
			);
			if ( ! empty( $f['choices'] ) && is_array( $f['choices'] ) ) {
				$entry['choices'] = array_values( $f['choices'] );
			}
			if ( ! empty( $f['sub_fields'] ) && is_array( $f['sub_fields'] ) ) {
				$entry['sub_fields'] = self::normalize_field_defs( $f['sub_fields'] );
			}
			$out[] = $entry;
		}
		return $out;
	}

	/**
	 * Walk a value from get_fields() and reshape attachment-like arrays into
	 * the standard media description shape. Leaves primitives untouched.
	 *
	 * @param mixed $value
	 * @return mixed
	 */
	private static function normalize_value( $value ) {
		if ( is_array( $value ) ) {
			// Detect "Image Array" / "Attachment" returned by ACF.
			if (
				isset( $value['id'] )
				&& isset( $value['url'] )
				&& isset( $value['mime_type'] )
				&& strpos( $value['mime_type'], 'image/' ) === 0
			) {
				$desc = Typeroll_Helper_Media::describe( (int) $value['id'] );
				return $desc ? $desc : $value;
			}
			// Recurse.
			$out = array();
			foreach ( $value as $k => $v ) {
				$out[ $k ] = self::normalize_value( $v );
			}
			return $out;
		}
		return $value;
	}
}
