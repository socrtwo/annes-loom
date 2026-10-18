<?php
defined('_JEXEC') or die;
$app = JFactory::getApplication();
$sitename = $app->get('sitename');
?>
<!DOCTYPE html>
<html lang="<?php echo $this->language; ?>" dir="<?php echo $this->direction; ?>">
<head>
	<jdoc:include type="head" />
	<link rel="stylesheet" href="<?php echo $this->baseurl; ?>/templates/<?php echo $this->template; ?>/css/template.css">
</head>
<body>
	<header>
		<a class="brand" href="<?php echo $this->baseurl; ?>/"><?php echo $sitename; ?></a>
		<jdoc:include type="modules" name="menu" style="none" />
	</header>
	<jdoc:include type="message" />
	<main>
		<jdoc:include type="component" />
	</main>
	<?php if ($this->countModules('sidebar-right')) : ?>
	<aside><jdoc:include type="modules" name="sidebar-right" style="card" /></aside>
	<?php endif; ?>
	<footer><jdoc:include type="modules" name="footer" /></footer>
</body>
</html>
