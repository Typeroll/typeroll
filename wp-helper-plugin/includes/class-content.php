<?php
/**
 * Content extraction — post types and individual items.
 *
 * Unlike the standard WP REST API, these methods don't care whether a post
 * type was registered with show_in_rest. They walk the WP object directly,
 * so the migrator gets a consistent view regardless of how the customer's
 * site is configured.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_Content {

	// Post types we never expose. These are internal WP scaffolding.
	const HIDDEN_TYPES = array(
		'attachment',
		'revision',
		'nav_menu_item',
		'wp_block',
		'wp_template',
		'wp_template_part',
		'wp_navigation',
		'wp_global_styles',
		'oembed_cache',
		'user_request',
		'customize_changeset',
	);

	/**
	 * List every registered post type that has at least one published item.
	 * Includes both built-in (post, page) and custom types.
	 *
	 * @return array
	 */
	public static function list_post_types() {
		$out = array();
		$all = get_post_types( array(), 'objects' );
		foreach ( $all as $slug => $obj ) {
			if ( in_array( $slug, self::HIDDEN_TYPES, true ) ) continue;
			$count_published = (int) wp_count_posts( $slug )->publish;
			$out[] = array(
				'slug'          => $slug,
				'name'          => $obj->labels->name ?? $slug,
				'singular_name' => $obj->labels->singular_name ?? $slug,
				'description'   => $obj->description ?? '',
				'public'        => (bool) $obj->public,
				'hierarchical'  => (bool) $obj->hierarchical,
				'rest_base'     => $obj->rest_base ?: $slug,
				'taxonomies'    => is_array( $obj->taxonomies ) ? array_values( $obj->taxonomies ) : array(),
				'is_builtin'    => (bool) $obj->_builtin,
				'count_published' => $count_published,
			);
		}
		return $out;
	}

	/**
	 * List items of a post type with everything the migrator needs inlined:
	 * rendered content, excerpt, featured image, taxonomies, ACF fields, meta.
	 *
	 * @param string $post_type
	 * @param int    $page       1-indexed
	 * @param int    $per_page
	 * @return array { items, total, total_pages }
	 */
	public static function list_items( $post_type, $page = 1, $per_page = 100 ) {
		$per_page = max( 1, min( 200, (int) $per_page ) );
		$page     = max( 1, (int) $page );

		$query = new WP_Query( array(
			'post_type'      => $post_type,
			'post_status'    => 'publish',
			'posts_per_page' => $per_page,
			'paged'          => $page,
			'orderby'        => 'date',
			'order'          => 'DESC',
			// Don't run shortcodes/filters for the list itself — we render per-item.
			'no_found_rows'  => false,
		) );

		$items = array();
		while ( $query->have_posts() ) {
			$query->the_post();
			$items[] = self::describe_post( get_post() );
		}
		wp_reset_postdata();

		return array(
			'items'       => $items,
			'total'       => (int) $query->found_posts,
			'total_pages' => (int) $query->max_num_pages,
			'page'        => $page,
			'per_page'    => $per_page,
		);
	}

	/**
	 * Get a single post by id, with everything inlined. Returns null on miss.
	 *
	 * @param int $id
	 * @return array|null
	 */
	public static function get_item( $id ) {
		$post = get_post( (int) $id );
		if ( ! $post || $post->post_status !== 'publish' ) return null;
		return self::describe_post( $post );
	}

	/**
	 * Convert a WP_Post into the migrator-friendly shape.
	 *
	 * @param WP_Post $post
	 * @return array
	 */
	public static function describe_post( $post ) {
		// Title — apply the_title filter so plugins/themes can hook in.
		$title = apply_filters( 'the_title', $post->post_title, $post->ID );

		// Content — apply the_content so shortcodes / blocks / page-builders
		// expand to their final HTML.
		$content_rendered = apply_filters( 'the_content', $post->post_content );
		$content_rendered = str_replace( ']]>', ']]&gt;', $content_rendered );

		// Excerpt.
		$excerpt = apply_filters( 'the_excerpt', get_the_excerpt( $post ) );

		// Featured image (full attachment description).
		$featured = null;
		$thumb_id = get_post_thumbnail_id( $post->ID );
		if ( $thumb_id ) {
			$featured = Typeroll_Helper_Media::describe( $thumb_id );
		}

		// Taxonomies (categories, tags, custom).
		$taxonomies = array();
		$tax_names  = get_object_taxonomies( $post->post_type );
		foreach ( $tax_names as $tax ) {
			$terms = wp_get_post_terms( $post->ID, $tax );
			if ( is_wp_error( $terms ) ) continue;
			$taxonomies[ $tax ] = array_map(
				function( $t ) {
					return array(
						'id'   => (int) $t->term_id,
						'name' => $t->name,
						'slug' => $t->slug,
					);
				},
				$terms
			);
		}

		// Custom post meta (skip underscore-prefixed internal keys, and skip
		// the few keys WP itself manages — they're not content).
		$skip_meta_keys = array(
			'_edit_lock', '_edit_last', '_wp_page_template',
			'_thumbnail_id', // already surfaced as featured_image
		);
		$meta = array();
		$all_meta = get_post_meta( $post->ID );
		if ( is_array( $all_meta ) ) {
			foreach ( $all_meta as $key => $vals ) {
				if ( in_array( $key, $skip_meta_keys, true ) ) continue;
				// Skip ACF's internal _foo keys but keep the user-facing "foo".
				if ( strpos( $key, '_' ) === 0 ) continue;
				// Most meta keys are single-value; collapse arrays of length 1.
				$val = ( is_array( $vals ) && count( $vals ) === 1 ) ? $vals[0] : $vals;
				$meta[ $key ] = self::maybe_unserialize( $val );
			}
		}

		// ACF fields (normalized).
		$acf = Typeroll_Helper_ACF::fields_for_post( $post->ID );

		// SEO overrides from whichever SEO plugin the customer is using —
		// normalized to a single shape so the migrator doesn't need to know
		// about Yoast/RankMath/SEOPress/AIOSEO individually. Empty array
		// when no SEO plugin is detected.
		$seo = Typeroll_Helper_SEO::for_post( $post->ID );

		// Detect page-builder data for downstream tools (optional).
		$builder = self::detect_builder( $post->ID );

		// Permalink / URL.
		$url = get_permalink( $post );

		return array(
			'id'           => (int) $post->ID,
			'type'         => $post->post_type,
			'slug'         => $post->post_name,
			'status'       => $post->post_status,
			'title'        => array( 'rendered' => $title ),
			'content'      => array(
				'rendered' => $content_rendered,
				'raw'      => $post->post_content,
			),
			'excerpt'      => array( 'rendered' => $excerpt ),
			'date'         => mysql_to_rfc3339( $post->post_date_gmt ),
			'modified'     => mysql_to_rfc3339( $post->post_modified_gmt ),
			'link'         => $url,
			'parent'       => (int) $post->post_parent,
			'menu_order'   => (int) $post->menu_order,
			'author'       => (int) $post->post_author,
			'featured_image' => $featured,
			'taxonomies'   => $taxonomies,
			'meta'         => $meta,
			'acf'          => $acf,
			'seo'          => $seo,
			'builder'      => $builder,
		);
	}

	private static function maybe_unserialize( $value ) {
		if ( is_string( $value ) && self::looks_like_serialized( $value ) ) {
			$un = @unserialize( $value, array( 'allowed_classes' => false ) );
			if ( $un !== false || $value === 'b:0;' ) return $un;
		}
		return $value;
	}

	private static function looks_like_serialized( $s ) {
		return is_string( $s ) && preg_match( '/^[abdiOs]:\d+/', $s ) === 1;
	}

	/**
	 * Detect whether the post was authored with a known page builder, and
	 * return its raw structured data so downstream tools can convert if they
	 * want. The migrator's current v1 doesn't use this — it relies on
	 * `content.rendered` — but it's available for future block conversion.
	 *
	 * @param int $post_id
	 * @return array|null
	 */
	private static function detect_builder( $post_id ) {
		$elementor = get_post_meta( $post_id, '_elementor_data', true );
		if ( $elementor ) {
			return array(
				'kind'    => 'elementor',
				'data'    => $elementor,
				'version' => get_post_meta( $post_id, '_elementor_version', true ),
			);
		}
		$breakdance = get_post_meta( $post_id, '_breakdance_data', true );
		if ( $breakdance ) {
			return array(
				'kind' => 'breakdance',
				'data' => $breakdance,
			);
		}
		// Gutenberg blocks are inline in post_content as comments; the migrator
		// already handles them via cleanWordPressHtml. No separate signal needed.
		return null;
	}
}
