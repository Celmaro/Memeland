/**
 * I0-1 — Blockscout token-transfer feed → BuyEvent[] for the convergence voter.
 *
 * Produces provisional BuyEvents for a token from Blockscout's token-transfer
 * endpoint, so the Q05 convergence voter (ownerDedupedConvergenceVote) stops
 * degrading to neutral every cycle.
 *
 * SEMANTICS (per the deep review): a token transfer is NOT necessarily a buy —
 * it can be a router hop, liquidity op, airdrop, or internal transfer. So this
 * producer tags every event `classification: 'transfer-proxy'` (low confidence)
 * and lets the voter apply the fail-closed convergence rules (distinct-wallet
 * threshold, concentration cap, amountUsd>0). Swap-log decoding (higher
 * confidence, needs ABIs) is a later enhancement — this is the free keyless
 * first-pass that unblocks the dead voter today.
 *
 * Env-gate: BLOCKSCOUT_FEED_ENABLED=true. Fail-open: any error → [] (the voter
 * already neutralizes on empty). Keyless on Blockscout's public/chain instances.
 */

import type { MarketDataProvider, MarketDiscoveryOptions, MarketToken } from './market-data-provider.js';
import type { BuyEvent } from '../services/flow-convergence.js';

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;

export interface BlockscoutTransfer {
  hash?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  total?: { value?: string };
  timestamp?: string;
  blockNumber?: number;
}

export interface BlockscoutFeedOptions {
  fetch?: FetchLike;
  /** Blockscout per-chain base (default the official RH instance). */
  baseUrl?: string;
  /** Chain-id → Blockscout base URL override. */
  chainBases?: Record<number, string>;
  /** Max transfers fetched per token (default 50). */
  limit?: number;
}

/** Default per-chain Blockscout bases (official explorer instances). */
const DEFAULT_CHAIN_BASES: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  56: 'https://bsc.blockscout.com',
  8453: 'https://base.blockscout.com',
  // Robinhood Chain is Blockscout's official explorer (RH #4663).
  4663: 'https://robinhoodchain.blockscout.com',
};

export class BlockscoutFeed implements MarketDataProvider {
  readonly id = 'blockscout';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly chainBases: Record<number, string>;
  private readonly limit: number;

  constructor(opts: BlockscoutFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? DEFAULT_CHAIN_BASES[4663]!;
    this.chainBases = opts.chainBases ?? DEFAULT_CHAIN_BASES;
    this.limit = opts.limit ?? 50;
  }

  /** Implements MarketDataProvider minimally (discovery not the role here). */
  async discover(_options?: MarketDiscoveryOptions): Promise<MarketToken[]> {
    return [];
  }

  /**
   * Fetch recent token transfers for an address and map them to provisional
   * BuyEvents. `from` transfers (outflow) are excluded; `to` transfers where the
   * recipient is NOT the token contract count as accumulation proxies. Amount is
   * raw units (no decimals/USD available from this endpoint) — the convergence
   * voter's amountUsd>0 check and distinct-wallet threshold still apply.
   */
  async getBuyEvents(chainId: number, tokenAddress: string): Promise<BuyEvent[]> {
    const base = this.chainBases[chainId] ?? this.baseUrl;
    try {
      const url = `${base}/api/v2/tokens/${tokenAddress}/transfers?limit=${this.limit}`;
      const res = await this.fetch(url);
      if (!res.ok) return [];
      const body = (await res.json()) as { items?: BlockscoutTransfer[] };
      const items = Array.isArray(body?.items) ? body.items : [];
      const events: BuyEvent[] = [];
      for (const t of items) {
        const from = t.from?.hash;
        const to = t.to?.hash;
        const tokenLc = tokenAddress.toLowerCase();
        // Skip if either party is the token contract itself (self-transfer /
        // contract-internal) and require an incoming, non-contract recipient.
        if (!from || !to || from.toLowerCase() === tokenLc || to.toLowerCase() === tokenLc) continue;
        const raw = t.total?.value;
        const amountUsd = raw && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 0;
        if (amountUsd <= 0) continue;
        const timestamp = t.timestamp ? Date.parse(t.timestamp) : Date.now();
        if (!Number.isFinite(timestamp)) continue;
        events.push({ wallet: from, amountUsd, timestamp });
      }
      return events;
    } catch {
      return []; // fail-open
    }
  }
}

/** Env-gated singleton factory (mirrors other *_FEED_ENABLED patterns). */
export function blockscoutFeedEnabled(): boolean {
  return process.env.BLOCKSCOUT_FEED_ENABLED === 'true';
}
