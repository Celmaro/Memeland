import fs from 'fs';
import path from 'path';
import { atomicWriteJsonSync } from '../storage/atomic-file-store.js';
import type { VoterId } from './voters.js';
import { deflationFactor, deflatedSharpe } from './learning-harness.js';
import { icWeightDeltas, applyDeltas } from './scoring-calibration.js';

export interface SignalOutcome {
  id: string;
  agentId: string;
  symbol: string;
  contractAddress: string;
  initialPriceUsd: number;
  maxPriceReachedUsd: number;
  lowestPriceReachedUsd: number;
  result: 'TAKE_PROFIT_2X' | 'TAKE_PROFIT_1_5X' | 'STOP_LOSS' | 'OPEN';
  confidenceScore: number;
  timestampIso: string;
}

export interface SwarmWeights {
  smartMoneyWeight: number; // default 0.35
  liquidityWeight: number;  // default 0.25
  devHoldingWeight: number; // default 0.20
  twitterWeight: number;    // default 0.20
}

/** Baseline voter weights — mirror of DEFAULT_VOTER_WEIGHTS in voters.ts (5 consolidated slots). */
const BASE_VOTER_WEIGHTS: Record<VoterId, number> = {
  momentum: 0.30,
  flow: 0.20,
  security: 0.25,
  sentiment: 0.15,
  critic: 0.10,
};

const LEARNING_DEFAULTS = {
  smartMoney: 0.35,
  liquidity: 0.25,
  devHolding: 0.20,
  twitter: 0.20,
};

/** Learning-weight keys calibrated by IC-weighted deltas. */
const VOTER_KEYS: Array<keyof SwarmWeights> = [
  'smartMoneyWeight',
  'liquidityWeight',
  'devHoldingWeight',
  'twitterWeight',
];

export class SwarmLearningEngine {
  private dbPath: string;
  private outcomes: SignalOutcome[] = [];
  private verbalReflector = false;
  private weights: SwarmWeights = {
    smartMoneyWeight: 0.35,
    liquidityWeight: 0.25,
    devHoldingWeight: 0.20,
    twitterWeight: 0.20,
  };
  private lastCalibrationReason: string | null = null;
  private calibratedIds = new Set<string>();
  private static readonly MIN_TRIALS = 25;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'database', 'swarm_learning.json');
    this.ensureDatabaseFile();
    this.loadState();
  }

  private ensureDatabaseFile(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.dbPath)) {
      atomicWriteJsonSync(this.dbPath, { outcomes: [], weights: this.weights });
    }
  }

  private loadState(): void {
    try {
      const raw = fs.readFileSync(this.dbPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.outcomes = parsed.outcomes || [];
      if (parsed.weights) {
        this.weights = parsed.weights;
      }
      console.log(`[SWARM LEARNING] Loaded ${this.outcomes.length} signal outcome records.`);
    } catch (err: any) {
      console.warn(`[SWARM LEARNING WARNING] Failed loading learning state: ${err.message}`);
    }
  }

  private saveState(): void {
    try {
      atomicWriteJsonSync(this.dbPath, { outcomes: this.outcomes, weights: this.weights });
    } catch (err: any) {
      console.error(`[SWARM LEARNING ERROR] Failed saving learning state: ${err.message}`);
    }
  }

  public recordSignalCall(agentId: string, symbol: string, contractAddress: string, initialPriceUsd: number, confidenceScore: number): SignalOutcome {
    const outcome: SignalOutcome = {
      id: `CALL_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      agentId,
      symbol,
      contractAddress,
      initialPriceUsd,
      maxPriceReachedUsd: initialPriceUsd,
      lowestPriceReachedUsd: initialPriceUsd,
      result: 'OPEN',
      confidenceScore,
      timestampIso: new Date().toISOString(),
    };

    this.outcomes.unshift(outcome);
    this.saveState();
    return outcome;
  }

  public updateSignalPrice(id: string, currentPriceUsd: number): void {
    const item = this.outcomes.find(o => o.id === id);
    if (!item) return;

    if (currentPriceUsd > item.maxPriceReachedUsd) {
      item.maxPriceReachedUsd = currentPriceUsd;
    }
    if (currentPriceUsd < item.lowestPriceReachedUsd) {
      item.lowestPriceReachedUsd = currentPriceUsd;
    }

    const gainRatio = item.maxPriceReachedUsd / item.initialPriceUsd;
    const lossRatio = item.lowestPriceReachedUsd / item.initialPriceUsd;

    if (gainRatio >= 2.0) {
      item.result = 'TAKE_PROFIT_2X';
      this.recalibrateWeights(true);
    } else if (gainRatio >= 1.5) {
      item.result = 'TAKE_PROFIT_1_5X';
      this.recalibrateWeights(true);
    } else if (lossRatio <= 0.8) {
      item.result = 'STOP_LOSS';
      this.recalibrateWeights(false);
    }

    this.saveState();
  }

  /**
   * Feed a terminal outcome directly from the OpportunityLedger post-mortem
   * (not tied to a specific tracked signal price). Rewards/penalizes the same
   * weight set that price-driven TP/SL outcomes do. Fail-soft: no-op on a
   * non-boolean input. When the verbal reflector is ON this observes the
   * outcome WITHOUT touching the live weights (no-update mode).
   */
  public recordAttributedOutcome(success: boolean): void {
    if (this.verbalReflector) {
      this.reflectOnOutcome(Boolean(success));
      return;
    }
    this.recalibrateWeights(Boolean(success));
    this.saveState();
  }

  /**
   * Toggle the no-update "verbal reflector" mode (arXiv 2510.08068). When ON,
   * every outcome observation is folded into the win-rate trail and a narrative
   * reflection is emitted, but the swarm weights are never mutated. This lets a
   * dry-run/paper phase learn descriptively without corrupting production
   * consensus.
   */
  public setVerbalReflector(on: boolean, persist = false): void {
    this.verbalReflector = Boolean(on);
    console.log(`[SWARM LEARNING] Verbal reflector ${this.verbalReflector ? 'ON' : 'OFF'} (weights ${this.verbalReflector ? 'frozen' : 'live'}).`);
    if (persist) this.saveState();
  }

  public isVerbalReflector(): boolean {
    return this.verbalReflector;
  }

  /**
   * Emit a no-update narrative reflection on an outcome. Never mutates weights;
   * stateless aside from a log line. Used directly in verbal-reflector mode and
   * available for external callers that want commentary without recalibration.
   */
  public reflectOnOutcome(success: boolean, context?: string): string {
    const winRate = this.getWinRatePercentage();
    const w = this.weights;
    const narrative = success
      ? `TRAIN: win → smartMoney ${w.smartMoneyWeight.toFixed(2)} / liquidity ${w.liquidityWeight.toFixed(2)} (frozen; reflector only)`
      : `TRAIN: loss → devHolding strictness ${w.devHoldingWeight.toFixed(2)} (frozen; reflector only)`;
    const line = `[SWARM REFLECTOR] ${context ? context + ': ' : ''}${narrative} — live win-rate ${winRate}%, ${this.outcomes.length} outcomes.`;
    console.log(line);
    return line;
  }

  private recalibrateWeights(isSuccess: boolean): void {
    if (isSuccess) {
      // Reward smart money and liquidity weights
      this.weights.smartMoneyWeight = Math.min(0.50, this.weights.smartMoneyWeight + 0.01);
      this.weights.liquidityWeight = Math.min(0.35, this.weights.liquidityWeight + 0.01);
    } else {
      // Penalize and increase dev holding strictness
      this.weights.devHoldingWeight = Math.min(0.40, this.weights.devHoldingWeight + 0.01);
    }
  }

  public getWeights(): SwarmWeights {
    return { ...this.weights };
  }

  /**
   * Bridge recalibrated learning weights into the 5-slot aggregation. Maps the
   * learning emphasis back onto its corresponding slot (smartMoney→flow,
   * liquidity→momentum, devHolding→security, twitter→sentiment), bounded to a
   * ±30% swing around baseline and renormalized to sum ~1.0 so it can never
   * destabilize the >=80 gate.
   */
  public getVoterWeights(): Record<VoterId, number> {
    const w = this.weights;
    const swing = (val: number, base: number): number =>
      Math.max(0.7, Math.min(1.3, base > 0 ? val / base : 1));
    const adj: Partial<Record<VoterId, number>> = {
      momentum: BASE_VOTER_WEIGHTS.momentum * swing(w.liquidityWeight, LEARNING_DEFAULTS.liquidity),
      flow: BASE_VOTER_WEIGHTS.flow * swing(w.smartMoneyWeight, LEARNING_DEFAULTS.smartMoney),
      security: BASE_VOTER_WEIGHTS.security * swing(w.devHoldingWeight, LEARNING_DEFAULTS.devHolding),
      sentiment: BASE_VOTER_WEIGHTS.sentiment * swing(w.twitterWeight, LEARNING_DEFAULTS.twitter),
      critic: BASE_VOTER_WEIGHTS.critic,
    };
    const out = {} as Record<VoterId, number>;
    let sum = 0;
    for (const id of Object.keys(BASE_VOTER_WEIGHTS) as VoterId[]) {
      out[id] = adj[id] ?? BASE_VOTER_WEIGHTS[id];
      sum += out[id];
    }
    for (const id of Object.keys(out) as VoterId[]) out[id] = out[id] / sum;
    return out;
  }

  /**
   * Anti-overfit honesty-gated scoring calibration. Runs the terminal outcome
   * stream through the Q01 harness (deflationFactor/deflatedSharpe) and the
   * Q10 scoring-calibration module (icWeightDeltas/applyDeltas). A high trial
   * count PLUS a positive deflated signal applies IC-weighted deltas to the
   * learning weights; a low trial count or a suspicious (non-positive) stream
   * applies NOTHING and records a reason. Idempotent: already-calibrated
   * outcomes are never re-applied, so re-calling on the same stream is a no-op.
   *
   * @param freshOutcomes optional terminal-outcome stream; defaults to the
   *   in-memory outcome history.
   */
  public calibrate(freshOutcomes?: SignalOutcome[]): void {
    const src = freshOutcomes ?? this.outcomes;
    const closed = src.filter(
      (o) => o.result !== 'OPEN' && !this.calibratedIds.has(o.id)
    );

    if (closed.length === 0) {
      this.lastCalibrationReason = 'calibration skipped: no new terminal outcomes to calibrate';
      return;
    }

    // Idempotency: any outcome we evaluate is consumed exactly once, whether or
    // not the honesty gate passes, so a re-run of the same stream never double-applies.
    for (const o of closed) this.calibratedIds.add(o.id);

    const wins = closed.filter((o) => o.result.startsWith('TAKE_PROFIT')).length;
    const numTrials = closed.length;
    const winRate = wins / numTrials;
    // Positive raw stream signal iff the win rate beats break-even.
    const rawSignal = (winRate - 0.5) * 2;
    const deflated = deflatedSharpe(rawSignal, numTrials, 1);
    const factor = deflationFactor(numTrials, 1);

    if (numTrials < SwarmLearningEngine.MIN_TRIALS) {
      this.lastCalibrationReason =
        `calibration skipped: low trial count (${numTrials} < ${SwarmLearningEngine.MIN_TRIALS}) — overfit risk`;
      return;
    }
    if (deflated <= 0) {
      this.lastCalibrationReason =
        `calibration skipped: suspicious stream — deflated signature ${deflated.toFixed(3)} <= 0 ` +
        `(win-rate ${Math.round(winRate * 100)}%, deflation factor ${factor.toFixed(3)})`;
      return;
    }

    // Honest positive stream → apply IC-weighted calibration deltas.
    const rows = closed.map((o) => ({
      voterScores: {
        smartMoneyWeight: o.confidenceScore,
        liquidityWeight: o.confidenceScore,
        devHoldingWeight: o.confidenceScore,
        twitterWeight: o.confidenceScore,
      },
      realized: o.result.startsWith('TAKE_PROFIT') ? 1 : 0,
    }));
    const base = this.weights as unknown as Record<string, number>;
    const { deltas } = icWeightDeltas(rows, [...VOTER_KEYS], base);
    const calibrated = applyDeltas(base, deltas);
    this.weights = {
      smartMoneyWeight: calibrated['smartMoneyWeight'],
      liquidityWeight: calibrated['liquidityWeight'],
      devHoldingWeight: calibrated['devHoldingWeight'],
      twitterWeight: calibrated['twitterWeight'],
    };
    this.saveState();
    this.lastCalibrationReason =
      `calibration applied: ${numTrials} trials, deflated signature ${deflated.toFixed(3)}, ` +
      `deltas ${JSON.stringify(deltas)}`;
  }

  /** Most recent calibrate() outcome reason, or null if none recorded yet. */
  public getLastCalibrationReason(): string | null {
    return this.lastCalibrationReason;
  }

  public getWinRatePercentage(): number {
    const closed = this.outcomes.filter(o => o.result !== 'OPEN');
    if (closed.length === 0) return 100;

    const wins = closed.filter(o => o.result.startsWith('TAKE_PROFIT')).length;
    return Math.round((wins / closed.length) * 100);
  }
}

/**
 * Process-wide singleton — wired into index.ts (recordSignalCall per posted call)
 * and consumed by position tracking for outcome-driven weight recalibration.
 */
export const globalSwarmLearning = new SwarmLearningEngine();
export const AgentLearningEngine = SwarmLearningEngine;
