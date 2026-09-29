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
});
