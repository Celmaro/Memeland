import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OpportunityLedger } from '../src/services/opportunity-ledger.js';
import { OpportunityPostMortem } from '../src/services/opportunity-post-mortem.js';
import { SwarmLearningEngine } from '../src/orchestrator/swarm-learning.js';

/**
 * Q16 — learning-feed soundness regression guard (from the 7c80573 code review).
 * Guarantees the swarm's learning feed is honest:
 *   - an EXITED (realized) trade feeds the swarm EXACTLY ONCE in total — the live
 *     TP/SL loop (wallet-tracker -> updateSignalPrice) is the single feeding path;
 *     the post-mortem never re-feeds it (double-count).
 *   - a PROFITABLE_MISS (the bot never held the trade) never increments a success weight,
 *   - classification is measured from the evaluation-window entry (not first-ever tick).
 */

const dbPaths: string[] = [];
const ledgers: OpportunityLedger[] = [];
const engines: SwarmLearningEngine[] = [];

function newLedger(): OpportunityLedger {
  const p = path.join(process.cwd(), 'database', `test_dedup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const l = new OpportunityLedger(p);
  ledgers.push(l);
  return l;
}

function newEngine(): SwarmLearningEngine {
  const p = path.join(process.cwd(), 'database', `test_dedup_engine_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const e = new SwarmLearningEngine(p);
  engines.push(e);
  return e;
}

function walk(ledger: OpportunityLedger, id: string, states: string[]): void {
  for (const s of states) {
    expect(ledger.transition(id, s as any, 'test', 'RISK_PASSED').ok).toBe(true);
  }
}

const OPEN_PATH = ['RISK_PENDING', 'WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET', 'APPROVAL_PENDING', 'APPROVED', 'OPEN'];
const ADMITTED_PATH = ['RISK_PENDING', 'WATCHING'];

/** Build a closed EXITED (realized) opportunity. */
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

/** Build a never-held terminal (EXPIRED) opportunity admitted to evaluation then parked. */
function expiredOpportunity(ledger: OpportunityLedger, address: string, prices: number[], entryPrice = 1.0): string {
  const id = ledger.ensureOpportunity({ chain: 'sol', contractAddress: address, source: 'rank', priceUsd: entryPrice }).opportunityId;
  walk(ledger, id, ADMITTED_PATH);
  for (const p of prices) {
    ledger.appendObservation({ opportunityId: id, source: 'rank', priceUsd: p });
  }
  ledger.transition(id, 'EXPIRED', 'parked', 'EXPIRED');
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

  it('an EXITED trade feeds the swarm exactly once in total — live TP/SL only, post-mortem dedupes', () => {
    const ledger = newLedger();
    const id = closedOpportunity(ledger, '0xEXIT', [1.0, 2.0]);
    const engine = newEngine();

    // The live loop recalibrates once when the tracked price crosses the TP threshold.
    const call = engine.recordSignalCall('whale', 'SYM', '0xEXIT', 1.0, 0.8);
    engine.updateSignalPrice(call.id, 2.0); // 2x -> recalibrateWeights(true) once
    const liveWeight = engine.getWeights().smartMoneyWeight;
    expect(liveWeight).toBeGreaterThan(0.35);

    // Post-mortem must NOT re-feed the same realized outcome.
    const pm = new OpportunityPostMortem(ledger, (s) => engine.recordAttributedOutcome(s));
    const res = pm.run();
    expect(res.fedSuccessCount).toBe(0);
    expect(res.fedLossCount).toBe(0);
    expect(engine.getWeights().smartMoneyWeight).toBe(liveWeight); // exactly once in total
    expect(ledger.get(id)!.finalOutcome).toBe('REALIZED');
    expect(ledger.closedUnattributed()).toHaveLength(0);
  });

  it('a PROFITABLE_MISS (never held) never increments a success weight', () => {
    const ledger = newLedger();
    const id = expiredOpportunity(ledger, '0xPM', [1.0, 1.9]);
    const engine = newEngine();
    const beforeSmart = engine.getWeights().smartMoneyWeight;
    const beforeLiq = engine.getWeights().liquidityWeight;

    const pm = new OpportunityPostMortem(ledger, (s) => engine.recordAttributedOutcome(s));
    const res = pm.run();
    expect(res.fedSuccessCount).toBe(0);
    expect(res.fedLossCount).toBe(0);
    expect(engine.getWeights().smartMoneyWeight).toBe(beforeSmart);
    expect(engine.getWeights().liquidityWeight).toBe(beforeLiq);
    expect(ledger.get(id)!.finalOutcome).toBe('PROFITABLE_MISS');
  });

  it('a re-run never double-feeds (the queue drains after attribution)', () => {
    const ledger = newLedger();
    expiredOpportunity(ledger, '0xLOSS', [1.0, 0.5]);
    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));

    const first = pm.run();
    const second = pm.run();
    expect(first.fedLossCount).toBe(1);
    expect(second.fedSuccessCount + second.fedLossCount).toBe(0);
    expect(fed).toEqual([false]); // exactly one feed in total across both runs
  });

  it('measures from the evaluation-window entry, not the first-ever tick', () => {
    const ledger = newLedger();
    const id = ledger.ensureOpportunity({ chain: 'sol', contractAddress: '0xANCHOR', source: 'rank', priceUsd: 1.0 }).opportunityId;
    ledger.appendObservation({ opportunityId: id, source: 'rank', priceUsd: 1.8 }); // pre-evaluation spike
    walk(ledger, id, ['RISK_PENDING']);
    ledger.transition(id, 'WATCHING', 'admit to nursery', 'NURSERY_ADMITTED'); // admission entry = 1.8
    ledger.appendObservation({ opportunityId: id, source: 'rank', priceUsd: 1.0 }); // post-admission fall
    ledger.transition(id, 'EXPIRED', 'parked', 'EXPIRED');

    const fed: boolean[] = [];
    const pm = new OpportunityPostMortem(ledger, (s) => fed.push(s));
    const res = pm.run();
    // From the evaluation entry (1.8) the trajectory only fell -> the bot correctly avoided
    // a falling token, so it feeds a loss-reinforce (CORRECT_REJECTION), never a success.
    expect(res.fedSuccessCount).toBe(0);
    expect(res.fedLossCount).toBe(1);
    expect(fed).toEqual([false]);
    expect(ledger.get(id)!.finalOutcome).toBe('CORRECT_REJECTION');
  });
});
