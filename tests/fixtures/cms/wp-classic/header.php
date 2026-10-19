<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<header class="site-header">
	<?php if ( is_front_page() ) : ?>
		<h1 class="site-title"><a href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php bloginfo( 'name' ); ?></a></h1>
	<?php else : ?>
		<p class="site-title"><a href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php bloginfo( 'name' ); ?></a></p>
	<?php endif; ?>
	<?php $description = get_bloginfo( 'description', 'display' );
	if ( $description ) : ?>
		<p class="site-description"><?php echo $description; ?></p>
	<?php endif; ?>
	<img class="logo" src="<?php echo get_template_directory_uri(); ?>/images/logo.svg" alt="">
	<nav class="main-navigation">
		<?php
		wp_nav_menu( array(
			'theme_location' => 'primary',
			'menu_class'     => 'nav-menu',
			'container'      => false,
		) );
		?>
	</nav>
</header>
<main id="primary" class="site-main">
