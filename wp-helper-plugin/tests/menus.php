<?php
// Deterministic test of the /menus export against WordPress-shaped stubs.
define( 'ABSPATH', __DIR__ );
function rest_ensure_response( $value ) { return $value; }
function wp_get_nav_menus() {
	return array( (object) array( 'term_id' => 3, 'name' => 'Main', 'slug' => 'main' ), (object) array( 'term_id' => 4, 'name' => 'Legal', 'slug' => 'legal' ) );
}
function get_nav_menu_locations() { return array( 'primary' => 3, 'mobile' => 3, 'footer' => 9 ); }
function wp_get_nav_menu_items( $id ) {
	if ( $id !== 3 ) return array();
	return array( (object) array(
		'ID' => 11, 'title' => 'About', 'url' => 'https://source.example/about/', 'menu_item_parent' => '0', 'menu_order' => 1,
		'target' => '', 'classes' => array( '', 'highlight' ), 'object' => 'page', 'object_id' => '42', 'type' => 'post_type', 'description' => 'Who we are',
	) );
}
require __DIR__ . '/../includes/class-rest-api.php';
$menus = Typeroll_Helper_Rest_API::route_menus( null );
if ( $menus[0]['locations'] !== array( 'primary', 'mobile' ) || $menus[1]['locations'] !== array() ) throw new Exception( 'Menu locations lost' );
$item = $menus[0]['items'][0];
if ( $item['object'] !== 'page' || $item['object_id'] !== 42 || $item['type'] !== 'post_type' || $item['parent'] !== 0 || $item['classes'] !== array( 'highlight' ) || $item['description'] !== 'Who we are' ) throw new Exception( 'Menu item target lost' );
echo "Menu export passed: theme locations and item targets.\n";
