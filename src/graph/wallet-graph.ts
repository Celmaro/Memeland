/**
 * #4 — Wallet Graph (Memeland 2.0 proprietary asset).
 *
 * Builds wallet → funder relationships (funding lineage) and deployer
 * reputation, so the bot stops treating N wallets funded by the same source
 * as N independent economic actors. This directly attacks the double-counting
 * problem: "4 smart-money wallets" is 4 wallets OR 1 deployer's cluster.
 *
 * Funding relationships come from on-chain observations (a funded wallet's
 * source-of-funds); deployer reputation accumulates from token outcomes.
 * Both are append-only so history is preserved.
 */

export interface DeployerReputation {
  address: string;
  launchCount: number;
  rugCount: number;
  successCount: number;
  /** rugs / launches (0 when no launches). */
  rugRate: number;
}

export class WalletGraph {
  /** walletAddress → funderAddress (canonical lowercase). */
  private funderOfWallet = new Map<string, string>();
  /** funderAddress → Set<walletAddress> it funded. */
  private walletByFunder = new Map<string, Set<string>>();
  private deployerOutcomes = new Map<string, Array<'rug' | 'success'>>();

  /** Register that `walletAddress` was funded by `funderAddress`. */
  public registerFunding(funderAddress: string, walletAddress: string): void {
    const k = funderAddress.toLowerCase();
    const w = walletAddress.toLowerCase();
    this.funderOfWallet.set(w, k);
    if (!this.walletByFunder.has(k)) this.walletByFunder.set(k, new Set());
    this.walletByFunder.get(k)!.add(w);
  }

  public funderOf(walletAddress: string): string | undefined {
    return this.funderOfWallet.get(walletAddress.toLowerCase());
  }

  /** True when two wallets trace to the same root funder. */
  public sameCluster(a: string, b: string): boolean {
    const fa = this.funderOf(a);
    const fb = this.funderOf(b);
    return fa !== undefined && fa === fb;
  }

  /**
   * Count how many ECONOMICALLY INDEPENDENT actors a wallet set represents.
   * Wallets sharing a funder collapse to one actor. NaN-safe: unknown wallets
   * count as independent (best-effort, never over-collapses).
   */
  public independentCount(wallets: string[]): number {
    const roots = new Set<string>();
    let unknown = 0;
    for (const w of wallets) {
      const f = this.funderOf(w);
      if (f) roots.add(f);
      else unknown += 1;
    }
    return roots.size + unknown;
  }

  /** Record a token outcome for a deployer. */
  public recordDeployerOutcome(deployerAddress: string, outcome: 'rug' | 'success'): void {
    const k = deployerAddress.toLowerCase();
    if (!this.deployerOutcomes.has(k)) this.deployerOutcomes.set(k, []);
    this.deployerOutcomes.get(k)!.push(outcome);
  }

  public deployerReputation(deployerAddress: string): DeployerReputation {
    const k = deployerAddress.toLowerCase();
    const outcomes = this.deployerOutcomes.get(k) ?? [];
    const rugCount = outcomes.filter((o) => o === 'rug').length;
    const successCount = outcomes.filter((o) => o === 'success').length;
    return {
      address: deployerAddress,
      launchCount: outcomes.length,
      rugCount,
      successCount,
      rugRate: outcomes.length > 0 ? rugCount / outcomes.length : 0,
    };
  }

  public size(): { funders: number; wallets: number; deployers: number } {
    return {
      funders: this.walletByFunder.size,
      wallets: this.funderOfWallet.size,
      deployers: this.deployerOutcomes.size,
    };
  }
}

/** Process-wide singleton for the screening cycle. */
export const globalWalletGraph = new WalletGraph();