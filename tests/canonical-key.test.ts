import { describe, it, expect } from 'vitest';
import { canonicalEntityKey, canonicalTypedKey, normalizeAddress } from '../src/discovery/canonical-key.js';

describe('canonicalEntityKey (6.4 — centralized normalization)', () => {
  it('lowercases EVM addresses regardless of checksum casing', () => {
    expect(canonicalEntityKey('eth', '0xAbCdef123')).toBe('eth:0xabcdef123');
    expect(canonicalEntityKey('eth', '0xABCDEF123')).toBe('eth:0xabcdef123');
    expect(canonicalEntityKey('eth', '0xAbCdef123')).toBe(canonicalEntityKey('eth', '0xabcdef123'));
  });

  it('trims whitespace and is stable for sol/base58', () => {
    expect(canonicalEntityKey('   sol  ', '  FOObarPubKey ')).toBe('sol:foobarpubkey');
  });

  it('collapses to a single side when chain or address is empty', () => {
    expect(canonicalEntityKey('', '0xABC')).toBe('0xabc');
    expect(canonicalEntityKey('eth', '')).toBe('eth');
    expect(canonicalEntityKey('', '')).toBe('');
  });

  it('canonicalTypedKey prefixes by kind so token vs pool never key-collide', () => {
    const t = canonicalTypedKey('token', 'eth', '0xABC');
    const p = canonicalTypedKey('pool', 'eth', '0xABC');
    expect(t).toBe('token:eth:0xabc');
    expect(p).toBe('pool:eth:0xabc');
    expect(t).not.toBe(p);
  });

  it('normalizeAddress is the single lowercase/trim primitive', () => {
    expect(normalizeAddress('  0xDEADBEEF ')).toBe('0xdeadbeef');
    expect(normalizeAddress(undefined)).toBe('');
  });
});