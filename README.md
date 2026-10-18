# QuillLoom

*Part of the Quill suite: [QuillPen](https://github.com/socrtwo/QuillPen) (documents), [QuillGrid](https://github.com/socrtwo/QuillGrid) (spreadsheets), [QuillPost](https://github.com/socrtwo/QuillPost) (email), [QuillStage](https://github.com/socrtwo/QuillStage) (presentations) and **QuillLoom** (web sites).*

An original, open-source web site editor in the tradition of the desktop WYSIWYG editors: Design, Split, Code and Preview views over real HTML files, whole-site management, page templates with editable regions, reports, and publishing. It has the Quill suite's ribbon with the Quick Access Bar and an **AI tab**, and, for people who learned the older editors, a **classic menu bar** laid out like Expression Web, FrontPage, Dreamweaver or KompoZer/BlueGriffon (or all of them combined).

- **946 commands**: the union of the menu commands of the desktop web editors, plus modern ones. Every command can go on the Quick Access Bar, on your own ribbon tab, on a shortcut, or into a macro, and command search (Alt+Q) finds any of them. See [docs/MENUS.md](docs/MENUS.md).
- **Ribbon, classic menus, or both** (View ▸ Menus). Classic layouts: Expression Web style, FrontPage style, Dreamweaver style, Composer style, or all editors combined.
- **WordPress, Weebly and Wix**, as a non-canonical editor: import and export their formats (below).
- **Web templates**: imports free and paid templates from ZIP files, including nested ZIPs and templates inside a documentation package.

## Editing

- **Design view**: edit the page visually. The **Quick Tag Selector** above the page shows where you are and edits, wraps or removes tags. Design view runs no scripts.
- **Code view**: syntax coloring for HTML, CSS, JavaScript, PHP and XML, code folding, completion, abbreviation expansion (Emmet-style: `ul>li.item*3` then Tab), bookmarks and unmatched-tag highlighting.
- **Split view**: both at once, side by side or stacked.
- **Preview**: runs the page's scripts in a sandbox, and links between site pages work inside it. The page-size menu covers phone, tablet and desktop widths.
- **Visual aids**: block outlines, CSS layout boxes, empty containers, margins, invisible elements, template regions, rulers, grid and a tracing image.
- **Panels**: Folder List, Navigation, Tag Properties, CSS Properties, Toolbox, Apply Styles, Manage Styles, Behaviors, Layers, Snippets, Assets, Find, Hyperlinks, Tasks, Reports, Accessibility, Compatibility, Validation, CSS Reports, History, Outline and an AI assistant.
- **Styles**:
  - New Style and Modify Style dialogs, with the style written inline or as classes.
  - Attach a style sheet to one page or many, move rules between sheets, and turn inline styles into rules.
  - Media queries, web fonts, CSS variables, and design-time style sheets that apply only in Design view.
- **Pages**: tables with merge, split and sort; forms with every input type; behaviors written as plain JavaScript; frames; data views built from CSV, JSON or XML files; over 30 ready-made components (navigation bar, hero, cards, pricing, gallery, tabs and more); framework links for Bootstrap, Tailwind, Pico, Bulma and others.
- **Pictures**: crop, resample, rotate, brightness, sharpen, convert to WebP, Auto Thumbnail, responsive sizes and image maps, all in the browser.
- **Page templates (.dwt)**: these work the way the older editors' templates did.
  - Both marker styles are read and written: FrontPage/Expression `#BeginEditable` and Dreamweaver `InstanceBeginEditable`.
  - Editable, optional and repeating regions, template parameters, and templates nested inside templates.
  - Attach, Detach, Update Attached Pages. Library items (.lbi), and server-side includes expanded in Preview.

## Site

- **Folders**:
  - Open a folder and edit it in place. This works in the desktop app and in Chromium browsers; other browsers can read a folder but save to ZIP or `.qlsite` instead.
  - Renaming or moving a file fixes every link to it across the site.
- **Reports** (25), including: site summary, unlinked files, slow pages, broken links, missing alt text, duplicate titles, unused styles, component errors, review status and publish status.
- **Checks**:
  - An HTML5 checker that reports line numbers, plus accessibility (WCAG 2.2), browser compatibility, SEO and page performance.
  - Offline spelling, with a thesaurus.
  - Clean up Word HTML and Optimize HTML.
- **Navigation, tasks and team work**: a navigation tree, with link bars and breadcrumbs that rebuild when it changes. Also tasks, and check in/check out.
- **Generators**: sitemap.xml, robots.txt, an RSS feed and a search index.
- **Publishing**: to a ZIP, a folder, WebDAV, FTP/FTPS (desktop app), GitHub Pages, or WordPress. Only changed files are sent by default, and there is a publish log.

## WordPress, Weebly, Wix and other systems

QuillLoom does not run these services. It reads and writes their files, so you can edit a site here and move it back:

| System | Import | Export |
|---|---|---|
| WordPress | Export file (WXR .xml): pages, posts, hierarchy, menus. Classic and block themes become static pages and a page template. Live sites through the REST API. | WXR file for WordPress's importer; a classic theme ZIP built from your design; block markup for one page; publish pages and posts through the REST API with an application password. |
| Weebly | Site archive ZIP; custom theme ZIP (`{content}`, `{menu}` and the other tags). | Custom theme ZIP. |
| Wix | Published pages by web address. The desktop app can fetch any site; browsers only sites that allow cross-site requests (CORS). Otherwise save the page as a single-file web page (.mht) and import that. Wix has no file export of its own. | Self-contained page for Wix's "Embed HTML" element, or a custom-element script for Velo. |
| Joomla, Drupal | Templates and themes become static pages and a page template. | — |
| Jekyll, Hugo, static hosts | — | Layouts with front matter, or a plain static ZIP. |
| HTML/CSS templates | ZIPs from free sources (HTML5 UP, Start Bootstrap, BootstrapMade, Colorlib and others) and paid marketplaces, and exports from Mobirise, Nicepage, Bootstrap Studio and Pinegrow. | — |
| Other | MHTML (.mht), Word HTML, Markdown. | MHTML. |

File ▸ Import ▸ Web Template detects what a ZIP holds. Imported PHP and JavaScript are never run, and every import ends with a report of what was converted and what was left out. Template licenses are the template authors': paid templates are licensed to their buyer.

## AI

The AI tab can:

- generate pages, whole sites and sections (including a page from a sketch);
- rewrite, shorten, translate or proofread selected text while keeping its markup;
- explain, fix, refactor or modernize code;
- make a page responsive;
- write meta tags, alt text, structured data, FAQs, privacy policies and 404 pages;
- review a page;
- chat about the page in the AI pane.

Every result is shown for editing before it is applied, and it applies as one undoable step.

Providers are the same as the rest of the suite: a free on-device model, free tiers (OpenRouter, Gemini, Groq, Mistral and others), local servers (Ollama, LM Studio), or paid keys (OpenAI, Anthropic and others). You can also send one request to several AIs, which either combine their answers or deliberate to a consensus. Nothing is sent until you use an AI command.

## Build

```bash
npm ci
npm run dev          # http://localhost:5173
npm run typecheck
npm test             # unit tests (vitest)
npm run build        # dist/
npm run desktop      # Electron desktop app; desktop:dist builds installers
npx vite preview --port 4173 & BASE_URL=http://localhost:4173 node tests/e2e/smoke.mjs   # runs every command in Chromium
```

See [docs/BUILD.md](docs/BUILD.md), [docs/INSTALL.md](docs/INSTALL.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limitations

- **Design view formatting**: edits made in Design view re-serialize the page body, so formatting inside the body can change. The doctype, the head, and everything outside the body are kept exactly as written. Code view edits are always kept exactly.
- **Server-side features**: there are no server databases, ASP.NET controls, or FrontPage Server Extensions components. Each has a static equivalent or a note; see docs/MENUS.md.
- **Browser limits**:
  - FTP needs the desktop app, and SFTP is not supported (use FTPS).
  - Fetching other sites and checking external links depend on CORS in browsers; the desktop app has no such limit.
  - Writing folders in place needs the desktop app or a Chromium browser.
- **Mobile**: Android and iOS packages are not set up yet. The web build works on phones and can be installed as an app from the browser.

## Legal

QuillLoom is an independent, clean-room project under the MIT License. It is not affiliated with, endorsed by, or sponsored by Microsoft, Adobe, Mozilla, Automattic or the WordPress Foundation, Square (Weebly), Wix.com, or any other vendor. Product names appear only to describe file-format compatibility or where a feature's idea comes from (nominative use). The interface, templates, icons and text are original or openly licensed. See [docs/LEGAL.md](docs/LEGAL.md).
