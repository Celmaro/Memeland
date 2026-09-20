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

  /** Attribute every closed-unattributed opportunity and feed learning (exactly once each). */
  public run(): PostMortemResult {
    const queue = this.ledger.closedUnattributed();
    let fedSuccessCount = 0;
    let fedLossCount = 0;
    let skippedNeutralCount = 0;

    for (const identity of queue) {
      if (identity.currentState === 'EXITED') {
        // A realized live trade — the swarm already recalibrated it exactly once through
        // the live TP/SL loop (wallet-tracker -> updateSignalPrice). The post-mortem must
        // NEVER re-feed it; it only drains the ledger with a truthful label so the queue
        // stays honest without double-counting the same realized PnL.
        this.ledger.setFinalOutcome(identity.opportunityId, 'REALIZED');
        skippedNeutralCount += 1;
        continue;
      }

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
    // Measure from the evaluation-window entry, not the token's first-ever tick.
    const entry =
      identity.admissionPriceUsd ??
      identity.firstSeenPriceUsd ??
      observations[0]?.priceUsd;
    if (entry === undefined || entry <= 0) {
      return { outcome: 'CORRECT_REJECTION' }; // no trajectory to judge
    }

    // Never admitted to the evaluation window — the bot was never evaluating it, so no
    // trajectory judgement (or learning feed) applies.
    if (!identity.admittedAt) {
      return { outcome: 'CORRECT_REJECTION' };
    }

    // Restrict the trajectory to observations at/after admission so a spike that happened
    // pre-prefilter (before the strategy ever had a live chance) cannot be read as a win.
    const prices = observations
      .filter((o) => o.observedAt && o.observedAt >= identity.admittedAt!)
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
