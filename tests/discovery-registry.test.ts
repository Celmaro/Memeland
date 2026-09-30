import { describe, it, expect } from 'vitest';
import { CandidateRegistry, isIntroducerEnabled, proposeIntroducers } from '../src/discovery/discovery-registry.js';

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

  it('B#1 — pruneFresh evicts dead fresh pairs but preserves matured/FP records', () => {
    let now = 0;
    const reg = new CandidateRegistry({ now: () => now });
    // Dead fresh pair — observed 16 min ago, never matured.
    reg.observe({ chain: 'base', tokenAddress: '0xdead', source: 'gecko', at: 0 });
    // Matured candidate — revalidated, must survive even if old.
    reg.observe({ chain: 'base', tokenAddress: '0xalive', source: 'gecko', at: 0 });
    reg.markRevalidated('base:0xalive');
    now = 16 * 60 * 1000; // advance 16 min (> 15 min TTL)
    // A still-fresh but young candidate — must survive.
    reg.observe({ chain: 'base', tokenAddress: '0xyoung', source: 'gecko', at: now });
    const evicted = reg.pruneFresh(15 * 60 * 1000);
    expect(evicted).toBe(1); // only 0xdead (stale fresh)
    expect(reg.get('base:0xdead')).toBeUndefined();   // pruned
    expect(reg.get('base:0xalive')).toBeDefined();    // preserved (matured)
    expect(reg.get('base:0xyoung')).toBeDefined();    // preserved (young fresh)
    // Second pass evicts nothing new — idempotent.
    expect(reg.pruneFresh(15 * 60 * 1000)).toBe(0);
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

  it('6.3 — records source availability and reflects it in stats', () => {
    const reg = new CandidateRegistry();
    expect(reg.availabilityOf('solana-rpc' as any)).toBeNull();
    reg.recordAvailability('solana-rpc' as any, true);
    reg.recordAvailability('solana-rpc' as any, true);
    reg.recordAvailability('solana-rpc' as any, false);
    expect(reg.availabilityOf('solana-rpc' as any)).toBeCloseTo(2 / 3);
    expect(reg.availabilityOf('gecko' as any)).toBeNull(); // never probed
    const s = reg.stats();
    expect(s.availability['solana-rpc']).toEqual({ ok: 2, total: 3, score: 2 / 3 });
  });

  it('6.7 — proposes an allowlist from measured stats and flags contradiction', () => {
    const reg = new CandidateRegistry();
    // gecko is the measured star (high coverage + first-seen + healthy).
    reg.observe({ chain: 'base', tokenAddress: '0xa', source: 'gecko', at: 1000 });
    reg.observe({ chain: 'base', tokenAddress: '0xb', source: 'gecko', at: 1100 });
    reg.observe({ chain: 'base', tokenAddress: '0xc', source: 'ankr', at: 1200 });
    reg.observe({ chain: 'base', tokenAddress: '0xd', source: 'ankr', at: 1300 });
    reg.recordAvailability('gecko', true);
    reg.recordAvailability('gecko', true);
    reg.recordAvailability('ankr', false);
    // Config allows only cmc (measured nothing) — contradicts the measured primary.
    const p = proposeIntroducers(reg.stats(), 'cmc');
    expect(p.measuredPrimary).toBe('gecko');
    expect(p.contradict).toBe(true);
    expect(p.configuredPrimary).toBeNull(); // cmc measured nothing → not ranked/enabled
    expect(p.enabledNow).toEqual(['cmc']);
    // promote = high-value sources not enabled (only the top tier here).
    expect(p.promote).toContain('gecko');
    expect(p.demote).toEqual([]); // ankr (positive) isn't bottom-tier enough to demote and isn't enabled
  });

  it('6.7 — no contradiction when config matches the measured primary', () => {
    const reg = new CandidateRegistry();
    reg.observe({ chain: 'base', tokenAddress: '0xa', source: 'gecko', at: 1000 });
    reg.observe({ chain: 'base', tokenAddress: '0xb', source: 'gecko', at: 1100 });
    reg.recordAvailability('gecko', true);
    const p = proposeIntroducers(reg.stats(), 'gecko');
    expect(p.measuredPrimary).toBe('gecko');
    expect(p.configuredPrimary).toBe('gecko');
    expect(p.contradict).toBe(false);
    expect(p.promote).not.toContain('gecko'); // already enabled
  });
});
