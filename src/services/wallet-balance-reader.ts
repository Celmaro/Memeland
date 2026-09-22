/**
 * KC7 / Kernel R — WalletBalanceReader.
 *
 * The `walletService.getEvmBalance(4663)` call pattern (hard-coded Robinhood
 * Chain id 4663) is duplicated across 6 call sites: index.ts, cli/tui.ts,
 * discord/handlers/command-handlers.ts (×2), discord/handlers/
 * interaction-buttons.ts, orchestrator/tool-registry.ts. This reader folds
 * the default chain id into one dependency surface so a future multi-chain
 * migration (or chain-id change) touches a single file.
 */

import type { BalanceResult } from './wallet-service.js';

export type BalanceProvider = Pick<WalletServiceLike, 'getEvmBalance'>;

/** Minimal structural type — accepts the real WalletService or a mock. */
export interface WalletServiceLike {
  getEvmBalance(chainId: number): Promise<BalanceResult | null>;
}

/** Robinhood Chain is the default EVM balance source for this bot. */
export const DEFAULT_BALANCE_CHAIN_ID = 4663;

export class WalletBalanceReader {
  private readonly wallet: BalanceProvider;
  private readonly defaultChainId: number;

  constructor(wallet: BalanceProvider, defaultChainId: number = DEFAULT_BALANCE_CHAIN_ID) {
    this.wallet = wallet;
    this.defaultChainId = defaultChainId;
  }

  /** Native balance on the default chain (Robinhood Chain unless overridden). */
  public async getEvmBalance(chainId: number = this.defaultChainId): Promise<BalanceResult | null> {
    return this.wallet.getEvmBalance(chainId);
  }

  /**
   * Convenience: balance × priceUsd. Returns null when either side is
   * unavailable (fail-open — callers treat null as 'skip this contribution').
   */
  public async getEthEquivalentUsd(priceUsd: number | null, chainId?: number): Promise<number | null> {
    if (priceUsd === null) return null;
    const bal = await this.getEvmBalance(chainId);
    if (!bal) return null;
    return bal.balance * priceUsd;
  }
}