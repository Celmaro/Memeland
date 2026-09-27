/**
 * P4.3 — Helius free-tier SOL security + tx confirmation (verified 2026-09-27).
 * Free plan: 1M credits/month, 10 rps RPC, 2 rps DAS/Enhanced, webhooks free.
 *
 * DAS getTokenAccounts (10 cr): holder count + top-10 concentration + mint/
 * freeze authority booleans in ONE call — replaces the PAID Birdeye
 * token_security ($39/mo) for Solana scam heuristics.
 *
 * Standard RPC getSignaturesForAddress/getTransaction (1 cr): cheap confirmed
 * buy/sell decoding for first-buy confirmation.
 */

import type { MarketDataProvider } from './market-data-provider.js';

export const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com';

export type FetchLike = (url: string, init?: { body?: string }) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

export interface HeliusTokenAccounts {
  count: number;
  top10Percent: number;
  mintAuthorityMutable: boolean;
  freezeAuthorityMutable: boolean;
}

export interface HeliusFeedOptions {
  fetch?: FetchLike;
  apiKey: string;
  baseUrl?: string;
}

export class HeliusFeed {
  readonly id = 'helius';
  private readonly fetch: FetchLike;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: HeliusFeedOptions) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? HELIUS_RPC_BASE;
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

  /** DAS getTokenAccounts — holder stats + authority flags in one call. */
  public async tokenAccounts(mint: string): Promise<HeliusTokenAccounts | null> {
    try {
      const result = (await this.rpc('getTokenAccounts', [{ mint }])) as {
        mintAuthority?: boolean;
        freezeAuthority?: boolean;
        items?: Array<{ owner?: string; amount?: number }>;
      } | null;
      if (!result) return null;
      const items = result.items ?? [];
      const total = items.reduce((a, i) => a + (Number(i.amount) || 0), 0);
      const top10 = [...items].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 10);
      const top10Amount = top10.reduce((a, i) => a + (Number(i.amount) || 0), 0);
      return {
        count: items.length,
        top10Percent: total > 0 ? (top10Amount / total) * 100 : 0,
        mintAuthorityMutable: result.mintAuthority === true,
        freezeAuthorityMutable: result.freezeAuthority === true,
      };
    } catch {
      return null; // fail-soft
    }
  }

  /** getSignaturesForAddress — first-buy/creation detection (1 cr). */
  public async signatures(address: string, before?: string): Promise<Array<{ signature: string; blockTime?: number }> | null> {
    try {
      const result = (await this.rpc('getSignaturesForAddress', [address, { limit: 1000, ...(before ? { before } : {}) }])) as
        Array<{ signature: string; blockTime?: number | null }> | null;
      if (!Array.isArray(result)) return null;
      return result.map((s) => ({ signature: s.signature, ...(s.blockTime ? { blockTime: s.blockTime } : {}) }));
    } catch {
      return null;
    }
  }
}

export type _FetchCompat = MarketDataProvider;
