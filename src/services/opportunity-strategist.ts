import {
  OpportunityLedger,
  TERMINAL_STATES,
  type OpportunityIdentity,
  type OpportunityObservation,
  type OpportunitySighting,
  type OpportunityState,
} from './opportunity-ledger.js';

/**
 * OpportunityStrategist — deterministic (no LLM) per-cycle escalation layer.
 *
 * It answers "which opportunities get scored by the 7-voter swarm and why now",
 * leaving the scoring/thesis to the RobinhoodScreeningAgent and the ≥80 gate to
 * swarm-consensus.ts. All state changes flow through the ledger's fail-closed
 * `transition()`, so invalid edges are rejected by construction.
 *
 * Escalation rules (doc §6), evaluated on change-driven observations:
 *   FIRST_SEEN      -- prefilter pass                  --> WATCHING   (admit to nursery)
 *   WATCHING        -- liquidity>20k OR smartWalletsBuying doubled OR vol24h>100k --> ACCELERATING
 *   ACCELERATING    -- trigger: isGraduated OR >1 smart full-close OR price ATH --> WATCH_TRIGGER
 *   WATCH_TRIGGER   -- run swarm once (recordSwarmResult)
 *                      --> confidence>=80 ? READY_SMALL_BET : stay WATCHING
 *   READY_SMALL_BET -- enqueue (existing approval ladder) --> APPROVAL_PENDING
 *
 * Re-admits parked RISK_REJECTED opportunities to WATCHING when metrics recover.
 */

export interface OpportunityStrategistConfig {
  /** Lucidity floor to admit a FIRST_SEEN token into the nursery. */
  minLiquidityUsdAdmit: number;
  /** Minimum 24h volume to admit a FIRST_SEEN token into the nursery. */
  minVolume24hUsdAdmit: number;
  /** WATCHING -> ACCELERATING liquidity trigger. */
  minLiquidityUsdAccelerate: number;
  /** WATCHING -> ACCELERATING 24h-volume trigger. */
  minVolume24hUsdAccelerate: number;
  /** WATCHING -> ACCELERATING: current smart-wallet buying >= prior * this factor. */
  smartWalletsDoubleFactor: number;
  /** ACCELERATING -> WATCH_TRIGGER when > this many unique smart full-closes. */
  smartFullCloseThreshold: number;
  /** WATCH_TRIGGER swarm consensus floor to move to READY_SMALL_BET. */
  consensusThreshold: number;
  /** Review throttle cadence applied when parking/re-checking an opportunity. */
  reviewCadenceMs: number;
  /** Parked RISK_REJECTED beyond this age is expired (deterministic cleanup). */
  expireAfterMs: number;
  /** Max candidates surfaced to the swarm per cycle (research budget guard). */
  maxScorePerCycle: number;
}

const DEFAULT_CONFIG: OpportunityStrategistConfig = {
  minLiquidityUsdAdmit: 1000,
  minVolume24hUsdAdmit: 10_000,
  minLiquidityUsdAccelerate: 20_000,
  minVolume24hUsdAccelerate: 100_000,
  smartWalletsDoubleFactor: 2,
  smartFullCloseThreshold: 1,
  consensusThreshold: 80,
  reviewCadenceMs: 60 * 60 * 1000,
  expireAfterMs: 72 * 60 * 60 * 1000,
  maxScorePerCycle: 5,
};

/** Raw sighting enriched with the change-driven metrics the escalator reads. */
export interface StrategistSighting extends OpportunitySighting {
  volume1hUsd?: number;
  volume24hUsd?: number;
  smartWalletsBuying?: number;
  totalBuyUsd?: number;
  totalSellUsd?: number;
  fullCloseCount?: number;
  /** True if the token left the bonding curve to the open DEX market. */
  graduated?: boolean;
  /** True if price is at/near its all-time high. */
  priceAth?: boolean;
  /** False when the token is off the feed / metrics unrecoverable. */
  available?: boolean;
}

export type StrategistAction =
  | 'ADMIT_NURSERY'
  | 'PARK'
  | 'RE_ADMIT'
  | 'ESCALATE'
  | 'TRIGGER'
  | 'SCORE'
  | 'ENQUEUE'
  | 'EXPIRE'
  | 'NONE';

export interface StrategistDecision {
  opportunityId: string;
  chain: string;
  contractAddress: string;
  symbol?: string;
  action: StrategistAction;
  fromState: OpportunityState;
  toState?: OpportunityState;
  reason: string;
  nextReviewAt?: string;
}

export interface StrategistCycle {
  /** Full audit trail of every decision made this cycle (ordered by firstSeenAt). */
  decisions: StrategistDecision[];
  /** Opportunity ids to run the 7-voter swarm on now (WATCH_TRIGGER), budget-capped. */
  nextCandidates: string[];
  /** Opportunity ids ready for the existing approval ladder (READY_SMALL_BET). */
  enqueueCandidates: string[];
  observedAt: string;
}

export class OpportunityStrategist {
  private ledger: OpportunityLedger;
  private config: OpportunityStrategistConfig;

  constructor(ledger: OpportunityLedger, config: Partial<OpportunityStrategistConfig> = {}) {
    this.ledger = ledger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Ingest a raw sighting: ensure identity + append the change observation. */
  public ingest(sighting: StrategistSighting): OpportunityIdentity {
    const identity = this.ledger.ensureOpportunity(sighting);
    const hasMetrics =
      sighting.volume1hUsd !== undefined ||
      sighting.volume24hUsd !== undefined ||
      sighting.liquidityUsd !== undefined ||
      sighting.marketCapUsd !== undefined ||
      sighting.smartWalletsBuying !== undefined ||
      sighting.totalBuyUsd !== undefined ||
      sighting.totalSellUsd !== undefined;
    if (hasMetrics) {
      this.ledger.appendObservation({
        opportunityId: identity.opportunityId,
        source: String(sighting.source || 'unknown'),
        priceUsd: sighting.priceUsd,
        marketCapUsd: sighting.marketCapUsd,
        liquidityUsd: sighting.liquidityUsd,
        volume1hUsd: sighting.volume1hUsd,
        volume24hUsd: sighting.volume24hUsd,
        smartWalletsBuying: sighting.smartWalletsBuying,
        totalBuyUsd: sighting.totalBuyUsd,
        totalSellUsd: sighting.totalSellUsd,
        extra: {
          fullCloseCount: sighting.fullCloseCount,
          graduated: sighting.graduated,
          priceAth: sighting.priceAth,
          available: sighting.available === undefined ? true : sighting.available,
        },
      });
    }
    return identity;
  }

  /** Run the per-cycle escalation pass over all live opportunities. */
  public decide(now: Date = new Date()): StrategistCycle {
    const decisions: StrategistDecision[] = [];
    const nextCandidates: string[] = [];
    const enqueueCandidates: string[] = [];

    const identities = this.ledger
      .getAll()
      .filter((i) => !TERMINAL_STATES.has(i.currentState))
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));

    for (const identity of identities) {
      const latest = this.latestObservation(identity.opportunityId);
      const decision = this.reviewOne(identity, latest, now);
      if (!decision) continue;
      decisions.push(decision);
      if (decision.action === 'SCORE' && decision.opportunityId) {
        if (nextCandidates.length < this.config.maxScorePerCycle) nextCandidates.push(decision.opportunityId);
      } else if (decision.action === 'ENQUEUE') {
        enqueueCandidates.push(decision.opportunityId);
      }
    }

    return { decisions, nextCandidates, enqueueCandidates, observedAt: now.toISOString() };
  }

  /** Feed back the swarm consensus result for a WATCH_TRIGGER opportunity. */
  public recordSwarmResult(opportunityId: string, consensus: number): boolean {
    const identity = this.ledger.get(opportunityId);
    if (!identity || identity.currentState !== 'WATCH_TRIGGER') return false;
    if (consensus >= this.config.consensusThreshold) {
      this.ledger.transition(opportunityId, 'READY_SMALL_BET', `consensus ${consensus} >= ${this.config.consensusThreshold}`, 'TRIGGER_FIRED');
    } else {
      this.ledger.transition(opportunityId, 'WATCHING', `consensus ${consensus} < ${this.config.consensusThreshold}`, 'TRIGGER_FIRED');
      this.park(opportunityId, nowIso());
    }
    return true;
  }

  /** Mark a READY_SMALL_BET opportunity as enqueued on the approval ladder. */
  public enqueue(opportunityId: string): boolean {
    const identity = this.ledger.get(opportunityId);
    if (!identity || identity.currentState !== 'READY_SMALL_BET') return false;
    return this.ledger.transition(opportunityId, 'APPROVAL_PENDING', 'enqueued on approval ladder', 'APPROVAL_PENDING').ok;
  }

  /**
   * Record a gate-passed (+ enqueued) signal that actually fired this cycle.
   * Walks the opportunity to APPROVAL_PENDING along valid edges when the swarm
   * consensus passed (>= threshold), mirroring the real approval ladder so the
   * audit trail reflects what was dispatched. Fail-closed: no-ops on unknown,
   * terminal, consensus-failed, or already-advanced opportunities.
   */
  public recordDispatch(opportunityId: string, consensus: number): OpportunityState | null {
    const identity = this.ledger.get(opportunityId);
    if (!identity || TERMINAL_STATES.has(identity.currentState)) return null;
    if (consensus < this.config.consensusThreshold) return null;
    const stepsToReady = this.DISPATCH_PATHS[identity.currentState];
    if (stepsToReady === undefined) return identity.currentState; // already APPROVED/OPEN/...
    const path = [...stepsToReady, 'APPROVAL_PENDING'] as OpportunityState[];
    for (const to of path) {
      const res = this.ledger.transition(opportunityId, to, `gate-passed dispatch (consensus ${consensus})`, 'DISPATCHED');
      if (!res.ok) return identity.currentState;
    }
    return identity.currentState;
  }

  // ==========================================
  // ESCALATION
  // ==========================================

  private reviewOne(
    identity: OpportunityIdentity,
    latest: OpportunityObservation | null,
    now: Date
  ): StrategistDecision | null {
    const state = identity.currentState;
    const base = {
      opportunityId: identity.opportunityId,
      chain: identity.chain,
      contractAddress: identity.contractAddress,
      symbol: identity.symbol,
    };

    switch (state) {
      case 'FIRST_SEEN':
        return this.reviewFirstSeen(identity, latest, now, base);
      case 'WATCHING':
        return this.reviewWatching(identity, latest, now, base);
      case 'ACCELERATING':
        return this.reviewAccelerating(identity, latest, now, base);
      case 'WATCH_TRIGGER':
        return { ...base, action: 'SCORE', fromState: state, reason: 'accelerating triggers fired — run swarm once' };
      case 'READY_SMALL_BET':
        return { ...base, action: 'ENQUEUE', fromState: state, reason: 'consensus passed — ready for the approval ladder' };
      case 'RISK_REJECTED':
        return this.reviewRiskRejected(identity, latest, now, base);
      default:
        // APPROVAL_PENDING / APPROVED / OPEN / REDUCE / EXIT_TRIGGERED belong to the
        // approval ladder and position manager, not the Strategist.
        return null;
    }
  }

  private reviewFirstSeen(
    identity: OpportunityIdentity,
    latest: OpportunityObservation | null,
    now: Date,
    base: DecideBase
  ): StrategistDecision {
    if (!latest) {
      return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'no metrics yet — awaiting a sighting' };
    }
    if (this.prefilterPasses(latest)) {
      this.ledger.transition(identity.opportunityId, 'RISK_PENDING', 'prefilter pass', 'RISK_PASSED');
      this.ledger.transition(identity.opportunityId, 'WATCHING', 'prefilter pass — admit to nursery', 'NURSERY_ADMITTED');
      return { ...base, action: 'ADMIT_NURSERY', fromState: identity.currentState, toState: 'WATCHING', reason: 'prefilter pass — admitted to nursery' };
    }
    const reason = this.prefilterReason(latest);
    this.ledger.transition(identity.opportunityId, 'RISK_REJECTED', reason, 'RISK_REJECTED');
    this.park(identity.opportunityId, nowIso(now.getTime() + this.config.reviewCadenceMs));
    return { ...base, action: 'PARK', fromState: identity.currentState, toState: 'RISK_REJECTED', reason, nextReviewAt: identity.nextReviewAt };
  }

  private reviewWatching(
    identity: OpportunityIdentity,
    latest: OpportunityObservation | null,
    now: Date,
    base: DecideBase
  ): StrategistDecision {
    if (!latest || latest.extra?.available === false) {
      this.park(identity.opportunityId, nowIso(now.getTime() + this.config.reviewCadenceMs));
      return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'no live metrics — re-check later', nextReviewAt: identity.nextReviewAt };
    }
    if (!this.isReviewDue(identity, now)) {
      return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'throttled until nextReviewAt', nextReviewAt: identity.nextReviewAt };
    }
    const reason = this.accelerateReason(identity, latest, now);
    if (reason) {
      this.ledger.transition(identity.opportunityId, 'ACCELERATING', reason, 'ESCALATED');
      return { ...base, action: 'ESCALATE', fromState: identity.currentState, toState: 'ACCELERATING', reason };
    }
    this.park(identity.opportunityId, nowIso(now.getTime() + this.config.reviewCadenceMs));
    return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'no escalation event — stay in nursery', nextReviewAt: identity.nextReviewAt };
  }

  private reviewAccelerating(
    identity: OpportunityIdentity,
    latest: OpportunityObservation | null,
    now: Date,
    base: DecideBase
  ): StrategistDecision {
    if (!latest) {
      this.park(identity.opportunityId, nowIso(now.getTime() + this.config.reviewCadenceMs));
      return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'no metrics — re-check later', nextReviewAt: identity.nextReviewAt };
    }
    if (!this.isReviewDue(identity, now)) {
      return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'throttled until nextReviewAt', nextReviewAt: identity.nextReviewAt };
    }
    const reason = this.triggerReason(latest);
    if (reason) {
      this.ledger.transition(identity.opportunityId, 'WATCH_TRIGGER', reason, 'TRIGGER_FIRED');
      return { ...base, action: 'TRIGGER', fromState: identity.currentState, toState: 'WATCH_TRIGGER', reason };
    }
    this.park(identity.opportunityId, nowIso(now.getTime() + this.config.reviewCadenceMs));
    return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'no trigger fired — keep accelerating', nextReviewAt: identity.nextReviewAt };
  }

  private reviewRiskRejected(
    identity: OpportunityIdentity,
    latest: OpportunityObservation | null,
    now: Date,
    base: DecideBase
  ): StrategistDecision {
    if (!this.isReviewDue(identity, now)) {
      return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'still parked — throttled', nextReviewAt: identity.nextReviewAt };
    }
    if (latest && latest.extra?.available !== false && this.prefilterPasses(latest)) {
      this.ledger.transition(identity.opportunityId, 'WATCHING', 'metrics recovered — re-admitted to nursery', 'NURSERY_ADMITTED');
      delete identity.nextReviewAt;
      return { ...base, action: 'RE_ADMIT', fromState: identity.currentState, toState: 'WATCHING', reason: 'metrics recovered — re-admitted to nursery' };
    }
    if (now.getTime() - Date.parse(identity.firstSeenAt) > this.config.expireAfterMs) {
      this.ledger.transition(identity.opportunityId, 'EXPIRED', 'parked too long without recovery', 'MISSED');
      return { ...base, action: 'EXPIRE', fromState: identity.currentState, toState: 'EXPIRED', reason: 'parked too long without recovery' };
    }
    this.park(identity.opportunityId, nowIso(now.getTime() + this.config.reviewCadenceMs));
    return { ...base, action: 'NONE', fromState: identity.currentState, reason: 'metrics have not recovered — keep parked', nextReviewAt: identity.nextReviewAt };
  }

  // ==========================================
  // RULE PREDICATES
  // ==========================================

  private prefilterPasses(o: OpportunityObservation): boolean {
    if (o.liquidityUsd === undefined || o.liquidityUsd < this.config.minLiquidityUsdAdmit) return false;
    const vol24 = o.volume24hUsd ?? (o.volume1hUsd !== undefined ? o.volume1hUsd * 24 : undefined);
    if (vol24 === undefined || vol24 < this.config.minVolume24hUsdAdmit) return false;
    return true;
  }

  private prefilterReason(o: OpportunityObservation): string {
    const parts: string[] = [];
    if (o.liquidityUsd === undefined || o.liquidityUsd < this.config.minLiquidityUsdAdmit) {
      parts.push(`liquidity ${o.liquidityUsd !== undefined ? `$${o.liquidityUsd.toFixed(0)}` : 'unknown'} < $${this.config.minLiquidityUsdAdmit} (LIQUIDITY_REJECTED)`);
    }
    const vol24 = o.volume24hUsd ?? (o.volume1hUsd !== undefined ? o.volume1hUsd * 24 : undefined);
    if (vol24 === undefined || vol24 < this.config.minVolume24hUsdAdmit) {
      parts.push(`volume24h ${vol24 !== undefined ? `$${vol24.toFixed(0)}` : 'unknown'} < $${this.config.minVolume24hUsdAdmit} (VOLUME_REJECTED)`);
    }
    return parts.join('; ');
  }

  private accelerateReason(
    identity: OpportunityIdentity,
    o: OpportunityObservation,
    _now: Date
  ): string | null {
    const priors = this.ledger
      .getObservations(identity.opportunityId)
      .filter((x) => x.id !== o.id && typeof x.smartWalletsBuying === 'number');
    const maxPrev = priors.length > 0 ? Math.max(...priors.map((x) => x.smartWalletsBuying as number)) : 0;
    const reasons: string[] = [];
    if (typeof o.liquidityUsd === 'number' && o.liquidityUsd > this.config.minLiquidityUsdAccelerate) {
      reasons.push(`liquidity $${o.liquidityUsd.toFixed(0)} > $${this.config.minLiquidityUsdAccelerate}`);
    }
    const vol24 = o.volume24hUsd ?? (o.volume1hUsd !== undefined ? o.volume1hUsd * 24 : undefined);
    if (vol24 !== undefined && vol24 > this.config.minVolume24hUsdAccelerate) {
      reasons.push(`vol24h $${vol24.toFixed(0)} > $${this.config.minVolume24hUsdAccelerate}`);
    }
    if (
      typeof o.smartWalletsBuying === 'number' &&
      maxPrev > 0 &&
      o.smartWalletsBuying >= maxPrev * this.config.smartWalletsDoubleFactor
    ) {
      reasons.push(`smart-wallet buying ${o.smartWalletsBuying} >= ${maxPrev} * ${this.config.smartWalletsDoubleFactor}`);
    }
    return reasons.length > 0 ? reasons.join(' OR ') : null;
  }

  private triggerReason(o: OpportunityObservation): string | null {
    if (o.extra?.graduated === true) return 'graduated off the bonding curve';
    const fullCloses = o.extra?.fullCloseCount;
    if (typeof fullCloses === 'number' && fullCloses > this.config.smartFullCloseThreshold) {
      return `${fullCloses} smart-full-closes (> ${this.config.smartFullCloseThreshold})`;
    }
    if (o.extra?.priceAth === true) return 'price at all-time high';
    return null;
  }

  private isReviewDue(identity: OpportunityIdentity, now: Date): boolean {
    if (!identity.nextReviewAt) return true;
    return now.getTime() >= Date.parse(identity.nextReviewAt);
  }

  private park(opportunityId: string, isoAt: string): void {
    this.ledger.setNextReviewAt(opportunityId, isoAt);
  }

  private latestObservation(opportunityId: string): OpportunityObservation | null {
    const list = this.ledger.getObservations(opportunityId, 1);
    return list.length > 0 ? list[0] : null;
  }

  /** Pre-APPROVAL_PENDING walk that culminates in READY_SMALL_BET (inclusive). */
  private readonly DISPATCH_PATHS: Readonly<Record<string, OpportunityState[]>> = {
    FIRST_SEEN: ['RISK_PENDING', 'WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET'],
    IDENTITY_RESOLVED: ['RISK_PENDING', 'WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET'],
    RISK_PENDING: ['WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET'],
    WATCHING: ['ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET'],
    ACCELERATING: ['WATCH_TRIGGER', 'READY_SMALL_BET'],
    RESEARCH_READY: ['WATCH_TRIGGER', 'READY_SMALL_BET'],
    WATCH_TRIGGER: ['READY_SMALL_BET'],
    READY_SMALL_BET: [],
  };
}

interface DecideBase {
  opportunityId: string;
  chain: string;
  contractAddress: string;
  symbol?: string;
}

function nowIso(atMs: number = Date.now()): string {
  return new Date(atMs).toISOString();
}
