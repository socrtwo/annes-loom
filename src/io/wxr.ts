/** STUB — WordPress eXtended RSS (WXR) import and export. */
import type { Site } from '../model/site';

export function isWxr(text: string): boolean { return /<rss[^>]+xmlns:wp=/i.test(text.slice(0, 4000)); }
export function wxrToSite(xml: string, opts: { name?: string } = {}): { site: Site; report: string[]; open?: string } { void xml; void opts; throw new Error('Not implemented yet'); }
export function siteToWxr(site: Site, opts: { siteUrl?: string; author?: string; postType?: 'page' | 'post' } = {}): string { void site; void opts; throw new Error('Not implemented yet'); }
