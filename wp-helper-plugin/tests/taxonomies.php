<?php
// Deterministic adapter test against WordPress-shaped source fixtures.
define( 'ABSPATH', __DIR__ );
function get_taxonomies( $args, $output ) {
    return array( 'category' => (object) array( 'labels' => (object) array( 'name' => 'Categories' ), 'rest_base' => 'categories', 'object_type' => array( 'post' ), 'hierarchical' => true ) );
}
function wp_count_terms( $args ) { return 2; }
function get_terms( $args ) {
    if ( $args['offset'] !== 1 || $args['number'] !== 1 || $args['hide_empty'] !== false ) throw new Exception( 'Pagination contract changed' );
    return array( (object) array( 'term_id' => 2, 'name' => 'Packing', 'slug' => 'packing', 'parent' => 1, 'description' => 'Shared description' ) );
}
function get_term_link( $term ) { return 'https://source.example/category/' . $term->slug . '/'; }
function get_term_meta( $id ) { return array( 'emoji' => array( '📦' ), '_internal' => array( 'hidden' ) ); }
function get_fields( $term ) { return array( 'color' => '#123456' ); }
function is_wp_error( $value ) { return false; }
require __DIR__ . '/../includes/class-content.php';
$types = Typeroll_Helper_Content::list_taxonomies();
if ( $types[0]['slug'] !== 'category' || $types[0]['types'] !== array( 'post' ) ) throw new Exception( 'Taxonomy mapping lost' );
$result = Typeroll_Helper_Content::list_terms( 'category', 2, 1 );
$term = $result['items'][0];
if ( $result['total_pages'] !== 2 || $term['parent'] !== 1 || $term['meta'] !== array( 'emoji' => '📦' ) || $term['acf']['color'] !== '#123456' || $term['link'] !== 'https://source.example/category/packing/' ) throw new Exception( 'Shared term metadata lost' );
echo "Taxonomy extraction passed: pagination, parents, archive URLs and shared metadata.\n";
