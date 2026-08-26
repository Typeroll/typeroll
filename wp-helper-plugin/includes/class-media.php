<?php
/**
 * Media (attachment) helpers — gives the Typeroll migrator everything it
 * needs about an image in one shape, including the full URL, alt text,
 * dimensions, and the various WP-generated sizes if it wants them.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_Media {

	/**
	 * Convert an attachment ID into a serializable array. Returns null if
	 * the attachment doesn't exist or isn't an image/file.
	 *
	 * @param int $attachment_id
	 * @return array|null
	 */
	public static function describe( $attachment_id ) {
		$attachment_id = (int) $attachment_id;
		if ( ! $attachment_id ) return null;
		$post = get_post( $attachment_id );
		if ( ! $post || $post->post_type !== 'attachment' ) return null;

		$src  = wp_get_attachment_url( $attachment_id );
		$meta = wp_get_attachment_metadata( $attachment_id );
		$mime = get_post_mime_type( $attachment_id );

		// Build the list of WP-generated sizes for srcset reconstruction.
		$sizes = array();
		if ( is_array( $meta ) && isset( $meta['sizes'] ) && is_array( $meta['sizes'] ) ) {
			$base_dir = trailingslashit( dirname( $meta['file'] ?? '' ) );
			$upload   = wp_upload_dir();
			$base_url = trailingslashit( $upload['baseurl'] ) . $base_dir;
			foreach ( $meta['sizes'] as $name => $info ) {
				$sizes[ $name ] = array(
					'url'    => $base_url . $info['file'],
					'width'  => isset( $info['width'] )  ? (int) $info['width']  : null,
					'height' => isset( $info['height'] ) ? (int) $info['height'] : null,
				);
			}
		}

		return array(
			'id'         => $attachment_id,
			'url'        => $src,
			'alt'        => get_post_meta( $attachment_id, '_wp_attachment_image_alt', true ),
			'title'      => $post->post_title,
			'caption'    => $post->post_excerpt,
			'mime_type'  => $mime,
			'width'      => isset( $meta['width'] )  ? (int) $meta['width']  : null,
			'height'     => isset( $meta['height'] ) ? (int) $meta['height'] : null,
			'filesize'   => isset( $meta['filesize'] ) ? (int) $meta['filesize'] : null,
			'sizes'      => $sizes,
		);
	}

	/**
	 * Bulk-describe a list of attachment IDs in one call, skipping nulls.
	 *
	 * @param int[] $ids
	 * @return array[]
	 */
	public static function describe_many( $ids ) {
		$out = array();
		foreach ( array_unique( array_filter( array_map( 'intval', (array) $ids ) ) ) as $id ) {
			$d = self::describe( $id );
			if ( $d ) $out[] = $d;
		}
		return $out;
	}
}
