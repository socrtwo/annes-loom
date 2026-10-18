import { describe, it, expect } from 'vitest';
import { Site } from '../../src/model/site';
import {
  applyTemplate, detachTemplate, updateAttachedPages, pagesUsing, attachedTemplate, templateRegions, pageRegions,
  dialectOf, pageToTemplate, libraryItemMarkup, updateLibraryItems, makeRegionMarkup,
} from '../../src/site/templates';
import {
  applyTemplateFull, updateTemplatePages, checkTemplateSyntax, renameRegion, removeRegion, stripTemplateMarkup,
  stripPageMarkup, evalExpr, templateParams, instanceParams, setInstanceParams, setTemplateParams,
} from '../../src/commands/template';

const BEGIN_TPL = `<!DOCTYPE html>
<html>
<head>
<!-- #BeginEditable "doctitle" --><title>Template</title><!-- #EndEditable -->
<link rel="stylesheet" href="../css/site.css">
</head>
<body>
<header><img src="../images/logo.png" alt="Logo"></header>
<!-- #BeginEditable "body" --><p>Default body</p><!-- #EndEditable -->
<footer>Footer v1</footer>
</body>
</html>`;

const INST_TPL = BEGIN_TPL
  .replace(/<!-- #BeginEditable "([^"]+)" -->/g, '<!-- TemplateBeginEditable name="$1" -->')
  .replace(/<!-- #EndEditable -->/g, '<!-- TemplateEndEditable -->');

const PAGE = `<!DOCTYPE html>
<html>
<head><title>About us</title></head>
<body>
<h1>About</h1>
<p>Hello <a href="team.html">team</a></p>
</body>
</html>`;

function siteWith(files: Record<string, string>): Site {
  const s = new Site('Test');
  for (const [p, t] of Object.entries(files)) s.write(p, t, { silent: true });
  return s;
}

describe('page templates: both dialects', () => {
  for (const [dialect, tpl] of [['begin', BEGIN_TPL], ['instance', INST_TPL]] as const) {
    describe(dialect, () => {
      it('detects the dialect and the regions', () => {
        expect(dialectOf(tpl)).toBe(dialect);
        expect(templateRegions(tpl).map((r) => r.name)).toEqual(['doctitle', 'body']);
      });

      it('attaches a fresh page: body and title go into regions, links follow the page', () => {
        const site = siteWith({ 'Templates/main.dwt': tpl, 'about/index.html': PAGE });
        const out = applyTemplate(site, 'Templates/main.dwt', PAGE, 'about/index.html');
        expect(attachedTemplate(out, 'about/index.html')).toBe('Templates/main.dwt');
        const regions = pageRegions(out);
        expect(regions.map((r) => r.name)).toEqual(['doctitle', 'body']);
        expect(regions[0].content).toContain('<title>About us</title>');
        expect(regions[1].content).toContain('<h1>About</h1>');
        expect(out).toContain('href="../css/site.css"');
        expect(out).toContain('src="../images/logo.png"');
        expect(out).toContain('Footer v1');
        expect(out).not.toContain('TemplateBeginEditable');
        if (dialect === 'begin') expect(out).toMatch(/<html><!-- #BeginTemplate "\/Templates\/main\.dwt" -->/);
        else expect(out).toMatch(/<!-- InstanceBegin template="\/Templates\/main\.dwt"/);
      });

      it('keeps region content when the template changes (Update Attached Pages)', () => {
        const site = siteWith({ 'Templates/main.dwt': tpl, 'index.html': PAGE, 'other.html': PAGE });
        site.write('index.html', applyTemplate(site, 'Templates/main.dwt', PAGE, 'index.html'));
        expect(pagesUsing(site, 'Templates/main.dwt')).toEqual(['index.html']);
        site.write('Templates/main.dwt', tpl.replace('Footer v1', 'Footer v2'));
        const changed = updateAttachedPages(site, 'Templates/main.dwt');
        expect(changed).toEqual(['index.html']);
        const out = site.read('index.html')!;
        expect(out).toContain('Footer v2');
        expect(out).not.toContain('Footer v1');
        expect(out).toContain('<h1>About</h1>');
        expect(out).toContain('src="images/logo.png"');
        // Applying again changes nothing.
        expect(updateAttachedPages(site, 'Templates/main.dwt')).toEqual([]);
      });

      it('maps regions with other names', () => {
        const site = siteWith({ 'Templates/main.dwt': tpl });
        const old = dialect === 'begin'
          ? '<html><!-- #BeginTemplate "/Templates/old.dwt" --><body><!-- #BeginEditable "content" --><p>Mine</p><!-- #EndEditable --></body><!-- #EndTemplate --></html>'
          : '<html><!-- InstanceBegin template="/Templates/old.dwt" --><body><!-- InstanceBeginEditable name="content" --><p>Mine</p><!-- InstanceEndEditable --></body><!-- InstanceEnd --></html>';
        const out = applyTemplate(site, 'Templates/main.dwt', old, 'index.html', { content: 'body' });
        expect(pageRegions(out).find((r) => r.name === 'body')!.content).toBe('<p>Mine</p>');
        expect(attachedTemplate(out, 'index.html')).toBe('Templates/main.dwt');
      });

      it('detaches a page, keeping its content', () => {
        const site = siteWith({ 'Templates/main.dwt': tpl });
        const out = detachTemplate(applyTemplate(site, 'Templates/main.dwt', PAGE, 'index.html'));
        expect(out).not.toMatch(/BeginEditable|EndEditable|BeginTemplate|InstanceBegin|InstanceEnd|EndTemplate/);
        expect(out).toContain('<h1>About</h1>');
        expect(out).toContain('Footer v1');
      });

      it('turns a page into a template and back', () => {
        const t = pageToTemplate(PAGE, dialect);
        expect(dialectOf(t)).toBe(dialect);
        expect(templateRegions(t).map((r) => r.name)).toEqual(['doctitle', 'body']);
        expect(makeRegionMarkup('x', 'y', dialect)).toBe(dialect === 'begin' ? '<!-- #BeginEditable "x" -->y<!-- #EndEditable -->' : '<!-- TemplateBeginEditable name="x" -->y<!-- TemplateEndEditable -->');
      });
    });
  }
});

describe('library items', () => {
  it('updates instances with links relative to each page', () => {
    const site = siteWith({ 'Library/nav.lbi': '<nav><a href="../index.html">Home</a> <img src="../images/i.png" alt=""></nav>' });
    const page = `<body>${libraryItemMarkup('Library/nav.lbi', 'old')}<p>x</p></body>`;
    const out = updateLibraryItems(site, 'blog/post.html', page);
    expect(out).toContain('<!-- #BeginLibraryItem "/Library/nav.lbi" -->');
    expect(out).toContain('href="../index.html"');
    expect(out).toContain('src="../images/i.png"');
    expect(out).not.toContain('old');
    const top = updateLibraryItems(site, 'index.html', page);
    expect(top).toContain('href="index.html"');
    expect(top).toContain('src="images/i.png"');
    // A missing item is left as it is.
    const missing = `<body>${libraryItemMarkup('Library/gone.lbi', 'keep')}</body>`;
    expect(updateLibraryItems(site, 'index.html', missing)).toBe(missing);
  });

  it('removes library markers with the page markup', () => {
    const page = `<body>${libraryItemMarkup('Library/nav.lbi', '<nav>n</nav>')}</body>`;
    expect(stripPageMarkup(page)).toBe('<body><nav>n</nav></body>');
  });
});

describe('template parameters, optional and repeating regions', () => {
  const TPL = `<html>
<head>
<!-- TemplateParam name="showNews" type="boolean" value="true" -->
<!-- TemplateParam name="theme" type="text" value="light" -->
<!-- TemplateBeginEditable name="doctitle" --><title>T</title><!-- TemplateEndEditable -->
</head>
<body class="@@(theme)@@">
<!-- TemplateBeginIf cond="showNews" --><aside>News</aside><!-- TemplateEndIf -->
<table><tbody>
<!-- TemplateBeginRepeat name="rows" --><tr><td><!-- TemplateBeginEditable name="cell" -->cell<!-- TemplateEndEditable --></td></tr><!-- TemplateEndRepeat -->
</tbody></table>
<!-- TemplateBeginEditable name="body" --><p>Body</p><!-- TemplateEndEditable -->
</body>
</html>`;

  it('evaluates expressions', () => {
    expect(evalExpr('a', { a: 'x' })).toBe('x');
    expect(evalExpr('!a', { a: 'true' })).toBe('false');
    expect(evalExpr("a == 'x'", { a: 'x' })).toBe('true');
    expect(evalExpr("a ? 'yes' : 'no'", { a: 'false' })).toBe('no');
    expect(evalExpr('a && b', { a: 'true', b: 'false' })).toBe('false');
    expect(evalExpr('a || b', { a: 'true', b: 'false' })).toBe('true');
  });

  it('reads and writes parameters', () => {
    expect(templateParams(TPL).map((p) => p.name)).toEqual(['showNews', 'theme']);
    const page = setInstanceParams('<html><head></head><body></body></html>', [{ name: 'theme', type: 'text', value: 'dark "x"' }]);
    expect(instanceParams(page)).toEqual([{ name: 'theme', type: 'text', value: 'dark &quot;x&quot;' }]);
    expect(setTemplateParams(TPL, []).includes('TemplateParam')).toBe(false);
  });

  it('applies defaults, page values, optional regions and keeps repeat entries', () => {
    const site = siteWith({ 'Templates/t.dwt': TPL });
    const first = applyTemplateFull(site, 'Templates/t.dwt', '<html><head><title>P</title></head><body><p>Mine</p></body></html>', 'p.html');
    expect(first).toContain('<body class="light">');
    expect(first).toContain('<aside>News</aside>');
    expect(first).toContain('<!-- InstanceParam name="showNews" type="boolean" value="true" -->');
    expect(first).toContain('<!-- InstanceBeginRepeat name="rows" --><!-- InstanceBeginRepeatEntry -->');
    expect(first).not.toContain('\u0001');
    expect(pageRegions(first).find((r) => r.name === 'body')!.content).toContain('<p>Mine</p>');
    expect(checkTemplateSyntax(first, false)).toEqual([]);

    // The page adds a second repeat entry and turns the news off.
    let page = first.replace(/(<!-- InstanceBeginRepeatEntry -->[\s\S]*?<!-- InstanceEndRepeatEntry -->)/, (m) => m.replace('>cell<', '>one<') + m.replace('>cell<', '>two<'));
    page = setInstanceParams(page, [{ name: 'showNews', type: 'boolean', value: 'false' }, { name: 'theme', type: 'text', value: 'dark' }]);
    const again = applyTemplateFull(site, 'Templates/t.dwt', page, 'p.html');
    expect(again).toContain('<body class="dark">');
    expect(again).not.toContain('<aside>News</aside>');
    expect(again).toContain('>one<');
    expect(again).toContain('>two<');
    expect((again.match(/InstanceBeginRepeatEntry/g) || []).length).toBe(2);
    expect(applyTemplateFull(site, 'Templates/t.dwt', again, 'p.html')).toBe(again);
  });

  it('updates nested templates and their pages', () => {
    const parent = `<html><head></head><body><header>Site v1</header><!-- TemplateBeginEditable name="main" --><p>x</p><!-- TemplateEndEditable --></body></html>`;
    const site = siteWith({ 'Templates/parent.dwt': parent });
    // The nested template is attached to the parent and makes part of "main" editable for its pages.
    let nested = applyTemplateFull(site, 'Templates/parent.dwt', '<html><body><p>x</p></body></html>', 'Templates/child.dwt');
    nested = nested.replace(/(<!-- InstanceBeginEditable name="main" -->)[\s\S]*?(<!-- InstanceEndEditable -->)/, '$1<section>Child fixed</section><!-- TemplateBeginEditable name="inner" -->inner<!-- TemplateEndEditable -->$2');
    site.write('Templates/child.dwt', nested);
    const page = applyTemplateFull(site, 'Templates/child.dwt', '<html><body><p>Page text</p></body></html>', 'page.html');
    site.write('page.html', page);
    expect(attachedTemplate(page, 'page.html')).toBe('Templates/child.dwt');
    expect(page).toContain('Site v1');
    expect(page).toContain('Child fixed');
    expect(pageRegions(page).map((r) => r.name)).toEqual(['inner']);
    expect((page.match(/InstanceBegin template=/g) || []).length).toBe(1);

    site.write('Templates/parent.dwt', parent.replace('Site v1', 'Site v2'));
    const changed = updateTemplatePages(site, 'Templates/parent.dwt');
    expect(changed).toEqual(['Templates/child.dwt', 'page.html']);
    const updated = site.read('page.html')!;
    expect(updated).toContain('Site v2');
    expect(updated).toContain('Child fixed');
    expect(updated).toContain('<p>Page text</p>');
    expect(site.read('Templates/child.dwt')).toContain('TemplateBeginEditable name="inner"');
  });
});

describe('region helpers', () => {
  it('renames and removes regions in templates and pages', () => {
    const renamed = renameRegion(BEGIN_TPL, 'body', 'content');
    expect(templateRegions(renamed).map((r) => r.name)).toEqual(['doctitle', 'content']);
    expect(templateRegions(renameRegion(INST_TPL, 'body', 'main')).map((r) => r.name)).toEqual(['doctitle', 'main']);
    const removed = removeRegion(INST_TPL, 'body');
    expect(templateRegions(removed).map((r) => r.name)).toEqual(['doctitle']);
    expect(removed).toContain('<p>Default body</p>');
  });

  it('strips template markup from a template', () => {
    const t = stripTemplateMarkup('<html><head><!-- TemplateParam name="c" type="text" value="red" --></head><body class="@@(c)@@"><!-- TemplateBeginEditable name="b" -->x<!-- TemplateEndEditable --></body></html>');
    expect(t).toBe('<html><head></head><body class="red">x</body></html>');
  });

  it('finds syntax problems', () => {
    const msgs = (s: string, tpl = true) => checkTemplateSyntax(s, tpl).map((i) => i.message);
    expect(checkTemplateSyntax(BEGIN_TPL, true)).toEqual([]);
    expect(checkTemplateSyntax(INST_TPL, true)).toEqual([]);
    expect(msgs('<!-- #BeginEditable "a" -->x')[0]).toMatch(/never closed/);
    expect(msgs('x<!-- #EndEditable -->')[0]).toMatch(/no matching beginning/);
    expect(msgs('<!-- #BeginEditable "a" --><!-- #BeginEditable "b" --><!-- #EndEditable --><!-- #EndEditable -->')[0]).toMatch(/cannot be nested/);
    expect(msgs('<!-- #BeginEditable "a" --><!-- #EndEditable --><!-- #BeginEditable "a" --><!-- #EndEditable -->')[0]).toMatch(/Two editable regions/);
    expect(msgs('<p>nothing</p>')[0]).toMatch(/no editable regions/);
    expect(msgs('<!-- TemplateBeginIf cond="x" --><!-- TemplateBeginEditable name="a" --><!-- TemplateEndIf --><!-- TemplateEndEditable -->').some((m) => /optional region/.test(m))).toBe(true);
    expect(msgs('<div class="<!-- #BeginEditable "a" -->"><!-- #EndEditable --></div>').some((m) => /inside a tag/.test(m))).toBe(true);
  });
});
