// Browser smoke test for Anne's Loom. Serves dist/ with `vite preview` (run `npm run build` first) or
// tests BASE_URL, then checks that:
//   - the app loads with no page errors;
//   - the ribbon tabs, the classic menu bar and the Folder List render;
//   - Design, Split, Code and Preview views switch, and typing in Code view updates Design view;
//   - every registered command runs without throwing (commands that would leave the page, quit, or
//     need a real native dialog are skipped; dialogs the commands open are closed with Escape).
// Usage: npm run build && node tests/e2e/smoke.mjs
// Environment: BASE_URL (test a running server), CHROMIUM_PATH (browser), SMOKE_ONLY (regular
// expression: run only matching command ids), SMOKE_VERBOSE=1 (print every command id).
import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 4173;
let server = null;
let url = process.env.BASE_URL;

function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'];
  try { for (const d of readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) cands.push(join('/opt/pw-browsers', d, 'chrome-linux', 'chrome')); } catch { /* none */ }
  return cands.find((p) => p && existsSync(p) && statSync(p).isFile());
}

async function startServer() {
  if (!existsSync('dist/index.html')) { console.error('dist/ is missing: run `npm run build` first (or set BASE_URL).'); process.exit(2); }
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  const u = `http://localhost:${PORT}/`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(u)).ok) return u; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('vite preview did not start');
}
function stopServer() { if (server) try { process.kill(-server.pid); } catch { /* already gone */ } }

/** Commands that would leave or reload the page, quit, or that only drive the browser's own UI. */
const SKIP = /(^|\.)(exit|quit|close(Window|App)?|reload|restart|resetAll|factoryReset|clearAllData)$|print|previewBrowser|openInBrowser|\.tour$/i;

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);

if (!url) url = await startServer();
const exe = findChromium();
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
  // Keep the test offline and fast: only the app's own server is reachable.
  const origin = new URL(url).origin;
  await context.route('**/*', (route) => (route.request().url().startsWith(origin) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
  const p = await context.newPage();
  let errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Requests this test blocks on purpose.
    if (/net::ERR_FAILED|ERR_BLOCKED|Failed to load resource|Failed to fetch/i.test(t)) return;
    errs.push('console: ' + t.slice(0, 400));
  });
  p.on('dialog', (d) => void d.dismiss().catch(() => undefined));
  p.on('popup', (w) => void w.close().catch(() => undefined));
  await p.addInitScript(() => {
    for (const k of ['quillloom.prefs.v1', 'quillstage.prefs.v1']) {
      try { localStorage.setItem(k, JSON.stringify({ firstRun: false })); } catch { /* */ }
    }
    // No native dialogs in a headless run: the pickers act as if canceled, print and new windows do nothing.
    const abort = () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
    window.showOpenFilePicker = abort;
    window.showSaveFilePicker = abort;
    window.showDirectoryPicker = abort;
    window.print = () => undefined;
    window.open = () => null;
  });

  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.ql && window.__qlAllIds && document.querySelector('.ql-tree-row'), null, { timeout: 30000 });
  await p.waitForTimeout(800);
  if (errs.length) fail('Errors while loading:\n  ' + errs.join('\n  '));
  errs = [];

  // ---- Shell ----
  const shell = await p.evaluate(() => ({
    tabs: [...document.querySelectorAll('.ql-tabs .ql-tab')].map((t) => t.textContent.trim()).filter(Boolean),
    menus: [...document.querySelectorAll('.ql-menubar .ql-menubar-item')].map((t) => t.textContent.trim()).filter(Boolean),
    files: [...document.querySelectorAll('.ql-tree .ql-tree-row')].map((t) => t.textContent.trim()),
    ribbonGroups: document.querySelectorAll('.ql-ribbon .ql-group').length,
  }));
  if (shell.tabs.length < 5) fail(`Ribbon tabs: expected at least 5, found ${JSON.stringify(shell.tabs)}`);
  for (const t of ['File', 'Home', 'Insert']) if (!shell.tabs.some((x) => x.includes(t))) fail(`Ribbon tab "${t}" is missing (${shell.tabs.join(', ')})`);
  if (!shell.ribbonGroups) fail('The ribbon shows no groups');
  if (shell.menus.length < 3) fail(`Classic menu bar: expected menus, found ${JSON.stringify(shell.menus)}`);
  if (!shell.files.length) fail('The Folder List is empty');
  if (!shell.files.some((f) => /index\.html?/.test(f))) warnings.push(`The Folder List has no index page: ${shell.files.slice(0, 10).join(', ')}`);

  // ---- Views ----
  await p.evaluate(() => { const pg = window.ql.site.pages?.()[0]?.path || 'index.html'; if (!window.ql.active || window.ql.active.kind !== 'page') window.ql.openFile(pg); });
  await p.waitForTimeout(300);
  for (const v of ['design', 'split', 'code', 'preview']) {
    await p.evaluate((id) => window.ql.exec(id), `view.${v}`);
    await p.waitForTimeout(400);
    const got = await p.evaluate(() => ({ view: window.ql.active?.view, data: document.querySelector('.ql-pageview[data-view]:not([hidden])')?.dataset.view || window.ql.active?.ui?.el?.dataset.view }));
    if (got.view !== v) fail(`view.${v}: the tab's view is ${got.view}`);
    if (got.data && got.data !== v) fail(`view.${v}: the page view shows ${got.data}`);
    if (v === 'preview' && !(await p.$('.ql-preview-frame'))) fail('Preview view has no preview frame');
    if (v === 'design' && !(await p.$('.ql-design iframe'))) fail('Design view has no frame');
    if (v === 'code' && !(await p.$('.ql-code .cm-content'))) fail('Code view has no editor');
  }

  // ---- Code view edits reach Design view ----
  await p.evaluate(() => window.ql.exec('view.split'));
  await p.waitForTimeout(400);
  const bodyLine = await p.evaluate(() => {
    const src = window.ql.active.source;
    const i = src.search(/<\/body>/i);
    return i < 0 ? -1 : src.slice(0, i).split('\n').length - 1;
  });
  if (bodyLine < 0) fail('The page has no </body>');
  else {
    const cm = await p.$('.ql-code .cm-content');
    await cm.click();
    await p.keyboard.press('Control+Home');
    for (let i = 0; i < bodyLine; i++) await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Home');
    await p.keyboard.type('SmokeTest42 ');
    await p.keyboard.press('Escape');
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      await p.waitForTimeout(200);
      ok = await p.evaluate(() => {
        const f = document.querySelector('.ql-design iframe');
        return !!f?.contentDocument?.body?.textContent?.includes('SmokeTest42');
      });
    }
    if (!(await p.evaluate(() => window.ql.active.source.includes('SmokeTest42')))) fail('Typing in Code view did not change the page source');
    if (!ok) fail('Typing in Code view did not update Design view');
    await p.evaluate(() => window.ql.exec('edit.undo'));
  }
  if (errs.length) fail('Errors while switching views and editing:\n  ' + errs.join('\n  '));
  errs = [];

  // ---- Every command ----
  const only = process.env.SMOKE_ONLY ? new RegExp(process.env.SMOKE_ONLY) : null;
  const ids = (await p.evaluate(() => window.__qlAllIds)).filter((id) => (!only || only.test(id)));
  const skipped = ids.filter((id) => SKIP.test(id));
  const broken = [];
  const stuck = [];
  let ran = 0;
  for (const id of ids) {
    if (SKIP.test(id)) continue;
    if (process.env.SMOKE_VERBOSE) console.log('…', id);
    errs = [];
    // Start each command from an open page in Split view, with nothing open on top.
    const state = await p.evaluate(() => {
      const ql = window.ql;
      try { ql.ui.hideBackstage?.(); } catch { /* */ }
      if (!ql.site || !ql.site.files.size) return 'nosite';
      if (!ql.active || ql.active.kind !== 'page') { const pg = ql.site.pages?.()[0]; if (pg) ql.openFile(pg.path); }
      return 'ok';
    }).catch((e) => 'error: ' + e.message);
    if (state !== 'ok') {
      // A command closed the site: start over with a fresh page load.
      await p.reload({ waitUntil: 'load' });
      await p.waitForFunction(() => window.ql && document.querySelector('.ql-tree-row'), null, { timeout: 30000 }).catch(() => undefined);
      errs = [];
    }
    const outcome = await p.evaluate(async (cid) => {
      try {
        const r = window.ql.exec(cid);
        if (r && typeof r.then === 'function') {
          // Commands that wait for a dialog stay pending until Escape below; do not wait for them.
          const t = await Promise.race([r.then(() => 'done', (e) => 'rejected: ' + (e?.message || e)), new Promise((res) => setTimeout(() => res('pending'), 600))]);
          return t;
        }
        return 'done';
      } catch (e) {
        return 'threw: ' + (e?.message || e);
      }
    }, id).catch((e) => 'evaluate failed: ' + e.message.split('\n')[0]);
    await p.waitForTimeout(120);
    for (let k = 0; k < 3; k++) {
      const open = await p.evaluate(() => !!document.querySelector('.ql-overlay, .ql-menu, .ql-palette')).catch(() => false);
      if (!open) break;
      await p.keyboard.press('Escape');
      await p.waitForTimeout(80);
    }
    const left = await p.evaluate(() => {
      const o = document.querySelectorAll('.ql-overlay');
      o.forEach((x) => x.remove());
      document.querySelectorAll('.ql-menu').forEach((x) => x.remove());
      return o.length;
    }).catch(() => 0);
    if (left) stuck.push(id);
    await p.waitForTimeout(40);
    ran++;
    if (/^(threw|rejected|evaluate failed)/.test(outcome) || errs.length) broken.push(`${id}: ${[/^(threw|rejected|evaluate)/.test(outcome) ? outcome : '', ...errs].filter(Boolean).join(' || ')}`);
  }
  console.log(`Commands: ${ids.length} registered, ${ran} run, ${skipped.length} skipped (${skipped.join(', ') || 'none'})`);
  if (stuck.length) warnings.push(`Dialogs that Escape did not close (${stuck.length}): ${stuck.join(', ')}`);
  if (broken.length) fail(`Commands that threw or logged errors (${broken.length}):\n  ${broken.join('\n  ')}`);
} finally {
  await browser.close();
  stopServer();
}

if (warnings.length) console.warn('Warnings:\n' + warnings.map((w) => '  ' + w).join('\n'));
if (failures.length) { console.error('E2E failures:\n' + failures.join('\n')); process.exit(1); }
console.log('E2E smoke test passed');
