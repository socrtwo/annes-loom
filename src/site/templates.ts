/**
 * Page templates with editable regions (.dwt) and library items (.lbi).
 *
 * Two marker dialects exist in the wild and both are read and written:
 *
 *   "begin" dialect (FrontPage / Expression family)
 *     template:  <!-- #BeginEditable "body" --> … <!-- #EndEditable -->
 *     page:      <html><!-- #BeginTemplate "/Templates/main.dwt" --> … <!-- #EndTemplate --></html>
 *
 *   "instance" dialect (Dreamweaver family)
 *     template:  <!-- TemplateBeginEditable name="body" --> … <!-- TemplateEndEditable -->
 *     page:      <html><!-- InstanceBegin template="/Templates/main.dwt" codeOutsideHTMLIsLocked="false" -->
 *                <!-- InstanceBeginEditable name="body" --> … <!-- InstanceEndEditable --> … <!-- InstanceEnd --></html>
 *
 * Applying a template copies the template's non-editable markup into the page (with its links
 * rewritten relative to the page), keeps the page's content for each editable region it already has,
 * and fills new regions with the template's default content.
 */
import type { Site } from '../model/site';
import { rewriteRefs } from '../model/site';
import { relativeRef, resolveRef } from '../model/paths';

export type Dialect = 'begin' | 'instance';

export interface Region { name: string; content: string; start: number; end: number; innerStart: number; innerEnd: number }

const T_BEGIN = /<!--\s*(?:#BeginEditable\s+"([^"]+)"|TemplateBeginEditable\s+name="([^"]+)")\s*-->/gi;
const T_END = /<!--\s*(?:#EndEditable|TemplateEndEditable)\s*-->/gi;
const I_BEGIN = /<!--\s*(?:#BeginEditable\s+"([^"]+)"|InstanceBeginEditable\s+name="([^"]+)")\s*-->/gi;
const I_END = /<!--\s*(?:#EndEditable|InstanceEndEditable)\s*-->/gi;

function scan(src: string, begin: RegExp, end: RegExp): Region[] {
  const out: Region[] = [];
  begin.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = begin.exec(src))) {
    end.lastIndex = begin.lastIndex;
    const e = end.exec(src);
    if (!e) break;
    out.push({ name: m[1] || m[2], content: src.slice(begin.lastIndex, e.index), start: m.index, end: e.index + e[0].length, innerStart: begin.lastIndex, innerEnd: e.index });
    begin.lastIndex = e.index + e[0].length;
  }
  return out;
}

export function templateRegions(src: string): Region[] { return scan(src, T_BEGIN, T_END); }
export function pageRegions(src: string): Region[] { return scan(src, I_BEGIN, I_END); }

export function dialectOf(templateSrc: string): Dialect {
  return /TemplateBeginEditable/i.test(templateSrc) ? 'instance' : 'begin';
}

/** The template a page is attached to, as a site path, or null. */
export function attachedTemplate(pageSrc: string, pagePath: string): string | null {
  const m = /<!--\s*(?:#BeginTemplate\s+"([^"]+)"|InstanceBegin\s+template="([^"]+)")/i.exec(pageSrc);
  if (!m) return null;
  return resolveRef(pagePath, m[1] || m[2]);
}

export function isTemplatePath(p: string): boolean { return /\.dwt$/i.test(p); }

/** Builds the page for `templatePath` with the page's existing region content (by name, or by `mapping`). */
export function applyTemplate(site: Site, templatePath: string, pageSrc: string, pagePath: string, mapping: Record<string, string> = {}): string {
  const tsrc = site.read(templatePath);
  if (tsrc == null) throw new Error(`Template ${templatePath} is missing.`);
  const dialect = dialectOf(tsrc);
  const existing = new Map(pageRegions(pageSrc).map((r) => [r.name, r.content]));
  // A page that was never attached: its body becomes the main region, its title the doctitle region.
  const fresh = !existing.size;
  const tRegions = templateRegions(tsrc);
  const mainName = tRegions.find((r) => /^(body|content|main|maincontent|page ?content|editregion\d*)$/i.test(r.name))?.name || tRegions.find((r) => !/title|head/i.test(r.name))?.name;
  let freshBody = '', freshTitle = '';
  if (fresh) {
    freshBody = /<body[^>]*>([\s\S]*)<\/body>/i.exec(pageSrc)?.[1] ?? '';
    freshTitle = /<title[^>]*>[\s\S]*?<\/title>/i.exec(pageSrc)?.[0] ?? '';
  }
  // Template links are relative to the template; make them relative to the page.
  const relinked = rewriteRefs(tsrc, templatePath, (target) => relativeRef(pagePath, target));
  let out = '';
  let last = 0;
  for (const r of templateRegions(relinked)) {
    const fromName = Object.entries(mapping).find(([, to]) => to === r.name)?.[0];
    let content = existing.get(fromName || r.name);
    if (content == null && fresh) {
      if (r.name === mainName && freshBody.trim()) content = '\n' + freshBody.trim() + '\n';
      else if (/title/i.test(r.name) && freshTitle) content = '\n' + freshTitle + '\n';
    }
    if (content == null) content = r.content;
    out += relinked.slice(last, r.start) + beginMarker(dialect, r.name) + content + endMarker(dialect);
    last = r.end;
  }
  out += relinked.slice(last);
  const ref = '/' + templatePath;
  if (dialect === 'begin') {
    out = out.replace(/(<html[^>]*>)/i, `$1<!-- #BeginTemplate "${ref}" -->`).replace(/(<\/html\s*>)/i, `<!-- #EndTemplate -->$1`);
  } else {
    out = out.replace(/(<html[^>]*>)/i, `$1<!-- InstanceBegin template="${ref}" codeOutsideHTMLIsLocked="false" -->`).replace(/(<\/html\s*>)/i, `<!-- InstanceEnd -->$1`);
  }
  // Template-only parameters and the "TemplateInfo" comment do not belong in pages.
  return out.replace(/<!--\s*TemplateInfo[^>]*-->\s*/gi, '').replace(/<!--\s*TemplateParam\b[^>]*-->/gi, '');
}

function beginMarker(d: Dialect, name: string): string { return d === 'begin' ? `<!-- #BeginEditable "${name}" -->` : `<!-- InstanceBeginEditable name="${name}" -->`; }
function endMarker(d: Dialect): string { return d === 'begin' ? '<!-- #EndEditable -->' : '<!-- InstanceEndEditable -->'; }

/** Removes the template link and region markers, keeping the content: the page becomes a normal page. */
export function detachTemplate(pageSrc: string): string {
  return pageSrc.replace(/<!--\s*(?:#BeginTemplate\s+"[^"]*"|#EndTemplate|InstanceBegin\s+template="[^"]*"[^>]*|InstanceEnd|#BeginEditable\s+"[^"]*"|#EndEditable|InstanceBeginEditable\s+name="[^"]*"|InstanceEndEditable|InstanceParam\b[^>]*)\s*-->/gi, '');
}

/** Pages attached to a template. */
export function pagesUsing(site: Site, templatePath: string): string[] {
  return site.pages().filter((f) => f.path !== templatePath && attachedTemplate(f.text || '', f.path) === templatePath).map((f) => f.path);
}

/** Re-applies a template to every page attached to it ("Update Attached Pages"). Returns the pages changed. */
export function updateAttachedPages(site: Site, templatePath: string): string[] {
  const changed: string[] = [];
  for (const p of pagesUsing(site, templatePath)) {
    const src = site.read(p)!;
    const out = applyTemplate(site, templatePath, src, p);
    if (out !== src) { site.write(p, out); changed.push(p); }
  }
  // Nested templates: a template attached to this one is itself a template; update its pages too.
  return changed;
}

/** Wraps a selection or the body in a new editable region (in a template). */
export function makeRegionMarkup(name: string, content: string, dialect: Dialect = 'begin'): string {
  return dialect === 'begin' ? `<!-- #BeginEditable "${name}" -->${content}<!-- #EndEditable -->` : `<!-- TemplateBeginEditable name="${name}" -->${content}<!-- TemplateEndEditable -->`;
}

/** Turns a page into a template: title and body become editable regions. */
export function pageToTemplate(src: string, dialect: Dialect = 'begin'): string {
  let s = detachTemplate(src);
  s = s.replace(/(<title[^>]*>[\s\S]*?<\/title>)/i, (m) => makeRegionMarkup('doctitle', m, dialect));
  s = s.replace(/(<body[^>]*>)([\s\S]*)(<\/body>)/i, (m, a, b, c) => `${a}${makeRegionMarkup('body', b, dialect)}${c}`);
  return s;
}

// ------------------------------------------------------------------------------------------
// Library items and includes

const LIB_RE = /<!--\s*#BeginLibraryItem\s+"([^"]+)"\s*-->([\s\S]*?)<!--\s*#EndLibraryItem\s*-->/gi;

export function libraryItemMarkup(itemPath: string, content: string): string {
  return `<!-- #BeginLibraryItem "/${itemPath}" -->${content}<!-- #EndLibraryItem -->`;
}

/** Refreshes every library item instance in a page from the site's .lbi files. */
export function updateLibraryItems(site: Site, pagePath: string, src: string): string {
  return src.replace(LIB_RE, (m, ref: string) => {
    const p = resolveRef(pagePath, ref);
    const lib = p ? site.read(p) : undefined;
    if (lib == null) return m;
    const rel = rewriteRefs(lib, p!, (t) => relativeRef(pagePath, t));
    return `<!-- #BeginLibraryItem "${ref}" -->${rel}<!-- #EndLibraryItem -->`;
  });
}

const SSI_RE = /<!--\s*#include\s+(virtual|file)\s*=\s*"([^"]+)"\s*-->/gi;
const WEBBOT_RE = /<!--\s*webbot\s+bot="Include"[^>]*U-Include="([^"]+)"[^>]*-->[\s\S]*?<!--\s*webbot\s+bot="Include"[^>]*endspan[^>]*-->/gi;

/**
 * Expands server-side includes and include-page components for preview and for publishing to hosts
 * that do not run them. Only <body> content of an included page is used.
 */
export function expandIncludes(site: Site, pagePath: string, src: string, depth = 0): string {
  if (depth > 6) return src;
  const inc = (ref: string, virtual: boolean) => {
    const p = resolveRef(virtual ? '' : pagePath, virtual && !ref.startsWith('/') ? '/' + ref : ref) || resolveRef(pagePath, ref);
    let t = p ? site.read(p) : undefined;
    if (t == null) return `<!-- include not found: ${ref} -->`;
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(t);
    if (body) t = body[1];
    t = rewriteRefs(t, p!, (target) => relativeRef(pagePath, target));
    return expandIncludes(site, pagePath, t, depth + 1);
  };
  return src.replace(SSI_RE, (m, kind, ref) => inc(ref, kind.toLowerCase() === 'virtual')).replace(WEBBOT_RE, (m, ref) => inc(ref, false));
}
