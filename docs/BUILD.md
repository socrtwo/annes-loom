# Building QuillLoom

All platforms share one web build (`npm run build` → `dist/`). The desktop app wraps it in Electron.

| Platform | Wrapper | Command | Builds on |
|---|---|---|---|
| Web / PWA | none | `npm run build` | anything with Node 22 |
| Windows, macOS, Linux, Raspberry Pi OS | Electron (`electron/`) | `npm run desktop:dist` | the target OS (macOS builds need a Mac) |
| Android, iOS / iPadOS | not set up yet | — | — |

QuillLoom has no Android or iOS project yet (no `android/` or `ios/` folders), so there is no APK or IPA. On phones and tablets, install the web app from the browser. The platform bridge (`src/platform/native.ts`) already has the Capacitor code paths that the other Quill apps use, so adding those projects later is mostly configuration.

**Releases:** run the **Release** workflow (Actions tab ▸ Release ▸ Run workflow), push a tag `v<version>`, or push a commit whose message contains `[release]` (published as a prerelease). GitHub Actions builds the web app and the desktop apps and publishes them as one release with `SHA256SUMS.txt` (`.github/workflows/release.yml`). The file names follow the pattern the other Quill apps use, so the QuillOffice suite can bundle QuillLoom once it is included there.

## Checks

```bash
npm run typecheck                            # tsc --noEmit
npm test                                     # vitest unit tests
node --test tests/e2e/desktop-ftp.test.mjs   # the desktop FTP/FTPS client against a local fake server
npm run build                                # production web build
npm run e2e                                  # browser smoke test of the build (Playwright + Chromium)
```

CI (`.github/workflows/ci.yml`) runs all of these on every push and pull request and keeps the built `dist/` as an artifact.

The smoke test (`tests/e2e/smoke.mjs`) serves `dist/` with `vite preview` on port 4173, or tests `BASE_URL` when it is set. It checks the ribbon, the classic menu bar, the Folder List, the four page views and Code-to-Design sync, then runs every registered command and reports any that throw. `SMOKE_ONLY=<regex>` limits the command run; `SMOKE_VERBOSE=1` prints each command. It uses Playwright's Chromium (`CHROMIUM_PATH` or `/opt/pw-browsers` when present; otherwise run `npx playwright install chromium` once).

## Prerequisites

- Node.js 22 (`node -v`), then `npm ci` in the repository.
- For desktop packages: the Electron binary, which `npm ci` downloads. If you installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, run `node node_modules/electron/install.js` before `npm run desktop`.

## Web

```bash
npm ci
npm run build        # dist/ (also writes public/third-party-notices.txt)
npx vite preview     # http://localhost:4173
```

`dist/` is a static site: copy it to any web server. Served over HTTPS, the service worker (`public/sw.js`) makes it work offline and Chrome and Edge offer to install it as an app.

## Desktop (Windows, macOS, Linux, Raspberry Pi OS)

```bash
npm run desktop        # build and run the desktop app
npm run desktop:dist   # build installers for this OS into release/
```

`desktop:dist` builds what the current OS can make:
- Windows: the NSIS installers (x64, arm64) and the portable `.exe`.
- macOS: a universal `.dmg` and `.zip`.
- Linux: an AppImage and a `.deb` for x64, arm64 and armv7l (Raspberry Pi OS 32-bit).

For one target only:

```bash
npm run build && node scripts/prepare-desktop.mjs
npx electron-builder --config electron-builder.config.cjs --linux deb --arm64
```

`scripts/prepare-desktop.mjs` stages `build/desktop-app/` (the web build, `electron/main.cjs`, `preload.cjs`, `ftp.cjs`, the window icon and a dependency-free `package.json`). Before packaging, CI checks the staged scripts with `node --check`.

### What the desktop app adds

The main process (`electron/main.cjs`) serves `dist/` from the `app://quillloom` origin and exposes `window.quillDesktop` through the preload script. Beyond what the browser offers, it provides:

- **Site folders**: Open Site reads a whole folder (skipping `.git`, `node_modules`, `_vti_cnf`, `_vti_pvt`, `__MACOSX`, `.DS_Store`, `Thumbs.db`; up to 20,000 files and about 500 MB). Saving writes files back into that folder. Only folders the user picked in a dialog can be written; paths are checked so that they stay inside the folder (no absolute paths, `..`, or symbolic links that lead out), and nothing is written into `.git`.
- **Preview origin**: Preview view loads pages from `preview://p/…`, a separate origin with its own permissive content security policy, so page scripts run as in a browser but cannot reach the app's storage.
- **FTP publishing** (`electron/ftp.cjs`): plain FTP or explicit FTPS (AUTH TLS, protected data connections), passive mode, nested folders. It has no dependencies. Certificates are verified, and the password never appears in the log.
- File associations for web pages, style sheets, scripts, PHP pages, Dynamic Web Templates, `.qlsite` sites and web archives.

## Icons

`node scripts/gen-icons.mjs` renders `resources/icon.svg` (the QuillLoom icon: woven threads with a gold quill) to `resources/icon-1024.png` (installers), `resources/icon-512.png` (desktop window), `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` and `apple-touch-icon.png`, and copies it to `public/favicon.svg`. It uses Playwright's Chromium (`CHROMIUM_PATH` overrides it). The SVG must keep its `<rect id="bg">` background and `<g id="art">` artwork group, which the script uses to make the full-bleed and maskable variants.

## Command reference

`npm run catalog` regenerates the command reference from the command registry.
