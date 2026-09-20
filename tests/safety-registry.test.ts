import { describe, it, expect, vi } from 'vitest';
import { SafeConfigRegistry, ReplayJournal, type SafeConfigIO } from '../src/services/safety-registry.js';
import { CapabilityRBAC } from '../src/services/exec-governance.js';

/** In-memory IO with an optional raw string override to simulate a corrupt partial file. */
function memIO(initial: string | null = null): SafeConfigIO & { store: string | null; written: string[] } {
  const written: string[] = [];
  return {
    store: initial,
    written,
    read: () => written.length > 0 ? written[written.length - 1] : initial,
    write: (s: string) => { written.push(s); },
  };
}

const rbac = (roleCaps?: Record<string, string[]>) => new CapabilityRBAC(roleCaps ?? {});
const SAFE_ROLES = { admin: ['safety:remediate'], operator: [] };

describe('Q15 SafeConfigRegistry', () => {
  it('read-only default: no safe-config and no remediate capability are both fail-closed', () => {
    const io = memIO(null);
    const reg = new SafeConfigRegistry(io, rbac(SAFE_ROLES));
    expect(reg.read()).toBeNull();
    expect(reg.isSafe('admin').safe).toBe(false);
    // operator lacks the remediate capability → refuse (deny-first, read-only default)
    expect(reg.remediate('operator', { safe: true }).ok).toBe(false);
    expect(io.written).toHaveLength(0);
  });

  it('remediation requires the explicit s:safety:remediate capability and bumps the version', () => {
    const io = memIO(null);
    const reg = new SafeConfigRegistry(io, rbac(SAFE_ROLES));
    const res = reg.remediate('admin', { safe: true, reason: 'gates healthy' });
    expect(res.ok).toBe(true);
    expect(res.version).toBe(1);
    const readBack = reg.read();
    expect(readBack?.safe).toBe(true);
    expect(readBack?.version).toBe(1);
    // next write is version 2
    expect(reg.remediate('admin', { safe: false, reason: 'loss cap hit' }).version).toBe(2);
    expect(reg.isSafe('admin').safe).toBe(false);
  });

  it('corrupt / partial safe-file is NEVER read — read() returns null and isSafe() is fail-closed', () => {
    const io = memIO('{"safe": tru'); // truncated mid-boolean — a torn write
    const reg = new SafeConfigRegistry(io, rbac(SAFE_ROLES));
    expect(reg.read()).toBeNull();
    expect(reg.isSafe('admin').safe).toBe(false);
    expect(reg.isSafe('admin').reason).toContain('fail-closed');
  });

  it('expired safe-config is fail-closed even when the payload said safe:true', () => {
    const now = 1_700_000_000_000;
    const cfg = JSON.stringify({ version: 1, safe: true, reason: 'ok', role: 'admin', expiresAt: now - 1000 });
    const reg = new SafeConfigRegistry(memIO(cfg), rbac(SAFE_ROLES), () => now);
    expect(reg.isSafe('admin').safe).toBe(false);
    expect(reg.isSafe('admin').reason).toContain('expired');
  });

  it('remediation always writes complete JSON that round-trips (atomic write)', () => {
    const io = memIO(null);
    const reg = new SafeConfigRegistry(io, rbac(SAFE_ROLES));
    reg.remediate('admin', { safe: true });
    expect(io.written).toHaveLength(1);
    const parsed = JSON.parse(io.written[0]);
    expect(typeof parsed.safe).toBe('boolean');
    expect(typeof parsed.version).toBe('number');
    expect(typeof parsed.role).toBe('string');
  });
});

describe('Q15 ReplayJournal — idempotent fill/PnL reconciliation', () => {
  it('records a sequence and reconciles fills/PnL without double-counting', () => {
    const j = new ReplayJournal();
    j.append({ kind: 'open', id: 'o1', tokenAddress: '0xT', amountUsd: 100, at: 1 });
    j.append({ kind: 'fill', id: 'f1', tokenAddress: '0xT', amountUsd: 100, at: 2 });
    j.append({ kind: 'close', id: 'c1', tokenAddress: '0xT', pnlUsd: 40, at: 3 });

    const r = j.reconcile();
    expect(r.openCount).toBe(1);
    expect(r.fillCount).toBe(1);
    expect(r.closeCount).toBe(1);
    expect(r.netPnlUsd).toBe(40);
    expect(j.isIdempotent()).toBe(true);
    expect(j.sequence).toBe(3);
  });

  it('re-appending the same event id is a no-op — PnL is never double-counted', () => {
    const j = new ReplayJournal();
    j.append({ kind: 'open', id: 'o1', tokenAddress: '0xT', at: 1 });
    j.append({ kind: 'fill', id: 'f1', tokenAddress: '0xT', amountUsd: 100, at: 2 });
    j.append({ kind: 'close', id: 'c1', tokenAddress: '0xT', pnlUsd: 50, at: 3 });

    // Replay the exact same close (e.g. a replayed journal) — must not inflate PnL.
    expect(j.append({ kind: 'close', id: 'c1', tokenAddress: '0xT', pnlUsd: 50, at: 3 }).appended).toBe(false);
    const r = j.reconcile();
    expect(r.closeCount).toBe(1);
    expect(r.netPnlUsd).toBe(50); // unchanged
    expect(j.isIdempotent()).toBe(true);
    expect(j.sequence).toBe(3); // sequence did not advance on the rejected append
  });

  it('nonmatching/fill-only journals reconcile to zero PnL (no fabricated numbers)', () => {
    const j = new ReplayJournal();
    j.append({ kind: 'open', id: 'o1', tokenAddress: '0xT', at: 1 });
    j.append({ kind: 'fill', id: 'f1', tokenAddress: '0xT', amountUsd: 200, at: 2 });
    const r = j.reconcile();
    expect(r.netPnlUsd).toBe(0); // no close → honest zero, never a guessed PnL
  });
});