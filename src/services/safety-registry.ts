/**
 * Q15 — Safety-registry + honest replay journal (SRC-173 OKX safety arch + SRC-124
 * event-sourced paper journal). The missing link between the approval queue and
 * auto-execution:
 *   - SafeConfigRegistry: versioned, atomic safe-config with read-only default and
 *     deny-first capability-gated remediation (plumbed to Q11 CapabilityRBAC).
 *   - ReplayJournal: append-only event sequence that reconciles fills/PnL idempotently
 *     (a unique event id can never double-count its PnL).
 *
 * Nothing here touches a live executor or persists secrets. Storage I/O is injected
 * so the module is pure/testable; the atomicity contract is: a malformed/partial
 * config is NEVER honored (read returns null) and remediation ALWAYS writes complete
 * JSON.
 */

import { CapabilityRBAC } from './exec-governance.js';

// ── Safe-config registry ────────────────────────────────────────────────────

export interface SafeConfig {
  version: number;
  /** true = trading allowed behind the other gates. false/absent = fail-closed. */
  safe: boolean;
  reason: string;
  role: string;
  /** Commit-time expiry (ms). Expired configs are treated as NOT safe. */
  expiresAt?: number;
}

export interface SafeConfigIO {
  read(): string | null;
  write(payloadJson: string): void;
}

const REMEDIATE_CAPABILITY = 'safety:remediate';

export class SafeConfigRegistry {
  constructor(
    private readonly io: SafeConfigIO,
    private readonly rbac: CapabilityRBAC,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Read the current safe-config. Fail-closed on ANY malformation: unparsable or
   * missing payload -> null (never honored). Expired config -> returned but treated
   * as NOT safe by isSafe().
   */
  public read(): SafeConfig | null {
    const raw = this.io.read();
    if (!raw) return null;
    try {
      const cfg = JSON.parse(raw) as SafeConfig;
      if (typeof cfg !== 'object' || cfg === null) return null;
      if (typeof cfg.safe !== 'boolean') return null;
      return cfg;
    } catch {
      return null; // corrupt partial — never read
    }
  }

  /** Fail-closed gate: only an unexpired, explicitly-safe config passes. */
  public isSafe(role: string): { safe: boolean; reason: string } {
    const cfg = this.read();
    if (!cfg) return { safe: false, reason: 'no safe-config — fail-closed' };
    if (cfg.expiresAt !== undefined && this.now() > cfg.expiresAt) {
      return { safe: false, reason: `safe-config expired (${new Date(cfg.expiresAt).toISOString()})` };
    }
    if (!cfg.safe) return { safe: false, reason: cfg.reason || 'explicitly not safe' };
    return { safe: true, reason: `safe v${cfg.version} for role '${role}'` };
  }

  /**
   * Atomic remediation-write. Deny-first: a role MUST have the 'safety:remediate'
   * capability or the write is refused. read-only by default (no capability -> refuse).
   * On success the version monotonically increments and a complete JSON payload is written.
   */
  public remediate(role: string, patch: { safe: boolean; reason?: string; expiresAt?: number }): { ok: boolean; reason?: string; version?: number } {
    if (!this.rbac.hasCapability(role, REMEDIATE_CAPABILITY)) {
      return { ok: false, reason: `deny-first: role '${role}' lacks ${REMEDIATE_CAPABILITY}` };
    }
    const prev = this.read();
    const nextVersion = (prev?.version ?? 0) + 1;
    const next: SafeConfig = {
      version: nextVersion,
      safe: patch.safe,
      reason: patch.reason ?? (patch.safe ? 'remediated to safe' : 'remediated to not-safe'),
      role,
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    };
    this.io.write(JSON.stringify(next, null, 2));
    return { ok: true, version: nextVersion };
  }
}

// ── Honest replay journal ───────────────────────────────────────────────────

export type JournalEventKind = 'open' | 'fill' | 'close';

export interface JournalEvent {
  kind: JournalEventKind;
  /** Unique event id — the reconciliation anchor. An id can only ever apply once. */
  id: string;
  sequence: number;
  tokenAddress: string;
  amountUsd?: number;
  pnlUsd?: number;
  at: number;
}

export interface ReconcileResult {
  eventCount: number;
  openCount: number;
  fillCount: number;
  closeCount: number;
  /** Sum of realized PnL across closed fills, each counted exactly once. */
  netPnlUsd: number;
}

export class ReplayJournal {
  private events: JournalEvent[] = [];
  private seen = new Set<string>();

  constructor(seed: JournalEvent[] = []) {
    for (const ev of seed) this.append(ev);
  }

  /** Append an event. Idempotent by id: re-appending the same id is a no-op (never double-count). */
  public append(ev: Omit<JournalEvent, 'sequence'>): { appended: boolean; sequence?: number } {
    if (this.seen.has(ev.id)) return { appended: false };
    const sequence = this.events.length === 0 ? 1 : this.events[this.events.length - 1].sequence + 1;
    this.seen.add(ev.id);
    this.events.push({ ...ev, sequence });
    return { appended: true, sequence };
  }

  public get sequence(): number {
    return this.events.length === 0 ? 0 : this.events[this.events.length - 1].sequence;
  }

  public get all(): readonly JournalEvent[] {
    return this.events;
  }

  /** Replay the recorded sequence and reconcile fills/PnL without double-counting. */
  public reconcile(): ReconcileResult {
    let openCount = 0;
    let fillCount = 0;
    let closeCount = 0;
    let netPnlUsd = 0;
    for (const ev of this.events) {
      if (ev.kind === 'open') openCount += 1;
      else if (ev.kind === 'fill') fillCount += 1;
      else if (ev.kind === 'close') {
        closeCount += 1;
        if (typeof ev.pnlUsd === 'number') netPnlUsd += ev.pnlUsd;
      }
    }
    return { eventCount: this.events.length, openCount, fillCount, closeCount, netPnlUsd };
  }

  /** True when no event id repeats — the anchor for "honest numbers only". */
  public isIdempotent(): boolean {
    return this.events.length === this.seen.size;
  }
}