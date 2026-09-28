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
});
