/** STUB — replaced by the CMS/templates importer work. Detects what a ZIP holds and turns it into a site. */
import type { Site } from '../model/site';

export type ArchiveKind = 'wp-theme' | 'joomla-template' | 'weebly-theme' | 'weebly-archive' | 'drupal-theme' | 'html-template' | 'site';

export function detectArchive(files: Map<string, Uint8Array>): ArchiveKind { void files; return 'site'; }

export async function siteFromArchive(name: string, files: Map<string, Uint8Array>, kind?: ArchiveKind): Promise<{ site: Site; report: string[]; open?: string }> {
  void name; void files; void kind;
  throw new Error('Not implemented yet');
}
