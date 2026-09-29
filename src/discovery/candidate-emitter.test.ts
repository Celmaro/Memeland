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

describe('DiscoveryCoordinator — priority merge + demotion', () => {
  it('merges by address in priority order; later source overwrites, freshLane survives', async () => {
    const c = new DiscoveryCoordinator();
    c.add(emitter('dexpaprika', [tok('A', 'dexpaprika')]));
    c.add(emitter('gecko', [
      tok('A', 'gecko', { freshLane: true, priceUsd: 9 }), // later overwrite, brings freshLane
      tok('B', 'gecko'),
    ]));
    const out = await c.discoverAll('sol');
    const a = out.find((t) => t.address === 'A');
    expect(a?.source).toBe('gecko'); // later source wins the slot
    expect(a?.priceUsd).toBe(9);
    expect(a?.freshLane).toBe(true); // freshLane survives overwrite
    expect(out.map((t) => t.address).sort()).toEqual(['A', 'B']);
  });

  it('skips disabled emitters and drops overlay rows never discovered', async () => {
    const c = new DiscoveryCoordinator();
    c.add({ id: 'ankr', enabled: () => false, discover: async () => [tok('A', 'ankr')] });
    c.add(emitter('routescan', [tok('B', 'routescan')]));
    const overlay = [tok('C', 'gmgn')]; // never discovered → dropped
    const out = await c.discoverAll('sol', { overlay });
    expect(out.map((t) => t.address)).toEqual(['B']);
  });

  it('places externally-collected extras (tape/track) in priority order and keeps overlay discoveredBy', async () => {
    const c = new DiscoveryCoordinator();
    c.add(emitter('dexpaprika', [tok('A', 'dexpaprika')]));
    // overlay upgrades an EXISTING address and preserves who FOUND it
    const out = await c.discoverAll('sol', {
      extras: { tape: [tok('T', 'dexscreener')], track: [tok('R', 'dexscreener')] },
      overlay: [tok('A', 'gmgn')],
    });
    const a = out.find((t) => t.address === 'A');
    expect(a?.source).toBe('gmgn');
    expect((a as unknown as { discoveredBy: string }).discoveredBy).toBe('dexpaprika');
    expect(out.map((t) => t.address).sort()).toEqual(['A', 'R', 'T']);
  });

  it('throws in an emitter → no candidates from it, cooldown registered, others unaffected', async () => {
    globalSourceQuota.clear();
    const c = new DiscoveryCoordinator();
    c.add({ id: 'fomo', enabled: () => true, discover: async () => { throw { status: 429 }; } });
    c.add(emitter('tape', [tok('T', 'tape')]));
    const out = await c.discoverAll('sol');
    expect(out.map((t) => t.address)).toEqual(['T']);
    expect(globalSourceQuota.isCooling('fomo')).toBe(true); // quota → cooled
  });
});