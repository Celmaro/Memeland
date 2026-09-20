import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OpportunityLedger } from '../src/services/opportunity-ledger.js';
import { OpportunityPostMortem } from '../src/services/opportunity-post-mortem.js';

const dbPaths: string[] = [];
const ledgers: OpportunityLedger[] = [];

function newLedger(): OpportunityLedger {
  const p = path.join(process.cwd(), 'database', `test_postmortem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const l = new OpportunityLedger(p);
  ledgers.push(l);
  return l;
}

function walk(ledger: OpportunityLedger, id: string, states: string[]): void {
  for (const s of states) {
    expect(ledger.transition(id, s as any, 'test', 'RISK_PASSED').ok).toBe(true);
  }
}

const OPEN_PATH = ['RISK_PENDING', 'WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET', 'APPROVAL_PENDING', 'APPROVED', 'OPEN'];
const ADMITTED_PATH = ['RISK_PENDING', 'WATCHING']; // into the evaluation window, never traded

/** Build a closed EXITED opportunity with the given observed price trajectory. */
function closedOpportunity(ledger: OpportunityLedger, address: string, prices: number[], entryPrice = 1.0): string {
  const id = ledger.ensureOpportunity({ chain: 'sol', contractAddress: address, source: 'rank', priceUsd: entryPrice }).opportunityId;
  walk(ledger, id, OPEN_PATH);
  ledger.transition(id, 'EXIT_TRIGGERED', 'triggered', 'POSITION_EXITED');
  ledger.transition(id, 'EXITED', 'exited', 'POSITION_EXITED');
  for (const p of prices) {
    ledger.appendObservation({ opportunityId: id, source: 'rank', priceUsd: p });
  }
  return id;
}

/** Build a never-held terminal (EXPIRED) opportunity that was admitted to evaluation then parked. */
function expiredOpportunity(ledger: OpportunityLedger, address: string, prices: number[], entryPrice = 1.0): string {
  const id = ledger.ensureOpportunity({ chain: 'sol', contractAddress: address, source: 'rank', priceUsd: entryPrice }).opportunityId;
  walk(ledger, id, ADMITTED_PATH);
  for (const p of prices) {
    ledger.appendObservation({ opportunityId: id, source: 'rank', priceUsd: p });
  }
  ledger.transition(id, 'EXPIRED', 'parked', 'EXPIRED');
  return id;
}

describe('OpportunityPostMortem', () => {
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

  it('attributes a never-held profitable close as PROFITABLE_MISS but does NOT feed success (Q16: neutral)', () => {
    const ledger = newLedger();
    const id = expiredOpportunity(ledger, '0xWIN', [1.0, 1.8]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.attributedCount).toBe(1);
    // PROFITABLE_MISS = the bot never held the trade — never feed a success weight.
    expect(res.fedSuccessCount).toBe(0);
    expect(res.skippedNeutralCount).toBe(1);
    expect(fed).toEqual([]);
    expect(ledger.get(id)!.finalOutcome).toBe('PROFITABLE_MISS');
  });

  it('attributes a never-held losing close as CORRECT_REJECTION and feeds failure', () => {
    const ledger = newLedger();
    const id = expiredOpportunity(ledger, '0xLOSS', [1.0, 0.5, 0.6]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.fedLossCount).toBe(1);
    expect(fed).toEqual([false]);
    expect(ledger.get(id)!.finalOutcome).toBe('CORRECT_REJECTION');
  });

  it('attributes a never-held neutral close without feeding learning weights', () => {
    const ledger = newLedger();
    expiredOpportunity(ledger, '0xNEUTR', [1.0, 1.1, 0.95]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.attributedCount).toBe(1);
    expect(res.skippedNeutralCount).toBe(1);
    expect(fed).toEqual([]);
  });

  it('drains an EXITED (realized) trade without feeding — the live TP/SL loop already recalibrated it', () => {
    const ledger = newLedger();
    const id = closedOpportunity(ledger, '0xEXIT', [1.0, 1.8]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.attributedCount).toBe(1);
    expect(res.fedSuccessCount).toBe(0);
    expect(res.fedLossCount).toBe(0);
    expect(res.skippedNeutralCount).toBe(1);
    expect(fed).toEqual([]); // never re-feed a realized trade
    expect(ledger.get(id)!.finalOutcome).toBe('REALIZED');
    expect(ledger.closedUnattributed()).toHaveLength(0);
  });

  it('is a no-op when there are no closed-unattributed opportunities', () => {
    const ledger = newLedger();
    ledger.ensureOpportunity({ chain: 'sol', contractAddress: '0xOPEN', source: 'rank' });
    const pm = new OpportunityPostMortem(ledger, () => { throw new Error('should not feed'); });
    const res = pm.run();
    expect(res.attributedCount).toBe(0);
    expect(ledger.closedUnattributed()).toHaveLength(0);
  });
});
