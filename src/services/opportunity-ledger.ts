import fs from 'fs';
import path from 'path';
import { atomicWriteJsonSync } from '../storage/atomic-file-store.js';
import { StateMachine, type StateTransitions } from '../lifecycle/state-machine.js';

export type OpportunityState =
  | 'FIRST_SEEN'
  | 'IDENTITY_RESOLVED'
  | 'RISK_PENDING'
  | 'RISK_REJECTED'
  | 'WATCHING'
  | 'ACCELERATING'
  | 'RESEARCH_READY'
  | 'WATCH_TRIGGER'
  | 'READY_SMALL_BET'
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'OPEN'
  | 'REDUCE'
  | 'EXIT_TRIGGERED'
  | 'EXITED'
  | 'MISSED'
  | 'CORRECT_REJECTION'
  | 'EXPIRED';

export const TERMINAL_STATES: ReadonlySet<OpportunityState> = new Set<OpportunityState>([
  'EXITED',
  'MISSED',
  'CORRECT_REJECTION',
  'EXPIRED',
]);

/** Allowed lifecycle edges, keyed by source state. Terminal states have no edges. */
export const STATE_TRANSITIONS: Readonly<Record<OpportunityState, ReadonlySet<OpportunityState>>> = {
  FIRST_SEEN: new Set(['IDENTITY_RESOLVED', 'RISK_PENDING', 'RISK_REJECTED']),
  IDENTITY_RESOLVED: new Set(['RISK_PENDING', 'RISK_REJECTED']),
  RISK_PENDING: new Set(['WATCHING', 'RISK_REJECTED']),
  RISK_REJECTED: new Set(['WATCHING', 'EXPIRED']),
  WATCHING: new Set(['ACCELERATING', 'RISK_REJECTED', 'EXPIRED']),
  ACCELERATING: new Set(['WATCH_TRIGGER', 'WATCHING']),
  RESEARCH_READY: new Set(['WATCH_TRIGGER', 'WATCHING']),
  WATCH_TRIGGER: new Set(['READY_SMALL_BET', 'WATCHING', 'RESEARCH_READY']),
  READY_SMALL_BET: new Set(['APPROVAL_PENDING', 'EXPIRED']),
  APPROVAL_PENDING: new Set(['APPROVED', 'EXITED', 'EXPIRED']),
  APPROVED: new Set(['OPEN', 'EXITED']),
  OPEN: new Set(['REDUCE', 'EXIT_TRIGGERED', 'EXITED']),
  REDUCE: new Set(['OPEN', 'EXIT_TRIGGERED', 'EXITED']),
  EXIT_TRIGGERED: new Set(['EXITED']),
  EXITED: new Set(),
  MISSED: new Set(),
  CORRECT_REJECTION: new Set(),
  EXPIRED: new Set(),
};

/** Array-backed view of {@link STATE_TRANSITIONS} for the shared {@link StateMachine} kernel. */
const OPPORTUNITY_TRANSITIONS: StateTransitions<OpportunityState> = Object.fromEntries(
  (Object.keys(STATE_TRANSITIONS) as OpportunityState[]).map((s) => [s, [...STATE_TRANSITIONS[s]]])
) as unknown as StateTransitions<OpportunityState>;

export type OpportunityEventType =
  | 'FIRST_SEEN'
  | 'OBSERVED'
  | 'IDENTITY_RESOLVED'
  | 'RISK_PASSED'
  | 'RISK_REJECTED'
  | 'NURSERY_ADMITTED'
  | 'ESCALATED'
  | 'RESEARCH_BUDGET_USED'
  | 'TRIGGER_FIRED'
  | 'APPROVAL_PENDING'
  | 'OPERATOR_REJECTED'
  | 'DISPATCHED'
  | 'MOVED_TO_OPEN'
  | 'POSITION_EXITED'
  | 'MISSED'
  | 'ATTRIBUTED';

export type OpportunityOutcomeReason =
  | 'NOT_DISCOVERED'
  | 'DISCOVERED_LATE'
  | 'IDENTITY_UNRESOLVED'
  | 'RISK_REJECTED'
  | 'LIQUIDITY_REJECTED'
  | 'VOLUME_REJECTED'
  | 'CONSENSUS_REJECTED'
  | 'RESEARCH_BUDGET_EXHAUSTED'
  | 'NOT_NOTIFIED'
  | 'NOT_APPROVED'
  | 'EXECUTION_FAILED'
  | 'POSITION_EXIT_FAILED'
  | 'PROFITABLE_MISS'
  | 'REALIZED'
  | 'CORRECT_REJECTION';

export interface OpportunityIdentity {
  opportunityId: string;
  chain: string;
  contractAddress: string;
  symbol?: string;
  firstSeenAt: string;
  firstSeenSource: string;
  firstSeenPriceUsd?: number;
  firstSeenMarketCapUsd?: number;
  firstSeenLiquidityUsd?: number;
  currentState: OpportunityState;
  stateUpdatedAt: string;
  /** ISO timestamp of first admission to the evaluation window (WATCHING). */
  admittedAt?: string;
  /** Price captured at evaluation-window admission — entry anchor for the post-mortem trajectory. */
  admissionPriceUsd?: number;
  finalOutcome?: OpportunityOutcomeReason;
  /** ISO timestamp for the next Strategist review (parking/throttle). Undefined = due now. */
  nextReviewAt?: string;
}

export interface OpportunityObservation {
  id: string;
  opportunityId: string;
  observedAt: string;
  source: string;
  priceUsd?: number;
  volume1hUsd?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  smartWalletsBuying?: number;
  totalBuyUsd?: number;
  totalSellUsd?: number;
  rugRatio?: number;
  top10HolderRate?: number;
  creatorClose?: boolean;
  extra?: Record<string, unknown>;
}

export interface OpportunityEvent {
  id: string;
  opportunityId: string;
  type: OpportunityEventType;
  from?: OpportunityState;
  to?: OpportunityState;
  reason: string;
  data?: Record<string, unknown>;
  at: string;
}

/** Raw sighting from a discovery adapter. Creates or refreshes an identity. */
export interface OpportunitySighting {
  chain: string;
  contractAddress: string;
  symbol?: string;
  source: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
}

/** Minimal call-card shape the gate-passed signal path produces (agent-contract CallCardPayload). */
export interface CallCardSightingSource {
  payload: {
    network?: string;
    contractAddress?: string;
    symbol?: string;
    priceUsd?: string | number;
    liquidityUsd?: number;
  };
  channelName: string;
}

/**
 * Build an opportunity sighting from a gate-passed call payload (ledger
 * identity). Returns null when there is no contract address to key on.
 * Moved here from index.ts so the domain mapping lives next to the ledger.
 */
export function sightingFromCallCard(item: CallCardSightingSource): OpportunitySighting | null {
  const payload = item.payload;
  if (!payload?.contractAddress) return null;
  const price = parseFloat(String(payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0;
  return {
    chain: String(payload.network || 'robinhood').toLowerCase(),
    contractAddress: payload.contractAddress,
    symbol: payload.symbol,
    source: item.channelName === 'call-meme-robinhood' ? 'swarm:gate' : 'whale:gate',
    priceUsd: price > 0 ? price : undefined,
    liquidityUsd: (payload.liquidityUsd ?? 0) > 0 ? payload.liquidityUsd : undefined,
  };
}

export interface OpportunityLedgerState {
  identities: Record<string, OpportunityIdentity>;
  observations: OpportunityObservation[];
  events: OpportunityEvent[];
  version: number;
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

const CURRENT_VERSION = 1;
const MAX_EVENTS = 10000;
const MAX_OBSERVATIONS = 10000;

/** Canonical identity key — chain + address lowercased, whitespace-trimmed. */
export function opportunityIdFor(chain: string, contractAddress: string): string {
  const c = String(chain || '').trim().toLowerCase();
  const a = String(contractAddress || '').trim().toLowerCase();
  return `${c}:${a}`;
}

export class OpportunityLedger {
  private dbFilePath: string;
  private identities: Record<string, OpportunityIdentity> = {};
  private observations: OpportunityObservation[] = [];
  private events: OpportunityEvent[] = [];
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 250;
  /** Injectable clock for deterministic tests; defaults to real time. */
  private readonly now: () => Date;

  constructor(filePath?: string, now?: () => Date) {
    this.now = now ?? (() => new Date());
    const dbDir = path.resolve(process.cwd(), 'database');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.dbFilePath = filePath || path.join(dbDir, 'opportunity_ledger.json');
    this.loadFromDisk();
  }

  /** Idempotent — returns the existing identity or creates a FIRST_SEEN one. */
  public ensureOpportunity(sighting: OpportunitySighting): OpportunityIdentity {
    if (!sighting || !sighting.contractAddress) {
      throw new Error('[OPPORTUNITY LEDGER] ensureOpportunity requires a contractAddress');
    }
    const id = opportunityIdFor(sighting.chain, sighting.contractAddress);
    const now = this.now().toISOString();
    const existing = this.identities[id];
    if (existing) return existing;

    const identity: OpportunityIdentity = {
      opportunityId: id,
      chain: String(sighting.chain || 'robinhood').trim().toLowerCase(),
      contractAddress: sighting.contractAddress.trim(),
      symbol: sighting.symbol,
      firstSeenAt: now,
      firstSeenSource: String(sighting.source || 'unknown'),
      firstSeenPriceUsd: sighting.priceUsd,
      firstSeenMarketCapUsd: sighting.marketCapUsd,
      firstSeenLiquidityUsd: sighting.liquidityUsd,
      currentState: 'FIRST_SEEN',
      stateUpdatedAt: now,
    };
    this.identities[id] = identity;
    this.emitEvent(identity, 'FIRST_SEEN', { from: undefined, to: 'FIRST_SEEN', reason: `first seen via ${identity.firstSeenSource}` });
    this.save();
    return identity;
  }

  public appendObservation(observation: Omit<OpportunityObservation, 'id' | 'observedAt'>): OpportunityObservation {
    const record: OpportunityObservation = {
      ...observation,
      id: this.uniqueId('OBS'),
      observedAt: this.now().toISOString(),
    };
    this.observations.push(record);
    if (this.observations.length > MAX_OBSERVATIONS) {
      this.observations = this.observations.slice(-MAX_OBSERVATIONS);
    }
    this.save();
    return record;
  }

  /** Validate a state edge (fail-closed: terminal states and invalid edges are rejected). */
  public transition(opportunityId: string, to: OpportunityState, reason: string, type: OpportunityEventType): TransitionResult {
    const identity = this.identities[opportunityId];
    if (!identity) return { ok: false, reason: `unknown opportunity '${opportunityId}'` };
    const from = identity.currentState;
    if (from === to) return { ok: true, reason: 'no-op' };
    const sm = new StateMachine<OpportunityState>(from, OPPORTUNITY_TRANSITIONS);
    if (TERMINAL_STATES.has(from)) return { ok: false, reason: `state '${from}' is terminal` };
    if (!sm.canTransitionTo(to)) return { ok: false, reason: `invalid transition '${from}' -> '${to}'` };
    identity.currentState = to;
    identity.stateUpdatedAt = this.now().toISOString();
    // Capture the evaluation-window entry (first admission to WATCHING) exactly once.
    // The post-mortem measures trajectory from this admission window, not the token's
    // first-ever tick, so a pre-evaluation spike can never be misread as a profitable miss.
    if (to === 'WATCHING' && identity.admittedAt === undefined) {
      identity.admittedAt = identity.stateUpdatedAt;
      const latestObs = [...this.observations]
        .reverse()
        .find((o) => o.opportunityId === opportunityId);
      identity.admissionPriceUsd = latestObs?.priceUsd ?? identity.firstSeenPriceUsd;
    }
    this.emitEvent(identity, type, { from, to, reason });
    this.save();
    return { ok: true };
  }

  public setFinalOutcome(opportunityId: string, outcome: OpportunityOutcomeReason): boolean {
    const identity = this.identities[opportunityId];
    if (!identity || !TERMINAL_STATES.has(identity.currentState) || identity.finalOutcome) return false;
    identity.finalOutcome = outcome;
    this.emitEvent(identity, 'ATTRIBUTED', { from: identity.currentState, to: identity.currentState, reason: `attributed: ${outcome}` });
    this.save();
    return true;
  }

  /**
   * Record a position lifecycle event from the PositionManager. Attempts the
   * matching state edge (OPEN for MOVED_TO_OPEN, EXITED for POSITION_EXITED)
   * when it is valid and always appends the audit event. Fail-soft: an unknown
   * opportunity or an invalid edge still records the event without forcing a
   * fabricated transition.
   */
  public recordPositionEvent(
    opportunityId: string,
    type: 'MOVED_TO_OPEN' | 'POSITION_EXITED',
    reason: string,
    data?: Record<string, unknown>
  ): void {
    const identity = this.identities[opportunityId];
    if (!identity) return;
    const target: OpportunityState = type === 'MOVED_TO_OPEN' ? 'OPEN' : 'EXITED';
    const from = identity.currentState;
    let to = from;
    const sm = new StateMachine<OpportunityState>(from, OPPORTUNITY_TRANSITIONS);
    if (from !== target && !TERMINAL_STATES.has(from) && sm.canTransitionTo(target)) {
      identity.currentState = target;
      identity.stateUpdatedAt = this.now().toISOString();
      to = target;
    }
    this.emitEvent(identity, type, { from, to, reason });
    if (data) {
      this.events[this.events.length - 1].data = data;
    }
    this.save();
  }

  /**
   * Find identities whose contractAddress matches (case-insensitive). The
   * PositionManager stores only a contractAddress, so it resolves the
   * opportunity id this way rather than fabricating a chain+address key.
   */
  public findByContractAddress(contractAddress: string): OpportunityIdentity[] {
    const addr = String(contractAddress || '').trim().toLowerCase();
    if (!addr) return [];
    return Object.values(this.identities).filter((i) => i.contractAddress.toLowerCase() === addr);
  }

  /** Set the review throttle deadline for an opportunity. Returns false if unknown. */
  public setNextReviewAt(opportunityId: string, isoAt: string): boolean {
    const identity = this.identities[opportunityId];
    if (!identity) return false;
    identity.nextReviewAt = isoAt;
    this.save();
    return true;
  }

  public get(opportunityId: string): OpportunityIdentity | undefined {
    return this.identities[opportunityId];
  }

  public getAll(): OpportunityIdentity[] {
    return Object.values(this.identities);
  }

  public byState(state: OpportunityState): OpportunityIdentity[] {
    return Object.values(this.identities).filter((i) => i.currentState === state);
  }

  /** Terminal opportunities missing a finalOutcome — the Post-mortem's queue. */
  public closedUnattributed(): OpportunityIdentity[] {
    return Object.values(this.identities).filter((i) => TERMINAL_STATES.has(i.currentState) && !i.finalOutcome);
  }

  public getEvents(opportunityId?: string, limit = 50): OpportunityEvent[] {
    const list = opportunityId ? this.events.filter((e) => e.opportunityId === opportunityId) : this.events;
    return list.slice(-limit).reverse();
  }

  public getObservations(opportunityId: string, limit = 50): OpportunityObservation[] {
    return this.observations.filter((o) => o.opportunityId === opportunityId).slice(-limit).reverse();
  }

  public flushToDisk(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.writeToDisk();
  }

  // ==========================================
  // PERSISTENCE
  // ==========================================

  private emitEvent(identity: OpportunityIdentity, type: OpportunityEventType, params: { from?: OpportunityState; to?: OpportunityState; reason: string }): void {
    this.events.push({
      id: this.uniqueId('EVT'),
      opportunityId: identity.opportunityId,
      type,
      from: params.from,
      to: params.to,
      reason: params.reason,
      at: this.now().toISOString(),
    });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  private uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.dbFilePath)) return;
      const data = JSON.parse(fs.readFileSync(this.dbFilePath, 'utf-8')) as Partial<OpportunityLedgerState>;
      this.identities = data.identities || {};
      this.observations = data.observations || [];
      this.events = data.events || [];
    } catch (err: any) {
      console.error(`[OPPORTUNITY LEDGER ERROR] Failed loading ledger, starting fresh: ${err.message}`);
      this.identities = {};
      this.observations = [];
      this.events = [];
    }
  }

  private writeToDisk(): void {
    try {
      atomicWriteJsonSync(this.dbFilePath, {
        identities: this.identities,
        observations: this.observations,
        events: this.events,
        version: CURRENT_VERSION,
      } as OpportunityLedgerState);
    } catch (err: any) {
      console.error(`[OPPORTUNITY LEDGER ERROR] Failed saving ledger: ${err.message}`);
    }
  }

  private save(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      this.writeToDisk();
      this.saveDebounceTimer = null;
    }, this.DEBOUNCE_MS);
  }
}
