<?php
/** Harbor Light functions. */
function harbor_setup() {
	add_theme_support( 'title-tag' );
	register_nav_menus( array( 'primary' => __( 'Primary', 'harbor-light' ) ) );
}
add_action( 'after_setup_theme', 'harbor_setup' );

function harbor_scripts() {
	wp_enqueue_style( 'harbor-style', get_stylesheet_uri() );
	wp_enqueue_style( 'harbor-layout', get_template_directory_uri() . '/css/layout.css', array(), '1.0' );
	wp_enqueue_script( 'harbor-nav', get_template_directory_uri() . '/js/nav.js', array(), '1.0', true );
}
add_action( 'wp_enqueue_scripts', 'harbor_scripts' );
