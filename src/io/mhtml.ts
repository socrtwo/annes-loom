/** STUB — MHTML (.mht/.mhtml) web archives. */
import type { Site } from '../model/site';

export function isMhtml(text: string): boolean { return /^(?:[\s\S]{0,2000}?)Content-Type:\s*multipart\/related/i.test(text); }
export function parseMhtml(bytes: Uint8Array): { html: string; files: Map<string, Uint8Array>; title?: string } { void bytes; throw new Error('Not implemented yet'); }
export function buildMhtml(site: Site, pagePath: string): string { void site; void pagePath; throw new Error('Not implemented yet'); }
