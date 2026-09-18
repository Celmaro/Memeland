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

  it('attributes a profitable close as PROFITABLE_MISS and feeds success', () => {
    const ledger = newLedger();
    const id = closedOpportunity(ledger, '0xWIN', [1.0, 1.8]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.attributedCount).toBe(1);
    expect(res.fedSuccessCount).toBe(1);
    expect(fed).toEqual([true]);
    expect(ledger.get(id)!.finalOutcome).toBe('PROFITABLE_MISS');
  });

  it('attributes a losing close as CORRECT_REJECTION and feeds failure', () => {
    const ledger = newLedger();
    const id = closedOpportunity(ledger, '0xLOSS', [1.0, 0.5, 0.6]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.fedLossCount).toBe(1);
    expect(fed).toEqual([false]);
    expect(ledger.get(id)!.finalOutcome).toBe('CORRECT_REJECTION');
  });

  it('attributes a neutral close without feeding learning weights', () => {
    const ledger = newLedger();
    closedOpportunity(ledger, '0xNEUTR', [1.0, 1.1, 0.95]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.attributedCount).toBe(1);
    expect(res.skippedNeutralCount).toBe(1);
    expect(fed).toEqual([]);
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
