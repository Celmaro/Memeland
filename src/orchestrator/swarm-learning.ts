import fs from 'fs';
import path from 'path';
import type { VoterId } from './voters.js';

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

/** Baseline 7-voter weights — mirror of DEFAULT_VOTER_WEIGHTS in voters.ts. */
const BASE_VOTER_WEIGHTS: Record<VoterId, number> = {
  quant: 0.2,
  ml: 0.15,
  security: 0.25,
  sentiment: 0.15,
  whale: 0.1,
  regime: 0.05,
  critic: 0.1,
};

const LEARNING_DEFAULTS = {
  smartMoney: 0.35,
  liquidity: 0.25,
  devHolding: 0.20,
  twitter: 0.20,
};

export class SwarmLearningEngine {
  private dbPath: string;
  private outcomes: SignalOutcome[] = [];
  private weights: SwarmWeights = {
    smartMoneyWeight: 0.35,
    liquidityWeight: 0.25,
    devHoldingWeight: 0.20,
    twitterWeight: 0.20,
  };

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
      fs.writeFileSync(this.dbPath, JSON.stringify({ outcomes: [], weights: this.weights }, null, 2), 'utf-8');
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
      fs.writeFileSync(
        this.dbPath,
        JSON.stringify({ outcomes: this.outcomes, weights: this.weights }, null, 2),
        'utf-8'
      );
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
   * non-boolean input.
   */
  public recordAttributedOutcome(success: boolean): void {
    this.recalibrateWeights(Boolean(success));
    this.saveState();
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
   * Bridge recalibrated learning weights into the 7-voter aggregation. Maps the
   * learning emphasis back onto its corresponding voter (smartMoney→whale,
   * liquidity→quant, devHolding→security, twitter→sentiment), bounded to a
   * ±30% swing around baseline and renormalized to sum ~1.0 so it can never
   * destabilize the >=80 gate.
   */
  public getVoterWeights(): Record<VoterId, number> {
    const w = this.weights;
    const swing = (val: number, base: number): number =>
      Math.max(0.7, Math.min(1.3, base > 0 ? val / base : 1));
    const adj: Partial<Record<VoterId, number>> = {
      quant: BASE_VOTER_WEIGHTS.quant * swing(w.liquidityWeight, LEARNING_DEFAULTS.liquidity),
      ml: BASE_VOTER_WEIGHTS.ml,
      security: BASE_VOTER_WEIGHTS.security * swing(w.devHoldingWeight, LEARNING_DEFAULTS.devHolding),
      sentiment: BASE_VOTER_WEIGHTS.sentiment * swing(w.twitterWeight, LEARNING_DEFAULTS.twitter),
      whale: BASE_VOTER_WEIGHTS.whale * swing(w.smartMoneyWeight, LEARNING_DEFAULTS.smartMoney),
      regime: BASE_VOTER_WEIGHTS.regime,
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
export const globalAgentLearning = globalSwarmLearning;
export const AgentLearningEngine = SwarmLearningEngine;
