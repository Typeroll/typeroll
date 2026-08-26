<?php
/**
 * Normalize per-post AND site-wide SEO from whichever plugin the customer
 * is running. The migrator maps the per-post shape onto Page's seo_* fields
 * and the site-wide shape onto the new site doc's SEO slots.
 *
 * Supported sources, in detection order:
 *   - Yoast SEO          (postmeta `_yoast_wpseo_*`, option `wpseo_titles`)
 *   - RankMath           (postmeta `rank_math_*`, option `rank-math-options-titles`)
 *   - SEOPress           (postmeta `_seopress_*`, option `seopress_titles_*`)
 *   - All in One SEO     (custom table `wp_aioseo_posts`, option `aioseo_options`)
 *
 * Detection prefers the actively-running plugin (function/class probe) and
 * falls back to "data present in DB" if nothing's hooked. Returns 'none'
 * when no SEO data of any kind shows up.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class Typeroll_Helper_SEO {

	/**
	 * Returns one of: 'yoast', 'rankmath', 'seopress', 'aioseo', 'none'.
	 * Cached per-request so describe_post() doesn't re-detect on every item.
	 */
	public static function detect_plugin() {
		static $cached = null;
		if ( $cached !== null ) return $cached;

		if ( defined( 'WPSEO_VERSION' ) || class_exists( 'WPSEO_Options' ) ) {
			return $cached = 'yoast';
		}
		if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
			return $cached = 'rankmath';
		}
		if ( defined( 'SEOPRESS_VERSION' ) || function_exists( 'seopress_titles_single_titles_option' ) ) {
			return $cached = 'seopress';
		}
		if ( defined( 'AIOSEO_VERSION' ) || class_exists( 'AIOSEO\\Plugin\\AIOSEO' ) ) {
			return $cached = 'aioseo';
		}

		// Fallback: probe the DB for traces of each plugin's per-post fields.
		// Lets us still import from a site where the plugin was deactivated
		// before the customer reached out.
		global $wpdb;
		$traces = $wpdb->get_var(
			"SELECT meta_key FROM {$wpdb->postmeta}
			 WHERE meta_key IN ('_yoast_wpseo_title','rank_math_title','_seopress_titles_title','_aioseo_title')
			 LIMIT 1"
		);
		if ( $traces ) {
			switch ( $traces ) {
				case '_yoast_wpseo_title':       return $cached = 'yoast';
				case 'rank_math_title':          return $cached = 'rankmath';
				case '_seopress_titles_title':   return $cached = 'seopress';
				case '_aioseo_title':            return $cached = 'aioseo';
			}
		}
		return $cached = 'none';
	}

	/**
	 * Per-post SEO in a normalized shape. Empty fields are omitted so the
	 * downstream merger can `??` over them.
	 */
	public static function for_post( $post_id ) {
		$plugin = self::detect_plugin();
		switch ( $plugin ) {
			case 'yoast':    return self::yoast_post( $post_id );
			case 'rankmath': return self::rankmath_post( $post_id );
			case 'seopress': return self::seopress_post( $post_id );
			case 'aioseo':   return self::aioseo_post( $post_id );
			default:         return array();
		}
	}

	/** Site-wide settings. */
	public static function site_wide() {
		$plugin = self::detect_plugin();
		$payload = array(
			'plugin' => $plugin,
			'site'   => array(),
		);
		switch ( $plugin ) {
			case 'yoast':    $payload['site'] = self::yoast_site();    break;
			case 'rankmath': $payload['site'] = self::rankmath_site(); break;
			case 'seopress': $payload['site'] = self::seopress_site(); break;
			case 'aioseo':   $payload['site'] = self::aioseo_site();   break;
		}
		return $payload;
	}

	// ─── Yoast ────────────────────────────────────────────────────────────

	private static function yoast_post( $post_id ) {
		$out = array();
		$pull = function( $key ) use ( $post_id ) {
			$v = get_post_meta( $post_id, $key, true );
			return ( is_string( $v ) && $v !== '' ) ? $v : null;
		};

		$title  = $pull( '_yoast_wpseo_title' );
		$desc   = $pull( '_yoast_wpseo_metadesc' );
		$canon  = $pull( '_yoast_wpseo_canonical' );
		$noidx  = get_post_meta( $post_id, '_yoast_wpseo_meta-robots-noindex', true );
		$nofol  = get_post_meta( $post_id, '_yoast_wpseo_meta-robots-nofollow', true );
		$ogt    = $pull( '_yoast_wpseo_opengraph-title' );
		$ogd    = $pull( '_yoast_wpseo_opengraph-description' );
		$ogi    = $pull( '_yoast_wpseo_opengraph-image' );
		$twt    = $pull( '_yoast_wpseo_twitter-title' );
		$twd    = $pull( '_yoast_wpseo_twitter-description' );
		$twi    = $pull( '_yoast_wpseo_twitter-image' );
		$focus  = $pull( '_yoast_wpseo_focuskw' );

		if ( $title !== null )  $out['title']        = $title;
		if ( $desc !== null )   $out['description']  = $desc;
		if ( $canon !== null )  $out['canonical']    = $canon;
		// Yoast stores: '1' = noindex, '2' = index, '0' = default.
		if ( $noidx === '1' )   $out['noindex']      = true;
		if ( $nofol === '1' )   $out['nofollow']     = true;
		if ( $ogt !== null )    $out['og_title']     = $ogt;
		if ( $ogd !== null )    $out['og_description'] = $ogd;
		if ( $ogi !== null )    $out['og_image']     = $ogi;
		if ( $twt !== null )    $out['twitter_title'] = $twt;
		if ( $twd !== null )    $out['twitter_description'] = $twd;
		if ( $twi !== null )    $out['twitter_image'] = $twi;
		if ( $focus !== null )  $out['focus_keyword'] = $focus;
		return $out;
	}

	private static function yoast_site() {
		$titles = get_option( 'wpseo_titles', array() );
		$social = get_option( 'wpseo', array() );
		if ( ! is_array( $titles ) ) $titles = array();
		if ( ! is_array( $social ) ) $social = array();

		return array(
			'title_separator'         => self::yoast_separator_char( $titles['separator'] ?? null ),
			'default_title_format'    => $titles['title-home-wpseo'] ?? null,
			'default_meta_description'=> $titles['metadesc-home-wpseo'] ?? null,
			'organization'            => array(
				'name'    => $titles['company_name'] ?? null,
				'logo'    => $titles['company_logo'] ?? null,
				'same_as' => array_values( array_filter( array(
					$social['facebook_site']  ?? null,
					$social['instagram_url']  ?? null,
					$social['linkedin_url']   ?? null,
					$social['youtube_url']    ?? null,
					$social['twitter_site']   ? 'https://twitter.com/' . ltrim( $social['twitter_site'], '@' ) : null,
				) ) ),
			),
			'social'                  => array(
				'facebook'  => $social['facebook_site']  ?? null,
				'instagram' => $social['instagram_url']  ?? null,
				'linkedin'  => $social['linkedin_url']   ?? null,
				'twitter'   => $social['twitter_site']   ?? null,
				'youtube'   => $social['youtube_url']    ?? null,
			),
			'default_og_image'        => $social['og_default_image']  ?? null,
		);
	}

	private static function yoast_separator_char( $key ) {
		// Yoast stores e.g. 'sc-dash' for "-", 'sc-bull' for "•".
		$map = array(
			'sc-dash' => '-', 'sc-ndash' => '–', 'sc-mdash' => '—',
			'sc-colon' => ':', 'sc-middot' => '·', 'sc-bull' => '•',
			'sc-star' => '*', 'sc-smstar' => '⋆', 'sc-pipe' => '|',
			'sc-tilde' => '~', 'sc-laquo' => '«', 'sc-raquo' => '»',
			'sc-lt' => '<', 'sc-gt' => '>',
		);
		return $map[ $key ] ?? null;
	}

	// ─── RankMath ─────────────────────────────────────────────────────────

	private static function rankmath_post( $post_id ) {
		$out = array();
		$pull = function( $key ) use ( $post_id ) {
			$v = get_post_meta( $post_id, $key, true );
			return ( is_string( $v ) && $v !== '' ) ? $v : null;
		};

		$title = $pull( 'rank_math_title' );
		$desc  = $pull( 'rank_math_description' );
		$canon = $pull( 'rank_math_canonical_url' );
		$robots_raw = get_post_meta( $post_id, 'rank_math_robots', true );
		$robots = is_array( $robots_raw ) ? $robots_raw : ( is_string( $robots_raw ) ? array_filter( explode( ',', $robots_raw ) ) : array() );
		$ogt   = $pull( 'rank_math_facebook_title' );
		$ogd   = $pull( 'rank_math_facebook_description' );
		$ogi   = $pull( 'rank_math_facebook_image' );
		$twt   = $pull( 'rank_math_twitter_title' );
		$twd   = $pull( 'rank_math_twitter_description' );
		$twi   = $pull( 'rank_math_twitter_image' );
		$focus = $pull( 'rank_math_focus_keyword' );

		if ( $title !== null ) $out['title']       = $title;
		if ( $desc !== null )  $out['description'] = $desc;
		if ( $canon !== null ) $out['canonical']   = $canon;
		if ( in_array( 'noindex', $robots, true ) )  $out['noindex']  = true;
		if ( in_array( 'nofollow', $robots, true ) ) $out['nofollow'] = true;
		if ( $ogt !== null )   $out['og_title']        = $ogt;
		if ( $ogd !== null )   $out['og_description']  = $ogd;
		if ( $ogi !== null )   $out['og_image']        = $ogi;
		if ( $twt !== null )   $out['twitter_title']        = $twt;
		if ( $twd !== null )   $out['twitter_description']  = $twd;
		if ( $twi !== null )   $out['twitter_image']        = $twi;
		if ( $focus !== null ) $out['focus_keyword']        = explode( ',', $focus )[0]; // first one
		return $out;
	}

	private static function rankmath_site() {
		// RankMath stores site title format in 'rank-math-options-titles'
		// (under e.g. 'title_separator', 'homepage_title', 'homepage_description').
		$titles = get_option( 'rank-math-options-titles', array() );
		$general = get_option( 'rank-math-options-general', array() );
		if ( ! is_array( $titles ) ) $titles = array();
		if ( ! is_array( $general ) ) $general = array();

		return array(
			'title_separator'          => $titles['title_separator'] ?? null,
			'default_title_format'     => $titles['homepage_title'] ?? null,
			'default_meta_description' => $titles['homepage_description'] ?? null,
			'organization'             => array(
				'name'    => $titles['knowledgegraph_name'] ?? null,
				'logo'    => $titles['knowledgegraph_logo'] ?? null,
				'same_as' => array_values( array_filter( array(
					$titles['social_url_facebook']  ?? null,
					$titles['social_url_instagram'] ?? null,
					$titles['social_url_linkedin']  ?? null,
					$titles['social_url_youtube']   ?? null,
					$titles['twitter_author_names'] ?? null,
				) ) ),
			),
			'social'                   => array(
				'facebook'  => $titles['social_url_facebook']  ?? null,
				'instagram' => $titles['social_url_instagram'] ?? null,
				'linkedin'  => $titles['social_url_linkedin']  ?? null,
				'twitter'   => $titles['twitter_author_names'] ?? null,
				'youtube'   => $titles['social_url_youtube']   ?? null,
			),
			'default_og_image'         => $titles['open_graph_image'] ?? null,
		);
	}

	// ─── SEOPress ─────────────────────────────────────────────────────────

	private static function seopress_post( $post_id ) {
		$out = array();
		$pull = function( $key ) use ( $post_id ) {
			$v = get_post_meta( $post_id, $key, true );
			return ( is_string( $v ) && $v !== '' ) ? $v : null;
		};

		$title = $pull( '_seopress_titles_title' );
		$desc  = $pull( '_seopress_titles_desc' );
		$canon = $pull( '_seopress_robots_canonical' );
		$noidx = get_post_meta( $post_id, '_seopress_robots_index', true );
		$nofol = get_post_meta( $post_id, '_seopress_robots_follow', true );
		$ogt   = $pull( '_seopress_social_fb_title' );
		$ogd   = $pull( '_seopress_social_fb_desc' );
		$ogi   = $pull( '_seopress_social_fb_img' );
		$twt   = $pull( '_seopress_social_twitter_title' );
		$twd   = $pull( '_seopress_social_twitter_desc' );
		$twi   = $pull( '_seopress_social_twitter_img' );
		$focus = $pull( '_seopress_analysis_target_kw' );

		if ( $title !== null ) $out['title']       = $title;
		if ( $desc !== null )  $out['description'] = $desc;
		if ( $canon !== null ) $out['canonical']   = $canon;
		// SEOPress stores 'yes' on noindex/nofollow when checked.
		if ( $noidx === 'yes' ) $out['noindex']  = true;
		if ( $nofol === 'yes' ) $out['nofollow'] = true;
		if ( $ogt !== null )   $out['og_title']        = $ogt;
		if ( $ogd !== null )   $out['og_description']  = $ogd;
		if ( $ogi !== null )   $out['og_image']        = $ogi;
		if ( $twt !== null )   $out['twitter_title']        = $twt;
		if ( $twd !== null )   $out['twitter_description']  = $twd;
		if ( $twi !== null )   $out['twitter_image']        = $twi;
		if ( $focus !== null ) $out['focus_keyword']        = explode( ',', $focus )[0];
		return $out;
	}

	private static function seopress_site() {
		$titles = get_option( 'seopress_titles_option_name', array() );
		$social = get_option( 'seopress_social_option_name', array() );
		if ( ! is_array( $titles ) ) $titles = array();
		if ( ! is_array( $social ) ) $social = array();

		return array(
			'title_separator'          => $titles['seopress_titles_sep'] ?? null,
			'default_title_format'     => $titles['seopress_titles_home_site_title'] ?? null,
			'default_meta_description' => $titles['seopress_titles_home_site_desc'] ?? null,
			'organization'             => array(
				'name'    => $social['seopress_social_knowledge_name'] ?? null,
				'logo'    => $social['seopress_social_knowledge_img'] ?? null,
				'same_as' => array_values( array_filter( array(
					$social['seopress_social_accounts_facebook']  ?? null,
					$social['seopress_social_accounts_instagram'] ?? null,
					$social['seopress_social_accounts_linkedin']  ?? null,
					$social['seopress_social_accounts_youtube']   ?? null,
					$social['seopress_social_accounts_twitter']   ?? null,
				) ) ),
			),
			'social'                   => array(
				'facebook'  => $social['seopress_social_accounts_facebook']  ?? null,
				'instagram' => $social['seopress_social_accounts_instagram'] ?? null,
				'linkedin'  => $social['seopress_social_accounts_linkedin']  ?? null,
				'twitter'   => $social['seopress_social_accounts_twitter']   ?? null,
				'youtube'   => $social['seopress_social_accounts_youtube']   ?? null,
			),
			'default_og_image'         => $social['seopress_social_facebook_img'] ?? null,
		);
	}

	// ─── All in One SEO (AIOSEO) ──────────────────────────────────────────
	//
	// Modern AIOSEO stores per-post data in a custom table, not postmeta.
	// We probe the table first; if it doesn't exist (very old AIOSEO), we
	// fall back to legacy `_aioseo_*` postmeta.

	private static function aioseo_post( $post_id ) {
		global $wpdb;
		$table = $wpdb->prefix . 'aioseo_posts';
		$exists = $wpdb->get_var( $wpdb->prepare( "SHOW TABLES LIKE %s", $table ) );
		if ( $exists === $table ) {
			$row = $wpdb->get_row( $wpdb->prepare(
				"SELECT title, description, canonical_url, robots_default, robots_noindex, robots_nofollow,
				        og_title, og_description, og_image_url, og_image_custom_url,
				        twitter_title, twitter_description, twitter_image_url, twitter_image_custom_url,
				        keyphrases
				 FROM {$table} WHERE post_id = %d",
				$post_id
			), ARRAY_A );
			if ( ! $row ) return array();
			$out = array();
			$set = function( &$o, $k, $v ) {
				if ( is_string( $v ) && $v !== '' ) $o[ $k ] = $v;
			};
			$set( $out, 'title',         $row['title'] );
			$set( $out, 'description',   $row['description'] );
			$set( $out, 'canonical',     $row['canonical_url'] );
			if ( (int) $row['robots_noindex'] === 1 ) $out['noindex'] = true;
			if ( (int) $row['robots_nofollow'] === 1 ) $out['nofollow'] = true;
			$set( $out, 'og_title',       $row['og_title'] );
			$set( $out, 'og_description', $row['og_description'] );
			$set( $out, 'og_image',       $row['og_image_custom_url'] ?: $row['og_image_url'] );
			$set( $out, 'twitter_title',       $row['twitter_title'] );
			$set( $out, 'twitter_description', $row['twitter_description'] );
			$set( $out, 'twitter_image',       $row['twitter_image_custom_url'] ?: $row['twitter_image_url'] );
			if ( $row['keyphrases'] ) {
				$kp = json_decode( $row['keyphrases'], true );
				if ( isset( $kp['focus']['keyphrase'] ) ) $out['focus_keyword'] = $kp['focus']['keyphrase'];
			}
			return $out;
		}

		// Legacy AIOSEO postmeta fallback.
		$out = array();
		$pull = function( $key ) use ( $post_id ) {
			$v = get_post_meta( $post_id, $key, true );
			return ( is_string( $v ) && $v !== '' ) ? $v : null;
		};
		if ( $t = $pull( '_aioseo_title' ) )       $out['title']       = $t;
		if ( $d = $pull( '_aioseo_description' ) ) $out['description'] = $d;
		if ( $c = $pull( '_aioseo_canonical' ) )   $out['canonical']   = $c;
		return $out;
	}

	private static function aioseo_site() {
		$opts = get_option( 'aioseo_options', '' );
		$parsed = is_string( $opts ) ? json_decode( $opts, true ) : ( is_array( $opts ) ? $opts : array() );
		if ( ! is_array( $parsed ) ) $parsed = array();
		// Modern AIOSEO nests EVERYTHING under deep paths; pluck the few we care about.
		$g = function( $path ) use ( $parsed ) {
			$node = $parsed;
			foreach ( $path as $k ) {
				if ( ! is_array( $node ) || ! isset( $node[ $k ] ) ) return null;
				$node = $node[ $k ];
			}
			return is_string( $node ) ? $node : null;
		};
		return array(
			'title_separator'          => $g( array( 'searchAppearance', 'global', 'separator' ) ),
			'default_title_format'     => $g( array( 'searchAppearance', 'global', 'siteTitle' ) ),
			'default_meta_description' => $g( array( 'searchAppearance', 'global', 'metaDescription' ) ),
			'organization'             => array(
				'name'    => $g( array( 'searchAppearance', 'global', 'schema', 'organizationName' ) ),
				'logo'    => $g( array( 'searchAppearance', 'global', 'schema', 'organizationLogo' ) ),
				'same_as' => array(),
			),
			'social'                   => array(
				'facebook'  => $g( array( 'social', 'profiles', 'urls', 'facebookPageUrl' ) ),
				'instagram' => $g( array( 'social', 'profiles', 'urls', 'instagramUrl' ) ),
				'linkedin'  => $g( array( 'social', 'profiles', 'urls', 'linkedinUrl' ) ),
				'twitter'   => $g( array( 'social', 'profiles', 'urls', 'twitterUrl' ) ),
				'youtube'   => $g( array( 'social', 'profiles', 'urls', 'youtubeUrl' ) ),
			),
			'default_og_image'         => $g( array( 'social', 'facebook', 'general', 'defaultImagePosts' ) ),
		);
	}
}
