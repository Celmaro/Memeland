import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { StateStore } from '../src/services/state-store.js';
import { ApprovalQueueService } from '../src/services/approval-queue-service.js';
import { DecisionLedger } from '../src/services/decision-ledger.js';

const dbPaths: string[] = [];
const stores: StateStore[] = [];

function newStore(): StateStore {
  const p = path.join(process.cwd(), 'database', `test_approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const s = new StateStore(p);
  stores.push(s);
  return s;
}

function newService(opts: { minApprovedFills?: number } = {}): { svc: ApprovalQueueService; store: StateStore } {
  const store = newStore();
  const svc = new ApprovalQueueService(opts);
  svc.attachStateStore(store);
  return { svc, store };
}

const input = {
  domain: 'meme-robinhood',
  symbol: 'TEST',
  contractAddress: '0x1234',
  chain: 'robinhood',
  entryPriceUsd: 0.5,
  suggestedSizeUsd: 100,
  confidence: 85,
  thesis: 'swarm passed at 85%',
};

describe('ApprovalQueueService', () => {
  afterAll(() => {
    for (const s of stores) {
      try { s.flushToDisk(); } catch { /* ignore */ }
    }
    for (const p of dbPaths) {
      for (const f of [p, `${p}.tmp`]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
    }
  });

  it('throws when used without an attached StateStore', () => {
    const svc = new ApprovalQueueService();
    expect(() => svc.enqueue(input)).toThrow(/StateStore not attached/);
  });

  it('enqueue creates a PENDING order with the supplied fields', () => {
    const { svc } = newService();
    const order = svc.enqueue(input);
    expect(order.status).toBe('PENDING');
    expect(order.symbol).toBe('TEST');
    expect(order.domain).toBe('meme-robinhood');
    expect(order.contractAddress).toBe('0x1234');
    expect(order.id).toMatch(/^APR_/);
    expect(order.decidedAtIso).toBeUndefined();
  });

  it('enqueue stamps the optional scorecardId for correlation', () => {
    const { svc } = newService();
    const order = svc.enqueue(input, { scorecardId: 'SC_abc' });
    expect(order.scorecardId).toBe('SC_abc');
  });

  it('new orders are placed at the front of the pending list', () => {
    const { svc } = newService();
    const a = svc.enqueue(input);
    const b = svc.enqueue(input);
    const pending = svc.listPending();
    expect(pending[0].id).toBe(b.id);
    expect(pending.map((o) => o.id)).toContain(a.id);
    expect(svc.getStats().pending).toBe(2);
  });

  it('approve transitions PENDING -> APPROVED with decider and bumps the approved funnel', () => {
    const { svc, store } = newService();
    const order = svc.enqueue(input);
    const approved = svc.approve(order.id, 'operator-1');
    expect(approved?.status).toBe('APPROVED');
    expect(approved?.decidedBy).toBe('operator-1');
    expect(approved?.decidedAtIso).toBeTruthy();
    expect(svc.getStats().approved).toBe(1);
    expect(store.getFunnelStats()['meme-robinhood']?.approved).toBe(1);
  });

  it('approve records a proposed decision ledger event for the approved order', () => {
    const store = newStore();
    const ledger = new DecisionLedger();
    const svc = new ApprovalQueueService({ decisionLedger: ledger });
    svc.attachStateStore(store);
    const order = svc.enqueue(input);
    svc.approve(order.id, 'operator-1');
    expect(ledger.audit.some((e) => e.kind === 'proposed' && e.nonce === order.id)).toBe(true);
  });

  it('reject transitions PENDING -> REJECTED and bumps the rejected funnel', () => {
    const { svc, store } = newService();
    const order = svc.enqueue(input);
    const rejected = svc.reject(order.id, 'operator-1');
    expect(rejected?.status).toBe('REJECTED');
    expect(svc.getStats().rejected).toBe(1);
    expect(store.getFunnelStats()['meme-robinhood']?.rejected).toBe(1);
  });

  it('approve/reject are no-ops (return null) on non-PENDING orders', () => {
    const { svc } = newService();
    const order = svc.enqueue(input);
    svc.approve(order.id, 'op');
    expect(svc.approve(order.id, 'op')).toBeNull();
    expect(svc.reject(order.id, 'op')).toBeNull();
    expect(svc.reject('does-not-exist', 'op')).toBeNull();
  });

  it('state machine (state-machine.ts) governs the approval lifecycle edges', () => {
    const { svc } = newService();

    // PENDING -> REJECTED then REJECTED is terminal (can't flip to APPROVED).
    const a = svc.enqueue(input);
    expect(svc.reject(a.id, 'op')?.status).toBe('REJECTED');
    expect(svc.approve(a.id, 'op')).toBeNull();
    expect(svc.getById(a.id)?.status).toBe('REJECTED');

    // PENDING -> APPROVED then APPROVED is terminal (can't reject).
    const b = svc.enqueue(input);
    expect(svc.approve(b.id, 'op')?.status).toBe('APPROVED');
    expect(svc.reject(b.id, 'op')).toBeNull();
    expect(svc.getById(b.id)?.status).toBe('APPROVED');
  });

  it('getApprovedFills counts only APPROVED orders and feeds the AUTO unlock', () => {
    const { svc } = newService();
    const a = svc.enqueue(input);
    const b = svc.enqueue(input);
    svc.approve(a.id);
    expect(svc.getApprovedFills()).toBe(1);
    expect(svc.getById(b.id)?.status).toBe('PENDING');
  });

  it('recordExecuted bumps the executed funnel stage for a known order', () => {
    const { svc, store } = newService();
    const order = svc.enqueue(input);
    svc.recordExecuted(order.id);
    expect(store.getFunnelStats()['meme-robinhood']?.executed).toBe(1);
    svc.recordExecuted('does-not-exist');
    expect(store.getFunnelStats()['meme-robinhood']?.executed).toBe(1);
  });

  it('orders persist across a StateStore reload', () => {
    const store = newStore();
    const svc = new ApprovalQueueService();
    svc.attachStateStore(store);
    const order = svc.enqueue(input);
    svc.approve(order.id, 'op');
    store.flushToDisk();

    const reloaded = new StateStore(dbPaths[dbPaths.length - 1]);
    stores.push(reloaded);
    const svc2 = new ApprovalQueueService();
    svc2.attachStateStore(reloaded);
    expect(svc2.getApprovedFills()).toBe(1);
    expect(reloaded.getApprovalOrder(order.id)?.status).toBe('APPROVED');
  });

  describe('canAutoExecute (Phase-3 AUTO gate)', () => {
    function seedApproved(svc: ApprovalQueueService, n: number): void {
      for (let i = 0; i < n; i++) {
        const o = svc.enqueue(input);
        svc.approve(o.id, 'op');
      }
    }

    it('is locked below the approved-fill floor even with positive expectancy', () => {
      const { svc } = newService();
      seedApproved(svc, 49);
      const res = svc.canAutoExecute({ tp: 2, sl: 1 });
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain('AUTO locked');
      expect(res.reason).toContain('approved fills 49/50');
    });

    it('is locked when there are no closed scorecard entries', () => {
      const { svc } = newService();
      seedApproved(svc, 60);
      const res = svc.canAutoExecute({ tp: 0, sl: 0 });
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain('no closed entries');
    });

    it('is locked when win rate is not > 50%', () => {
      const { svc } = newService();
      seedApproved(svc, 60);
      const res = svc.canAutoExecute({ tp: 1, sl: 2 }); // 33%
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain('winRate 33%');
    });

    it('unlocks only above the floor with closed entries AND win rate > 50%', () => {
      const { svc } = newService();
      seedApproved(svc, 50);
      const res = svc.canAutoExecute({ tp: 3, sl: 1 }); // 75%
      expect(res.allowed).toBe(true);
      expect(res.reason).toContain('75% win rate');
      expect(res.approvedFills).toBe(50);
    });

    it('honours a custom (lower) floor for env/gate tuning', () => {
      const { svc } = newService({ minApprovedFills: 3 });
      seedApproved(svc, 3);
      const res = svc.canAutoExecute({ tp: 1, sl: 0 }); // 100%
      expect(res.allowed).toBe(true);
    });
  });
});
