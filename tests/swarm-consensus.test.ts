import { describe, it, expect, vi, afterEach } from 'vitest';
import { SwarmConsensusEngine } from '../src/orchestrator/swarm-consensus.js';
import { isAllowed } from '../src/decision/decision-result.js';
import { RefusalCode } from '../src/decision/refusal-code.js';
import { CONSENSUS_FLOOR } from '../src/orchestrator/swarm-guards.js';

describe('Swarm Consensus gate-only path (agent-computed confidence)', () => {
  const swarm = new SwarmConsensusEngine();
  /** Agent-confidence candidate at an exact confidence level. */
  const candidate = (confidence: number) => ({
    symbol: `C_${confidence}`,
    domain: 'MEME_ROBINHOOD' as const,
    contractAddress: `c${confidence}`,
    liquidityUsd: 0,
    volume1hUsd: 0,
    securityAuditPassed: true,
    socialHypeScore: 0,
    confidence,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    SwarmConsensusEngine.setStrategyProvider(null);
  });

  // The floor constant is derived from CONSENSUS_FLOOR; this is the single
  // owner of the boundary pair. Other suites that asserted a bare `80` were
  // re-asserting a derived literal without pinning the constant itself.
  it('the consensus floor is CONSENSUS_FLOOR, inclusive at the boundary', () => {
    expect(CONSENSUS_FLOOR).toBe(0.8);
    const floor = Math.round(CONSENSUS_FLOOR * 100);
    const at = swarm.evaluateSignal(candidate(floor));
    const below = swarm.evaluateSignal(candidate(floor - 1));
    expect(at.passed).toBe(true);
    expect(below.passed).toBe(false);
  });

  it('passes a candidate with agent confidence 85 + securityAuditPassed true', () => {
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal({
      symbol: 'GATE_85',
      domain: 'MEME_ROBINHOOD',
      contractAddress: 'gate85',
      liquidityUsd: 0,
      volume1hUsd: 0,
      securityAuditPassed: true,
      socialHypeScore: 0,
      confidence: 85,
    });
    expect(res.passed).toBe(true);
    expect(res.confidenceScore).toBeGreaterThanOrEqual(80);
  });

  it('rejects a candidate with agent confidence 50', () => {
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal({
      symbol: 'GATE_50',
      domain: 'MEME_ROBINHOOD',
      contractAddress: 'gate50',
      liquidityUsd: 0,
      volume1hUsd: 0,
      securityAuditPassed: true,
      socialHypeScore: 0,
      confidence: 50,
    });
    expect(res.passed).toBe(false);
    expect(res.confidenceScore).toBeLessThan(80);
  });

  it('gate-only path ignores a fail-closed global strategy provider (no blend suppression)', () => {
    SwarmConsensusEngine.setStrategyProvider(() => ({
      evaluate: () => ({ confidence: 0, recommendedAction: 'SKIP', reason: 'fail-closed' }),
    }));
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal({
      symbol: 'GATE_STRAT',
      domain: 'MEME_ROBINHOOD',
      contractAddress: 'gate-strat',
      liquidityUsd: 0,
      volume1hUsd: 0,
      securityAuditPassed: true,
      socialHypeScore: 0,
      confidence: 85,
    });
    expect(res.passed).toBe(true);
    expect(res.confidenceScore).toBeGreaterThanOrEqual(80);
  });

  it('exposes a shared allowDecision result on a passed signal', () => {
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal({
      symbol: 'DECISION_PASS',
      domain: 'MEME_ROBINHOOD',
      contractAddress: 'decision-pass',
      liquidityUsd: 0,
      volume1hUsd: 0,
      securityAuditPassed: true,
      socialHypeScore: 0,
      confidence: 85,
    });
    expect(res.decision).toBeDefined();
    expect(isAllowed(res.decision!)).toBe(true);
    if (res.decision?.allowed) {
      expect(res.decision.value).toBe(res.confidenceScore);
      expect(res.decision.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'confidence', passed: true }),
      ]));
    }
  });

  it('exposes a shared CONSENSUS refusal result on a rejected signal', () => {
    const swarm = new SwarmConsensusEngine();
    const res = swarm.evaluateSignal({
      symbol: 'DECISION_REJECT',
      domain: 'MEME_ROBINHOOD',
      contractAddress: 'decision-reject',
      liquidityUsd: 0,
      volume1hUsd: 0,
      securityAuditPassed: true,
      socialHypeScore: 0,
      confidence: 50,
    });
    expect(res.decision).toBeDefined();
    expect(res.decision?.allowed).toBe(false);
    if (!res.decision?.allowed) {
      expect(res.decision.refusal).toBe(RefusalCode.CONSENSUS);
      expect(res.decision.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'confidence', passed: false }),
      ]));
    }
  });
});
