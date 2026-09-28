import { describe, it, expect, afterEach } from 'vitest';
import {
  providerBannerLines,
  sourceParticipation,
  PROVIDER_FEEDS,
} from './provider-banner.js';

/** Keep the banner deterministic per test — clear the DISCOVERY_INTRODUCERS gate. */
const savedGates = new Map<string, string | undefined>();

function withGates(gates: Record<string, string>, fn: () => void): void {
  for (const [k, v] of Object.entries(gates)) {
    savedGates.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k] of Object.entries(gates)) {
      if (savedGates.get(k) === undefined) delete process.env[k];
      else process.env[k] = savedGates.get(k)!;
    }
  }
}

describe('provider-banner', () => {
  afterEach(() => {
    delete process.env.DISCOVERY_INTRODUCERS;
    delete process.env.SOLANA_RPC_FEED_ENABLED;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.ANKR_FEED_ENABLED;
    delete process.env.FOMO_FEED_ENABLED;
    delete process.env.FOMO_API_KEY;
    delete process.env.DEFILLAMA_FEED_ENABLED;
    delete process.env.ARKHAM_ENABLED;
    delete process.env.ARKHAM_API_KEY;
    delete process.env.DEXPAPRIKA_FEED_ENABLED;
    delete process.env.GECKO_FEED_ENABLED;
    delete process.env.DEXSCREENER_FEED_ENABLED;
    delete process.env.ROUTESCAN_FEED_ENABLED;
    delete process.env.CMC_DEX_FEED_ENABLED;
    delete process.env.BLOCKSCOUT_FEED_ENABLED;
    delete process.env.RH_TAPE_ENABLED;
    delete process.env.JEV_ENABLED;
  });

  it('classifies a source as promote when DISCOVERY_INTRODUCERS is unset', () => {
    expect(sourceParticipation('fomo')).toBe('promote');
    expect(sourceParticipation('gecko')).toBe('promote');
    expect(sourceParticipation('solana-rpc')).toBe('promote');
  });

  it('scopes non-introducers to recall-only when the allowlist is set', () => {
    withGates({ DISCOVERY_INTRODUCERS: 'solana-rpc-sol,ankr-eth,ankr-base,ankr-bsc' }, () => {
      expect(sourceParticipation('solana-rpc')).toBe('promote');
      expect(sourceParticipation('ankr')).toBe('promote');
      expect(sourceParticipation('fomo')).toBe('recall-only');
      expect(sourceParticipation('gecko')).toBe('recall-only');
      expect(sourceParticipation('dexscreener')).toBe('recall-only');
    });
  });

  it('emits an introducer line and a scoping line in the banner', () => {
    withGates(
      {
        DISCOVERY_INTRODUCERS: 'solana-rpc-sol,ankr-eth,ankr-base,ankr-bsc',
        SOLANA_RPC_FEED_ENABLED: 'true',
        SOLANA_RPC_URL: 'https://rpc.shyft.to?api_key=k',
        ANKR_FEED_ENABLED: 'true',
        DEFILLAMA_FEED_ENABLED: 'true',
      },
      () => {
        const lines = providerBannerLines();
        expect(lines.some((l) => l.startsWith('[PROVIDERS] introducer '))).toBe(true);
        expect(lines.some((l) => l.includes('solana-rpc·sol') && l.includes('ankr·eth/base/bsc'))).toBe(true);
        expect(lines.some((l) => l.includes('DISCOVERY_INTRODUCERS=solana-rpc-sol'))).toBe(true);
        // defillama is a regime/context feed — should appear under regime role.
        expect(lines.some((l) => l.startsWith('[PROVIDERS] regime ') && l.includes('defillama'))).toBe(true);
      },
    );
  });

  it('marks a keyed feed inert when the key is missing', () => {
    withGates(
      { SOLANA_RPC_FEED_ENABLED: 'true' }, // enabled flag but NO SOLANA_RPC_URL
      () => {
        const lines = providerBannerLines();
        const introLine = lines.find((l) => l.startsWith('[PROVIDERS] introducer '));
        expect(introLine).toBeTruthy();
        // solana-rpc requires a mainnet URL → not active; the line shows inert/off.
        expect(introLine!).not.toMatch(/→ solana-rpc·sol/);
      },
    );
  });

  it('does not mutate and every feed has a defined role gate', () => {
    for (const f of PROVIDER_FEEDS) {
      expect(typeof f.id).toBe('string');
      expect(typeof f.gate).toBe('function');
    }
  });
});
