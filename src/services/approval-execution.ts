/**
 * Phase-2/3 execution helper — the one place a meme buy (auto-execute OR
 * one-click operator approve) turns into an EVM buy + trade-journal OPEN entry
 * + executed funnel bump. Kept dependency-injected so it stays unit-testable
 * without live network/RPC and so both call sites stay identical.
 */
import type { EVMTradeAdapter } from '../adapters/evm-adapter.js';
import type { WalletService } from './wallet-service.js';
import type { TradeJournalService } from './trade-journal-service.js';
import { DecisionLedger, type TradeProposal } from './decision-ledger.js';

export interface ExecuteMemeBuyOptions {
  evm: EVMTradeAdapter;
  wallet: WalletService;
  journal: TradeJournalService;
  /** Called after the fill is recorded — bumps the `executed` funnel stage. */
  onExecuted: () => void;
  /** Signal chain (payload.network / approval order chain). Defaults to robinhood. */
  chain?: string;
  symbol: string;
  contractAddress: string;
  entryPriceUsd: number;
  amountEth: number;
  confidence: number;
  thesis: string;
  /** Journal strategy label — AUTO gate vs one-click operator approve differ. */
  strategyUsed?: string;
  /** Q15 fail-closed safe-config gate. When provided and NOT safe, the fill is refused. */
  safety?: { isSafe(): { safe: boolean; reason: string } };
  /** Quoter-honeypot sellability proof (rh-execution-core). When provided and NOT sellable, refused. */
  sellability?: { check(tokenAddress: string): Promise<{ sellable: boolean; reason: string }> };
  /** Per-token tx serializer (rh-execution-core TxLock). When provided, only one in-flight tx per token. */
  txLock?: { acquire(tokenAddress: string): Promise<() => void> };
  /** Q07 multi-constraint sizer. When provided, clamps the notional to the binding constraint; refuses on refusal. */
  sizer?: { clamp(desiredUsd: number): { allowed: boolean; amountUsd: number; reason?: string } };
  /** Q08 fill simulation. When provided, refuses fills whose impact is refused / over a cap. */
  fillSim?: { check(input: { amountUsd: number; midPriceUsd: number; liquidityUsd?: number }): { allowed: boolean; impactPct: number; reason?: string } };
  /** Q13 cost gate. When provided, a fill must be within the cumulative cost budget. */
  costGate?: { trySpend(costUsd: number): { allowed: boolean; reason?: string } };
  /** Q11 execution governance. When provided, the order is reserved + receipt-locked before the fill. */
  governance?: { reserve(order: { nonce: string; payload: string }): { reserved: boolean; reason?: string }; issue(order: { nonce: string; payload: string }): { valid: boolean; reason?: string } };
  /** Q09 executor-DI. When provided, the buy is routed through this executor instead of the raw EVM adapter. */
  executor?: { submit(req: { token: string; chainId: number; side: 'buy'; amountUsd: number; timeoutMs?: number }): Promise<{ outcome: 'confirmed' | 'failed' | 'timed_out'; txHash?: string; reason?: string; at: number }> };
  /** Decision ledger audit hook: proposal + send reconciliation for the shared fill path. */
  ledger?: DecisionLedger;
}

export interface ExecuteMemeBuyResult {
  success: boolean;
  simulated: boolean;
  outputTokens: number;
  error?: string;
}

/** Chains with a live execution adapter today. All others fail closed. */
const EXECUTABLE_CHAINS = new Set<string>(['robinhood']);

/** Normalize payload/approval chain labels to the canonical chain key. */
export function normalizeChain(v: string): string {
  const k = String(v || '').trim().toLowerCase();
  const alias: Record<string, string> = {
    robinhood: 'robinhood',
    solana: 'sol',
    sol: 'sol',
    'bnb chain': 'bsc',
    bsc: 'bsc',
    binance: 'bsc',
    base: 'base',
    ethereum: 'eth',
    eth: 'eth',
  };
  return alias[k] ?? k;
}

export async function executeMemeBuy(opts: ExecuteMemeBuyOptions): Promise<ExecuteMemeBuyResult> {
  const chain = normalizeChain(opts.chain || 'robinhood');
  if (!EXECUTABLE_CHAINS.has(chain)) {
    return {
      success: false,
      simulated: false,
      outputTokens: 0,
      error: `no execution adapter for chain '${chain}' — fail-closed (robinhood only)`,
    };
  }

  const nonce = `${opts.contractAddress}:${opts.symbol}:${Date.now()}`;
  const proposal: TradeProposal = {
    agent: opts.strategyUsed || 'auto-execute',
    nonce,
    symbol: opts.symbol,
    chain,
    side: 'BUY',
    sizeEth: opts.amountEth,
    maxSizeEth: opts.amountEth,
    confidence: (opts.confidence || 0) / 100,
  };
  opts.ledger?.recordProposed(proposal);

  // ── Q15 fail-closed safety gate ─────────────────────────────────────────
  // When a safe-config registry is injected, an explicit-safe config must be
  // in force or the fill is refused (read-only default; remediate to enable).
  if (opts.safety) {
    const s = opts.safety.isSafe();
    if (!s.safe) {
      return { success: false, simulated: false, outputTokens: 0, error: `safety gate refused: ${s.reason}` };
    }
  } else {
    console.warn('[EXEC] no safety gate injected — fills proceed unguarded (tests / unconfigured only)');
  }

  // ── Quoter-honeypot sellability proof (fail-closed) ─────────────────────
  if (opts.sellability) {
    const s = await opts.sellability.check(opts.contractAddress);
    if (!s.sellable) {
      return { success: false, simulated: false, outputTokens: 0, error: `sellability gate refused: ${s.reason}` };
    }
  }

  // ── Q07 multi-constraint sizing (USD notional clamp) ────────────────────
  const desiredUsd = opts.amountEth * (opts.entryPriceUsd || 0);
  let effectiveAmountEth = opts.amountEth;
  if (opts.sizer) {
    const s = opts.sizer.clamp(desiredUsd);
    if (!s.allowed) {
      return { success: false, simulated: false, outputTokens: 0, error: `sizing gate refused: ${s.reason}` };
    }
    if (s.amountUsd > 0 && opts.entryPriceUsd > 0) effectiveAmountEth = s.amountUsd / opts.entryPriceUsd;
  }

  // ── Q08 fill simulation (impact / liquidity proof, fail-closed) ─────────
  if (opts.fillSim) {
    const s = opts.fillSim.check({ amountUsd: desiredUsd, midPriceUsd: opts.entryPriceUsd, liquidityUsd: opts.entryPriceUsd > 0 ? opts.entryPriceUsd * 1000 : undefined });
    if (!s.allowed) {
      return { success: false, simulated: false, outputTokens: 0, error: `fill-sim gate refused: ${s.reason} (impact ${s.impactPct.toFixed(1)}%)` };
    }
  }

  // ── Q13 cost gate (cumulative fill-cost budget) ─────────────────────────
  if (opts.costGate) {
    const c = opts.costGate.trySpend(desiredUsd);
    if (!c.allowed) {
      return { success: false, simulated: false, outputTokens: 0, error: `cost gate refused: ${c.reason}` };
    }
  }

  // ── Q11 execution governance (idempotent reservation + hash-locked receipt) ──
  if (opts.governance) {
    const payload = JSON.stringify({ chain, token: opts.contractAddress, amountUsd: desiredUsd });
    const reserved = opts.governance.reserve({ nonce, payload });
    if (!reserved.reserved) {
      return { success: false, simulated: false, outputTokens: 0, error: `governance reservation refused: ${reserved.reason}` };
    }
    const receipt = opts.governance.issue({ nonce, payload });
    if (!receipt.valid) {
      return { success: false, simulated: false, outputTokens: 0, error: `governance receipt refused: ${receipt.reason}` };
    }
  }

  // ── Per-token tx serialization (TxLock) ─────────────────────────────────
  const release = opts.txLock ? await opts.txLock.acquire(opts.contractAddress) : null;
  try {
    // Q09 executor-DI: when an executor is provided, route the fill through it
    // (serialized + veto-with-reason) instead of the raw EVM adapter.
    const execRes = opts.executor
      ? await (async () => {
          const r = await opts.executor!.submit({
            token: opts.contractAddress,
            chainId: 4663,
            side: 'buy',
            amountUsd: desiredUsd,
            timeoutMs: 15_000,
          });
          return {
            success: r.outcome === 'confirmed',
            simulated: false,
            outputTokens: 0,
            error: r.outcome === 'confirmed' ? undefined : (r.reason || r.outcome),
          };
        })()
      : await opts.evm.executeBuyToken(
          {
            chain,
            tokenAddress: opts.contractAddress,
            amountEth: effectiveAmountEth,
            slippagePercentage: 1.5,
          },
          opts.wallet
        );

    opts.journal.recordTradeEntry({
      id: `TRADE_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      domain: 'MEME_ROBINHOOD',
      symbol: opts.symbol || 'TOKEN',
      contractAddressOrId: opts.contractAddress || opts.symbol || 'N/A',
      chain,
      entryTimestamp: new Date().toISOString(),
      entryPriceUsdOrEth: opts.entryPriceUsd,
      positionSizeUsd: effectiveAmountEth * (opts.entryPriceUsd || 1),
      swarmScore: opts.confidence,
      strategyUsed: opts.strategyUsed || 'approval-approved',
      aiThesisSummary: (opts.thesis || '').slice(0, 200),
      status: 'OPEN',
    });

    opts.onExecuted();
    opts.ledger?.recordSend(nonce, execRes.success ? 'confirmed' : 'failed');
    return {
      success: execRes.success,
      simulated: execRes.simulated,
      outputTokens: execRes.outputTokens,
      error: execRes.error,
    };
  } finally {
    release?.();
  }
}
