<?php get_header(); ?>
<?php while ( have_posts() ) : the_post(); ?>
	<article <?php post_class( 'single-entry' ); ?>>
		<h1 class="entry-title"><?php the_title(); ?></h1>
		<p class="byline"><?php the_author(); ?> &middot; <?php echo get_the_date(); ?></p>
		<?php the_content(); ?>
	</article>
<?php endwhile; ?>
<?php get_footer(); ?>
