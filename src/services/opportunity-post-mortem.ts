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

  /** Regression guard (Q16): an identity that already fed learning is never fed again, so the
   *  swarm learns from a realized outcome exactly once in total even if run() is called repeatedly. */
  private fed = new Set<string>();

  constructor(
    ledger: OpportunityLedger,
    feedLearning: (success: boolean) => void = (success: boolean) => {
      // no-op — the live loop injects the real SwarmLearningEngine feed.
    }
  ) {
    this.ledger = ledger;
    this.feedLearning = feedLearning;
  }

  /** Attribute every closed-unattributed opportunity and feed learning (exactly once each). */
  public run(): PostMortemResult {
    const queue = this.ledger.closedUnattributed();
    let fedSuccessCount = 0;
    let fedLossCount = 0;
    let skippedNeutralCount = 0;

    for (const identity of queue) {
      const idKey = identity.opportunityId;
      const result = this.attribute(identity);
      this.ledger.setFinalOutcome(identity.opportunityId, result.outcome);
      if (this.fed.has(idKey)) {
        // already honored once — never feed the swarm twice for the same outcome
        continue;
      }
      if (result.success === true) {
        fedSuccessCount += 1;
        this.fed.add(idKey);
        this.feedLearning(true);
      } else if (result.success === false) {
        fedLossCount += 1;
        this.fed.add(idKey);
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

    // Q16 soundness: an entry-anchored trajectory (from the evaluation's entry, not the
    // token's first-ever tick). PROFITABLE_MISS = the bot NEVER held a live trade, so it is
    // NEUTRAL — it must NOT feed a success weight (that would reward signals the bot
    // didn't act on and corrupt the learning feed).
    const maxPrice = Math.max(entry, ...prices);
    const minPrice = Math.min(entry, ...prices);
    if (maxPrice / entry >= WIN_GAIN_RATIO) {
      return { outcome: 'PROFITABLE_MISS' }; // neutral — no positive feed
    }
    if (minPrice / entry <= LOSS_LOSS_RATIO) {
      return { outcome: 'CORRECT_REJECTION', success: false };
    }
    return { outcome: 'CORRECT_REJECTION' };
  }
}
