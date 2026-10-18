import { describe, it, expect } from 'vitest';
import { validateHtml, validateXml, parseHtml, decodeWithMap, fromNuJson } from '../../src/check/validate';
import { checkAccessibility, contrastRatio, parseColor } from '../../src/check/accessibility';
import { checkCompat } from '../../src/check/compat';
import { seoCheck, performanceCheck, imageSize } from '../../src/check/seo';
import {
  cleanupWordHtml, fontToCss, removeComments, removeEmptyTags, removeRedundantNested, combineNestedFonts, inlineToClasses, toHtml5, toXhtmlPage,
  fixMojibake, minifyCss, minifyJs, diffLines, diffStats, optimizeHtml, removeUnusedStyles, markupCleaner, closeImpliedTags, convertWordLists,
} from '../../src/check/cleanup';
import { pageWords, replaceWord, wordsInText } from '../../src/proof/spelling';
import { evaluateExpression, lorem } from '../../src/commands/tools';

const page = (body: string, head = '<meta charset="utf-8"><title>Test page title here</title>') => `<!DOCTYPE html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
const msgs = (issues: { message: string }[]) => issues.map((i) => i.message).join('\n');

describe('HTML validator', () => {
  it('accepts a conforming page with optional end tags, raw text and SVG', () => {
    const src = page('<main><p>One<p>Two &amp; three</p><ul><li>a<li>b</ul><table><tr><th>h<td>c</table>\n<img src="a.png" alt=""><svg viewBox="0 0 2 2"><path d="M0 0"/></svg>\n<script>if (a < b && c) x();</script></main>');
    expect(validateHtml(src)).toEqual([]);
  });
  it('reports document-level problems', () => {
    const m = msgs(validateHtml('<html><body><p>x</p></body></html>'));
    expect(m).toMatch(/doctype/i);
    expect(m).toMatch(/no lang/);
    expect(m).toMatch(/no <title>/);
    expect(m).toMatch(/character encoding/);
  });
  it('finds unclosed, stray and misnested tags with positions', () => {
    const src = page('<div>\n<b><i>x</b></i>\n<span>open\n</div>\n</em>');
    const issues = validateHtml(src);
    const mis = issues.find((i) => i.rule === 'misnested')!;
    expect(mis.line).toBe(8);
    expect(issues.some((i) => i.rule === 'stray' && /<\/i>/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.rule === 'unclosed' && /<span>/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.rule === 'stray' && /<\/em>/.test(i.message))).toBe(true);
  });
  it('reports duplicate ids and attributes, unknown and obsolete markup', () => {
    const m = msgs(validateHtml(page('<p id="a" class="x" class="y">1</p><p id="a">2</p><foo>?</foo><center><font color="red">old</font></center><table bgcolor="#fff"><tr><td>x</td></tr></table>')));
    expect(m).toMatch(/Duplicate id "a"/);
    expect(m).toMatch(/Duplicate attribute class/);
    expect(m).toMatch(/Unknown element <foo>/);
    expect(m).toMatch(/<center> is obsolete/);
    expect(m).toMatch(/<font> is obsolete/);
    expect(m).toMatch(/bgcolor attribute on <table> is obsolete/);
  });
  it('checks content models and required attributes', () => {
    const m = msgs(validateHtml(page('<p>para<div>block</div></p><li>loose</li><a href="/"><a href="/x">nested</a></a><button><a href="#">x</a></button><span><div>d</div></span><img src="x.png"><input type="txt"><label for="missing">L</label><img src="y.png" alt="" width="100px">')));
    expect(m).toMatch(/closes the open paragraph/);
    expect(m).toMatch(/Stray end tag <\/p>/);
    expect(m).toMatch(/<li> must be inside/);
    expect(m).toMatch(/link <a> cannot be inside another link/);
    expect(m).toMatch(/Interactive <a> inside <button>/);
    expect(m).toMatch(/<div> is not allowed inside <span>/);
    expect(m).toMatch(/<img> needs an alt attribute/);
    expect(m).toMatch(/"txt" is not an input type/);
    expect(m).toMatch(/refers to no element/);
    expect(m).toMatch(/width="100px" must be a whole number/);
  });
  it('flags ambiguous ampersands and stray "<"', () => {
    const issues = validateHtml(page('<p>Tom &copy Jerry and 1 < 2 and AT&T</p>'));
    expect(issues.some((i) => i.rule === 'escape' && /&copy/.test(i.message))).toBe(true);
    expect(issues.some((i) => /"<" in text/.test(i.message))).toBe(true);
    expect(issues.some((i) => /AT&T|&T/.test(i.message))).toBe(false);
  });
  it('applies XHTML rules under an XHTML doctype', () => {
    const src = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>t</title></head><body><P CLASS=x>one<br><input disabled></body></html>';
    const m = msgs(validateHtml(src));
    expect(m).toMatch(/element names must be lower case/);
    expect(m).toMatch(/attribute names must be lower case/);
    expect(m).toMatch(/must be in quotes/);
    expect(m).toMatch(/<br \/>/);
    expect(m).toMatch(/needs a value/);
    expect(m).toMatch(/explicit end tag <\/p>/);
  });
  it('checks XML well-formedness', () => {
    expect(validateXml('<?xml version="1.0"?>\n<rss><channel><title>A &amp; B</title></channel></rss>')).toEqual([]);
    const m = msgs(validateXml('<a><b x=1>&nbsp;</B></a><c/>'));
    expect(m).toMatch(/must be in quotes/);
    expect(m).toMatch(/Undeclared entity/);
    expect(m).toMatch(/case-sensitive/);
    expect(m).toMatch(/second root/);
  });
  it('builds a tree with source positions and decodes entities with a map', () => {
    const { root } = parseHtml('<p>a<b>c</b></p>');
    expect(root.children[0].name).toBe('p');
    expect(root.children[0].children[1].start).toBe(4);
    const d = decodeWithMap('x&amp;y&#233;', 10);
    expect(d.text).toBe('x&yé');
    expect(d.from[1]).toBe(11);
    expect(d.to[1]).toBe(16);
  });
  it('reads W3C service results', () => {
    expect(fromNuJson({ messages: [{ type: 'error', lastLine: 3, firstColumn: 2, message: 'Bad' }, { type: 'info', subType: 'warning', lastLine: 4, message: 'Hmm' }] }).map((i) => i.severity)).toEqual(['error', 'warning']);
  });
});

describe('accessibility checker', () => {
  it('passes an accessible page', () => {
    const src = page('<header><nav aria-label="Main"><a href="/">Home</a></nav></header><main><h1>Welcome</h1><img src="cat.jpg" alt="A cat asleep on a rug"><form><label for="q">Search</label><input id="q" type="search"><button>Go</button></form></main>');
    expect(checkAccessibility(src).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('reports common WCAG failures with references', () => {
    const src = '<html><head></head><body><img src="photo1.jpg"><a href="/a"></a><a href="/b">click here</a><button></button><input type="text" placeholder="Name"><h1>T</h1><h3>Skip</h3><iframe src="m.html"></iframe><video src="v.mp4" autoplay></video><div tabindex="3">x</div><span aria-hidden="true"><a href="/c">hidden link</a></span><div role="buton">x</div><p aria-labelledby="nope">x</p><p style="color:#777;background:#888">low contrast</p></body></html>';
    const r = checkAccessibility(src);
    const has = (ref: string, re: RegExp) => r.some((i) => i.ref === `WCAG ${ref}` && re.test(i.message));
    expect(has('3.1.1', /language/)).toBe(true);
    expect(has('2.4.2', /title/)).toBe(true);
    expect(has('1.1.1', /text alternative/)).toBe(true);
    expect(has('2.4.4', /Link without text/)).toBe(true);
    expect(has('2.4.4', /click here/)).toBe(true);
    expect(has('4.1.2', /Button without a name/)).toBe(true);
    expect(has('3.3.2', /Placeholder text is not a label/)).toBe(true);
    expect(has('1.3.1', /skips from h1 to h3/)).toBe(true);
    expect(has('4.1.2', /<iframe> without a title/)).toBe(true);
    expect(has('1.4.2', /plays sound/)).toBe(true);
    expect(has('2.4.3', /tabindex="3"/)).toBe(true);
    expect(has('4.1.2', /aria-hidden="true" on content with focusable/)).toBe(true);
    expect(has('4.1.2', /"buton" is not an ARIA role/)).toBe(true);
    expect(has('4.1.2', /refers to "nope"/)).toBe(true);
    expect(has('1.4.3', /contrast/)).toBe(true);
  });
  it('computes contrast ratios', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('white')!)).toBeCloseTo(21, 1);
    expect(contrastRatio(parseColor('rgb(119,119,119)')!, parseColor('#fff')!)).toBeCloseTo(4.48, 1);
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
  it('treats large text with the 3:1 threshold', () => {
    const src = page('<main><h1>x</h1><p style="color:#888;font-size:32px">Big gray heading text</p></main>');
    expect(checkAccessibility(src).some((i) => i.rule === 'contrast')).toBe(false);
  });
});

describe('compatibility, SEO and performance', () => {
  it('finds legacy features', () => {
    const src = page('<!--[if IE]><p>IE</p><![endif]--><embed src="movie.swf"><script>document.write("x"); var x = new XMLHttpRequest(); x.open("GET", "/a", false);</script><img src="http://example.com/a.png" alt=""><style>.a{-webkit-transform:rotate(1deg)} .b{filter:progid:DXImageTransform.Microsoft.Alpha(opacity=50)}</style><marquee>hi</marquee>');
    const m = msgs(checkCompat(src));
    expect(m).toMatch(/conditional comment/);
    expect(m).toMatch(/Flash/);
    expect(m).toMatch(/document\.write/);
    expect(m).toMatch(/Synchronous XMLHttpRequest/);
    expect(m).toMatch(/plain HTTP/);
    expect(m).toMatch(/-webkit-transform without the standard transform/);
    expect(m).toMatch(/Internet Explorer filters/);
    expect(m).toMatch(/<marquee>/);
    expect(msgs(checkCompat(page('<style>.a:has(b){color:red}</style>'), { modern: true }))).toMatch(/:has\(\)/);
  });
  it('reports SEO basics', () => {
    const m = msgs(seoCheck('<!DOCTYPE html><html><head><title>Hi</title><meta name="robots" content="noindex"></head><body><p>short</p><img src="a.png"></body></html>'));
    expect(m).toMatch(/short/);
    expect(m).toMatch(/meta description/);
    expect(m).toMatch(/noindex/);
    expect(m).toMatch(/No h1/);
    expect(m).toMatch(/viewport/);
    expect(m).toMatch(/Picture without alt/);
  });
  it('measures page weight and oversized pictures', () => {
    const png = new Uint8Array(400 * 1024);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x0f, 0xa0, 0, 0, 0x0b, 0xb8]);
    expect(imageSize(png)).toEqual({ width: 4000, height: 3000, type: 'png' });
    const src = page('<img src="big.png" alt="x" width="400" height="300"><img src="nosize.png" alt="y">', '<title>t</title><script src="app.js"></script>');
    const r = performanceCheck(src, { resolve: (ref) => ref, bytes: (p) => (p === 'big.png' ? png : p === 'app.js' ? new Uint8Array(1000) : undefined) });
    const m = msgs(r.issues);
    expect(m).toMatch(/Render-blocking script app\.js/);
    expect(m).toMatch(/4000×3000 pixels but shown at 400×300/);
    expect(m).toMatch(/without width and height/);
    expect(r.totalBytes).toBeGreaterThan(400 * 1024);
  });
});

const WORD = `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=windows-1252">
<meta name=ProgId content=Word.Document>
<meta name=Generator content="Microsoft Word 15">
<link rel=File-List href="doc_files/filelist.xml">
<!--[if gte mso 9]><xml>
 <o:DocumentProperties><o:Author>Someone</o:Author></o:DocumentProperties>
</xml><![endif]-->
<style>
<!--
 /* Style Definitions */
 p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; mso-pagination:widow-orphan; font-size:12.0pt;}
@page WordSection1 {size:8.5in 11.0in;}
div.WordSection1 {page:WordSection1;}
-->
</style>
<title>Report</title>
</head>
<body lang=EN-US link=blue vlink=purple style='tab-interval:.5in'>
<div class=WordSection1>
<p class=MsoNormal><b><span style='font-size:14.0pt;mso-bidi-font-size:12.0pt'>Quarterly report<o:p></o:p></span></b></p>
<p class=MsoNormal><span style='mso-spacerun:yes'> </span>Sales grew.<a name="_Toc12345"></a><o:p>&nbsp;</o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span></span><![endif]>First point<o:p></o:p></p>
<p class=MsoListParagraphCxSpLast style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span></span><![endif]>Second point<o:p></o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoNormal style='margin-left:.5in;text-indent:-.25in;mso-list:l1 level1 lfo2'><![if !supportLists]><span>1.<span style='font:7.0pt "Times New Roman"'>&nbsp; </span></span><![endif]>Numbered<o:p></o:p></p>
<p class=MsoNormal><font face="Arial" size="2" color="#ff0000">Red note</font></p>
</div>
</body>
</html>`;

describe('clean-up', () => {
  it('cleans up word-processor HTML thoroughly', () => {
    const r = cleanupWordHtml(WORD);
    const s = r.src;
    expect(s).not.toMatch(/mso-|Mso|o:p|xmlns:|ProgId|Generator|File-List|<xml|WordSection|supportLists|_Toc|tab-interval|lang=/i);
    expect(s).toMatch(/<ul>\s*<li>First point<\/li>\s*<li>Second point<\/li>\s*<\/ul>/);
    expect(s).toMatch(/<ol>\s*<li>Numbered<\/li>\s*<\/ol>/);
    expect(s).toMatch(/<b><span style="font-size: ?14\.0pt">Quarterly report<\/span><\/b>/);
    expect(s).toMatch(/<span style="font-family: Arial; font-size: small; color: #ff0000">Red note<\/span>/);
    expect(s).toMatch(/<title>Report<\/title>/);
    expect(s).not.toMatch(/<p>\s*(&nbsp;)?\s*<\/p>/);
    expect(r.log.join('\n')).toMatch(/Word lists converted: 2/);
    // The cleaned page parses without structural errors.
    expect(validateHtml(s).filter((i) => i.rule === 'unclosed' || i.rule === 'stray' || i.rule === 'misnested')).toEqual([]);
  });
  it('converts Word lists with nesting', () => {
    const src = '<p style="mso-list:l0 level1 lfo1">A</p>\n<p style="mso-list:l0 level2 lfo1">A1</p>\n<p style="mso-list:l0 level1 lfo1">B</p>';
    expect(convertWordLists(src).src.replace(/\s+/g, '')).toBe('<ul><li>A<ul><li>A1</li></ul></li><li>B</li></ul>');
  });
  it('turns font tags into CSS and merges nested spans', () => {
    expect(fontToCss('<font face="Times New Roman, serif" size="+1"><font color="blue">x</font></font>').src).toBe(`<span style="font-family: 'Times New Roman', serif; font-size: large; color: blue">x</span>`);
    expect(fontToCss('<font>plain</font>').src).toBe('plain');
    expect(combineNestedFonts('<font face="A"><font color="red">x</font></font>').src).toBe('<font face="A" color="red">x</font>');
  });
  it('removes comments but keeps template markers and conditional comments', () => {
    const src = '<p>a</p>\n<!-- note -->\n<!-- #BeginEditable "body" --><p>b</p><!-- #EndEditable -->\n<!--[if IE]>x<![endif]-->\n<script><!-- keep --></script>';
    const r = removeComments(src);
    expect(r.count).toBe(1);
    expect(r.src).toBe('<p>a</p>\n<!-- #BeginEditable "body" --><p>b</p><!-- #EndEditable -->\n<!--[if IE]>x<![endif]-->\n<script><!-- keep --></script>');
  });
  it('removes empty and redundant tags but keeps hooks', () => {
    expect(removeEmptyTags('<p><b> </b><span style="x"></span><div id="hook"></div><i class="icon"></i></p>').src).toBe('<p><div id="hook"></div><i class="icon"></i></p>');
    expect(removeEmptyTags('<p><b> </b></p><div><span></span></div>').src).toBe('');
    expect(removeRedundantNested('<b><b>x</b></b>').src).toBe('<b>x</b>');
  });
  it('gathers inline styles into classes', () => {
    const r = inlineToClasses('<body><p style="color:red">a</p><p style="color: red;" class="x">b</p><p style="margin:0">c</p></body>', { min: 2 });
    expect(r.classes).toBe(1);
    expect(r.css).toBe('.style1 { color: red; }\n');
    expect(r.src).toBe('<body><p class="style1">a</p><p class="x style1">b</p><p style="margin:0">c</p></body>');
  });
  it('converts legacy markup to HTML5', () => {
    const src = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">\n<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><script type="text/javascript" language="JavaScript">x()</script></head><body bgcolor="#ffffff" link="#00f"><center>Hi</center><p align="right">r</p><img src="a.png" border="0" align="left"><a name="top"></a><font color="red">f</font></body></html>';
    const s = toHtml5(src).src;
    expect(s.startsWith('<!DOCTYPE html>\n')).toBe(true);
    expect(s).toMatch(/<meta charset="utf-8">/);
    expect(s).toMatch(/<script>x\(\)<\/script>/);
    expect(s).toMatch(/<body style="background-color: #ffffff">/);
    expect(s).toMatch(/a:link \{ color: #00f; \}/);
    expect(s).toMatch(/<div style="text-align: center">Hi<\/div>/);
    expect(s).toMatch(/<p style="text-align: right">r<\/p>/);
    expect(s).toMatch(/<img src="a.png" style="float: left">/);
    expect(s).toMatch(/<a id="top"><\/a>/);
    expect(s).toMatch(/<span style="color: red">f<\/span>/);
  });
  it('converts to XHTML, writing omitted end tags', () => {
    expect(closeImpliedTags('<ul><li>a<li>b</ul>').src).toBe('<ul><li>a</li><li>b</li></ul>');
    const s = toXhtmlPage('<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><P>one<br>A & B<input disabled></body></html>').src;
    expect(s).toMatch(/XHTML 1\.0 Transitional/);
    expect(s).toMatch(/<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" lang="en" xml:lang="en">/);
    expect(s).toMatch(/<p>one<br \/>A &amp; B<input disabled="disabled" \/><\/p>/);
  });
  it('repairs mojibake', () => {
    expect(fixMojibake('CafÃ© â€” donâ€™t').src).toBe('Café — don’t');
    expect(fixMojibake('naïve résumé').count).toBe(0);
  });
  it('optimizes HTML and removes unused styles', () => {
    const src = '<html><head><meta name="generator" content="X"><style>.used{color:red} .unused{color:blue} @media print{.gone{x:y}}</style></head><body>\n    <p class="used">a</p>\n<!--webbot bot="Timestamp" --></body></html>';
    const r = optimizeHtml(src, { generator: true, frontpage: true, unusedStyles: true, whitespaceLeading: true });
    expect(r.src).not.toMatch(/generator|webbot|unused|gone/);
    expect(r.src).toMatch(/\.used\{color:red\}/);
    expect(r.src).toMatch(/\n<p class="used">/);
    expect(removeUnusedStyles('<style>#a, .b {x:y}</style><p id="a">').count).toBe(0);
  });
  it('runs the markup cleaner', () => {
    const r = markupCleaner('<p>text<br></p><div></div><ul><li>a</li><ul><li>b</li></ul></ul>', { trailingBr: true, emptyBlocks: true, nestedLists: true });
    expect(r.src).toBe('<p>text</p><ul><li>a<ul><li>b</li></ul></li></ul>');
  });
  it('minifies CSS and JavaScript safely', () => {
    expect(minifyCss('/* c */ a :hover , b > i { color : red ; content: "a , b" ; }\n@media (max-width: 600px) { .x { margin : 0 } }')).toBe('a :hover,b>i{color:red;content:"a , b"}@media (max-width: 600px){.x{margin:0}}');
    expect(minifyJs('  // note\n  var a = "x // y"; /* c */\n\n  var r = /\\/\\*/g;\n  return a;')).toBe('var a = "x // y";\nvar r = /\\/\\*/g;\nreturn a;');
  });
});

describe('line comparison', () => {
  it('finds the shortest edit script', () => {
    const ops = diffLines('a\nb\nc\nd\n', 'a\nx\nc\nd\ne\n');
    expect(ops.map((o) => `${o.op[0]}${o.text}`)).toEqual(['ea', 'db', 'ix', 'ec', 'ed', 'ie']);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1, same: 3 });
    expect(ops.find((o) => o.text === 'x')!.b).toBe(2);
  });
  it('handles empty sides and options', () => {
    expect(diffLines('', 'a\nb').filter((o) => o.op === 'insert').length).toBe(2);
    expect(diffStats(diffLines('A  b', 'a b', { ignoreWhitespace: true, ignoreCase: true }))).toEqual({ added: 0, removed: 0, same: 1 });
  });
  it('agrees with a longest common subsequence on random input', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let t = 0; t < 20; t++) {
      const a = Array.from({ length: 30 }, () => 'abcde'[Math.floor(rnd() * 5)]);
      const b = Array.from({ length: 25 }, () => 'abcde'[Math.floor(rnd() * 5)]);
      const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) lcs[i][j] = a[i - 1] === b[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      const ops = diffLines(a.join('\n'), b.join('\n'));
      expect(diffStats(ops).same).toBe(lcs[a.length][b.length]);
      expect(ops.filter((o) => o.op !== 'insert').map((o) => o.text)).toEqual(a);
      expect(ops.filter((o) => o.op !== 'delete').map((o) => o.text)).toEqual(b);
    }
  });
});

describe('calculator', () => {
  it('evaluates with precedence and functions', () => {
    expect(evaluateExpression('1 + 2 * 3')).toBe(7);
    expect(evaluateExpression('(1280 - 2 * 24) / 3')).toBeCloseTo(410.6667, 3);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluateExpression('-2^2')).toBe(-4);
    expect(evaluateExpression('sqrt(16) + max(1, 5, 3) + abs(-2)')).toBe(11);
    expect(evaluateExpression('200 * 15%')).toBe(30);
    expect(evaluateExpression('10 % 4')).toBe(2);
    expect(evaluateExpression('2pi')).toBeCloseTo(6.2832, 3);
    expect(evaluateExpression('0x10 + 1e2')).toBe(116);
    expect(evaluateExpression('5!')).toBe(120);
    expect(evaluateExpression('ans * 2', { ans: 21 })).toBe(42);
  });
  it('rejects bad input without eval', () => {
    expect(() => evaluateExpression('1 / 0')).toThrow(/zero/);
    expect(() => evaluateExpression('2 +')).toThrow();
    expect(() => evaluateExpression('alert(1)')).toThrow(/Unknown name/);
    expect(() => evaluateExpression('(1 + 2')).toThrow(/\)/);
  });
});

describe('spelling text extraction', () => {
  it('takes words only from visible text, with exact source ranges', () => {
    const src = page('<p class="speling">Helo <b>wrold</b> &amp; caf&eacute; <code>misspeled</code> <a href="x">linke</a> http://exampl.com NASA iPhone 3rd</p><p spellcheck="false">ignord</p><script>var tyop;</script>', '<title>Titel</title>');
    const ws = pageWords(src);
    expect(ws.map((w) => w.word)).toEqual(['Titel', 'Helo', 'wrold', 'café', 'linke']);
    const cafe = ws.find((w) => w.word === 'café')!;
    expect(src.slice(cafe.start, cafe.end)).toBe('caf&eacute;');
    const fixed = replaceWord(src, ws.find((w) => w.word === 'wrold')!, 'world')!;
    expect(fixed).toMatch(/<b>world<\/b>/);
    expect(fixed.replace('world', 'wrold')).toBe(src);
    expect(replaceWord(fixed, ws[1], 'Hello')).toMatch(/Hello <b>/);
  });
  it('splits words with apostrophes and hyphens', () => {
    expect(wordsInText("don't well-known x").map((w) => w.word)).toEqual(["don't", 'well', 'known']);
  });
  it('makes placeholder text', () => {
    expect(lorem('words', 5, true, 1)).toBe('Lorem ipsum dolor sit amet');
    expect(lorem('paragraphs', 2, true, 3).split('\n\n').length).toBe(2);
  });
});
