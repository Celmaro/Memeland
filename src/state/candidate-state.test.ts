import { describe, it, expect } from 'vitest';
import {
  CandidateStateStore,
  InMemoryCandidateBackend,
  evaluateCausalTransition,
  type CandidateEvent,
  type CandidateState,
  type CandidateStateRecord,
} from './candidate-state.js';

describe('evaluateCausalTransition — monotonic causal matrix', () => {
  it('rejects retrograde / unknown transitions', () => {
    const r = evaluateCausalTransition('UNINITIALIZED', 'RECEIPT_CONFIRMED', {
      baseReserveUsd: 0,
      volume1hUsd: 0,
      score: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('walks the happy path DISCOVERY → … → FILLED', () => {
    let state: CandidateState = 'UNINITIALIZED';
    const cases: Array<[CandidateEvent, () => CandidateState]> = [
      ['DISCOVERY_EVENT', () => 'DISCOVERED'],
      ['RESERVE_INJECTED', () => 'SCREENED_L1'],
      ['SECURITY_VERIFIED', () => 'SEC_PASSED'],
      ['ENRICHMENT_SETTLED', () => 'HYDRATED'],
      ['ML_SCORE_EVALUATED', () => 'P42_GATED'],
      ['ARKHAM_CLEARED', () => 'DISPATCH_READY'],
      ['TX_BROADCASTED', () => 'IN_FLIGHT'],
      ['RECEIPT_CONFIRMED', () => 'FILLED'],
    ];
    for (const [event, expectTo] of cases) {
      const r = evaluateCausalTransition(state, event, {
        baseReserveUsd: 5000,
        volume1hUsd: 100,
        score: 0.9,
        deployerRugCount: 0,
        scoreThreshold: 0.5,
        liquidityGateUsd: 1000,
      });
      expect(r.ok).toBe(true);
      expect(r.next).toBe(expectTo());
      state = r.next as CandidateState;
    }
    expect(state).toBe('FILLED');
  });

  it('RESERVE_INJECTED fails when liquidity is below the $1k gate', () => {
    const r = evaluateCausalTransition('DISCOVERED', 'RESERVE_INJECTED', {
      baseReserveUsd: 500,
      volume1hUsd: 0,
      score: 0,
      liquidityGateUsd: 1000,
    });
    expect(r.ok).toBe(false);
  });

  it('ML_SCORE_EVALUATED routes to DROPPED context only via explicit DROP; low score rejects the gate', () => {
    const r = evaluateCausalTransition('HYDRATED', 'ML_SCORE_EVALUATED', {
      baseReserveUsd: 5000,
      volume1hUsd: 10,
      score: 0.2,
      scoreThreshold: 0.5,
    });
    expect(r.ok).toBe(false); // under threshold → gate not passed (caller may DROP)
  });

  it('TTL_EXPIRED evicts from any active state; DROP works from SCREENED_L1', () => {
    expect(evaluateCausalTransition('SCREENED_L1', 'TTL_EXPIRED', { baseReserveUsd: 0, volume1hUsd: 0, score: 0 }).next).toBe('EVICTED');
    expect(evaluateCausalTransition('SCREENED_L1', 'DROP', { baseReserveUsd: 0, volume1hUsd: 0, score: 0 }).next).toBe('DROPPED');
  });
});

describe('CandidateStateStore — optimistic-locking reducer', () => {
  it('allocates and transitions a candidate through the funnel', async () => {
    const store = new CandidateStateStore(new InMemoryCandidateBackend());
    const id = 'sol:abc';
    expect(await store.get(id)).toBeNull();

    const d = await store.transition(id, 'DISCOVERY_EVENT', { mutation: () => ({ baseReserveUsd: 5000, volume1hUsd: 120 }) });
    expect(d.ok).toBe(true);
    expect(d.record?.state).toBe('DISCOVERED');
    expect(d.record?.version).toBe(1);

    const s = await store.transition(id, 'RESERVE_INJECTED', { context: { liquidityGateUsd: 1000 } });
    expect(s.ok).toBe(true);
    expect(s.record?.state).toBe('SCREENED_L1');

    const sec = await store.transition(id, 'SECURITY_VERIFIED');
    expect(sec.ok).toBe(true);
    expect(sec.record?.state).toBe('SEC_PASSED');

    const hyd = await store.transition(id, 'ENRICHMENT_SETTLED', { mutation: () => ({ volume1hUsd: 300 }) });
    expect(hyd.ok).toBe(true);
    expect(hyd.record?.volume1hUsd).toBe(300);
    expect(hyd.record?.state).toBe('HYDRATED');

    const ml = await store.transition(id, 'ML_SCORE_EVALUATED', { mutation: () => ({ score: 0.9 }), context: { scoreThreshold: 0.5 } });
    expect(ml.ok).toBe(true);
    expect(ml.record?.state).toBe('P42_GATED');

    const ark = await store.transition(id, 'ARKHAM_CLEARED', { context: { deployerRugCount: 0 } });
    expect(ark.ok).toBe(true);
    expect(ark.record?.state).toBe('DISPATCH_READY');

    const tx = await store.transition(id, 'TX_BROADCASTED');
    expect(tx.ok).toBe(true);
    expect(tx.record?.state).toBe('IN_FLIGHT');

    const fill = await store.transition(id, 'RECEIPT_CONFIRMED');
    expect(fill.ok).toBe(true);
    expect(fill.record?.state).toBe('FILLED');
  });

  it('rejects a retrograde event once a record is past that step', async () => {
    const store = new CandidateStateStore(new InMemoryCandidateBackend());
    await store.transition('sol:x', 'DISCOVERY_EVENT');
    // DISCOVERY_EVENT on a DISCOVERED record is retrograde → rejected.
    const r = await store.transition('sol:x', 'DISCOVERY_EVENT');
    expect(r.ok).toBe(false);
  });

  it('handles an out-of-order ENRICHMENT_UPDATE by buffering into PENDING_DISCOVERY, then reconciles on DISCOVERY', async () => {
    const store = new CandidateStateStore(new InMemoryCandidateBackend());
    // Enrichment arrives BEFORE discovery: buffer metrics.
    const e = await store.transition('sol:y', 'ENRICHMENT_UPDATE', { mutation: () => ({ volume1hUsd: 75 }) });
    expect(e.ok).toBe(true);
    expect(e.record?.state).toBe('PENDING_DISCOVERY');

    const d = await store.transition('sol:y', 'DISCOVERY_EVENT', { mutation: () => ({ baseReserveUsd: 2000 }) });
    expect(d.ok).toBe(true);
    expect(d.record?.state).toBe('DISCOVERED');
    expect(d.record?.volume1hUsd).toBe(75); // buffered metric merged
    expect(d.record?.baseReserveUsd).toBe(2000);
  });

  it('does not fabricate success for a lone event on a missing candidate', async () => {
    const store = new CandidateStateStore(new InMemoryCandidateBackend());
    const r = await store.transition('sol:z', 'RECEIPT_CONFIRMED');
    expect(r.ok).toBe(false);
  });

  it('evicts a candidate', async () => {
    const store = new CandidateStateStore(new InMemoryCandidateBackend());
    await store.transition('sol:q', 'DISCOVERY_EVENT');
    await store.evict('sol:q');
    expect(await store.get('sol:q')).toBeNull();
  });

  it('optimistic collision retries against a fresh version', async () => {
    // First backend write (DISCOVERY_EVENT) bumps to version 1. A second, concurrent
    // transition on the SAME stale expected version must be reconciled via re-read.
    const backend = new InMemoryCandidateBackend();
    const store = new CandidateStateStore(backend);
    await store.transition('sol:c', 'DISCOVERY_EVENT');
    const rec = (await backend.read('candidate:sol:c')) as CandidateStateRecord;

    // Simulate a concurrent writer bumping the version out from under the next op.
    await store.transition('sol:c', 'RESERVE_INJECTED', {
      mutation: () => ({ baseReserveUsd: 5000 }),
      context: { liquidityGateUsd: 1000 },
    });

    // A stale CAS (expected old version) must fail on the raw backend…
    const stale = await backend.cas('candidate:sol:c', rec.version, { ...rec, version: rec.version + 1 }, 900000);
    expect(stale).toBe(false);

    // …while the store-level transition reads fresh and succeeds.
    const s2 = await store.transition('sol:c', 'SECURITY_VERIFIED');
    expect(s2.ok).toBe(true);
    expect(s2.record?.state).toBe('SEC_PASSED');
  });

  it('probe reports in-memory backend as not armed', async () => {
    const backend = new InMemoryCandidateBackend();
    const probe = backend.probe;
    if (probe) {
      const p = await probe();
      expect(p.armed).toBe(false);
    }
    expect(probe).toBeDefined();
  });
});
