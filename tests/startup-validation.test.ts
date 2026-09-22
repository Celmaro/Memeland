import { describe, expect, it } from 'vitest';
import { validateStartupConfig } from '../src/config/startup-validation.js';

describe('startup configuration validation', () => {
  it('rejects invalid ports and booleans', () => {
    const result = validateStartupConfig({ API_PORT: '70000', DRY_RUN: 'sometimes' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.key)).toEqual(expect.arrayContaining(['API_PORT', 'DRY_RUN']));
  });

  it('requires acknowledgement, approval, key, and enforced safety gate for live auto-execution', () => {
    const result = validateStartupConfig({ DRY_RUN: 'false', AUTO_EXECUTE_ENABLED: 'true', OPERATOR_APPROVAL_REQUIRED: 'false' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.key)).toEqual(expect.arrayContaining([
      'LIVE_TRADING_ACKNOWLEDGED', 'OPERATOR_APPROVAL_REQUIRED', 'EVM_PRIVATE_KEY', 'SAFETY_GATE_ENFORCED',
    ]));
  });

  it('accepts a fully acknowledged live configuration', () => {
    expect(validateStartupConfig({
      DRY_RUN: 'false', AUTO_EXECUTE_ENABLED: 'true', OPERATOR_APPROVAL_REQUIRED: 'true',
      LIVE_TRADING_ACKNOWLEDGED: 'true', EVM_PRIVATE_KEY: 'test-key', SAFETY_GATE_ENFORCED: 'true',
    }).ok).toBe(true);
  });

  it('DuckAI P0-3: live auto-execution fails startup when the safety gate is not enforced', () => {
    // An opt-in gate that defaults to bypass is not a gate — live AUTO must
    // explicitly set SAFETY_GATE_ENFORCED=true or boot refuses.
    const result = validateStartupConfig({
      DRY_RUN: 'false', AUTO_EXECUTE_ENABLED: 'true', OPERATOR_APPROVAL_REQUIRED: 'true',
      LIVE_TRADING_ACKNOWLEDGED: 'true', EVM_PRIVATE_KEY: 'test-key',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.key)).toContain('SAFETY_GATE_ENFORCED');
  });

  it('protects non-loopback API binds with an API key', () => {
    expect(validateStartupConfig({ API_BIND_HOST: '0.0.0.0' }).ok).toBe(false);
    expect(validateStartupConfig({ API_BIND_HOST: '0.0.0.0', OPENCATZ_API_KEY: 'test-key' }).ok).toBe(true);
  });

  it('R1: requires EVM_PRIVATE_KEY per executable EVM chain (or a shared key)', () => {
    // Each EVM chain in MULTICHAIN_CHAINS needs a key — either the shared one
    // or a per-chain override. Sol is its own key. Unconfigured chain = fail.
    expect(
      validateStartupConfig({ MULTICHAIN_CHAINS: 'eth' } as NodeJS.ProcessEnv).ok
    ).toBe(false);
    expect(
      validateStartupConfig({ MULTICHAIN_CHAINS: 'eth', EVM_PRIVATE_KEY: 'k' } as NodeJS.ProcessEnv).ok
    ).toBe(true);
    expect(
      validateStartupConfig({ MULTICHAIN_CHAINS: 'eth,base', EVM_PRIVATE_KEY: 'k' } as NodeJS.ProcessEnv).ok
    ).toBe(true);
    // A per-chain override without a shared key covers ONLY that chain; the
    // other executable EVM chain is still unconfigured → fail.
    expect(
      validateStartupConfig({
        MULTICHAIN_CHAINS: 'eth', EVM_PRIVATE_KEY_BASE: 'k2',
      } as NodeJS.ProcessEnv).ok
    ).toBe(false);
    // Per-chain override plus shared key = both covered.
    expect(
      validateStartupConfig({
        MULTICHAIN_CHAINS: 'eth,base', EVM_PRIVATE_KEY: 'k', EVM_PRIVATE_KEY_BASE: 'k2',
      } as NodeJS.ProcessEnv).ok
    ).toBe(true);
    // sol + eth: SOLANA_PRIVATE_KEY present but no EVM key → fail.
    expect(
      validateStartupConfig({
        MULTICHAIN_CHAINS: 'sol,eth', SOLANA_PRIVATE_KEY: 'sk',
      } as NodeJS.ProcessEnv).ok
    ).toBe(false);
  });
});
