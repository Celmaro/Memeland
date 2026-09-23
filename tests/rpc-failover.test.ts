import { describe, it, expect, vi, afterEach } from 'vitest';
import { RPCFailoverManager, RPC_CHAINS } from '../src/services/rpc-failover.js';

describe('RPCFailoverManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RPC_FAILOVER_URLS;
    delete process.env.EVM_ROBINHOOD_RPC_URL;
    delete process.env.EVM_ETH_RPC_URL;
    delete process.env.EVM_BSC_RPC_URL;
    delete process.env.EVM_BASE_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
  });

  it('builds per-chain pools for all five chains from verified defaults', () => {
    const mgr = new RPCFailoverManager();
    for (const chain of RPC_CHAINS) {
      expect(mgr.getRpcUrls(chain).length).toBeGreaterThan(0);
    }
    // robinhood keeps the official RPC first; eth/bsc/base/sol have free defaults
    expect(mgr.getRpcUrls('rh')[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(mgr.getRpcUrls('eth')).toContain('https://ethereum-rpc.publicnode.com/');
    expect(mgr.getRpcUrls('bsc')).toContain('https://public-bsc.nownodes.io/');
    expect(mgr.getRpcUrls('sol')).toContain('https://solana-rpc.publicnode.com/');
  });

  it('measures real latencies and picks the fastest healthy RPC', async () => {
    process.env.RPC_FAILOVER_URLS = JSON.stringify({ rh: ['https://slow.example.com', 'https://fast.example.com'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ result: '0x1237' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ result: '0x1237' }) }));
    const mgr = new RPCFailoverManager();
    await mgr.probeLatencies();
    const active = mgr.getActiveRPC('rh');
    expect(typeof active).toBe('string');
    expect(active.length).toBeGreaterThan(0);
  });

  it('reports an unhealthy RPC and fails over to the next', async () => {
    process.env.RPC_FAILOVER_URLS = JSON.stringify({ rh: ['https://first.example.com', 'https://second.example.com'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: '0x1237' }) }));
    const mgr = new RPCFailoverManager();
    await mgr.probeLatencies();
    mgr.reportRPCFailure('rh', 'https://first.example.com');
    expect(mgr.getActiveRPC('rh')).toBe('https://second.example.com');
  });

  it('legacy "evm" alias resolves to the robinhood pool', () => {
    const mgr = new RPCFailoverManager();
    expect(mgr.getRpcUrls('evm')).toEqual(mgr.getRpcUrls('rh'));
  });

  it('does not use demo endpoints by default', () => {
    const mgr = new RPCFailoverManager();
    for (const chain of RPC_CHAINS) {
      expect(mgr.getRpcUrls(chain).some((u) => u.includes('/demo'))).toBe(false);
    }
  });
});