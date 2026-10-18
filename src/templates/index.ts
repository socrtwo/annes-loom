/**
 * Built-in starting points. Page templates add one page (and any style sheet it needs) to the open site;
 * site templates create a whole new site. Every template is original work, MIT-licensed with the app.
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
}

import { blankPage } from '../model/html';

export const TEMPLATES: TemplateDef[] = [
  { id: 'blank', name: 'Blank Page', description: 'An empty HTML5 page', kind: 'page', category: 'General', open: '{page}', files: () => ({ '{page}': blankPage({ title: 'Untitled' }) }), swatch: '#fff' },
];

export function templateById(id: string): TemplateDef | undefined { return TEMPLATES.find((t) => t.id === id); }
