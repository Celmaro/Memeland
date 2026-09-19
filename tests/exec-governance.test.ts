import { describe, it, expect } from 'vitest';
import { ApprovalGovernance, CapabilityRBAC, hashPayload } from '../src/services/exec-governance.js';

describe('ApprovalGovernance (Q11)', () => {
  it('reserving the same nonce/payload is a no-op (idempotent)', () => {
    let t = 0;
    const gov = new ApprovalGovernance(() => ++t);
    const order = { nonce: 'n1', payload: 'buy TOKEN 100usd' };
    const first = gov.reserve(order);
    const second = gov.reserve(order);
    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(true);
    expect(second.at).toBe(first.at); // existing reservation, not re-recorded
    expect(gov.audit.filter((e) => e.kind === 'reserved')).toHaveLength(1);
  });

  it('refuses a nonce reused with a different payload', () => {
    const gov = new ApprovalGovernance();
    gov.reserve({ nonce: 'n', payload: 'A' });
    const r = gov.reserve({ nonce: 'n', payload: 'B' });
    expect(r.reserved).toBe(false);
    expect(r.reason).toContain('different payload');
  });

  it('a receipt hash mismatched against the order payload is rejected', () => {
    const gov = new ApprovalGovernance();
    gov.reserve({ nonce: 'n', payload: 'exact' });
    const bad = gov.issueReceipt({ nonce: 'n', payload: 'tampered' });
    expect(bad.valid).toBe(false);
    const good = gov.issueReceipt({ nonce: 'n', payload: 'exact' });
    expect(good.valid).toBe(true);
    expect(good.receipt!.payloadHash).toBe(hashPayload('exact'));
  });

  it('appends audit events and resets explicitly', () => {
    const gov = new ApprovalGovernance();
    gov.reserve({ nonce: 'a', payload: 'x' });
    gov.issueReceipt({ nonce: 'a', payload: 'x' });
    gov.issueReceipt({ nonce: 'a', payload: 'y' }); // rejected → audit
    const before = gov.audit.length;
    expect(gov.audit.some((e) => e.kind === 'receipt_rejected')).toBe(true);
    gov.reset();
    expect(gov.audit.length).toBe(before + 1);
    expect(gov.audit.at(-1)!.kind).toBe('reset');
  });
});

describe('CapabilityRBAC (Q11)', () => {
  it('refuses an unlisted capability by default (deny-first)', () => {
    const rbac = new CapabilityRBAC({ operator: ['trade', 'view'] });
    expect(rbac.hasCapability('operator', 'trade')).toBe(true);
    expect(rbac.hasCapability('operator', 'admin')).toBe(false);
    expect(rbac.hasCapability('ghost', 'trade')).toBe(false);
  });
});
