</main>
<?php get_sidebar(); ?>
<footer class="site-footer">
	<p>&copy; <?php echo date( 'Y' ); ?> <?php bloginfo( 'name' ); ?>. <?php printf( esc_html__( 'Theme: %s', 'harbor-light' ), 'Harbor Light' ); ?></p>
	<?php harbor_social_links(); ?>
</footer>
<?php wp_footer(); ?>
</body>
</html>
