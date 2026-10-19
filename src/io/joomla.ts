/**
 * Joomla templates and Drupal themes as static sites.
 *
 * Joomla: templateDetails.xml names the template, its files and module positions; index.php is the page,
 * with <jdoc:include type="head|component|modules|message" …/> placeholders and PHP such as
 * $this->baseurl / $this->template for asset paths. Joomla 4+ templates may list assets in
 * joomla.asset.json (WebAsset manager).
 *
 * Drupal: <name>.info.yml (type: theme, regions, libraries), <name>.libraries.yml (CSS/JS), and Twig
 * templates in templates/ (page.html.twig with {{ page.content }} and {{ page.<region> }}).
 *
 * Both become a page template (Templates/page.dwt) with sample pages, as WordPress themes do.
 */
import { Site } from '../model/site';
import { esc, escAttr } from '../model/html';
import { baseName, dirOf, extOf, joinPath, relativeRef } from '../model/paths';
import { renderPhp, type PhpEnv, type PhpReport, type Evaluator } from './php';
import { assembleThemeSite, keepSource, menuHtml, summarize, textOf, MARK_CONTENT, MARK_TITLE, type ThemeCtx, type ThemeRenderer } from './common';

// ------------------------------------------------------------------------------------------
// Joomla

export function joomlaInfo(xml: string): { name: string; positions: string[]; description: string; version: string; author: string; license: string; client: string } {
  const tag = (t: string) => new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i').exec(xml)?.[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';
  return {
    name: tag('name'),
    positions: [...xml.matchAll(/<position[^>]*>([\s\S]*?)<\/position>/gi)].map((m) => m[1].trim()),
    description: tag('description').replace(/<[^>]+>/g, ''),
    version: tag('version'),
    author: tag('author'),
    license: tag('license'),
    client: /client\s*=\s*["'](\w+)["']/i.exec(xml)?.[1] || 'site',
  };
}

function joomlaAssets(files: Map<string, Uint8Array>): { css: string[]; js: string[] } {
  const css: string[] = [], js: string[] = [];
  const j = files.get('joomla.asset.json');
  if (j) {
    try {
      const data = JSON.parse(textOf(j));
      for (const a of data.assets || []) {
        const uri = String(a.uri || '');
        if (!uri || /^(core|bootstrap|jquery|fontawesome)/.test(a.name) && !files.has(uri)) continue;
        const local = [uri, `css/${uri}`, `js/${uri}`, `media/${uri}`].find((p) => files.has(p)) || (files.has(uri.replace(/\.min\./, '.')) ? uri.replace(/\.min\./, '.') : null);
        if (!local) continue;
        if (a.type === 'style') css.push(local); else if (a.type === 'script') js.push(local);
      }
    } catch { /* ignore */ }
  }
  return { css, js };
}

class JoomlaEnv implements PhpEnv {
  constructor(private ctx: ThemeCtx, private tplName: string, private assets: { css: string[]; js: string[] }) {}
  private get root() { return this.ctx.root; }
  call(name: string, args: string[], ev: Evaluator): string | undefined {
    const v = this.value(name, args, ev);
    if (v !== undefined) return '';
    if (/^(defined|jexec|HTMLHelper::_|JHtml::_|\$wa->|\$doc->)/i.test(name)) return '';
    return undefined;
  }
  value(name: string, args: string[], ev: Evaluator): string | undefined {
    const n = name.toLowerCase();
    if (/^(juri::base|juri::root|uri::base|uri::root)$/.test(n)) return this.root + '/';
    if (/^(jtext::_|text::_|jtext::sprintf|text::sprintf)$/.test(n)) return ev.expr(args[0] || '').replace(/^TPL_\w+?_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    if (/^(factory::getapplication|jfactory::getapplication|factory::getdocument|jfactory::getdocument|factory::getlanguage|jfactory::getlanguage|htmlspecialchars|htmlhelper::_|jhtml::_)$/.test(n)) return '';
    if (n === 'date') return undefined;
    return undefined;
  }
  cond(name: string): boolean | undefined {
    if (/countModules/i.test(name)) return true;
    return undefined;
  }
  variable(expr: string): string | undefined {
    const e = expr.replace(/\s+/g, '');
    if (/^\$this->baseurl$/.test(e)) return this.root;
    if (/^\$this->template$/.test(e)) return this.tplName;
    if (/^\$this->(language)$/.test(e)) return 'en-gb';
    if (/^\$this->direction$/.test(e)) return 'ltr';
    if (/^\$this->countModules\(/.test(e)) return '1';
    if (/^\$this->params->get\(/.test(e)) { const m = /get\(\s*['"](\w+)['"]\s*(?:,\s*['"]([^'"]*)['"])?/.exec(e); return m?.[1] && /sitetitle|sitename|brand/i.test(m[1]) ? esc(this.ctx.siteName) : m?.[2] || ''; }
    if (/^\$(app|this)->(get|getCfg)\(['"]sitename['"]\)/.test(e) || /^\$sitename$/.test(e) || /^\$sitename/.test(e)) return esc(this.ctx.siteName);
    if (/^\$(templatePath|tplPath)$/.test(e)) return this.root;
    if (/^\$(this|app|doc|wa|menu|params|input|user|lang)\b/.test(e)) return '';
    return undefined;
  }
  head(): string {
    return [`<title>${this.ctx.markers ? MARK_TITLE : esc(this.ctx.item.title)} – ${esc(this.ctx.siteName)}</title>`, ...this.assets.css.map((c) => `<link rel="stylesheet" href="${escAttr(this.root + '/' + c)}">`), ...this.assets.js.map((j) => `<script src="${escAttr(this.root + '/' + j)}" defer></script>`)].join('\n');
  }
}

export function joomlaTemplateToSite(name: string, files: Map<string, Uint8Array>): { site: Site; report: string[]; open?: string } {
  const report: string[] = [];
  const info = joomlaInfo(textOf(files.get('templateDetails.xml')));
  const tplName = (info.name || name).toLowerCase().replace(/^tpl_/, '').replace(/\s+/g, '_');
  const siteName = info.name || name;
  const site = new Site(siteName);
  if (!files.has('index.php')) throw new Error('The Joomla template has no index.php.');
  const assets = joomlaAssets(files);
  const php: PhpReport = { dropped: [], assumed: [] };
  const positions = new Set<string>();
  const renderer: ThemeRenderer = {
    has: (k) => k === 'page' || (k === 'index' && files.has('index.php')) || (k === '404' && files.has('error.php')),
    render: (k, ctx) => {
      const env = new JoomlaEnv(ctx, tplName, assets);
      let src = textOf(files.get(k === '404' ? 'error.php' : 'index.php'));
      // jdoc:include placeholders.
      src = src.replace(/<jdoc:include\b([^>]*)\/?>/gi, (m, attrs: string) => {
        const type = /type\s*=\s*["'](\w+)["']/i.exec(attrs)?.[1]?.toLowerCase();
        const pos = /name\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || '';
        switch (type) {
          case 'head': case 'metas': return env.head();
          case 'styles': return assets.css.map((c) => `<link rel="stylesheet" href="${escAttr(ctx.root + '/' + c)}">`).join('\n');
          case 'scripts': return assets.js.map((j) => `<script src="${escAttr(ctx.root + '/' + j)}" defer></script>`).join('\n');
          case 'component': return `<h1>${ctx.markers ? MARK_TITLE : esc(ctx.item.title)}</h1>\n${ctx.markers ? MARK_CONTENT : ctx.item.content}`;
          case 'message': return '';
          case 'modules': case 'module': {
            positions.add(pos);
            if (/menu|nav/i.test(pos)) return menuHtml(ctx.menu, ctx.file, { cls: 'mod-menu nav menu', current: ctx.file });
            if (/breadcrumb/i.test(pos)) return `<nav class="mod-breadcrumbs" aria-label="Breadcrumbs"><a href="${escAttr(relativeRef(ctx.file, 'index.html'))}">Home</a></nav>`;
            if (/search/i.test(pos)) return '<form class="mod-finder" action="#" role="search"><input type="search" name="q" placeholder="Search"></form>';
            if (/footer/i.test(pos)) return `<div class="moduletable"><p>© ${new Date().getFullYear()} ${esc(ctx.siteName)}</p></div>`;
            return `<!-- module position "${esc(pos)}" -->`;
          }
          default: return '';
        }
      });
      if (k === 'page' || k === 'index' || k === '404') {
        const html = renderPhp(src, env, php);
        // $this->baseurl . '/templates/' . $this->template . '/css/x.css' → ./css/x.css
        return html.replace(/(["'(])\s*(\.{1,2}(?:\/\.\.)*)\/+(?:templates|media\/templates\/site)\/[\w-]+\//gi, '$1$2/').replace(/([("'])\/+(?:templates|media\/templates\/site)\/[\w-]+\//g, `$1${ctx.root}/`);
      }
      return '';
    },
  };
  const made = assembleThemeSite(site, renderer, { siteName, tagline: info.description.slice(0, 90), report, blog: false });
  for (const [p, v] of files) if (extOf(p) !== 'php' && !/^(language|html)\//.test(p) && p !== 'templateDetails.xml' && p !== 'joomla.asset.json') site.write(p, v, { silent: true });
  keepSource(site, files);
  report.unshift(`Joomla template "${siteName}"${info.version ? ` ${info.version}` : ''}${info.author ? ` by ${info.author}` : ''}${info.client === 'administrator' ? ' (an administrator template; it styles the back end, not a site)' : ''}.`);
  report.push(`Made ${made.join(', ')}. The component area became the "content" editable region of Templates/page.dwt.`);
  if (positions.size) report.push(`Module positions: ${[...positions].join(', ')}. Menu-like positions show the site menu; others are left as comments.`);
  if (info.license) report.push(`License: ${info.license}.`);
  if (php.dropped.length) report.push(`PHP with no static meaning was left out (kept in _theme-source/): ${summarize(php.dropped)}.`);
  if ([...files.keys()].some((k) => k.startsWith('html/'))) report.push('Template overrides in html/ change how Joomla renders components and modules; they need Joomla and were not used.');
  return { site, report, open: 'index.html' };
}

// ------------------------------------------------------------------------------------------
// Drupal

export function drupalInfo(files: Map<string, Uint8Array>): { file: string; name: string; machine: string; libraries: string[]; regions: Record<string, string>; description: string } | null {
  const file = [...files.keys()].find((k) => /^[^/]+\.info\.yml$/.test(k) && /type:\s*theme/.test(textOf(files.get(k))));
  if (!file) return null;
  const y = textOf(files.get(file));
  const val = (k: string) => new RegExp(`^${k}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm').exec(y)?.[1].trim() || '';
  const block = (k: string) => { const m = new RegExp(`^${k}:\\s*\\n((?:[ \\t]+.*\\n?)*)`, 'm').exec(y); return m ? m[1] : ''; };
  const libraries = block('libraries').split('\n').map((l) => l.replace(/^\s*-\s*/, '').replace(/['"]/g, '').trim()).filter(Boolean);
  const regions: Record<string, string> = {};
  for (const l of block('regions').split('\n')) { const m = /^\s*([\w-]+)\s*:\s*['"]?([^'"]+)['"]?/.exec(l); if (m) regions[m[1]] = m[2].trim(); }
  return { file, name: val('name'), machine: baseName(file).replace(/\.info\.yml$/, ''), libraries, regions, description: val('description') };
}

/** CSS and JS files of the theme's own libraries (<theme>.libraries.yml). */
function drupalLibraries(files: Map<string, Uint8Array>, machine: string, wanted: string[]): { css: string[]; js: string[] } {
  const y = textOf(files.get(`${machine}.libraries.yml`));
  const css: string[] = [], js: string[] = [];
  const own = wanted.filter((w) => w.startsWith(machine + '/')).map((w) => w.slice(machine.length + 1));
  let lib = '';
  let section = '';
  for (const line of y.split('\n')) {
    const top = /^([\w-]+):\s*$/.exec(line);
    if (top) { lib = top[1]; section = ''; continue; }
    const sec = /^\s+(css|js):\s*$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    const f = /^\s+['"]?([^'":\s]+\.(css|js))['"]?\s*:/.exec(line);
    if (f && (own.length === 0 || own.includes(lib)) && !/^(https?:)?\/\//.test(f[1])) {
      const p = f[1].replace(/^\//, '');
      if (files.has(p)) (f[2] === 'css' ? css : js).push(p);
    }
    void section;
  }
  return { css, js };
}

/** A minimal Twig reader: {{ page.content }}, {{ page.<region> }}, {% if %}…{% endif %} (first branch), blocks, includes. */
function renderTwig(src: string, ctx: ThemeCtx, files: Map<string, Uint8Array>, info: { machine: string; regions: Record<string, string> }, dropped: string[], depth = 0): string {
  let s = src.replace(/\{#[\s\S]*?#\}/g, '');
  // Includes of the theme's own templates.
  s = s.replace(/\{%\s*(?:include|embed)\s+['"]([^'"]+)['"][^%]*%\}/g, (m, ref: string) => {
    const name = ref.replace(/^@[\w-]+\//, '').replace(/^.*\//, '');
    const hit = [...files.keys()].find((k) => k.endsWith('/' + name) || k === name);
    return hit && depth < 5 ? renderTwig(textOf(files.get(hit)), ctx, files, info, dropped, depth + 1) : (dropped.push(`include ${ref}`), '');
  });
  // if / else: keep the first branch.
  for (let guard = 0; guard < 200 && /\{%-?\s*if\b/.test(s); guard++) {
    s = s.replace(/\{%-?\s*if\b[^%]*-?%\}((?:(?!\{%-?\s*if\b)[\s\S])*?)\{%-?\s*endif\s*-?%\}/, (m, body: string) => body.split(/\{%-?\s*(?:elseif\b[^%]*|else)\s*-?%\}/)[0]);
  }
  s = s.replace(/\{%-?\s*for\b[^%]*%\}([\s\S]*?)\{%-?\s*endfor\s*-?%\}/g, '$1');
  s = s.replace(/\{%-?\s*(?:block|endblock|set|extends|spaceless|endspaceless|apply|endapply|trans|endtrans|with|endwith)\b[^%]*-?%\}/g, (m) => { if (/extends/.test(m)) dropped.push(m.trim()); return ''; });
  s = s.replace(/\{%[\s\S]*?%\}/g, (m) => { dropped.push(m.replace(/\s+/g, ' ').slice(0, 40)); return ''; });
  s = s.replace(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g, (m, e: string) => {
    const x = e.replace(/\|[\w\s(),'"]+$/, '').trim();
    if (/^page\.content$|^content$/.test(x)) return `<h1>${ctx.markers ? MARK_TITLE : esc(ctx.item.title)}</h1>\n${ctx.markers ? MARK_CONTENT : ctx.item.content}`;
    if (/^(page|page_top|page_bottom)$/.test(x)) return '';
    const region = /^page\.([\w-]+)$/.exec(x)?.[1];
    if (region) {
      if (/menu|nav/i.test(region)) return `<nav class="region region-${region}">${menuHtml(ctx.menu, ctx.file, { cls: 'menu', current: ctx.file })}</nav>`;
      if (/branding|header/i.test(region)) return `<div class="region region-${region}"><a class="site-branding__name" href="${escAttr(relativeRef(ctx.file, 'index.html'))}">${esc(ctx.siteName)}</a></div>`;
      if (/footer/i.test(region)) return `<div class="region region-${region}"><p>© ${new Date().getFullYear()} ${esc(ctx.siteName)}</p></div>`;
      return `<div class="region region-${region}"><!-- region ${esc(info.regions[region] || region)} --></div>`;
    }
    if (/^site_name$/.test(x)) return esc(ctx.siteName);
    if (/^site_slogan$/.test(x)) return esc(ctx.tagline);
    if (/^(head_title|title)/.test(x)) return ctx.markers ? MARK_TITLE : esc(ctx.item.title);
    if (/^(base_path\s*~\s*)?directory$/.test(x) || /^base_path\s*~\s*directory/.test(x)) return ctx.root;
    if (/^base_path$/.test(x)) return ctx.root + '/';
    if (/^front_page$|path\(\s*['"]<front>['"]\s*\)/.test(x)) return relativeRef(ctx.file, 'index.html');
    if (/^(html_)?attributes|attributes\./.test(x)) return '';
    if (/^'([^']*)'\s*\|?\s*t?$/.test(e.trim())) return esc(/^'([^']*)'/.exec(e.trim())![1]);
    if (/^(placeholder_token|head|styles|scripts|scripts_bottom|messages|logo|tabs|action_links|page\.highlighted|page\.help)$/.test(x)) return '';
    dropped.push(`{{ ${x.slice(0, 40)} }}`);
    return '';
  });
  return s;
}

export function drupalThemeToSite(name: string, files: Map<string, Uint8Array>): { site: Site; report: string[]; open?: string } {
  const info = drupalInfo(files);
  if (!info) throw new Error('No Drupal theme (.info.yml with type: theme) was found.');
  const report: string[] = [];
  const siteName = info.name || name;
  const site = new Site(siteName);
  const libs = drupalLibraries(files, info.machine, info.libraries);
  const dropped: string[] = [];
  const tpl = (n: string) => [...files.keys()].find((k) => k.endsWith('/' + n) || k === n);
  const pageTwig = tpl('page.html.twig');
  const htmlTwig = tpl('html.html.twig');
  const renderer: ThemeRenderer = {
    has: (k) => k === 'page' && true,
    render: (k, ctx) => {
      void k;
      const body = pageTwig ? renderTwig(textOf(files.get(pageTwig)), ctx, files, info, dropped) : `<main>${MARK_CONTENT}</main>`;
      const head = [`<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<title>${ctx.markers ? MARK_TITLE : esc(ctx.item.title)} – ${esc(ctx.siteName)}</title>`, ...libs.css.map((c) => `<link rel="stylesheet" href="${escAttr(ctx.root + '/' + c)}">`)].join('\n  ');
      const scripts = libs.js.map((j) => `<script src="${escAttr(ctx.root + '/' + j)}"></script>`).join('\n');
      if (htmlTwig) {
        let h = textOf(files.get(htmlTwig));
        h = h.replace(/\{\{\s*page\s*\}\}/, '\u0003PAGE\u0003').replace(/<head-placeholder[^>]*>|<css-placeholder[^>]*>|<js-placeholder[^>]*>|<js-bottom-placeholder[^>]*>/gi, '');
        h = renderTwig(h, ctx, files, info, dropped).replace(/<title>[\s\S]*?<\/title>/i, '');
        h = h.replace(/<\/head>/i, `  ${head}\n</head>`).replace(/<\/body>/i, `${scripts}\n</body>`);
        return h.replace('\u0003PAGE\u0003', body);
      }
      return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  ${head}\n</head>\n<body>\n${body}\n${scripts}\n</body>\n</html>\n`;
    },
  };
  const made = assembleThemeSite(site, renderer, { siteName, tagline: info.description.slice(0, 90), report, blog: false });
  for (const [p, v] of files) if (!/\.(twig|yml|theme|php|inc)$/.test(p)) site.write(p, v, { silent: true });
  keepSource(site, files);
  report.unshift(`Drupal theme "${siteName}" (${info.machine}).`);
  report.push(`Made ${made.join(', ')} from ${pageTwig || 'a plain layout (no page.html.twig)'}${htmlTwig ? ' and html.html.twig' : ''}. Regions: ${Object.keys(info.regions).join(', ') || 'default'}.`);
  if (libs.css.length) report.push(`Style sheets from ${info.machine}.libraries.yml: ${libs.css.join(', ')}.`);
  if (info.libraries.some((l) => !l.startsWith(info.machine + '/'))) report.push(`Libraries from Drupal core or other modules are not included: ${info.libraries.filter((l) => !l.startsWith(info.machine + '/')).join(', ')}.`);
  if (dropped.length) report.push(`Twig that needs Drupal was left out: ${summarize(dropped)}.`);
  void dirOf; void joinPath;
  return { site, report, open: 'index.html' };
}
