<?php
/**
 * Routes under /wp-json/typeroll/v1/* — all auth'd via X-Typeroll-Key.
 *
 *   GET /info                         site metadata, ACF presence, key check
 *   GET /post-types                   every type the migrator might want
 *   GET /items/{type}?page&per_page   items of a type, with everything inlined
 *   GET /items/{type}/{id}            one item
 *   GET /acf/groups/{post_id}         ACF field-group schema for a post id
 *   GET /menus                        navigation menus and items
 *   GET /urls                         every public-facing permalink
 *   GET /redirects                    existing redirects from common WP plugins
 *   GET /postmeta/{id}/{key}          raw read of a specific postmeta field
 *   GET /seo                          site-wide SEO settings (active plugin)
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_Rest_API {

	const NAMESPACE_V1 = 'typeroll/v1';

	public static function register_routes() {
		$auth = array( 'Typeroll_Helper_Auth', 'check_request' );

		register_rest_route( self::NAMESPACE_V1, '/info', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_info' ),
		) );

		register_rest_route( self::NAMESPACE_V1, '/post-types', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_post_types' ),
		) );

		register_rest_route( self::NAMESPACE_V1, '/items/(?P<type>[\w-]+)', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_items' ),
			'args'                => array(
				'page'     => array( 'default' => 1,   'sanitize_callback' => 'absint' ),
				'per_page' => array( 'default' => 100, 'sanitize_callback' => 'absint' ),
			),
		) );

		register_rest_route( self::NAMESPACE_V1, '/items/(?P<type>[\w-]+)/(?P<id>\d+)', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_item' ),
		) );

		register_rest_route( self::NAMESPACE_V1, '/acf/groups/(?P<id>\d+)', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_acf_groups' ),
		) );

		register_rest_route( self::NAMESPACE_V1, '/menus', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_menus' ),
		) );

		register_rest_route( self::NAMESPACE_V1, '/urls', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_urls' ),
		) );

		register_rest_route( self::NAMESPACE_V1, '/redirects', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_redirects' ),
		) );

		register_rest_route( self::NAMESPACE_V1, '/seo', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_seo' ),
		) );

		// Escape hatch: read any postmeta field. Useful when an oddly-stored
		// custom field (e.g. a page builder's serialized blob) doesn't surface
		// through the normalized /items endpoint. The key is restricted to a
		// safe charset to keep the route shape predictable.
		register_rest_route( self::NAMESPACE_V1, '/postmeta/(?P<id>\d+)/(?P<key>[A-Za-z0-9_\-]+)', array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => array( __CLASS__, 'route_postmeta' ),
		) );
	}

	public static function route_info( $request ) {
		return rest_ensure_response( array(
			'name'             => get_bloginfo( 'name' ),
			'description'      => get_bloginfo( 'description' ),
			'url'              => home_url( '/' ),
			'admin_email'      => get_bloginfo( 'admin_email' ),
			'wp_version'       => get_bloginfo( 'version' ),
			'plugin_version'   => TYPEROLL_HELPER_VERSION,
			'acf_active'       => Typeroll_Helper_ACF::is_active(),
			'language'         => get_bloginfo( 'language' ),
			'timezone_string'  => get_option( 'timezone_string' ),
			'site_logo_id'     => function_exists( 'get_theme_mod' ) ? (int) get_theme_mod( 'custom_logo' ) : null,
		) );
	}

	public static function route_post_types( $request ) {
		return rest_ensure_response( Typeroll_Helper_Content::list_post_types() );
	}

	public static function route_items( $request ) {
		$type = $request['type'];
		if ( ! post_type_exists( $type ) ) {
			return new WP_Error( 'typeroll_unknown_type', "Unknown post type: $type", array( 'status' => 404 ) );
		}
		$page     = (int) $request->get_param( 'page' );
		$per_page = (int) $request->get_param( 'per_page' );
		$result   = Typeroll_Helper_Content::list_items( $type, $page, $per_page );

		$response = rest_ensure_response( $result['items'] );
		// Match the WP-Total / WP-TotalPages convention so paginating clients work.
		$response->header( 'X-WP-Total', (string) $result['total'] );
		$response->header( 'X-WP-TotalPages', (string) $result['total_pages'] );
		return $response;
	}

	public static function route_item( $request ) {
		$item = Typeroll_Helper_Content::get_item( (int) $request['id'] );
		if ( ! $item ) {
			return new WP_Error( 'typeroll_not_found', 'Item not found', array( 'status' => 404 ) );
		}
		if ( $item['type'] !== $request['type'] ) {
			return new WP_Error( 'typeroll_type_mismatch', 'Item exists but is a different post type.', array( 'status' => 404 ) );
		}
		return rest_ensure_response( $item );
	}

	public static function route_acf_groups( $request ) {
		return rest_ensure_response(
			Typeroll_Helper_ACF::field_groups_for_post( (int) $request['id'] )
		);
	}

	/**
	 * Return every public-facing URL the site emits: permalinks for all
	 * published items across every post type, plus archive URLs we can
	 * derive. The migrator uses this to build its inventory and verify
	 * coverage before the customer switches DNS.
	 */
	public static function route_urls( $request ) {
		$out   = array();
		$types = get_post_types( array( 'public' => true ), 'objects' );

		foreach ( $types as $slug => $obj ) {
			if ( $slug === 'attachment' ) continue;

			$paged = 1;
			while ( true ) {
				$query = new WP_Query( array(
					'post_type'      => $slug,
					'post_status'    => 'publish',
					'posts_per_page' => 200,
					'paged'          => $paged,
					'fields'         => 'ids',
					'no_found_rows'  => false,
				) );
				if ( ! $query->have_posts() ) break;
				foreach ( $query->posts as $post_id ) {
					$permalink = get_permalink( $post_id );
					if ( $permalink ) {
						$out[] = array(
							'url'   => $permalink,
							'type'  => $slug,
							'id'    => (int) $post_id,
							'date'  => mysql_to_rfc3339( get_post_field( 'post_date_gmt', $post_id ) ),
						);
					}
				}
				if ( $paged >= (int) $query->max_num_pages ) break;
				$paged++;
				if ( $paged > 200 ) break; // sanity cap
			}
		}

		return rest_ensure_response( $out );
	}

	public static function route_redirects( $request ) {
		return rest_ensure_response( Typeroll_Helper_Redirects::collect() );
	}

	public static function route_seo( $request ) {
		return rest_ensure_response( Typeroll_Helper_SEO::site_wide() );
	}

	public static function route_postmeta( $request ) {
		$post_id  = (int) $request['id'];
		$meta_key = (string) $request['key'];
		$post     = get_post( $post_id );
		if ( ! $post ) {
			return new WP_Error( 'typeroll_not_found', 'Post not found', array( 'status' => 404 ) );
		}
		$value = get_post_meta( $post_id, $meta_key, true );
		// If the value parses cleanly as JSON, surface that too for convenience.
		$decoded = null;
		if ( is_string( $value ) && $value !== '' ) {
			$try = json_decode( $value, true );
			if ( json_last_error() === JSON_ERROR_NONE ) $decoded = $try;
		}
		return rest_ensure_response( array(
			'post_id'       => $post_id,
			'meta_key'      => $meta_key,
			'value'         => $value,
			'value_decoded' => $decoded,
			'value_type'    => gettype( $value ),
		) );
	}

	public static function route_menus( $request ) {
		if ( ! function_exists( 'wp_get_nav_menus' ) ) return rest_ensure_response( array() );
		$menus = wp_get_nav_menus();
		$out = array();
		foreach ( $menus as $menu ) {
			$items = wp_get_nav_menu_items( $menu->term_id );
			$out[] = array(
				'id'    => (int) $menu->term_id,
				'name'  => $menu->name,
				'slug'  => $menu->slug,
				'items' => is_array( $items ) ? array_map(
					function( $i ) {
						return array(
							'id'        => (int) $i->ID,
							'title'     => $i->title,
							'url'       => $i->url,
							'parent'    => (int) $i->menu_item_parent,
							'order'     => (int) $i->menu_order,
							'target'    => $i->target,
							'classes'   => is_array( $i->classes ) ? array_values( array_filter( $i->classes ) ) : array(),
						);
					},
					$items
				) : array(),
			);
		}
		return rest_ensure_response( $out );
	}
}
