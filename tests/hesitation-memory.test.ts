import { describe, expect, it } from 'vitest';
import {
  HesitationMemory,
  type MemoryEntry,
} from '../src/services/hesitation-memory.js';

function entry(overrides: Partial<MemoryEntry> & { id: string; key: string; agent: string }): MemoryEntry {
  return {
    kind: 'observation',
    claim: '',
    createdAt: 0,
    ttlMs: 60_000,
    weight: 1,
    ...overrides,
  };
}

describe('HesitationMemory lifecycle (memanto memory-lifecycle)', () => {
  it('memorizes entries and briefs each voter with non-expired history', () => {
    let now = 0;
    const mem = new HesitationMemory(() => now);
    mem.remember(
      entry({
        id: 'a',
        key: 'TOK',
        agent: 'security',
        kind: 'flag',
        claim: 'honeypot suspicion',
        createdAt: 0,
        weight: 0.9,
      }),
    );
    mem.remember(
      entry({
        id: 'b',
        key: 'TOK',
        agent: 'liquidity',
        kind: 'clear',
        claim: 'pool observes liquid depth',
        createdAt: 10_000,
        weight: 0.6,
      }),
    );

    const brief = mem.brief('TOK');
    expect(brief.entries).toHaveLength(2);
    expect(brief.entries[0]).toMatchObject({ id: 'b', agent: 'liquidity' });
    expect(brief.status).toBe('CLEARED');
    expect(brief.conflicts).toHaveLength(1);
    expect(brief.conflicts[0].winnerId).toBe('b');
  });

  it('discards stale entries before briefing', () => {
    let now = 0;
    const mem = new HesitationMemory(() => now);
    mem.remember(
      entry({
        id: 'old',
        key: 'TOK',
        agent: 'security',
        kind: 'flag',
        claim: 'old honeypot flag',
        createdAt: 0,
        ttlMs: 5_000,
      }),
    );

    now = 6_000;
    const brief = mem.brief('TOK');
    expect(brief.entries).toHaveLength(0);
    expect(brief.status).toBe('NO_MEMORY');
  });

  it('gc removes expired memories from the ledger', () => {
    let now = 0;
    const mem = new HesitationMemory(() => now);
    mem.remember(
      entry({
        id: 'doomed',
        key: 'TOK',
        agent: 'critic',
        kind: 'observation',
        claim: 'temporary observation',
        createdAt: 0,
        ttlMs: 1_000,
      }),
    );
    now = 2_000;
    mem.gc();
    expect(mem.brief('TOK').status).toBe('NO_MEMORY');
  });
});

describe('HesitationMemory conflict resolution (memanto contradiction)', () => {
  it('a later flag blocks an earlier clear', () => {
    const mem = new HesitationMemory(() => 0);
    mem.remember(
      entry({
        id: 'clear1',
        key: 'TOK',
        agent: 'liquidity',
        kind: 'clear',
        createdAt: 0,
      }),
    );
    mem.remember(
      entry({
        id: 'flag2',
        key: 'TOK',
        agent: 'security',
        kind: 'flag',
        claim: 'fresh honeypot evidence',
        createdAt: 1_000,
        weight: 0.9,
      }),
    );

    const brief = mem.brief('TOK');
    expect(brief.status).toBe('FLAGGED');
    expect(brief.conflicts[0].winnerId).toBe('flag2');
    expect(brief.conflicts[0].resolvedBy).toBe('recency');
  });

  it('a later clear can override a flag once the contradiction is resolved', () => {
    const mem = new HesitationMemory(() => 0);
    mem.remember(
      entry({
        id: 'flag1',
        key: 'TOK',
        agent: 'security',
        kind: 'flag',
        createdAt: 0,
        weight: 0.9,
      }),
    );
    mem.remember(
      entry({
        id: 'clear2',
        key: 'TOK',
        agent: 'auditor',
        kind: 'clear',
        claim: 'confirmed not a honeypot',
        createdAt: 2_000,
        weight: 0.95,
      }),
    );

    const brief = mem.brief('TOK');
    expect(brief.status).toBe('CLEARED');
    expect(brief.conflicts[0].winnerId).toBe('clear2');
  });

  it('breaks exact-time conflicts by memory weight', () => {
    const mem = new HesitationMemory(() => 0);
    mem.remember(
      entry({
        id: 'weak-flag',
        key: 'TOK',
        agent: 'whale',
        kind: 'flag',
        createdAt: 0,
        weight: 0.5,
      }),
    );
    mem.remember(
      entry({
        id: 'strong-clear',
        key: 'TOK',
        agent: 'auditor',
        kind: 'clear',
        createdAt: 0,
        weight: 0.95,
      }),
    );

    const brief = mem.brief('TOK');
    expect(brief.status).toBe('CLEARED');
    expect(brief.conflicts[0].winnerId).toBe('strong-clear');
    expect(brief.conflicts[0].resolvedBy).toBe('weight');
  });

  it('a lone flag blocks and a lone clear clears without a conflict pair', () => {
    const mem = new HesitationMemory(() => 0);
    mem.remember(
      entry({ id: 'only-flag', key: 'TOK', agent: 'security', kind: 'flag', createdAt: 0 }),
    );
    expect(mem.brief('TOK').status).toBe('FLAGGED');

    const mem2 = new HesitationMemory(() => 0);
    mem2.remember(
      entry({ id: 'only-clear', key: 'TOK', agent: 'auditor', kind: 'clear', createdAt: 0 }),
    );
    expect(mem2.brief('TOK').status).toBe('CLEARED');
  });
});
