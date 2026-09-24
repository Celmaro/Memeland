import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OpportunityLedger } from '../src/services/opportunity-ledger.js';
import { OpportunityStrategist, type OpportunityStrategistConfig } from '../src/services/opportunity-strategist.js';

const dbPaths: string[] = [];
const ledgers: OpportunityLedger[] = [];

function newLedger(now?: () => Date): OpportunityLedger {
  const p = path.join(process.cwd(), 'database', `test_opportunity_strategist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const l = new OpportunityLedger(p, now);
  ledgers.push(l);
  return l;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const cfg: Partial<OpportunityStrategistConfig> = {
  minLiquidityUsdAdmit: 1000,
  minVolume24hUsdAdmit: 10_000,
  minLiquidityUsdAccelerate: 20_000,
  minVolume24hUsdAccelerate: 100_000,
  smartWalletsDoubleFactor: 2,
  smartFullCloseThreshold: 1,
  consensusThreshold: 80,
  reviewCadenceMs: HOUR_MS,
  expireAfterMs: 72 * HOUR_MS,
  maxScorePerCycle: 5,
};

function strategist(ledger: OpportunityLedger, overrides: Partial<OpportunityStrategistConfig> = {}): OpportunityStrategist {
  return new OpportunityStrategist(ledger, { ...cfg, ...overrides });
}

describe('OpportunityStrategist', () => {
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

  it('ingest creates a FIRST_SEEN identity and appends a change observation', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const identity = s.ingest({ chain: 'sol', contractAddress: '0xING', symbol: 'ING', source: 'gmgn:rank', liquidityUsd: 30_000, volume24hUsd: 200_000 });

    expect(identity.currentState).toBe('FIRST_SEEN');
    expect(ledger.getObservations(identity.opportunityId)).toHaveLength(1);
    expect(ledger.getObservations(identity.opportunityId)[0].liquidityUsd).toBe(30_000);
  });

  it('FIRST_SEEN that passes the prefilter is admitted to the nursery (WATCHING)', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'base', contractAddress: '0xADMIT', source: 'gmgn:hot', liquidityUsd: 30_000, volume24hUsd: 200_000 }).opportunityId;

    const cycle = s.decide(new Date('2026-09-19T00:00:00Z'));
    const dec = cycle.decisions.find((d) => d.opportunityId === id);
    expect(dec?.action).toBe('ADMIT_NURSERY');
    expect(ledger.get(id)?.currentState).toBe('WATCHING');
  });

  it('FIRST_SEEN that fails the prefilter is parked as RISK_REJECTED with a nextReviewAt', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'sol', contractAddress: '0xPARK', source: 'gmgn:hot', liquidityUsd: 200, volume24hUsd: 50 }).opportunityId;

    const cycle = s.decide(new Date('2026-09-19T00:00:00Z'));
    const dec = cycle.decisions.find((d) => d.opportunityId === id);
    expect(dec?.action).toBe('PARK');
    expect(dec?.reason).toContain('LIQUIDITY_REJECTED');
    expect(ledger.get(id)?.currentState).toBe('RISK_REJECTED');
    expect(ledger.get(id)?.nextReviewAt).toBeTruthy();
  });

  it('WATCHING with liquidity > 20k escalates to ACCELERATING', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'robinhood', contractAddress: '0xESC1', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 }).opportunityId;
    // Admit to nursery first.
    s.decide(new Date('2026-09-19T00:00:00Z'));
    expect(ledger.get(id)?.currentState).toBe('WATCHING');

    // Refresh with liquidity crossing 20k, then decide again — must escape throttle by stepping time past nextReviewAt.
    const now1 = new Date('2026-09-19T01:30:00Z');
    s.ingest({ chain: 'robinhood', contractAddress: '0xESC1', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 });
    const cycle = s.decide(now1);
    const dec = cycle.decisions.find((d) => d.opportunityId === id);
    expect(dec?.action).toBe('ESCALATE');
    expect(ledger.get(id)?.currentState).toBe('ACCELERATING');
  });

  it('WATCHING with vol24h > 100k or doubled smart-wallet buying escalates to ACCELERATING', () => {
    const ledger = newLedger();
    const s = strategist(ledger);

    // Volume-triggered escalation.
    const v = s.ingest({ chain: 'sol', contractAddress: '0xESC2', source: 'rank', liquidityUsd: 5000, volume24hUsd: 150_000 }).opportunityId;
    s.decide(new Date('2026-09-19T00:00:00Z'));
    expect(ledger.get(v)?.currentState).toBe('WATCHING');
    const vCycle = s.decide(new Date('2026-09-19T01:30:00Z'));
    expect(vCycle.decisions.find((d) => d.opportunityId === v)?.action).toBe('ESCALATE');

    // Doubled smart-wallet buying, small volume/liquidity, prior baseline of 1.
    const w = s.ingest({ chain: 'base', contractAddress: '0xESC3', source: 'rank', liquidityUsd: 5000, volume24hUsd: 20_000, smartWalletsBuying: 3 }).opportunityId;
    s.decide(new Date('2026-09-19T00:00:00Z')); // admits to WATCHING (baseline 3 stored)
    expect(ledger.get(w)?.currentState).toBe('WATCHING');
    // First decide(review) with same metrics -> no escalation (no doubling yet).
    expect(s.decide(new Date('2026-09-19T00:30:00Z')).decisions.find((d) => d.opportunityId === w)?.action).toBe('NONE');
    // Now smart buying doubles to 6 -> escalate.
    s.ingest({ chain: 'base', contractAddress: '0xESC3', source: 'rank', liquidityUsd: 5000, volume24hUsd: 20_000, smartWalletsBuying: 6 });
    const wCycle = s.decide(new Date('2026-09-19T01:30:00Z'));
    expect(wCycle.decisions.find((d) => d.opportunityId === w)?.action).toBe('ESCALATE');
    expect(ledger.get(w)?.currentState).toBe('ACCELERATING');
  });

  it('WATCHING is throttled until nextReviewAt (no re-evaluation on every cycle)', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'robinhood', contractAddress: '0xTHROT', source: 'rank', liquidityUsd: 5000, volume24hUsd: 20_000 }).opportunityId;
    s.decide(new Date('2026-09-19T00:00:00Z')); // WATCHING, park -> nextReviewAt ~01:00
    expect(ledger.get(id)?.currentState).toBe('WATCHING');

    // First review parks (no escalation at 5k liquidity), then within the cadence
    // liquidity crossing 20k must NOT escalate until the nextReviewAt deadline.
    expect(s.decide(new Date('2026-09-19T00:10:00Z')).decisions.find((d) => d.opportunityId === id)?.action).toBe('NONE');
    const parkAt = ledger.get(id)?.nextReviewAt;
    expect(parkAt).toBeTruthy();

    s.ingest({ chain: 'robinhood', contractAddress: '0xTHROT', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 });
    // Before the deadline: throttled, no escalation.
    const throttled = s.decide(new Date(new Date(parkAt!).getTime() - 1000));
    expect(throttled.decisions.find((d) => d.opportunityId === id)?.action).toBe('NONE');
    expect(ledger.get(id)?.currentState).toBe('WATCHING');
    // At/after the deadline: escalation fires.
    const due = s.decide(new Date(new Date(parkAt!).getTime() + 1000));
    expect(due.decisions.find((d) => d.opportunityId === id)?.action).toBe('ESCALATE');
  });

  it('ACCELERATING triggers to WATCH_TRIGGER on graduation, smart full-close, or price ATH', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'sol', contractAddress: '0xTRIG', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 }).opportunityId;
    s.decide(new Date('2026-09-19T00:00:00Z')); // WATCHING
    expect(s.decide(new Date('2026-09-19T01:30:00Z')).decisions.find((d) => d.opportunityId === id)?.action).toBe('ESCALATE');

    // Graduation fires the trigger.
    s.ingest({ chain: 'sol', contractAddress: '0xTRIG', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000, graduated: true });
    const cycle = s.decide(new Date('2026-09-19T03:00:00Z'));
    const trig = cycle.decisions.find((d) => d.opportunityId === id);
    expect(trig?.action).toBe('TRIGGER');
    expect(ledger.get(id)?.currentState).toBe('WATCH_TRIGGER');
  });

  it('WATCH_TRIGGER surfaces as a nextCandidate (SCORE) for the swarm, budget-capped', () => {
    const ledger = newLedger();
    const s = strategist(ledger, { maxScorePerCycle: 1 });
    for (let i = 0; i < 3; i++) {
      const addr = `0xSCORE${i}`;
      s.ingest({ chain: 'sol', contractAddress: addr, source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 });
      s.decide(new Date('2026-09-19T00:00:00Z')); // WATCHING
      s.decide(new Date('2026-09-19T01:30:00Z')); // ACCELERATING
      s.ingest({ chain: 'sol', contractAddress: addr, source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000, graduated: true });
      s.decide(new Date('2026-09-19T03:00:00Z')); // WATCH_TRIGGER
    }
    const cycle = s.decide(new Date('2026-09-19T04:00:00Z'));
    expect(cycle.nextCandidates).toHaveLength(1); // budge-capped at maxScorePerCycle
    expect(ledger.get(cycle.nextCandidates[0])?.currentState).toBe('WATCH_TRIGGER');
  });

  it('recordSwarmResult with consensus >= 80 moves to READY_SMALL_BET, else back to WATCHING', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const pass = s.ingest({ chain: 'robinhood', contractAddress: '0xPASS', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 }).opportunityId;
    const fail = s.ingest({ chain: 'robinhood', contractAddress: '0xFAIL', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 }).opportunityId;
    // Shared sequential pass: each decide() evaluates both identities together.
    s.decide(new Date('2026-09-19T00:00:00Z')); // both -> WATCHING
    s.decide(new Date('2026-09-19T01:30:00Z')); // both -> ACCELERATING
    s.ingest({ chain: 'robinhood', contractAddress: ledger.get(pass)!.contractAddress, source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000, graduated: true });
    s.ingest({ chain: 'robinhood', contractAddress: ledger.get(fail)!.contractAddress, source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000, graduated: true });
    s.decide(new Date('2026-09-19T03:00:00Z')); // both -> WATCH_TRIGGER
    expect(ledger.get(pass)?.currentState).toBe('WATCH_TRIGGER');
    expect(ledger.get(fail)?.currentState).toBe('WATCH_TRIGGER');

    s.recordSwarmResult(pass, 85);
    s.recordSwarmResult(fail, 40);
    expect(ledger.get(pass)?.currentState).toBe('READY_SMALL_BET');
    expect(ledger.get(fail)?.currentState).toBe('WATCHING');
    expect(ledger.get(fail)?.nextReviewAt).toBeTruthy(); // re-parked
  });

  it('READY_SMALL_BET opportunities surface as enqueue candidates and enqueue() moves to APPROVAL_PENDING', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'base', contractAddress: '0xENQ', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 }).opportunityId;
    s.decide(new Date('2026-09-19T00:00:00Z'));
    s.decide(new Date('2026-09-19T01:30:00Z'));
    s.ingest({ chain: 'base', contractAddress: '0xENQ', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000, graduated: true });
    s.decide(new Date('2026-09-19T03:00:00Z'));
    s.recordSwarmResult(id, 90);

    const cycle = s.decide(new Date('2026-09-19T04:00:00Z'));
    expect(cycle.enqueueCandidates).toContain(id);
    expect(s.enqueue(id)).toBe(true);
    expect(ledger.get(id)?.currentState).toBe('APPROVAL_PENDING');
  });

  it('RISK_REJECTED opportunities are re-admitted to WATCHING when metrics recover', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'sol', contractAddress: '0xRE', source: 'rank', liquidityUsd: 200, volume24hUsd: 50 }).opportunityId;
    s.decide(new Date('2026-09-19T00:00:00Z'));
    expect(ledger.get(id)?.currentState).toBe('RISK_REJECTED');

    // Recovered after the parking cadence.
    s.ingest({ chain: 'sol', contractAddress: '0xRE', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 150_000 });
    const cycle = s.decide(new Date('2026-09-19T02:00:00Z'));
    expect(cycle.decisions.find((d) => d.opportunityId === id)?.action).toBe('RE_ADMIT');
    expect(ledger.get(id)?.currentState).toBe('WATCHING');
    expect(ledger.get(id)?.nextReviewAt).toBeUndefined();
  });

  it('persists nextReviewAt across ledger reloads', () => {
    const p = path.join(process.cwd(), 'database', `test_strategist_persist_${Date.now()}.json`);
    dbPaths.push(p);
    const l1 = new OpportunityLedger(p);
    ledgers.push(l1);
    const s1 = strategist(l1);
    const id = s1.ingest({ chain: 'sol', contractAddress: '0xPRST', source: 'rank', liquidityUsd: 200, volume24hUsd: 50 }).opportunityId;
    s1.decide(new Date('2026-09-19T00:00:00Z'));
    const parkedAt = l1.get(id)!.nextReviewAt;
    l1.flushToDisk();

    const l2 = new OpportunityLedger(p);
    ledgers.push(l2);
    expect(l2.get(id)?.currentState).toBe('RISK_REJECTED');
    expect(l2.get(id)?.nextReviewAt).toBe(parkedAt);
  });

  it('parked RISK_REJECTED opportunities expire after the expiry window', () => {
    // Fixed clock so firstSeenAt (stamped on ingest) aligns with the injected
    // decide() dates — the ledger's real clock made this drift with wall time.
    const T0 = new Date('2026-09-19T00:00:00Z');
    const ledger = newLedger(() => T0);
    const s = strategist(ledger, { expireAfterMs: DAY_MS });
    const id = s.ingest({ chain: 'sol', contractAddress: '0xEXP', source: 'rank', liquidityUsd: 200, volume24hUsd: 50 }).opportunityId;
    s.decide(T0); // RISK_REJECTED
    expect(ledger.get(id)?.currentState).toBe('RISK_REJECTED');

    // Well past the 1-day expiry, still not recovered.
    const cycle = s.decide(new Date('2026-09-25T00:00:00Z'));
    expect(cycle.decisions.find((d) => d.opportunityId === id)?.action).toBe('EXPIRE');
    expect(ledger.get(id)?.currentState).toBe('EXPIRED');
  });

  it('recordDispatch walks a gate-passed FIRST_SEEN opportunity to APPROVAL_PENDING', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'robinhood', contractAddress: '0xDIS', source: 'swarm:gate', liquidityUsd: 30_000, volume24hUsd: 20_000 }).opportunityId;

    expect(ledger.get(id)?.currentState).toBe('FIRST_SEEN');
    const finalState = s.recordDispatch(id, 88);
    expect(finalState).toBe('APPROVAL_PENDING');
    expect(ledger.get(id)?.currentState).toBe('APPROVAL_PENDING');
    // Valid edges walked: RISK_PENDING -> WATCHING -> ACCELERATING -> WATCH_TRIGGER -> READY_SMALL_BET -> APPROVAL_PENDING.
    const events = ledger.getEvents(id);
    expect(events.map((e) => e.to)).toContain('APPROVAL_PENDING');
  });

  it('recordDispatch no-ops on consensus failure, unknown ids, and already-advanced states', () => {
    const ledger = newLedger();
    const s = strategist(ledger);
    const id = s.ingest({ chain: 'sol', contractAddress: '0xDNO', source: 'rank', liquidityUsd: 30_000, volume24hUsd: 20_000 }).opportunityId;

    // Consensus below threshold: stays FIRST_SEEN.
    expect(s.recordDispatch(id, 40)).toBeNull();
    expect(ledger.get(id)?.currentState).toBe('FIRST_SEEN');
    // Unknown id: null.
    expect(s.recordDispatch('nope:0xZZZ', 90)).toBeNull();
    // Already advanced: returns current state unchanged.
    s.recordDispatch(id, 90); // -> APPROVAL_PENDING
    expect(s.recordDispatch(id, 95)).toBe('APPROVAL_PENDING');
    expect(ledger.get(id)?.currentState).toBe('APPROVAL_PENDING');
  });
});
