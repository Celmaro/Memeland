import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PositionManager } from '../src/position/position-manager.js';
import { OpportunityLedger } from '../src/services/opportunity-ledger.js';

const mkPosition = () => ({
  id: 'POS_1',
  symbol: 'TOKX',
  contractAddress: 'MINTX',
  entryPriceUsd: 1.0,
  currentPriceUsd: 1.0,
  amount: 1000,
  highWaterMarkUsd: 1.0,
});

const dbPaths: string[] = [];
const ledgers: OpportunityLedger[] = [];

function newLedger(): OpportunityLedger {
  const p = path.join(process.cwd(), 'database', `test_position_ledger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const l = new OpportunityLedger(p);
  ledgers.push(l);
  return l;
}

describe('PositionManager.updateMemePosition — stop-loss enforcement', () => {
  afterAll(() => {
    for (const l of ledgers) {
      try { l.flushToDisk(); } catch { /* ignore */ }
    }
    for (const p of dbPaths) {
      for (const f of [p, `${p}.tmp`]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
    }
  });

  it('fires CRITICAL at -50% by default (stopLossPct unset)', () => {
    const pm = new PositionManager();
    pm.addPosition(mkPosition());

    // -40% is above the default -50% SL → no critical alert.
    expect(pm.updateMemePosition('POS_1', 0.6).triggerAlert).toBe(false);
    // -50% hits the default SL.
    const res = pm.updateMemePosition('POS_1', 0.5);
    expect(res.triggerAlert).toBe(true);
    expect(res.type).toBe('CRITICAL');
    expect(res.reason).toContain('-50%');
  });

  it('a tightened SL (stopLossPct=0.2) fires CRITICAL earlier at -20%, not -50%', () => {
    const pm = new PositionManager();
    pm.addPosition(mkPosition());
    expect(pm.tightenStopLoss('MINTX', 0.2)).toBe(true);

    // -40% is well past the tightened -20% SL → critical fires.
    const res = pm.updateMemePosition('POS_1', 0.6);
    expect(res.triggerAlert).toBe(true);
    expect(res.type).toBe('CRITICAL');
    expect(res.reason).toContain('-20%');
  });

  it('tightenStopLoss only narrows the SL — never widens it back', () => {
    const pm = new PositionManager();
    pm.addPosition(mkPosition());
    pm.tightenStopLoss('MINTX', 0.2);
    // A later, looser value must not widen the already-tightened SL.
    pm.tightenStopLoss('MINTX', 0.5);
    const pos = pm.getActivePositions().find((p) => p.contractAddress === 'MINTX');
    expect(pos?.stopLossPct).toBe(0.2);
  });

  it('emits MOVED_TO_OPEN on addPosition and POSITION_EXITED on removePosition', () => {
    const pm = new PositionManager();
    const ledger = newLedger();
    const id = ledger.ensureOpportunity({ chain: 'robinhood', contractAddress: 'MINTX', symbol: 'TOKX', source: 'rank' }).opportunityId;
    for (const s of ['RISK_PENDING', 'WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET', 'APPROVAL_PENDING', 'APPROVED']) {
      expect(ledger.transition(id, s as any, 'test', 'RISK_PASSED').ok).toBe(true);
    }
    pm.attachOpportunityLedger(ledger);

    pm.addPosition(mkPosition());
    expect(ledger.get(id)!.currentState).toBe('OPEN');

    pm.removePosition('POS_1');
    expect(ledger.get(id)!.currentState).toBe('EXITED');

    const events = ledger.getEvents(id);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['POSITION_EXITED', 'MOVED_TO_OPEN', 'FIRST_SEEN'])
    );
    // The two lifecycle events are the most recent, in reverse-chronological order.
    expect(events[0].type).toBe('POSITION_EXITED');
    expect(events[1].type).toBe('MOVED_TO_OPEN');
  });

  it('lifecycle events are skipped (no-op) when no ledger is attached', () => {
    const pm = new PositionManager();
    expect(() => {
      pm.addPosition(mkPosition());
      pm.removePosition('POS_1');
    }).not.toThrow();
    expect(pm.getActivePositions()).toHaveLength(0);
  });
});
