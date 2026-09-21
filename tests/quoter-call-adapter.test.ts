import { describe, it, expect } from 'vitest';
import { EvmAdapter, type RpcHost, type RpcTransport } from '../src/adapters/evm-adapter.js';
import { evmAdapterToQuoterCall } from '../src/adapters/quoter-call-adapter.js';
import { assessSellability } from '../src/services/rh-execution-core.js';

function okTransport(result: unknown): RpcTransport {
  return { async request() { return { ok: true, result }; } };
}
function failingTransport(error: string): RpcTransport {
  return { async request() { return { ok: false, error }; } };
}

describe('quoter-call-adapter (PR 2 / Kernel E — Result<T,E> consumer)', () => {
  it('bridges Result<ok, Bytes> into the legacy QuoterCall contract', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a' }];
    const adapter = new EvmAdapter({ hosts, transport: okTransport('0xdeadbeef') });
    const quoter = evmAdapterToQuoterCall(adapter, { to: '0xquoter', chain: 'robinhood' });
    const res = await quoter.callContract('0xabcd');
    expect(res).toEqual({ ok: true, output: '0xdeadbeef' });
  });

  it('downgrades transport errors to { ok: false }', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a' }];
    const adapter = new EvmAdapter({ hosts, transport: failingTransport('RPC down') });
    const quoter = evmAdapterToQuoterCall(adapter, { to: '0xquoter', chain: 'robinhood' });
    const res = await quoter.callContract('0xabcd');
    expect(res).toEqual({ ok: false });
  });

  it('downgrades empty results to { ok: false } (assessSellability treats this as fail-closed)', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a' }];
    const adapter = new EvmAdapter({ hosts, transport: okTransport('') });
    const quoter = evmAdapterToQuoterCall(adapter, { to: '0xquoter', chain: 'robinhood' });
    const res = await quoter.callContract('0xabcd');
    expect(res).toEqual({ ok: false });
  });

  it('downgrades throttled (RATE_LIMIT) results to { ok: false }', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a' }];
    // capacity 1 -> first call ok, second call throttled (RATE_LIMIT).
    const adapter = new EvmAdapter({
      hosts,
      transport: okTransport('0xdata'),
      laneTokensPerSec: 0,
      readLaneCapacity: 1,
      submitLaneCapacity: 1,
    });
    const quoter = evmAdapterToQuoterCall(adapter, { to: '0xquoter', chain: 'robinhood' });
    expect((await quoter.callContract('0xabcd')).ok).toBe(true);
    expect((await quoter.callContract('0xabcd')).ok).toBe(false);
  });

  it('end-to-end: assessSellability uses the Result-bridged call and returns sellable=true on a real quote', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a' }];
    const adapter = new EvmAdapter({ hosts, transport: okTransport('0xfeedface') });
    const quoter = evmAdapterToQuoterCall(adapter, { to: '0xquoter', chain: 'robinhood' });
    const out = await assessSellability(quoter, '0xcalldata');
    expect(out).toEqual({ sellable: true, reason: 'confirmed on-chain liquidity' });
  });

  it('end-to-end: assessSellability returns fail-closed sellable=false on a transport error', async () => {
    const hosts: RpcHost[] = [{ url: 'http://a' }];
    const adapter = new EvmAdapter({ hosts, transport: failingTransport('boom') });
    const quoter = evmAdapterToQuoterCall(adapter, { to: '0xquoter', chain: 'robinhood' });
    const out = await assessSellability(quoter, '0xcalldata');
    expect(out.sellable).toBe(false);
    expect(out.reason).toMatch(/fail-closed/);
  });
});