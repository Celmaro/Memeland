import { describe, it, expect, vi } from 'vitest';
import { WalletBalanceReader, DEFAULT_BALANCE_CHAIN_ID } from '../src/services/wallet-balance-reader.js';
import type { BalanceResult } from '../src/services/wallet-service.js';

function mockWallet(overrides: Partial<{ balance: BalanceResult | null; calls: number[] }> = {}) {
  const calls: number[] = [];
  const impl = vi.fn(async (chainId: number): Promise<BalanceResult | null> => {
    calls.push(chainId);
    return 'balance' in overrides
      ? overrides.balance ?? null
      : { balance: 1.5, symbol: 'ETH', chain: 'Robinhood Chain', simulated: false };
  });
  return { getEvmBalance: impl, calls };
}

describe('KC7 / Kernel R — WalletBalanceReader', () => {
  it('defaults to Robinhood Chain id 4663', () => {
    expect(DEFAULT_BALANCE_CHAIN_ID).toBe(4663);
  });

  it('getEvmBalance() uses the default chain when no arg passed', async () => {
    const w = mockWallet();
    const reader = new WalletBalanceReader(w);
    const bal = await reader.getEvmBalance();
    expect(w.calls).toEqual([4663]);
    expect(bal).toEqual({ balance: 1.5, symbol: 'ETH', chain: 'Robinhood Chain', simulated: false });
  });

  it('getEvmBalance(chainId) overrides the default', async () => {
    const w = mockWallet();
    const reader = new WalletBalanceReader(w);
    await reader.getEvmBalance(8453);
    expect(w.calls).toEqual([8453]);
  });

  it('custom default chain id is honored', async () => {
    const w = mockWallet();
    const reader = new WalletBalanceReader(w, 56);
    await reader.getEvmBalance();
    expect(w.calls).toEqual([56]);
  });

  it('returns null when the wallet read fails', async () => {
    const w = mockWallet({ balance: null });
    const reader = new WalletBalanceReader(w);
    expect(await reader.getEvmBalance()).toBeNull();
  });

  it('getEthEquivalentUsd returns balance × price when both available', async () => {
    const w = mockWallet({ balance: { balance: 2, symbol: 'ETH', chain: 'Robinhood Chain', simulated: false } });
    const reader = new WalletBalanceReader(w);
    expect(await reader.getEthEquivalentUsd(3000)).toBe(6000);
  });

  it('getEthEquivalentUsd returns null when price is null (fail-open)', async () => {
    const w = mockWallet({ balance: null });
    const reader = new WalletBalanceReader(w);
    expect(await reader.getEthEquivalentUsd(null)).toBeNull();
    expect(w.calls).toEqual([]); // no wallet read attempted when price absent
  });

  it('getEthEquivalentUsd returns null when balance read fails', async () => {
    const w = mockWallet({ balance: null });
    const reader = new WalletBalanceReader(w);
    expect(await reader.getEthEquivalentUsd(3000)).toBeNull();
  });
});