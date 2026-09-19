/**
 * Q11 - Execution governance (SRC-154 tradingcodex, SRC-153 paper-first/kill
 * audit loop). Idempotent order reservation, payload-hash-locked approval
 * receipts, append-only audit events, and deny-first capability RBAC. Pure so
 * it can gate approvals without coupling to a live execution path.
 */

import { createHash } from 'node:crypto';

/** Deterministic payload hash used to lock receipts to their exact order. */
export function hashPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export interface ApprovalOrder {
  nonce: string;
  payload: string;
}

export interface ApprovalReceipt {
  nonce: string;
  payloadHash: string;
  approved: boolean;
  at: number;
}

export interface AuditEvent {
  at: number;
  kind: 'reserved' | 'receipt_issued' | 'receipt_rejected' | 'reset';
  nonce: string;
  detail?: string;
}

export class ApprovalGovernance {
  private reservations = new Map<string, { payloadHash: string; at: number }>();
  private auditLog: AuditEvent[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  get audit(): readonly AuditEvent[] {
    return this.auditLog;
  }

  /**
   * Reserve an order for approval. Idempotent: reserving the same nonce with
   * the same payload is a no-op (returns the existing reservation, no second
   * audit event). A nonce reused with a DIFFERENT payload is refused.
   */
  reserve(order: ApprovalOrder): { reserved: boolean; reason?: string; at: number } {
    const at = this.now();
    const hash = hashPayload(order.payload);
    const existing = this.reservations.get(order.nonce);
    if (existing) {
      if (existing.payloadHash === hash) {
        return { reserved: true, at: existing.at };
      }
      return { reserved: false, reason: 'nonce already reserved with a different payload', at };
    }
    this.reservations.set(order.nonce, { payloadHash: hash, at });
    this.auditLog.push({ at, kind: 'reserved', nonce: order.nonce });
    return { reserved: true, at };
  }

  /**
   * Issue a receipt only when its payload hash matches the reserved order.
   * A mismatched hash is rejected (hash-locked).
   */
  issueReceipt(order: ApprovalOrder): { valid: boolean; receipt?: ApprovalReceipt; reason?: string } {
    const at = this.now();
    const reserved = this.reservations.get(order.nonce);
    const payloadHash = hashPayload(order.payload);
    if (!reserved || reserved.payloadHash !== payloadHash) {
      this.auditLog.push({ at, kind: 'receipt_rejected', nonce: order.nonce, detail: 'payload hash mismatch' });
      return { valid: false, reason: 'receipt payload does not match the reserved order' };
    }
    const receipt: ApprovalReceipt = { nonce: order.nonce, payloadHash, approved: true, at };
    this.auditLog.push({ at, kind: 'receipt_issued', nonce: order.nonce });
    return { valid: true, receipt };
  }

  reset(): void {
    const at = this.now();
    this.reservations.clear();
    this.auditLog.push({ at, kind: 'reset', nonce: '' });
  }
}

/**
 * Deny-first capability RBAC. A capability is only granted when explicitly
 * listed for a role; anything unlisted is refused by default.
 */
export class CapabilityRBAC {
  constructor(private readonly roleCapabilities: Record<string, string[]>) {}

  hasCapability(role: string, capability: string): boolean {
    const caps = this.roleCapabilities[role];
    return Array.isArray(caps) && caps.includes(capability);
  }
}
