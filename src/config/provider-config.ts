/**
 * 6.9 — Single typed provider-config schema with boot validation.
 *
 * Provider enablement today is a dozen ad-hoc `process.env.*_ENABLED` gates checked
 * in different adapters. The failure mode is silent: an operator sets
 * `FOMO_FEED_ENABLED=true` without `FOMO_API_KEY` and the bot just yields no FOMO
 * candidates. This module centralizes the provider→env mapping and validates it
 * loudly at boot so a misconfigured provider fails fast.
 *
 * Semantics: a provider that is ENABLED must have its required credentials; a
 * provider with declared key slots must have at least one populated. Anything
 * structural (format, key presence when enabled) is an error — not a warning.
 */

export interface ProviderSpec {
  /** Env var that turns the provider on (`'true'`). Optional — omitted = always active. */
  enableEnv?: string;
  /** Credential env vars; validated only when the provider is enabled. */
  requiredKeys?: string[];
  /** Credential slots where AT LEAST ONE must be set (key pools/rotation), e.g. GMGN. */
  requiredAnyOf?: string[];
  /** Human label for messages. */
  label: string;
}

/**
 * The provider configuration schema. Source ids follow the DISCOVERY_INTRODUCERS
 * vocabulary where applicable. Ordered for stable error output.
 */
export const PROVIDER_SCHEMA: Record<string, ProviderSpec> = {
  gmgn: {
    label: 'GMGN (price/intel/enrichment)',
    requiredAnyOf: [
      'GMGN_API_KEY',
      'GMGN_API_KEY_SOL', 'GMGN_API_KEY_BSC', 'GMGN_API_KEY_BASE',
      'GMGN_API_KEY_ETH', 'GMGN_API_KEY_ROBINHOOD',
    ],
  },
  fomo: {
    label: 'FOMO leaderboard/hints',
    enableEnv: 'FOMO_FEED_ENABLED',
    requiredKeys: ['FOMO_API_KEY'],
  },
  routescan: {
    label: 'Routescan (on-chain token/tx)',
    enableEnv: 'ROUTESCAN_FEED_ENABLED',
    // Keyless-capable (live-verified 2026-09-27: free tier needs no key; a set
    // ROUTESCAN_API_KEY only raises the RPS quota). So enabling must NOT hard-fail
    // boot without a key — the adapter falls back to the keyless tier.
  },
  cmcDex: {
    label: 'CoinMarketCap / Dex filter feed',
    enableEnv: 'CMC_DEX_FEED_ENABLED',
    requiredKeys: ['CMC_API_KEY'],
  },
  pumpdev: {
    label: 'Pump.dev launch stream',
    enableEnv: 'PUMPDEV_FEED_ENABLED',
    requiredKeys: ['PUMPDEV_WS_URL'],
  },
  ankr: {
    label: 'Ankr RPC feed',
    enableEnv: 'ANKR_FEED_ENABLED',
  },
  dexpaprika: {
    label: 'Dexpaprika feed',
    requiredKeys: ['DEXPAPRIKA_API_KEY'],
  },
};

/** Recognized single-letter/boolean semantics for *_ENABLED flags. */
function enabled(env: NodeJS.ProcessEnv): (key: string) => boolean {
  return (key: string) => env[key] === 'true' || env[key] === '1';
}

export interface ProviderConfigError {
  key: string;
  message: string;
}

export interface ProviderConfigResult {
  ok: boolean;
  errors: ProviderConfigError[];
}

/**
 * Validate provider configuration against the typed {@link PROVIDER_SCHEMA}.
 * Pure — no process.env reads except through the `env` argument (defaulted for
 * ergonomics at boot).
 */
export function validateProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfigResult {
  const errors: ProviderConfigError[] = [];
  const isEnabled = enabled(env);

  // DISCOVERY_INTRODUCERS must be a well-formed comma list (no empty entries).
  if (env.DISCOVERY_INTRODUCERS !== undefined && env.DISCOVERY_INTRODUCERS.trim() !== '') {
    const parts = env.DISCOVERY_INTRODUCERS.split(',').map((s) => s.trim());
    const bad = parts.filter((p) => p === '');
    if (bad.length > 0) {
      errors.push({ key: 'DISCOVERY_INTRODUCERS', message: 'contains an empty entry (double comma?)' });
    } else {
      // Every referenced source must be a known provider or feed id.
      const knownSources = new Set([
        ...Object.keys(PROVIDER_SCHEMA),
        'gecko', 'dexscreener', 'solana-rpc', 'jsonrpc-ws-tape', 'swarm:gate', 'whale:gate', 'tape', 'track',
      ]);
      const unknown = parts.filter((p) => !knownSources.has(p));
      if (unknown.length > 0) {
        errors.push({ key: 'DISCOVERY_INTRODUCERS', message: `unknown source id(s): ${unknown.join(', ')}` });
      }
    }
  }

  for (const [source, spec] of Object.entries(PROVIDER_SCHEMA)) {
    // Key enforcement only applies to EXPLICITLY enabled providers (enableEnv set to
    // true). Always-active feeds (e.g. GMGN, dexpaprika) can run on public/keyless
    // endpoints with rate limits, so they must not hard-fail boot — matching the
    // SOFT-degradation rule (6.5) and keeping keyless dev/test setups valid.
    if (!spec.enableEnv) continue;

    const enabledProvider = isEnabled(spec.enableEnv);
    // An ENABLED flag that fails to parse is a config error whether on or off.
    if (env[spec.enableEnv] !== undefined) {
      const raw = env[spec.enableEnv];
      if (raw !== 'true' && raw !== '1' && raw !== 'false' && raw !== '0') {
        errors.push({ key: spec.enableEnv, message: `must be true/false or 1/0 (${source} enable flag)` });
      }
    }
    if (!enabledProvider) continue;

    // Enabled provider → required individual keys must be present and non-empty.
    for (const key of spec.requiredKeys ?? []) {
      if (!env[key]?.trim()) {
        errors.push({ key, message: `is required because ${spec.label} is enabled` });
      }
    }
    // Enabled provider → at least one of its key-pool slots must be set.
    if ((spec.requiredAnyOf?.length ?? 0) > 0) {
      const anySet = spec.requiredAnyOf!.some((k) => !!env[k]?.trim());
      if (!anySet) {
        errors.push({
          key: spec.requiredAnyOf![0]!,
          message: `${spec.label} needs at least one key from: ${spec.requiredAnyOf!.join(', ')}`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Throw on the first boot-time provider config problem (fail fast, not silent no-candidates). */
export function assertProviderConfig(env: NodeJS.ProcessEnv = process.env): void {
  const result = validateProviderConfig(env);
  if (!result.ok) {
    const message = result.errors.map((e) => `${e.key}: ${e.message}`).join('; ');
    throw new Error(`Invalid provider configuration: ${message}`);
  }
}