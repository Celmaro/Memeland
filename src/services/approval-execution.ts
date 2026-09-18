/**
 * Phase-2/3 execution helper — the one place a meme buy (auto-execute OR
 * one-click operator approve) turns into an EVM buy + trade-journal OPEN entry
 * + executed funnel bump. Kept dependency-injected so it stays unit-testable
 * without live network/RPC and so both call sites stay identical.
 */
import type { EVMTradeAdapter } from '../adapters/evm-adapter.js';
import type { WalletService } from './wallet-service.js';
import type { TradeJournalService } from './trade-journal-service.js';

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

  const execRes = await opts.evm.executeBuyToken(
    {
      chain,
      tokenAddress: opts.contractAddress,
      amountEth: opts.amountEth,
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
    positionSizeUsd: opts.amountEth * (opts.entryPriceUsd || 1),
    swarmScore: opts.confidence,
    strategyUsed: opts.strategyUsed || 'approval-approved',
    aiThesisSummary: (opts.thesis || '').slice(0, 200),
    status: 'OPEN',
  });

  opts.onExecuted();
  return {
    success: execRes.success,
    simulated: execRes.simulated,
    outputTokens: execRes.outputTokens,
    error: execRes.error,
  };
}
