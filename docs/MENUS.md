# Menus and command sources

Anne's Loom has two menu systems over one command library:

- **The Anne's Office ribbon** (Home, Insert, Design, Layout, Site, CMS & Builders, Check, Code, View, AI, Developer, Help, plus contextual Table, Picture, Form and Template tabs), the same shell as Anne's Pen, Anne's Grid and Anne's Stage, with the Quick Access Bar, command search (Alt+Q), Customize Tabs and Customize Keyboard.
- **A classic menu bar** laid out like the desktop web editors people learned. View ▸ Menus switches between ribbon, menu bar or both; View ▸ Classic Menu Layout picks the editor whose layout the bar follows.

Every entry in every layout is a command id in the registry, so a command found in the FrontPage-style *Format* menu is the same command as on the ribbon, can go on the Quick Access Bar, gets a shortcut, and records in macros. `src/ui/classicMenus.ts` holds the layouts; `tests/unit/catalog.test.ts` fails if any layout names a command that does not exist. Help ▸ Menu Map shows where a command lives in each layout.

## Layouts

| Layout | Modeled on | Menus |
|---|---|---|
| Expression Web style | Expression Web 1–4 | File, Edit, View, Insert, Format, Tools, Table, Site, Panels, AI, Window, Help |
| FrontPage style | FrontPage 2000, 2002, 2003 | File, Edit, View, Insert, Format, Tools, Table, Data, Frames, AI, Window, Help |
| Dreamweaver style | Dreamweaver MX through CC | File, Edit, View, Insert, Modify, Format, Commands, Site, Window, AI, Help |
| Composer style | Netscape/Mozilla/SeaMonkey Composer, Nvu, KompoZer, BlueGriffon | File, Edit, View, Insert, Format, Table, Tools, AI, Window, Help |
| All editors combined | the union of the four, merged menu by menu without duplicates | File, Edit, View, Insert, Format, Modify, Commands, Tools, Table, Data, Frames, Site, Panels, AI, Window, Help |

Product names are used only to say where an arrangement or idea comes from (nominative use). Labels inside the app are generic: *Page Template* and *Editable Region* rather than a vendor's trademark for them.

## Editors surveyed and what they contributed

| Editor | Commands and ideas carried into Anne's Loom |
|---|---|
| FrontPage | Folders, Navigation, Hyperlinks, Reports and Tasks views; site reports (summary, unlinked files, slow pages, broken hyperlinks, component errors, review status, assigned to, categories, publish status); shared borders; themes; link bars, page banner, table of contents, include page, scheduled include, substitution, hit counter, photo gallery, interactive buttons, marquee; Auto Thumbnail; Recalculate Hyperlinks; Publish Site; check in/out; frames pages; Data menu; layout tables; Fill Down/Right; table AutoFormat |
| Expression Web | Design/Split/Code views; Quick Tag Selector and Quick Tag Editor; Tag Properties, CSS Properties, Apply Styles, Manage Styles, Toolbox, Behaviors, Layers, Snippets, Find, Accessibility, Compatibility and CSS Reports panels; Visual Aids and Formatting Marks; ruler, grid and tracing image; page size; style application modes (auto/manual, inline/classes); New Style dialog; attach/detach style sheets; page templates with editable regions (Attach, Detach, Update attached pages, Manage editable regions); Optimize HTML; publishing destinations; SuperPreview-style side-by-side preview |
| Dreamweaver | Live view/Code and Design; Select Parent/Child Tag; Balance Braces; code collapse; Apply Source Formatting; code hints; Clean Up HTML and Clean Up Word HTML; Externalize JavaScript; templates with editable, optional and repeating regions, nested templates, template parameters, Export without markup; library items; Insert Image Objects (placeholder, rollover); media queries; web fonts; AP elements (absolutely positioned layers) with align/same size/prevent overlaps; Modify ▸ Image (crop, resample, brightness/contrast, sharpen, optimize); Get/Put/Synchronize; Check Links Sitewide; Change Link Sitewide; design-time style sheets; Design Notes; commands recording; Create Web Photo Album; Sort Table; Format Table |
| Composer, Nvu, KompoZer, BlueGriffon | Normal / HTML Tags / Source / Preview edit modes (Reveal Tags), Publish and Publish As with site settings, Save As Charset, Export as Text, Paste Without Formatting, Remove All Text Styles, Remove Links, Remove Named Anchors, Page Colors and Background, Page Title and Properties, CSS editor, Markup Cleaner, Break Below Images, smileys, MathML |
| HomeSite and other code editors | CodeSweeper-style formatting, Validate Document, Verify Links, snippets, tag inspector, upper/lower case tags |
| GoLive, NetObjects Fusion, Contribute | site structure editing, components, publish profiles |
| Modern builders (Bootstrap Studio, Pinegrow, Mobirise, Nicepage, Webflow, Brackets) | components (navbar, hero, cards, pricing, testimonials, carousel, tabs, accordion, modal, lightbox, timeline, countdown, cookie banner), framework links (Bootstrap, Tailwind, Pico, Bulma, Foundation, Alpine, Font Awesome, Google Fonts), responsive page sizes, Emmet abbreviations, CSS variables, flexbox and grid dialogs, SEO and performance checks, sitemap.xml, robots.txt, RSS, client-side search index |
| Content systems (WordPress, Weebly, Wix, Joomla, Jekyll, Hugo) | the CMS & Builders tab: import and export of their formats (see README) |

## What is not reproduced

Some menu commands depended on server software that no longer exists or never ran on static hosts. They are present where a sensible modern equivalent exists and say so when invoked:

- FrontPage Server Extensions components (hit counter, form handlers with server-side results, discussion webs, Top 10 lists): replaced by static equivalents or a note; forms can post to any form-handler URL.
- SharePoint Data View and Web Part connections: the Data menu builds tables, lists and cards from CSV, JSON and XML files in the site instead.
- ASP.NET controls, Silverlight, and server database connections: not supported; PHP, SSI, ASP, JSP, Handlebars and Liquid snippets can be inserted and edited as code.
- Flash, Shockwave, Java applets and ActiveX: markup can be inserted and edited, with a warning that browsers no longer run them.
- Photoshop layer import: flattened pictures can be imported; layered .psd files are not read.
