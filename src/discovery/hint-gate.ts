/**
 * Phase 6 — Hint gate (enforce the candidate-hints.ts pipeline for recall-only
 * sources). FOMO/GMGN say "this looks interesting", not "this token exists".
 * Only a canonical on-chain introducer (or an on-chain existence check) may
 * promote an address into the candidate universe. This gate makes that rule the
 * LIVE path for FOMO/GMGN rows:
 *
 *   rows → record into HintRegistry → drainChecked(chain-aware existence oracle)
 *               ↓ only exists:true     ↓ transport down → fail OPEN + cooldown
 *          promoted rows               rows flow as before (prior behavior)
 *
 * The oracle is composed via `chainAwareVerifier` over the two existence
 * primitives the system already owns (`rpc-verify.ts`): EVM `eth_getCode` and
 * Solana `getTokenLargestAccounts`. Transport failures (RPC unreachable) return
 * transportDown=true so the gate NEVER silently starves the funnel — instead it
 * demotes to the prior behavior for that pass and registers a cooldown (per
 * `source-quota.ts`), exactly as the plan requires.
 */

import type { Chain, GMGNRawToken } from '../adapters/gmgn-adapter.js';
import { globalCandidateRegistry } from './discovery-registry.js';
import {
  HintRegistry,
  chainAwareVerifier,
  globalHintRegistry,
  type CandidateHint,
  type HintSource,
} from './candidate-hints.js';
import { evmTokenExists, solanaMintExists, type ExistencePrims } from '../services/onchain/rpc-verify.js';
import { globalSourceQuota, classifyHttpFailure } from '../services/source-quota.js';

/** Map a normalized chain name onto the RpcVerify EVM key ('' → not EVM). */
function evmKeyFor(chain: string): 'rh' | 'eth' | 'bsc' | 'base' | '' {
  const c = chain.toLowerCase();
  if (c === 'sol') return '';
  if (c === 'eth') return 'eth';
  if (c === 'bsc') return 'bsc';
  if (c === 'base') return 'base';
  return 'rh'; // robinhood + legacy EVM default
}

export interface HintGateOptions {
  /** Registry to record/drain into. Defaults to the process-wide ledger. */
  registry?: HintRegistry;
  /** RPC transport prims. Defaults to the real failover pool (+ global fetch). */
  prims?: ExistencePrims;
  /** Coordinator-known predicate: skip the existence check for already-canonical
   *  addresses (verify-only-if-not-already-canonical). Defaults to the global
   *  CandidateRegistry having already observed the address. */
  isCanonical?: (chain: string, address: string) => boolean;
  quota?: typeof globalSourceQuota;
  now?: () => number;
}

export interface HintGateResult {
  /** Rows to promote (verified-canonical + verified-real). Empty when fail-open
   *  was NOT triggered but everything failed; = the input when transport-down. */
  promoted: GMGNRawToken[];
  /** True when the oracle was unreachable — caller should use PRIOR behavior. */
  transportDown: boolean;
  verified: number;
  skippedCanonical: number;
}

export class HintGate {
  private readonly registry: HintRegistry;
  private readonly prims: ExistencePrims;
  private readonly isCanonical: (chain: string, address: string) => boolean;
  private readonly quota: typeof globalSourceQuota;
  private readonly now: () => number;

  constructor(opts: HintGateOptions = {}) {
    this.registry = opts.registry ?? globalHintRegistry;
    this.prims = opts.prims ?? {};
    this.isCanonical =
      opts.isCanonical ??
      ((chain, address) => {
        const rec = globalCandidateRegistry.get(`${chain}:${address.toLowerCase()}`);
        return rec !== undefined && rec.firstSource !== null;
      });
    this.quota = opts.quota ?? globalSourceQuota;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Chain-aware existence oracle wired to the real RPC primitives. */
  private verify = (hint: CandidateHint) => {
    const evm = evmKeyFor(hint.chain);
    if (hint.chain.toLowerCase() === 'sol') {
      return solanaMintExists(hint.address, this.prims);
    }
    if (evm) return evmTokenExists(evm, hint.address, this.prims);
    return Promise.resolve({ exists: false, transportDown: false });
  };

  /**
   * Route candidate rows (from a recall-only source) through the hint pipeline.
   * Records every row into the registry, then drains with the chain-aware oracle.
   * - exists:true   → promoted.
   * - exists:false  → dropped (phantom / serial-deployer never promoted; fail-closed).
   * - transportDown → FAIL OPEN: registers a cooldown for the source and returns
   *                   the whole input so the funnel keeps flowing with prior behavior.
   */
  public async gate(rows: GMGNRawToken[], chain: Chain, source: HintSource): Promise<HintGateResult> {
    if (!rows || rows.length === 0) return { promoted: [], transportDown: false, verified: 0, skippedCanonical: 0 };

    const hints: CandidateHint[] = [];
    const byAddress = new Map<string, GMGNRawToken>();
    let skippedCanonical = 0;

    for (const row of rows) {
      if (!row?.address) continue;
      const addr = row.address.toLowerCase();
      if (this.isCanonical(chain, addr)) {
        skippedCanonical += 1; // already coordinator-known → skip existence check
        byAddress.set(addr, row);
        continue;
      }
      byAddress.set(addr, row);
      hints.push({ chain, address: row.address, source, at: this.now() });
    }

    // Cheap dedup + evidence ledger: record the batch, then drain with the oracle.
    this.registry.recordBatch(hints);
    const { promoted, transportDown } = await this.registry.drainChecked(this.verify);

    // Fail open at the transport level: never starve the funnel because the RPC
    // oracle is down. Register a cooldown so we don't hammer a dead transport.
    if (transportDown) {
      this.quota.backoff(`hint-${source}`, 'transient', this.now());
    }

    const promotedAddrs = new Set<string>(promoted.map((p) => p.address.toLowerCase()));
    const out: GMGNRawToken[] = [];
    for (const [addr, row] of byAddress) {
      if (transportDown || promotedAddrs.has(addr) || this.isCanonical(chain, addr)) {
        out.push(row);
      }
    }

    return {
      promoted: out,
      transportDown,
      verified: promotedAddrs.size,
      skippedCanonical,
    };
  }
}

/** Process-wide gate wired to the real RPC pool + global candidate registry. */
export const globalHintGate = new HintGate();