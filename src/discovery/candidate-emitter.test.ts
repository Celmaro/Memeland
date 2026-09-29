import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiscoveryCoordinator, type CandidateEmitter } from './candidate-emitter.js';
import { globalSourceQuota } from '../services/source-quota.js';
import type { GMGNRawToken } from '../adapters/gmgn-adapter.js';

const cfg = process.env.DISCOVERY_INTRODUCERS;
afterEach(() => {
  if (cfg === undefined) delete process.env.DISCOVERY_INTRODUCERS;
  else process.env.DISCOVERY_INTRODUCERS = cfg;
  globalSourceQuota.clear();
});

const tok = (address: string, source: string, over: Record<string, unknown> = {}): GMGNRawToken =>
  ({ chain: 'sol', address, source, symbol: address.toUpperCase(), priceUsd: 1, ...over }) as unknown as GMGNRawToken;

function emitter(id: string, tokens: GMGNRawToken[]): CandidateEmitter {
  return { id, enabled: () => true, discover: async () => tokens };
}

describe('DiscoveryCoordinator — priority merge + demotion + P5 observation sink', () => {
  it('merges by address in priority order; later source overwrites, freshLane survives', async () => {
    const c = new DiscoveryCoordinator();
    c.add(emitter('dexpaprika', [tok('A', 'dexpaprika')]));
    c.add(emitter('gecko', [
      tok('A', 'gecko', { freshLane: true, priceUsd: 9 }), // later overwrite, brings freshLane
      tok('B', 'gecko'),
    ]));
    const { candidates } = await c.discoverAll('sol');
    const a = candidates.find((t) => t.address === 'A');
    expect(a?.source).toBe('gecko'); // later source wins the slot
    expect(a?.priceUsd).toBe(9);
    expect(a?.freshLane).toBe(true); // freshLane survives overwrite
    expect(candidates.map((t) => t.address).sort()).toEqual(['A', 'B']);
  });

  it('skips disabled emitters and drops overlay rows never discovered', async () => {
    const c = new DiscoveryCoordinator();
    c.add({ id: 'ankr', enabled: () => false, discover: async () => [tok('A', 'ankr')] });
    c.add(emitter('routescan', [tok('B', 'routescan')]));
    const overlay = [tok('C', 'gmgn')]; // never discovered → dropped
    const { candidates } = await c.discoverAll('sol', { overlay });
    expect(candidates.map((t) => t.address)).toEqual(['B']);
  });

  it('places externally-collected extras (tape/track) in priority order and keeps overlay discoveredBy', async () => {
    const c = new DiscoveryCoordinator();
    c.add(emitter('dexpaprika', [tok('A', 'dexpaprika')]));
    // overlay upgrades an EXISTING address and preserves who FOUND it
    const { candidates } = await c.discoverAll('sol', {
      extras: { tape: [tok('T', 'dexscreener')], track: [tok('R', 'dexscreener')] },
      overlay: [tok('A', 'gmgn')],
    });
    const a = candidates.find((t) => t.address === 'A');
    expect(a?.source).toBe('gmgn');
    expect((a as unknown as { discoveredBy: string }).discoveredBy).toBe('dexpaprika');
    expect(candidates.map((t) => t.address).sort()).toEqual(['A', 'R', 'T']);
  });

  it('throws in an emitter → no candidates from it, cooldown registered, others unaffected', async () => {
    globalSourceQuota.clear();
    const c = new DiscoveryCoordinator();
    c.add({ id: 'fomo', enabled: () => true, discover: async () => { throw { status: 429 }; } });
    c.add(emitter('tape', [tok('T', 'tape')]));
    const { candidates } = await c.discoverAll('sol');
    expect(candidates.map((t) => t.address)).toEqual(['T']);
    expect(globalSourceQuota.isCooling('fomo')).toBe(true); // quota → cooled
  });

  it('P5: emits an observation per (source × token) BEFORE merge — all sources recorded', async () => {
    const c = new DiscoveryCoordinator();
    c.add(emitter('dexpaprika', [tok('A', 'dexpaprika')]));
    // gecko ALSO sees A (plus a unique B) → the merged list has ONE A, but
    // the evidence keeps BOTH sightings of A (per-source coverage stays answerable).
    c.add(emitter('gecko', [tok('A', 'gecko'), tok('B', 'gecko')]));
    const { candidates, observations } = await c.discoverAll('sol', {
      observeAt: () => 1_000,
    });
    expect(candidates.map((t) => t.address).sort()).toEqual(['A', 'B']); // merged = 2 tokens
    expect(observations).toHaveLength(3); // A(dexpaprika) + A(gecko) + B(gecko)
    expect(observations.filter((o) => o.tokenAddress === 'A')).toHaveLength(2); // both sources
    expect(observations.map((o) => o.source).sort()).toEqual(['dexpaprika', 'gecko', 'gecko']);
    for (const o of observations) expect(o.at).toBe(1_000); // deterministic clock
  });

  it('P5: observation source is the emitter id, NOT the token source tag (tape rows)', async () => {
    const c = new DiscoveryCoordinator();
    // Tape normalizes tokens tagged 'dexscreener' internally — the observation
    // must be attributed to 'tape', not the tag, or coverage metrics lie.
    c.add(emitter('tape', [tok('T', 'dexscreener')]));
    const { observations } = await c.discoverAll('sol');
    expect(observations).toHaveLength(1);
    expect(observations[0]!.source).toBe('tape');
    expect(observations[0]!.tokenAddress).toBe('T');
  });

  it('P5: throwing emitter contributes no observations; others unaffected', async () => {
    const c = new DiscoveryCoordinator();
    c.add({ id: 'fomo', enabled: () => true, discover: async () => { throw { status: 500 }; } });
    c.add(emitter('ankr', [tok('A', 'ankr')]));
    const { candidates, observations } = await c.discoverAll('sol');
    expect(candidates.map((t) => t.address)).toEqual(['A']);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.source).toBe('ankr');
  });

  it('P10: carries source-reported providerEventTime (ms) from creationTimestamp, else undefined', async () => {
    const c = new DiscoveryCoordinator();
    c.add(emitter('gecko', [
      tok('WITH_TS', 'gecko', { creationTimestamp: 1_600_000_000 }),   // seconds → ms
      tok('NO_TS', 'gecko', { creationTimestamp: null }),
      tok('ZERO_TS', 'gecko', { creationTimestamp: 0 }),
    ]));
    const { observations } = await c.discoverAll('sol', { observeAt: () => 2_000 });
    const byAddr = Object.fromEntries(observations.map((o) => [o.tokenAddress, o]));
    // Local `at` stays the ingest snapshot time (poll-schedule artifact).
    expect(byAddr['WITH_TS']!.at).toBe(2_000);
    expect(byAddr['WITH_TS']!.providerEventTime).toBe(1_600_000_000 * 1000);
    expect(byAddr['NO_TS']!.providerEventTime).toBeUndefined();
    expect(byAddr['ZERO_TS']!.providerEventTime).toBeUndefined();
  });
});