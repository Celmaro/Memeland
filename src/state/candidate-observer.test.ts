import { describe, it, expect, vi } from 'vitest';
import { CandidateStateStore, InMemoryCandidateBackend } from './candidate-state.js';
import { recordDiscovery, recordScore } from './candidate-observer.js';

function store(): CandidateStateStore {
  return new CandidateStateStore(new InMemoryCandidateBackend());
}

describe('globalCandidateObserver — non-gating recording', () => {
  it('records discovery and merges buffered metrics (out-of-order safe)', async () => {
    const s = store();
    await recordDiscovery(s, { id: 'sol:abc', baseReserveUsd: 5000, volume1hUsd: 120 });
    const rec = await s.get('sol:abc');
    expect(rec?.state).toBe('SCREENED_L1'); // discovery + reserve-injected
    expect(rec?.baseReserveUsd).toBe(5000);
    expect(rec?.volume1hUsd).toBe(120);
  });

  it('does not gate (returns a record for a below-gate candidate, still records) ', async () => {
    const s = store();
    await recordDiscovery(s, { id: 'sol:low', baseReserveUsd: 200, volume1hUsd: 0 });
    const rec = await s.get('sol:low');
    // RESERVE_INJECTED condition fails, but discovery is still recorded (non-gating).
    expect(rec?.state).toBe('DISCOVERED');
  });

  it('records the ML score via the zero-alloc scorer (candidate already hydrated)', async () => {
    const s = store();
    await recordDiscovery(s, { id: 'sol:sc', baseReserveUsd: 5000, volume1hUsd: 1000 }); // → SCREENED_L1
    await s.transition('sol:sc', 'SECURITY_VERIFIED'); // → SEC_PASSED
    await s.transition('sol:sc', 'ENRICHMENT_SETTLED'); // → HYDRATED
    await recordScore(
      s,
      {
        id: 'sol:sc',
        snapshot: {
          currentLiqUsd: 5000,
          fiveMinAgoUsd: 1000,
          buyVol1hUsd: 5000,
          sellVol1hUsd: 500,
          numSmartWallets: 4,
          top10Supply: 20,
          totalSupply: 100,
          numHistoricalRugs: 0,
          numTotalLaunches: 0,
        },
        scoreThreshold: 0.5,
      },
    );
    const rec = await s.get('sol:sc');
    expect(rec?.state).toBe('P42_GATED');
    expect(rec?.score).toBeGreaterThan(0);
  });

  it('is fail-open: a store error never throws', async () => {
    const throwing = {
      transition: vi.fn(async () => {
        throw new Error('redis down');
      }),
      get: vi.fn(async () => null),
    } as unknown as CandidateStateStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await recordDiscovery(throwing, { id: 'sol:x', baseReserveUsd: 1 });
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});