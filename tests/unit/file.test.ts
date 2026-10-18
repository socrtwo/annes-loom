import { describe, it, expect } from 'vitest';
import {
  sniffKind, fileNameFor, detectDelimiter, parseDelimited, rowsToTable, rowsToCsv, toAsciiEntities, parseStyleDecl, styleDeclToString,
  setCssRuleProp, tagAttr, regionsToXml, xmlToRegions, searchSite, codePrintHtml, pageSetupCss, emulatePrintCss, localPathForUrl,
  markOnDisk, changedPaths, dependenciesOf, DEFAULT_PAGE_SETUP,
} from '../../src/commands/file';
import '../../src/commands/window';
import '../../src/commands/help';
import { parseMacroText, macroText } from '../../src/commands/dev';
import { menuPaths, ribbonPaths, HTML_REF, CSS_REF } from '../../src/commands/help';
import { getCommand, allCommands } from '../../src/commands/registry';
import { classicIds } from '../../src/ui/classicMenus';
import { idsInTabs } from '../../src/ui/ribbonLayout';
import { DEFAULT_QAT, QAT_CHOICES } from '../../src/prefs';
import { Site } from '../../src/model/site';

const enc = (s: string) => new TextEncoder().encode(s);
const OTHER_AGENT = new Set(['file.importTemplate', 'file.templateSources', 'file.importMhtml', 'file.exportMhtml', 'file.importWord', 'file.importMarkdown', 'file.importPsd']);

describe('file, window, help and dev commands', () => {
  it('registers every file./window./help./dev. id the menus, ribbon and Quick Access Bar name', () => {
    const want = new Set([...classicIds(), ...idsInTabs(), ...DEFAULT_QAT, ...QAT_CHOICES]);
    const mine = [...want].filter((id) => /^(file|window|help|dev)\./.test(id) && !OTHER_AGENT.has(id));
    expect(mine.filter((id) => !getCommand(id))).toEqual([]);
  });
  it('has no duplicate labels inside one group', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const c of allCommands().filter((x) => /^(file|window|help|dev)\./.test(x.id))) {
      const k = `${c.tab}/${c.group}/${c.label}`;
      if (seen.has(k)) dups.push(`${seen.get(k)} & ${c.id}`); else seen.set(k, c.id);
    }
    expect(dups).toEqual([]);
  });
  it('registers the ids the shell, backstage and entry point run', () => {
    for (const id of ['file.openDropped', 'file.recoverUnsaved', 'file.newDwtFile', 'file.newFromMyTemplate', 'file.saveAsMyTemplate', 'file.saveSiteToFolder', 'file.openUrl', 'file.customizeQat', 'file.customizeRibbon', 'file.customizeKeyboard', 'file.options', 'file.exportFile', 'dev.runMacro']) expect(getCommand(id), id).toBeTruthy();
  });
});

describe('sniffKind', () => {
  it('recognizes containers by their bytes, whatever the name', () => {
    expect(sniffKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'site.dat')).toBe('zip');
    expect(sniffKind(enc('{"format":"quillloom-site","version":1,"files":[]}'), 'x.json')).toBe('qlsite');
    expect(sniffKind(enc('<?xml version="1.0"?>\n<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">'), 'export.xml')).toBe('wxr');
    expect(sniffKind(enc('From: <Saved by Blink>\nMIME-Version: 1.0\nContent-Type: multipart/related; boundary="x"\n'), 'page.txt')).toBe('mhtml');
    expect(sniffKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'pic')).toBe('image');
    expect(sniffKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'pic.bin')).toBe('image');
    expect(sniffKind(new Uint8Array([1, 2, 0, 4, 5]), 'data')).toBe('binary');
  });
  it('trusts known text extensions and sniffs text without one', () => {
    expect(sniffKind(enc('<html><body>x</body></html>'), 'a.php')).toBe('php');
    expect(sniffKind(enc('body { color: red; }'), 'a.css')).toBe('css');
    expect(sniffKind(enc('<!DOCTYPE html><html><head></head></html>'), 'download')).toBe('page');
    expect(sniffKind(enc('<?php echo 1; ?>'), 'script')).toBe('php');
    expect(sniffKind(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'icon')).toBe('svg');
    expect(sniffKind(enc('.nav a { color: red; }\n'), 'styles')).toBe('css');
    expect(sniffKind(enc('const x = () => 1;\n'), 'app')).toBe('js');
    expect(sniffKind(enc('{"a": 1}'), 'data')).toBe('json');
    expect(sniffKind(enc('Just some words.'), 'notes')).toBe('text');
  });
  it('names files by content when they have no extension', () => {
    expect(fileNameFor('download', 'page')).toBe('download.html');
    expect(fileNameFor('C:\\dir\\style', 'css')).toBe('style.css');
    expect(fileNameFor('about.htm', 'page')).toBe('about.htm');
    expect(fileNameFor('photo', 'image')).toBe('photo');
  });
});

describe('tabular data', () => {
  it('detects separators and parses quoted fields', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b\n1;2')).toBe(';');
    expect(parseDelimited('name,note\n"Smith, J","said ""hi""\nthen left"\n\nx,y\n')).toEqual([['name', 'note'], ['Smith, J', 'said "hi"\nthen left'], ['x', 'y']]);
  });
  it('builds tables and CSV', () => {
    const t = rowsToTable([['A', 'B'], ['1', '<2>'], ['3']], { header: true, className: 'data' });
    expect(t).toContain('<table class="data">');
    expect(t).toContain('<th>A</th><th>B</th>');
    expect(t).toContain('<td>1</td><td>&lt;2&gt;</td>');
    expect(t).toContain('<td>3</td><td></td>');
    expect(rowsToCsv([['a', 'b,c'], ['"q"', '']])).toBe('a,"b,c"\r\n"""q""",\r\n');
  });
});

describe('source helpers', () => {
  it('writes non-ASCII as character references outside scripts', () => {
    const r = toAsciiEntities('<p>café 😀</p><script>var s="é";</script>');
    expect(r.text).toBe('<p>caf&#233; &#128512;</p><script>var s="é";</script>');
    expect(r.skipped).toBe(1);
  });
  it('edits style declarations and rules', () => {
    const m = parseStyleDecl('color: red; background: url(a;b.png); MARGIN:0');
    expect([...m.keys()]).toEqual(['color', 'background', 'margin']);
    expect(styleDeclToString(m)).toBe('color: red; background: url(a;b.png); margin: 0');
    let css = '\n    body { margin: 0; }\n';
    css = setCssRuleProp(css, 'a:link', 'color', '#00f');
    expect(css).toContain('a:link { color: #00f; }');
    css = setCssRuleProp(css, 'a:link', 'color', '#f00');
    expect(css).toContain('a:link { color: #f00; }');
    css = setCssRuleProp(css, 'a:link', 'color', null);
    expect(css).not.toContain('a:link');
    expect(css).toContain('body { margin: 0; }');
  });
  it('reads tag attributes', () => {
    expect(tagAttr('<body bgcolor="#fff" text=black style=\'x\'>', 'text')).toBe('black');
    expect(tagAttr('<body bgcolor="#fff">', 'bgcolor')).toBe('#fff');
    expect(tagAttr('<body>', 'link')).toBeNull();
  });
  it('round-trips template data XML', () => {
    const xml = regionsToXml('/Templates/main.dwt', [{ name: 'body', content: '<p>a ]]> b</p>' }, { name: 'doctitle', content: '<title>T</title>' }]);
    const back = xmlToRegions(xml);
    expect(back.template).toBe('/Templates/main.dwt');
    expect(back.items).toEqual([{ name: 'body', content: '<p>a ]]> b</p>' }, { name: 'doctitle', content: '<title>T</title>' }]);
  });
});

describe('site helpers', () => {
  const site = new Site('T');
  site.write('index.html', '<html><head><link rel="stylesheet" href="css/a.css"></head><body><img src="img/x.png"><a href="about.html">About</a> Hello World</body></html>', { silent: true });
  site.write('about.html', '<p>hello again</p>', { silent: true });
  site.write('css/a.css', 'body{background:url(../img/bg.png)}', { silent: true });
  site.write('img/x.png', new Uint8Array([1]), { silent: true });
  site.write('img/bg.png', new Uint8Array([2]), { silent: true });
  it('searches names and contents', () => {
    const hits = searchSite(site, 'hello');
    expect(hits.map((x) => x.path)).toEqual(['about.html', 'index.html']);
    expect(searchSite(site, 'Hello', { matchCase: true }).map((x) => x.path)).toEqual(['index.html']);
    expect(searchSite(site, 'css', { content: false }).map((x) => x.path)).toEqual(['css/a.css']);
    expect(() => searchSite(site, '(', { regex: true })).toThrow();
  });
  it('collects the files a page needs, through style sheets', () => {
    expect(dependenciesOf(site, ['index.html']).sort()).toEqual(['css/a.css', 'img/bg.png', 'img/x.png', 'index.html']);
  });
  it('tracks files changed since they were written to the folder', () => {
    markOnDisk(site);
    expect(changedPaths(site)).toEqual([]);
    site.write('about.html', '<p>changed</p>', { silent: true });
    site.write('new.html', '<p>new</p>', { silent: true });
    expect(changedPaths(site).sort()).toEqual(['about.html', 'new.html']);
    markOnDisk(site, ['about.html']);
    expect(changedPaths(site)).toEqual(['new.html']);
  });
});

describe('printing and preview helpers', () => {
  it('prints code with line numbers, escaped', () => {
    const html = codePrintHtml('<a>\nb', 'x.html');
    expect(html).toContain('<span class="n">1</span>&lt;a&gt;');
    expect(html).toContain('<span class="n">2</span>b');
  });
  it('writes page setup rules', () => {
    expect(pageSetupCss(DEFAULT_PAGE_SETUP)).toBe('@page { size: auto; margin: 0.75in; }');
    const css = pageSetupCss({ ...DEFAULT_PAGE_SETUP, paper: 'a4', orientation: 'landscape', backgrounds: true, linkUrls: true });
    expect(css).toContain('size: a4 landscape');
    expect(css).toContain('print-color-adjust: exact');
    expect(css).toContain('attr(href)');
  });
  it('turns print rules on for screen preview', () => {
    expect(emulatePrintCss('@media print { a{} } @media screen and (min-width:1px) { b{} } @media only print, screen {c{}}')).toBe('@media all { a{} } @media not all and (min-width:1px) { b{} } @media all, not all {c{}}');
  });
  it('maps downloaded addresses to site paths', () => {
    const root = new URL('https://example.com/');
    expect(localPathForUrl(new URL('https://example.com/'), root, true)).toBe('index.html');
    expect(localPathForUrl(new URL('https://example.com/blog/'), root, true)).toBe('blog/index.html');
    expect(localPathForUrl(new URL('https://example.com/about'), root, true)).toBe('about.html');
    expect(localPathForUrl(new URL('https://example.com/img/a%20b.png'), root)).toBe('img/a b.png');
    expect(localPathForUrl(new URL('https://cdn.other.net/lib.js'), root)).toBe('_external/cdn.other.net/lib.js');
  });
});

describe('macros and help', () => {
  it('parses macro text', () => {
    const r = parseMacroText('# comment\nfile.newPage\nfile.newPage {"dir":"blog"}\n');
    expect(r.error).toBeNull();
    expect(r.steps).toEqual([{ id: 'file.newPage' }, { id: 'file.newPage', arg: { dir: 'blog' } }]);
    expect(parseMacroText('no.such.command').error).toMatch(/unknown command/);
    expect(parseMacroText('file.newPage {bad').error).toMatch(/JSON/);
    expect(parseMacroText(macroText({ name: 'm', steps: [{ id: 'file.save' }, { id: 'file.newPage', arg: { dir: 'x' } }], created: 0 })).steps).toEqual([{ id: 'file.save' }, { id: 'file.newPage', arg: { dir: 'x' } }]);
  });
  it('maps commands to their classic menu and ribbon places', () => {
    const m = menuPaths('expression');
    expect(m.get('file.open')?.[0]).toMatch(/^File ▸ /);
    expect([...m.values()].flat().some((p) => p.startsWith('File ▸ New ▸ '))).toBe(true);
    expect(ribbonPaths().get('help.about')?.[0]).toMatch(/▸/);
  });
  it('has reference tables', () => {
    expect(HTML_REF.length).toBeGreaterThan(80);
    expect(CSS_REF.length).toBeGreaterThan(80);
    expect(HTML_REF.some(([e]) => e === 'table')).toBe(true);
    expect(CSS_REF.some(([p]) => p === 'display')).toBe(true);
  });
});
