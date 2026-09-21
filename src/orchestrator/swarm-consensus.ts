import { StateStore, SignalLedgerEntry } from '../services/state-store.js';
import { allowDecision, refuseDecision, type DecisionResult } from '../decision/decision-result.js';
import { RefusalCode } from '../decision/refusal-code.js';
import { aggregateVoterScores } from './voters.js';
import { globalSwarmLearning } from './swarm-learning.js';

export interface SignalCandidate {
  symbol: string;
  domain: 'MEME_ROBINHOOD' | 'NFT' | 'LP_ROBINHOOD';
  contractAddress?: string;
  liquidityUsd: number;
  volume1hUsd: number;
  securityAuditPassed: boolean;
  socialHypeScore: number; // 0 - 100
  confidence?: number; // agent-computed confidence (0-100); when present, swarm acts as pure gate
  /** Arch-3 7-voter swarm scores. When present, the weighted voter average becomes the confidence. */
  voterScores?: Partial<Record<string, number>>;
}

export interface ConsensusResult {
  passed: boolean;
  confidenceScore: number; // 0 - 100
  /** Shared decision-result envelope so callers can consume a stable refusal code. */
  decision?: DecisionResult<number>;
  breakdown: {
    quantScore: number;
    catalystScore: number;
    securityScore: number;
    reputationMultiplier: number;
    /** Per-voter swarm scores (voter path only; absent on the legacy path). */
    voters?: Record<string, number>;
  };
  reason: string;
}

export class SwarmConsensusEngine {
  private stateStore: StateStore | null = null;

  // Optional pluggable strategy provider (set by StrategyEngine wiring in index.ts)
  private static strategyProvider: ((domain: string) => { evaluate?: (ctx: any) => any } | null) | null = null;

  public static setStrategyProvider(fn: ((domain: string) => { evaluate?: (ctx: any) => any } | null) | null): void {
    SwarmConsensusEngine.strategyProvider = fn;
  }

  /**
   * Attach StateStore for immutable signal audit trail
   */
  public attachStateStore(store: StateStore): void {
    this.stateStore = store;
  }

  private activeOpposingIntents: Map<string, { domain: string; direction: 'LONG' | 'SHORT' | 'BUY' | 'SELL'; timestamp: number }> = new Map();

  /**
   * Register a direction intent from an agent (e.g. a SHORT on BTC vs a spot BUY) to enable Cross-Agent Veto
   */
  public registerAgentIntent(symbol: string, domain: string, direction: 'LONG' | 'SHORT' | 'BUY' | 'SELL'): void {
    const key = symbol.toUpperCase();
    this.activeOpposingIntents.set(key, { domain, direction, timestamp: Date.now() });
  }

  public evaluateSignal(candidate: SignalCandidate & { direction?: 'LONG' | 'SHORT' | 'BUY' | 'SELL' }): ConsensusResult {
    const symbolKey = candidate.symbol.toUpperCase();

    // Cross-Agent Conflict Veto Check (e.g., SHORT intent vs SPOT BUY)
    const existingIntent = this.activeOpposingIntents.get(symbolKey);
    if (existingIntent && Date.now() - existingIntent.timestamp < 60 * 60 * 1000) {
      const incomingDir = candidate.direction || 'BUY';
      const isConflict = 
        (existingIntent.direction === 'SHORT' || existingIntent.direction === 'SELL') && (incomingDir === 'BUY' || incomingDir === 'LONG') ||
        (existingIntent.direction === 'LONG' || existingIntent.direction === 'BUY') && (incomingDir === 'SELL' || incomingDir === 'SHORT');

      if (isConflict) {
        return {
          passed: false,
          confidenceScore: 0,
          decision: refuseDecision(
            `CONSENSUS_${candidate.domain}_${symbolKey}_VETO`,
            RefusalCode.CONSENSUS,
            `Cross-agent veto blocked ${symbolKey} (active ${existingIntent.direction} intent from ${existingIntent.domain}).`,
            [{ id: 'crossAgentVeto', passed: false }],
          ),
          breakdown: { quantScore: 0, catalystScore: 0, securityScore: 0, reputationMultiplier: 1.0 },
          reason: `🛑 **Cross-Agent Veto Block:** Opposing intent detected! ${existingIntent.domain} has an active ${existingIntent.direction} intent on $${symbolKey}, conflicting with incoming ${candidate.domain} ${incomingDir}. Order blocked to prevent hedging self-destruction.`,
        };
      }
    }

    // Agent reputation is always neutral (1.0) until wired to real trade outcomes;
    // evaluateSignal must never fail-open from a stale/nonexistent reputation entry.
    const reputationMultiplier = 1.0;

    // Agent-computed confidence path (new): swarm acts as pure gate
        let quantScore = 0;
        let catalystScore = 0;
        let securityScore = 0;
        let baseConfidence = 0;
        let isFastLane = false;
        let voterBreakdown: Record<string, number> | null = null;
        // Learning-bridged weights: the swarm-learning engine's recalibrated
        // emphasis feeds the voter aggregate (bounded ±30%, renormalized). Default
        // weights are used whenever learning has not diverged from baseline.
        const voterWeights = globalSwarmLearning.getVoterWeights();
        // Arch-3 7-voter swarm path: weighted average across the voters that rendered
        // a score (quant/ml/security/sentiment/whale/regime/critic). The meme agent's
        // own confidence rides in as the 'quant' vote, so nothing is lost.
        if (candidate.voterScores && Object.keys(candidate.voterScores).length > 0) {
          const agg = aggregateVoterScores(candidate.voterScores, voterWeights);
          baseConfidence = agg.score;
          voterBreakdown = agg.breakdown;
          quantScore = agg.breakdown['quant'] ?? 0;
          catalystScore = agg.breakdown['sentiment'] ?? 0;
          securityScore = agg.breakdown['security'] ?? 0;
        } else if (typeof candidate.confidence === 'number' && candidate.confidence > 0) {
          baseConfidence = candidate.confidence;
        } else {
      // Legacy path: recompute from quant/catalyst/security
      if (candidate.liquidityUsd >= 25000) quantScore += 50;
      if (candidate.volume1hUsd >= 10000) quantScore += 50;
      catalystScore = candidate.socialHypeScore;
      securityScore = candidate.securityAuditPassed ? 100 : 0;
      isFastLane = quantScore >= 90 && candidate.securityAuditPassed;
      baseConfidence = quantScore * 0.35 + catalystScore * 0.35 + securityScore * 0.30;
    }

    let confidenceScore = isFastLane
      ? Math.max(88, Math.min(100, Math.round(baseConfidence * reputationMultiplier)))
      : Math.min(100, Math.round(baseConfidence * reputationMultiplier));

    // Optional active strategy override (StrategyEngine) — blend with its evaluate() confidence.
    // NOT applied on the agent-confidence path: the agent already ran its own strategy extension in
    // runScreeningPass, and a global strategy must never suppress other domains via an empty ctx.
    const isAgentConfidencePath = typeof candidate.confidence === 'number' && candidate.confidence > 0;
    let strategyReason: string | null = null;
    if (!isAgentConfidencePath && SwarmConsensusEngine.strategyProvider) {
      try {
        const strat = SwarmConsensusEngine.strategyProvider(candidate.domain);
        if (strat?.evaluate) {
          // Sanitize env for the call — strategy .mjs files run in-process and must
          // never read private keys / API secrets (prompt-injection hardening).
          const snapshot = { ...process.env };
          const sensitiveKeys = Object.keys(process.env).filter((k) =>
            /KEY|TOKEN|SECRET|PRIVATE|PASSWORD|API/i.test(k) ||
            k.startsWith('EVM_') || k.startsWith('AI_')
          );
          for (const k of sensitiveKeys) delete process.env[k];
          let ev: any = null;
          try {
            ev = strat.evaluate({
              domain: candidate.domain,
              symbol: candidate.symbol,
              contractAddress: candidate.contractAddress,
              priceUsd: 0,
              liquidityUsd: candidate.liquidityUsd,
              volume24hUsd: candidate.volume1hUsd * 24,
              volume1hUsd: candidate.volume1hUsd,
              smartMoneyCount: 0,
              securityAuditPassed: candidate.securityAuditPassed,
              socialHypeScore: candidate.socialHypeScore,
            });
          } finally {
            process.env = snapshot;
          }
          if (ev && typeof ev.confidence === 'number') {
            confidenceScore = Math.round(confidenceScore * 0.5 + Math.max(0, Math.min(100, ev.confidence)) * 0.5);
            if (ev.reason) strategyReason = ev.reason;
          }
        }
      } catch (err: any) {
        console.warn(`[SWARM] Strategy evaluation failed for ${candidate.domain}: ${err.message}`);
      }
    }

    const passed = confidenceScore >= 80 && candidate.securityAuditPassed;

    const checks = [
      { id: 'confidence', passed: confidenceScore >= 80, reason: `${confidenceScore}% confidence` },
      { id: 'security', passed: candidate.securityAuditPassed, reason: candidate.securityAuditPassed ? 'audit passed' : 'audit failed' },
    ];
    const decision: DecisionResult<number> = passed
      ? allowDecision(confidenceScore, `CONSENSUS_${candidate.domain}_${symbolKey}_${Date.now()}_${Math.random().toString(36).substring(7)}`, checks)
      : refuseDecision(
          `CONSENSUS_${candidate.domain}_${symbolKey}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          RefusalCode.CONSENSUS,
          `Signal rejected (${confidenceScore}% confidence below 80% threshold or security failed).`,
          checks,
        );

    const result: ConsensusResult = {
      passed,
      confidenceScore,
      breakdown: {
        quantScore,
        catalystScore,
        securityScore,
        reputationMultiplier,
        ...(voterBreakdown ? { voters: voterBreakdown } : {}),
      },
      reason: passed
        ? strategyReason
          ? `Signal passed Multi-Agent Consensus (${confidenceScore}% confidence) + Strategy: ${strategyReason}`
          : isFastLane 
            ? `⚡ **FAST-LANE AGENT CONSENSUS PASSED** (${confidenceScore}% confidence, Sub-second High Conviction, Reputation Wt: ${reputationMultiplier.toFixed(2)}x).`
            : voterBreakdown
              ? `Signal passed 7-voter Swarm Consensus (${confidenceScore}% confidence; voters: ${JSON.stringify(voterBreakdown)}).`
              : `Signal passed Multi-Agent Consensus with ${confidenceScore}% confidence (Reputation Wt: ${reputationMultiplier.toFixed(2)}x).`
        : `Signal rejected (${confidenceScore}% confidence below 80% threshold or security failed).`,
    };

    result.decision = decision;

    // Append to immutable signal audit ledger
    if (this.stateStore) {
      const ledgerEntry: SignalLedgerEntry = {
        id: `SIG_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        timestamp: new Date().toISOString(),
        sourceAgent: candidate.domain,
        domain: candidate.domain,
        symbol: candidate.symbol,
        contractAddress: candidate.contractAddress || '',
        quantScore,
        catalystScore,
        securityScore,
        totalConfidence: confidenceScore,
        passed,
        reason: result.reason,
        rawPayloadJson: JSON.stringify(candidate),
      };
      this.stateStore.appendSignalLedger(ledgerEntry);
    }

    return result;
  }
}

export const AgentConsensusEngine = SwarmConsensusEngine;
export const MultiAgentConsensusEngine = SwarmConsensusEngine;
