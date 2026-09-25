import { describe, it, expect } from 'vitest';
import {
  whaleVote,
  securityVote,
  aggregateVoterScores,
  scoresFromOpinions,
  VOTER_IDS,
  DEFAULT_VOTER_WEIGHTS,
  walletVote,
  convergenceVote,
  rubricVote,
  type VoterContext,
} from '../src/orchestrator/voters.js';

const baseCtx = (): VoterContext => ({
  token: {} as never,
  chain: 'solana',
  nativePriceUsd: null,
  securityAuditPassed: true,
  signalConfidence: 50,
});

// ── walletVote (Q03) ────────────────────────────────────────────────────────

describe('walletVote', () => {
  it('is monotonic: higher wallet score => higher 0-100 vote', () => {
    const low = walletVote({ ...baseCtx(), walletMetrics: { netFlowRatio: -0.5, top10HolderRate: 0.1, distinctMakers: 6 } });
    const high = walletVote({ ...baseCtx(), walletMetrics: { netFlowRatio: 0.8, top10HolderRate: 0.1, distinctMakers: 6 } });
    expect(high.score).toBeGreaterThan(low.score);
    expect(low.score).toBeGreaterThanOrEqual(0);
    expect(high.score).toBeLessThanOrEqual(100);
  });

  it('is neutral (50) when metrics are missing — never a false win', () => {
    expect(walletVote(baseCtx()).score).toBe(50);
  });

  it('is neutral (50) when required input degrades (missing net flow)', () => {
    const v = walletVote({ ...baseCtx(), walletMetrics: { top10HolderRate: 0.1, distinctMakers: 6 } });
    expect(v.score).toBe(50);
  });
});

// ── convergenceVote (Q05) ───────────────────────────────────────────────────

const now = Date.now();

describe('convergenceVote', () => {
  it('is monotonic: more distributed volume raises the score', () => {
    const mk = (amountUsd: number) =>
      Array.from({ length: 8 }, (_, i) => ({ wallet: `w${i}`, amountUsd, timestamp: now }));
    const low = convergenceVote({ ...baseCtx(), convergence: { buys: mk(2000) } });
    const high = convergenceVote({ ...baseCtx(), convergence: { buys: mk(60000) } });
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.score).toBeLessThanOrEqual(100);
  });

  it('a single whale does NOT count as convergence (neutral 50)', () => {
    const v = convergenceVote({
      ...baseCtx(),
      convergence: { buys: [{ wallet: 'whale1', amountUsd: 500000, timestamp: now }] },
    });
    expect(v.score).toBe(50);
  });

  it('stale buys (outside window) are neutral 50', () => {
    const stale = now - 60 * 60 * 1000; // 1h old, beyond 15m window
    const v = convergenceVote({
      ...baseCtx(),
      convergence: {
        buys: Array.from({ length: 8 }, (_, i) => ({ wallet: `w${i}`, amountUsd: 10000, timestamp: stale })),
      },
    });
    expect(v.score).toBe(50);
  });

  it('is neutral (50) when no flow data', () => {
    expect(convergenceVote(baseCtx()).score).toBe(50);
  });
});

// ── rubricVote (Q12) ────────────────────────────────────────────────────────

describe('rubricVote', () => {
  it('is monotonic: higher safety (lower concentration) => higher score', () => {
    const clean = rubricVote({
      ...baseCtx(),
      rubricMetrics: { concentration: 0.2, liquidityUsd: 200000, spikePct: 50, volatility: 40 },
    });
    const concentrated = rubricVote({
      ...baseCtx(),
      rubricMetrics: { concentration: 0.9, liquidityUsd: 200000, spikePct: 50, volatility: 40 },
    });
    expect(clean.score).toBeGreaterThan(concentrated.score);
    expect(clean.score).toBeGreaterThan(50);
  });

  it('spike moves the score down', () => {
    const calm = rubricVote({ ...baseCtx(), rubricMetrics: { concentration: 0.2, liquidityUsd: 200000, spikePct: 10, volatility: 40 } });
    const spiked = rubricVote({ ...baseCtx(), rubricMetrics: { concentration: 0.2, liquidityUsd: 200000, spikePct: 290, volatility: 40 } });
    expect(calm.score).toBeGreaterThan(spiked.score);
  });

  it('a missing REQUIRED factor cannot yield a clean score — neutral (fail closed)', () => {
    const missingConcentration = rubricVote({
      ...baseCtx(),
      rubricMetrics: { liquidityUsd: 200000, spikePct: 50, volatility: 40 },
    });
    expect(missingConcentration.score).toBe(50);
    // empty rubricMetrics also fail-closed
    expect(rubricVote({ ...baseCtx(), rubricMetrics: {} }).score).toBe(50);
  });

  it('is neutral (50) when rubric metrics are absent entirely', () => {
    expect(rubricVote(baseCtx()).score).toBe(50);
  });
});

// ── existing exports intact + new ids weighted ─────────────────────────────

describe('existing voters exports remain intact and new ids are weighted', () => {
  it('keeps all original voter exports', () => {
    expect(typeof whaleVote).toBe('function');
    expect(typeof securityVote).toBe('function');
    expect(typeof aggregateVoterScores).toBe('function');
    expect(typeof scoresFromOpinions).toBe('function');
    expect(typeof walletVote).toBe('function');
    expect(typeof convergenceVote).toBe('function');
    expect(typeof rubricVote).toBe('function');
  });

  it('registers the consolidated voter ids in VOTER_IDS and DEFAULT_VOTER_WEIGHTS', () => {
    for (const id of ['momentum', 'flow', 'security', 'sentiment', 'critic'] as const) {
      expect(VOTER_IDS).toContain(id);
      expect(typeof DEFAULT_VOTER_WEIGHTS[id]).toBe('number');
    }
  });

  it('aggregateVoterScores still weights the consolidated voter ids', () => {
    // If flow were not weighted, {momentum:100, flow:0} would collapse to momentum alone => 100.
    const { score, breakdown } = aggregateVoterScores({ momentum: 100, flow: 0 });
    expect(score).toBeLessThan(100);
    expect(breakdown['flow']).toBe(0);
    // Lone consolidated voters aggregate to their own clamped score.
    expect(aggregateVoterScores({ flow: 80 }).score).toBe(80);
    expect(aggregateVoterScores({ critic: 60 }).score).toBe(60);
  });
});
