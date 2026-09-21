import { createPublicClient, http } from 'viem';
import { robinhood } from 'viem/chains';
import { PositionManager } from '../position/position-manager.js';
import { StateStore } from '../services/state-store.js';
import { WalletService } from '../services/wallet-service.js';
import { TradeJournalService } from '../services/trade-journal-service.js';
import { GMGNAdapter, type GMGNTrackTrade } from '../adapters/gmgn-adapter.js';
import { PaperBroker, sizeCopyPosition, type PaperFill } from './solana-copy-trade.js';
import { HesitationMemory, type HesitationBrief, type MemoryKind, type MemoryStatus } from './hesitation-memory.js';

export type EvmBalanceReader = (chain: string, token: string, owner: string) => Promise<bigint | null>;

export interface WalletTrackerDeps {
  positionManager: PositionManager;
  stateStore?: StateStore;
  gmgn?: GMGNAdapter;
  walletService?: WalletService;
  tradeJournal?: TradeJournalService;
  evmBalanceReader?: EvmBalanceReader;
  exitMinWallets?: number;
  exitMinUsd?: number;
  exitWindowMs?: number;
  exitAlertsEnabled?: boolean;
  /** SL magnitude to tighten to (0.2 = -20%) on a smart-money full-close exit of a held token. */
  exitSLTightenPct?: number;
}

export interface WalletHolding {
  chain: 'robinhood';
  address: string;
  amount: number;
}

export interface WalletAlert {
  type: string;
  reason: string;
  address: string;
}

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export class WalletTracker {
  private positionManager: PositionManager;
  private stateStore?: StateStore;
  private gmgn?: GMGNAdapter;
  private walletService?: WalletService;
  private tradeJournal?: TradeJournalService;
  private evmBalanceReader: EvmBalanceReader;
  private exitMinWallets: number;
  private exitMinUsd: number;
  private exitWindowMs: number;
  private exitAlertsEnabled: boolean;
  private exitSLTightenPct: number;

  constructor(deps: WalletTrackerDeps) {
    this.positionManager = deps.positionManager;
    this.stateStore = deps.stateStore;
    this.gmgn = deps.gmgn;
    this.walletService = deps.walletService;
    this.tradeJournal = deps.tradeJournal;
    this.evmBalanceReader = deps.evmBalanceReader ?? this.defaultEvmBalanceReader;
    this.exitMinWallets = deps.exitMinWallets ?? 2;
    this.exitMinUsd = deps.exitMinUsd ?? 20_000;
    this.exitWindowMs = deps.exitWindowMs ?? 2 * 60 * 60 * 1000;
    this.exitAlertsEnabled = deps.exitAlertsEnabled ?? true;
    this.exitSLTightenPct = deps.exitSLTightenPct ?? 0.2;
  }

  private defaultEvmBalanceReader: EvmBalanceReader = async (_chain, token, owner) => {
    try {
      const rpc = process.env.EVM_ROBINHOOD_RPC_URL || undefined;
      const publicClient = createPublicClient({ chain: robinhood, transport: http(rpc) });
      return await publicClient.readContract({
        address: token as `0x${string}`,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [owner as `0x${string}`],
      });
    } catch {
      return null;
    }
  };

  /** Scan tracked robinhood tokens for non-zero balances. Fail-closed []. */
  public async scanEvmHoldings(): Promise<Array<{ address: string; amount: number }>> {
    return (await this.scanEvmHoldingsSafe()).holdings;
  }

  private async scanEvmHoldingsSafe(): Promise<{
    holdings: Array<{ address: string; amount: number }>;
    ok: boolean;
    scannedOk: Set<string>;
  }> {
    if (!this.stateStore || !this.walletService || !this.walletService.hasWallet('evm')) {
      return { holdings: [], ok: false, scannedOk: new Set() };
    }
    try {
      const owner = this.walletService.getEvmAddress();
      const tracked = this.stateStore.getTrackedTokens().filter((t) => t.chain === 'robinhood');
      const holdings: Array<{ address: string; amount: number }> = [];
      const scannedOk = new Set<string>();
      for (const tok of tracked) {
        const balance = await this.evmBalanceReader(tok.chain, tok.address, owner);
        if (balance === null) {
          console.warn(`[WALLET TRACKER] EVM balance read failed for ${tok.symbol} (${tok.address}) — excluded from scan`);
          continue;
        }
        scannedOk.add(tok.address.toLowerCase());
        if (balance > 0n) holdings.push({ address: tok.address, amount: Number(balance) });
      }
      return { holdings, ok: true, scannedOk };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[WALLET TRACKER] EVM holdings scan failed: ${message}`);
      return { holdings: [], ok: false, scannedOk: new Set() };
    }
  }

  /** Persist a token as an auto-tracking target (deduped by chain + address in StateStore). */
  public registerTrackedToken(chain: 'robinhood' | 'sol' | 'bsc' | 'base' | 'eth', address: string, symbol: string): void {
    this.stateStore?.setTrackedToken({ chain, address, symbol, addedAt: Date.now() });
  }

  public async syncPositions(): Promise<WalletAlert[]> {
    const alerts: WalletAlert[] = [];
    const evmScan = await this.scanEvmHoldingsSafe();

    const holdings: WalletHolding[] = evmScan.holdings.map((h) => ({ chain: 'robinhood' as const, address: h.address, amount: h.amount }));

    // Dedupe by address (case-insensitive)
    const seen = new Set<string>();
    const deduped = holdings.filter((h) => {
      const key = h.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const active = this.positionManager.getActivePositions();
    const heldAddresses = new Set(deduped.map((h) => h.address.toLowerCase()));

    for (const holding of deduped) {
      const tok = this.gmgn ? await this.gmgn.fetchTokenInfo(holding.chain, holding.address) : null;
      if (!tok) {
        console.warn(`[WALLET TRACKER] Skipping ${holding.chain} holding ${holding.address}: token info unavailable`);
        continue;
      }
      const pos = active.find((p) => p.contractAddress.toLowerCase() === holding.address.toLowerCase());
      if (!pos) {
        this.positionManager.addPosition({
          id: holding.address,
          symbol: tok.symbol || 'TOKEN',
          contractAddress: holding.address,
          entryPriceUsd: tok.priceUsd,
          currentPriceUsd: tok.priceUsd,
          amount: holding.amount || 0,
          highWaterMarkUsd: tok.priceUsd,
          initialVolume4hUsd: tok.volume24hUsd / 6,
          initialSmartMoneyCount: tok.smartDegenCount,
        });
        console.log(`[WALLET TRACKER] Added auto-tracked position ${tok.symbol} (${holding.address}) at $${tok.priceUsd}`);
      } else {
        const res = this.positionManager.updateMemePosition(pos.id, tok.priceUsd, tok.volume24hUsd / 6, tok.smartDegenCount);
        if (res.triggerAlert) {
          alerts.push({ type: res.type, reason: res.reason || '', address: holding.address });
        }
        // Feed current price into Swarm Learning — outcome tracking (TP/SL) that
        // recalibrates agent weights based on real results. (wired 2026-08-08)
        try {
          const { globalSwarmLearning } = await import('../orchestrator/swarm-learning.js');
          globalSwarmLearning.updateSignalPrice(holding.address, tok.priceUsd);
        } catch (learnErr: any) {
          // non-fatal — learning must never break position tracking
          console.warn(`[SWARM LEARNING] price update failed for ${holding.address}: ${learnErr.message}`);
        }
      }
    }

    // Auto-close positions no longer held — but only when the scan actually ran
    // successfully (fail-closed scans report ok: false, so they never trigger mass
    // closes). A close is only allowed when the position's contract address was
    // actually read successfully (scannedOk), so a single failed balanceOf read can
    // never look like a "not held" and trigger a wrongful auto-close.
    if (evmScan.ok) {
      for (const pos of active) {
        if (heldAddresses.has(pos.contractAddress.toLowerCase())) continue;
        if (!evmScan.scannedOk.has(pos.contractAddress.toLowerCase())) continue;
        this.positionManager.removePosition(pos.id);
        // Close any OPEN journal entry for this contract — exit PnL audit trail.
        try {
          const closed = this.tradeJournal?.closeByContractAddressOrId(pos.contractAddress, pos.currentPriceUsd, 'CLOSED_MANUAL', 'wallet auto-close: no longer held');
          if (closed) console.log(`[WALLET TRACKER] Closed ${closed} journal entry(ies) for ${pos.symbol} (${pos.id})`);
        } catch (journalErr: any) {
          console.warn(`[WALLET TRACKER] Journal close failed for ${pos.symbol}: ${journalErr.message}`);
        }
        console.log(`[WALLET TRACKER] Auto-closed position ${pos.symbol} (${pos.id}) — no longer held`);
      }
    }

    // Smart Money Exit alert: only for tokens YOU still hold. Without
    // a position = no trigger (exit signals never become calls).
    if (this.exitAlertsEnabled) {
      try {
        const exitAlerts = await this.checkSmartMoneyExit(active);
        alerts.push(...exitAlerts);
      } catch (exitErr: any) {
        console.warn(`[WALLET TRACKER] Smart money exit check failed (skipped): ${exitErr.message}`);
      }
    }

    return alerts;
  }

  /**
   * Detect Smart Money Exit on positions still being held:
   * >= exitMinWallets smart wallets performing a full-close (side=sell +
   * is_open_or_close=1) within exitWindowMs, total exit >= exitMinUsd.
   * Data from GMGN `/v1/user/smartmoney` (60s cache, fail-open []).
   * Alert only — never affects screening/calls.
   */
  public async checkSmartMoneyExit(activePositions: Array<{ contractAddress: string; symbol?: string }>): Promise<WalletAlert[]> {
    if (!this.gmgn) return [];
    const heldAddrs: Set<string> = new Set();
    for (const p of activePositions) {
      const addr = String(p.contractAddress || '');
      if (!addr) continue;
      heldAddrs.add(addr.toLowerCase());
    }
    if (heldAddrs.size === 0) return [];

    const alerts: WalletAlert[] = [];
    const nowSec = Date.now() / 1000;
    let trades: GMGNTrackTrade[] = [];
    try {
      trades = await this.gmgn.fetchTrackTrades('robinhood', 'smartmoney');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[WALLET TRACKER] Track feed robinhood failed (skipped): ${message}`);
      return alerts;
    }
    if (trades.length === 0) return alerts;
    const { buildTrackAccumulation } = await import('../agents/shared/gmgn-meme-helpers.js');
    const acc = buildTrackAccumulation(trades);
    for (const heldAddr of heldAddrs) {
      const a = acc.get(heldAddr);
      if (!a) continue;
      if (a.fullCloseWallets.size < this.exitMinWallets) continue;
      if (a.fullCloseTotalUsd < this.exitMinUsd) continue;
      if (nowSec - a.lastFullCloseAt > this.exitWindowMs / 1000) continue;
      const mins = Math.max(0, Math.round((nowSec - a.lastFullCloseAt) / 60));
      alerts.push({
        type: 'sm-exit',
        reason: `⚠️ **Smart Money Exit:** $${a.symbol || heldAddr.slice(0, 8)} — ${a.fullCloseWallets.size} smart wallets full-closed $${(a.fullCloseTotalUsd / 1000).toFixed(1)}k in the last ${mins}m. You still hold this position — consider exiting.`,
        address: heldAddr,
      });
      // Smart-money exit on a HELD token ⇒ tighten the SL in the position manager.
      // Never widens; only narrows (Math.min in position-manager); fail-closed no-op if not held.
      const tightened = this.positionManager.tightenStopLoss(heldAddr, this.exitSLTightenPct);
      if (tightened) console.log(`[WALLET TRACKER] 🔒 Tightened SL on ${a.symbol || heldAddr} to -${Math.round(this.exitSLTightenPct * 100)}% (smart-money exit)`);
      console.log(`[WALLET TRACKER] 🚨 SM Exit: ${a.symbol || heldAddr} — ${a.fullCloseWallets.size} wallet full-close $${(a.fullCloseTotalUsd / 1000).toFixed(1)}k`);
    }
    return alerts;
  }
}

/**
 * PR10 - Adapt-Only #2: whale/whale-tracker extensions.
 *
 * Pure, zero-dependency helpers for trader-following, concentration, bundle
 * discovery, batched/deduped balance reads, retry/backoff, and idempotent
 * dedup-merge. These extend the tracker without touching the existing scan or
 * exit-alert paths.
 */

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

export interface BatchBalanceRequest {
  chain: string;
  token: string;
  owner: string;
}

/**
 * GMGN-style batch balance reader with in-flight dedupe: concurrent reads of
 * the same chain:token:owner collapse to a single underlying call, and
 * `readMany` maps a batch of requests (fail-closed null per failed read).
 */
export class BalanceBatchReader {
  private inFlight = new Map<string, Promise<bigint | null>>();

  constructor(private readonly readOne: EvmBalanceReader) {}

  private key(req: BatchBalanceRequest): string {
    return `${req.chain}:${req.token.toLowerCase()}:${req.owner.toLowerCase()}`;
  }

  async read(chain: string, token: string, owner: string): Promise<bigint | null> {
    const key = `${chain}:${token.toLowerCase()}:${owner.toLowerCase()}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = Promise.resolve(this.readOne(chain, token, owner)).catch(() => null);
    this.inFlight.set(key, p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async readMany(requests: BatchBalanceRequest[]): Promise<Map<string, bigint | null>> {
    const list = Array.isArray(requests) ? requests : [];
    const results = new Map<string, bigint | null>();
    await Promise.all(
      list.map(async (req) => {
        results.set(this.key(req), await this.read(req.chain, req.token, req.owner));
      })
    );
    return results;
  }
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
