import { describe, it, expect } from 'vitest';
import { DecisionLedger, type TradeProposal } from '../src/services/decision-ledger.js';

const baseProposal: TradeProposal = {
  agent: 'quant-a',
  nonce: 'n:1',
  symbol: 'MEME',
  chain: 'robinhood',
  side: 'BUY',
  sizeEth: 0.5,
  maxSizeEth: 1,
  confidence: 0.8,
  liquidityUsd: 10000,
};

describe('DecisionLedger.resultingWeight (FLYWHEEL six checks)', () => {
  it('returns six checks and full weight on all-pass', () => {
    const dl = new DecisionLedger();
    const r = dl.resultingWeight(baseProposal);
    expect(r.checks).toHaveLength(6);
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(r.weight).toBeCloseTo(0.8);
  });

  it('a size over the max fails closed with reason naming the check and weight 0', () => {
    const dl = new DecisionLedger();
    const r = dl.resultingWeight({ ...baseProposal, sizeEth: 3, maxSizeEth: 1 });
    expect(r.weight).toBe(0);
    expect(r.reason).toContain('size');
    const size = r.checks.find((c) => c.id === 'size')!;
    expect(size.passed).toBe(false);
    expect(size.observed).toBe(3);
    expect(size.limit).toBe(1);
  });

  it('low confidence, out-of-band liquidity and unsupported chain act as gates', () => {
    const dl = new DecisionLedger();
    const low = dl.resultingWeight({ ...baseProposal, confidence: 0.2 });
    expect(low.weight).toBe(0);
    expect(low.checks.find((c) => c.id === 'confidence')!.passed).toBe(false);

    const thin = dl.resultingWeight({ ...baseProposal, liquidityUsd: 5 });
    expect(thin.weight).toBe(0);
    expect(thin.checks.find((c) => c.id === 'liquidity_min')!.passed).toBe(false);

    const unsupported = dl.resultingWeight({ ...baseProposal, chain: 'solana' });
    expect(unsupported.weight).toBe(0);
    expect(unsupported.checks.find((c) => c.id === 'chain')!.passed).toBe(false);
  });
});

describe('DecisionLedger reservation + hash-locked receipt (tradingcodex)', () => {
  it('reserve is idempotent and refuses a nonce reused with a different payload', () => {
    const dl = new DecisionLedger();
    const order = { nonce: 'n1', payload: 'buy 100' };
    expect(dl.reserve(order).reserved).toBe(true);
    expect(dl.reserve(order).reserved).toBe(true);
    expect(dl.reserve({ nonce: 'n1', payload: 'buy 999' }).reserved).toBe(false);
  });

  it('a receipt whose payload hash does not match the reservation is rejected', () => {
    const dl = new DecisionLedger();
    dl.reserve({ nonce: 'n', payload: 'exact' });
    expect(dl.issueReceipt({ nonce: 'n', payload: 'tampered' }).valid).toBe(false);
    expect(dl.issueReceipt({ nonce: 'n', payload: 'exact' }).valid).toBe(true);
  });
});

describe('DecisionLedger reconcile-by-nonce (NERVE exactly-once)', () => {
  it('unknown nonce reconciles to unknown', () => {
    const dl = new DecisionLedger();
    expect(dl.reconcileByNonce('ghost')).toBe('unknown');
  });

  it('a settled send outcome cannot be flipped and is flagged as replaced', () => {
    const dl = new DecisionLedger();
    expect(dl.recordSend('n', 'confirmed').state).toBe('confirmed');
    const second = dl.recordSend('n', 'failed');
    expect(second.recorded).toBe(false);
    expect(second.state).toBe('replaced');
    expect(dl.reconcileByNonce('n')).toMatch(/confirmed|replaced/);
  });

  it('a completed nonce stays confirmed across reconcile calls', () => {
    const dl = new DecisionLedger();
    dl.recordSend('n', 'confirmed');
    expect(dl.reconcileByNonce('n')).toBe('confirmed');
    expect(dl.reconcileByNonce('n')).toBe('confirmed');
  });
});

describe('DecisionLedger propose/veto/audit (append-only) + persistence seam', () => {
  it('recordProposed and recordVeto append ordered events and persist to io', () => {
    const lines: string[] = [];
    const dl = new DecisionLedger({ io: { append: (l) => lines.push(l) } });
    dl.recordProposed(baseProposal);
    dl.recordVeto('liquidity too thin', { token: 'MEME' });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe('proposed');
    expect(JSON.parse(lines[1]).kind).toBe('veto');
    expect(dl.audit[0].seq).toBeLessThan(dl.audit[1].seq);
  });
});

describe('DecisionLedger grok fail-closed helpers', () => {
  it('vetoOnParseFailure refuses with an audit reason and appends a veto', () => {
    const dl = new DecisionLedger();
    const v = dl.vetoOnParseFailure('llm-a', 'not json');
    expect(v.veto).toBe(true);
    expect(v.reason).toContain('llm-a');
    expect(dl.audit.some((e) => e.kind === 'veto')).toBe(true);
  });

  it('pessimisticFallback holds when broken and buys when healthy', () => {
    const dl = new DecisionLedger();
    expect(dl.pessimisticFallback('llm-a', true)).toBe('HOLD');
    expect(dl.pessimisticFallback('llm-a', false)).toBe('BUY');
  });
});
