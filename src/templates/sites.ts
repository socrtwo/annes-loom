/**
 * Built-in site templates (original work). Each returns every file of a small, working site: pages that
 * share one style sheet and navigation, placeholder pictures drawn as SVG files, and no external assets.
 */
import type { TemplateDef } from './index';
import { buildSite, baseCss, navMarkup, ln, artSvg, avatarSvg, FONTS, type Theme } from './kit';
import { Site } from '../model/site';
import { applyTemplate } from '../site/templates';
import { blankPage, esc } from '../model/html';

// ------------------------------------------------------------------------------------------
// Starter site: pages attached to a page template (Templates/main.dwt)

const STARTER_THEME: Theme = {
  font: FONTS.sans, bg: '#ffffff', fg: '#1d2433', muted: '#5a6478', surface: '#f4f6fb', border: '#dde2ec', accent: '#2f5bd3', accentFg: '#ffffff',
  dark: { bg: '#11151d', fg: '#e8ebf2', muted: '#a3abbd', surface: '#1a202b', border: '#2c3445', accent: '#8fb0ff', accentFg: '#0d1424' },
};

const STARTER_NAV = [{ path: 'index.html', label: 'Home' }, { path: 'about.html', label: 'About' }, { path: 'contact.html', label: 'Contact' }];

function starterTemplate(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- #BeginEditable "doctitle" -->
  <title>Page Title – My Web Site</title>
  <!-- #EndEditable -->
  <link rel="stylesheet" href="../css/site.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="../index.html">My Web Site<small>A short tagline goes here</small></a>
    ${navMarkup(STARTER_NAV, 'Templates/main.dwt')}
  </div>
</header>
<main id="main" class="wrap page">
<!-- #BeginEditable "content" -->
<h1>Page heading</h1>
<p>Pages attached to this template keep their own content here. Everything outside this region comes from the template.</p>
<!-- #EndEditable -->
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>&copy; 2026 My Web Site</p>
    <p>Made with Anne's Loom</p>
  </div>
</footer>
</body>
</html>
`;
}

const STARTER_HOME = `<section class="starter-hero">
  <p class="eyebrow">Welcome</p>
  <h1>Your new web site starts here</h1>
  <p class="lead">This starter site has three pages, one shared style sheet and a page template. Click anywhere on this page in Design view and start typing.</p>
  <p class="actions"><a class="button" href="about.html">About this site</a> <a class="button ghost" href="contact.html">Get in touch</a></p>
</section>
<h2>Three things to try</h2>
<div class="grid">
  <article class="card">
    <h3>Edit this page</h3>
    <p>Type over this text in Design view, or switch to Code or Split view to edit the HTML directly.</p>
  </article>
  <article class="card">
    <h3>Change the look</h3>
    <p>Colors and fonts live at the top of <code>css/site.css</code> as custom properties. Change <code>--accent</code> and every page follows.</p>
  </article>
  <article class="card">
    <h3>Update every page at once</h3>
    <p>The header, navigation and footer come from <code>Templates/main.dwt</code>. Edit it, save, and the attached pages are updated.</p>
  </article>
</div>`;

const STARTER_ABOUT = `<h1>About</h1>
<div class="prose">
  <p class="lead">Tell visitors who you are and what this site offers. A short, friendly paragraph works best.</p>
  <p>Use this page for your story, your mission or the people behind the work. Add a picture with Insert ▸ Picture, and keep paragraphs short so they read well on phones.</p>
  <h2>What we do</h2>
  <ul>
    <li>Describe your first service, product or interest.</li>
    <li>Describe the second one.</li>
    <li>And a third, if you have one.</li>
  </ul>
  <blockquote>A quotation from a happy customer or a guiding idea fits nicely here.</blockquote>
</div>`;

const STARTER_CONTACT = `<h1>Contact</h1>
<div class="split starter-contact">
  <form class="card" action="#" method="post">
    <div class="field"><label for="name">Name</label><input id="name" name="name" autocomplete="name" required></div>
    <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
    <div class="field"><label for="message">Message</label><textarea id="message" name="message" rows="5" required></textarea></div>
    <p class="hint">This form needs a form handler on your web server or a form service before it can send mail.</p>
    <button class="button" type="submit">Send message</button>
  </form>
  <div>
    <h2>Other ways to reach us</h2>
    <p>Email: <a href="mailto:hello@example.com">hello@example.com</a><br>Phone: (555) 010-0100</p>
    <address>123 Example Street<br>Springfield, ST 00000</address>
  </div>
</div>`;

function starterFiles(): Record<string, string> {
  const tmp = new Site('My Web Site');
  const tpl = starterTemplate();
  tmp.write('Templates/main.dwt', tpl, { silent: true });
  const files: Record<string, string> = {
    'css/site.css': baseCss(STARTER_THEME) + `
/* Starter site */
.starter-hero { padding: clamp(1.5rem, 5vw, 3rem); margin-bottom: 2.5rem; border-radius: var(--radius); background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, var(--bg)), var(--surface)); }
.starter-contact { align-items: start; }
`,
    'Templates/main.dwt': tpl,
  };
  const pages: [string, string, string][] = [['index.html', 'Home – My Web Site', STARTER_HOME], ['about.html', 'About – My Web Site', STARTER_ABOUT], ['contact.html', 'Contact – My Web Site', STARTER_CONTACT]];
  for (const [path, title, body] of pages) files[path] = applyTemplate(tmp, 'Templates/main.dwt', blankPage({ title, body }), path);
  return files;
}

// ------------------------------------------------------------------------------------------
// Personal portfolio

function personalFiles(): Record<string, string> {
  const projects = ['Riverside Library signage', 'Harvest Market identity', 'Night Owl Coffee app', 'Field Notes zine', 'Northwind Trails maps', 'Studio Fern website'];
  const files = buildSite({
    name: 'Jordan Avery', tagline: 'Designer & illustrator',
    theme: { font: FONTS.humanist, heading: FONTS.serif, bg: '#fbfaf7', fg: '#222222', muted: '#62605b', surface: '#f2efe8', border: '#e1ddd3', accent: '#b4462f', accentFg: '#ffffff', radius: '6px', dark: { bg: '#161513', fg: '#eeeae2', muted: '#aaa59a', surface: '#201f1c', border: '#34322d', accent: '#f08f74', accentFg: '#1a0d08' } },
    css: `.work-card { padding: 0; overflow: hidden; }
.work-card img { border-radius: 0; aspect-ratio: 4 / 3; object-fit: cover; width: 100%; }
.work-card .body { padding: 1rem 1.2rem 1.2rem; }
.portrait { border-radius: 50%; width: min(220px, 60vw); }
.tags { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; padding: 0; }
.tags li { border: 1px solid var(--border); border-radius: 999px; padding: .1rem .7rem; font-size: .85rem; }`,
    pages: [
      { path: 'index.html', title: 'Home', nav: 'Home', desc: 'Portfolio of Jordan Avery, designer and illustrator.', wrap: false, body: `<section class="hero">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Portfolio</p>
      <h1>I design friendly brands, books and interfaces.</h1>
      <p class="lead">Ten years of identity, editorial and product design for small studios, libraries and independent shops.</p>
      <p class="actions"><a class="button" href="work.html">See my work</a> <a class="button ghost" href="contact.html">Hire me</a></p>
    </div>
    <img src="images/hero.svg" alt="" width="800" height="600">
  </div>
</section>
<section class="section wrap">
  <h2>Selected work</h2>
  <div class="grid">
${projects.slice(0, 3).map((t, i) => `    <article class="card work-card"><img src="images/work-${i + 1}.svg" alt="${esc(t)}" width="800" height="600"><div class="body"><h3>${esc(t)}</h3><p class="muted">Identity · 2026</p></div></article>`).join('\n')}
  </div>
</section>` },
      { path: 'work.html', title: 'Work', nav: 'Work', desc: 'Selected projects.', body: `<h1>Work</h1>
<p class="lead">A selection of recent projects. Replace the pictures and descriptions with your own.</p>
<div class="grid">
${projects.map((t, i) => `  <article class="card work-card">
    <img src="images/work-${i + 1}.svg" alt="${esc(t)}" width="800" height="600">
    <div class="body"><h2 class="h3">${esc(t)}</h2><p>A sentence about the brief, your role and the result.</p><ul class="tags"><li>${['Identity', 'Editorial', 'Product', 'Illustration', 'Wayfinding', 'Web'][i]}</li><li>2026</li></ul></div>
  </article>`).join('\n')}
</div>` },
      { path: 'about.html', title: 'About', nav: 'About', body: `<div class="split">
  <img class="portrait" src="images/portrait.svg" alt="Portrait of Jordan Avery" width="200" height="200">
  <div class="prose">
    <h1>About me</h1>
    <p class="lead">I am an independent designer who loves clear typography and hand-drawn details.</p>
    <p>Before going independent I worked in a small studio designing books and exhibitions. Today I help organizations find a voice that feels like them.</p>
    <h2>Services</h2>
    <ul><li>Brand identity and logos</li><li>Editorial and book design</li><li>Illustration</li><li>Websites for small organizations</li></ul>
  </div>
</div>` },
      { path: 'contact.html', title: 'Contact', nav: 'Contact', body: `<h1>Let's work together</h1>
<p class="lead">Tell me about your project. I usually reply within two working days.</p>
<form class="card prose" action="#" method="post">
  <div class="field"><label for="name">Name</label><input id="name" name="name" autocomplete="name" required></div>
  <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
  <div class="field"><label for="budget">Budget</label><select id="budget" name="budget"><option>Not sure yet</option><option>Under $2,000</option><option>$2,000–$10,000</option><option>Over $10,000</option></select></div>
  <div class="field"><label for="msg">Project details</label><textarea id="msg" name="message" rows="6" required></textarea></div>
  <button class="button" type="submit">Send</button>
</form>` },
    ],
  });
  files['images/hero.svg'] = artSvg(2, 'Decorative landscape');
  projects.forEach((t, i) => { files[`images/work-${i + 1}.svg`] = artSvg(i + 3, t); });
  files['images/portrait.svg'] = avatarSvg(1, 'Portrait placeholder');
  return files;
}

// ------------------------------------------------------------------------------------------
// Small business

function businessFiles(): Record<string, string> {
  const services = [['Lawn care', 'Weekly mowing, edging and seasonal cleanups that keep your yard tidy all year.'], ['Garden design', 'Planting plans with native perennials that suit your soil, sun and budget.'], ['Hardscaping', 'Patios, paths and low walls built to last, with drainage done right.'], ['Tree and shrub care', 'Pruning, planting and health checks by trained arborists.']];
  const files = buildSite({
    name: 'Greenway Landscaping', tagline: 'Yards you love to come home to',
    theme: { font: FONTS.sans, bg: '#ffffff', fg: '#1b2a20', muted: '#526157', surface: '#f1f6f1', border: '#d8e3da', accent: '#2e7d32', accentFg: '#ffffff', radius: '12px' },
    css: `.badge { display: inline-block; background: var(--accent); color: var(--accent-fg); border-radius: 999px; padding: .15rem .7rem; font-size: .85rem; font-weight: 600; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 1rem; text-align: center; }
.stats strong { display: block; font-size: 2.2rem; color: var(--accent); }
.icon { width: 2.5rem; height: 2.5rem; color: var(--accent); margin-bottom: .5rem; }`,
    footer: `<p>&copy; 2026 Greenway Landscaping · Licensed and insured</p><p>(555) 010-0144 · <a href="mailto:hello@example.com">hello@example.com</a></p>`,
    pages: [
      { path: 'index.html', title: 'Home', nav: 'Home', desc: 'Lawn care, garden design and hardscaping.', wrap: false, body: `<section class="hero">
  <div class="wrap">
    <span class="badge">Free estimates</span>
    <h1>Beautiful, low-maintenance yards</h1>
    <p class="lead">Family-owned since 2009. We design, build and care for gardens across the county.</p>
    <p class="actions"><a class="button" href="contact.html">Request an estimate</a> <a class="button ghost" href="services.html">Our services</a></p>
  </div>
</section>
<section class="section wrap">
  <h2 class="center">What we do</h2>
  <div class="grid">
${services.map(([t, d]) => `    <article class="card"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C7 7 5 10.5 5 14a7 7 0 0 0 14 0c0-3.5-2-7-7-12Zm0 18a5 5 0 0 1-5-5c0-2.4 1.3-5 5-9.2 3.7 4.2 5 6.8 5 9.2a5 5 0 0 1-5 5Z"/></svg><h3>${t}</h3><p>${d}</p></article>`).join('\n')}
  </div>
</section>
<section class="section alt">
  <div class="wrap stats">
    <p><strong>15+</strong> years in business</p>
    <p><strong>1,200</strong> gardens cared for</p>
    <p><strong>4.9/5</strong> average review</p>
  </div>
</section>
<section class="section wrap center">
  <h2>Ready for a better yard?</h2>
  <p class="lead">Tell us what you have in mind and we will visit within a week.</p>
  <p class="actions" style="justify-content:center"><a class="button" href="contact.html">Get a free estimate</a></p>
</section>` },
      { path: 'services.html', title: 'Services', nav: 'Services', body: `<h1>Services</h1>
<p class="lead">Every job starts with a free visit and a written estimate.</p>
${services.map(([t, d]) => `<section class="card" style="margin-bottom:1rem"><h2>${t}</h2><p>${d}</p><p class="muted">Starting at $— per visit. Replace with your pricing.</p></section>`).join('\n')}` },
      { path: 'about.html', title: 'About', nav: 'About', body: `<div class="prose">
  <h1>About us</h1>
  <p class="lead">Greenway is a team of twelve gardeners, designers and builders who live and work in the community.</p>
  <p>We started with one truck and a mower. Today we care for homes, schools and small businesses, and we still answer the phone ourselves.</p>
  <h2>Our promise</h2>
  <ul><li>On time, every time</li><li>Clear, written estimates</li><li>Native plants and responsible watering</li></ul>
</div>` },
      { path: 'contact.html', title: 'Contact', nav: 'Contact', body: `<h1>Request an estimate</h1>
<div class="split" style="align-items:start">
  <form class="card" action="#" method="post">
    <div class="field"><label for="n">Name</label><input id="n" name="name" autocomplete="name" required></div>
    <div class="field"><label for="p">Phone</label><input id="p" name="phone" type="tel" autocomplete="tel"></div>
    <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required></div>
    <div class="field"><label for="s">Service</label><select id="s" name="service">${services.map(([t]) => `<option>${t}</option>`).join('')}</select></div>
    <div class="field"><label for="m">Tell us about your yard</label><textarea id="m" name="message" rows="5"></textarea></div>
    <button class="button" type="submit">Send request</button>
  </form>
  <div>
    <h2>Office</h2>
    <address>48 Example Road<br>Springfield, ST 00000</address>
    <p>Monday–Friday, 7 a.m.–5 p.m.<br>(555) 010-0144</p>
  </div>
</div>` },
    ],
  });
  return files;
}

// ------------------------------------------------------------------------------------------
// Restaurant

function restaurantFiles(): Record<string, string> {
  const menu: [string, [string, string, string][]][] = [
    ['Small plates', [['Charred carrots', 'Whipped feta, honey, toasted seeds', '9'], ['Tomato toast', 'Sourdough, garlic, basil, olive oil', '8'], ['Crispy potatoes', 'Smoked paprika aioli', '7']]],
    ['Mains', [['Roast chicken', 'Lemon, thyme, pan juices, greens', '22'], ['Mushroom risotto', 'Parmesan, parsley, brown butter', '19'], ['Market fish', 'Ask your server about today\'s catch', '26']]],
    ['Desserts', [['Olive oil cake', 'Citrus, crème fraîche', '9'], ['Chocolate pot', 'Sea salt, shortbread', '8']]],
  ];
  const files = buildSite({
    name: 'Olive & Thyme', tagline: 'Neighborhood kitchen',
    theme: { font: FONTS.sans, heading: FONTS.serif, bg: '#fffaf3', fg: '#2a211b', muted: '#6e6158', surface: '#f6ecdf', border: '#e7d8c6', accent: '#8a3b12', accentFg: '#ffffff', radius: '4px' },
    css: `.menu-section { margin-bottom: 2.5rem; }
.menu-item { display: grid; grid-template-columns: 1fr auto; gap: .2rem 1rem; padding: .8rem 0; border-bottom: 1px dotted var(--border); }
.menu-item h3 { margin: 0; font-size: 1.1rem; }
.menu-item p { margin: 0; color: var(--muted); grid-column: 1; }
.menu-item .price { font-weight: 700; grid-row: 1; grid-column: 2; }
.hours dt { font-weight: 700; } .hours dd { margin: 0 0 .5rem; }
.dish { border-radius: var(--radius); }`,
    footer: `<p>&copy; 2026 Olive &amp; Thyme</p><p>Open Tuesday–Sunday · (555) 010-0170</p>`,
    pages: [
      { path: 'index.html', title: 'Home', nav: 'Home', wrap: false, desc: 'A neighborhood kitchen with seasonal food.', body: `<section class="hero">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Seasonal · Local · Unfussy</p>
      <h1>Good food, made from what's growing now</h1>
      <p class="lead">Dinner Tuesday to Sunday, brunch on weekends, and a short list of natural wines.</p>
      <p class="actions"><a class="button" href="menu.html">See the menu</a> <a class="button ghost" href="visit.html">Hours &amp; location</a></p>
    </div>
    <img class="dish" src="images/dish.svg" alt="" width="800" height="600">
  </div>
</section>
<section class="section wrap grid">
  <div><h2>Reservations</h2><p>Book by phone at (555) 010-0170. We keep half the room for walk-ins.</p></div>
  <div><h2>Private dining</h2><p>Our back room seats eighteen for birthdays, rehearsal dinners and team meals.</p></div>
  <div><h2>Gift cards</h2><p>Available at the host stand in any amount.</p></div>
</section>` },
      { path: 'menu.html', title: 'Menu', nav: 'Menu', desc: 'Our dinner menu.', body: `<h1>Dinner menu</h1>
<p class="lead">The menu changes with the seasons. Tell us about allergies and we will help.</p>
${menu.map(([sec, items]) => `<section class="menu-section" aria-labelledby="m-${sec.split(' ')[0].toLowerCase()}">
  <h2 id="m-${sec.split(' ')[0].toLowerCase()}">${sec}</h2>
${items.map(([n, d, p]) => `  <div class="menu-item"><h3>${n}</h3><span class="price">$${p}</span><p>${d}</p></div>`).join('\n')}
</section>`).join('\n')}
<p class="muted">Prices include service. A 3% kitchen fund supports our staff's health insurance.</p>` },
      { path: 'visit.html', title: 'Visit', nav: 'Visit', body: `<h1>Visit us</h1>
<div class="split" style="align-items:start">
  <div>
    <h2>Hours</h2>
    <dl class="hours"><dt>Tuesday–Thursday</dt><dd>5–10 p.m.</dd><dt>Friday–Saturday</dt><dd>5–11 p.m.</dd><dt>Saturday–Sunday brunch</dt><dd>10 a.m.–2 p.m.</dd><dt>Monday</dt><dd>Closed</dd></dl>
  </div>
  <div>
    <h2>Location</h2>
    <address>210 Example Avenue<br>Springfield, ST 00000</address>
    <p>Street parking and a bike rack out front. The dining room is step-free.</p>
  </div>
</div>` },
    ],
  });
  files['images/dish.svg'] = artSvg(7, 'Decorative picture');
  return files;
}

// ------------------------------------------------------------------------------------------
// Blog

function blogFiles(): Record<string, string> {
  const posts = [
    { path: 'posts/first-light.html', title: 'Chasing first light on the ridge', date: '2026-05-02', label: 'May 2, 2026', summary: 'An early start, a cold thermos and the reward of a sunrise over the valley.' },
    { path: 'posts/sourdough-notes.html', title: 'Notes from a year of sourdough', date: '2026-04-11', label: 'April 11, 2026', summary: 'What changed when I stopped following recipes and started watching the dough.' },
  ];
  const postBody = (p: typeof posts[number], paras: string[]) => `<article class="prose post">
  <p class="byline"><time datetime="${p.date}">${p.label}</time> · 4 minute read</p>
  <h1>${esc(p.title)}</h1>
${paras.map((x) => `  <p>${x}</p>`).join('\n')}
  <h2>What I'd do next time</h2>
  <ul><li>Start ten minutes earlier.</li><li>Bring a second layer.</li><li>Write things down the same day.</li></ul>
  <p><a href="${ln(p.path, 'archive.html')}">← All posts</a></p>
</article>`;
  return buildSite({
    name: 'Field & Kitchen', tagline: 'Notes on walking and baking',
    theme: { font: FONTS.serif, heading: FONTS.sans, bg: '#ffffff', fg: '#23201c', muted: '#6b645a', surface: '#f7f4ef', border: '#e6e0d6', accent: '#1f6f8b', accentFg: '#ffffff', maxw: '48rem', dark: { bg: '#141312', fg: '#ebe7e0', muted: '#aaa398', surface: '#1d1b19', border: '#33302b', accent: '#7cc6e0', accentFg: '#071a21' } },
    css: `.byline { color: var(--muted); font-family: var(--heading-font); font-size: .9rem; }
.post-list { list-style: none; padding: 0; }
.post-list li { padding: 1.25rem 0; border-bottom: 1px solid var(--border); }
.post-list h2 { font-size: 1.4rem; margin-bottom: .25rem; }
.post-list h2 a { color: var(--fg); text-decoration: none; }
.post-list h2 a:hover { color: var(--accent); }
.post p { font-size: 1.12rem; }`,
    pages: [
      { path: 'index.html', title: 'Home', nav: 'Home', desc: 'A blog about walking and baking.', body: `<h1>Latest posts</h1>
<ol class="post-list" reversed>
${posts.map((p) => `  <li><p class="byline"><time datetime="${p.date}">${p.label}</time></p><h2><a href="${ln('index.html', p.path)}">${esc(p.title)}</a></h2><p>${esc(p.summary)}</p></li>`).join('\n')}
</ol>
<p><a href="archive.html">Browse the archive</a></p>` },
      { path: 'archive.html', title: 'Archive', nav: 'Archive', body: `<h1>Archive</h1>
<h2>2026</h2>
<ul>
${posts.map((p) => `  <li><a href="${ln('archive.html', p.path)}">${esc(p.title)}</a> <span class="muted">— <time datetime="${p.date}">${p.label}</time></span></li>`).join('\n')}
</ul>` },
      { path: 'about.html', title: 'About', nav: 'About', body: `<div class="prose"><h1>About this blog</h1><p class="lead">Short essays about long walks and slow bread, written on weekends.</p><p>Replace this with a few sentences about yourself and what readers can expect. Add a new post by copying a page in the <code>posts</code> folder and listing it on the home page and in the archive.</p></div>` },
      { path: posts[0].path, title: posts[0].title, body: postBody(posts[0], ['The alarm went off at 4:40, which is a time I usually only see from the other side. Outside, the street was blue and silent.', 'By the time we reached the ridge the sky had gone from navy to a thin orange line. Nobody spoke for a while.', 'It is easy to forget how much a place changes in the first hour of light. The valley filled with mist, then emptied, like a slow breath.']) },
      { path: posts[1].path, title: posts[1].title, body: postBody(posts[1], ['For the first few months I weighed everything to the gram and still got flat loaves. The problem was never the recipe.', 'Temperature mattered more than anything. A warm kitchen in July and a cold one in January need completely different timings.', 'Now I watch for the dough to rise by about half, feel for bubbles at the edges, and bake when it is ready, not when the timer says so.']) },
    ],
  });
}

// ------------------------------------------------------------------------------------------
// Photo gallery

function photoFiles(): Record<string, string> {
  const shots = ['Morning fog over the lake', 'Red barn in late summer', 'Coastal cliffs at dusk', 'Aspen grove in October', 'Desert road after rain', 'Harbor lights', 'Wildflower meadow', 'First snow on the pass', 'Island ferry crossing'];
  const files = buildSite({
    name: 'Lumen Photography', tagline: 'Landscapes and quiet places',
    theme: { font: FONTS.sans, bg: '#111214', fg: '#ececec', muted: '#a4a6ab', surface: '#191a1d', border: '#2b2d31', accent: '#f2c14e', accentFg: '#1a1406', radius: '4px', maxw: '78rem' },
    css: `.gallery { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); }
.gallery figure { margin: 0; position: relative; overflow: hidden; border-radius: var(--radius); background: var(--surface); }
.gallery a { display: block; color: inherit; text-decoration: none; }
.gallery img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 0; transition: transform .4s ease; }
.gallery a:hover img, .gallery a:focus-visible img { transform: scale(1.04); }
.gallery figcaption { padding: .5rem .75rem; margin: 0; }`,
    pages: [
      { path: 'index.html', title: 'Gallery', nav: 'Gallery', desc: 'Landscape photography portfolio.', body: `<h1 class="visually-hidden">Gallery</h1>
<p class="lead">Selected photographs, 2022–2026. Select a picture to see it full size.</p>
<div class="gallery">
${shots.map((s, i) => `  <figure><a href="images/photo-${i + 1}.svg"><img src="images/photo-${i + 1}.svg" alt="${esc(s)}" width="800" height="600" loading="lazy"></a><figcaption>${esc(s)}</figcaption></figure>`).join('\n')}
</div>` },
      { path: 'about.html', title: 'About', nav: 'About', body: `<div class="prose"><h1>About</h1><p class="lead">I photograph places at the edges of the day, when the light is soft and the roads are empty.</p><p>Prints are available on archival paper in three sizes. For licensing and commissions, write to <a href="mailto:hello@example.com">hello@example.com</a>.</p></div>` },
    ],
  });
  shots.forEach((s, i) => { files[`images/photo-${i + 1}.svg`] = artSvg(i, s); });
  return files;
}

// ------------------------------------------------------------------------------------------
// Event (single page)

function eventFiles(): Record<string, string> {
  const speakers = ['Sam Rivera', 'Priya Nandakumar', 'Lee Okafor'];
  const talks: [string, string, string][] = [['9:00', 'Doors open and coffee', ''], ['9:30', 'Opening keynote: Small sites, big impact', 'Sam Rivera'], ['10:30', 'Accessible forms that people finish', 'Priya Nandakumar'], ['11:30', 'Designing for slow connections', 'Lee Okafor'], ['12:30', 'Lunch', ''], ['1:30', 'Workshops (choose one)', 'Various'], ['4:00', 'Closing panel and community awards', 'All speakers']];
  const files = buildSite({
    name: 'Web Craft Day 2026', tagline: 'June 12 · Springfield Public Library',
    theme: { font: FONTS.sans, bg: '#ffffff', fg: '#16141f', muted: '#5d5970', surface: '#f4f2fb', border: '#dfdbee', accent: '#6b3fd4', accentFg: '#ffffff', radius: '14px' },
    css: `.event-hero { background: radial-gradient(circle at 80% 20%, color-mix(in srgb, var(--accent) 35%, transparent), transparent 55%), linear-gradient(160deg, #1e1442, #3b1f7a); color: #fff; }
.event-hero .lead { color: #ddd6f7; }
.event-hero .button.ghost { color: #fff; border-color: #fff; }
.facts { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; list-style: none; padding: 0; font-weight: 600; }
.schedule th { white-space: nowrap; width: 6rem; }
.speaker img { border-radius: 50%; width: 120px; margin-bottom: .75rem; }`,
    pages: [
      { path: 'index.html', title: 'Web Craft Day', nav: 'Event', desc: 'A one-day conference about building better small web sites.', wrap: false, body: `<section class="hero event-hero">
  <div class="wrap">
    <p class="eyebrow" style="color:#c8b8ff">One day · One track · Forty seats</p>
    <h1>Web Craft Day 2026</h1>
    <p class="lead">Talks and hands-on workshops about building fast, accessible, lovable small web sites.</p>
    <ul class="facts"><li>Friday, June 12</li><li>9 a.m.–5 p.m.</li><li>Springfield Public Library</li></ul>
    <p class="actions"><a class="button" href="#register">Register — $40</a> <a class="button ghost" href="#schedule">Schedule</a></p>
  </div>
</section>
<section class="section wrap" id="schedule" aria-labelledby="sched-h">
  <h2 id="sched-h">Schedule</h2>
  <div class="table-scroll"><table class="schedule"><caption class="visually-hidden">Event schedule</caption><thead><tr><th scope="col">Time</th><th scope="col">Session</th><th scope="col">Speaker</th></tr></thead><tbody>
${talks.map(([t, s, p]) => `    <tr><th scope="row">${t}</th><td>${s}</td><td>${p}</td></tr>`).join('\n')}
  </tbody></table></div>
</section>
<section class="section alt" aria-labelledby="spk-h">
  <div class="wrap">
    <h2 id="spk-h">Speakers</h2>
    <div class="grid">
${speakers.map((n, i) => `      <article class="card speaker center"><img src="images/speaker-${i + 1}.svg" alt="" width="200" height="200" style="margin-inline:auto"><h3>${n}</h3><p class="muted">A one-line bio of the speaker.</p></article>`).join('\n')}
    </div>
  </div>
</section>
<section class="section wrap" id="register" aria-labelledby="reg-h">
  <h2 id="reg-h">Register</h2>
  <form class="card prose" action="#" method="post">
    <div class="field"><label for="rn">Full name</label><input id="rn" name="name" autocomplete="name" required></div>
    <div class="field"><label for="re">Email</label><input id="re" name="email" type="email" autocomplete="email" required></div>
    <div class="field"><label for="rw">Workshop</label><select id="rw" name="workshop"><option>CSS layout clinic</option><option>Writing for the web</option><option>Image optimization</option></select></div>
    <div class="field"><label for="ra">Accessibility needs (optional)</label><textarea id="ra" name="needs" rows="3"></textarea></div>
    <button class="button" type="submit">Reserve my seat</button>
  </form>
</section>
<section class="section alt" aria-labelledby="venue-h"><div class="wrap"><h2 id="venue-h">Venue</h2><address>Springfield Public Library, Community Room<br>100 Example Plaza, Springfield, ST 00000</address><p>Step-free entrance, gender-neutral restrooms, and a quiet room. Parking garage across the street.</p></div></section>` },
    ],
  });
  speakers.forEach((n, i) => { files[`images/speaker-${i + 1}.svg`] = avatarSvg(i + 4, `Portrait placeholder for ${n}`); });
  return files;
}

// ------------------------------------------------------------------------------------------
// Resume

function resumeFiles(): Record<string, string> {
  return buildSite({
    name: 'Morgan Lee', tagline: 'Front-end developer',
    theme: { font: FONTS.sans, bg: '#ffffff', fg: '#1f2328', muted: '#59636e', surface: '#f6f8fa', border: '#d8dee4', accent: '#0b6e4f', accentFg: '#ffffff', maxw: '52rem', radius: '6px' },
    css: `.cv h2 { font-size: 1.1rem; text-transform: uppercase; letter-spacing: .1em; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: .3rem; margin-top: 2rem; }
.job { display: grid; grid-template-columns: 1fr auto; gap: 0 1rem; margin-bottom: 1.25rem; }
.job h3 { margin: 0; font-size: 1.05rem; }
.job .when { color: var(--muted); font-size: .95rem; }
.job ul { grid-column: 1 / -1; margin: .4rem 0 0; }
.skills { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; padding: 0; }
.skills li { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: .15rem .75rem; }
@media print { .cv { font-size: 11pt; } .cv h2 { margin-top: 1rem; } }`,
    pages: [
      { path: 'index.html', title: 'Resume', nav: 'Resume', desc: 'Resume of Morgan Lee, front-end developer.', body: `<article class="cv">
  <h1>Morgan Lee</h1>
  <p class="lead">Front-end developer who builds accessible, fast interfaces for public services and nonprofits.</p>
  <p>Springfield, ST · <a href="mailto:morgan@example.com">morgan@example.com</a> · (555) 010-0123</p>
  <h2>Experience</h2>
  <section class="job"><h3>Senior front-end developer, Example Health Network</h3><span class="when">2022–present</span><ul><li>Led the rebuild of the patient portal; cut page weight by 60%.</li><li>Set up an accessibility review that every release now passes.</li></ul></section>
  <section class="job"><h3>Web developer, City of Springfield</h3><span class="when">2018–2022</span><ul><li>Built the online permit forms used by 40,000 residents a year.</li><li>Mentored three junior developers.</li></ul></section>
  <section class="job"><h3>Freelance web designer</h3><span class="when">2015–2018</span><ul><li>Designed and built sites for twenty small businesses and arts groups.</li></ul></section>
  <h2>Skills</h2>
  <ul class="skills"><li>HTML</li><li>CSS</li><li>JavaScript</li><li>TypeScript</li><li>Accessibility (WCAG 2.2)</li><li>Performance</li><li>Design systems</li></ul>
  <h2>Education</h2>
  <section class="job"><h3>B.A., Graphic Design, Example State University</h3><span class="when">2015</span></section>
</article>` },
    ],
  });
}

// ------------------------------------------------------------------------------------------
// Documentation with a sidebar

function docsFiles(): Record<string, string> {
  const pages = [
    { path: 'index.html', title: 'Overview', h: 'Introduction' },
    { path: 'docs/install.html', title: 'Installation', h: 'Installation' },
    { path: 'docs/usage.html', title: 'Usage', h: 'Using the tool' },
    { path: 'docs/configuration.html', title: 'Configuration', h: 'Configuration' },
    { path: 'docs/faq.html', title: 'FAQ', h: 'Frequently asked questions' },
  ];
  const side = (from: string) => `<nav class="docs-nav" aria-label="Documentation">
  <p class="docs-nav-title">Contents</p>
  <ul>
${pages.map((p) => `    <li><a href="${ln(from, p.path)}"${p.path === from ? ' aria-current="page"' : ''}>${p.title}</a></li>`).join('\n')}
  </ul>
</nav>`;
  const body: Record<string, string> = {
    'index.html': `<p class="lead">Tidy is a small command-line tool that formats and checks HTML files. This documentation explains how to install it, use it and configure it.</p><h2 id="features">Features</h2><ul><li>Formats HTML with consistent indentation.</li><li>Reports unclosed tags and duplicate ids.</li><li>Runs on Windows, macOS and Linux.</li></ul><p>New here? Start with <a href="docs/install.html">Installation</a>.</p>`,
    'docs/install.html': `<p>Download the package for your system, then check that it runs.</p><h2 id="check">Check the installation</h2><pre><code>tidy --version</code></pre><p>You should see a version number. Next, read <a href="usage.html">Usage</a>.</p>`,
    'docs/usage.html': `<p>Run the tool on a file or a folder.</p><pre><code>tidy index.html\ntidy --check site/</code></pre><h2 id="options">Common options</h2><table><caption>Command-line options</caption><thead><tr><th scope="col">Option</th><th scope="col">Meaning</th></tr></thead><tbody><tr><td><code>--check</code></td><td>Report problems without changing files.</td></tr><tr><td><code>--indent 2</code></td><td>Indent with two spaces.</td></tr></tbody></table>`,
    'docs/configuration.html': `<p>Put a <code>tidy.json</code> file in your project folder to set options once.</p><pre><code>{\n  "indent": 2,\n  "wrap": 100\n}</code></pre><p>Options on the command line override the file.</p>`,
    'docs/faq.html': `<details><summary>Does it change my files?</summary><p>Only when you run it without <code>--check</code>.</p></details><details><summary>Can I use it in a build?</summary><p>Yes; it exits with a non-zero status when it finds problems.</p></details>`,
  };
  return buildSite({
    name: 'Tidy Docs', tagline: 'Version 2.0',
    theme: { font: FONTS.sans, bg: '#ffffff', fg: '#1c1e21', muted: '#5f6670', surface: '#f5f7f9', border: '#e1e5ea', accent: '#0062cc', accentFg: '#ffffff', maxw: '76rem', radius: '6px', dark: { bg: '#0f1115', fg: '#e3e6ea', muted: '#9aa3ad', surface: '#171a20', border: '#2a2f38', accent: '#6cb2ff', accentFg: '#051426' } },
    css: `.docs { display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: 2.5rem; align-items: start; }
.docs-nav { position: sticky; top: 1rem; border-right: 1px solid var(--border); padding-right: 1rem; }
.docs-nav-title { font-weight: 700; text-transform: uppercase; font-size: .8rem; letter-spacing: .08em; color: var(--muted); }
.docs-nav ul { list-style: none; padding: 0; margin: 0; }
.docs-nav a { display: block; padding: .3rem .6rem; border-radius: 6px; color: var(--fg); text-decoration: none; }
.docs-nav a[aria-current="page"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-weight: 600; }
.docs-content { min-width: 0; max-width: 75ch; }
details { border: 1px solid var(--border); border-radius: var(--radius); padding: .6rem 1rem; margin-bottom: .75rem; }
summary { cursor: pointer; font-weight: 600; }
@media (max-width: 760px) { .docs { grid-template-columns: 1fr; } .docs-nav { position: static; border-right: 0; border-bottom: 1px solid var(--border); padding: 0 0 1rem; } }`,
    pages: pages.map((p, i) => ({
      path: p.path, title: p.title, nav: i === 0 ? 'Docs' : undefined,
      body: `<div class="docs">
${side(p.path)}
<article class="docs-content">
  <h1>${p.h}</h1>
  ${body[p.path]}
</article>
</div>`,
    })),
  });
}

// ------------------------------------------------------------------------------------------
// Nonprofit

function nonprofitFiles(): Record<string, string> {
  return buildSite({
    name: 'Riverbend Food Share', tagline: 'Neighbors feeding neighbors',
    theme: { font: FONTS.humanist, bg: '#ffffff', fg: '#202124', muted: '#5f6368', surface: '#fff6ea', border: '#f0dfc6', accent: '#c4511a', accentFg: '#ffffff', radius: '16px' },
    css: `.impact { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); text-align: center; }
.impact strong { display: block; font-size: 2.4rem; color: var(--accent); line-height: 1.1; }
.amounts { display: flex; flex-wrap: wrap; gap: .5rem; border: 0; padding: 0; margin: 0 0 1rem; }
.amounts label { font-weight: 600; border: 2px solid var(--border); border-radius: 999px; padding: .4rem 1rem; cursor: pointer; }
.amounts input { width: auto; margin-right: .35rem; }`,
    footer: `<p>&copy; 2026 Riverbend Food Share, a registered 501(c)(3) nonprofit. EIN 00-0000000.</p><p><a href="donate.html">Donate</a> · <a href="volunteer.html">Volunteer</a></p>`,
    pages: [
      { path: 'index.html', title: 'Home', nav: 'Home', wrap: false, desc: 'A community food pantry.', body: `<section class="hero">
  <div class="wrap">
    <h1>No one in our town should go hungry</h1>
    <p class="lead">We collect surplus food from farms and grocers and share it with 900 families every week, no questions asked.</p>
    <p class="actions"><a class="button" href="donate.html">Give today</a> <a class="button ghost" href="volunteer.html">Volunteer</a></p>
  </div>
</section>
<section class="section wrap"><div class="impact"><p><strong>48,000</strong> meals last month</p><p><strong>310</strong> volunteers</p><p><strong>92¢</strong> of each dollar goes to food</p></div></section>
<section class="section alt"><div class="wrap grid">
  <article class="card"><h2 class="h3">Weekly pantry</h2><p>Fresh produce, bread and staples every Tuesday and Saturday.</p><p><a href="programs.html">Programs</a></p></article>
  <article class="card"><h2 class="h3">School backpacks</h2><p>Weekend meals for 250 students during the school year.</p></article>
  <article class="card"><h2 class="h3">Home delivery</h2><p>Volunteers bring groceries to seniors and neighbors who cannot travel.</p></article>
</div></section>` },
      { path: 'programs.html', title: 'Programs', nav: 'Programs', body: `<h1>Programs</h1><div class="prose"><h2>Weekly pantry</h2><p>Open Tuesdays 3–7 p.m. and Saturdays 9 a.m.–noon at 15 Example Street. Bring a bag if you can.</p><h2>School backpacks</h2><p>Counselors at six schools refer students confidentially.</p><h2>Home delivery</h2><p>Call (555) 010-0190 to sign up yourself or a neighbor.</p></div>` },
      { path: 'volunteer.html', title: 'Volunteer', nav: 'Volunteer', body: `<h1>Volunteer with us</h1><p class="lead">Shifts are two to three hours. No experience needed; we train everyone.</p>
<form class="card prose" action="#" method="post">
  <div class="field"><label for="vn">Name</label><input id="vn" name="name" autocomplete="name" required></div>
  <div class="field"><label for="ve">Email</label><input id="ve" name="email" type="email" autocomplete="email" required></div>
  <fieldset class="field" style="border:0;padding:0"><legend><b>I can help with</b></legend>
    <label style="font-weight:400"><input type="checkbox" name="role" value="sorting" style="width:auto"> Sorting food</label>
    <label style="font-weight:400"><input type="checkbox" name="role" value="driving" style="width:auto"> Driving deliveries</label>
    <label style="font-weight:400"><input type="checkbox" name="role" value="events" style="width:auto"> Events and fundraising</label>
  </fieldset>
  <button class="button" type="submit">Sign up</button>
</form>` },
      { path: 'donate.html', title: 'Donate', nav: 'Donate', body: `<h1>Donate</h1><p class="lead">$25 provides about 75 meals. Gifts are tax-deductible as allowed by law.</p>
<form class="card prose" action="#" method="post">
  <fieldset class="amounts"><legend class="visually-hidden">Amount</legend>${['25', '50', '100', '250'].map((a, i) => `<label><input type="radio" name="amount" value="${a}"${i === 1 ? ' checked' : ''}>$${a}</label>`).join('')}</fieldset>
  <div class="field"><label for="other">Other amount ($)</label><input id="other" name="other" inputmode="decimal"></div>
  <p class="hint">Connect this form to your payment provider before publishing.</p>
  <button class="button" type="submit">Continue</button>
</form>` },
    ],
  });
}

// ------------------------------------------------------------------------------------------
// Church / congregation

function churchFiles(): Record<string, string> {
  return buildSite({
    name: 'Grace Hill Community Church', tagline: 'All are welcome',
    theme: { font: FONTS.sans, heading: FONTS.serif, bg: '#fdfcfa', fg: '#24222a', muted: '#625e6b', surface: '#f3f0f7', border: '#e2dcea', accent: '#4b3a8c', accentFg: '#ffffff', radius: '8px' },
    css: `.times { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
.times .card strong { display: block; font-size: 1.6rem; font-family: var(--heading-font); color: var(--accent); }
.events { list-style: none; padding: 0; }
.events li { display: grid; grid-template-columns: 5rem 1fr; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--border); }
.events time { text-align: center; background: var(--surface); border-radius: var(--radius); padding: .4rem; font-weight: 700; line-height: 1.2; }
.events time span { display: block; font-size: 1.6rem; color: var(--accent); }`,
    footer: `<p>&copy; 2026 Grace Hill Community Church · 77 Example Lane, Springfield</p><p>Office: (555) 010-0155</p>`,
    pages: [
      { path: 'index.html', title: 'Home', nav: 'Home', wrap: false, body: `<section class="hero center">
  <div class="wrap">
    <h1>A place to belong</h1>
    <p class="lead">Join us on Sunday mornings for worship, music and coffee afterward. Come as you are.</p>
    <p class="actions" style="justify-content:center"><a class="button" href="services.html">Service times</a> <a class="button ghost" href="events.html">Upcoming events</a></p>
  </div>
</section>
<section class="section wrap"><h2 class="center">This week</h2><div class="times">
  <div class="card center"><strong>9:00 a.m.</strong>Early service (quiet, traditional)</div>
  <div class="card center"><strong>10:30 a.m.</strong>Main service with choir and children's program</div>
  <div class="card center"><strong>Wednesday 7 p.m.</strong>Midweek gathering and study</div>
</div></section>` },
      { path: 'services.html', title: 'Worship', nav: 'Worship', body: `<h1>Worship services</h1><div class="prose"><p class="lead">Our services last about an hour. Children are welcome in every service, and a staffed nursery is available.</p><h2>What to expect</h2><ul><li>Greeters at the main door can show you around.</li><li>Large-print bulletins and hearing assistance are available.</li><li>The sanctuary is step-free; accessible parking is by the side entrance.</li></ul><h2>Watch online</h2><p>Services are streamed live each Sunday at 10:30 a.m.</p></div>` },
      { path: 'events.html', title: 'Events', nav: 'Events', body: `<h1>Upcoming events</h1><ul class="events">
${[['2026-06-06', 'Jun', '6', 'Community garden workday', 'Bring gloves; lunch provided.'], ['2026-06-14', 'Jun', '14', 'Summer picnic', 'After the 10:30 service in the park.'], ['2026-06-21', 'Jun', '21', 'Food drive', 'Drop off canned goods in the lobby all week.']].map(([d, m, n, t, x]) => `  <li><time datetime="${d}">${m}<span>${n}</span></time><div><h2 class="h3">${t}</h2><p>${x}</p></div></li>`).join('\n')}
</ul>` },
      { path: 'giving.html', title: 'Giving', nav: 'Giving', body: `<h1>Giving</h1><div class="prose"><p class="lead">Your generosity supports our ministries, our building and our neighbors in need.</p><h2>Ways to give</h2><ul><li>During any service, in the offering</li><li>By mail to the church office</li><li>Online, once your payment provider is connected below</li></ul><p><a class="button" href="#give">Give online</a></p><p id="give" class="hint">Link this button to your giving provider before publishing.</p></div>` },
    ],
  });
}

// ------------------------------------------------------------------------------------------
// Genealogy / family history

function genealogyFiles(): Record<string, string> {
  const surnames: [string, string, string][] = [['Ashford', '1792–present', 'Yorkshire, England; Ohio'], ['Bellamy', '1810–1934', 'County Cork, Ireland; Pennsylvania'], ['Hartley', '1835–present', 'Lancashire, England; Illinois'], ['Kowalczyk', '1868–present', 'Galicia; Chicago'], ['Moreau', '1802–1911', 'Quebec; Vermont']];
  return buildSite({
    name: 'The Hartley Family History', tagline: 'Five families, two centuries',
    theme: { font: FONTS.serif, heading: FONTS.serif, bg: '#fbf8f1', fg: '#2b2620', muted: '#6a6156', surface: '#f2ece0', border: '#ddd2bf', accent: '#7a4a1e', accentFg: '#ffffff', radius: '4px', maxw: '60rem' },
    css: `.sheet th[scope="row"] { width: 9rem; background: var(--surface); }
.person { border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.25rem; margin-bottom: 1rem; background: var(--bg); }
.person h3 { margin-bottom: .25rem; }
.cite { font-size: .85rem; vertical-align: super; }
.sources li { margin-bottom: .6rem; }
.alpha { display: flex; flex-wrap: wrap; gap: .5rem; list-style: none; padding: 0; font-weight: 700; }`,
    footer: `<p>Compiled by the family, 2026. Corrections and additions are welcome.</p><p>Living people are not shown, to protect their privacy.</p>`,
    pages: [
      { path: 'index.html', title: 'Home', nav: 'Home', desc: 'Family history and genealogy of the Hartley family and related lines.', body: `<h1>Our family history</h1>
<div class="prose">
  <p class="lead">This site gathers what we know about the Hartley family and the families joined to it by marriage, with the records behind each fact.</p>
  <p>Start with the <a href="surnames.html">surname index</a>, or read the family group record for <a href="family-hartley.html">Thomas Hartley and Ellen Bellamy</a>.</p>
  <h2>How to read this site</h2>
  <ul><li>Dates are written as day month year: 14 Mar 1861.</li><li>"abt." means about; "bef." and "aft." mean before and after.</li><li>Numbers like <sup class="cite">[3]</sup> point to the <a href="sources.html">sources</a>.</li></ul>
</div>` },
      { path: 'surnames.html', title: 'Surnames', nav: 'Surnames', body: `<h1>Surname index</h1>
<ul class="alpha" aria-label="Jump to letter"><li>A</li><li>B</li><li><a href="family-hartley.html">H</a></li><li>K</li><li>M</li></ul>
<div class="table-scroll"><table><caption>Family surnames in this history</caption><thead><tr><th scope="col">Surname</th><th scope="col">Years</th><th scope="col">Places</th></tr></thead><tbody>
${surnames.map(([s, y, p]) => `  <tr><th scope="row">${s === 'Hartley' ? `<a href="family-hartley.html">${s}</a>` : s}</th><td>${y}</td><td>${p}</td></tr>`).join('\n')}
</tbody></table></div>` },
      { path: 'family-hartley.html', title: 'Thomas Hartley and Ellen Bellamy', body: `<h1>Family group: Thomas Hartley &amp; Ellen Bellamy</h1>
<div class="table-scroll"><table class="sheet"><caption>Husband</caption><tbody>
  <tr><th scope="row">Name</th><td>Thomas Hartley</td></tr>
  <tr><th scope="row">Born</th><td>14 Mar 1835, Bolton, Lancashire, England <sup class="cite">[1]</sup></td></tr>
  <tr><th scope="row">Died</th><td>2 Nov 1902, Peoria, Illinois <sup class="cite">[3]</sup></td></tr>
  <tr><th scope="row">Parents</th><td>James Hartley and Mary Ashford</td></tr>
</tbody></table></div>
<div class="table-scroll"><table class="sheet"><caption>Wife</caption><tbody>
  <tr><th scope="row">Name</th><td>Ellen Bellamy</td></tr>
  <tr><th scope="row">Born</th><td>abt. 1840, County Cork, Ireland <sup class="cite">[2]</sup></td></tr>
  <tr><th scope="row">Died</th><td>18 Jan 1915, Peoria, Illinois</td></tr>
  <tr><th scope="row">Married</th><td>6 Jun 1859, Philadelphia, Pennsylvania <sup class="cite">[2]</sup></td></tr>
</tbody></table></div>
<h2>Children</h2>
<div class="person"><h3>William Hartley</h3><p>b. 1861, Philadelphia · d. 1938 · m. Anna Kowalczyk</p></div>
<div class="person"><h3>Margaret Hartley</h3><p>b. 1864, Philadelphia · d. 1866</p></div>
<div class="person"><h3>Edward Hartley</h3><p>b. 1869, Peoria · d. 1941 · m. Louise Moreau</p></div>
<h2>Notes</h2>
<p class="prose">Thomas emigrated in 1857 and worked as a machinist. The family moved west in 1867, after the war, following his brother.</p>
<p><a href="sources.html">See the sources</a> · <a href="surnames.html">Back to the surname index</a></p>` },
      { path: 'sources.html', title: 'Sources', nav: 'Sources', body: `<h1>Sources</h1>
<ol class="sources">
  <li>Baptism register, St. Peter's Church, Bolton, 1835. Transcription by a family member.</li>
  <li>Marriage record, Philadelphia County, Pennsylvania, 1859.</li>
  <li>Death certificate, Peoria County, Illinois, 1902.</li>
  <li>U.S. federal census, 1870 and 1880, Peoria, Illinois.</li>
</ol>
<p class="hint">Cite each record so others can find it again: who created it, what it is, where it is kept, and when you consulted it.</p>` },
    ],
  });
}

// ------------------------------------------------------------------------------------------
// One-page landing

function onePageFiles(): Record<string, string> {
  return buildSite({
    name: 'Brightside', tagline: 'Habit tracker',
    theme: { font: FONTS.sans, bg: '#ffffff', fg: '#0f172a', muted: '#475569', surface: '#f1f5f9', border: '#e2e8f0', accent: '#0f766e', accentFg: '#ffffff', radius: '14px', dark: { bg: '#0b1120', fg: '#e2e8f0', muted: '#94a3b8', surface: '#111a2e', border: '#1e293b', accent: '#2dd4bf', accentFg: '#042f2e' } },
    css: `.one-nav { display: flex; flex-wrap: wrap; gap: 1rem; list-style: none; padding: 0; margin: 0; }
.plans { align-items: stretch; }
.plan { display: flex; flex-direction: column; }
.plan .price { font-size: 2.2rem; font-weight: 800; }
.plan ul { flex: 1; }
.plan.featured { border: 2px solid var(--accent); }
.steps { counter-reset: step; list-style: none; padding: 0; }
.steps li { counter-increment: step; position: relative; padding-left: 3rem; margin-bottom: 1.25rem; }
.steps li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 2.1rem; height: 2.1rem; border-radius: 50%; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-weight: 700; }
details { border-bottom: 1px solid var(--border); padding: .75rem 0; }
summary { cursor: pointer; font-weight: 600; }`,
    pages: [
      { path: 'index.html', title: 'Brightside', nav: 'Home', wrap: false, desc: 'A friendly habit tracker.', body: `<nav class="wrap" aria-label="On this page" style="padding-block:.75rem"><ul class="one-nav"><li><a href="#features">Features</a></li><li><a href="#how">How it works</a></li><li><a href="#pricing">Pricing</a></li><li><a href="#faq">FAQ</a></li></ul></nav>
<section class="hero center">
  <div class="wrap">
    <h1>Small steps, every day</h1>
    <p class="lead">Brightside helps you build habits that stick, with gentle reminders and honest progress.</p>
    <p class="actions" style="justify-content:center"><a class="button" href="#pricing">Start free</a> <a class="button ghost" href="#how">See how it works</a></p>
  </div>
</section>
<section class="section wrap" id="features" aria-labelledby="f-h"><h2 id="f-h" class="center">Features</h2><div class="grid">
  <article class="card"><h3>Gentle reminders</h3><p>Nudges at the right time, never nagging.</p></article>
  <article class="card"><h3>Streaks that forgive</h3><p>Miss a day? Your progress bends instead of breaking.</p></article>
  <article class="card"><h3>Private by design</h3><p>Your data stays on your device unless you choose to sync.</p></article>
</div></section>
<section class="section alt" id="how" aria-labelledby="h-h"><div class="wrap"><h2 id="h-h">How it works</h2><ol class="steps"><li><b>Pick one habit.</b> Start small: two minutes is enough.</li><li><b>Check in daily.</b> One tap, any time of day.</li><li><b>Review weekly.</b> See what worked and adjust.</li></ol></div></section>
<section class="section wrap" id="pricing" aria-labelledby="p-h"><h2 id="p-h" class="center">Pricing</h2><div class="grid plans">
  <article class="card plan"><h3>Free</h3><p class="price">$0</p><ul><li>3 habits</li><li>Reminders</li></ul><a class="button ghost" href="#">Get started</a></article>
  <article class="card plan featured"><h3>Plus <span class="muted">(most popular)</span></h3><p class="price">$4<span class="muted" style="font-size:1rem">/month</span></p><ul><li>Unlimited habits</li><li>Sync across devices</li><li>Weekly insights</li></ul><a class="button" href="#">Try Plus free</a></article>
  <article class="card plan"><h3>Family</h3><p class="price">$8<span class="muted" style="font-size:1rem">/month</span></p><ul><li>Up to 5 people</li><li>Shared goals</li></ul><a class="button ghost" href="#">Choose Family</a></article>
</div></section>
<section class="section alt" id="faq" aria-labelledby="q-h"><div class="wrap prose"><h2 id="q-h">FAQ</h2>
  <details><summary>Is there a free trial of Plus?</summary><p>Yes, 30 days, no card required.</p></details>
  <details><summary>Can I export my data?</summary><p>Any time, as a spreadsheet file.</p></details>
  <details><summary>Which devices are supported?</summary><p>Phones, tablets and the web.</p></details>
</div></section>` },
    ],
  });
}

// ------------------------------------------------------------------------------------------

export const SITE_TEMPLATES: TemplateDef[] = [
  { id: 'starter-site', name: 'Starter Site', kind: 'site', category: 'General', description: 'Home, About and Contact pages attached to a page template (Templates/main.dwt) with a shared style sheet', origin: 'Expression Web (Dynamic Web Templates)', swatch: 'linear-gradient(135deg,#2f5bd3,#8fb0ff)', open: 'index.html', files: starterFiles },
  { id: 'personal', name: 'Portfolio', kind: 'site', category: 'Personal', description: 'A personal portfolio: home, work grid, about and contact', origin: 'modern site builders', swatch: 'linear-gradient(135deg,#b4462f,#f2efe8)', open: 'index.html', files: personalFiles },
  { id: 'business', name: 'Small Business', kind: 'site', category: 'Business', description: 'Home, services, about and contact pages for a local business', origin: 'FrontPage (Corporate Presence Wizard), modern site builders', swatch: 'linear-gradient(135deg,#2e7d32,#c8e6c9)', open: 'index.html', files: businessFiles },
  { id: 'restaurant', name: 'Restaurant', kind: 'site', category: 'Business', description: 'A restaurant with a menu page and hours and location', origin: 'modern site builders', swatch: 'linear-gradient(135deg,#8a3b12,#f6ecdf)', open: 'index.html', files: restaurantFiles },
  { id: 'blog', name: 'Blog', kind: 'site', category: 'Personal', description: 'A blog home page, two posts in a posts folder, an archive and an about page', origin: 'Expression Web, blogging tools', swatch: 'linear-gradient(135deg,#1f6f8b,#f7f4ef)', open: 'index.html', files: blogFiles },
  { id: 'photo', name: 'Photo Gallery', kind: 'site', category: 'Personal', description: 'A dark, responsive photo gallery with captions', origin: 'FrontPage (Photo Gallery), Expression Web', swatch: 'linear-gradient(135deg,#111214,#f2c14e)', open: 'index.html', files: photoFiles },
  { id: 'event', name: 'Event', kind: 'site', category: 'Events', description: 'A single-page event site: schedule, speakers, registration form and venue', origin: 'modern site builders', swatch: 'linear-gradient(135deg,#1e1442,#6b3fd4)', open: 'index.html', files: eventFiles },
  { id: 'resume', name: 'Resume', kind: 'site', category: 'Personal', description: 'A one-page resume that also prints well', origin: 'FrontPage (Personal Web), modern site builders', swatch: 'linear-gradient(135deg,#0b6e4f,#f6f8fa)', open: 'index.html', files: resumeFiles },
  { id: 'docs', name: 'Documentation', kind: 'site', category: 'Business', description: 'Documentation pages with a sticky contents sidebar and code samples', origin: 'documentation site generators', swatch: 'linear-gradient(135deg,#0062cc,#e1e5ea)', open: 'index.html', files: docsFiles },
  { id: 'nonprofit', name: 'Nonprofit', kind: 'site', category: 'Community', description: 'A nonprofit: mission, programs, volunteer sign-up and donation pages', origin: 'modern site builders', swatch: 'linear-gradient(135deg,#c4511a,#fff6ea)', open: 'index.html', files: nonprofitFiles },
  { id: 'church', name: 'Congregation', kind: 'site', category: 'Community', description: 'A church or congregation: service times, worship, events and giving', origin: 'modern site builders', swatch: 'linear-gradient(135deg,#4b3a8c,#f3f0f7)', open: 'index.html', files: churchFiles },
  { id: 'genealogy', name: 'Family History', kind: 'site', category: 'Personal', description: 'Genealogy: a surname index, a family group record and cited sources', origin: 'genealogy web publishing', swatch: 'linear-gradient(135deg,#7a4a1e,#f2ece0)', open: 'index.html', files: genealogyFiles },
  { id: 'one-page', name: 'One-Page Landing', kind: 'site', category: 'Business', description: 'A product landing page with features, steps, pricing and FAQ on one page', origin: 'modern site builders', swatch: 'linear-gradient(135deg,#0f766e,#2dd4bf)', open: 'index.html', files: onePageFiles },
];
