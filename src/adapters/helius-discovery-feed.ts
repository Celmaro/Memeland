/**
 * Helius Solana INTRODUCER feed (provider-architecture v2: helius-sol).
 *
 * Pull-based, credit-bounded, fail-soft discovery of NEWLY CREATED SPL mints on
 * the Solana launch programs. Verified against current Helius billing
 * (2026-09-29 web check): getSignaturesForAddress and getTransaction are BOTH
 * 10 credits each (NOT 1 — the old helius-feed docstring understated them), and
 * getProgramAccounts is 10 cr. So this feed:
 *
 *   - never polls getProgramAccounts (the ~288K cr/day trap the report warns of)
 *   - walks getSignaturesForAddress (10 cr) with a PERSISTED per-program cursor,
 *     so each cycle only pays for signatures the previous cycle has NOT seen
 *   - decodes a mint only when a transaction actually contains an SPL Token
 *     `create` instruction (parsed.type === 'create', info.mint present). This
 *     is the program-agnostic "a new SPL mint was created" signal (works for
 *     pump.fun / Meteora / Raydium alike) and FAILS SOFT — an ambiguous or
 *     malformed transaction introduces nothing, never garbage.
 *
 * Hard per-cycle credit budget (default 50) caps worst-case spend; the result
 * is purely additive ([] on any transport/parse failure).
 *
 * The preferred ~0-credit production path is a Helius webhook (1 cr/event), but
 * that needs a publicly reachable endpoint this repo does not host; this feed is
 * the bounded pull fallback. Live-key validation remains outstanding.
 */

import type { MarketDataProvider, MarketToken, MarketDiscoveryOptions } from './market-data-provider.js';
import type { FetchLike, HeliusFeedOptions } from './helius-feed.js';

/** Confirmed 2026-09-29: getSignaturesForAddress costs 10 credits. */
export const HELIUS_CR_GET_SIGNATURES = 10;
/** Confirmed 2026-09-29: getTransaction costs 10 credits. */
export const HELIUS_CR_GET_TRANSACTION = 10;
/** Never polled (report rule): getProgramAccounts is the ~288K cr/day trap. */
export const HELIUS_CR_GET_PROGRAM_ACCOUNTS = 10;

/** Solana chain id used by the market-data layer. */
export const SOLANA_CHAIN_ID = 101;

export interface HeliusDiscoveryOptions extends MarketDiscoveryOptions {
  chainIds?: number[];
}

export interface HeliusDiscoveryFeedOptions extends HeliusFeedOptions {
  /** Launch programs to walk for new-mint signatures (default: pump.fun). */
  launchPrograms?: string[];
  /** Max credits spent per discover() cycle (default 50). */
  perCycleCredits?: number;
  /** Max signatures enumerated per program per cycle (default 10). */
  maxSignaturesPerProgram?: number;
}

/** Default Solana launch programs to watch (pump.fun canonical). */
export const DEFAULT_LAUNCH_PROGRAMS = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'];

/** A Solana base58 public-key (32–44 chars, no I/O/l/0 ambiguity). */
export function isBase58PublicKey(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/**
 * Extract the mint of a newly created SPL token from a jsonParsed
 * getTransaction result. Program-agnostic: an SPL Token `create` instruction
 * (parsed.type === 'create', parsed.info.mint) is the universal "new mint"
 * signal. Returns null on any malformed/ambiguous input — the caller treats
 * null as "not a confident new mint" and introduces nothing.
 */
export function extractCreateMint(tx: unknown): string | null {
  const root = tx as { meta?: { postTokenBalances?: unknown }; transaction?: { message?: { instructions?: unknown[] } } };
  const instructions = root?.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return null;
  for (const ins of instructions) {
    const parsed = (ins as { parsed?: { type?: string; info?: { mint?: string } } })?.parsed;
    if (parsed && typeof parsed === 'object' && parsed.type === 'create' && parsed.info && typeof parsed.info.mint === 'string') {
      const mint = parsed.info.mint.trim();
      if (isBase58PublicKey(mint)) return mint;
    }
  }
  return null;
}

export class HeliusDiscoveryFeed implements MarketDataProvider {
  readonly id = 'helius';

  private readonly fetch: FetchLike;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly launchPrograms: string[];
  private readonly perCycleCredits: number;
  private readonly maxSignaturesPerProgram: number;
  /** Persisted per-program cursor: last enumerated signature (de-dupes cycles). */
  private readonly cursor = new Map<string, string>();

  constructor(opts: HeliusDiscoveryFeedOptions) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://mainnet.helius-rpc.com';
    this.launchPrograms = (opts.launchPrograms ?? DEFAULT_LAUNCH_PROGRAMS).filter(isBase58PublicKey);
    this.perCycleCredits = opts.perCycleCredits ?? 50;
    this.maxSignaturesPerProgram = opts.maxSignaturesPerProgram ?? 10;
  }

  /**
   * Discover newly created SPL mints. Solana-only: returns [] unless the chain
   * filter is empty or includes solana (101). Additive & fail-soft.
   */
  async discover(options: HeliusDiscoveryOptions = {}): Promise<MarketToken[]> {
    const chainIds = options.chainIds ?? [];
    if (chainIds.length > 0 && !chainIds.includes(SOLANA_CHAIN_ID)) return [];

    const tokens: MarketToken[] = [];
    let credits = 0;
    for (const program of this.launchPrograms) {
      if (credits >= this.perCycleCredits) break;
      const before = this.cursor.get(program);
      // getSignaturesForAddress = 10 cr, capped at per-program page size.
      const sigs = await this.signatures(program, before, this.maxSignaturesPerProgram);
      if (sigs === null || sigs.length === 0) continue;
      credits += HELIUS_CR_GET_SIGNATURES;
      for (const sig of sigs) {
        if (credits >= this.perCycleCredits) break;
        const mint = await this.mintFromSignature(sig.signature);
        if (!mint) continue; // not a confident new SPL mint — skip, fail-soft
        credits += HELIUS_CR_GET_TRANSACTION;
        tokens.push({
          address: mint,
          chainId: SOLANA_CHAIN_ID,
          symbol: '',
          priceUsd: 0,
          liquidityUsd: 0,
          volume24hUsd: 0,
          // Raw on-chain mint at birth: zero market data, so it passes the LOW
          // fresh floor; market depth arrives via enrichment in later cycles.
          freshLane: true,
          pairAddress: program,
          dex: 'helius-sol',
        });
      }
      // Advance the cursor to the OLDEST signature we enumerated so the next
      // cycle only pays for signatures this cycle introduced.
      this.cursor.set(program, sigs[sigs.length - 1]!.signature);
    }
    return tokens;
  }

  /** getSignaturesForAddress (10 cr), bounded page. Fail-soft → null. */
  private async signatures(program: string, before?: string, limit = 10): Promise<Array<{ signature: string }> | null> {
    try {
      const result = (await this.rpc('getSignaturesForAddress', [program, { limit, ...(before ? { before } : {}) }])) as
        Array<{ signature: string }> | null;
      if (!Array.isArray(result)) return null;
      return result.map((s) => ({ signature: s.signature }));
    } catch {
      return null;
    }
  }

  /**
   * Decode a mint from a signature via getTransaction (10 cr). Only a confident
   * SPL `create` yields a mint; anything else returns null (introduces nothing).
   */
  private async mintFromSignature(signature: string): Promise<string | null> {
    try {
      const result = (await this.rpc('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ])) as unknown;
      return extractCreateMint(result);
    } catch {
      return null;
    }
  }

  private rpc(method: string, params: unknown[]): Promise<unknown> {
    const url = `${this.baseUrl}/?api-key=${encodeURIComponent(this.apiKey)}`;
    return this.fetch(url, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`helius ${method} HTTP ${res.status}`);
      const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (data.error) throw new Error(`helius ${method}: ${data.error.message}`);
      return data.result;
    });
  }
}
