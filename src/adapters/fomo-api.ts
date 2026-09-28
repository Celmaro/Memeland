/**
 * P0.1 — FOMO API adapter (provider-architecture v2: candidate emitter).
 *
 * fomoapi.io — independent, UNOFFICIAL developer product mirroring
 * fomo.family's public data (provenance caveat from the research report: it is
 * a proxied social-trading view, so it is CANDIDATE-EMITTING / trader
 * intelligence, never canonical discovery truth).
 *
 * Verified free tier (2026-09-29): 250,000 credits/mo (~1K normal calls),
 * EVERY endpoint, 20 req/min free, WS messages unmetered. Credit costs:
 *   - normal/leaderboard/trades/balances/holders = 250
 *   - /v2/alerts = 125
 *   - thesis = 1,250
 *   - wallet resolution /v2/users/{handle} = 2,500
 * Chains: Robinhood (4663, FOMO's most active), Solana, Ethereum, Base, BSC,
 * Monad, Arc, Hyperliquid.
 *
 * All reads go through the shared ProviderGovernor so the 250K monthly cap and
 * the 20 rpm free limit are respected centrally. Requests are cast through a
 * tolerant parser (the exact JSON shape is not contractual here) — a malformed
 * row is dropped, never fatal; transport failure yields [] (fail-soft).
 */

import { ProviderGovernor, globalProviderGovernor } from '../services/provider-governor.js';
import { chainIdFor, CHAIN_NAME_TO_ID } from './market-data-provider.js';

export const FOMO_CR_DEFAULT = 250;
export const FOMO_CR_ALERTS = 125;
export const FOMO_CR_THESIS = 1_250;
export const FOMO_CR_IDENTITY = 2_500;
export const FOMO_DAILY_CAP = 250_000;
export const FOMO_RPM = 20;

export type FomoWindow = '24h' | '7d' | '30d' | 'all';
export type FomoTokenBoard = 'trending' | 'most-held' | 'graduated';
export type FomoChain = 'robinhood' | 'solana' | 'ethereum' | 'base' | 'bsc' | 'monad' | 'arc' | 'hyperliquid';

export interface FomoLeaderboardRow {
  rank: number;
  handle: string;
  userId: string;
  pnlPct: number;
  volumeUsd: number;
  chain: FomoChain;
  solWallet?: string;
  evmWallet?: string;
}

export interface FomoTokenBoardRow {
  address: string;
  chain: FomoChain;
  symbol: string;
  name?: string;
  priceUsd: number;
  change24hPct: number;
  volumeUsd: number;
  graduated?: boolean;
}

export interface FomoTraderResolution {
  handle: string;
  solWallet?: string;
  evmWallet?: string;
  pnlPct24h?: number;
  pnlPct7d?: number;
  pnlPct30d?: number;
  ageDays?: number;
}

export interface FomoTokenHealth {
  address: string;
  /** Deployer / insider wallet addresses (rug / serial-deployer signal). */
  devs?: string[];
  thesis?: string;
}

export interface FomoApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  governor?: ProviderGovernor;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export class FomoApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly governor: ProviderGovernor;

  constructor(opts: FomoApiOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://app.fomoapi.io').replace(/\/$/, '');
    this.fetch = opts.fetch ?? (globalThis.fetch as typeof fetch);
    this.governor = opts.governor ?? globalProviderGovernor;
  }

  private cfg(dailyCap?: number) {
    return { id: 'fomo', dailyCap: dailyCap ?? FOMO_DAILY_CAP, rpm: FOMO_RPM, assumedCostPerCall: FOMO_CR_DEFAULT, ttlMs: 5 * 60_000 };
  }

  /** GET an authenticated FOMO endpoint through the governor (credit + rpm paced). */
  private async get<T>(path: string, cacheKey: string, cost: number, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const sep = qs.toString() ? `?${qs.toString()}` : '';
    const url = `${this.baseUrl}${path}${sep}`;
    const attempt = await this.governor.run<T>('fomo', this.cfg(), cacheKey, async () => {
      const res = await this.fetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${this.apiKey}` },
      });
      const creditsUsed = parseCreditHeader(res.headers.get('x-credits-cost') ?? res.headers.get('x-credits'));
      const data = (await res.json()) as T;
      return { status: res.status, data, creditsUsed: creditsUsed ?? cost };
    });
    if (!attempt.ok) return null;
    return attempt.data ?? null;
  }

  /**
   * Ranked trader leaderboard for a window. Rows carry BOTH on-chain wallet ids
   * and the trader handle, feeding the trader-persistence / wallet-graph layer.
   * Cost: 250 cr each (default).
   */
  public async leaderboard(window: FomoWindow, chain?: FomoChain, limit = 50): Promise<FomoLeaderboardRow[]> {
    const data = await this.get<unknown>(`/v2/leaderboard/${window}`, `lb:${window}:${chain ?? ''}`, FOMO_CR_DEFAULT, {
      chain: chain ? String(chainIdFor(chain) ?? chain) : undefined,
      limit,
    });
    const arr = asArray(data);
    const out: FomoLeaderboardRow[] = [];
    for (const row of arr) {
      const rank = num(row?.rank);
      const handle = str(row?.handle);
      if (!handle) continue;
      const h = row as Record<string, unknown>;
      out.push({
        rank: rank || 0,
        handle,
        userId: str(h.userId) ?? str(h.id) ?? handle,
        pnlPct: num(h.pnlPct ?? h.pnl),
        volumeUsd: num(h.volumeUsd ?? h.volume),
        chain: (str(h.chain) as FomoChain) ?? chain ?? 'solana',
        solWallet: str(h.solWallet ?? h.sol_address ?? h.sol),
        evmWallet: str(h.evmWallet ?? h.evm_address ?? h.evm ?? h.wallet),
      });
    }
    return out;
  }

  /** Token boards: trending / most-held / graduated token candidate hints. */
  public async tokenBoard(stack: FomoTokenBoard, chain?: FomoChain): Promise<FomoTokenBoardRow[]> {
    const data = await this.get<unknown>(`/v2/leaderboard/tokens/${stack}`, `tb:${stack}:${chain ?? ''}`, FOMO_CR_DEFAULT, {
      chain: chain ? String(chainIdFor(chain) ?? chain) : undefined,
    });
    const out: FomoTokenBoardRow[] = [];
    for (const row of asArray(data)) {
      const address = str(row?.address ?? row?.mint ?? row?.token);
      if (!address) continue;
      const h = row as Record<string, unknown>;
      out.push({
        address,
        chain: (str(h.chain) as FomoChain) ?? chain ?? 'solana',
        symbol: str(h.symbol) ?? '',
        name: str(h.name),
        priceUsd: num(h.priceUsd ?? h.price),
        change24hPct: num(h.change24hPct ?? h.change),
        volumeUsd: num(h.volumeUsd ?? h.volume),
        graduated: stack === 'graduated' ? true : Boolean(h.graduated),
      });
    }
    return out;
  }

  /**
   * Trader Identity Resolver: handle → Solana + EVM on-chain wallets + PnL
   * windows. EXPENSIVE (2,500 cr) — the caller must gate this to a shortlist.
   */
  public async resolveTrader(handle: string): Promise<FomoTraderResolution | null> {
    const data = await this.get<unknown>(`/v2/users/${encodeURIComponent(handle)}`, `user:${handle}`, FOMO_CR_IDENTITY);
    const h = (data ?? {}) as Record<string, unknown>;
    const solWallet = str(h.solWallet ?? h.sol_address ?? h.sol);
    const evmWallet = str(h.evmWallet ?? h.evm_address ?? h.evm ?? h.wallet);
    if (!solWallet && !evmWallet) return null;
    return {
      handle,
      solWallet,
      evmWallet,
      pnlPct24h: numFrom(h, ['pnl24hPct', 'pnlPct24h', 'pnl.24h']),
      pnlPct7d: numFrom(h, ['pnl7dPct', 'pnlPct7d', 'pnl.7d']),
      pnlPct30d: numFrom(h, ['pnl30dPct', 'pnlPct30d', 'pnl.30d']),
      ageDays: numFrom(h, ['ageDays', 'accountAgeDays']),
    };
  }

  /** Deployer + insiders + thesis for a token (rug / serial-deployer signal). */
  public async tokenHealth(address: string, chain: FomoChain = 'solana'): Promise<FomoTokenHealth | null> {
    const data = await this.get<unknown>(`/v2/token/${encodeURIComponent(address)}/devs`, `devs:${chain}:${address}`, FOMO_CR_DEFAULT, {
      chain: chainIdFor(chain) !== undefined ? String(chainIdFor(chain)) : undefined,
    });
    const h = (data ?? {}) as Record<string, unknown>;
    return {
      address,
      devs: asArray(h.devs ?? h.insiders).map((d) => str(d?.address ?? d?.wallet ?? d) ?? '').filter(Boolean),
      thesis: str(h.thesis),
    };
  }

  /** App-feed WS URL (realtime, unmetered messages; 7d realtime then 15s). */
  public static alertsWsUrl(base = 'wss://app.fomoapi.io'): string {
    return `${base.replace(/^http/, 'wss')}/ws/alerts`;
  }
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  if (v && typeof v === 'object') {
    const d = v as Record<string, unknown>;
    if (Array.isArray(d.data)) return d.data as Array<Record<string, unknown>>;
    if (Array.isArray(d.results)) return d.results as Array<Record<string, unknown>>;
    if (Array.isArray(d.traders)) return d.traders as Array<Record<string, unknown>>;
    if (Array.isArray(d.tokens)) return d.tokens as Array<Record<string, unknown>>;
  }
  return [];
}

/** First defined value among candidate keys (tolerant of varying API shapes). */
function numFrom(h: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const direct = h[k];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const dotted = k.split('.');
    if (dotted.length === 2) {
      const parent = h[dotted[0]] as Record<string, unknown> | undefined;
      const v = parent?.[dotted[1]];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

function parseCreditHeader(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Chain-name aliases for the FOMO adapter (extended from the market map). */
export const FOMO_CHAIN_ID = CHAIN_NAME_TO_ID;