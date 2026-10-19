/**
 * Built-in starting points. Page templates add one page (and any style sheet it needs) to the open site;
 * site templates create a whole new site. Every template is original work, MIT-licensed with the app:
 * plain modern CSS (no framework), system fonts, and placeholder pictures drawn as SVG.
 */
export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  kind: 'page' | 'site';
  category: string;
  /** Files keyed by site path. Page templates use "{page}" in a path for the new page's name. */
  files: () => Record<string, string>;
  /** File to open after creating. */
  open: string;
  /** Small preview (CSS background) for the gallery. */
  swatch?: string;
  /** Where the idea comes from (shown in the gallery and the command reference). */
  origin?: string;
}

import { SITE_TEMPLATES } from './sites';
import { PAGE_TEMPLATES } from './pages';

export const TEMPLATES: TemplateDef[] = [...PAGE_TEMPLATES, ...SITE_TEMPLATES];

export function templateById(id: string): TemplateDef | undefined { return TEMPLATES.find((t) => t.id === id); }

export const pageTemplates = (): TemplateDef[] => TEMPLATES.filter((t) => t.kind === 'page');
export const siteTemplates = (): TemplateDef[] => TEMPLATES.filter((t) => t.kind === 'site');
