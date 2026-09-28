import { describe, it, expect } from 'vitest';
import { ArkhamEnrich } from './arkham-enrich.js';
import { ProviderGovernor } from '../services/provider-governor.js';

describe('ArkhamEnrich', () => {
  it('normalizes an address to a labeled entity', async () => {
    const fetchMock = async () => ({
      ok: true, status: 200,
      json: async () => ({ ownerType: 'EXCHANGE', displayName: 'Binance', tags: ['cex', 'hot-wallet'] }),
    });
    const c = new ArkhamEnrich({ apiKey: 'k', fetch: fetchMock as unknown as typeof globalThis.fetch, governor: new ProviderGovernor() });
    const e = await c.entity('0x123');
    expect(e).not.toBeNull();
    expect(e!.ownerType).toBe('EXCHANGE');
    expect(e!.displayName).toBe('Binance');
    expect(e!.tags).toContain('cex');
  });

  it('returns null (fail-soft) when the row has no label/tags', async () => {
    const fetchMock = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const c = new ArkhamEnrich({ apiKey: 'k', fetch: fetchMock as unknown as typeof globalThis.fetch, governor: new ProviderGovernor() });
    expect(await c.entity('0x456')).toBeNull();
  });
});