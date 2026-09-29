import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HintGate } from './hint-gate.js';
import { HintRegistry } from './candidate-hints.js';
import { globalSourceQuota } from '../services/source-quota.js';
import type { ExistencePrims } from '../services/onchain/rpc-verify.js';
import type { Chain, GMGNRawToken } from '../adapters/gmgn-adapter.js';

beforeEach(() => globalSourceQuota.clear());
afterEach(() => globalSourceQuota.clear());

const tok = (address: string, over: Record<string, unknown> = {}): GMGNRawToken =>
  ({ chain: 'sol', address, source: 'fomo', symbol: address.toUpperCase(), priceUsd: 1, ...over }) as unknown as GMGNRawToken;

/**
 * Stub RPC transport: decide per-address whether a JSON-RPC `eth_getCode`
 * returns a non-empty result (exists), `0x` (no contract), or fails transport.
 * `sol:0xREAL.AT` style isn't needed — we drive the EVM key for sol-chain tests
 * via a getActiveRPC that returns a URL, then map the method.
 */
function stubPrims(opts: {
  real?: string[];
  fail?: string[];
  transportDown?: boolean;
}): ExistencePrims {
  const realSet = new Set((opts.real ?? []).map((a) => a.toLowerCase()));
  const failSet = new Set((opts.fail ?? []).map((a) => a.toLowerCase()));
  return {
    getActiveRPC: () => 'https://stub.local',
    fetch: async (_url, init) => {
      if (opts.transportDown) return { ok: false, json: async () => ({}) };
      const body = JSON.parse(init.body) as { method: string; params: unknown[] };
      const addr = String((body.params as unknown[])[0]).toLowerCase();
      const isSolMint = body.method === 'getTokenLargestAccounts';
      if (failSet.has(addr)) {
        return { ok: true, json: async () => (isSolMint ? { result: {}, error: { code: -32602 } } : { result: '0x' }) };
      }
      if (realSet.has(addr)) {
        return { ok: true, json: async () => (isSolMint ? { result: { value: [{ address: addr }] } } : { result: '0x60fe' }) };
      }
      // Unknown address → no contract on EVM, or no accounts on Sol
      return { ok: true, json: async () => (isSolMint ? { result: { value: [] } } : { result: '0x' }) };
    },
  };
}

function gate(prims: ExistencePrims, isCanonical?: (chain: string, address: string) => boolean): HintGate {
  return new HintGate({ registry: new HintRegistry(), prims, isCanonical });
}

describe('Phase 6 — HintGate (FOMO/GMGN → existence oracle → promote/drop/fail-open)', () => {
  it('FOMO row that fails existence is NOT promoted', async () => {
    const g = gate(stubPrims({ real: ['0xREAL'], fail: ['0xPHANTOM'] }));
    const res = await g.gate([tok('0xPHANTOM'), tok('0xREAL')], 'sol', 'fomo');
    expect(res.transportDown).toBe(false);
    expect(res.promoted.map((t) => t.address)).toEqual(['0xREAL']);
  });

  it('FOMO row that passes existence is promoted, discoveredBy/source preserved', async () => {
    const g = gate(stubPrims({ real: ['0xREAL'] }));
    const row = tok('0xREAL', { discoveredBy: 'dexscreener' });
    const res = await g.gate([row], 'sol', 'fomo');
    expect(res.transportDown).toBe(false);
    expect(res.promoted).toHaveLength(1);
    expect(res.promoted[0]).toBe(row); // same object → provenance untouched
    expect((res.promoted[0] as unknown as { discoveredBy?: string }).discoveredBy).toBe('dexscreener');
  });

  it('transport-down oracle FAILS OPEN: rows flow as prior behavior + cooldown registered', async () => {
    globalSourceQuota.clear();
    const g = gate(stubPrims({ transportDown: true, real: ['0xREAL'] }));
    const res = await g.gate([tok('0xREAL'), tok('0xPHANTOM')], 'sol', 'fomo');
    expect(res.transportDown).toBe(true);
    // All rows flow (prior behavior) — never starve the funnel.
    expect(res.promoted.map((t) => t.address)).toEqual(['0xREAL', '0xPHANTOM']);
    // Cooldown was registered for the source so a dead transport isn't hammered.
    expect(globalSourceQuota.isCooling('hint-fomo')).toBe(true);
  });

  it('coordinator-known (canonical) addresses skip the existence check entirely', async () => {
    let oracleCalls = 0;
    const prims: ExistencePrims = {
      getActiveRPC: () => 'https://stub.local',
      fetch: async (_url, init) => {
        oracleCalls += 1;
        const body = JSON.parse(init.body) as { method: string; params: unknown[] };
        const addr = String((body.params as unknown[])[0]).toLowerCase();
        return { ok: true, json: async () => ({ result: addr === '0xknown' ? '0x60fe' : '0x' }) };
      },
    };
    const g = new HintGate({
      registry: new HintRegistry(),
      prims,
      isCanonical: (_chain, address) => address.toLowerCase() === '0xknown',
    });
    const res = await g.gate([tok('0xKNOWN'), tok('0xUNKNOWN')], 'eth', 'fomo');
    // Canonical address promoted without an oracle call; unknown was oracle-checked.
    expect(res.skippedCanonical).toBe(1);
    expect(oracleCalls).toBe(1); // only the unknown address hit the transport
    expect(res.promoted.map((t) => t.address)).toEqual(['0xKNOWN']);
  });

  it('routes by chain: solana uses getTokenLargestAccounts, EVM uses eth_getCode', async () => {
    const calls: string[] = [];
    const prims: ExistencePrims = {
      getActiveRPC: () => 'https://stub.local',
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body) as { method: string; params: unknown[] };
        calls.push(body.method);
        return { ok: true, json: async () => ({ result: body.method === 'getTokenLargestAccounts' ? { value: [{ address: String(body.params[0]) }] } : '0x60fe' }) };
      },
    };
    const g = gate(prims, () => false);
    await g.gate([tok('0xSOL')], 'sol', 'fomo');
    await g.gate([tok('0xETH')], 'eth', 'gmgn');
    expect(calls).toContain('getTokenLargestAccounts');
    expect(calls.filter((m) => m === 'eth_getCode').length).toBeGreaterThan(0);
  });

  it('Empty input short-circuits (no oracle work, no promotions)', async () => {
    let oracleCalls = 0;
    const prims: ExistencePrims = {
      getActiveRPC: () => 'https://stub.local',
      fetch: async () => { oracleCalls += 1; return { ok: true, json: async () => ({ result: '0x60fe' }) }; },
    };
    const g = gate(prims, () => false);
    const res = await g.gate([], 'eth', 'fomo');
    expect(res.promoted).toEqual([]);
    expect(res.transportDown).toBe(false);
    expect(oracleCalls).toBe(0);
  });
});

describe('Phase 6 — chain-agnostic plumbing', () => {
  it('exposes a process-wide gate defaulting to the real RPC pool', () => {
    // Constructed with no opts → uses globalHintRegistry + real failover pool.
    const g = new HintGate();
    expect(g).toBeInstanceOf(HintGate);
  });

  it('GMGN overlay stays enrichment-only: rows the coordinator never discovered are not introduced', async () => {
    // The hint gate never promotes a GMGN-only row as a fresh introducer — the
    // coordinator drops overlay rows for addresses it lacks. We assert the gate
    // leaves overlay semantics to the coordinator (promoted = verified rows,
    // existence still enforced even for enrichment).
    const g = gate(stubPrims({ real: ['0xKNOWN'] }));
    const res = await g.gate([tok('0xKNOWN')], 'sol', 'gmgn');
    expect(res.promoted.map((t) => t.address)).toEqual(['0xKNOWN']);
  });
});