import { describe, it, expect } from 'vitest';
import { RpcVerify } from './rpc-verify.js';

function receiptBody(status: string, overrides: Record<string, unknown> = {}) {
  return {
    status,
    blockNumber: '0x10',
    from: '0xabc',
    to: '0xdef',
    logs: [],
    ...overrides,
  };
}

describe('RpcVerify — independent on-chain verify over the failover pool', () => {
  it('confirms a successful mined transaction (receipt.status === 0x1)', async () => {
    const verify = new RpcVerify({
      getActiveRPC: () => 'https://rpc.example/rh',
      fetch: async () => ({ ok: true, json: async () => ({ result: receiptBody('0x1') }) }),
    });
    const receipt = await verify.getTransactionReceipt('rh', '0x' + 'a'.repeat(64));
    expect(receipt?.confirmed).toBe(true);
    expect(receipt?.status).toBe(true);
    expect(receipt?.blockNumber).toBe(16);
    expect(await verify.confirmSuccess('rh', '0x' + 'a'.repeat(64))).toBe(true);
  });

  it('flags a reverted transaction (status 0x0) as NOT a success', async () => {
    const verify = new RpcVerify({
      getActiveRPC: () => 'https://rpc.example/rh',
      fetch: async () => ({ ok: true, json: async () => ({ result: receiptBody('0x0') }) }),
    });
    expect(await verify.confirmSuccess('rh', '0x' + 'a'.repeat(64))).toBe(false);
  });

  it('returns null (fail-soft) when the receipt is absent (not mined)', async () => {
    const verify = new RpcVerify({
      getActiveRPC: () => 'https://rpc.example/rh',
      fetch: async () => ({ ok: true, json: async () => ({ result: null }) }),
    });
    expect(await verify.getTransactionReceipt('rh', '0x' + 'a'.repeat(64))).toBeNull();
  });

  it('returns null on transport error — never a false confirmation', async () => {
    const verify = new RpcVerify({
      getActiveRPC: () => 'https://rpc.example/rh',
      fetch: async () => {
        throw new Error('network');
      },
    });
    expect(await verify.getTransactionReceipt('rh', '0x' + 'a'.repeat(64))).toBeNull();
    expect(await verify.confirmSuccess('rh', '0x' + 'a'.repeat(64))).toBe(false);
  });

  it('returns null when no active RPC or invalid tx hash', async () => {
    const noRpc = new RpcVerify({ getActiveRPC: () => '' });
    expect(await noRpc.getTransactionReceipt('rh', '0x' + 'a'.repeat(64))).toBeNull();
    const invalidHash = new RpcVerify({ getActiveRPC: () => 'https://rpc.example' });
    expect(await invalidHash.getTransactionReceipt('rh', '0xZZZ')).toBeNull();
  });
});
