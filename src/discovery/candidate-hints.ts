/**
 * P0.3 — CandidateHint pipeline (provider-architecture v2: candidate emitters).
 *
 * Emitters (FOMO API, GMGN) never say "this token exists" — they say "this
 * looks interesting" (recall without authority). The durable rule from the
 * research report: ONLY a canonical introducer (on-chain event) promotes an
 * address into the candidate universe. So emitters land here as CandidateHints
 * and are only *promoted* to a candidate after an on-chain existence check.
 *
 *   record(hint)   -> dedup + queue  (cheap, does NOT touch a live registry)
 *   drain(verify)  -> for each pending hint run verify(), resolve it, and
 *                     return only the hints whose chain verifies them as real.
 *
 * The verify callback is injected so EVM (eth_getCode/eth_call via RPC) and
 * Solana (getTokenLargestAccounts over the Sol RPC) can each provide their own
 * existence oracle, and tests can stub it. Hints that fail verification are
 * recorded as false (so a serial-deployer/phantom address is never promoted).
 */

export type HintSource = 'fomo' | 'gmgn';
export type HintWindow = '24h' | '7d' | '30d';

export interface CandidateHint {
  chain: string; // e.g. 'robinhood' | 'solana' | 'base'
  address: string; // token mint / pair address to verify
  source: HintSource;
  /** When the hint was surfaced (epoch ms). */
  at: number;
  /** Leaderboard window the trader appeared in (FOMO). */
  window?: HintWindow;
  /** Trader PnL % over that window (FOMO leaderboard row). */
  pnlPct?: number;
  /** Trade volume USD over that window (FOMO leaderboard row). */
  volumeUsd?: number;
  /** Handle / trader identifier (FOMO identity-resolve subject). */
  traderHandle?: string;
  /** On-chain wallet addresses resolved for the trader (after identity resolve). */
  wallets?: string[];
  /** Payload retained for the promoted candidate's registry observe(). */
  costCredits?: number;
}

/** Verifies an address truly exists on-chain for the hint's chain. */
export type HintVerifyFn = (hint: CandidateHint) => Promise<{ exists: boolean }>;

export interface HintResolution {
  hint: CandidateHint;
  exists: boolean;
  resolvedAt: number;
}

export class HintRegistry {
  /** Pending (unverified) hints, keyed `${chain}:${address}:${source}`. */
  private pending = new Map<string, CandidateHint>();
  /** Verified resolutions, keyed the same way. */
  private resolutions = new Map<string, HintResolution>();
  private observed = 0;

  private key(h: CandidateHint): string {
    return `${h.chain}:${h.address.toLowerCase()}:${h.source}`;
  }

  /** Queue a candidate hint. Dedups identical chain/address/source re-emits. */
  public record(hint: CandidateHint): void {
    const k = this.key(hint);
    const prev = this.pending.get(k);
    // Keep the newest time/rich fields but never double-queue the same address.
    if (prev) {
      this.pending.set(k, { ...prev, ...hint, at: Math.max(prev.at, hint.at) });
      return;
    }
    this.pending.set(k, hint);
    this.observed += 1;
  }

  public pendingSize(): number {
    return this.pending.size;
  }

  /** Hints still awaiting verification (optionally filtered by chain). */
  public pendingHints(chain?: string): CandidateHint[] {
    const out: CandidateHint[] = [];
    for (const h of this.pending.values()) {
      if (chain && h.chain !== chain) continue;
      out.push(h);
    }
    return out;
  }

  /**
   * Verify every pending hint with `verify`, record the resolution, and clear
   * the pending queue. Returns only the hints that verified as real (promotable
   * to a candidate). Never throws: a failed verification = `exists:false`.
   */
  public async drain(verify: HintVerifyFn): Promise<CandidateHint[]> {
    const promoted: CandidateHint[] = [];
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [k, hint] of batch) {
      let exists = false;
      try {
        ({ exists } = await verify(hint));
      } catch {
        exists = false; // verification failure = not promotable (fail-closed)
      }
      const res: HintResolution = { hint, exists, resolvedAt: Date.now() };
      this.resolutions.set(k, res);
      if (exists) promoted.push(hint);
    }
    return promoted;
  }

  /** Promotable (verified-real) hint resolutions so far. */
  public resolutionsList(): HintResolution[] {
    return [...this.resolutions.values()];
  }

  public resolutionsExists(): HintResolution[] {
    return this.resolutionsList().filter((r) => r.exists);
  }

  public stats(): { observed: number; pending: number; verifiedExists: number; verifiedFalse: number } {
    let exists = 0;
    for (const r of this.resolutions.values()) if (r.exists) exists += 1;
    return {
      observed: this.observed,
      pending: this.pending.size,
      verifiedExists: exists,
      verifiedFalse: this.resolutions.size - exists,
    };
  }
}

/**
 * Chain-aware default verifier: an always-real "exists" oracle is NOT provided
 * here (existence must come from the real transport). Use this to compose one
 * from the two canonical existence checks the system already owns:
 *  - EVM: eth_getCode / eth_call via the RPC pool (address has a token contract)
 *  - Sol: getTokenLargestAccounts over the Sol RPC pool or SPL-create check
 * Pass in per-chain delegate fns; unknown chains resolve to a fail-closed false.
 */
export function chainAwareVerifier(
  verifiers: Record<string, (hint: CandidateHint) => Promise<{ exists: boolean }>>,
): HintVerifyFn {
  return (hint) => {
    const fn = verifiers[hint.chain.toLowerCase()];
    if (!fn) return Promise.resolve({ exists: false });
    return fn(hint);
  };
}

/** Process-wide hint ledger for the screening cycle. */
export const globalHintRegistry = new HintRegistry();