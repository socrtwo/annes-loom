/**
 * Built-in page templates (original work). Each adds one page ("{page}" is replaced with the new page's
 * file name) and, for layouts, a style sheet css/<id>.css. Links inside are in-page anchors, so a new page
 * never points at files the site does not have.
 */
import type { TemplateDef } from './index';
import { baseCss, doc, FONTS, type Theme } from './kit';
import { blankPage } from '../model/html';

const THEME: Theme = {
  font: FONTS.sans, bg: '#ffffff', fg: '#1d2433', muted: '#5a6478', surface: '#f4f6fb', border: '#dde2ec', accent: '#2f5bd3', accentFg: '#ffffff',
  dark: { bg: '#11151d', fg: '#e8ebf2', muted: '#a3abbd', surface: '#1a202b', border: '#2c3445', accent: '#8fb0ff', accentFg: '#0d1424' },
};

const header = (name = 'Site Name') => `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="#main">${name}</a>
    <nav class="site-nav" aria-label="Main">
      <ul>
        <li><a href="#main" aria-current="page">Home</a></li>
        <li><a href="#about">About</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
    </nav>
  </div>
</header>`;

const footer = `<footer class="site-footer" id="contact">
  <div class="wrap">
    <p>&copy; 2026 Site Name</p>
    <p><a href="mailto:hello@example.com">hello@example.com</a></p>
  </div>
</footer>`;

const para = (n: number) => ['Replace this paragraph with your own words. Keep paragraphs short and lead with the most useful point, so visitors scanning on a phone get it at a glance.', 'A second paragraph adds detail: an example, a reason, or the next step you want the reader to take.', 'Use headings to break long pages into sections, and lists for anything people will compare or follow in order.'].slice(0, n).map((p) => `<p>${p}</p>`).join('\n');

interface PageSpec { id: string; name: string; description: string; category: string; swatch: string; origin?: string; title: string; css?: string; body: string; head?: string; bodyClass?: string; noChrome?: boolean }

function pageTemplate(s: PageSpec): TemplateDef {
  return {
    id: s.id, name: s.name, description: s.description, kind: 'page', category: s.category, swatch: s.swatch, origin: s.origin, open: '{page}',
    files: () => {
      const cssPath = `css/${s.id}.css`;
      let html = doc({ title: s.title, css: [cssPath], body: s.noChrome ? s.body : `${header()}\n${s.body.trim()}\n${footer}`, head: s.head });
      if (s.bodyClass) html = html.replace('<body>', `<body class="${s.bodyClass}">`);
      return { '{page}': html, [cssPath]: baseCss(THEME) + (s.css ? `\n/* ${s.name} layout */\n${s.css.trim()}\n` : '') };
    },
  };
}

const sidebarBox = `<h2 class="h3">In this section</h2>
<ul class="side-list">
  <li><a href="#main">Overview</a></li>
  <li><a href="#details">Details</a></li>
  <li><a href="#contact">Contact</a></li>
</ul>
<div class="card"><h3>Quick tip</h3><p>Sidebars hold navigation, related links or a short call to action.</p></div>`;

const sidebarCss = (side: 'left' | 'right') => `.with-sidebar { display: grid; gap: clamp(1.5rem, 4vw, 3rem); grid-template-columns: ${side === 'left' ? '16rem minmax(0, 1fr)' : 'minmax(0, 1fr) 16rem'}; align-items: start; }
.with-sidebar aside { position: sticky; top: 1rem; }
.side-list { list-style: none; padding: 0; }
.side-list a { display: block; padding: .35rem 0; }
@media (max-width: 760px) { .with-sidebar { grid-template-columns: 1fr; } .with-sidebar aside { position: static; order: ${side === 'left' ? 0 : 1}; } }`;

const article = (id: string) => `<article class="prose">
  <h1>Page heading</h1>
  <p class="lead">A one-sentence summary of what this page is about.</p>
  ${para(2)}
  <h2 id="${id}">Details</h2>
  ${para(3)}
</article>`;

export const PAGE_TEMPLATES: TemplateDef[] = [
  { id: 'blank', name: 'Blank Page', description: 'An empty HTML5 page', kind: 'page', category: 'General', open: '{page}', swatch: '#ffffff', origin: 'Expression Web', files: () => ({ '{page}': blankPage({ title: 'Untitled' }) }) },
  pageTemplate({ id: 'header-footer', name: 'Header and Footer', category: 'Layouts', description: 'A header with navigation, a content area and a footer', swatch: 'linear-gradient(#2f5bd3 0 18%,#fff 18% 82%,#dde2ec 82%)', title: 'Page Title', body: `<main id="main" class="wrap page">\n${article('details')}\n</main>` }),
  pageTemplate({ id: 'two-column', name: 'Two Columns', category: 'Layouts', description: 'Two equal columns that stack on phones', swatch: 'linear-gradient(90deg,#dde2ec 0 48%,#fff 48% 52%,#dde2ec 52%)', title: 'Two Columns',
    css: '.cols-2 { display: grid; gap: clamp(1.5rem, 4vw, 3rem); grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); }',
    body: `<main id="main" class="wrap page">\n<h1>Page heading</h1>\n<div class="cols-2">\n  <section><h2>First column</h2>\n${para(2)}</section>\n  <section id="details"><h2>Second column</h2>\n${para(2)}</section>\n</div>\n</main>` }),
  pageTemplate({ id: 'three-column', name: 'Three Columns', category: 'Layouts', description: 'Three columns of cards that wrap on smaller screens', swatch: 'linear-gradient(90deg,#dde2ec 0 31%,#fff 31% 34.5%,#dde2ec 34.5% 65.5%,#fff 65.5% 69%,#dde2ec 69%)', title: 'Three Columns',
    body: `<main id="main" class="wrap page">\n<h1>Page heading</h1>\n<p class="lead">An introduction to the three topics below.</p>\n<div class="grid" style="--min: 15rem">\n${['First', 'Second', 'Third'].map((t) => `  <section class="card"><h2 class="h3">${t} topic</h2>\n${para(1)}</section>`).join('\n')}\n</div>\n</main>` }),
  pageTemplate({ id: 'sidebar-left', name: 'Sidebar Left', category: 'Layouts', description: 'Navigation sidebar on the left, content on the right', swatch: 'linear-gradient(90deg,#c9d3ea 0 26%,#fff 26%)', title: 'Sidebar Left', css: sidebarCss('left'),
    body: `<main id="main" class="wrap page with-sidebar">\n<aside aria-label="Section">\n${sidebarBox}\n</aside>\n${article('details')}\n</main>` }),
  pageTemplate({ id: 'sidebar-right', name: 'Sidebar Right', category: 'Layouts', description: 'Content on the left, a sidebar on the right', swatch: 'linear-gradient(90deg,#fff 74%,#c9d3ea 74%)', title: 'Sidebar Right', css: sidebarCss('right'),
    body: `<main id="main" class="wrap page with-sidebar">\n${article('details')}\n<aside aria-label="Related">\n${sidebarBox}\n</aside>\n</main>` }),
  pageTemplate({ id: 'landing', name: 'Landing Hero', category: 'Marketing', description: 'A big hero with call-to-action buttons, features and a closing call to action', swatch: 'linear-gradient(135deg,#2f5bd3,#a5bdfc)', origin: 'modern site builders', title: 'Product Name – A short promise',
    css: '.hero h1 { max-width: 18ch; }\n.feature-icon { width: 2.75rem; height: 2.75rem; border-radius: 12px; display: grid; place-items: center; background: var(--accent); color: var(--accent-fg); font-weight: 800; margin-bottom: .75rem; }',
    body: `<main id="main">
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">New</p>
    <h1>A clear promise in one short line</h1>
    <p class="lead">One or two sentences that explain who this is for and what it does for them.</p>
    <p class="actions"><a class="button" href="#get-started">Get started</a> <a class="button ghost" href="#about">Learn more</a></p>
  </div>
</section>
<section class="section wrap" id="about" aria-labelledby="feat">
  <h2 id="feat" class="center">Why people choose it</h2>
  <div class="grid">
${['Fast', 'Friendly', 'Flexible'].map((t, i) => `    <article class="card"><div class="feature-icon" aria-hidden="true">${i + 1}</div><h3>${t}</h3><p>Explain this benefit in one or two sentences.</p></article>`).join('\n')}
  </div>
</section>
<section class="section alt center" id="get-started">
  <div class="wrap"><h2>Ready to begin?</h2><p class="lead">Repeat the main call to action at the end of the page.</p><p class="actions" style="justify-content:center"><a class="button" href="#contact">Contact us</a></p></div>
</section>
</main>` }),
  pageTemplate({ id: 'article', name: 'Article', category: 'Content', description: 'A readable article with byline, figure, pull quote and related links', swatch: 'repeating-linear-gradient(#fff 0 10px,#e3e7ef 10px 12px)', title: 'Article Title',
    css: '.article { max-width: 68ch; margin-inline: auto; }\n.article p { font-size: 1.12rem; }\n.byline { color: var(--muted); }\n.pull { font-size: 1.35rem; border: 0; border-top: 3px solid var(--accent); border-bottom: 3px solid var(--accent); padding: 1rem 0; margin: 2rem 0; }\n.figure-ph { aspect-ratio: 16 / 9; border-radius: var(--radius); background: linear-gradient(135deg, #a5bdfc, #2f5bd3); }',
    body: `<main id="main" class="wrap page">
<article class="article">
  <header>
    <p class="eyebrow">Category</p>
    <h1>An article title that says what readers will learn</h1>
    <p class="byline">By Author Name · <time datetime="2026-01-15">January 15, 2026</time> · 5 minute read</p>
  </header>
  ${para(2)}
  <figure><div class="figure-ph" role="img" aria-label="Picture placeholder: replace with a photo"></div><figcaption>A caption that explains the picture.</figcaption></figure>
  <h2 id="details">A section heading</h2>
  ${para(2)}
  <blockquote class="pull"><p>A memorable line from the article, repeated to catch the eye.</p></blockquote>
  ${para(1)}
  <aside aria-label="Related"><h2 class="h3">Related reading</h2><ul><li><a href="#main">Another article</a></li><li><a href="#main">A useful guide</a></li></ul></aside>
</article>
</main>` }),
  pageTemplate({ id: 'contact', name: 'Contact Form', category: 'Forms', description: 'An accessible contact form with labels, hints and contact details', swatch: 'linear-gradient(#fff 0 20%,#dde2ec 20% 30%,#fff 30% 40%,#dde2ec 40% 50%,#fff 50% 60%,#dde2ec 60% 80%,#2f5bd3 80% 90%,#fff 90%)', origin: 'FrontPage (Feedback Form)', title: 'Contact Us',
    css: '.contact-grid { display: grid; gap: clamp(1.5rem, 4vw, 3rem); grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); align-items: start; }\n@media (max-width: 760px) { .contact-grid { grid-template-columns: 1fr; } }\n.req { color: #b3261e; }',
    body: `<main id="main" class="wrap page">
<h1>Contact us</h1>
<p class="lead">Questions, ideas or feedback? Send a message and we will reply within two working days.</p>
<div class="contact-grid">
  <form class="card" action="#" method="post">
    <p class="hint">Fields marked <span class="req" aria-hidden="true">*</span> are required.</p>
    <div class="field"><label for="c-name">Name <span class="req" aria-hidden="true">*</span></label><input id="c-name" name="name" autocomplete="name" required></div>
    <div class="field"><label for="c-email">Email <span class="req" aria-hidden="true">*</span></label><input id="c-email" name="email" type="email" autocomplete="email" required aria-describedby="c-email-hint"><span class="hint" id="c-email-hint">We only use it to reply.</span></div>
    <div class="field"><label for="c-topic">Topic</label><select id="c-topic" name="topic"><option>General question</option><option>Support</option><option>Feedback</option></select></div>
    <div class="field"><label for="c-msg">Message <span class="req" aria-hidden="true">*</span></label><textarea id="c-msg" name="message" rows="6" required></textarea></div>
    <button class="button" type="submit">Send message</button>
    <p class="hint">Connect this form to a form handler or service before publishing.</p>
  </form>
  <aside aria-label="Contact details">
    <h2 class="h3">Other ways to reach us</h2>
    <p><a href="mailto:hello@example.com">hello@example.com</a><br>(555) 010-0100</p>
    <address>123 Example Street<br>Springfield, ST 00000</address>
    <p class="muted">Monday–Friday, 9 a.m.–5 p.m.</p>
  </aside>
</div>
</main>` }),
  pageTemplate({ id: 'faq', name: 'FAQ', category: 'Content', description: 'Frequently asked questions as expandable sections (no script needed)', swatch: 'repeating-linear-gradient(#fff 0 14px,#dde2ec 14px 16px)', title: 'Frequently Asked Questions',
    css: '.faq details { border: 1px solid var(--border); border-radius: var(--radius); padding: .75rem 1rem; margin-bottom: .75rem; background: var(--bg); }\n.faq summary { cursor: pointer; font-weight: 600; }\n.faq details[open] summary { margin-bottom: .5rem; }',
    body: `<main id="main" class="wrap page">
<h1>Frequently asked questions</h1>
<p class="lead">Can't find an answer? <a href="#contact">Contact us</a>.</p>
<div class="faq prose">
${['How do I get started?', 'How much does it cost?', 'Can I change my plan later?', 'How do I cancel?', 'Where can I get help?'].map((q, i) => `  <details${i === 0 ? ' open' : ''}><summary>${q}</summary><p>Write a short, direct answer. Link to a page with more detail if needed.</p></details>`).join('\n')}
</div>
</main>` }),
  pageTemplate({ id: 'pricing', name: 'Pricing', category: 'Marketing', description: 'Three pricing plans with a highlighted recommendation and a comparison table', swatch: 'linear-gradient(90deg,#dde2ec 0 30%,#fff 30% 35%,#2f5bd3 35% 65%,#fff 65% 70%,#dde2ec 70%)', title: 'Pricing',
    css: '.plans { align-items: stretch; }\n.plan { display: flex; flex-direction: column; }\n.plan ul { flex: 1; padding-left: 1.2rem; }\n.plan .price { font-size: 2.4rem; font-weight: 800; margin: .25rem 0 1rem; }\n.plan .price small { font-size: 1rem; font-weight: 400; color: var(--muted); }\n.plan.featured { border: 2px solid var(--accent); box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 18%, transparent); }\n.badge { display: inline-block; background: var(--accent); color: var(--accent-fg); border-radius: 999px; padding: .1rem .7rem; font-size: .8rem; font-weight: 700; }',
    body: `<main id="main" class="wrap page">
<h1 class="center">Simple, fair pricing</h1>
<p class="lead center">Start free. Upgrade when you need more.</p>
<div class="grid plans">
  <section class="card plan" aria-labelledby="p1"><h2 id="p1" class="h3">Starter</h2><p class="price">$0 <small>per month</small></p><ul><li>One project</li><li>Community support</li></ul><a class="button ghost" href="#contact">Start free</a></section>
  <section class="card plan featured" aria-labelledby="p2"><span class="badge">Most popular</span><h2 id="p2" class="h3">Professional</h2><p class="price">$19 <small>per month</small></p><ul><li>Unlimited projects</li><li>Email support</li><li>Custom domain</li></ul><a class="button" href="#contact">Choose Professional</a></section>
  <section class="card plan" aria-labelledby="p3"><h2 id="p3" class="h3">Team</h2><p class="price">$49 <small>per month</small></p><ul><li>Everything in Professional</li><li>Five team members</li><li>Priority support</li></ul><a class="button ghost" href="#contact">Choose Team</a></section>
</div>
<div class="table-scroll section"><table><caption>Compare plans</caption><thead><tr><th scope="col">Feature</th><th scope="col">Starter</th><th scope="col">Professional</th><th scope="col">Team</th></tr></thead><tbody>
  <tr><th scope="row">Projects</th><td>1</td><td>Unlimited</td><td>Unlimited</td></tr>
  <tr><th scope="row">Team members</th><td>1</td><td>1</td><td>5</td></tr>
  <tr><th scope="row">Support</th><td>Community</td><td>Email</td><td>Priority</td></tr>
</tbody></table></div>
</main>` }),
  pageTemplate({ id: 'error-404', name: '404 Page Not Found', category: 'Utility', description: 'A friendly "page not found" page (save it as 404.html)', swatch: 'radial-gradient(circle,#2f5bd3 0 20%,#eef2fb 21%)', title: 'Page Not Found', head: '<meta name="robots" content="noindex">',
    css: '.notfound { min-height: 70vh; display: grid; place-items: center; text-align: center; }\n.notfound .code { font-size: clamp(5rem, 20vw, 10rem); font-weight: 800; line-height: 1; color: var(--accent); margin: 0; }',
    body: `<main id="main" class="wrap notfound">
<div>
  <p class="code" aria-hidden="true">404</p>
  <h1>We couldn't find that page</h1>
  <p class="lead">The address may be mistyped, or the page may have moved.</p>
  <p class="actions" style="justify-content:center"><a class="button" href="/">Go to the home page</a> <a class="button ghost" href="#contact">Report a broken link</a></p>
</div>
</main>` }),
  pageTemplate({ id: 'privacy', name: 'Privacy Policy', category: 'Utility', description: 'A privacy policy outline with the usual sections to fill in (not legal advice)', swatch: 'repeating-linear-gradient(#fff 0 8px,#e6e9f0 8px 9px)', title: 'Privacy Policy',
    css: '.policy { max-width: 70ch; }\n.policy h2 { margin-top: 2rem; }\n.toc { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.25rem; }',
    body: `<main id="main" class="wrap page policy">
<!-- This outline is a starting point, not legal advice. Have the final policy reviewed by a qualified professional. -->
<h1>Privacy policy</h1>
<p class="muted">Effective date: [DATE]</p>
<nav class="toc" aria-label="Contents"><ol>${['What we collect', 'How we use it', 'Cookies and analytics', 'Sharing', 'How long we keep it', 'Your rights', 'Children', 'Changes to this policy', 'Contact us'].map((t, i) => `<li><a href="#s${i + 1}">${t}</a></li>`).join('')}</ol></nav>
${['What we collect', 'How we use it', 'Cookies and analytics', 'Sharing', 'How long we keep it', 'Your rights', 'Children', 'Changes to this policy', 'Contact us'].map((t, i) => `<section id="s${i + 1}"><h2>${t}</h2><p>[Describe ${t.toLowerCase()} in plain language.]</p></section>`).join('\n')}
</main>` }),
  pageTemplate({ id: 'gallery', name: 'Gallery', category: 'Content', description: 'A responsive picture grid with captions', swatch: 'conic-gradient(#a5bdfc 0 25%,#2f5bd3 0 50%,#c9d3ea 0 75%,#6f8fe6 0)', origin: 'FrontPage (Photo Gallery)', title: 'Gallery',
    css: '.gallery { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); }\n.gallery figure { margin: 0; }\n.ph { aspect-ratio: 4 / 3; border-radius: var(--radius); background: linear-gradient(135deg, #a5bdfc, #2f5bd3); }\n.gallery figure:nth-child(3n+2) .ph { background: linear-gradient(135deg, #ffd7a8, #ff9a76); }\n.gallery figure:nth-child(3n) .ph { background: linear-gradient(135deg, #d8f3dc, #52796f); }',
    body: `<main id="main" class="wrap page">
<h1>Gallery</h1>
<p class="lead">Replace each placeholder with a picture: select it and use Insert ▸ Picture. Give every picture alternative text.</p>
<div class="gallery">
${Array.from({ length: 9 }, (_, i) => `  <figure><div class="ph" role="img" aria-label="Picture placeholder ${i + 1}"></div><figcaption>Caption ${i + 1}</figcaption></figure>`).join('\n')}
</div>
</main>` }),
  pageTemplate({ id: 'timeline', name: 'Timeline', category: 'Content', description: 'A vertical timeline of milestones or history', swatch: 'linear-gradient(90deg,#fff 0 18%,#2f5bd3 18% 21%,#fff 21%)', title: 'Our History',
    css: '.timeline { list-style: none; padding: 0; margin: 0; position: relative; max-width: 50rem; }\n.timeline::before { content: ""; position: absolute; left: .55rem; top: .3rem; bottom: .3rem; width: 3px; background: var(--border); }\n.timeline li { position: relative; padding: 0 0 2rem 2.5rem; }\n.timeline li::before { content: ""; position: absolute; left: 0; top: .35rem; width: 1.15rem; height: 1.15rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--bg); }\n.timeline time { font-weight: 800; color: var(--accent); display: block; }',
    body: `<main id="main" class="wrap page">
<h1>Our history</h1>
<p class="lead">Key moments, from the first day to today.</p>
<ol class="timeline">
${[['2008', 'The beginning', 'Founded in a garage with one idea and two friends.'], ['2012', 'First milestone', 'Moved into a real office and hired the first employee.'], ['2017', 'Growing up', 'Opened a second location and launched a new service.'], ['2021', 'Recognition', 'Named a community business of the year.'], ['2026', 'Today', 'Still independent, with a team of twenty-five.']].map(([y, t, d]) => `  <li><time datetime="${y}">${y}</time><h2 class="h3">${t}</h2><p>${d}</p></li>`).join('\n')}
</ol>
</main>` }),
  pageTemplate({ id: 'frames-style', name: 'Fixed Sidebar (Frames Style)', category: 'Classic Layouts', description: 'The classic frames look, a fixed banner and navigation with scrolling content, made with modern CSS (no frames)', swatch: 'linear-gradient(90deg,#1f3c88 0 24%,#fff 24%)', origin: 'FrontPage and Expression Web frames pages', title: 'Fixed Sidebar', noChrome: true, bodyClass: 'frames',
    css: `body.frames { display: grid; grid-template-columns: 15rem minmax(0, 1fr); grid-template-rows: auto 1fr; min-height: 100vh; }
.f-banner { grid-column: 1 / -1; position: sticky; top: 0; z-index: 2; background: #1f3c88; color: #fff; padding: .9rem 1.25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.f-banner a { color: #fff; }
.f-banner .brand { color: #fff; }
.f-nav { position: sticky; top: 3.6rem; align-self: start; height: calc(100vh - 3.6rem); overflow: auto; background: var(--surface); border-right: 1px solid var(--border); padding: 1rem; }
.f-nav ul { list-style: none; padding: 0; margin: 0; }
.f-nav a { display: block; padding: .4rem .6rem; border-radius: 6px; color: var(--fg); text-decoration: none; }
.f-nav a:hover, .f-nav a[aria-current="page"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.f-main { padding: clamp(1.25rem, 4vw, 2.5rem); max-width: 75ch; }
@media (max-width: 760px) { body.frames { display: block; } .f-banner { position: static; } .f-nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); } .f-nav ul { display: flex; flex-wrap: wrap; gap: .25rem; } }`,
    body: `<a class="skip-link" href="#main">Skip to content</a>
<header class="f-banner"><a class="brand" href="#main">Site Name</a><span>A short tagline</span></header>
<nav class="f-nav" aria-label="Main">
  <ul>
    <li><a href="#main" aria-current="page">Home</a></li>
    <li><a href="#chapter-1">Chapter 1</a></li>
    <li><a href="#chapter-2">Chapter 2</a></li>
    <li><a href="#chapter-3">Chapter 3</a></li>
  </ul>
</nav>
<main id="main" class="f-main">
  <h1>Welcome</h1>
  <p class="lead">The banner and navigation stay in place while this content scrolls, like a frames page, but it is one ordinary page that search engines and screen readers handle well.</p>
${[1, 2, 3].map((n) => `  <section id="chapter-${n}"><h2>Chapter ${n}</h2>\n${para(3)}</section>`).join('\n')}
</main>` }),
  pageTemplate({ id: 'classic-centered', name: 'Centered Classic', category: 'Classic Layouts', description: 'The early-2000s centered page with banner, left navigation and footer, rebuilt with CSS grid (no layout tables)', swatch: 'linear-gradient(90deg,#e9e4d8 0 15%,#7a2e2e 15% 30%,#fffdf8 30% 85%,#e9e4d8 85%)', origin: 'FrontPage themes, Expression Web layouts', title: 'Classic Page', noChrome: true, bodyClass: 'classic',
    css: `body.classic { background: #e9e4d8; --font: ${FONTS.serif}; --heading-font: ${FONTS.serif}; }
.c-page { width: min(100% - 1rem, 60rem); margin: 1rem auto; background: #fffdf8; color: #2a2420; border: 1px solid #c9bfa8; box-shadow: 0 2px 12px rgba(0,0,0,.12); display: grid; grid-template-columns: 12rem minmax(0, 1fr); grid-template-areas: "banner banner" "nav main" "foot foot"; }
.c-banner { grid-area: banner; background: linear-gradient(#8f3a3a, #6a2626); color: #fff8e8; padding: 1.5rem; border-bottom: 4px solid #d8b56a; }
.c-banner h1 { margin: 0; font-size: 2rem; }
.c-banner p { margin: 0; color: #f0dcc0; font-style: italic; }
.c-nav { grid-area: nav; background: #f3ecdc; border-right: 1px solid #ddd2b8; padding: 1rem; }
.c-nav ul { list-style: none; padding: 0; margin: 0; }
.c-nav a { display: block; padding: .35rem .5rem; color: #6a2626; font-weight: 700; text-decoration: none; border-bottom: 1px dotted #c9bfa8; }
.c-nav a:hover { background: #fffaf0; text-decoration: underline; }
.c-main { grid-area: main; padding: 1.5rem; }
.c-main h2 { color: #6a2626; border-bottom: 1px solid #ddd2b8; }
.c-foot { grid-area: foot; text-align: center; font-size: .85rem; color: #6b5f50; padding: .75rem; border-top: 1px solid #ddd2b8; background: #f3ecdc; }
@media (max-width: 680px) { .c-page { grid-template-columns: 1fr; grid-template-areas: "banner" "nav" "main" "foot"; } .c-nav { border-right: 0; border-bottom: 1px solid #ddd2b8; } }`,
    body: `<a class="skip-link" href="#main">Skip to content</a>
<div class="c-page">
  <header class="c-banner"><h1>Site Name</h1><p>Established 2001 · Updated weekly</p></header>
  <nav class="c-nav" aria-label="Main"><ul><li><a href="#main">Home</a></li><li><a href="#news">What's New</a></li><li><a href="#links">Favorite Links</a></li><li><a href="#guestbook">Guest Book</a></li></ul></nav>
  <main id="main" class="c-main">
    <h2>Welcome to my home page</h2>
    ${para(2)}
    <h2 id="news">What's new</h2>
    <ul><li><b>June 2026:</b> Added a new photo page.</li><li><b>May 2026:</b> Redesigned the whole site.</li></ul>
    <h2 id="links">Favorite links</h2>
    <p>List the sites you recommend, with a sentence about each.</p>
    <h2 id="guestbook">Guest book</h2>
    <p>Invite visitors to write to you at <a href="mailto:hello@example.com">hello@example.com</a>.</p>
  </main>
  <footer class="c-foot">&copy; 2026 Site Name · Best viewed in any browser, at any size</footer>
</div>` }),
];
