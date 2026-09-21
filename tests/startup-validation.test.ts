import { describe, expect, it } from 'vitest';
import { validateStartupConfig } from '../src/config/startup-validation.js';

describe('startup configuration validation', () => {
  it('rejects invalid ports and booleans', () => {
    const result = validateStartupConfig({ API_PORT: '70000', DRY_RUN: 'sometimes' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.key)).toEqual(expect.arrayContaining(['API_PORT', 'DRY_RUN']));
  });

  it('requires acknowledgement, approval, and a key for live auto-execution', () => {
    const result = validateStartupConfig({ DRY_RUN: 'false', AUTO_EXECUTE_ENABLED: 'true', OPERATOR_APPROVAL_REQUIRED: 'false' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.key)).toEqual(expect.arrayContaining([
      'LIVE_TRADING_ACKNOWLEDGED', 'OPERATOR_APPROVAL_REQUIRED', 'EVM_PRIVATE_KEY',
    ]));
  });

  it('accepts a fully acknowledged live configuration', () => {
    expect(validateStartupConfig({
      DRY_RUN: 'false', AUTO_EXECUTE_ENABLED: 'true', OPERATOR_APPROVAL_REQUIRED: 'true',
      LIVE_TRADING_ACKNOWLEDGED: 'true', EVM_PRIVATE_KEY: 'test-key',
    }).ok).toBe(true);
  });

  it('protects non-loopback API binds with an API key', () => {
    expect(validateStartupConfig({ API_BIND_HOST: '0.0.0.0' }).ok).toBe(false);
    expect(validateStartupConfig({ API_BIND_HOST: '0.0.0.0', OPENCATZ_API_KEY: 'test-key' }).ok).toBe(true);
  });
});
