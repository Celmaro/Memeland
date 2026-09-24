import { StateStore, SignalLedgerEntry } from '../services/state-store.js';
import { allowDecision, refuseDecision, type DecisionResult } from '../decision/decision-result.js';
import { RefusalCode } from '../decision/refusal-code.js';
import { aggregateVoterScores } from './voters.js';
import { globalSwarmLearning } from './swarm-learning.js';
import {
  regimeAwareFloor,
  resolveConflict,
  calibratedConfidence,
  cohortVote,
  CircuitBreaker,
  StickyConviction,
  type Regime,
  type DirectionVote,
} from './swarm-guards.js';

export interface SignalCandidate {
  symbol: string;
  domain: 'MEME_ROBINHOOD';
  contractAddress?: string;
  liquidityUsd: number;
  volume1hUsd: number;
  securityAuditPassed: boolean;
  socialHypeScore: number; // 0 - 100
  confidence?: number; // agent-computed confidence (0-100); when present, swarm acts as pure gate
  /** Arch-3 10-voter swarm scores. When present, the weighted voter average becomes the confidence. */
  voterScores?: Partial<Record<string, number>>;
  /** Kernel B — prism-insight regime (raises the consensus floor in a bear market). */
  regime?: Regime;
  /** Kernel B — Decision Hub asymmetric conflict (1BUY + 2SELL = veto). */
  directionVotes?: DirectionVote[];
  /** Kernel B — zetryn downgrade-only calibration map (score -> calibrated). */
  calibrationMap?: Record<number, number>;
  /** Kernel B — FlySwarm cohort overlap; high crime-noise lowers confidence. */
  cohort?: { observed: string[]; cohort: string[] };
  /** Kernel B — azimuth sticky-conviction key; holds the last confidence within TTL. */
  stickyKey?: string;
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

  // Kernel B wiring (swarm-guards): circuit breaker + sticky conviction live on
  // the engine so failures/successes and conviction can be recorded by index.ts.
  private readonly circuitBreaker = new CircuitBreaker(3, 3_600_000);
  private readonly sticky = new StickyConviction(300_000);

  /**
   * Register a direction intent from an agent (e.g. a SHORT on BTC vs a spot BUY) to enable Cross-Agent Veto
   */
  public registerAgentIntent(symbol: string, domain: string, direction: 'LONG' | 'SHORT' | 'BUY' | 'SELL'): void {
    const key = symbol.toUpperCase();
    this.activeOpposingIntents.set(key, { domain, direction, timestamp: Date.now() });
  }

  /** Kernel B — pump-scanner circuit breaker: record a signal outcome (failed => toward open). */
  public registerConsensusOutcome(failed: boolean): { tripped: boolean; cooldownMs: number } {
    return this.circuitBreaker.record(failed);
  }

  public resetConsensusCircuit(): void {
    this.circuitBreaker.reset();
  }

  /** Kernel B — azimuth sticky conviction: read the held confidence for a key. */
  public getConviction(key: string): number | null {
    return this.sticky.get(key);
  }

  public setConviction(key: string, value: number): void {
    this.sticky.store(key, value);
  }

  public evaluateSignal(candidate: SignalCandidate & { direction?: 'LONG' | 'SHORT' | 'BUY' | 'SELL' }): ConsensusResult {
    const symbolKey = candidate.symbol.toUpperCase();

    // Kernel B — circuit breaker: a tripped circuit refuses before any scoring.
    if (this.circuitBreaker.isOpen()) {
      const id = `CONSENSUS_${candidate.domain}_${symbolKey}_CIRCUIT_${Date.now()}`;
      return {
        passed: false,
        confidenceScore: 0,
        decision: refuseDecision(
          id,
          RefusalCode.CIRCUIT_OPEN,
          `Circuit breaker open for ${candidate.domain}.`,
          [{ id: 'circuit', passed: false, reason: 'circuit open' }],
        ),
        breakdown: { quantScore: 0, catalystScore: 0, securityScore: 0, reputationMultiplier: 1.0 },
        reason: `🛑 **Circuit Open:** recent consensus failures tripped the breaker — ${candidate.domain} signals refused during the cooldown.`,
      };
    }

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

    // Kernel B — Decision Hub asymmetric conflict veto (1BUY + 2SELL = block).
    if (candidate.directionVotes && candidate.directionVotes.length > 0) {
      const conflict = resolveConflict(candidate.directionVotes);
      if (conflict.conflicted && !conflict.resume) {
        const id = `CONSENSUS_${candidate.domain}_${symbolKey}_ASYMMETRIC_${Date.now()}`;
        return {
          passed: false,
          confidenceScore: 0,
          decision: refuseDecision(
            id,
            RefusalCode.ASYMMETRIC_CONFLICT,
            `${conflict.reason ?? 'asymmetric conflict'} on ${symbolKey}.`,
            [{ id: 'directionConflict', passed: false, reason: conflict.reason }],
          ),
          breakdown: { quantScore: 0, catalystScore: 0, securityScore: 0, reputationMultiplier: 1.0 },
          reason: `🛑 **Asymmetric Conflict Block:** ${conflict.reason} on $${symbolKey}.`,
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
        // Arch-3 10-voter swarm path: weighted average across the voters that rendered
        // a score (quant/ml/security/sentiment/whale/regime/critic/wallet/convergence/rubric).
        // The meme agent's own confidence rides in as the 'quant' vote, so nothing is lost.
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

    // Kernel B — zetryn downgrade-only calibration: never let a calibrated value
    // exceed the raw score.
    if (candidate.calibrationMap) {
      baseConfidence = calibratedConfidence(baseConfidence, candidate.calibrationMap);
    }

    // Kernel B — FlySwarm cohort overlap: high overlap with a known cohort
    // distrusts the signal (safety demerit, additive and optional).
    let cohortReason = '';
    if (candidate.cohort && candidate.cohort.observed.length > 0) {
      const cohort = cohortVote(candidate.cohort.observed, candidate.cohort.cohort);
      if (cohort.crimeNoise >= 0.6) {
        baseConfidence = Math.max(0, baseConfidence - Math.round(cohort.crimeNoise * 30));
        cohortReason = ` (cohort overlap ${(cohort.crimeNoise * 100).toFixed(0)}% distrusts)`;
      }
    }

    // Kernel B — azimuth sticky conviction: hold the last confidence for a key
    // within TTL so a brief re-check cannot erode a fresh high-conviction read.
    if (candidate.stickyKey) {
      const held = this.sticky.get(candidate.stickyKey);
      if (held !== null && held > baseConfidence) baseConfidence = held;
      this.sticky.store(candidate.stickyKey, baseConfidence);
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

    // Single 80% quorum floor in every regime (regimeAwareFloor). The regime
    // votes through the regime voter, not a raised floor.
    const floor = Math.round(regimeAwareFloor(candidate.regime ?? 'CHOP') * 100);
    const passed = confidenceScore >= floor && candidate.securityAuditPassed;

    const checks = [
      { id: 'confidence', passed: confidenceScore >= floor, reason: `${confidenceScore}% confidence (floor ${floor}%)` },
      { id: 'security', passed: candidate.securityAuditPassed, reason: candidate.securityAuditPassed ? 'audit passed' : 'audit failed' },
    ];
    if (candidate.regime) checks.push({ id: 'regime', passed: true, reason: `regime ${candidate.regime} scored via regime voter` });
    const decision: DecisionResult<number> = passed
      ? allowDecision(confidenceScore, `CONSENSUS_${candidate.domain}_${symbolKey}_${Date.now()}_${Math.random().toString(36).substring(7)}`, checks)
      : refuseDecision(
          `CONSENSUS_${candidate.domain}_${symbolKey}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          (candidate.regime === 'TRENDING_BEAR' || candidate.regime === 'EXTREME_VOLATILITY') && confidenceScore < floor ? RefusalCode.REGIME_REJECTED : RefusalCode.CONSENSUS,
          `Signal rejected (${confidenceScore}% confidence below ${floor}% threshold or security failed).`,
          checks,
        );

    // Kernel B — record the outcome so repeated failures trip the circuit breaker.
    // NOTE (2026-09-24, live-log audit): do NOT auto-record normal gate
    // rejections here. The >=80% floor is an intentional filter — most
    // candidates legitimately score below it, and with the keyless-feed
    // discovery tier now delivering 10-16 candidates/cycle, 3 quick rejections
    // opened the breaker and silently discarded every subsequent candidate for
    // an hour (observed live: all gate refusals became CIRCUIT_OPEN 0%).
    // The breaker is for SYSTEM-level failures (provider outage, exception
    // storm) — trip it explicitly via registerConsensusOutcome(true) from the
    // caller when the consensus ENGINE itself fails, not on ordinary rejects.
    // this.registerConsensusOutcome(!passed);

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
              ? `Signal passed 10-voter Swarm Consensus (${confidenceScore}% confidence; voters: ${JSON.stringify(voterBreakdown)})${cohortReason}.`
              : `Signal passed Multi-Agent Consensus with ${confidenceScore}% confidence (Reputation Wt: ${reputationMultiplier.toFixed(2)}x).`
        : `Signal rejected (${confidenceScore}% confidence below ${floor}% threshold or security failed).`,
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
