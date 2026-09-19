import { describe, it, expect, vi } from 'vitest';
import { RhFillTapeReader, type RpcBalanceProvider, type RawFillRow } from '../src/adapters/rh-fill-tape.js';

function makeReader(rows: RawFillRow[], labelHints = { '0xABC': 'smart_money' }) {
  const balanceCalls: number[] = [];
  const rpc: RpcBalanceProvider = {
    async getBalances(addresses, chainId) {
      balanceCalls.push(addresses.length);
      return addresses.map((address) => ({ address, balance: labelHints[address] ? 1_000 : 0 }));
    },
  };
  const fetchFills = vi.fn(async (tokenAddress: string) => rows);
  const reader = new RhFillTapeReader(rpc, fetchFills, { chainId: 4663, maxWindow: 2, ttlMs: 600_000, labelHints });
  return { reader, fetchFills, balanceCalls };
}

describe('RhFillTapeReader (Q04)', () => {
  it('returns a bounded, ordered fill window scoped to chain/address', async () => {
    const { reader } = makeReader([
      { wallet: '0xA', side: 'buy', amountUsd: 1000, timestamp: 100 },
      { wallet: '0xB', side: 'sell', amountUsd: 500, timestamp: 300 },
      { wallet: '0xC', side: 'buy', amountUsd: 700, timestamp: 200 },
    ]);
    const w = await reader.readFillTape('0xTOKEN');
    expect(w.chainId).toBe(4663);
    expect(w.tokenAddress).toBe('0xTOKEN');
    expect(w.entries.map((e) => e.timestamp)).toEqual([300, 200]); // bounded at 2, newest-first
    expect(w.truncated).toBe(true);
    // Chain mismatch is a fail-open unknown (never a cross-chain misread).
    const other = await reader.readFillTape('0xTOKEN2', 1);
    expect(other.failOpen).toBe(true);
    expect(other.entries).toEqual([]);
  });

  it('resolves wallets to labels and caches/dedupes concurrent lookups', async () => {
    const balanceCalls: number[] = [];
    const rpc: RpcBalanceProvider = {
      async getBalances(addresses) {
        balanceCalls.push(addresses.length);
        return addresses.map((address) => ({ address, balance: 500 }));
      },
    };
    const reader = new RhFillTapeReader(
      rpc,
      async () => [
        { wallet: '0xZZZ', side: 'buy', amountUsd: 1000, timestamp: 100 },
        { wallet: '0xZZZ', side: 'buy', amountUsd: 2000, timestamp: 200 },
      ],
      { chainId: 4663 }
    );
    // Two concurrent reads sharing the same wallet must trigger ONE in-flight RPC call.
    const [a, b] = await Promise.all([reader.readFillTape('T'), reader.readFillTape('T')]);
    expect(a.entries[0]!.wallet).toBe('0xZZZ');
    expect(b.entries[1]!.wallet).toBe('0xZZZ');
    expect(balanceCalls.length).toBe(1);
    // A second non-concurrent batch is served from the label cache.
    await reader.readFillTape('T');
    expect(balanceCalls.length).toBe(1);
  });

  it('a tape gap behaves fail-open (unknown, never a false confirmation)', async () => {
    const { reader } = makeReader([
      { wallet: '0xA', side: 'buy', amountUsd: 0, timestamp: 100 },
    ]);
    const w = await reader.readFillTape('T');
    expect(w.failOpen).toBe(true);
    expect(w.entries).toEqual([]);

    // A throwing RPC source also fails open.
    const broken = new RhFillTapeReader(
      { async getBalances() { throw new Error('rpc down'); } },
      async () => { throw new Error('tape gap'); },
      {}
    );
    const fw = await broken.readFillTape('T');
    expect(fw.failOpen).toBe(true);
    expect(fw.entries).toEqual([]);
  });
});
