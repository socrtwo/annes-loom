/**
 * Reads PHP theme templates (WordPress, Joomla) without running them. The template is split into HTML and
 * PHP code; control structures are followed (conditions are judged by the environment, unknown ones count
 * as true), template tags are replaced by static values from the environment, and every statement that has
 * no static meaning is dropped and listed in the report. No PHP is ever executed.
 */

export interface PhpEnv {
  /** Output of a statement-level call (a template tag such as the_title()); undefined when unknown. */
  call(name: string, args: string[], ev: Evaluator): string | undefined;
  /** Value of a call inside an expression (esc_url(home_url('/'))); undefined when unknown. */
  value(name: string, args: string[], ev: Evaluator): string | undefined;
  /** Truth of a call in a condition (have_posts(), is_front_page()); undefined when unknown. */
  cond(name: string, args: string[], ev: Evaluator): boolean | undefined;
  /** Value of a variable expression ($this->baseurl, $post->post_title); undefined when unknown. */
  variable?(expr: string): string | undefined;
  /** Called at the start of a `while (have_posts())` loop; returns how many times to run the body. */
  loopCount?(cond: string): number;
  /** Called before each pass of such a loop. */
  loopPass?(i: number): void;
}

export interface PhpReport { dropped: string[]; assumed: string[] }

export interface Evaluator {
  expr(e: string): string;
  cond(e: string): boolean;
  args(s: string): string[];
  array(s: string): Record<string, string>;
  vars: Map<string, string>;
}

type Seg = { t: 'html'; s: string } | { t: 'php'; s: string; echo: boolean };

/** Splits source into HTML and PHP code, honoring strings and comments inside the code. */
export function splitPhp(src: string): Seg[] {
  const out: Seg[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.slice(i).search(/<\?(?:php\b|=|(?!xml))/i);
    if (open < 0) { out.push({ t: 'html', s: src.slice(i) }); break; }
    if (open > 0) out.push({ t: 'html', s: src.slice(i, i + open) });
    let j = i + open + 2;
    let echo = false;
    if (/^php/i.test(src.slice(j, j + 3))) j += 3; else if (src[j] === '=') { echo = true; j++; }
    const start = j;
    let q: string | null = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? src.length : e + 1; continue; }
      if ((c === '/' && src[j + 1] === '/') || c === '#') {
        while (j < src.length && src[j] !== '\n' && !(src[j] === '?' && src[j + 1] === '>')) j++;
        j--; continue;
      }
      if (c === '?' && src[j + 1] === '>') break;
    }
    out.push({ t: 'php', s: src.slice(start, j), echo });
    i = j + 2;
    // A newline right after ?> is eaten by PHP.
    if (src[i] === '\n') i++; else if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
  }
  return out;
}

type Op =
  | { op: 'html'; s: string }
  | { op: 'stmt'; s: string }
  | { op: 'if'; cond: string; alt: boolean }
  | { op: 'elseif'; cond: string }
  | { op: 'else' }
  | { op: 'loop'; kw: string; cond: string; alt: boolean }
  | { op: 'end'; kw?: string }
  | { op: 'open' }
  | { op: 'skip'; what: string };

/** Index just after the bracket that closes the one at `i`. */
function balanced(s: string, i: number): number {
  const open = s[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  let q: string | null = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return s.length;
}

/** Reads one statement up to a top-level ";" (or the end). */
function readStatement(s: string, i: number): number {
  let q: string | null = null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return j; depth--; }
    else if (c === ';' && depth === 0) return j + 1;
  }
  return s.length;
}

function stripComments(code: string): string {
  let out = '';
  let q: string | null = null;
  for (let j = 0; j < code.length; j++) {
    const c = code[j];
    if (q) { out += c; if (c === '\\') { out += code[++j] ?? ''; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === '/' && code[j + 1] === '*') { const e = code.indexOf('*/', j + 2); j = e < 0 ? code.length : e + 1; out += ' '; continue; }
    if ((c === '/' && code[j + 1] === '/') || c === '#') { while (j < code.length && code[j] !== '\n') j++; out += '\n'; continue; }
    out += c;
  }
  return out;
}

function parseCode(code: string, ops: Op[], singleStack: number[]): void {
  const s = stripComments(code);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const afterHead = (alt: () => void, brace: () => void, single: () => void) => {
    ws();
    if (s[i] === ':') { i++; alt(); } else if (s[i] === '{') { i++; brace(); } else single();
  };
  while (true) {
    ws();
    if (i >= s.length) break;
    const rest = s.slice(i);
    if (s[i] === '}') {
      i++;
      ws();
      const em = /^(else\s*if|elseif)\s*\(/i.exec(s.slice(i));
      if (em) { i += em[0].length - 1; const e = balanced(s, i); const cond = s.slice(i + 1, e - 1); i = e; ws(); if (s[i] === '{') i++; ops.push({ op: 'elseif', cond }); continue; }
      if (/^else\b/i.test(s.slice(i))) { i += 4; ws(); if (s[i] === '{') i++; ops.push({ op: 'else' }); continue; }
      ops.push({ op: 'end' });
      continue;
    }
    if (s[i] === '{') { i++; ops.push({ op: 'open' }); continue; }
    let m = /^(if|elseif|else\s+if|while|foreach|for|switch)\s*\(/i.exec(rest);
    if (m) {
      const kw = m[1].toLowerCase().replace(/\s+/, '');
      i += m[0].length - 1;
      const e = balanced(s, i);
      const cond = s.slice(i + 1, e - 1);
      i = e;
      if (kw === 'switch') {
        ws();
        if (s[i] === '{') { i = balanced(s, i); ops.push({ op: 'skip', what: 'switch statement' }); continue; }
        if (s[i] === ':') { const end = s.indexOf('endswitch', i); i = end < 0 ? s.length : end + 9; ops.push({ op: 'skip', what: 'switch statement' }); continue; }
      }
      if (kw === 'elseif') { ws(); if (s[i] === ':' || s[i] === '{') i++; ops.push({ op: 'elseif', cond }); continue; }
      const isIf = kw === 'if';
      afterHead(
        () => ops.push(isIf ? { op: 'if', cond, alt: true } : { op: 'loop', kw, cond, alt: true }),
        () => ops.push(isIf ? { op: 'if', cond, alt: false } : { op: 'loop', kw, cond, alt: false }),
        () => {
          // One statement without braces: `if ( x ) echo 'y';`
          ops.push(isIf ? { op: 'if', cond, alt: false } : { op: 'loop', kw, cond, alt: false });
          const e2 = readStatement(s, i);
          const st = s.slice(i, e2).trim().replace(/;$/, '');
          if (st) ops.push({ op: 'stmt', s: st });
          i = e2;
          ops.push({ op: 'end' });
          singleStack.push(ops.length);
        },
      );
      continue;
    }
    m = /^else\b/i.exec(rest);
    if (m) { i += 4; ws(); if (s[i] === ':' || s[i] === '{') i++; ops.push({ op: 'else' }); continue; }
    m = /^(endif|endwhile|endforeach|endfor|endswitch)\b\s*;?/i.exec(rest);
    if (m) { i += m[0].length; ops.push({ op: 'end', kw: m[1].toLowerCase() }); continue; }
    m = /^function\s+[\w]+\s*\(/i.exec(rest);
    if (m) {
      i += m[0].length - 1;
      i = balanced(s, i);
      ws();
      if (s[i] === '{') i = balanced(s, i);
      ops.push({ op: 'skip', what: 'function definition' });
      continue;
    }
    m = /^(case\b[^:]*|default\s*):/i.exec(rest);
    if (m) { i += m[0].length; continue; }
    const e = readStatement(s, i);
    const st = s.slice(i, e).trim().replace(/;$/, '').trim();
    i = e === i ? i + 1 : e;
    if (st) ops.push({ op: 'stmt', s: st });
  }
}

function compile(src: string): Op[] {
  const ops: Op[] = [];
  for (const seg of splitPhp(src)) {
    if (seg.t === 'html') { if (seg.s) ops.push({ op: 'html', s: seg.s }); continue; }
    if (seg.echo) { ops.push({ op: 'stmt', s: 'echo ' + seg.s.trim().replace(/;\s*$/, '') }); continue; }
    parseCode(seg.s, ops, []);
  }
  return ops;
}

interface Struct { kind: 'if' | 'loop' | 'open'; start: number; branches: number[]; end: number }

/** Matches every if/loop/brace with its branches and end. */
function structure(ops: Op[]): Map<number, Struct> {
  const map = new Map<number, Struct>();
  const stack: Struct[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'if' || o.op === 'loop' || o.op === 'open') {
      const st: Struct = { kind: o.op, start: i, branches: [], end: ops.length };
      stack.push(st);
      map.set(i, st);
    } else if (o.op === 'elseif' || o.op === 'else') {
      const st = [...stack].reverse().find((x) => x.kind === 'if');
      if (st) { st.branches.push(i); map.set(i, st); }
    } else if (o.op === 'end') {
      const st = stack.pop();
      if (st) { st.end = i; map.set(i, st); }
    }
  });
  return map;
}

export function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let q: string | null = null;
  let depth = 0;
  let last = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && s.startsWith(sep, j)) {
      // "." concatenation, not a decimal point, "..." or ".=".
      if (sep === '.' && (/\d/.test(s[j - 1] || '') && /\d/.test(s[j + 1] || '') || s[j + 1] === '.' || s[j - 1] === '.' || s[j + 1] === '=')) continue;
      out.push(s.slice(last, j));
      last = j + sep.length;
      j += sep.length - 1;
    }
  }
  out.push(s.slice(last));
  return out;
}

/** Position of a top-level ternary "?" (not "?->" or "??"), or -1. */
function ternaryAt(s: string): number {
  let q: string | null = null;
  let depth = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '?' && depth === 0 && s[j + 1] !== '-' && s[j + 1] !== '?' && s[j - 1] !== '?') return j;
  }
  return -1;
}

/** Top-level comparison: [whole, left, operator, right] or null. Skips "->" and "=>". */
function findCmp(s: string): [string, string, string, string] | null {
  let q: string | null = null;
  let depth = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0) {
      const op = /^(===|!==|==|!=|<=|>=|<|>)/.exec(s.slice(j))?.[1];
      if (!op) continue;
      if (op === '>' && (s[j - 1] === '-' || s[j - 1] === '=')) continue;
      if (op[0] === '=' && s[j + op.length] === '>') continue;
      return [s, s.slice(0, j), op, s.slice(j + op.length)];
    }
  }
  return null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function phpDate(fmt: string, d = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return fmt.replace(/\\(.)|[YymndjFMDlGgHisaA]/g, (c, lit) => {
    if (lit) return lit;
    switch (c) {
      case 'Y': return String(d.getFullYear());
      case 'y': return String(d.getFullYear()).slice(2);
      case 'm': return p2(d.getMonth() + 1);
      case 'n': return String(d.getMonth() + 1);
      case 'd': return p2(d.getDate());
      case 'j': return String(d.getDate());
      case 'F': return MONTHS[d.getMonth()];
      case 'M': return MONTHS[d.getMonth()].slice(0, 3);
      case 'D': return DAYS[d.getDay()].slice(0, 3);
      case 'l': return DAYS[d.getDay()];
      case 'G': return String(d.getHours());
      case 'g': return String(d.getHours() % 12 || 12);
      case 'H': return p2(d.getHours());
      case 'i': return p2(d.getMinutes());
      case 's': return p2(d.getSeconds());
      case 'a': return d.getHours() < 12 ? 'am' : 'pm';
      case 'A': return d.getHours() < 12 ? 'AM' : 'PM';
    }
    return c;
  });
}

function unquote(lit: string, vars: Map<string, string>): string {
  const q = lit[0];
  const body = lit.slice(1, -1);
  if (q === "'") return body.replace(/\\(['\\])/g, '$1');
  return body
    .replace(/\{?\$([A-Za-z_]\w*)\}?/g, (m, n) => vars.get(n) ?? '')
    .replace(/\\(["\\$])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

const SPRINTF = /%(?:(\d+)\$)?[-+ 0#]*\d*(?:\.\d+)?([sdfu%])/g;

export function renderPhp(src: string, env: PhpEnv, report: PhpReport, vars = new Map<string, string>()): string {
  const ops = compile(src);
  const st = structure(ops);
  let out = '';

  const ev: Evaluator = {
    vars,
    args: (s) => (s.trim() ? splitTop(s, ',').map((a) => a.trim()) : []),
    array: (s) => {
      let t = s.trim();
      const m = /^array\s*\(([\s\S]*)\)$/i.exec(t) || /^\[([\s\S]*)\]$/.exec(t);
      if (!m) return {};
      t = m[1];
      const r: Record<string, string> = {};
      for (const part of splitTop(t, ',')) {
        const kv = splitTop(part, '=>');
        if (kv.length === 2) r[ev.expr(kv[0])] = ev.expr(kv[1]);
      }
      return r;
    },
    expr: (e0) => {
      let e = e0.trim();
      if (!e) return '';
      while (/^\((?:string|int|integer|bool|boolean|float|array|object)\)/i.test(e)) e = e.replace(/^\([a-z]+\)\s*/i, '');
      if (e.startsWith('@')) e = e.slice(1).trim();
      if (e[0] === '(' && balanced(e, 0) === e.length) return ev.expr(e.slice(1, -1));
      const t = ternaryAt(e);
      if (t > 0) {
        const cond = e.slice(0, t);
        const rest = e.slice(t + 1);
        if (rest.trimStart().startsWith(':')) { const a = ev.expr(cond); return a || ev.expr(rest.trimStart().slice(1)); }
        const parts = splitTop(rest, ':');
        return ev.cond(cond) ? ev.expr(parts[0]) : ev.expr(parts.slice(1).join(':'));
      }
      const nc = splitTop(e, '??');
      if (nc.length > 1) { for (const p of nc) { const v = ev.expr(p); if (v) return v; } return ''; }
      const cat = splitTop(e, '.');
      if (cat.length > 1) return cat.map((p) => ev.expr(p)).join('');
      if (/^'(?:[^'\\]|\\.)*'$/s.test(e) || /^"(?:[^"\\]|\\.)*"$/s.test(e)) return unquote(e, vars);
      if (/^-?\d+(\.\d+)?$/.test(e)) return e;
      if (/^(true)$/i.test(e)) return '1';
      if (/^(false|null)$/i.test(e)) return '';
      if (/^(array\s*\(|\[)/i.test(e)) return '';
      const call = /^(new\s+)?([\\A-Za-z_][\w\\]*(?:::[A-Za-z_]\w*)?)\s*\(/.exec(e);
      if (call && balanced(e, call[0].length - 1) === e.length) {
        const name = call[2].replace(/^\\/, '');
        const args = ev.args(e.slice(call[0].length, -1));
        return builtin(name, args) ?? env.value(name, args, ev) ?? (report.dropped.push(`${name}()`), '');
      }
      if (e.startsWith('$')) {
        const v = env.variable?.(e);
        if (v !== undefined) return v;
        const name = /^\$(\w+)/.exec(e)?.[1] || '';
        if (vars.has(name) && /^\$\w+$/.test(e)) return vars.get(name)!;
        report.dropped.push(e.replace(/\(.*$/s, '(…)').slice(0, 60));
        return '';
      }
      if (/^[A-Z_][A-Z0-9_]*$/.test(e)) return '';
      report.dropped.push(e.slice(0, 60));
      return '';
    },
    cond: (c0) => {
      let c = c0.trim();
      if (!c) return true;
      if (c[0] === '(' && balanced(c, 0) === c.length) return ev.cond(c.slice(1, -1));
      for (const op of ['||', ' or ']) { const p = splitTop(c, op); if (p.length > 1) return p.some((x) => ev.cond(x)); }
      for (const op of ['&&', ' and ']) { const p = splitTop(c, op); if (p.length > 1) return p.every((x) => ev.cond(x)); }
      if (c.startsWith('!') && !c.startsWith('!=')) return !ev.cond(c.slice(1));
      const cmp = findCmp(c);
      if (cmp) {
        const a = ev.expr(cmp[1]), b = ev.expr(cmp[3]);
        switch (cmp[2]) {
          case '===': case '==': return a === b;
          case '!==': case '!=': return a !== b;
          default: { const x = parseFloat(a) || 0, y = parseFloat(b) || 0; return cmp[2] === '<' ? x < y : cmp[2] === '>' ? x > y : cmp[2] === '<=' ? x <= y : x >= y; }
        }
      }
      const call = /^([\\A-Za-z_][\w\\]*(?:::[A-Za-z_]\w*)?)\s*\(/.exec(c);
      if (call && balanced(c, call[0].length - 1) === c.length) {
        const name = call[1].replace(/^\\/, '');
        const args = ev.args(c.slice(call[0].length, -1));
        if (/^(empty)$/i.test(name)) return !ev.expr(args[0] || '');
        if (/^(isset)$/i.test(name)) return args.every((a) => !!ev.expr(a));
        const r = env.cond(name, args, ev);
        if (r !== undefined) return r;
        const v = builtin(name, args) ?? env.value(name, args, ev);
        if (v !== undefined) return !!v && v !== '0';
        report.assumed.push(`${name}()`);
        return true;
      }
      if (c.startsWith('$')) {
        const name = /^\$(\w+)$/.exec(c)?.[1];
        if (name && vars.has(name)) return !!vars.get(name) && vars.get(name) !== '0';
        const v = env.variable?.(c);
        if (v !== undefined) return !!v && v !== '0';
        report.assumed.push(c.slice(0, 40));
        return true;
      }
      const v = ev.expr(c);
      return !!v && v !== '0';
    },
  };

  function builtin(name: string, args: string[]): string | undefined {
    const a0 = () => ev.expr(args[0] || '');
    switch (name.toLowerCase()) {
      case 'esc_url': case 'esc_url_raw': case 'esc_html': case 'esc_attr': case 'esc_textarea': case 'esc_js': case 'wp_kses_post': case 'wp_kses': case 'wp_kses_data': case 'trim': case 'sanitize_text_field': case 'sanitize_title': case 'wp_strip_all_tags': case 'strip_tags': case 'htmlspecialchars': case 'htmlentities': case 'wpautop': case 'do_shortcode': case 'apply_filters_value': case 'intval': case 'absint': case 'esc_sql': case 'stripslashes': case 'wptexturize': case 'convert_chars': case 'force_balance_tags': case 'urlencode': case 'rawurlencode':
        return a0();
      case '__': case 'esc_html__': case 'esc_attr__': case '_x': case 'esc_html_x': case 'esc_attr_x': case '_n': case 'translate': case 'jtext::_': case 'text::_':
        return a0();
      case 'apply_filters': return ev.expr(args[1] || '');
      case 'strtoupper': return a0().toUpperCase();
      case 'strtolower': return a0().toLowerCase();
      case 'ucfirst': { const v = a0(); return v.charAt(0).toUpperCase() + v.slice(1); }
      case 'date': case 'gmdate': case 'date_i18n': case 'wp_date': return phpDate(a0());
      case 'sprintf': case 'vsprintf': return sprintf(args);
      case 'implode': case 'join': return '';
      case 'number_format': return a0();
      case 'str_replace': { const s = ev.expr(args[2] || ''); return s.split(ev.expr(args[0] || '')).join(ev.expr(args[1] || '')); }
      case 'count': case 'sizeof': return '0';
      case 'is_array': case 'function_exists': case 'class_exists': case 'defined': return '1';
      case 'get_template_part': case 'locate_template': return undefined;
    }
    return undefined;
  }

  function sprintf(args: string[]): string {
    const fmt = ev.expr(args[0] || '');
    let n = 1;
    return fmt.replace(SPRINTF, (m, pos, k) => (k === '%' ? '%' : ev.expr(args[pos ? +pos : n++] || '')));
  }

  function stmt(s: string): void {
    let m = /^(echo|print)\b([\s\S]*)$/i.exec(s);
    if (m) { for (const part of splitTop(m[2], ',')) out += ev.expr(part); return; }
    m = /^\$(\w+)\s*(\.?=)(?!=)\s*([\s\S]*)$/.exec(s);
    if (m) { const v = ev.expr(m[3]); vars.set(m[1], m[2] === '.=' ? (vars.get(m[1]) || '') + v : v); return; }
    if (/^(return|exit|die|break|continue|global|static|use|namespace)\b/i.test(s) || /^defined\s*\(/i.test(s)) return;
    m = /^(include|require|include_once|require_once)\b/i.exec(s);
    if (m) { report.dropped.push(`${m[1]} ${s.slice(m[0].length).trim().slice(0, 60)}`); return; }
    m = /^@?([\\A-Za-z_][\w\\]*(?:::[A-Za-z_]\w*)?)\s*\(/.exec(s);
    if (m && balanced(s, m[0].length - 1) === s.length) {
      const name = m[1].replace(/^\\/, '');
      const args = ev.args(s.slice(m[0].length, -1));
      if (/^printf$/i.test(name)) { out += sprintf(args); return; }
      if (/^(_e|esc_html_e|esc_attr_e|_ex|esc_html_ex|esc_attr_ex)$/i.test(name)) { out += ev.expr(args[0] || ''); return; }
      const r = env.call(name, args, ev);
      if (r !== undefined) { out += r; return; }
      report.dropped.push(`${name}()`);
      return;
    }
    report.dropped.push(s.replace(/\s+/g, ' ').slice(0, 70));
  }

  function run(from: number, to: number, depth: number): void {
    if (depth > 40) return;
    for (let i = from; i < to; i++) {
      const o = ops[i];
      switch (o.op) {
        case 'html': out += o.s; break;
        case 'stmt': stmt(o.s); break;
        case 'skip': report.dropped.push(o.what); break;
        case 'open': { const s = st.get(i)!; run(i + 1, s.end, depth + 1); i = s.end; break; }
        case 'if': {
          const s = st.get(i)!;
          const starts = [i, ...s.branches];
          let done = false;
          for (let b = 0; b < starts.length && !done; b++) {
            const bo = ops[starts[b]];
            const end = b + 1 < starts.length ? starts[b + 1] : s.end;
            const take = bo.op === 'else' ? true : ev.cond((bo as any).cond);
            if (take) { run(starts[b] + 1, end, depth + 1); done = true; }
          }
          i = s.end;
          break;
        }
        case 'loop': {
          const s = st.get(i)!;
          if (/have_posts\s*\(/.test(o.cond) && env.loopCount) {
            const n = Math.min(50, env.loopCount(o.cond));
            for (let k = 0; k < n; k++) { env.loopPass?.(k); run(i + 1, s.end, depth + 1); }
          } else {
            report.assumed.push(`${o.kw} loop (shown once)`);
            run(i + 1, s.end, depth + 1);
          }
          i = s.end;
          break;
        }
        default: break;
      }
    }
  }
  run(0, ops.length, 0);
  return out;
}
