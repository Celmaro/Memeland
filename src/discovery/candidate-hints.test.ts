import { describe, it, expect } from 'vitest';
import { HintRegistry, chainAwareVerifier, type CandidateHint } from './candidate-hints.js';

function hint(overrides: Partial<CandidateHint> = {}): CandidateHint {
  return {
    chain: 'robinhood',
    address: '0xabc',
    source: 'fomo',
    at: 1_000,
    ...overrides,
  };
}

describe('HintRegistry', () => {
  it('dedupes re-emits of the same chain/address/source', () => {
    const r = new HintRegistry();
    r.record(hint({ at: 1_000 }));
    r.record(hint({ at: 2_000, pnlPct: 12 }));
    expect(r.pendingSize()).toBe(1);
    expect(r.stats().observed).toBe(1);
    const [h] = r.pendingHints();
    expect(h.at).toBe(2_000);
    expect(h.pnlPct).toBe(12);
  });

  it('only promotes hints that verify as real, and fails closed on errors', async () => {
    const r = new HintRegistry();
    r.record(hint({ address: '0xreal' }));
    r.record(hint({ address: '0xphantom' }));
    r.record(hint({ address: '0xthrows' }));
    const promoted = await r.drain(async (h) => {
      if (h.address === '0xthrows') throw new Error('network');
      return { exists: h.address === '0xreal' };
    });
    expect(promoted.map((p) => p.address)).toEqual(['0xreal']);
    const s = r.stats();
    expect(s.verifiedExists).toBe(1);
    expect(s.verifiedFalse).toBe(2);
    expect(r.pendingSize()).toBe(0);
  });

  it('chainAwareVerifier routes by chain and is fail-closed for unknown chains', async () => {
    const v = chainAwareVerifier({
      solana: async () => ({ exists: true }),
    });
    expect((await v(hint({ chain: 'solana' }))).exists).toBe(true);
    expect((await v(hint({ chain: 'base' }))).exists).toBe(false);
  });
});