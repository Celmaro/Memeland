/**
 * PR 1 / Kernel C — Decision Ledger (SRC-154 tradingcodex, SRC-107 NERVE,
 * SRC-261 FLYWHEEL, SRC-262 grok-trading-desk, Million append-only audit).
 *
 * The single, append-only writer for the execute pipeline's proposal -> veto ->
 * reservation -> receipt -> reconcile state machine. Composes the existing Q11
 * ApprovalGovernance (idempotent reservation + hash-locked receipt + deny-first
 * RBAC) with:
 *   - propose-vs-decide split + six-checks resulting-weight sizing (FLYWHEEL),
 *   - exactly-once reconcile-by-nonce with a 'replaced' guard (NERVE),
 *   - fail-closed veto + pessimistic fallback helpers (grok).
 *
 * Additive-only: no existing signature changes. Persistence is injected (io.append)
 * so the module stays pure/testable and never touches a live executor or secrets.
 */

import fs from 'fs';
import path from 'path';
import { ApprovalGovernance, type ApprovalOrder } from './exec-governance.js';

export type ReconcileState = 'confirmed' | 'failed' | 'unknown' | 'replaced';
export type SendOutcome = 'confirmed' | 'failed';

/**
 * Execution lifecycle (item 1): the explicit state machine a trade plan moves
 * through. Agents PROPOSE plans; only the deterministic gate chain may promote
 * them — never free-form model output straight to broadcast.
 */
export type TradeLifecycleState =
  | 'planned'       // agent proposal recorded
  | 'approved'      // risk gates passed (safety, sellability, sizer, fillSim, cost, governance)
  | 'simulated'     // fill/sellability simulation done
  | 'submitted'     // broadcast initiated
  | 'pending'       // tx in flight (not yet confirmed)
  | 'confirmed'     // on-chain success
  | 'rejected'      // a gate refused it
  | 'failed'        // broadcast/execution error
  | 'timed_out'     // executor timeout
  | 'replaced'      // nonce superseded
  | 'partially_filled'
  | 'reconciled';   // settlement verified against expectation

export interface TradePlan {
  agent: string;
  nonce: string;
  symbol: string;
  chain: string;
  side: 'BUY' | 'SELL';
  tokenAddress: string;
  amountUsd: number;
  maxAmountUsd: number;
  expectedOutTokens?: number;
  quoteUsd?: number;
  slippageTolerancePct?: number;
  confidence: number;
  timestamp: string;
  lifecycle: TradeLifecycleState;
}

export interface RiskCheck {
  id: string;
  label: string;
  passed: boolean;
  observed: number;
  limit: number;
}

export interface TradeProposal {
  agent: string;
  nonce: string;
  symbol: string;
  chain: string;
  side: 'BUY' | 'SELL';
  sizeEth: number;
  maxSizeEth: number;
  confidence: number;
  liquidityUsd?: number;
}

export interface WeightResult {
  weight: number;
  checks: RiskCheck[];
  reason?: string;
}

export interface LedgerEvent {
  kind: 'proposed' | 'veto' | 'reserved' | 'receipt_issued' | 'receipt_rejected' | 'send' | 'replaced' | 'lifecycle';
  seq: number;
  nonce?: string;
  agent?: string;
  symbol?: string;
  chain?: string;
  outcome?: SendOutcome;
  reason?: string;
  lifecycle?: TradeLifecycleState;
  txHash?: string;
}

export interface DecisionLedgerIO {
  /** Append one JSON line for an event. Implementations own atomicity/rotation. */
  append(line: string): void;
}

export interface DecisionLedgerOptions {
  now?: () => number;
  io?: DecisionLedgerIO;
  checks?: {
    confFloor?: number;
    chainSet?: string[];
    minLiquidityUsd?: number;
    maxLiquidityUsd?: number;
  };
}

const DEFAULT_CHAINS = ['robinhood', 'sol', 'eth', 'bsc', 'base'];

export class DecisionLedger {
  private readonly gov: ApprovalGovernance;
  private readonly io?: DecisionLedgerIO;
  private readonly checks: Required<NonNullable<DecisionLedgerOptions['checks']>>;
  private seq = 0;
  private events: LedgerEvent[] = [];
  private readonly sends = new Map<string, ReconcileState>();

  constructor(opts: DecisionLedgerOptions = {}) {
    this.gov = new ApprovalGovernance(opts.now);
    this.io = opts.io;
    this.checks = {
      confFloor: opts.checks?.confFloor ?? 0.5,
      chainSet: opts.checks?.chainSet ?? DEFAULT_CHAINS,
      minLiquidityUsd: opts.checks?.minLiquidityUsd ?? 1_000,
      maxLiquidityUsd: opts.checks?.maxLiquidityUsd ?? 100_000_000,
    };
  }

  get audit(): readonly LedgerEvent[] {
    return this.events;
  }

  private emit(ev: Omit<LedgerEvent, 'seq'>): number {
    const seq = ++this.seq;
    const full: LedgerEvent = { ...ev, seq };
    this.events.push(full);
    this.io?.append(JSON.stringify(full));
    return seq;
  }

  /** Idempotent reservation. Same nonce/payload is a no-op; different payload refused. */
  reserve(order: ApprovalOrder): { reserved: boolean; reason?: string; at: number } {
    const r = this.gov.reserve(order);
    if (r.reserved) this.emit({ kind: 'reserved', nonce: order.nonce });
    return r;
  }

  /**
   * Item 1: record a trade-plan lifecycle transition. Append-only, per nonce.
   * The execution pipeline calls this at every gate boundary (planned → approved
   * → simulated → submitted → confirmed/rejected/failed/timed_out/replaced…)
   * so the audit trail is the single source of truth for reconciliation.
   */
  recordLifecycle(plan: TradePlan, state: TradeLifecycleState, extra?: { reason?: string; txHash?: string }): number {
    const ev: Omit<LedgerEvent, 'seq'> = {
      kind: 'lifecycle',
      nonce: plan.nonce,
      agent: plan.agent,
      symbol: plan.symbol,
      chain: plan.chain,
      lifecycle: state,
      reason: extra?.reason,
      txHash: extra?.txHash,
    };
    return this.emit(ev);
  }

  /** Hash-locked receipt — only valid when the payload matches the reservation. */
  issueReceipt(order: ApprovalOrder): { valid: boolean; reason?: string } {
    const r = this.gov.issueReceipt(order);
    this.emit({
      kind: r.valid ? 'receipt_issued' : 'receipt_rejected',
      nonce: order.nonce,
      reason: r.reason,
    });
    return { valid: r.valid, reason: r.reason };
  }

  /** Append a propose (decide) event to the ledger. Returns its sequence. */
  recordProposed(proposal: TradeProposal): number {
    return this.emit({
      kind: 'proposed',
      nonce: proposal.nonce,
      agent: proposal.agent,
      symbol: proposal.symbol,
      chain: proposal.chain,
    });
  }

  /** Append a veto to the ledger. Returns its sequence. */
  recordVeto(reason: string, payload: unknown): number {
    const agent = (payload as { agent?: string } | null)?.agent;
    return this.emit({ kind: 'veto', reason, agent });
  }

  /**
   * Record a settled send outcome exactly once. A second, different outcome for the
   * same nonce is refused and flags the earlier settlement as 'replaced'.
   */
  recordSend(nonce: string, outcome: SendOutcome): { recorded: boolean; state: ReconcileState } {
    const existing = this.sends.get(nonce);
    if (existing) {
      if (existing === outcome) return { recorded: false, state: existing };
      this.sends.set(nonce, 'replaced');
      this.emit({ kind: 'replaced', nonce });
      return { recorded: false, state: 'replaced' };
    }
    this.sends.set(nonce, outcome);
    this.emit({ kind: 'send', nonce, outcome });
    return { recorded: true, state: outcome };
  }

  /** Recovery CLI for unknown terminal states: settled -> confirmed/failed, else unknown. */
  reconcileByNonce(nonce: string): ReconcileState {
    return this.sends.get(nonce) ?? 'unknown';
  }

  /**
   * P7 — rebuild operational state from a durable event history after a restart.
   * Replays send/replaced outcomes into the `sends` map (so reconcileByNonce is
   * correct across restarts) and advances seq past the highest replayed event.
   * Refuses to apply once the process has already recorded events, so it never
   * clobbers live divergence.
   */
  hydrate(events: LedgerEvent[]): void {
    if (this.events.length > 0 || this.seq > 0) return;
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    let maxSeq = 0;
    for (const ev of ordered) {
      if (ev.seq > maxSeq) maxSeq = ev.seq;
      if (ev.kind === 'send' && ev.nonce) this.sends.set(ev.nonce, ev.outcome as ReconcileState);
      else if (ev.kind === 'replaced' && ev.nonce) this.sends.set(ev.nonce, 'replaced');
    }
    this.seq = maxSeq;
    if (ordered.length > 0) this.events = ordered.slice();
  }

  /** FLYWHEEL six-checks gate. All pass -> weight = confidence; any fail -> fail-closed 0. */
  resultingWeight(proposal: TradeProposal): WeightResult {
    const chainOk = this.checks.chainSet.includes(proposal.chain);
    const measured = typeof proposal.liquidityUsd === 'number';
    const liq = proposal.liquidityUsd ?? 0;
    const checks: RiskCheck[] = [
      {
        id: 'size',
        label: 'order size within max',
        passed: proposal.sizeEth <= proposal.maxSizeEth,
        observed: proposal.sizeEth,
        limit: proposal.maxSizeEth,
      },
      {
        id: 'confidence',
        label: 'confidence at or above floor',
        passed: proposal.confidence >= this.checks.confFloor,
        observed: proposal.confidence,
        limit: this.checks.confFloor,
      },
      {
        id: 'chain',
        label: 'chain is supported',
        passed: chainOk,
        observed: chainOk ? 1 : 0,
        limit: 1,
      },
      {
        id: 'liquidity_min',
        label: 'liquidity above lower band',
        passed: !measured || liq >= this.checks.minLiquidityUsd,
        observed: liq,
        limit: this.checks.minLiquidityUsd,
      },
      {
        id: 'liquidity_max',
        label: 'liquidity within upper band',
        passed: !measured || liq <= this.checks.maxLiquidityUsd,
        observed: liq,
        limit: this.checks.maxLiquidityUsd,
      },
      {
        id: 'side',
        label: 'buy-only sizing',
        passed: proposal.side === 'BUY',
        observed: proposal.side === 'BUY' ? 1 : 0,
        limit: 1,
      },
    ];
    const failed = checks.find((c) => !c.passed);
    if (failed) {
      return { weight: 0, checks, reason: `${failed.id}: ${failed.label}` };
    }
    return { weight: Math.min(1, Math.max(0, proposal.confidence)), checks };
  }

  /** grok: when a model output cannot be parsed, veto with a named reason. */
  vetoOnParseFailure(agent: string, _raw: string): { veto: true; reason: string } {
    const reason = `parse failure: no trustworthy verdict from '${agent}'`;
    this.recordVeto(reason, { agent });
    return { veto: true, reason };
  }

  /** grok: pessimistic fallback — hold when the pipeline is broken, else buy. */
  pessimisticFallback(_agent: string, broken: boolean): 'HOLD' | 'BUY' {
    return broken ? 'HOLD' : 'BUY';
  }
}

export const DEFAULT_LEDGER_FILE = path.resolve('database', 'decision-ledger.jsonl');

/** File-backed DecisionLedgerIO — appends one JSON line per event (JSONL). */
export function fileDecisionLedgerIO(filePath: string = DEFAULT_LEDGER_FILE): DecisionLedgerIO {
  return {
    append: (line: string) => {
      try {
        const absolutePath = path.resolve(filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.appendFileSync(absolutePath, `${line}\n`, 'utf-8');
      } catch (error) {
        console.warn(`[DECISION LEDGER] Failed to append ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** Resolve a Postgres connection string for the durable decision history. */
function postgresUrl(): string | null {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URI ?? process.env.POSTGRES_CONNECTION_STRING ?? null;
}

/**
 * P7 — Postgres-backed DecisionLedgerIO. Appends each event as one JSONB row.
 * Fail-open: a DB failure degrades silently (the in-process audit still holds)
 * so a paused Postgres never blocks a decision. Lazy pool, like the observation
 * store — no connection is opened until the first append.
 */
export function pgDecisionLedgerIO(url: string = postgresUrl() ?? ''): DecisionLedgerIO {
  const dbUrl = url || null;
  let pool: any = null;
  let ready = false;
  const ensurePool = async (): Promise<any> => {
    if (!dbUrl) return null;
    if (!pool) {
      const { default: Pg } = await import('pg');
      pool = new Pg.Pool({ connectionString: dbUrl, max: 2 });
    }
    if (!ready) {
      try { await pool.query('SELECT 1'); ready = true; } catch { /* leave unready, retry on next append */ }
    }
    return ready ? pool : null;
  };
  return {
    append: (line: string) => {
      if (!dbUrl) return;
      void ensurePool()
        .then((p) =>
          p?.query('INSERT INTO decision_events (payload, created_at) VALUES ($1, $2)', [line, Date.now()]),
        )
        .catch(() => { /* fail-open */ });
    },
  };
}

/**
 * P7 — Load durable decision events as LedgerEvent[], ordered by the ledger's own
 * monotonically-increasing seq. Reads the Postgres history when a URL is present,
 * else falls back to the JSONL file. Used to rebuild operational state on restart.
 */
export async function loadDecisionEvents(opts?: { url?: string; file?: string }): Promise<LedgerEvent[]> {
  const url = opts?.url ?? postgresUrl();
  const events: LedgerEvent[] = [];
  if (url) {
    try {
      const { default: Pg } = await import('pg');
      const pool = new Pg.Pool({ connectionString: url, max: 2 });
      const { rows } = await pool.query<{ payload: string }>(
        'SELECT payload FROM decision_events',
      );
      await pool.end();
      for (const r of rows) {
        try { events.push(JSON.parse(r.payload) as LedgerEvent); } catch { /* skip malformed row */ }
      }
      events.sort((a, b) => a.seq - b.seq);
      return events;
    } catch (err) {
      console.warn(`[DECISION LEDGER] failed to load durable events: ${err instanceof Error ? err.message : String(err)}`);
      return events;
    }
  }
  const filePath = path.resolve(opts?.file ?? DEFAULT_LEDGER_FILE);
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as LedgerEvent); } catch { /* skip malformed line */ }
    }
  } catch { /* no file yet */ }
  events.sort((a, b) => a.seq - b.seq);
  return events;
}

/**
 * Create the default global ledger: Postgres-backed when a DB URL is present (and
 * best-effort rebuilds operational state from durable history on restart), else
 * file/JSONL-backed with no hydration (current behavior).
 */
export function createGlobalDecisionLedger(): DecisionLedger {
  const url = postgresUrl();
  const ledger = new DecisionLedger({ io: url ? pgDecisionLedgerIO(url) : fileDecisionLedgerIO() });
  if (url) {
    void loadDecisionEvents({ url })
      .then((evs) => { if (evs.length > 0) ledger.hydrate(evs); })
      .catch(() => { /* hydration is best-effort */ });
  }
  return ledger;
}

/** Live-process audit ledger used by the shared execution/AUTO path. */
export const globalDecisionLedger = createGlobalDecisionLedger();
