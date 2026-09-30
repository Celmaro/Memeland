/**
 * P1 — handoff/threshold/domain alignment.
 *
 * 1.1 double-80: the agent prefilter and the swarm quorum were BOTH 80 on two
 *     different scales, so a candidate had to clear the heuristic AND the
 *     weighted voter average at 80 — collapsing the joint pass rate.
 * 1.2 multichain AUTO domains: the cycle derives `meme-${chain}`, which never
 *     normalized to the domain the operator actually toggles, so every
 *     non-robinhood chain silently reported AUTO disabled.
 * 1.3 strategist re-feed: enqueueCandidates were computed then discarded.
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import { normalizeDomainKey } from '../src/orchestrator/agent-registry.js';
import { CONSENSUS_FLOOR } from '../src/orchestrator/swarm-guards.js';
import { ScreeningAgent } from '../src/agents/meme-robinhood/robinhood-screening-agent.js';
import { OpportunityLedger } from '../src/services/opportunity-ledger.js';
import { OpportunityStrategist } from '../src/services/opportunity-strategist.js';

const dbPaths: string[] = [];
const mkLedger = (): OpportunityLedger => {
  const p = path.join(process.cwd(), 'database', `test_phase1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  return new OpportunityLedger(p);
};
const dbPath = mkLedger();
const dbPath2 = mkLedger();
const dbPath3 = mkLedger();

afterAll(() => {
  for (const p of dbPaths) { try { require('fs').unlinkSync(p); } catch { /* already gone */ } }
});

describe('P1.2 multichain AUTO domain normalization', () => {
  it('normalizes every per-chain AUTO domain the screening cycle derives', () => {
    // screening-cycle builds `meme-${signalChainKey}`. If any of these miss the
    // registry, hub.isAutoExecuteEnabled() returns {enabled:false} and the
    // chain can never auto-execute regardless of the operator's setting.
    for (const chain of ['sol', 'bsc', 'base', 'eth', 'robinhood']) {
      expect(normalizeDomainKey(`meme-${chain}`)).toBe('meme-robinhood');
    }
  });

  it('still resolves the bare and legacy aliases', () => {
    for (const alias of ['robinhood', 'meme', 'sol', 'solana', 'base', 'bsc', 'eth', 'ethereum', 'evm']) {
      expect(normalizeDomainKey(alias)).toBe('meme-robinhood');
    }
  });

  it('does not capture unrelated domains', () => {
    // A control: the alias list must not turn every string into the meme domain.
    expect(normalizeDomainKey('alpha-robinhood')).toBe('alpha-robinhood');
  });
});

describe('P1.1 prefilter vs authoritative swarm floor', () => {
  it('sets the prefilter strictly below the swarm quorum floor', () => {
    const agent = new ScreeningAgent();
    const prefilter = agent.getConfig().passThreshold;
    const swarmFloor = Math.round(CONSENSUS_FLOOR * 100);
    // The whole point: the prefilter admits candidates for the swarm to judge.
    // If it reached the swarm floor, the double-gate bug would be back.
    expect(prefilter).toBeLessThan(swarmFloor);
  });

  it('keeps the prefilter high enough to still reject noise', () => {
    // Lowering the prefilter must not turn the funnel into a firehose.
    const agent = new ScreeningAgent();
    expect(agent.getConfig().passThreshold).toBeGreaterThanOrEqual(50);
  });
});

describe('P1.3 strategist re-feed resolution', () => {
  it('fails closed for an unknown opportunity id', () => {
    // A missing opportunity must never produce an enqueue — the re-feed would
    // otherwise be able to admit a token with no verified identity.
    const ledger = new OpportunityLedger(dbPath);
    const strategist = new OpportunityStrategist(ledger);
    expect(strategist.resolveForEnqueue('does-not-exist')).toBeNull();
  });

  it('refuses to re-feed an opportunity that is not READY_SMALL_BET', () => {
    // The re-feed is only valid for a fully escalated opportunity. A FIRST_SEEN
    // or already-APPROVED one must not be re-enqueued (double-fire).
    const ledger = new OpportunityLedger(dbPath2);
    const strategist = new OpportunityStrategist(ledger);
    const id = ledger.ensureOpportunity({
      chain: 'sol', contractAddress: '0xABC', symbol: 'ABC', priceUsd: 1.0,
    } as any).opportunityId;
    expect(strategist.resolveForEnqueue(id)).toBeNull();
  });

  it('resolves a READY_SMALL_BET opportunity into approval-ladder fields', () => {
    const ledger = new OpportunityLedger(dbPath3);
    const strategist = new OpportunityStrategist(ledger);
    const identity = ledger.ensureOpportunity({
      chain: 'bsc', contractAddress: '0xDEF', symbol: 'DEF', priceUsd: 2.5,
    } as any);
    // Drive it to READY_SMALL_BET along the real state machine.
    for (const to of ['RISK_PENDING', 'WATCHING', 'ACCELERATING', 'WATCH_TRIGGER', 'READY_SMALL_BET'] as const) {
      ledger.transition(identity.opportunityId, to, 'test', 'TEST');
    }
    const resolved = strategist.resolveForEnqueue(identity.opportunityId);
    expect(resolved).not.toBeNull();
    expect(resolved!.contractAddress).toBe('0xDEF');
    expect(resolved!.chain).toBe('bsc');
    expect(resolved!.symbol).toBe('DEF');
  });
});
