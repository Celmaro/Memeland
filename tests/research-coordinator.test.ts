import { describe, it, expect } from 'vitest';
import { ResearchCoordinator } from '../src/research/research-coordinator.js';
import { InMemoryEphemeralStore } from '../src/storage/ephemeral-store.js';

describe('P5 ResearchCoordinator', () => {
  it('admits candidates up to the per-cycle budget and reports spend', () => {
    const rc = new ResearchCoordinator({ perCycle: 3 }, new InMemoryEphemeralStore());
    const { admissions } = rc.admit(['a', 'b', 'c', 'd', 'e']);
    expect(admissions.filter((a) => a.admitted)).toHaveLength(3);
    expect(admissions.filter((a) => !a.admitted).map((a) => a.candidateId)).toEqual(['d', 'e']);
    expect(admissions.find((a) => a.candidateId === 'e')).toMatchObject({
      admitted: false,
      reason: expect.stringMatching(/budget exhausted/),
    });
    expect(rc.view().cycleSpent).toBe(3);
    expect(rc.view().remaining).toBe(0);
  });

  it('spend() meters non-admission research costs and enforces the budget on subsequent admits', () => {
    const rc = new ResearchCoordinator({ perCycle: 4 }, new InMemoryEphemeralStore());
    rc.spend('enrichment'); // 1
    rc.spend('blockscout'); // 2 → 3 spent
    const { admissions } = rc.admit(['x', 'y']); // admits [x], refuses [y] (4 capped)
    expect(admissions.filter((a) => a.admitted)).toHaveLength(1);
    expect(admissions.filter((a) => !a.admitted)).toHaveLength(1);
  });

  it('fixed costs are explicit and stable', () => {
    expect(ResearchCoordinator.cost('swarm_score')).toBe(1);
    expect(ResearchCoordinator.cost('enrichment')).toBe(1);
    expect(ResearchCoordinator.cost('blockscout')).toBe(2);
    expect(ResearchCoordinator.cost('kalp_estimate')).toBe(3);
  });

  it('cross-pass spend is metered into the ephemeral store when a spend window is configured', () => {
    let now = 1000;
    const meter = new InMemoryEphemeralStore(() => now);
    const rc = new ResearchCoordinator({ perCycle: 10, spendWindowMs: 60_000 }, meter);
    rc.spend('kalp_estimate'); // 3
    expect(meter.get<number>('research:window-spent')).toBe(3);
    rc.admit(['z']);
    expect(meter.get<number>('research:window-spent')).toBe(4);
  });

  it('P7: admission state does not leak across cycles (fresh instance per pass)', () => {
    const a = new ResearchCoordinator({ perCycle: 2 });
    const b = new ResearchCoordinator({ perCycle: 2 });
    expect(a.admit(['a', 'b', 'c']).admittedCount).toBe(2);
    // A fresh coordinator (the agent/pass pattern) starts at a full budget again.
    expect(b.admit(['a', 'b', 'c']).admittedCount).toBe(2);
  });
});
