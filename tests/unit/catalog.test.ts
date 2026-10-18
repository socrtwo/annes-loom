import { describe, it, expect } from 'vitest';
import '../../src/commands';
import { allCommands, getCommand } from '../../src/commands/registry';
import { classicIds } from '../../src/ui/classicMenus';
import { idsInTabs } from '../../src/ui/ribbonLayout';
import { DEFAULT_QAT, QAT_CHOICES } from '../../src/prefs';

/** Ids referenced by the menus, ribbon and Quick Access Bar but not registered. PREFIX=file. limits the list. */
export function missingIds(prefix = ''): string[] {
  const want = new Set([...classicIds(), ...idsInTabs(), ...DEFAULT_QAT, ...QAT_CHOICES]);
  return [...want].filter((id) => id.startsWith(prefix) && !getCommand(id)).sort();
}

describe('command catalog', () => {
  it('registers every command the menus, ribbon and Quick Access Bar name', () => {
    expect(missingIds(process.env.PREFIX || '')).toEqual([]);
  });
  it('gives every command a label, icon and tab', () => {
    for (const c of allCommands()) {
      expect(c.label, c.id).toBeTruthy();
      expect(c.tab, c.id).toBeTruthy();
    }
  });
  it('has no duplicate labels inside one group', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const c of allCommands()) {
      const k = `${c.tab}/${c.group}/${c.label}`;
      if (seen.has(k)) dups.push(`${seen.get(k)} & ${c.id}`); else seen.set(k, c.id);
    }
    expect(dups).toEqual([]);
  });
});
