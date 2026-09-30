import { describe, it, expect } from 'vitest';
import { SolanaRpcDiscoveryFeed, extractCreateMint } from './solana-rpc-discovery-feed.js';
import type { SolFetchLike } from './solana-rpc-discovery-feed.js';

const RPC = 'https://rpc.shyft.to?api_key=k';
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const CREATE_TX = {
  transaction: { message: { instructions: [{ parsed: { type: 'create', info: { mint: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLmBJEAFsRE4YquLS7t4P' } } }] } },
};

function rpcRoute(method: string) {
  if (method === 'getSignaturesForAddress') {
    return okJson({ result: [{ signature: 'sig1' }] });
  }
  if (method === 'getTransaction') {
    return okJson({ result: CREATE_TX });
  }
  return okJson({ result: null });
}

const routeFetch: SolFetchLike = (url, init) => {
  const body = JSON.parse(init?.body ?? '{}') as { method?: string };
  return Promise.resolve(rpcRoute(body.method ?? ''));
};

describe('SolanaRpcDiscoveryFeed (Sol introducer)', () => {
  it('discovers a fresh SPL mint from a create tx over the Sol RPC', async () => {
    const f = new SolanaRpcDiscoveryFeed({ rpcUrl: RPC, fetch: routeFetch });
    const out = await f.discover();
    expect(out).toHaveLength(1);
    expect(out[0]!.address).toBe('Gh9ZwEmdLJ8DscKNTkTqPbNwLmBJEAFsRE4YquLS7t4P');
    expect(out[0]!.chainId).toBe(101);
    expect(out[0]!.freshLane).toBe(true);
  });

  it('filters to Sol: returns [] when chainIds exclude Sol', async () => {
    const f = new SolanaRpcDiscoveryFeed({ rpcUrl: RPC, fetch: routeFetch });
    const out = await f.discover({ chainIds: [56] });
    expect(out).toEqual([]);
  });

  it('is fail-soft: returns [] on transport error', async () => {
    const bad: SolFetchLike = async () => {
      throw new Error('boom');
    };
    const f = new SolanaRpcDiscoveryFeed({ rpcUrl: RPC, fetch: bad });
    await expect(f.discover()).resolves.toEqual([]);
  });

  it('extractCreateMint parses a jsonParsed create instruction', () => {
    expect(extractCreateMint(CREATE_TX)).toBe('Gh9ZwEmdLJ8DscKNTkTqPbNwLmBJEAFsRE4YquLS7t4P');
    expect(extractCreateMint({ transaction: { message: { instructions: [] } } })).toBeNull();
    expect(extractCreateMint(null)).toBeNull();
  });

  it('B#2 — resumes from a persisted cursor: asks for signatures AFTER the last seen one', async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const routeFetch: SolFetchLike = (url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { method?: string; params?: unknown };
      calls.push(body);
      if (body.method === 'getSignaturesForAddress') return Promise.resolve(okJson({ result: [{ signature: 'sig2' }] }));
      if (body.method === 'getTransaction') return Promise.resolve(okJson({ result: CREATE_TX }));
      return Promise.resolve(okJson({ result: null }));
    };
    const backend = { get: () => 'sig1', set: () => {} };
    const f = new SolanaRpcDiscoveryFeed({ rpcUrl: RPC, fetch: routeFetch, cursorBackend: backend });
    const out = await f.discover();
    expect(out).toHaveLength(1);
    const sigsCall = calls.find((c) => c.method === 'getSignaturesForAddress');
    expect((sigsCall?.params as Array<unknown> | undefined)?.[1]).toMatchObject({ before: 'sig1' });
  });

  it('B#2 — persists the advanced cursor back to the backend', async () => {
    let stored: string | undefined;
    const backend = { get: () => undefined, set: (_p: string, sig: string) => { stored = sig; } };
    const f = new SolanaRpcDiscoveryFeed({ rpcUrl: RPC, fetch: routeFetch, cursorBackend: backend });
    await f.discover();
    expect(stored).toBe('sig1'); // last enumerated signature advanced the cursor
  });

  it('B#2 — a throwing cursor backend is fail-soft: discovery still proceeds', async () => {
    const bad = { get: () => { throw new Error('store down'); }, set: () => { throw new Error('store down'); } };
    const f = new SolanaRpcDiscoveryFeed({ rpcUrl: RPC, fetch: routeFetch, cursorBackend: bad });
    const out = await f.discover();
    expect(out).toHaveLength(1);
  });
});
