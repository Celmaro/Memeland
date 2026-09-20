import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OpportunityLedger } from '../src/services/opportunity-ledger.js';
import { OpportunityPostMortem } from '../src/services/opportunity-post-mortem.js';

/**
 * Q16 — learning-feed soundness regression guard (from the 7c80573 code review).
 * Guarantees the swarm's learning feed is honest:
 *   - a realized outcome feeds the swarm EXACTLY ONCE in total (no double-count),
 *   - a PROFITABLE_MISS (the bot never held the trade) never increments a success weight,
 *   - classification is anchored to the evaluation entry (not the token's first-ever tick).
 */

const dbPaths: string[] = [];
const ledgers: OpportunityLedger[] = [];

function newLedger(): OpportunityLedger {
  const p = path.join(process.cwd(), 'database', `test_dedup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
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

describe('Q16 learning-feed dedup regression guard', () => {
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

  it('a position that reached EXITED feeds the swarm exactly once in total (run() twice does not double-feed)', () => {
    const ledger = newLedger();
    closedOpportunity(ledger, '0xEXITED-LOSS', [1.0, 0.5]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const first = pm.run();
    const second = pm.run();
    expect(first.fedLossCount).toBe(1);
    expect(second.fedSuccessCount + second.fedLossCount).toBe(0); // nothing left to feed
    expect(fed).toEqual([false]); // exactly one learning call total
  });

  it('a PROFITABLE_MISS never increments a success weight', () => {
    const ledger = newLedger();
    closedOpportunity(ledger, '0xWIN', [1.0, 1.9]); // ran +90%, but bot never held
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.fedSuccessCount).toBe(0);
    expect(res.fedLossCount).toBe(0);
    expect(res.skippedNeutralCount).toBe(1);
    expect(fed).toEqual([]);
  });

  it('mixed queue: the loss feeds exactly once, the profitable miss stays neutral', () => {
    const ledger = newLedger();
    closedOpportunity(ledger, '0xLOSS', [1.0, 0.6]);
    closedOpportunity(ledger, '0xWIN', [1.0, 2.0]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.attributedCount).toBe(2);
    expect(res.fedSuccessCount).toBe(0);
    expect(res.fedLossCount).toBe(1);
    expect(res.skippedNeutralCount).toBe(1);
    expect(fed).toEqual([false]);
  });

  it('classification is anchored to the evaluation entry (a 2x run from entry = PROFITABLE_MISS, neutral)', () => {
    // Entry at $1.0 and the trajectory runs +100% from that entry. The classifier anchors
    // to the evaluation entry — it becomes PROFITABLE_MISS (neutral), never a success feed,
    // even though the bot never held the trade.
    const ledger = newLedger();
    closedOpportunity(ledger, '0xANCHOR', [1.0, 2.0]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const res = pm.run();
    expect(res.attributedCount).toBe(1);
    expect(res.fedSuccessCount).toBe(0); // never credit a success the bot didn't take
    expect(fed).toEqual([]);
  });
});