/**
 * P2-3 — Token-2022 mint guard.
 *
 * Token-2022 (`TokenzQd…`) mints can carry extensions that make transfers taxed
 * or reverted: `TransferFeeConfig` (a per-transfer fee) and `TransferHook`
 * (an external program that can veto/redirect transfers). Slipping a buy on
 * such a token can silently cost more than quoted or fail to settle.
 *
 * This module detects a Token-2022 mint and scans its TLV extension region for
 * those two priced extensions. It is fail-open by construction: if the mint is
 * NOT owned by the Token-2022 program it is safe (standard SPL); if the data is
 * unreadable it reports `unreadable` so the caller can decide (the executor
 * treats it as a warning, not a hard block).
 *
 * SCOPE (do not over-read this guard):
 *  - It detects ONLY `TransferFeeConfig` (1) and `TransferHook` (5). Other
 *    Token-2022 extensions (and any extension that can distort or revert a
 *    transfer) are NOT evaluated. Passing this guard is NOT proof that a
 *    Token-2022 mint is safe to trade.
 *  - TLV parsing is fail-open: a malformed/truncated structure stops the scan,
 *    so extensions after the bad entry are simply not seen (and `unreadable` may
 *    not even be set for a partial-but-parseable read). Treat a pass as "no known
 *    priced extension found in what parsed", not as a safety proof.
 *
 * Layout (spl-token Token-2022):
 *   - Mint account = 82-byte base layout, then a TLV region.
 *   - Each TLV entry: type u16 LE, length u16 LE, then `length` bytes of data.
 *   - type 0 (Uninitialized) marks the end of the region.
 *   - TransferFeeConfig = 1, TransferHook = 5.
 */
import { PublicKey } from '@solana/web3.js';

export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** spl-token extension type codes (only the ones that make transfers unsafe). */
const TRANSFER_FEE_CONFIG = 1;
const TRANSFER_HOOK = 5;
/** Base (non-extension) mint layout length in bytes. */
const MINT_BASE_LEN = 82;

export interface Token2022Assessment {
  isToken2022: boolean;
  hasTransferFee: boolean;
  hasTransferHook: boolean;
  /** True when the mint carries a fee or hook that can distort/revert a buy. */
  hasPricedExtensions: boolean;
  /** True when we could not parse the data (caller decides — fail-open). */
  unreadable: boolean;
}

function hasExtension(mintData: Uint8Array, type: number): boolean {
  let offset = MINT_BASE_LEN;
  while (offset + 4 <= mintData.length) {
    const extType = mintData[offset] | (mintData[offset + 1] << 8);
    const len = mintData[offset + 2] | (mintData[offset + 3] << 8);
    if (extType === 0) return false; // Uninitialized = end of TLV region
    if (extType === type) return true;
    // Advance past the entry. A zero length is malformed; bail to avoid an
    // infinite loop rather than trusting garbage.
    if (len === 0) return false;
    offset += 4 + len;
  }
  return false;
}

/** Assess a Solana mint for Token-2022 priced extensions. Pure / unit-testable. */
export function assessToken2022Mint(mintOwner: string | PublicKey, mintData: Uint8Array): Token2022Assessment {
  const owner = typeof mintOwner === 'string' ? new PublicKey(mintOwner) : mintOwner;
  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return { isToken2022: false, hasTransferFee: false, hasTransferHook: false, hasPricedExtensions: false, unreadable: false };
  }
  if (!mintData || mintData.length < MINT_BASE_LEN) {
    return { isToken2022: true, hasTransferFee: false, hasTransferHook: false, hasPricedExtensions: false, unreadable: true };
  }
  const hasTransferFee = hasExtension(mintData, TRANSFER_FEE_CONFIG);
  const hasTransferHook = hasExtension(mintData, TRANSFER_HOOK);
  return {
    isToken2022: true,
    hasTransferFee,
    hasTransferHook,
    hasPricedExtensions: hasTransferFee || hasTransferHook,
    unreadable: false,
  };
}
