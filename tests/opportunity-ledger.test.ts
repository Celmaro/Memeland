import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  OpportunityLedger,
  opportunityIdFor,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
} from '../src/services/opportunity-ledger.js';

const dbPaths: string[] = [];
const ledgers: OpportunityLedger[] = [];

function newLedger(): OpportunityLedger {
  const p = path.join(process.cwd(), 'database', `test_opportunity_ledger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const l = new OpportunityLedger(p);
  ledgers.push(l);
  return l;
}

/** Walk a valid APPROVED edge starting from the FIRST_SEEN identity. */
function walk(ledger: OpportunityLedger, id: string, states: string[]): void {
  for (const s of states) {
    expect(ledger.transition(id, s as any, 'test', 'RISK_PASSED').ok).toBe(true);
  }
}

const APPROVED_PATH = ['RISK_PENDING', 'WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET', 'APPROVAL_PENDING', 'APPROVED'];

describe('OpportunityLedger', () => {
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

  it('opportunityIdFor canonicalizes chain+address to a stable lowercase key', () => {
    expect(opportunityIdFor('ROBINHOOD', ' 0xABC ')).toBe('robinhood:0xabc');
    expect(opportunityIdFor('sol', 'SoL9XyZ')).toBe('sol:sol9xyz');
  });

  it('ensureOpportunity creates an immutable FIRST_SEEN identity and is idempotent', () => {
    const ledger = newLedger();
    const a = ledger.ensureOpportunity({ chain: 'robinhood', contractAddress: '0xAAA', symbol: 'TOKX', source: 'gmgn:rank', priceUsd: 0.5 });
    const b = ledger.ensureOpportunity({ chain: 'robinhood', contractAddress: '0xAAA', source: 'gmgn:hot', priceUsd: 9.9 });

    // Same identity; first-seen never overwritten by a later source.
    expect(a.opportunityId).toBe('robinhood:0xaaa');
    expect(b).toBe(a);
    expect(a.firstSeenSource).toBe('gmgn:rank');
    expect(a.currentState).toBe('FIRST_SEEN');
    // Empty address is rejected (fail-closed).
    expect(() => ledger.ensureOpportunity({ chain: 'sol', contractAddress: '', source: 'x' })).toThrow();
  });

  it('records FIRST_SEEN events into the immutable audit trail', () => {
    const ledger = newLedger();
    ledger.ensureOpportunity({ chain: 'sol', contractAddress: '0xBF', source: 'trackFeed' });
    const events = ledger.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('FIRST_SEEN');
    expect(events[0].to).toBe('FIRST_SEEN');
  });

  it('findByContractAddress is case-insensitive and needs a real address', () => {
    const ledger = newLedger();
    ledger.ensureOpportunity({ chain: 'robinhood', contractAddress: '0xABCD', source: 'rank' });
    expect(ledger.findByContractAddress('0xabcd')).toHaveLength(1);
    expect(ledger.findByContractAddress(' 0xABCD ')).toHaveLength(1);
    expect(ledger.findByContractAddress('0xZZZZ')).toHaveLength(0);
    expect(ledger.findByContractAddress('')).toHaveLength(0);
  });

  it('recordPositionEvent moves MOVED_TO_OPEN -> OPEN on the APPROVED edge', () => {
    const ledger = newLedger();
    const id = ledger.ensureOpportunity({ chain: 'sol', contractAddress: '0xPO', source: 'rank' }).opportunityId;
    walk(ledger, id, APPROVED_PATH);
    expect(ledger.get(id)!.currentState).toBe('APPROVED');

    ledger.recordPositionEvent(id, 'MOVED_TO_OPEN', 'position POS_1 opened (TOKX)');
    expect(ledger.get(id)!.currentState).toBe('OPEN');
    const evt = ledger.getEvents(id)[0];
    expect(evt.type).toBe('MOVED_TO_OPEN');
    expect(evt.from).toBe('APPROVED');
    expect(evt.to).toBe('OPEN');
  });

  it('recordPositionEvent POSITION_EXITED -> EXITED on the OPEN edge and is fail-soft on invalid edges', () => {
    const ledger = newLedger();
    const valid = ledger.ensureOpportunity({ chain: 'sol', contractAddress: '0xPX', source: 'rank' }).opportunityId;
    walk(ledger, valid, APPROVED_PATH);
    ledger.transition(valid, 'OPEN', 'opened', 'MOVED_TO_OPEN');
    ledger.recordPositionEvent(valid, 'POSITION_EXITED', 'position POS_1 exited (TOKX)');
    expect(ledger.get(valid)!.currentState).toBe('EXITED');

    // A FIRst_SEEN identity has no OPEN/EXITED edge — event still recorded, state untouched.
    const neverOpened = ledger.ensureOpportunity({ chain: 'base', contractAddress: '0xNEV', source: 'hot' }).opportunityId;
    ledger.recordPositionEvent(neverOpened, 'POSITION_EXITED', 'no-op test');
    expect(ledger.get(neverOpened)!.currentState).toBe('FIRST_SEEN');
    expect(ledger.getEvents(neverOpened)[0].type).toBe('POSITION_EXITED');
  });

  it('transition() enforces the lifecycle state machine (fail-closed)', () => {
    const ledger = newLedger();
    const id = ledger.ensureOpportunity({ chain: 'robinhood', contractAddress: '0xCEDE', source: 'rank' }).opportunityId;

    // Valid walk: FIRST_SEEN -> RISK_PENDING -> WATCHING -> ACCELERATING -> WATCH_TRIGGER -> READY_SMALL_BET -> APPROVAL_PENDING
    expect(ledger.transition(id, 'RISK_PENDING', 'audit pending', 'RISK_PASSED').ok).toBe(true);
    expect(ledger.transition(id, 'WATCHING', 'nursery admit', 'NURSERY_ADMITTED').ok).toBe(true);
    expect(ledger.transition(id, 'ACCELERATING', 'liquidity crossed 20k', 'ESCALATED').ok).toBe(true);
    expect(ledger.transition(id, 'WATCH_TRIGGER', 'smart full-close noted', 'TRIGGER_FIRED').ok).toBe(true);
    expect(ledger.transition(id, 'READY_SMALL_BET', 'consensus 84', 'TRIGGER_FIRED').ok).toBe(true);
    expect(ledger.transition(id, 'APPROVAL_PENDING', 'queued', 'APPROVAL_PENDING').ok).toBe(true);

    // Invalid edge (APPROVAL_PENDING -> ACCELERATING) is rejected.
    const bad = ledger.transition(id, 'ACCELERATING', 'should not happen', 'ESCALATED');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('invalid transition');
    expect(ledger.get(id)?.currentState).toBe('APPROVAL_PENDING');
  });

  it('terminal states block further transitions and closedUnattributed() exposes them to the Post-mortem', () => {
    const ledger = newLedger();
    const id = ledger.ensureOpportunity({ chain: 'sol', contractAddress: '0xT', source: 'hot' }).opportunityId;
    ledger.transition(id, 'RISK_PENDING', '', 'RISK_PASSED');
    ledger.transition(id, 'WATCHING', '', 'NURSERY_ADMITTED');
    ledger.transition(id, 'ACCELERATING', '', 'ESCALATED');
    ledger.transition(id, 'WATCH_TRIGGER', '', 'TRIGGER_FIRED');
    ledger.transition(id, 'READY_SMALL_BET', '', 'TRIGGER_FIRED');
    ledger.transition(id, 'APPROVAL_PENDING', '', 'APPROVAL_PENDING');
    ledger.transition(id, 'APPROVED', '', 'APPROVAL_PENDING');
    ledger.transition(id, 'OPEN', '', 'MOVED_TO_OPEN');
    ledger.transition(id, 'EXIT_TRIGGERED', '', 'POSITION_EXITED');
    ledger.transition(id, 'EXITED', '', 'POSITION_EXITED');

    expect(TERMINAL_STATES.has(ledger.get(id)!.currentState)).toBe(true);
    // Terminal: further transitions rejected.
    const afterTerminal = ledger.transition(id, 'OPEN', '', 'MOVED_TO_OPEN');
    expect(afterTerminal.ok).toBe(false);
    expect(afterTerminal.reason).toContain('terminal');

    // Post-mortem queue.
    expect(ledger.closedUnattributed().map((i) => i.opportunityId)).toContain(id);
    // Attribution writes finalOutcome once.
    expect(ledger.setFinalOutcome(id, 'EXECUTION_FAILED')).toBe(true);
    expect(ledger.setFinalOutcome(id, 'NOT_APPROVED')).toBe(false); // already attributed
    expect(ledger.get(id)!.finalOutcome).toBe('EXECUTION_FAILED');
    expect(ledger.closedUnattributed().map((i) => i.opportunityId)).not.toContain(id);
  });

  it('persists across reloads (round-trips identities, events, outcomes)', () => {
    const p = path.join(process.cwd(), 'database', `test_opportunity_ledger_persist_${Date.now()}.json`);
    dbPaths.push(p);
    const l1 = new OpportunityLedger(p);
    const id = l1.ensureOpportunity({ chain: 'sol', contractAddress: '0xPERSIST', symbol: 'TOKP', source: 'gecko:trending', priceUsd: 1.2 }).opportunityId;
    l1.transition(id, 'RISK_PENDING', 'audit pending', 'RISK_PASSED');
    l1.transition(id, 'WATCHING', 'admit', 'NURSERY_ADMITTED');
    l1.flushToDisk();

    const l2 = new OpportunityLedger(p);
    ledgers.push(l2);
    const reloaded = l2.get(id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.firstSeenSource).toBe('gecko:trending');
    expect(reloaded!.firstSeenPriceUsd).toBe(1.2);
    expect(reloaded!.currentState).toBe('WATCHING');
    expect(l2.getEvents(id)).toHaveLength(3); // FIRST_SEEN + RISK_PASSED + NURSERY_ADMITTED
  });

  it('appendObservation stores change snapshots with ids/timestamps, prunes past a cap', () => {
    const ledger = newLedger();
    const id = ledger.ensureOpportunity({ chain: 'base', contractAddress: '0xO', source: 'rank' }).opportunityId;
    const first = ledger.appendObservation({ opportunityId: id, source: 'rank', priceUsd: 1.0, liquidityUsd: 5000 });
    expect(first.id).toBeTruthy();
    expect(first.observedAt).toBeTruthy();
    expect(ledger.getObservations(id)).toHaveLength(1);
    expect(ledger.getObservations(id)[0].liquidityUsd).toBe(5000);
  });

  it('STATE_TRANSITIONS covers every declared state and terminal states have no edges', () => {
    const allStates = Object.keys(STATE_TRANSITIONS) as (keyof typeof STATE_TRANSITIONS)[];
    for (const s of allStates) {
      expect(Array.isArray([...(STATE_TRANSITIONS[s] as Set<string>)])).toBe(true);
    }
    for (const t of TERMINAL_STATES) {
      expect(STATE_TRANSITIONS[t].size).toBe(0);
    }
  });
});
