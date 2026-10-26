<?php
// Deterministic security tests for the export boundary against WordPress-shaped stubs.
define( 'ABSPATH', __DIR__ );

class WP_Error {
	public $code;
	public $data;
	public function __construct( $code, $message = '', $data = array() ) {
		$this->code = $code;
		$this->data = $data;
	}
}
class WP_Post {
	public function __construct( array $fields ) {
		foreach ( $fields as $k => $v ) $this->$k = $v;
	}
}
class WP_User {
	public $ID;
	public $display_name;
	public $data;
	public function __construct( $id, $display_name, $data ) {
		$this->ID = $id;
		$this->display_name = $display_name;
		$this->data = $data;
	}
}
class Fake_Request {
	private $headers;
	private $params;
	public function __construct( $headers, $params ) {
		$this->headers = $headers;
		$this->params = $params;
	}
	public function get_header( $name ) { return $this->headers[ $name ] ?? null; }
	public function get_param( $name ) { return $this->params[ $name ] ?? null; }
}

$GLOBALS['tr_types'] = array(
	'post'         => (object) array( 'public' => true, 'publicly_queryable' => true, '_builtin' => true ),
	'page'         => (object) array( 'public' => true, 'publicly_queryable' => false, '_builtin' => true ),
	'product'      => (object) array( 'public' => true, 'publicly_queryable' => true, '_builtin' => false ),
	'shop_order'   => (object) array( 'public' => false, 'publicly_queryable' => false, '_builtin' => false ),
	'shop_coupon'  => (object) array( 'public' => false, 'publicly_queryable' => false, '_builtin' => false ),
	'flamingo_inbound' => (object) array( 'public' => false, 'publicly_queryable' => false, '_builtin' => false ),
	'revision'     => (object) array( 'public' => false, 'publicly_queryable' => false, '_builtin' => true ),
);
$GLOBALS['tr_posts'] = array(
	1 => new WP_Post( array( 'ID' => 1, 'post_type' => 'page', 'post_status' => 'publish', 'post_password' => '', 'post_title' => 'About', 'post_name' => 'about', 'post_content' => '<p>Public body</p>', 'post_date_gmt' => '2024-01-01 00:00:00', 'post_modified_gmt' => '2024-01-02 00:00:00', 'post_parent' => 0, 'menu_order' => 0, 'post_author' => 1 ) ),
	2 => new WP_Post( array( 'ID' => 2, 'post_type' => 'post', 'post_status' => 'publish', 'post_password' => 'hunter2', 'post_title' => 'Members', 'post_name' => 'members', 'post_content' => '<p>Secret body</p>', 'post_date_gmt' => '2024-01-01 00:00:00', 'post_modified_gmt' => '2024-01-02 00:00:00', 'post_parent' => 0, 'menu_order' => 0, 'post_author' => 1 ) ),
	3 => new WP_Post( array( 'ID' => 3, 'post_type' => 'shop_order', 'post_status' => 'publish', 'post_password' => '', 'post_title' => 'Order', 'post_name' => 'order-3', 'post_content' => '', 'post_date_gmt' => '2024-01-01 00:00:00', 'post_modified_gmt' => '2024-01-02 00:00:00', 'post_parent' => 0, 'menu_order' => 0, 'post_author' => 1 ) ),
	4 => new WP_Post( array( 'ID' => 4, 'post_type' => 'page', 'post_status' => 'draft', 'post_password' => '', 'post_title' => 'Draft', 'post_name' => 'draft', 'post_content' => '<p>Draft body</p>', 'post_date_gmt' => '2024-01-01 00:00:00', 'post_modified_gmt' => '2024-01-02 00:00:00', 'post_parent' => 0, 'menu_order' => 0, 'post_author' => 1 ) ),
);
$GLOBALS['tr_meta'] = array(
	1 => array( 'subtitle' => array( 'Hello' ), '_billing_email' => array( 'buyer@example.test' ), '_elementor_data' => array( '[]' ) ),
	2 => array( 'subtitle' => array( 'Secret subtitle' ) ),
	3 => array( '_billing_email' => array( 'buyer@example.test' ), 'note' => array( 'Order note' ) ),
);

function get_option( $name ) { return $name === 'typeroll_helper_api_key' ? str_repeat( 'k', 48 ) : false; }
function update_option( $name, $value ) { return true; }
function get_post_type_object( $type ) { return $GLOBALS['tr_types'][ $type ] ?? null; }
function is_post_type_viewable( $obj ) { return $obj->_builtin ? $obj->public : $obj->publicly_queryable; }
function post_type_exists( $type ) { return isset( $GLOBALS['tr_types'][ $type ] ); }
function get_post( $id ) { return $GLOBALS['tr_posts'][ (int) $id ] ?? null; }
function get_post_meta( $id, $key = '', $single = false ) {
	$all = $GLOBALS['tr_meta'][ $id ] ?? array();
	if ( $key === '' ) return $all;
	return isset( $all[ $key ] ) ? ( $single ? $all[ $key ][0] : $all[ $key ] ) : ( $single ? '' : array() );
}
function apply_filters( $hook, $value ) { return $value; }
function get_the_excerpt( $post ) { return 'Excerpt of ' . $post->post_content; }
function get_post_thumbnail_id( $id ) { return 0; }
function get_object_taxonomies( $type ) { return array(); }
function mysql_to_rfc3339( $date ) { return str_replace( ' ', 'T', $date ); }
function get_permalink( $post ) { return 'https://source.example/' . ( is_object( $post ) ? $post->post_name : $post ) . '/'; }
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function rest_ensure_response( $value ) { return $value; }
function wp_count_posts( $type ) { return (object) array( 'publish' => 1 ); }
function get_post_types( $args, $output ) {
	$out = array();
	foreach ( $GLOBALS['tr_types'] as $slug => $obj ) {
		$obj->labels = (object) array( 'name' => $slug, 'singular_name' => $slug );
		$obj->description = '';
		$obj->hierarchical = false;
		$obj->rest_base = $slug;
		$obj->taxonomies = array();
		$out[ $slug ] = $obj;
	}
	return $out;
}
function acf_get_field_groups() { return array(); }
function get_fields( $id ) {
	return array(
		'owner'    => new WP_User( 7, 'Ada', (object) array( 'user_pass' => '$P$hash', 'user_email' => 'ada@example.test' ) ),
		'editors'  => array( array( 'ID' => 8, 'display_name' => 'Bo', 'user_email' => 'bo@example.test', 'user_login' => 'bo' ) ),
		'related'  => $GLOBALS['tr_posts'][2],
		'linked'   => $GLOBALS['tr_posts'][1],
		'nested'   => array( 'deep' => array( new WP_User( 9, 'Cy', (object) array( 'user_pass' => '$P$hash2' ) ) ) ),
		'location' => (object) array( 'lat' => 1.5, 'lng' => 2.5 ),
		'title'    => 'Plain string',
	);
}

class Typeroll_Helper_SEO { public static function for_post( $id ) { return array(); } }
class Typeroll_Helper_Media { public static function describe( $id ) { return null; } }

require __DIR__ . '/../includes/class-auth.php';
require __DIR__ . '/../includes/class-acf.php';
require __DIR__ . '/../includes/class-content.php';
require __DIR__ . '/../includes/class-rest-api.php';

function check( $condition, $message ) {
	if ( ! $condition ) throw new Exception( $message );
}

// Auth: header only.
$key = str_repeat( 'k', 48 );
check( Typeroll_Helper_Auth::check_request( new Fake_Request( array( 'x-typeroll-key' => $key ), array() ) ) === true, 'Header key must authenticate' );
$query = Typeroll_Helper_Auth::check_request( new Fake_Request( array(), array( 'key' => $key ) ) );
check( $query instanceof WP_Error && $query->code === 'typeroll_no_key', 'Query-string key must be refused' );
$wrong = Typeroll_Helper_Auth::check_request( new Fake_Request( array( 'x-typeroll-key' => str_repeat( 'x', 48 ) ), array() ) );
check( $wrong instanceof WP_Error && $wrong->code === 'typeroll_bad_key', 'Wrong key must be refused' );

// Post types: only viewable, non-scaffolding types.
$slugs = array_column( Typeroll_Helper_Content::list_post_types(), 'slug' );
check( $slugs === array( 'post', 'page', 'product' ), 'Non-public post types leaked: ' . implode( ',', $slugs ) );
foreach ( array( 'shop_order', 'shop_coupon', 'flamingo_inbound', 'revision', 'missing' ) as $type ) {
	$res = Typeroll_Helper_Rest_API::route_items( array( 'type' => $type ) );
	check( $res instanceof WP_Error && $res->data['status'] === 404, "/items/$type must be 404" );
}

// Single items: non-public type and drafts are hidden.
check( Typeroll_Helper_Content::get_item( 3 ) === null, 'shop_order item leaked' );
check( Typeroll_Helper_Content::get_item( 4 ) === null, 'Draft item leaked' );

// Public item keeps its content and is not flagged.
$public = Typeroll_Helper_Content::get_item( 1 );
check( $public['protected'] === false && $public['content']['raw'] === '<p>Public body</p>' && $public['meta'] === array( 'subtitle' => 'Hello' ), 'Public item changed' );

// Password-protected item: identity only.
$protected = Typeroll_Helper_Content::get_item( 2 );
check( $protected['protected'] === true, 'Protected flag missing' );
check( $protected['content'] === array( 'rendered' => '', 'raw' => '' ) && $protected['excerpt']['rendered'] === '', 'Protected body leaked' );
check( $protected['meta'] === array() && $protected['acf'] === array() && $protected['builder'] === null, 'Protected custom data leaked' );
check( $protected['title']['rendered'] === 'Members' && $protected['link'] === 'https://source.example/members/', 'Protected identity lost' );
check( strpos( json_encode( $protected ), 'Secret' ) === false, 'Protected item contains secret text' );

// ACF: objects reduced to safe subsets, recursively.
$acf = json_encode( Typeroll_Helper_ACF::fields_for_post( 1 ) );
foreach ( array( 'user_pass', '$P$hash', 'user_email', 'ada@example.test', 'bo@example.test', 'user_login', 'Secret body', 'Members' ) as $needle ) {
	check( strpos( $acf, $needle ) === false, "ACF export leaked $needle" );
}
$fields = Typeroll_Helper_ACF::fields_for_post( 1 );
check( $fields['owner'] === array( 'ID' => 7, 'display_name' => 'Ada' ), 'WP_User not reduced' );
check( $fields['editors'][0] === array( 'ID' => 8, 'display_name' => 'Bo' ), 'User array not reduced' );
check( $fields['nested']['deep'][0] === array( 'ID' => 9, 'display_name' => 'Cy' ), 'Nested WP_User not reduced' );
check( $fields['linked']['permalink'] === 'https://source.example/about/' && $fields['linked']['post_title'] === 'About', 'Post reference lost public identity' );
check( ! isset( $fields['linked']['post_content'] ), 'Post reference leaked content' );
check( $fields['related']['ID'] === 2 && $fields['related']['post_title'] === '', 'Protected post reference leaked title' );
check( $fields['location'] === array( 'lat' => 1.5, 'lng' => 2.5 ) && $fields['title'] === 'Plain string', 'Plain ACF values changed' );

// Postmeta: public posts and non-underscore or allowlisted keys only.
$ok = Typeroll_Helper_Rest_API::route_postmeta( array( 'id' => 1, 'key' => 'subtitle' ) );
check( is_array( $ok ) && $ok['value'] === 'Hello', 'Public meta must be readable' );
$builder = Typeroll_Helper_Rest_API::route_postmeta( array( 'id' => 1, 'key' => '_elementor_data' ) );
check( is_array( $builder ) && $builder['value'] === '[]', 'Allowlisted builder meta must be readable' );
$private = Typeroll_Helper_Rest_API::route_postmeta( array( 'id' => 1, 'key' => '_billing_email' ) );
check( $private instanceof WP_Error && $private->data['status'] === 403, 'Underscore meta must be refused' );
$order = Typeroll_Helper_Rest_API::route_postmeta( array( 'id' => 3, 'key' => 'note' ) );
check( $order instanceof WP_Error && $order->data['status'] === 404, 'Meta of non-public type must be refused' );
$locked = Typeroll_Helper_Rest_API::route_postmeta( array( 'id' => 2, 'key' => 'subtitle' ) );
check( $locked instanceof WP_Error && $locked->data['status'] === 404, 'Meta of protected post must be refused' );
$draft = Typeroll_Helper_Rest_API::route_postmeta( array( 'id' => 4, 'key' => 'subtitle' ) );
check( $draft instanceof WP_Error && $draft->data['status'] === 404, 'Meta of draft must be refused' );

echo "Security boundary passed: header-only key, public types, protected posts, ACF objects and postmeta.\n";
