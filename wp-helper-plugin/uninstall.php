<?php
/**
 * Runs when the plugin is deleted from WP admin. Removes the stored API key
 * so a deleted plugin leaves no usable credential behind. On multisite the
 * option is per-site, so every site is cleaned.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

$typeroll_helper_option = 'typeroll_helper_api_key';

if ( is_multisite() && function_exists( 'get_sites' ) ) {
	foreach ( get_sites( array( 'fields' => 'ids', 'number' => 0 ) ) as $typeroll_helper_site_id ) {
		switch_to_blog( (int) $typeroll_helper_site_id );
		delete_option( $typeroll_helper_option );
		restore_current_blog();
	}
} else {
	delete_option( $typeroll_helper_option );
}
