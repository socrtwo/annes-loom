import { describe, it, expect } from 'vitest';
import { TEMPLATES, templateById } from '../../src/templates';
import { linksOf } from '../../src/model/site';
import { isPagePath } from '../../src/model/paths';
import { attachedTemplate, pageRegions, templateRegions } from '../../src/site/templates';
import { unbalancedTags } from '../../src/ai/web';

const PAGE = 'new-page.html';
const filesOf = (id: string) => {
  const t = templateById(id)!;
  return Object.fromEntries(Object.entries(t.files()).map(([p, text]) => [p.replace('{page}', PAGE), text]));
};

describe('built-in templates', () => {
  it('have unique ids and the fields the gallery needs', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(t.name && t.description && t.category && t.swatch, t.id).toBeTruthy();
      const files = filesOf(t.id);
      expect(files[t.open.replace('{page}', PAGE)], `${t.id} opens a file it creates`).toBeTypeOf('string');
    }
    for (const id of ['starter-site', 'personal', 'business', 'restaurant', 'blog', 'photo', 'event', 'resume', 'docs', 'nonprofit', 'church', 'genealogy', 'one-page']) expect(templateById(id)?.kind, id).toBe('site');
    for (const id of ['blank', 'two-column', 'three-column', 'sidebar-left', 'sidebar-right', 'header-footer', 'landing', 'article', 'contact', 'faq', 'pricing', 'error-404', 'privacy', 'gallery', 'timeline', 'frames-style', 'classic-centered']) expect(templateById(id)?.kind, id).toBe('page');
  });

  it('write well-formed pages: one html/head/body/main, a title, lang, viewport and balanced tags', () => {
    for (const t of TEMPLATES) {
      for (const [path, text] of Object.entries(filesOf(t.id))) {
        if (!isPagePath(path)) continue;
        const where = `${t.id}: ${path}`;
        expect(text.startsWith('<!DOCTYPE html>'), where).toBe(true);
        for (const tag of ['html', 'head', 'body']) {
          expect((text.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length, `${where} <${tag}>`).toBe(1);
          expect((text.match(new RegExp(`</${tag}>`, 'g')) || []).length, `${where} </${tag}>`).toBe(1);
        }
        if (t.id !== 'blank') expect((text.match(/<main[\s>]/g) || []).length, `${where} <main>`).toBe(1);
        expect(text, where).toMatch(/<html lang="[a-z]{2}/);
        expect(text, where).toMatch(/<title>[^<]+<\/title>/);
        expect(text, where).toMatch(/name="viewport"/);
        expect(unbalancedTags(text), where).toEqual([]);
        // Every picture has alt text; every form control has a label.
        for (const img of text.match(/<img\b[^>]*>/g) || []) expect(img, where).toMatch(/\balt="/);
        for (const m of text.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"/g)) expect(text, `${where} label for ${m[2]}`).toContain(`for="${m[2]}"`);
      }
    }
  });

  it('link only to files inside the template (or the site root from a 404 page)', () => {
    for (const t of TEMPLATES) {
      const files = filesOf(t.id);
      for (const [path, text] of Object.entries(files)) {
        if (!isPagePath(path) && !path.endsWith('.css')) continue;
        for (const [target, ref] of linksOf(text, path)) {
          if (ref === '/' && t.id === 'error-404') continue;
          expect(files[target], `${t.id}: ${path} links to ${ref}`).toBeTypeOf('string');
        }
      }
    }
  });

  it('use no external assets', () => {
    for (const t of TEMPLATES) for (const [path, text] of Object.entries(filesOf(t.id))) {
      expect(text, `${t.id}: ${path}`).not.toMatch(/(src|href)\s*=\s*["'](https?:)?\/\/(?!www\.w3\.org)/);
      expect(text, `${t.id}: ${path}`).not.toMatch(/@import|url\(\s*["']?https?:/);
    }
  });

  it('starter site pages are attached to Templates/main.dwt with doctitle and content regions', () => {
    const files = filesOf('starter-site');
    expect(templateRegions(files['Templates/main.dwt']).map((r) => r.name)).toEqual(['doctitle', 'content']);
    for (const p of ['index.html', 'about.html', 'contact.html']) {
      expect(attachedTemplate(files[p], p), p).toBe('Templates/main.dwt');
      const regions = pageRegions(files[p]);
      expect(regions.map((r) => r.name), p).toEqual(['doctitle', 'content']);
      expect(regions[0].content, p).toMatch(/<title>[^<]+<\/title>/);
      expect(files[p], p).toContain('href="css/site.css"');
      expect(files[p], p).toMatch(/<!-- #BeginTemplate "\/Templates\/main\.dwt" -->/);
    }
    expect(pageRegions(files['index.html']).map((r) => r.content).join('\n')).toContain('Your new web site starts here');
    expect(files['css/site.css']).toContain('--accent');
  });

  it('stays a reasonable size', () => {
    let total = 0;
    for (const t of TEMPLATES) for (const text of Object.values(t.files())) total += text.length;
    expect(total).toBeLessThan(900_000);
  });
});
