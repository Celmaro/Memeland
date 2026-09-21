import { describe, expect, it } from 'vitest';
import {
  createOperationalFunnel,
  funnelCountersFromState,
  incrementOperationalFunnel,
  mergeOperationalFunnel,
} from '../src/services/operational-funnel.js';

describe('operational funnel', () => {
  it('starts at zero and increments a stage', () => {
    const funnel = createOperationalFunnel();
    expect(funnel.candidatesDiscovered).toBe(0);
    const next = incrementOperationalFunnel(funnel, 'candidatesDiscovered', 4);
    expect(next.candidatesDiscovered).toBe(4);
    expect(funnel.candidatesDiscovered).toBe(0);
  });

  it('merges partial counters without lowering existing values', () => {
    const funnel = createOperationalFunnel({ sourcesQueried: 2, signalsEmitted: 1 });
    const merged = mergeOperationalFunnel(funnel, { signalsEmitted: 1, candidatesEnriched: 3 });
    expect(merged.sourcesQueried).toBe(2);
    expect(merged.signalsEmitted).toBe(2);
    expect(merged.candidatesEnriched).toBe(3);
  });

  it('derives stage counters from persisted StateStore funnel buckets', () => {
    const counters = funnelCountersFromState({
      'meme-robinhood': {
        scanned: 10,
        prefiltered: 6,
        fired: 2,
        rejected: 1,
      },
    });
    expect(counters.candidatesDiscovered).toBe(10);
    expect(counters.candidatesNormalized).toBe(6);
    expect(counters.signalsEmitted).toBe(2);
    expect(counters.candidatesRejectedByGate).toBe(1);
  });
});
