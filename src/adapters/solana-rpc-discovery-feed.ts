/**
 * Solana RPC introducer (provider-architecture v2: `solana-rpc`).
 *
 * The canonical SOL introducer on a generic Solana
 * JSON-RPC host. It runs over the RPC-failover manager's active Sol RPC
 * (Shyft → Chainstack → PublicNode sol — see docs/research/solana-evm-rpc-providers.md),
 * so the raw mainnet Sol RPCs the operator supplied are the TRANSPORT housing it.
 *
 * The logic is the proven, credit-free SPL-create walk:
 *   - never polls getProgramAccounts (the huge-cost trap)
 *   - walks getSignaturesForAddress on the pump.fun launch program with a
 *     PERSISTED per-program cursor, so each cycle only re-reads new signatures
 *   - decodes a mint only when a tx actually contains an SPL Token `create`
 *     instruction (parsed.type === 'create', info.mint present) — program-agnostic
 *     and FAIL-SOFT: ambiguous/malformed txs introduce nothing, never garbage.
 *
 * Per-cycle signature budget caps worst-case spend; the result is purely
 * additive ([]) on any transport/parse failure. Rate limits are enforced by
 * `globalRateLimiter` (429 circuit breaker) inside the failover manager.
 */

import type { MarketDataProvider, MarketToken, MarketDiscoveryOptions } from './market-data-provider.js';
import { globalRPCFailoverManager } from '../services/rpc-failover.js';

/** Solana chain id used by the market-data layer. */
export const SOLANA_CHAIN_ID = 101;

export type SolFetchLike = (url: string, init?: { body?: string }) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

export interface SolanaRpcDiscoveryOptions extends MarketDiscoveryOptions {
  /** Launch programs to walk for new-mint signatures (default: pump.fun). */
  launchPrograms?: string[];
  /** Max signatures enumerated per program per cycle (default 10). */
  maxSignaturesPerProgram?: number;
  /** Explicit Sol RPC URL. Default: the failover manager's active Sol RPC. */
  rpcUrl?: string;
  /**
   * B#2 (audit) — persistent per-program signature cursor. The cursor is what
   * bounds cost: each cycle only re-walks NEW signatures past it. Defaults to an
   * in-memory Map (lost on restart, so a restart re-reads one bounded page). For
   * pull-based SOL discovery against a paid RPC, inject a durable backend
   * (Redis/JSONL) so a restart resumes from the last seen signature instead of
   * re-decoding an already-seen page every boot. Fail-soft: a backend whose
   * get/set throws is caught and treated as "no cursor" by the caller.
   */
  cursorBackend?: CursorBackend;
  fetch?: SolFetchLike;
}

/** Persistable cursor seam: maps a launch program to its last enumerated signature. */
export interface CursorBackend {
  get(program: string): string | undefined;
  set(program: string, signature: string): void;
}

/** Default Solana launch program to watch (pump.fun canonical). */
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

export class SolanaRpcDiscoveryFeed implements MarketDataProvider {
  readonly id = 'solana-rpc';

  private readonly fetch: SolFetchLike;
  private readonly launchPrograms: string[];
  private readonly maxSignaturesPerProgram: number;
  private readonly rpcUrl?: string;
  /** Per-program cursor: last enumerated signature (de-dupes cycles). Backed by
   *  the injectable `cursorBackend` when provided, else an in-memory Map. */
  private readonly cursor: CursorBackend;

  constructor(opts: SolanaRpcDiscoveryOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: SolFetchLike }).fetch as SolFetchLike);
    this.fetch = f;
    this.launchPrograms = (opts.launchPrograms ?? DEFAULT_LAUNCH_PROGRAMS).filter(isBase58PublicKey);
    this.maxSignaturesPerProgram = opts.maxSignaturesPerProgram ?? 10;
    this.rpcUrl = opts.rpcUrl;
    this.cursor = opts.cursorBackend ?? new Map<string, string>();
  }

  /** Resolve the Sol RPC to talk to: explicit URL or the failover manager's active Sol RPC. */
  private url(): string {
    if (this.rpcUrl) return this.rpcUrl;
    const active = globalRPCFailoverManager.getActiveRPC('sol');
    return active || '';
  }

  /**
   * Discover newly created SPL mints. Solana-only: returns [] unless the chain
   * filter is empty or includes solana (101). Additive & fail-soft.
   */
  async discover(options: SolanaRpcDiscoveryOptions = {}): Promise<MarketToken[]> {
    const chainIds = options.chainIds ?? [];
    if (chainIds.length > 0 && !chainIds.includes(SOLANA_CHAIN_ID)) return [];

    const tokens: MarketToken[] = [];
    let budget = options.maxSignaturesPerProgram ? this.maxSignaturesPerProgram * this.launchPrograms.length : Infinity;
    for (const program of this.launchPrograms) {
      if (budget <= 0) break;
      const before = this.cursorGet(program);
      const sigs = await this.signatures(program, before, this.maxSignaturesPerProgram);
      if (sigs === null || sigs.length === 0) continue;
      budget -= sigs.length;
      for (const sig of sigs) {
        const mint = await this.mintFromSignature(sig.signature);
        if (!mint) continue; // not a confident new SPL mint — skip, fail-soft
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
          dex: 'solana-rpc',
        });
      }
      // Advance the cursor to the OLDEST signature enumerated so the next cycle
      // only pays for signatures this cycle introduced.
      this.cursorSet(program, sigs[sigs.length - 1]!.signature);
    }
    return tokens;
  }

  /** getSignaturesForAddress, bounded page. Fail-soft → null. */
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

  /** Decode a mint from a signature via getTransaction. Only a confident SPL `create` yields a mint. */
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

  /** Fail-soft cursor read: a throwing/absent backend is treated as no cursor. */
  private cursorGet(program: string): string | undefined {
    try {
      return this.cursor.get(program);
    } catch {
      return undefined;
    }
  }

  /** Fail-soft cursor write: a throwing backend is skipped, discovery continues. */
  private cursorSet(program: string, signature: string): void {
    try {
      this.cursor.set(program, signature);
    } catch { /* persist failure never blocks discovery */ }
  }

  private rpc(method: string, params: unknown[]): Promise<unknown> {
    const url = this.url();
    return this.fetch(url, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`solana-rpc ${method} HTTP ${res.status}`);
      const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (data.error) throw new Error(`solana-rpc ${method}: ${data.error.message}`);
      return data.result;
    });
  }
}
