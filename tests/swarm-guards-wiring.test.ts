import { describe, it, expect, afterEach } from 'vitest';
import { SwarmConsensusEngine } from '../src/orchestrator/swarm-consensus.js';
import { RefusalCode } from '../src/decision/refusal-code.js';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'WIRE',
    domain: 'MEME_ROBINHOOD' as const,
    contractAddress: 'wire',
    liquidityUsd: 0,
    volume1hUsd: 0,
    securityAuditPassed: true,
    socialHypeScore: 0,
    confidence: 85,
    ...overrides,
  };
}

describe('Kernel B guard wiring (swarm-guards -> swarm-consensus)', () => {
  afterEach(() => SwarmConsensusEngine.setStrategyProvider(null));

  it('regime removed: the floor is a flat 80% — bear/risk-off no longer changes the refusal', () => {
    const normal = new SwarmConsensusEngine();
    expect(normal.evaluateSignal(candidate()).passed).toBe(true);

    const bear = new SwarmConsensusEngine();
    expect(bear.evaluateSignal(candidate({ regime: 'TRENDING_BEAR' })).passed).toBe(true);

    const lowBear = new SwarmConsensusEngine();
    const res = lowBear.evaluateSignal(candidate({ symbol: 'LOWB', regime: 'TRENDING_BEAR', confidence: 70 }));
    expect(res.passed).toBe(false);
    // Regime voter is gone — a sub-80 reject is a plain CONSENSUS refusal, never REGIME_REJECTED.
    expect(res.decision?.refusal).toBe(RefusalCode.CONSENSUS);

    const lowChop = new SwarmConsensusEngine();
    const chop = lowChop.evaluateSignal(candidate({ symbol: 'LOWC', regime: 'CHOP', confidence: 70 }));
    expect(chop.passed).toBe(false);
    expect(chop.decision?.refusal).toBe(RefusalCode.CONSENSUS);
    expect(res.breakdown.voters ?? res.confidenceScore).toBeDefined();
  });

  it('circuit breaker: ordinary gate rejections do NOT trip it (2026-09-24 fix) — a later strong signal is still scored', () => {
      const swarm = new SwarmConsensusEngine();
      // 3 ordinary rejects (below the 80% floor) — the old code auto-recorded
      // these toward the breaker, which opened the circuit after the 3rd and
      // silently discarded every candidate for an hour. Now they leave the
      // breaker untouched: a later 90%-confidence signal is scored normally.
      swarm.evaluateSignal(candidate({ symbol: 'CIRC', confidence: 50 }));
      swarm.evaluateSignal(candidate({ symbol: 'CIRC', confidence: 50 }));
      swarm.evaluateSignal(candidate({ symbol: 'CIRC', confidence: 50 }));
      const res = swarm.evaluateSignal(candidate({ symbol: 'CIRC', confidence: 90 }));
      expect(res.passed).toBe(true); // scored, not CIRCUIT_OPEN
      if (res.decision && !res.decision.allowed) {
        expect(res.decision.refusal).not.toBe(RefusalCode.CIRCUIT_OPEN);
      }
    });

    it('circuit breaker: explicit system failures (registerConsensusOutcome(true) x3) trip it and refuse the next signal as CIRCUIT_OPEN', () => {
      const swarm = new SwarmConsensusEngine();
      // System-level failures (provider outage / engine exception) trip the
      // breaker explicitly from the caller — the documented trip path.
      swarm.registerConsensusOutcome(true);
      swarm.registerConsensusOutcome(true);
      swarm.registerConsensusOutcome(true);
      const res = swarm.evaluateSignal(candidate({ symbol: 'CIRC', confidence: 90 }));
      expect(res.passed).toBe(false);
      expect(res.confidenceScore).toBe(0);
      expect(res.decision?.allowed).toBe(false);
      if (res.decision && !res.decision.allowed) {
        expect(res.decision.refusal).toBe(RefusalCode.CIRCUIT_OPEN);
      }
    });

  it('asymmetric conflict: 1BUY + 2SELL is vetoed as ASYMMETRIC_CONFLICT before scoring', () => {
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal(
      candidate({
        directionVotes: [
          { side: 'BUY', weight: 1 },
          { side: 'SELL', weight: 1 },
          { side: 'SELL', weight: 1 },
        ],
      }),
    );
    expect(res.passed).toBe(false);
    if (res.decision && !res.decision.allowed) {
      expect(res.decision.refusal).toBe(RefusalCode.ASYMMETRIC_CONFLICT);
    }
  });

  it('zetryn downgrade-only calibration: a calibrated 70 cannot pass even though the raw score is 85', () => {
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal(candidate({ calibrationMap: { 85: 70 } }));
    expect(res.passed).toBe(false);
    expect(res.confidenceScore).toBe(70);
  });

  it('FlySwarm cohort overlap distrusts the signal (85 -> below floor on full overlap)', () => {
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal(
      candidate({ confidence: 80, cohort: { observed: ['a', 'b', 'c'], cohort: ['a', 'b', 'c'] } }),
    );
    expect(res.passed).toBe(false);
    expect(res.confidenceScore).toBeLessThan(80);
  });

  it('azimuth sticky conviction holds a fresh high-conviction read across a later low re-check', () => {
    const swarm = new SwarmConsensusEngine();
    expect(swarm.evaluateSignal(candidate({ stickyKey: 'MEME', confidence: 85 })).passed).toBe(true);
    const recheck = swarm.evaluateSignal(candidate({ stickyKey: 'MEME', confidence: 50 }));
    expect(recheck.passed).toBe(true);
    expect(recheck.confidenceScore).toBe(85);
  });
});
