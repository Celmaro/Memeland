import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  assessToken2022Mint,
  TOKEN_2022_PROGRAM_ID,
} from '../src/solana/token2022-guard.js';

const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Build a mint account: 82-byte base + TLV entries. */
function buildMint(entries: { type: number; data: Uint8Array }[]): Uint8Array {
  const base = new Uint8Array(82);
  let body: number[] = [];
  for (const e of entries) {
    body.push(e.type & 0xff, (e.type >> 8) & 0xff); // type u16 LE
    body.push(e.data.length & 0xff, (e.data.length >> 8) & 0xff); // length u16 LE
    body.push(...Array.from(e.data));
  }
  body.push(0x00, 0x00, 0x00, 0x00); // Uninitialized terminator
  const out = new Uint8Array(base.length + body.length);
  out.set(base, 0);
  out.set(body, base.length);
  return out;
}

describe('P2-3 assessToken2022Mint', () => {
  it('standard SPL mint (non-Token-2022 owner) is safe with no extensions', () => {
    const a = assessToken2022Mint(SPL_TOKEN_PROGRAM_ID.toBase58(), new Uint8Array(82));
    expect(a.isToken2022).toBe(false);
    expect(a.hasPricedExtensions).toBe(false);
    expect(a.unreadable).toBe(false);
  });

  it('Token-2022 mint with NO extensions is safe', () => {
    const a = assessToken2022Mint(TOKEN_2022_PROGRAM_ID, buildMint([]));
    expect(a.isToken2022).toBe(true);
    expect(a.hasPricedExtensions).toBe(false);
    expect(a.unreadable).toBe(false);
  });

  it('Token-2022 mint with a TransferFeeConfig extension is flagged', () => {
    // TransferFeeConfig data is 40 bytes (spl-token).
    const data = new Uint8Array(40);
    const a = assessToken2022Mint(TOKEN_2022_PROGRAM_ID, buildMint([{ type: 1, data }]));
    expect(a.isToken2022).toBe(true);
    expect(a.hasTransferFee).toBe(true);
    expect(a.hasPricedExtensions).toBe(true);
  });

  it('Token-2022 mint with a TransferHook extension is flagged', () => {
    // TransferHook data is 32 bytes (the hook program id).
    const data = new Uint8Array(32);
    const a = assessToken2022Mint(TOKEN_2022_PROGRAM_ID, buildMint([{ type: 5, data }]));
    expect(a.isToken2022).toBe(true);
    expect(a.hasTransferHook).toBe(true);
    expect(a.hasPricedExtensions).toBe(true);
  });

  it('Token-2022 mint with only a harmless extension (MintCloseAuthority=3) is NOT flagged', () => {
    const data = new Uint8Array(32);
    const a = assessToken2022Mint(TOKEN_2022_PROGRAM_ID, buildMint([{ type: 3, data }]));
    expect(a.isToken2022).toBe(true);
    expect(a.hasTransferFee).toBe(false);
    expect(a.hasTransferHook).toBe(false);
    expect(a.hasPricedExtensions).toBe(false);
  });

  it('short/unreadable Token-2022 mint data is reported unreadable (fail-open)', () => {
    const a = assessToken2022Mint(TOKEN_2022_PROGRAM_ID, new Uint8Array(10));
    expect(a.isToken2022).toBe(true);
    expect(a.unreadable).toBe(true);
    expect(a.hasPricedExtensions).toBe(false);
  });
});
