import { describe, it, expect, vi } from 'vitest';
import {
  aggregateVoterScores,
  DEFAULT_VOTER_WEIGHTS,
  securityVote,
  whaleVote,
  regimeVote,
  scoresFromOpinions,
} from '../src/orchestrator/voters.js';
import { predictUpMomentum, rsi, fetchKlinesWithGeckoFallback, geckoNetworkIdFor, type KlineLike } from '../src/agents/shared/ml-predictor.js';
import { CriticVoter } from '../src/agents/shared/critic-voter.js';
import { SwarmConsensusEngine } from '../src/orchestrator/swarm-consensus.js';

// ── voters.ts ──────────────────────────────────────────────────────────────

describe('7-voter swarm aggregation', () => {
  it('weights average only the voters that rendered a score (missing voters ignored, never 0)', () => {
    const { score, breakdown } = aggregateVoterScores({ quant: 100, security: 100, ml: 50 });
    // weights: quant .2 + security .25 + ml .15 = .6 → (100*.2 + 100*.25 + 50*.15)/.6 = 87.5 → 88
    expect(score).toBe(88);
    expect(breakdown['sentiment']).toBeUndefined();
  });

  it('clamps scores to 0-100', () => {
    const { score } = aggregateVoterScores({ quant: 500, security: -10 });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('returns 0 when no voters rendered (denominator guard)', () => {
    const { score, breakdown } = aggregateVoterScores({});
    expect(score).toBe(0);
    expect(Object.keys(breakdown)).toHaveLength(0);
  });

  it('security vote is fail-closed (0 on audit failure, 100 on pass)', () => {
    expect(securityVote(false).score).toBe(0);
    expect(securityVote(true).score).toBe(100);
    expect(securityVote(true, ['concentration penalty']).score).toBe(90);
  });

  it('whale vote: accumulation lifts, full closes cap; no data → neutral 50', () => {
    const empty = whaleVote([]);
    expect(empty.score).toBe(50);
    const buyHeavy = whaleVote([
      { side: 'buy', amountUsd: 50000, isFullClose: false },
      { side: 'buy', amountUsd: 30000, isFullClose: false },
      { side: 'sell', amountUsd: 10000, isFullClose: false },
    ]);
    // netRatio = 70000/90000 = 0.777 → 50 + 31.1 = 81
    expect(buyHeavy.score).toBe(81);
    const exited = whaleVote([
      { side: 'buy', amountUsd: 1000, isFullClose: false },
      { side: 'sell', amountUsd: 1500, isFullClose: true },
    ]);
    // netRatio = -0.2 → 42 − 10 (full close) = 32
    expect(exited.score).toBe(32);
  });

  it('regime vote: risk-off caps at 45', () => {
    const riskOff = regimeVote({ volatilityIndex: 40, riskOff: true });
    expect(riskOff.score).toBeLessThanOrEqual(45);
    const calm = regimeVote({ volatilityIndex: 10, riskOff: false });
    expect(calm.score).toBe(60);
    expect(regimeVote(null).score).toBe(50);
  });

  it('scoresFromOpinions maps rendered opinions to VoterScores', () => {
    const map = scoresFromOpinions([
      { voter: 'quant', score: 90, reasons: ['a'] },
      { voter: 'ml', score: 40, reasons: ['b'] },
    ]);
    expect(map).toEqual({ quant: 90, ml: 40 });
  });
});

// ── ml-predictor.ts ────────────────────────────────────────────────────────

const mkCandles = (closes: number[], volume = 1000): KlineLike[] =>
  closes.map((c, i) => ({
    timestamp: 1700000000 + i * 900,
    open: c * 0.99,
    high: c * 1.02,
    low: c * 0.97,
    close: c,
    volume,
  }));

describe('ML momentum predictor', () => {
  it('returns neutral 50 when klines are insufficient (fail-closed, never confident)', () => {
    const r = predictUpMomentum(mkCandles([1, 2, 3]));
    expect(r.score).toBe(50);
    expect(r.pUp).toBe(0.5);
    expect(r.reasons[0]).toContain('insufficient');
  });

  it('strong upward momentum scores above 50 with reasons', () => {
    const up = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    const r = predictUpMomentum(mkCandles(up));
    expect(r.score).toBeGreaterThan(60);
    expect(r.pUp).toBeGreaterThan(0.6);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('declining momentum scores below 50', () => {
    const down = Array.from({ length: 20 }, (_, i) => 200 - i * 10);
    const r = predictUpMomentum(mkCandles(down));
    expect(r.score).toBeLessThan(50);
  });

  it('rsi computes extremes (all up → 100, all down → 0) and null when short', () => {
    expect(rsi([0])).toBeNull();
    const up = Array.from({ length: 15 }, (_, i) => i);
    expect(rsi(up, 14)).toBe(100);
    const down = Array.from({ length: 15 }, (_, i) => 100 - i);
    expect(rsi(down, 14)).toBe(0);
  });
});

// ── GeckoTerminal kline failover (ml-predictor.ts) ─────────────────────────

describe('Gecko kline failover', () => {
  const k = (close: number): KlineLike => ({ timestamp: 1, open: close, high: close, low: close, close, volume: 1 });

  it('geckoNetworkIdFor maps GMGN chains to GeckoTerminal network ids', () => {
    expect(geckoNetworkIdFor('sol')).toBe('solana');
    expect(geckoNetworkIdFor('bsc')).toBe('bsc');
    expect(geckoNetworkIdFor('base')).toBe('base');
    expect(geckoNetworkIdFor('eth')).toBe('eth');
    expect(geckoNetworkIdFor('robinhood')).toBe('robinhood');
    expect(geckoNetworkIdFor('unknown')).toBeNull();
  });

  it('returns the primary (GMGN) klines when present — Gecko never called', async () => {
    const primary = vi.fn(async () => [k(1), k(2)]);
    const deps = { resolvePool: vi.fn(), fetchKlines: vi.fn() };
    const out = await fetchKlinesWithGeckoFallback(primary, 'bsc', '0xaddr', deps as any);
    expect(out).toHaveLength(2);
    expect(deps.resolvePool).not.toHaveBeenCalled();
    expect(deps.fetchKlines).not.toHaveBeenCalled();
  });

  it('falls back to Gecko when the primary throws (429/failure)', async () => {
    const primary = vi.fn(async () => { throw new Error('gmgn 429'); });
    const deps = {
      resolvePool: vi.fn(async () => '0xpool'),
      fetchKlines: vi.fn(async () => [k(3), k(4)]),
    };
    const out = await fetchKlinesWithGeckoFallback(primary, 'eth', '0xaddr', deps as any);
    expect(out).toHaveLength(2);
    expect(deps.resolvePool).toHaveBeenCalledWith('eth', '0xaddr');
  });

  it('returns null when primary is empty and no Gecko network id resolves', async () => {
    const primary = vi.fn(async () => null);
    const deps = { resolvePool: vi.fn(), fetchKlines: vi.fn() };
    const out = await fetchKlinesWithGeckoFallback(primary, null, '0xaddr', deps as any);
    expect(out).toBeNull();
    expect(deps.resolvePool).not.toHaveBeenCalled();
  });

  it('returns null when no Gecko pool resolves (fail-closed, ML stays neutral)', async () => {
    const primary = vi.fn(async () => null);
    const deps = { resolvePool: vi.fn(async () => null), fetchKlines: vi.fn() };
    const out = await fetchKlinesWithGeckoFallback(primary, 'base', '0xaddr', deps as any);
    expect(out).toBeNull();
    expect(deps.fetchKlines).not.toHaveBeenCalled();
  });
});

// ── critic-voter.ts ────────────────────────────────────────────────────────

describe('Critic voter', () => {
  const criticInput = {
    token: {
      address: '0xabc', symbol: 'TEST', name: 'Test', chain: 'base', priceUsd: 0.001,
      marketCapUsd: 150000, liquidityUsd: 50000, volume1hUsd: 120000,
      buys: 200, sells: 50, holderCount: 500, smartDegenCount: 2, renownedCount: 0,
      rugRatio: null, bundlerRate: null, top10HolderRate: null, creatorClose: false,
    } as any,
    chain: 'base',
    thesis: 'momentum play',
    reasons: ['high volume'],
  };

  it('returns neutral 50 without an AI service (fail-open)', async () => {
    const voter = new CriticVoter(null);
    expect(voter.isAvailable()).toBe(false);
    const opinion = await voter.evaluate(criticInput);
    expect(opinion.score).toBe(50);
    expect(opinion.reasons[0]).toContain('unavailable');
  });

  it('parses SCORE from an LLM reply and keeps failure reasons', async () => {
    const fakeAi = {
      generateCompletion: vi.fn(async () => '- Top-10 holders are 60%+ of supply\n- Volume is bot-driven\nSCORE: 25'),
    } as any;
    const voter = new CriticVoter(fakeAi);
    const opinion = await voter.evaluate(criticInput);
    expect(opinion.score).toBe(25);
    expect(opinion.reasons).toHaveLength(2);
    expect(fakeAi.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('LLM failure (throw) → neutral 50, never crashes the pass', async () => {
    const failingAi = {
      generateCompletion: vi.fn(async () => { throw new Error('timeout'); }),
    } as any;
    const voter = new CriticVoter(failingAi);
    const opinion = await voter.evaluate(criticInput);
    expect(opinion.score).toBe(50);
  });

  it('unparsable reply → neutral 50 (never fabricates a score)', async () => {
    const oddAi = { generateCompletion: vi.fn(async () => 'the token seems fine i think') } as any;
    const opinion = await new CriticVoter(oddAi).evaluate(criticInput);
    expect(opinion.score).toBe(50);
  });
});

// ── swarm-consensus voter path ─────────────────────────────────────────────

describe('Swarm consensus voter path', () => {
  const engine = new SwarmConsensusEngine();
  const baseCandidate = {
    symbol: 'TEST', domain: 'MEME_ROBINHOOD' as const, contractAddress: '0xabc',
    liquidityUsd: 60000, volume1hUsd: 120000, securityAuditPassed: true,
    socialHypeScore: 80,
  };

  it('re-derives confidence from the weighted voter average when voterScores present', () => {
    const res = engine.evaluateSignal({
      ...baseCandidate,
      voterScores: { quant: 90, ml: 85, security: 100, sentiment: 80, whale: 70, regime: 60, critic: 85 },
    });
    expect(res.passed).toBe(true);
    expect(res.confidenceScore).toBeGreaterThanOrEqual(80);
    expect(res.breakdown.voters).toBeDefined();
    expect(res.reason).toContain('Swarm');
  });

  it('voter-weighted confidence below 80 rejects even when quant is 100 (swarm has final word)', () => {
    const res = engine.evaluateSignal({
      ...baseCandidate,
      voterScores: { quant: 100, ml: 10, security: 0, sentiment: 20, whale: 10, regime: 5, critic: 10 },
    });
    expect(res.passed).toBe(false);
    expect(res.confidenceScore).toBeLessThan(80);
  });

  it('legacy path (no voterScores) keeps the old confidence-gate behavior', () => {
    const res = engine.evaluateSignal({ ...baseCandidate, confidence: 95 });
    expect(res.passed).toBe(true);
    expect(res.confidenceScore).toBe(95);
    expect(res.breakdown.voters).toBeUndefined();
  });

  it('default voter weights are defined and sum to ~1.0', () => {
    const total = Object.values(DEFAULT_VOTER_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 2);
  });
});
