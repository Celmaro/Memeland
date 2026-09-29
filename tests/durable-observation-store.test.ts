import { describe, it, expect } from 'vitest';
import {
  InMemoryObservationStore,
  PostgresObservationStore,
  createObservationStore,
} from '../src/storage/durable-observation-store.js';

const OBS = {
  chain: 'sol',
  tokenAddress: '0xDEADBEEF',
  source: 'dexpaprika' as const,
  at: 1000,
  costCredits: 2,
};

describe('P2 durable observation store', () => {
  it('in-memory backend appends, dedupes by count and reports source coverage', () => {
    const s = new InMemoryObservationStore();
    expect(s.size()).toBe(0);
    s.append(OBS);
    s.append({ ...OBS, source: 'gecko', at: 1100 });
    s.append({ ...OBS, at: 1200 }); // same source+addr repeat
    expect(s.size()).toBe(3);
    expect(s.countFor('sol', '0xDEADBEEF')).toBe(3);
    expect(s.countFor('sol', '0xDEADBEEF', 1150)).toBe(1); // only the at=1200 row is >= 1150
    expect(s.sourcesFor('sol', '0xDEADBEEF')).toEqual(['dexpaprika', 'gecko']);
    expect(s.sourcesFor('eth', '0xDEADBEEF')).toEqual([]);
  });

  it('recent() returns newest-first rows', () => {
    const s = new InMemoryObservationStore();
    s.append({ ...OBS, at: 100 });
    s.append({ ...OBS, at: 200 });
    const recent = s.recent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.at).toBe(200);
  });

  it('PostgresObservationStore without DATABASE_URL falls back to in-memory only (durableArmed=false)', () => {
    const p = new PostgresObservationStore(undefined as unknown as string);
    expect(p.durableArmed()).toBe(false);
    p.append(OBS);
    expect(p.size()).toBe(1);
    expect(p.countFor('sol', '0xDEADBEEF')).toBe(1);
    expect(p.sourcesFor('sol', '0xDEADBEEF')).toEqual(['dexpaprika']);
  });

  it('createObservationStore selects in-memory when DATABASE_URL is unset', () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const s = createObservationStore();
      expect(s.durableArmed ? s.durableArmed() : false).toBe(false);
      expect(s).toBeInstanceOf(InMemoryObservationStore);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it('P9 — durable reads serve Postgres rows across a fresh process (empty mirror)', async () => {
    // A PostgresObservationStore armed with a URL whose ensurePool returns a
    // fake pool returning a pre-seeded durable row — simulates a restart where
    // the in-process mirror is empty but Postgres holds history.
    const p = new PostgresObservationStore('postgres://fake');
    const rows = [
      { chain: 'sol', tokenAddress: '0xDEADBEEF', source: 'gecko', at: 500, costCredits: '1' },
      { chain: 'eth', tokenAddress: '0xCOFFEE', source: 'dexpaprika', at: 700, costCredits: null },
    ];
    (p as unknown as { ensurePool: () => Promise<any> }).ensurePool = async () => ({
      query: async (sql: string, args: any[]) => {
        if (/COUNT\(\*\)/.test(sql)) {
          const n = args[1] === '0xdeadbeef' ? 1 : 0;
          return { rows: [{ n }] };
        }
        if (/DISTINCT source/.test(sql)) {
          return { rows: [{ source: 'gecko' }] };
        }
        if (/LIMIT/.test(sql)) {
          // Emulate the real ORDER BY at DESC the store issues.
          const sorted = [...rows].sort((a, b) => b.at - a.at);
          return { rows: sorted.slice(0, args[0]) };
        }
        return { rows: [] };
      },
    });
    // Empty mirror (fresh process) — current-process reads see nothing durable.
    expect(p.countFor('sol', '0xDEADBEEF')).toBe(0);
    // Durable reads DO see the seeded Postgres rows.
    expect(await p.countDurable('sol', '0xDEADBEEF')).toBe(1);
    expect(await p.sourcesForDurable('sol', '0xDEADBEEF')).toEqual(['gecko']);
    const recent = await p.recentDurable(100);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.at).toBe(700); // newest-first
    expect(recent[0]!.source).toBe('dexpaprika');
    // Since-clause is honored.
    expect(await p.countDurable('sol', '0xDEADBEEF', 600)).toBe(1);
  });

  it('P9 — durable reads fail-open to the mirror when the DB query fails', async () => {
    const p = new PostgresObservationStore('postgres://fake');
    p.append(OBS); // dexpaprika
    p.append({ ...OBS, source: 'gecko' as const });
    (p as unknown as { ensurePool: () => Promise<any> }).ensurePool = async () => ({
      query: async () => { throw new Error('db down'); },
    });
    expect(await p.countDurable('sol', '0xDEADBEEF')).toBe(p.countFor('sol', '0xDEADBEEF'));
    expect(await p.sourcesForDurable('sol', '0xDEADBEEF')).toEqual(['dexpaprika', 'gecko']);
  });
});
