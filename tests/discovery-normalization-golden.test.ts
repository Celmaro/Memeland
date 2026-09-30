import { describe, it, expect } from 'vitest';
import { DEX_GOLDEN_CASES, TAPE_GOLDEN_CASES, runDexCase, runTapeCase } from './discovery-normalization.fixtures.js';

describe('6.6 — golden normalization fixtures (catch provider-format drift at the boundary)', () => {
  it('covers every DEX golden case with exact key-field expectations', () => {
    for (const c of DEX_GOLDEN_CASES) {
      const out = runDexCase(c);
      for (const [k, v] of Object.entries(c.expect)) {
        expect(out[k as keyof typeof out], `${c.name} → ${k}`).toEqual(v);
      }
      expect(out.source, `${c.name} → source`).toBe(c.source);
    }
  });

  it('covers every tape golden case', () => {
    for (const c of TAPE_GOLDEN_CASES) {
      const out = runTapeCase(c);
      for (const [k, v] of Object.entries(c.expect)) {
        expect(out[k as keyof typeof out], `${c.name} → ${k}`).toEqual(v);
      }
      expect(out.source, `${c.name} → source`).toBe('dexscreener');
    }
  });

  it('has at least one fixture per chain (rh, sol, eth) to pin per-chain shape', () => {
    const chains = new Set(DEX_GOLDEN_CASES.map((c) => c.chain));
    for (const ch of ['rh', 'sol', 'eth']) expect(chains.has(ch as any), `missing ${ch} fixture`).toBe(true);
  });
});