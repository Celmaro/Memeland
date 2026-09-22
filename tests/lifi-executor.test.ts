import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifiExecutor } from '../src/adapters/lifi-executor.js';

const { mockSendTransaction, mockCreateWalletClient } = vi.hoisted(() => {
  const mockSendTransaction = vi.fn();
  const mockCreateWalletClient = vi.fn(() => ({
    chain: { id: 0 },
    sendTransaction: mockSendTransaction,
  }));
  return { mockSendTransaction, mockCreateWalletClient };
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: mockCreateWalletClient,
    http: () => ({}),
  };
});

vi.mock('viem/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/chains')>();
  return {
    ...actual,
    mainnet: { id: 1 },
    bsc: { id: 56 },
    base: { id: 8453 },
    robinhood: { id: 4663 },
  };
});

const FAKE_KEY = `0x${'1'.repeat(64)}`;
const DEFAULT_TX = { to: '0xpool', data: '0xabc', value: '0' };

function mockLifiFetch(routes: {
  quoteId?: string | false;
  buildTx?: Record<string, unknown>;
  status?: { status?: string; txHash?: string };
} = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/quote')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [{ id: routes.quoteId === false ? undefined : routes.quoteId ?? 'r1', toAmount: '1000000' }],
        }),
      } as unknown as Response;
    }
    if (u.includes('/build-transaction')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ transactionRequest: routes.buildTx ?? DEFAULT_TX }),
      } as unknown as Response;
    }
    if (u.includes('/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: routes.status?.status ?? 'DONE',
          txHash: routes.status?.txHash ?? '0xdone',
        }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function makeExecutor(overrides: { dryRun: boolean; now?: number; fetchImpl?: typeof fetch }) {
  return new LifiExecutor({
    dryRun: overrides.dryRun,
    now: () => overrides.now ?? 1000,
    fetchImpl: overrides.fetchImpl,
    evmPrivateKey: FAKE_KEY,
    solanaPrivateKey: '',
    integrator: 'test',
    requestSpacingMs: 0,
    executionTimeoutMs: 1000,
  });
}

describe('LifiExecutor (LI.FI / Jumper — only execution layer)', () => {
  beforeEach(() => {
    mockSendTransaction.mockReset();
    mockSendTransaction.mockResolvedValue('0xtxhash');
    mockCreateWalletClient.mockClear();
  });

  afterEach(() => {
    delete process.env.EXECUTION_FUNDING_TOKEN_ROBINHOOD;
    delete process.env.EXECUTION_FUNDING_TOKEN_ETH;
    delete process.env.EXECUTION_FUNDING_TOKEN_BSC;
    delete process.env.EXECUTION_FUNDING_TOKEN_BASE;
    delete process.env.EXECUTION_FUNDING_TOKEN_SOL;
    vi.restoreAllMocks();
  });

  it('DRY_RUN quotes + builds a real transaction but never broadcasts (simulated)', async () => {
    const { fetchImpl, calls } = mockLifiFetch();
    const ex = makeExecutor({ dryRun: true, now: 1000, fetchImpl });
    const res = await ex.submit({ chain: 'robinhood', token: '0xTOKEN', side: 'buy', amountUsd: 100 });

    expect(res.outcome).toBe('simulated');
    expect(res.simulated).toBe(true);
    expect(calls.some((u) => u.includes('/quote'))).toBe(true);
    expect(calls.some((u) => u.includes('/build-transaction'))).toBe(true);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('live EVM path signs via viem and polls status to a confirmed fill', async () => {
    const { fetchImpl, calls } = mockLifiFetch({ status: { status: 'DONE', txHash: '0xdone' } });
    const ex = makeExecutor({ dryRun: false, now: 1000, fetchImpl });

    const res = await ex.submit({ chain: 'robinhood', token: '0xTOKEN', side: 'buy', amountUsd: 100 });

    expect(res.outcome).toBe('confirmed');
    expect(res.txHash).toBe('0xdone');
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(mockSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xpool', data: '0xabc', value: 0n })
    );
    expect(calls.some((u) => u.includes('/status'))).toBe(true);
  });

  it('does not broadcast the same nonce twice (idempotent guard)', async () => {
    const { fetchImpl } = mockLifiFetch({ status: { status: 'DONE' } });
    const ex = makeExecutor({ dryRun: false, now: 1000, fetchImpl });

    const first = await ex.submit({ chain: 'robinhood', token: '0xTOKEN', side: 'buy', amountUsd: 100 });
    const second = await ex.submit({ chain: 'robinhood', token: '0xTOKEN', side: 'buy', amountUsd: 100 });

    expect(first.outcome).toBe('confirmed');
    expect(second.outcome).toBe('failed');
    expect(second.reason).toMatch(/already broadcast/);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports a FAILED status receipt as a failed fill', async () => {
    const { fetchImpl } = mockLifiFetch({ status: { status: 'FAILED' } });
    const ex = makeExecutor({ dryRun: false, now: 1000, fetchImpl });
    const res = await ex.submit({ chain: 'robinhood', token: '0xTOKEN', side: 'buy', amountUsd: 100 });
    expect(res.outcome).toBe('failed');
    expect(res.reason).toMatch(/FAILED/);
  });

  it('times out the fill when no route id is returned (no receipt to poll)', async () => {
    const { fetchImpl } = mockLifiFetch({ quoteId: false });
    const ex = makeExecutor({ dryRun: false, now: 1000, fetchImpl });
    const res = await ex.submit({ chain: 'robinhood', token: '0xTOKEN', side: 'buy', amountUsd: 100 });
    expect(res.outcome).toBe('timed_out');
    expect(res.txHash).toBe('0xtxhash');
  });

  it('fails closed for an unsupported side and an unknown chain', async () => {
    const { fetchImpl } = mockLifiFetch();
    const ex = makeExecutor({ dryRun: false, fetchImpl });
    const sell = await ex.submit({ chain: 'robinhood', token: '0xTOKEN', side: 'sell', amountUsd: 100 });
    expect(sell.outcome).toBe('failed');
    expect(sell.reason).toMatch(/side 'sell' not supported/);

    const unknown = await ex.submit({ chain: 'aptos', token: '0xTOKEN', side: 'buy', amountUsd: 100 });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.reason).toMatch(/unknown chain/);
  });

  it('dry-run Solana submit quotes without broadcasting', async () => {
    const { fetchImpl, calls } = mockLifiFetch();
    const ex = makeExecutor({ dryRun: true, now: 1000, fetchImpl });
    const res = await ex.submit({ chain: 'sol', token: 'mintaddr', side: 'buy', amountUsd: 50 });
    expect(res.outcome).toBe('simulated');
    expect(calls.some((u) => u.includes('/quote'))).toBe(true);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('resolves token meta for native, addresses, and known stables; throws on unknown symbols', () => {
    const ex = makeExecutor({ dryRun: true });
    const anyEx = ex as unknown as {
      resolveAnyTokenMeta(chain: string, s: string): { address: string; decimals: number };
    };
    expect(anyEx.resolveAnyTokenMeta('eth', 'ETH').address).toMatch(/^0x0+$/);
    expect(anyEx.resolveAnyTokenMeta('sol', 'SOL').address.length).toBeGreaterThan(30);
    expect(anyEx.resolveAnyTokenMeta('eth', 'USDC').address.toLowerCase()).toMatch(/^0xa0b86991/);
    const addr = `0x${'a'.repeat(40)}`;
    expect(anyEx.resolveAnyTokenMeta('base', addr).address).toBe(addr);
    expect(() => anyEx.resolveAnyTokenMeta('eth', 'FOO')).toThrow(/no funding token 'FOO'/);
  });
});
