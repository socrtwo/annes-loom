# Clean-room, trademark and licensing notes

This file records how QuillLoom will provide a complete presentation command set while avoiding other vendors' trademarks and copyrights. It summarizes the project's practice, the same practice QuillPen and QuillGrid follow; it is not legal advice. QuillLoom has no code yet, so this file states the rules the code will be written under.

## What is reproduced, and why it is safe

- **Functionality and command names.** Presentation operations (New Slide, Duplicate Slide, Slide Master, Rehearse Timings, Presenter View, Fade transition, Fly In animation) are functional ideas. Their names are ordinary descriptive words used across the industry. Functionality is not protected by copyright, and descriptive terms are not trademarks for those functions.
- **Tab and group organization.** Grouping commands under tabs such as Home, Insert, Design, Transitions, Animations and Slide Show is a common, functional arrangement. QuillLoom's grouping, ordering, labels, tooltips and descriptions are written for this project.
- **Keyboard shortcuts.** Long-standing shortcuts (F5 to start a show, Ctrl+M for a new slide) are functional conventions users rely on; all of them can be rebound.
- **File formats.** .pptx (ECMA-376 / ISO/IEC 29500 Office Open XML, PresentationML and DrawingML), .odp (ISO/IEC 26300 OpenDocument), the legacy binary .ppt format (published by Microsoft as the [MS-PPT] and related Open Specifications), PDF (ISO 32000), Markdown and HTML are public specifications. The converters will be written from those specifications and tested with open-source tools (LibreOffice) and files produced by the project.
- **Visual effects.** Transitions and animations are described by the file formats (each effect has a name and parameters in the specification) and are implemented from those descriptions, not by copying another program's code or assets.

## What is deliberately not reproduced

- No vendor logos, icons, splash screens, color schemes or trade dress. Command icons will be Google's Material Symbols (Apache 2.0). The app icon and visual design are original.
- No vendor product names in the app's own name or interface. Trademarked or brand-specific feature names are replaced with generic terms:

| Vendor term | QuillLoom term |
|---|---|
| PowerPoint (as a feature or format name in menus) | "PowerPoint Presentation (.pptx)" only in file-type lists, to identify the format |
| WordArt | Decorative Text |
| SmartArt | Diagram |
| Designer / Design Ideas (PowerPoint), Magic Design (Canva) | Design Ideas (generic description) |
| Morph (PowerPoint), Magic Move (Keynote) | Smooth Morph |
| Zoom (Summary Zoom, Section Zoom, Slide Zoom) | Zoom links (generic) |
| Cameo | Live Camera |
| Presenter Coach / Rehearse with Coach | Rehearsal Coach |
| Recording Studio | Record tab |
| Live Presentations / Present Live, Keynote Live | Audience Link, Broadcast Show |
| Instant Alpha | Remove Color |
| Package for CD, Pack and Go, Show on the Go | Package Presentation |
| Smart Lookup | Look Up |
| Tell Me / Search | Search Commands |
| Copilot and other assistant brand names | AI tab |
| Prezi, Sway | Canvas mode, Story (generic descriptions) |
| Mentimeter, Slido | Poll, Word Cloud, Quiz, Audience Q&A |
| Ribbon | Tabs / ribbon used generically |

- No copied help text, tooltips, templates, themes, sample decks, clip art, sounds, stock photos or dictionaries. Themes, layouts, content starters, transition sounds and sample text will be original. Online picture search will use openly licensed collections and record each image's license and attribution.
- No proprietary fonts are bundled. Decks that name Calibri, Cambria, Times New Roman, Arial, Courier New, Georgia or Garamond render with metric-compatible open fonts: Carlito, Caladea, Tinos, Arimo, Cousine, Gelasio and EB Garamond (SIL OFL / Apache 2.0). A locally installed original is preferred when present; fonts embedded in a .pptx are used only as their embedding permissions allow.
- No reading of undocumented proprietary formats beyond what is needed to identify them. Keynote and Prezi files are not opened (see [INNOVATIONS.md](INNOVATIONS.md), *Considered and skipped*).
- VBA projects in .pptm files are preserved byte for byte and never executed.

## Nominative use

QuillLoom's documentation names other products (Microsoft PowerPoint, Apple Keynote, Google Slides, LibreOffice Impress, Prezi, Canva, Sway, Pitch, Gamma, Tome, Ludus, Mentimeter, Slido, Zoho Show, WPS Presentation, Focusky, Harvard Graphics, Aldus Persuasion, Lotus Freelance Graphics, Corel Presentations, Astound, ShowPartner, Microsoft Producer, reveal.js, Marp, Slidev, Beamer, KineMaster, Freeform, Miro, Whimsical and others) only to identify file formats or to credit where an idea came from ("Build Order panel, inspired by Keynote"). This is nominative use; it does not imply affiliation, sponsorship or endorsement. The names are trademarks of their respective owners, including:

- PowerPoint, Microsoft 365, Sway and Microsoft Producer are trademarks of Microsoft Corporation.
- Keynote, Freeform and iWork are trademarks of Apple Inc.
- Google Slides is a trademark of Google LLC.
- LibreOffice is a trademark of The Document Foundation.
- Prezi, Canva, Pitch, Gamma, Tome, Ludus, Mentimeter, Slido, Zoho, WPS, Focusky, KineMaster, Miro and Whimsical are trademarks of their respective owners.
- Pecha Kucha (PechaKucha) and Ignite are names of presentation formats and event series owned by their respective organizers; QuillLoom's *Timed Format* presets describe the formats' timing only.

## Third-party components (planned)

The final list will be generated from `package.json` into a third-party notices file at build time, as in the sister apps. Only permissive licenses are accepted:

| Component | License |
|---|---|
| JSZip | MIT (dual MIT/GPLv3; used under MIT) |
| nspell, hunspell-asm | MIT |
| SCOWL English dictionaries | MIT and BSD-style |
| Other Hunspell dictionaries (downloaded on request) | as listed per dictionary in the Spelling Dictionaries wizard; only freely redistributable licenses |
| KaTeX | MIT |
| Material Symbols | Apache 2.0 |
| Capacitor, Electron, electron-builder | MIT |
| Transformers.js (on-device AI) | Apache 2.0; each model's own license is shown before download |
| Fonts: Carlito, Caladea, Gelasio, EB Garamond, Courier Prime, Libre Baskerville, Lato, Merriweather, Open Sans | SIL Open Font License 1.1 |
| Fonts: Tinos, Arimo, Cousine | Apache 2.0 |

## Online services

QuillLoom will work offline. Online services are called only when the user invokes the matching command: the chosen AI provider (AI tab), on-device model downloads (Hugging Face Hub), dictionary downloads (Review ▸ Spelling Dictionaries), openly licensed picture search (Insert ▸ Online Pictures), the thesaurus service, web search and translation (opened in the browser or sent to the chosen AI provider), and, for audience features, phone remote and broadcast, the signaling relay the user configures.
