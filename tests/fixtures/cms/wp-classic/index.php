<?php get_header(); ?>
<?php if ( have_posts() ) : ?>
	<?php while ( have_posts() ) : the_post(); ?>
		<?php get_template_part( 'template-parts/content', get_post_type() ); ?>
	<?php endwhile; ?>
	<?php the_posts_navigation(); ?>
<?php else : ?>
	<p><?php esc_html_e( 'Nothing found.', 'harbor-light' ); ?></p>
<?php endif; ?>
<?php get_footer(); ?>
