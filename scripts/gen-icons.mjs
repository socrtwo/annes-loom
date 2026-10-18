#!/usr/bin/env node
// Renders the QuillLoom icon (resources/icon.svg) to every size the platforms need:
//   resources/icon-1024.png                desktop installers (electron-builder derives .ico and .icns from it)
//   resources/icon-512.png                 desktop window icon (scripts/prepare-desktop.mjs copies it)
//   public/icons/icon-192.png, icon-512.png
//                                          web app manifest, purpose "any" (PWA, ChromeOS)
//   public/icons/icon-maskable-512.png     web app manifest, purpose "maskable": full bleed, with the artwork
//                                          inside the central safe circle so that every mask shape keeps it
//   public/icons/apple-touch-icon.png      iOS home-screen bookmark (180x180, opaque, square; iOS rounds it)
//   public/favicon.svg                     a copy of resources/icon.svg
// resources/icon.svg must keep its structure: a background <rect id="bg" … rx="…"/> and the artwork in <g id="art" …>.
// Usage: node scripts/gen-icons.mjs   (uses Playwright's Chromium; CHROMIUM_PATH overrides the browser)
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rounded = readFileSync(join(root, 'resources/icon.svg'), 'utf8');
if (!/<rect id="bg"[^>]*\srx="[\d.]+"/.test(rounded) || !/<g id="art"/.test(rounded)) throw new Error('resources/icon.svg needs <rect id="bg" rx="…"> and <g id="art">');

// Opaque, full-bleed square (the platform applies its own mask).
const square = rounded.replace(/(<rect id="bg"[^>]*\s)rx="[\d.]+"/, '$1rx="0"');
// Maskable: the artwork shrunk into the safe zone (a circle of 80% of the width).
const maskable = square.replace(/<g id="art"([^>]*)>([\s\S]*)<\/g>(\s*<\/svg>)/, '<g transform="translate(256 256) scale(0.8) translate(-256 -256)"><g id="art"$1>$2</g></g>$3');

/** Playwright's Chromium: CHROMIUM_PATH, /opt/pw-browsers/chromium, or chrome-linux/chrome in a versioned chromium folder under /opt/pw-browsers. */
function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'];
  try {
    for (const d of readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) cands.push(join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
  } catch { /* not there */ }
  return cands.find((p) => p && existsSync(p) && statSync(p).isFile());
}

const exe = findChromium();
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
// [size, output, source, transparent background?]
const outputs = [
  [1024, 'resources/icon-1024.png', rounded, true],
  [512, 'resources/icon-512.png', rounded, true],
  [512, 'public/icons/icon-512.png', rounded, true],
  [192, 'public/icons/icon-192.png', rounded, true],
  [512, 'public/icons/icon-maskable-512.png', maskable, false],
  [180, 'public/icons/apple-touch-icon.png', square, false],
];
try {
  for (const [size, rel, svg, transparent] of outputs) {
    const out = join(root, rel);
    mkdirSync(dirname(out), { recursive: true });
    await page.setViewportSize({ width: size, height: size });
    const sized = svg.replace(/\swidth="[\d.]+"/, ` width="${size}"`).replace(/\sheight="[\d.]+"/, ` height="${size}"`);
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:${transparent ? 'transparent' : '#2E6B5E'}}svg{display:block}</style></head><body>${sized}</body></html>`);
    await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', rel);
  }
} finally {
  await browser.close();
}
writeFileSync(join(root, 'public/favicon.svg'), rounded);
console.log('wrote public/favicon.svg');
