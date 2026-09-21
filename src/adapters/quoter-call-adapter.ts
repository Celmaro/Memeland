/**
 * PR 2 / Kernel E — Result<T,E> → legacy QuoterCall adapter (the missing Week 2
 * of the G2 deprecation plan). Bridges the canonical `EvmAdapter.call()`
 * Result contract into the legacy `{ ok, output? }` shape that
 * `assessSellability` in rh-execution-core expects.
 *
 * This is the FIRST production caller of `EvmAdapter.call()`. With this in
 * place, the G2 deprecation can finish (Week 3: remove `callLegacy`).
 *
 * Additive: no existing signature changes. The previous QuoterCall contract
 * still works for callers that don't want to migrate.
 */

import { EvmAdapter, type EvmCallRequest } from './evm-adapter.js';
import type { QuoterCall } from '../services/rh-execution-core.js';

/**
 * Bridge `EvmAdapter.call()` (Result<Bytes, AdapterError>) into the legacy
 * `{ ok, output? }` shape that assessSellability consumes. The conversion is
 * lossless: every Result<T,E> error collapses into `{ ok: false }` and an
 * empty output is also `{ ok: false }` (assessSellability treats both as
 * "fail-closed: cannot sell").
 */
export function evmAdapterToQuoterCall(adapter: EvmAdapter, base: Omit<EvmCallRequest, 'data'>): QuoterCall {
  return {
    async callContract(payload: string): Promise<{ ok: boolean; output?: string }> {
      const r = await adapter.call({ ...base, data: payload });
      if (!r.ok) return { ok: false };
      const output = r.value;
      if (typeof output !== 'string' || output.length === 0) return { ok: false };
      return { ok: true, output };
    },
  };
}