/**
 * 6.4 — Central address normalization + canonical entity key.
 *
 * Dedup today is `address.toLowerCase()` (EVM) vs base58 (sol) handled implicitly
 * and inconsistently across ad-hoc sites. This is the single, canonical entity-key
 * function used wherever an identity is built (registry id, coordinator merge,
 * token/pool observation keys, opportunity ids). One definition kills the whole
 * class of dedup bugs (lowercased sol addresses, checksummed eth, trailing
 * whitespace) before a Postgres migration makes them expensive.
 */

/** The canonical lowercase identity form of an address for keying across modules. */
export function normalizeAddress(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Build the canonical identity key for a chain+address pair. Normalizes both sides
 * defensively and produces a stable, collision-safe key usable as a primary key /
 * map key / dedup id.
 *
 * - EVM: checksummed/HexCase → lowercase (so a checksummed vs lowercased address
 *   of the same contract collapse).
 * - Solana/base58: trimmed and lowercased for consistency; the base58 payload is
 *   otherwise unchanged.
 * - Whitespace-trimmed; empty chain/address yields the other side (never a bare
 *   empty key when one half is known).
 */
export function canonicalEntityKey(chain: string | null | undefined, address: string | null | undefined): string {
  const c = normalizeAddress(chain);
  const a = normalizeAddress(address);
  if (!c) return a;
  return a ? `${c}:${a}` : c;
}

/** Entity "kind" prefixing for a multi-entity key space (token vs pool separation, P4). */
export type EntityKind = 'token' | 'pool' | 'wallet' | 'trader';

/**
 * Canonical key for a typed entity. Same normalization as {@link canonicalEntityKey}
 * but guarantees a distinct prefix per entity kind, so a token address and a pool
 * address on the same chain can never key-collide (the P4 token/pool split).
 */
export function canonicalTypedKey(
  kind: EntityKind,
  chain: string | null | undefined,
  address: string | null | undefined,
): string {
  const key = canonicalEntityKey(chain, address);
  return key ? `${kind}:${key}` : `${kind}`;
}