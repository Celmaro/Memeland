/**
 * Kernel T — CopyTradeHesitation + the copy-trade extension helpers.
 * Extracted from wallet-tracker.ts (PR10 Adapt-only #2 cluster): pure,
 * zero-dependency helpers for trader-following, concentration, bundle
 * discovery, copy sizing, hesitation gating, retry/backoff, and idempotent
 * dedup-merge. wallet-tracker.ts re-exports these for backward compatibility.
 */

import { HesitationMemory, type HesitationBrief, type MemoryKind, type MemoryStatus } from './hesitation-memory.js';
import { TimeOnCurveFilter, type TimeOnCurveResult, type TimeOnCurveAssessOptions } from './time-on-curve.js';
import { garchHarnessValidation, garchWalkForward, volTargetSize, type GarchParams } from './garch-vol.js';
import { simulateNextClose, type NextCloseBar, type NextCloseConfig, type NextCloseOrder, type NextCloseResult } from './next-close-simulator.js';
import { PaperBroker, sizeCopyPosition, type PaperFill } from './solana-copy-trade.js';

export interface WalletTradeRecord {
  wallet: string;
  token: string;
  side: 'buy' | 'sell';
  usd: number;
  /** Realized PnL for the trade, when known. */
  pnlUsd?: number;
  blockTime?: number;
  txHash?: string;
}

export interface TraderFollowRank {
  wallet: string;
  realizedPnlUsd: number;
  trades: number;
  winRatePct: number;
}

/**
 * Rank wallets by realized PnL (Vybe-style trader-following signal). Fail-open:
 * wallets with no realized-PnL records are omitted rather than ranked 0.
 */
export function rankTradersByRealizedPnl(
  trades: WalletTradeRecord[]
): TraderFollowRank[] {
  const list = Array.isArray(trades) ? trades : [];
  const byWallet = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of list) {
    if (t.pnlUsd === undefined || !Number.isFinite(t.pnlUsd)) continue;
    const w = String(t.wallet || '');
    if (!w) continue;
    const rec = byWallet.get(w) ?? { pnl: 0, trades: 0, wins: 0 };
    rec.pnl += t.pnlUsd;
    rec.trades += 1;
    if (t.pnlUsd > 0) rec.wins += 1;
    byWallet.set(w, rec);
  }
  return [...byWallet.entries()]
    .map(([wallet, rec]) => ({
      wallet,
      realizedPnlUsd: rec.pnl,
      trades: rec.trades,
      winRatePct: rec.trades > 0 ? (rec.wins / rec.trades) * 100 : 0,
    }))
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
}

export interface CopyTradeSizingConfig {
  baseNotionalUsd?: number;
  maxNotionalUsd?: number;
  minNotionalUsd?: number;
}

export const DEFAULT_COPY_TRADE_CONFIG: CopyTradeSizingConfig = {
  baseNotionalUsd: 100,
  maxNotionalUsd: 500,
  minNotionalUsd: 10,
};

/**
 * Wire SRC-108 copy sizing + paper broker into trader-following. Uses the
 * Solana copy-trade kernel's proportional sizing, then records a dry-run fill
 * that never touches a live executor.
 */
export async function sizeAndPaperCopyTrade(
  tokenAddress: string,
  leaderMultiplier: number,
  midPriceUsd: number,
  cfg: CopyTradeSizingConfig = {}
): Promise<{ suggestedUsd: number; accepted: boolean; fill?: PaperFill; reason?: string }> {
  const config = { ...DEFAULT_COPY_TRADE_CONFIG, ...cfg };
  const suggestedUsd = sizeCopyPosition(config.baseNotionalUsd!, leaderMultiplier, {
    baseNotionalUsd: config.baseNotionalUsd!,
    maxNotionalUsd: config.maxNotionalUsd!,
    minNotionalUsd: config.minNotionalUsd!,
  });
  if (suggestedUsd <= 0) {
    return { suggestedUsd, accepted: false, reason: 'invalid copy sizing inputs' };
  }
  const res = await new PaperBroker().submitFill({
    tokenAddress,
    side: 'buy',
    sizeUsd: suggestedUsd,
    midPriceUsd,
    slippagePct: 0,
  });
  return { suggestedUsd, accepted: res.accepted, fill: res.fill, reason: res.reason };
}

export interface CopyTradeHesitationEntryOptions {
  agent?: string;
  claim?: string;
  ttlMs?: number;
  weight?: number;
  createdAt?: number;
}

const DEFAULT_HESITATION_TTL_MS = 60 * 60 * 1000;

/**
 * Wallet-tracker wrapper around the SRC-155 hesitation memory kernel. Keys by
 * token address so a flag from security blocks the copy path until a later
 * clear (or expiry) lets it through again.
 */
export class CopyTradeHesitation {
  private readonly memory: HesitationMemory;

  constructor(now: () => number = Date.now) {
    this.memory = new HesitationMemory(now);
  }

  public flag(tokenAddress: string, opts: CopyTradeHesitationEntryOptions = {}): void {
    this.remember('flag', tokenAddress, opts);
  }

  public clear(tokenAddress: string, opts: CopyTradeHesitationEntryOptions = {}): void {
    this.remember('clear', tokenAddress, opts);
  }

  public brief(tokenAddress: string): HesitationBrief {
    return this.memory.brief(this.keyFor(tokenAddress));
  }

  public shouldCopy(tokenAddress: string): { ok: boolean; status: MemoryStatus; reason?: string } {
    const brief = this.brief(tokenAddress);
    if (brief.status === 'FLAGGED') {
      return {
        ok: false,
        status: brief.status,
        reason: `copy blocked by hesitation flag for ${tokenAddress}`,
      };
    }
    return { ok: true, status: brief.status };
  }

  private keyFor(tokenAddress: string): string {
    return `copy-trade:${String(tokenAddress || '').toLowerCase()}`;
  }

  private remember(kind: MemoryKind, tokenAddress: string, opts: CopyTradeHesitationEntryOptions): void {
    const createdAt = opts.createdAt ?? Date.now();
    this.memory.remember({
      id: `${kind}:${this.keyFor(tokenAddress)}:${createdAt}`,
      key: this.keyFor(tokenAddress),
      agent: opts.agent ?? 'wallet-tracker',
      kind,
      claim: opts.claim ?? (kind === 'flag' ? 'flagged copy target' : 'cleared copy target'),
      createdAt,
      ttlMs: opts.ttlMs ?? DEFAULT_HESITATION_TTL_MS,
      weight: opts.weight ?? 1,
    });
  }
}

export interface GuardedCopyTradeResult {
  suggestedUsd: number;
  accepted: boolean;
  fill?: PaperFill;
  reason?: string;
  status: MemoryStatus;
}

/** Copy sizing gated by the hesitation memory ledger before any paper fill. */
export async function sizeCopyTradeGuarded(
  tokenAddress: string,
  leaderMultiplier: number,
  midPriceUsd: number,
  hesitation: CopyTradeHesitation,
  cfg: CopyTradeSizingConfig = {}
): Promise<GuardedCopyTradeResult> {
  const guard = hesitation.shouldCopy(tokenAddress);
  if (!guard.ok) {
    return {
      suggestedUsd: 0,
      accepted: false,
      reason: `${guard.reason} (${guard.status})`,
      status: guard.status,
    };
  }
  const res = await sizeAndPaperCopyTrade(tokenAddress, leaderMultiplier, midPriceUsd, cfg);
  return { ...res, status: guard.status };
}

export interface SolanaTimeOnCurveOptions {
  chains?: readonly string[];
  minAgeHours?: number;
}

/** Solana-only time-on-curve filter wired into the tracker path. */
export function assessSolanaTimeOnCurve(
  token: string,
  graduatedAtMs: number,
  loader: TimeOnCurveAssessOptions['loader'],
  opts: SolanaTimeOnCurveOptions = {}
): Promise<TimeOnCurveResult> {
  return new TimeOnCurveFilter({ chains: opts.chains }).assess({
    token,
    chain: 'sol',
    graduatedAtMs,
    loader,
    minAgeHours: opts.minAgeHours,
  });
}

export interface GarchVolSizedCopy {
  suggestedUsd: number;
  forecastVolPct: number | null;
  validated: boolean;
  reason: string;
}

/**
 * Wallet-tracker copy-sizing wrapper around the Q14 GARCH walk-forward kernel.
 * Sizes are only accepted after the honest-harness gate proves the vol estimate,
 * then scaled down as forecast vol rises. Fail-closed: anything short or invalid
 * returns 0 suggested size.
 */
export function sizeCopyByGarchVol(
  returns: number[],
  params: GarchParams,
  baseUsd: number,
  targetVolPct: number,
): GarchVolSizedCopy {
  const list = Array.isArray(returns) ? returns : [];
  if (list.length < 8) {
    return {
      suggestedUsd: 0,
      forecastVolPct: null,
      validated: false,
      reason: 'too few returns to validate honestly',
    };
  }

  const harness = garchHarnessValidation(list, params);
  if (!harness.valid) {
    return {
      suggestedUsd: 0,
      forecastVolPct: null,
      validated: false,
      reason: harness.reason,
    };
  }

  const forecast = garchWalkForward(list, params);
  if (forecast.vols.length === 0 || !Number.isFinite(forecast.nextVol)) {
    return {
      suggestedUsd: 0,
      forecastVolPct: null,
      validated: false,
      reason: 'degenerate or non-finite GARCH forecast',
    };
  }

  const forecastVolPct = forecast.nextVol * 100;
  return {
    suggestedUsd: volTargetSize(baseUsd, forecastVolPct, targetVolPct),
    forecastVolPct,
    validated: true,
    reason: harness.reason,
  };
}

/**
 * Wallet-tracker copy-path wrapper around the PR8 causal next-close simulator.
 * Orders fill on the next observed close, never on the decision bar, and gap
 * fills are cancelled instead of guessed. Additive: existing paper-broker paths
 * are unchanged.
 */
export function simulateCopyReplay(
  bars: NextCloseBar[],
  orders: NextCloseOrder[],
  config: NextCloseConfig = {},
): NextCloseResult {
  return simulateNextClose(bars, orders, config);
}

export interface ConcentrationResult {
  topNUsd: number;
  totalUsd: number;
  concentrationPct: number | null;
  topWallets: Array<{ wallet: string; usd: number }>;
}

/**
 * Share of traded USD concentrated in the top-N wallets. Fail-closed: null
 * concentration (not 0) when there is no volume.
 */
export function traderConcentration(
  trades: WalletTradeRecord[],
  topN: number
): ConcentrationResult {
  const list = Array.isArray(trades) ? trades : [];
  const n = Math.max(1, Math.floor(topN));
  const byWallet = new Map<string, number>();
  let totalUsd = 0;
  for (const t of list) {
    const w = String(t.wallet || '');
    if (!w) continue;
    const usd = Number.isFinite(t.usd) ? t.usd : 0;
    byWallet.set(w, (byWallet.get(w) ?? 0) + usd);
    totalUsd += usd;
  }
  const sorted = [...byWallet.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, n);
  const topNUsd = top.reduce((a, [, usd]) => a + usd, 0);
  return {
    topNUsd,
    totalUsd,
    concentrationPct: totalUsd > 0 ? (topNUsd / totalUsd) * 100 : null,
    topWallets: top.map(([wallet, usd]) => ({ wallet, usd })),
  };
}

export interface BundleDetectionOptions {
  windowSec?: number;
  minWallets?: number;
}

export interface Bundle {
  token: string;
  wallets: string[];
  totalUsd: number;
  lastBlockTime?: number;
}

/**
 * Detect "bundle" buys: >= minWallets distinct wallets buying the same token
 * within a time window. Only buy-side trades count; fail-open [].
 */
export function detectBundles(
  trades: WalletTradeRecord[],
  options: BundleDetectionOptions = {}
): Bundle[] {
  const list = Array.isArray(trades) ? trades : [];
  const windowSec = options.windowSec ?? 60;
  const minWallets = options.minWallets ?? 2;
  const byToken = new Map<string, WalletTradeRecord[]>();
  for (const t of list) {
    if (t.side !== 'buy') continue;
    if (t.blockTime === undefined) continue;
    const tok = String(t.token || '');
    if (!tok) continue;
    const bucket = byToken.get(tok) ?? [];
    bucket.push(t);
    byToken.set(tok, bucket);
  }

  const bundles: Bundle[] = [];
  for (const [token, bucket] of byToken) {
    const sorted = [...bucket].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
    let start = 0;
    for (let i = 0; i < sorted.length; i++) {
      while (
        (sorted[i]!.blockTime ?? 0) - (sorted[start]!.blockTime ?? 0) > windowSec
      ) {
        start++;
      }
      const windowWallets = new Set(
        sorted.slice(start, i + 1).map((t) => String(t.wallet || ''))
      );
      if (windowWallets.size >= minWallets) {
        const group = sorted.slice(start, i + 1);
        bundles.push({
          token,
          wallets: [...windowWallets],
          totalUsd: group.reduce((a, t) => a + (Number.isFinite(t.usd) ? t.usd : 0), 0),
          lastBlockTime: group[group.length - 1]!.blockTime,
        });
        start = i + 1;
      }
    }
  }
  return bundles;
}

export interface RetryBackoffOptions {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  /** Whether the error is retryable. Default: true for HTTP 429/5xx, else false. */
  isRetryable?: (err: Error & { status?: number }) => boolean;
}

/**
 * kol-quest retry/429-backoff. Retries `fn` up to `maxRetries` with capped
 * exponential backoff when the error is retryable. Rethrows the last error
 * once the retry budget is exhausted.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryBackoffOptions = {}
): Promise<T> {
  const maxRetries = Math.max(1, Math.floor(options.maxRetries ?? 3));
  const baseMs = Math.max(1, options.baseMs ?? 100);
  const maxMs = Math.max(baseMs, options.maxMs ?? 2000);
  const isRetryable =
    options.isRetryable ??
    ((err: Error & { status?: number }) =>
      err?.status === 429 || (err?.status ?? 0) >= 500);

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const e = err as Error & { status?: number };
      if (attempt >= maxRetries || !isRetryable(e)) throw err;
      const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Idempotent poll+ingest merge: merges incoming records into an existing map
 * keyed by `keyOf`, with later records replacing earlier ones for the same key.
 */
export function dedupMerge<T>(
  existing: Map<string, T>,
  incoming: T[],
  keyOf: (record: T) => string
): Map<string, T> {
  const list = Array.isArray(incoming) ? incoming : [];
  const merged = new Map(existing);
  for (const record of list) {
    merged.set(keyOf(record), record);
  }
  return merged;
}