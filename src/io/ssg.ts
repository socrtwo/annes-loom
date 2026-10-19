/**
 * Static exports: a plain static site (templates expanded, template and library markers removed) and
 * projects for the Jekyll and Hugo static site generators (front matter per page, a layout made from the
 * page template, assets copied).
 */
import type { Site } from '../model/site';
import { rewriteRefs } from '../model/site';
import { esc, getTitle } from '../model/html';
import { baseName, dirOf, isPagePath, joinPath, stripExt } from '../model/paths';
import { attachedTemplate, detachTemplate, expandIncludes } from '../site/templates';
import { splitMain, zipFiles } from './common';
import { contentPages, pageTitleOf } from './wxr';

const LIB_MARK = /<!--\s*#(?:Begin|End)LibraryItem(?:\s+"[^"]*")?\s*-->/gi;

export function staticPage(site: Site, p: string): string {
  return detachTemplate(expandIncludes(site, p, site.read(p) || '')).replace(LIB_MARK, '');
}

function assetFiles(site: Site): string[] {
  return site.list((f) => !f.noPublish && !isPagePath(f.path) && !/^(Templates|Library|_[^/]*)\//.test(f.path)).map((f) => f.path);
}

export function exportStaticFiles(site: Site): Map<string, string | Uint8Array> {
  const out = new Map<string, string | Uint8Array>();
  for (const f of site.list((x) => !x.noPublish && !/^(Templates|Library)\//.test(x.path) && !/\.(dwt|lbi)$/i.test(x.path))) {
    out.set(f.path, isPagePath(f.path) ? staticPage(site, f.path) : f.data ?? f.text ?? '');
  }
  return out;
}

export async function exportStatic(site: Site): Promise<Blob> { return zipFiles(exportStaticFiles(site)); }

/** The layout source: the home page's template if it has one, else the home page itself. */
function layoutSource(site: Site): { src: string; path: string } {
  const home = site.homePage;
  const tpl = site.data.templates[home] || attachedTemplate(site.read(home) || '', home);
  if (tpl && site.has(tpl)) return { src: site.read(tpl)!, path: tpl };
  return { src: site.read(home) || '', path: home };
}

const yamlStr = (s: string) => JSON.stringify(s);

function layoutFrom(site: Site, link: (sitePath: string) => string, content: string, title: string): string {
  const { src, path } = layoutSource(site);
  const parts = splitMain(expandIncludes(site, path, src));
  const relinked = (html: string) => rewriteRefs(detachTemplate(html).replace(LIB_MARK, ''), path, (t) => (site.has(t) ? link(t) : null));
  const head = relinked(parts.head).replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  return `<!DOCTYPE html>\n<html lang="en">\n<head>${/<title/i.test(head) ? head : `\n  <title>${title}</title>${head}`}</head>\n${parts.bodyTag}${relinked(parts.before)}\n${content}\n${relinked(parts.after)}</body>\n</html>\n`;
}

export function exportJekyllFiles(site: Site): Map<string, string | Uint8Array> {
  const out = new Map<string, string | Uint8Array>();
  out.set('_config.yml', `title: ${yamlStr(site.name)}\ndescription: ${yamlStr(site.data.meta.description || '')}\nbaseurl: ""\nexclude:\n  - README.md\n`);
  out.set('_layouts/default.html', layoutFrom(site, (t) => `{{ '/${t}' | relative_url }}`, '{{ content }}', '{% if page.title and page.title != site.title %}{{ page.title }} – {% endif %}{{ site.title }}'));
  for (const p of contentPages(site)) {
    const src = staticPage(site, p);
    let content = splitMain(src).content.trim();
    if (/\{\{|\{%/.test(content)) content = `{% raw %}\n${content}\n{% endraw %}`;
    out.set(p.replace(/\.(htm|shtml)$/i, '.html'), `---\nlayout: default\ntitle: ${yamlStr(pageTitleOf(site, p, src))}\n---\n${content}\n`);
  }
  for (const a of assetFiles(site)) { const f = site.get(a)!; out.set(a.startsWith('_') ? a.slice(1) : a, f.data ?? f.text ?? ''); }
  out.set('README.md', `# ${site.name}\n\nA Jekyll site exported from QuillLoom.\n\n    bundle exec jekyll serve\n\nThe layout in _layouts/default.html comes from the site's page template; each page has front matter and its main content.\n`);
  return out;
}

export function exportHugoFiles(site: Site): Map<string, string | Uint8Array> {
  const out = new Map<string, string | Uint8Array>();
  out.set('hugo.toml', `baseURL = "/"\nlanguageCode = "en-us"\ntitle = ${JSON.stringify(site.name)}\nuglyURLs = true\nrelativeURLs = true\ndisableKinds = ["taxonomy", "term", "RSS", "sitemap"]\n\n[params]\ndescription = ${JSON.stringify(site.data.meta.description || '')}\n`);
  out.set('layouts/_default/baseof.html', layoutFrom(site, (t) => `{{ "${t}" | relURL }}`, '{{ block "main" . }}{{ end }}', '{{ if .IsHome }}{{ site.Title }}{{ else }}{{ .Title }} – {{ site.Title }}{{ end }}'));
  const main = '{{ define "main" }}\n{{ .Content }}\n{{ end }}\n';
  out.set('layouts/_default/single.html', main);
  out.set('layouts/_default/list.html', main);
  out.set('layouts/index.html', main);
  for (const p of contentPages(site)) {
    const src = staticPage(site, p);
    const content = splitMain(src).content.trim();
    const base = stripExt(baseName(p));
    const dest = p === site.homePage ? 'content/_index.html' : base === 'index' ? joinPath('content', dirOf(p), '_index.html') : joinPath('content', stripExt(p) + '.html');
    out.set(dest, `---\ntitle: ${yamlStr(pageTitleOf(site, p, src))}\n---\n${content}\n`);
  }
  for (const a of assetFiles(site)) { const f = site.get(a)!; out.set(joinPath('static', a), f.data ?? f.text ?? ''); }
  out.set('README.md', `# ${site.name}\n\nA Hugo site exported from QuillLoom.\n\n    hugo server\n\nlayouts/_default/baseof.html comes from the site's page template; content/ holds each page's main content as HTML with front matter; static/ holds pictures, style sheets and scripts.\n`);
  void esc; void getTitle;
  return out;
}
