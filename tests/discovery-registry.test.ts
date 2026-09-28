import { describe, it, expect } from 'vitest';
import { CandidateRegistry, isIntroducerEnabled } from '../src/discovery/discovery-registry.js';

describe('isIntroducerEnabled (DISCOVERY_INTRODUCERS gate)', () => {
  it('enables every feed when the env list is unset (back-compat)', () => {
    expect(isIntroducerEnabled('ankr')).toBe(true);
    expect(isIntroducerEnabled('solana-rpc', '')).toBe(true);
    expect(isIntroducerEnabled('solana-rpc', '   ')).toBe(true);
  });

  it('enables a source when listed exactly or as a <source>-* token', () => {
    expect(isIntroducerEnabled('dexpaprika', 'dexpaprika,ankr')).toBe(true);
    expect(isIntroducerEnabled('ankr', 'dexpaprika,ankr')).toBe(true);
    // provider-architecture style: solana-rpc-sol enables solana-rpc; gecko-base gecko.
    expect(isIntroducerEnabled('solana-rpc', 'solana-rpc-sol,dexpaprika')).toBe(true);
    expect(isIntroducerEnabled('gecko', 'gecko-base')).toBe(true);
  });

  it('blocks a source absent from the allowlist', () => {
    expect(isIntroducerEnabled('cmc', 'ankr,solana-rpc-sol')).toBe(false);
    expect(isIntroducerEnabled('gecko', 'dexpaprika')).toBe(false);
  });
});


describe('CandidateRegistry (P3.1 per-source firstSeen + latency)', () => {
  it('records firstSeen per source and keeps the FIRST sighting', () => {
    const reg = new CandidateRegistry();
    reg.observe({ chain: 'base', tokenAddress: '0xabc', source: 'gecko', at: 1000 });
    reg.observe({ chain: 'base', tokenAddress: '0xabc', source: 'dexpaprika', at: 2000 });
    reg.observe({ chain: 'base', tokenAddress: '0xabc', source: 'gmgn', at: 3000 }); // overlay — still recorded
    const c = reg.get('base:0xabc')!;
    expect(c.firstSeen.gecko).toBe(1000); // first sighting preserved
    expect(c.firstSeen.dexpaprika).toBe(2000);
    expect(c.firstSeen.gmgn).toBe(3000);
    // Later gecko sighting does NOT overwrite the first.
    reg.observe({ chain: 'base', tokenAddress: '0xabc', source: 'gecko', at: 9000 });
    expect(reg.get('base:0xabc')!.firstSeen.gecko).toBe(1000);
  });

  it('computes per-source discovery latency and the first-source', () => {
    const reg = new CandidateRegistry();
    // rpc saw it at 100 (on-chain truth), dexpaprika at 150 → latency 50ms.
    reg.observe({ chain: 'eth', tokenAddress: '0xeth', source: 'rpc', at: 100 });
    reg.observe({ chain: 'eth', tokenAddress: '0xeth', source: 'dexpaprika', at: 150 });
    const c = reg.get('eth:0xeth')!;
    expect(c.firstSource).toBe('rpc');
    expect(c.latencyMs.dexpaprika).toBe(50);
    expect(c.latencyMs.rpc).toBe(0);
  });

  it('derives the empirical primary discovery source across candidates', () => {
    const reg = new CandidateRegistry();
    // 3 tokens all first seen by rpc → primary = rpc.
    for (const addr of ['0xa', '0xb', '0xc']) {
      reg.observe({ chain: 'base', tokenAddress: addr, source: 'rpc', at: 100 });
      reg.observe({ chain: 'base', tokenAddress: addr, source: 'gecko', at: 500 });
    }
    const stats = reg.primaryDiscoverySource();
    expect(stats.primary).toBe('rpc');
    expect(stats.bySource.rpc).toBe(3);
    // gecko was never FIRST for any candidate → absent (not counted).
    expect(stats.bySource.gecko ?? 0).toBe(0);
  });

  it('exposes lifecycle: fresh → eligible after revalidate, dead after expiry', () => {
    const reg = new CandidateRegistry();
    reg.observe({ chain: 'base', tokenAddress: '0xabc', source: 'gecko', at: 1000 });
    reg.markRevalidated('base:0xabc');
    expect(reg.get('base:0xabc')!.lifecycle).toBe('eligible');
    reg.markDead('base:0xabc');
    expect(reg.get('base:0xabc')!.lifecycle).toBe('dead');
  });

  it('tracks coverage, dup-rate, spend and false-positive attribution per source', () => {
    const reg = new CandidateRegistry();
    // solana-rpc first-sees three tokens; dexpaprika adds one new token and
    // re-observes the same address (that repeat is the dup-rate signal).
    for (const addr of ['0xa', '0xb', '0xc']) {
      reg.observe({ chain: 'sol', tokenAddress: addr, source: 'solana-rpc', at: 100, costCredits: 10 });
    }
    reg.observe({ chain: 'sol', tokenAddress: '0xa', source: 'dexpaprika', at: 500, costCredits: 1 });
    reg.observe({ chain: 'sol', tokenAddress: '0xa', source: 'dexpaprika', at: 600, costCredits: 1 }); // repeat
    reg.observe({ chain: 'sol', tokenAddress: '0xd', source: 'dexpaprika', at: 700, costCredits: 1 }); // new

    const s = reg.stats();
    expect(s.totalCandidates).toBe(4);
    // solana-rpc coverage 3; dexpaprika coverage 2 (0xa,0xd) across 3 sightings → dup 1/3.
    expect(s.coverage['solana-rpc']).toBe(3);
    expect(s.coverage.dexpaprika).toBe(2);
    expect(s.dupRate.dexpaprika).toBeCloseTo(1 / 3);
    expect(s.dupRate['solana-rpc']).toBe(0);
    expect(s.spend['solana-rpc']).toBe(30);
    expect(s.spend.dexpaprika).toBe(3);
    // first-seen shares: solana-rpc first for 0xa/b/c; dexpaprika first only for 0xd.
    expect(s.firstSeenBySource['solana-rpc']).toBe(3);
    expect(s.firstSeenBySource.dexpaprika).toBe(1);

    // False positives attribute to the source that first listed the token.
    reg.markDead('sol:0xa');
    reg.markDead('sol:0xb');
    expect(reg.stats().falsePositive['solana-rpc']).toBe(2);
  });
});
