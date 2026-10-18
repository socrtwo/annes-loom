import { describe, it, expect } from 'vitest';
import '../../src/commands';
import { allCommands } from '../../src/commands/registry';
import { canonicalKey } from '../../src/util/keys';

describe('keyboard shortcuts', () => {
  it('assigns each key to one command', () => {
    const by = new Map<string, string[]>();
    for (const c of allCommands()) for (const k of c.keys || []) { const ck = canonicalKey(k); by.set(ck, [...(by.get(ck) || []), c.id]); }
    const clashes = [...by].filter(([, ids]) => ids.length > 1).map(([k, ids]) => `${k}: ${ids.join(', ')}`);
    expect(clashes).toEqual([]);
  });
});
