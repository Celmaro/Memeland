import {
  OpportunityLedger,
  type OpportunityIdentity,
  type OpportunityOutcomeReason,
} from './opportunity-ledger.js';

/**
 * OpportunityPostMortem — reads terminal (closed) opportunities that were never
 * attributed a finalOutcome, decides a win/loss/neutral classification from the
 * observed price trajectory, writes finalOutcome, and feeds the swarm-learning
 * weights for the terminal wins/losses.
 *
 * Only terminal wins (price ran >= 1.5x) and losses (price fell <= 0.8x to
 * entry) drive learning weights (doc §7). Neutral closes (no clear price
 * trajectory) are still attributed but do not pollute recalibration.
 */

export interface PostMortemResult {
  attributedCount: number;
  fedSuccessCount: number;
  fedLossCount: number;
  skippedNeutralCount: number;
}

interface AttributeResult {
  outcome: OpportunityOutcomeReason;
  success?: boolean;
}

/** 1.5x gain threshold for a profitable miss; 0.8x for a stop-loss-like loss. */
const WIN_GAIN_RATIO = 1.5;
const LOSS_LOSS_RATIO = 0.8;

export class OpportunityPostMortem {
  private ledger: OpportunityLedger;
  private feedLearning: (success: boolean) => void;

  constructor(
    ledger: OpportunityLedger,
    feedLearning: (success: boolean) => void = (success: boolean) => {
      // no-op — the live loop injects the real SwarmLearningEngine feed.
    }
  ) {
    this.ledger = ledger;
    this.feedLearning = feedLearning;
  }

  /** Attribute every closed-unattributed opportunity and feed learning. */
  public run(): PostMortemResult {
    const queue = this.ledger.closedUnattributed();
    let fedSuccessCount = 0;
    let fedLossCount = 0;
    let skippedNeutralCount = 0;

    for (const identity of queue) {
      const result = this.attribute(identity);
      this.ledger.setFinalOutcome(identity.opportunityId, result.outcome);
      if (result.success === true) {
        fedSuccessCount += 1;
        this.feedLearning(true);
      } else if (result.success === false) {
        fedLossCount += 1;
        this.feedLearning(false);
      } else {
        skippedNeutralCount += 1;
      }
    }

    return {
      attributedCount: queue.length,
      fedSuccessCount,
      fedLossCount,
      skippedNeutralCount,
    };
  }

  // ==========================================
  // CLASSIFIER
  // ==========================================

  private attribute(identity: OpportunityIdentity): AttributeResult {
    const observations = this.ledger.getObservations(identity.opportunityId);
    const entry = identity.firstSeenPriceUsd ?? observations[0]?.priceUsd;
    if (entry === undefined || entry <= 0) {
      return { outcome: 'CORRECT_REJECTION' }; // no trajectory to judge
    }

    const prices = observations
      .map((o) => o.priceUsd)
      .filter((p): p is number => typeof p === 'number' && p > 0);
    if (prices.length === 0) {
      return { outcome: 'CORRECT_REJECTION' };
    }

    const maxPrice = Math.max(entry, ...prices);
    const minPrice = Math.min(entry, ...prices);
    if (maxPrice / entry >= WIN_GAIN_RATIO) {
      return { outcome: 'PROFITABLE_MISS', success: true };
    }
    if (minPrice / entry <= LOSS_LOSS_RATIO) {
      return { outcome: 'CORRECT_REJECTION', success: false };
    }
    return { outcome: 'CORRECT_REJECTION' };
  }
}
