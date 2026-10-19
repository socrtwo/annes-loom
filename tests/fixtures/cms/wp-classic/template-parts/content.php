<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
	<?php the_title( '<h2 class="entry-title"><a href="' . esc_url( get_permalink() ) . '">', '</a></h2>' ); ?>
	<div class="entry-meta"><?php the_date(); ?></div>
	<div class="entry-summary"><?php the_excerpt(); ?></div>
</article>
