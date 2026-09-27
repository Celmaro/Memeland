import { describe, it, expect } from 'vitest';
import { CandidateRegistry } from '../src/discovery/discovery-registry.js';

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
});
