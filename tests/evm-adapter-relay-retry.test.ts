import { describe, it, expect, vi, afterEach } from 'vitest';
import { EVMTradeAdapter } from '../src/adapters/evm-adapter.js';

function okQuoteBody() {
  return {
    amountOut: '1000000000000000000',
    steps: [{ items: [{ data: { to: '0xto', data: '0xdata', value: '0' } }] }],
    details: { currencyOut: { amount: '2000000000000000000' } },
  };
}

function makeWalletService() {
  return {
    hasWallet: () => true,
    getEvmAddress: () => '0xuser',
    getEvmWalletClient: () => ({ chain: null, sendTransaction: async () => '0xtx' }),
    getEvmAccount: () => '0xacct',
    getExplorerUrl: () => 'https://explorer',
  };
}

describe('EVMTradeAdapter relay quote (call-policy wiring)', () => {
  afterEach(() => {
    delete process.env.DRY_RUN;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retries a retryable 5xx relay quote via callWithRetry then succeeds', async () => {
    process.env.DRY_RUN = 'false';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'upstream boom' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => okQuoteBody() });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new EVMTradeAdapter();
    const result = await adapter.executeBuyToken(
      { chain: 'robinhood', tokenAddress: '0xtoken', amountEth: 1 },
      makeWalletService() as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.txHash).toBe('0xtx');
  });

  it('fails fast (no retry) on a non-retryable 4xx relay quote', async () => {
    process.env.DRY_RUN = 'false';
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new EVMTradeAdapter();
    const result = await adapter.executeBuyToken(
      { chain: 'robinhood', tokenAddress: '0xtoken', amountEth: 1 },
      makeWalletService() as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Relay Swap quote error');
  });
});
