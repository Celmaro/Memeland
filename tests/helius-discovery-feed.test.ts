import { describe, it, expect, vi } from 'vitest';
import {
  HeliusDiscoveryFeed,
  extractCreateMint,
  isBase58PublicKey,
  SOLANA_CHAIN_ID,
  DEFAULT_LAUNCH_PROGRAMS,
} from '../src/adapters/helius-discovery-feed.js';
import type { FetchLike } from '../src/adapters/helius-feed.js';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const MINT = 'FpMoZHKuk2KHsNurw1YEVoB8MVvjXuwgKpCTf8Ypump';
const PROG = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function rawTx(parsedType = 'create') {
  // The transaction OBJECT as returned by getTransaction's `.result` — this is
  // exactly what `extractCreateMint` receives from the feed's RPC unwrap.
  return {
    meta: {},
    transaction: {
      message: {
        instructions: [{ parsed: { type: parsedType, info: { mint: MINT } } }],
      },
    },
  };
}

function rpcFeed(handlers: Record<string, unknown>, calls: string[] = []) {
  const fn: FetchLike = async (_url: string, init?: { body?: string }) => {
    const method = JSON.parse(init?.body ?? '{}').method as string;
    calls.push(method);
    const body = handlers[method];
    if (body === undefined) throw new Error(`unexpected ${method}`);
    return okJson(body);
  };
  return { fn, calls };
}

describe('extractCreateMint (SPL mint-creation signal)', () => {
  it('extracts a valid base58 mint from a parsed create instruction', () => {
    expect(extractCreateMint(rawTx('create'))).toBe(MINT);
  });

  it('returns null when the instruction is not an SPL create', () => {
    expect(extractCreateMint(rawTx('transfer'))).toBeNull();
    expect(extractCreateMint(rawTx('initializeMint'))).toBeNull();
  });

  it('rejects malformed mints and malformed transactions (never fabricates)', () => {
    expect(extractCreateMint({ meta: {}, transaction: { message: { instructions: [] } } })).toBeNull();
    expect(extractCreateMint({ meta: {}, transaction: { message: {} } })).toBeNull();
    expect(extractCreateMint(null)).toBeNull();
    // A malformed base58 (contains ambiguous chars / wrong length) is refused.
    expect(extractCreateMint({ meta: {}, transaction: { message: { instructions: [{ parsed: { type: 'create', info: { mint: '0OIl...short' } } }] } } })).toBeNull();
  });

  it('isBase58PublicKey guards 32–44 char keys', () => {
    expect(isBase58PublicKey(MINT)).toBe(true);
    expect(isBase58PublicKey('short')).toBe(false);
    expect(isBase58PublicKey('0'.repeat(44))).toBe(false);
  });
});

describe('HeliusDiscoveryFeed (P4.3 SOL introducer)', () => {
  it('discovers a new SPL mint as a freshLane sol candidate (chainId 101)', async () => {
    const { fn, calls } = rpcFeed({
      getSignaturesForAddress: { result: [{ signature: 'sig1' }] },
      getTransaction: { result: rawTx('create') },
    });
    const feed = new HeliusDiscoveryFeed({ fetch: fn, apiKey: 'k', launchPrograms: [PROG] });
    const tokens = await feed.discover();
    expect(calls).toEqual(['getSignaturesForAddress', 'getTransaction']);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.address).toBe(MINT);
    expect(tokens[0]!.chainId).toBe(SOLANA_CHAIN_ID);
    expect(tokens[0]!.freshLane).toBe(true);
    expect(tokens[0]!.pairAddress).toBe(PROG);
  });

  it('advances the cursor and skips non-create transactions (additive, not garbage)', async () => {
    let phase = 0;
    const fn: FetchLike = async (_url, init) => {
      const method = JSON.parse(init?.body ?? '{}').method as string;
      if (method === 'getSignaturesForAddress') return okJson({ result: [{ signature: `sig${phase}` }] });
      // Phase 0: transfer (no mint) → skipped. Phase 1: create → surfaced.
      return okJson({ result: rawTx(phase === 0 ? 'transfer' : 'create') });
    };
    const feed = new HeliusDiscoveryFeed({ fetch: fn, apiKey: 'k', launchPrograms: [PROG] });
    const first = await feed.discover();
    expect(first.length).toBe(0); // transfer yielded nothing
    phase = 1;
    const second = await feed.discover();
    expect(second.length).toBe(1);
    expect(second[0]!.address).toBe(MINT);
  });

  it('respects the chain filter (only solana 101 passes)', async () => {
    const { fn } = rpcFeed({ getSignaturesForAddress: { result: [{ signature: 's' }] }, getTransaction: { result: rawTx() } });
    const feed = new HeliusDiscoveryFeed({ fetch: fn, apiKey: 'k' });
    expect(await feed.discover({ chainIds: [1] })).toEqual([]); // eth only → no sol
  });

  it('fails soft on transport error (never blocks the funnel)', async () => {
    const fn: FetchLike = async () => { throw new Error('rpc down'); };
    const feed = new HeliusDiscoveryFeed({ fetch: fn, apiKey: 'k' });
    expect(await feed.discover()).toEqual([]);
  });

  it('honors the per-cycle credit budget (stops before over-spending)', async () => {
    // Many signatures, but budget = 1 sig call + 2 tx decodes → bounded.
    const sigs = Array.from({ length: 20 }, (_, i) => ({ signature: `sig${i}` }));
    const fn: FetchLike = async (_url, init) => {
      const method = JSON.parse(init?.body ?? '{}').method as string;
      if (method === 'getSignaturesForAddress') return okJson({ result: sigs });
      return okJson({ result: rawTx('create') });
    };
    const feed = new HeliusDiscoveryFeed({ fetch: fn, apiKey: 'k', perCycleCredits: 20, maxSignaturesPerProgram: 20 });
    const tokens = await feed.discover();
    // 20 credits budget → 1 sig call (10) + 1 tx decode (10) → at most 1 token.
    expect(tokens.length).toBeLessThanOrEqual(1);
  });

  it('defaults to the pump.fun launch program', () => {
    expect(DEFAULT_LAUNCH_PROGRAMS).toHaveLength(1);
    expect(isBase58PublicKey(DEFAULT_LAUNCH_PROGRAMS[0]!)).toBe(true);
  });
});
