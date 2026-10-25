# Architecture

Anne's Loom is a TypeScript web application (Vite). The desktop release wraps the same build in Electron. It reuses the Anne's Office suite's shell (ribbon, Quick Access Bar, backstage, dialogs, customization, AI layer) from Anne's Stage and adds a web-site editing core.

```
src/
  main.ts                 entry: registry, App + Shell, first site, launch files, service worker
  app.ts                  App (one open Site, PageTab tabs, exec(), commit()/editSource(), undo history, autosave)
  prefs.ts                per-device preferences (QAT, custom tabs, keymap, macros, editor options, menu style)
  model/
    paths.ts              site paths: resolveRef(), relativeRef(), mimeOf(), isPagePath()…
    site.ts               Site: files keyed by path, write/remove/rename (with link fix-up), nav tree, tasks,
                          publish profiles, .qlsite JSON; rewriteRefs()/linksOf() link scanner
    html.ts               source-level HTML: regions, bodyInner/replaceBody, head insert, title/meta/doctype/charset,
                          linked styles/scripts, formatHtml(), minifyHtml(), toXhtml(), htmlToText()
  site/
    templates.ts          page templates (.dwt, both marker dialects) and library items (.lbi); SSI/include expansion
    io.ts                 ZIP read/write, .qlsite, folders (File System Access API / desktop bridge / webkitdirectory)
  editor/
    workspace.ts          PageView: Design / Split / Code / Preview for one tab, Quick Tag Selector, mode bar, sync
    designView.ts         editable sandboxed iframe (no scripts), selection box, visual aids, AP-element drag
    codeView.ts           CodeMirror 6 wrapper (HTML/CSS/JS/PHP/XML)
    resources.ts          site files shown through blob:/data: URLs; originals kept in data-ql-o-* attributes
    ops.ts                helpers for commands (insertHtml, wrapTag, mutate, setAttr, setStyleProp, selectedEl…)
  commands/
    registry.ts           Command interface and registry (single source for ribbon, menus, QAT, keys, macros, search)
    *.ts                  command modules, auto-registered by commands/index.ts (import.meta.glob)
  ui/
    shell.ts              title bar, QAT, classic menu bar, tabs + ribbon, doc tabs, left/right panes, status bar,
                          command palette, Design view context menu, Quick Tag menu
    ribbonLayout.ts       default ribbon tabs and groups (command ids only)
    classicMenus.ts       classic menu bars: Expression Web, FrontPage, Dreamweaver, Composer families, and the union
    panes.ts              pane registry (registerPane) and the Folder List
    backstage.ts          File screen
    dialog.ts, dom.ts     dialogs, menus, toasts, color pickers; h() DOM builder
    customize.ts          Customize QAT / Tabs / Keyboard
    aiWizard.ts           AI provider setup wizard
  ai/                     providers, key store, client (OpenAI-compatible, Anthropic, Gemini, built-in, on-device), ensembles
  io/                     importers/exporters for other systems (WordPress, Weebly, Wix, Joomla, MHTML, templates…)
  templates/              built-in page and site templates (original work)
  platform/native.ts      desktop bridge (window.quillDesktop) and browser fallbacks; desktopFolders for site folders,
                          preview origin and FTP
electron/                 desktop main process and preload
```

## Key design decisions

- **The file text is the document.** Each open tab mirrors one site file. Code view edits it directly. Design view edits only the `<body>`; its DOM is serialized back into the body region of the text (`replaceBody`), so the doctype, head, comments and server code outside the body survive exactly as written. Head changes (title, meta, style sheets) are made on the text (`model/html.ts`).
- **One undo history per tab** of whole-text snapshots (`App.commit`). Typing coalesces. Commands that change text call `app.editSource(label, fn)`; commands that change the Design view DOM call `mutate(app, fn)` (editor/ops.ts) which flushes into one step.
- **Design view runs no scripts.** It is an iframe with `sandbox="allow-same-origin"`. Preview is a separate sandboxed iframe (`allow-scripts`, opaque origin) with every site resource inlined as data: URLs, so page scripts can never reach the editor's storage. The desktop app serves previews from a separate origin because a srcdoc frame would inherit the app's content security policy.
- **Resource links** inside Design view point at blob: URLs of site files. The original value is kept in `data-ql-o-<attr>`; use `setAttr()`/`getAttr()`/`setStyleProp()` from editor/ops.ts, never set `src`/`href`/`style` directly on Design view elements.
- **Commands are data.** The ribbon, classic menus, QAT, context menus, shortcuts, macros and search all refer to command ids.
- **Renames fix links.** `Site.rename()` rewrites every link to the moved file across pages and style sheets, as desktop site editors do.

## Writing a command module

```ts
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { insertHtml, wrapTag, mutate, selectedEl, isPage, inDesign } from '../editor/ops';

def([
  { id: 'insert.hr', label: 'Horizontal Line', icon: 'horizontal_rule', tab: 'Insert', group: 'Text', edits: true,
    origin: 'FrontPage, Dreamweaver', isEnabled: isPage, run: (app) => insertHtml(app, '<hr>') },
]);
```

- `tab` is the ribbon tab name ('Home', 'Insert', 'Design', 'Layout', 'Site', 'CMS & Builders', 'Check', 'Code', 'View', 'AI', 'Developer', 'Help', 'Backstage' for File, or a contextual tab: 'Table Layout', 'Table Design', 'Picture', 'Form', 'Template'); commands that appear only in the classic menus use the closest tab.
- `kind`: 'button' (default) | 'toggle' (with `isActive`) | 'menu' (with `menu()` returning MenuEntry[]; picking an entry runs `entry.id` with `entry.arg`) | 'split' | 'font' | 'size' | 'color' | 'gallery' | 'combo'.
- `edits: true` for commands that change the site; `noRecord: true` for UI-only commands (not recorded in macros).
- `origin`: where the idea comes from, nominative ("FrontPage", "Dreamweaver", "Expression Web", "KompoZer"). Interface labels use generic names.
- `run(app, arg)`: `arg` comes from menus and macros; when it is undefined, ask with a dialog.
- Every id named in `ui/classicMenus.ts` and `ui/ribbonLayout.ts` must exist in the registry (`tests/unit/catalog.test.ts`).

Dialogs: `openDialog({ title, fields: [{ key, label, type: 'text'|'number'|'select'|'checkbox'|'color'|'textarea'|'radio'|'range'|'list'|'info'|'heading'|'combo'|'file'|'button', value, options }], onChange, wide, content, help })` resolves to the values or null. Also `toast(msg)`, `confirmDialog`, `promptDialog`, `choiceDialog`, `alertDialog`, `showMenu`, `colorMenu`.

Panes: `registerPane({ id, title, side: 'left' | 'right', render(app, el), update(app, el) })`; open with `app.ui.togglePane(id)`. `update` runs on every refresh; guard with `sigOf(el, signature)` and `typingIn(el)`.
