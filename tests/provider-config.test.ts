import { describe, it, expect } from 'vitest';
import { validateProviderConfig, assertProviderConfig, PROVIDER_SCHEMA } from '../src/config/provider-config.js';

describe('validateProviderConfig (6.9 — typed provider schema with boot validation)', () => {
  it('accepts an empty config (no hard-fail for keyless always-active feeds)', () => {
    const r = validateProviderConfig({});
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('fails fast when an ENABLED provider is missing its required key', () => {
    const r = validateProviderConfig({ FOMO_FEED_ENABLED: 'true' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.key === 'FOMO_API_KEY')).toBe(true);
    expect(r.errors[0]!.message).toContain('FOMO');
  });

  it('passes an enabled provider when its key is present', () => {
    const r = validateProviderConfig({ FOMO_FEED_ENABLED: 'true', FOMO_API_KEY: 'k' });
    expect(r.ok).toBe(true);
  });

  it('flags an unparseable *_ENABLED value regardless of on/off', () => {
    const r = validateProviderConfig({ FOMO_FEED_ENABLED: 'sometimes' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.key === 'FOMO_FEED_ENABLED')).toBe(true);
  });

  it('validates DISCOVERY_INTRODUCERS is a well-formed list of known sources', () => {
    expect(validateProviderConfig({ DISCOVERY_INTRODUCERS: 'ankr,gecko,,fomo' }).ok).toBe(false); // empty entry
    expect(validateProviderConfig({ DISCOVERY_INTRODUCERS: 'ankr,,fomo' }).ok).toBe(false);
    expect(validateProviderConfig({ DISCOVERY_INTRODUCERS: 'ankr,gecko,fomo' }).ok).toBe(true);
    expect(validateProviderConfig({ DISCOVERY_INTRODUCERS: 'not-a-real-source' }).ok).toBe(false);
  });

  it('gates dexpaprika and gmgn as always-active (keyless allowed) in the schema', () => {
    // GMGN has no enableEnv → not hard-required even with no keys.
    expect(validateProviderConfig({}).ok).toBe(true);
    expect(PROVIDER_SCHEMA.gmgn!.enableEnv).toBeUndefined();
    expect(PROVIDER_SCHEMA.dexpaprika!.enableEnv).toBeUndefined();
  });

  it('assertProviderConfig throws with the failing keys', () => {
    // Routescan is keyless-capable: enabling it WITHOUT a key is valid (the adapter
    // falls back to the free tier). Only genuinely keyed providers fail fast.
    expect(() => assertProviderConfig({ ROUTESCAN_FEED_ENABLED: 'true' })).not.toThrow();
    expect(() => assertProviderConfig({})).not.toThrow();
    // A truly keyed provider (FOMO) still fails fast when enabled without its key.
    expect(() => assertProviderConfig({ FOMO_FEED_ENABLED: 'true' })).toThrow(/FOMO_API_KEY/);
  });
});