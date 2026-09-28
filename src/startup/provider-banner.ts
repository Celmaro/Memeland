/**
 * Provider-role boot banner.
 *
 * The Zeabur logs should tell an operator what the bot's provider fabric is,
 * not just "9 voters / LI.FI". This banner reflects the CURRENT four-role
 * provider architecture (see docs/research/provider-role-and-endpoints-report.md
 * and provider-implementation-plan.md):
 *
 *   introducer  — canonical on-chain introducers: only these PROMOTE a raw
 *                 address into the candidate universe. Gated by
 *                 DISCOVERY_INTRODUCERS (helius·sol, ankr·eth/base/bsc).
 *   emitter    — recall-only candidate emitter (fomo): emits CandidateHints;
 *                 promotion still requires the on-chain verify gate.
 *   enricher   — recall/hydrate, NEVER promote (dexpaprika/gecko/dexscreener/
 *                 routescan/cmc). When DISCOVERY_INTRODUCERS is set they scope
 *                 to enrichment-only.
 *   regime     — DeFiLlama regime CONTEXT (not a token-score voter).
 *   entity     — Arkham entity/deployer resolution overlay.
 *   verify     — blockscout on-chain tx verification.
 *   tape       — Robinhood tape transport.
 *   decision   — JEV shadow router.
 *
 * Every line is derived from the SAME env gates the runtime reads, so the log
 * always matches behaviour. Feed collection is gated per-source in the
 * screening agent; presence of a key gates inject-in (index.ts).
 */
import { isIntroducerEnabled } from '../discovery/discovery-registry.js';

type Role =
  | 'introducer'
  | 'emitter'
  | 'enricher'
  | 'regime'
  | 'entity'
  | 'verify'
  | 'tape'
  | 'decision';

interface FeedSpec {
  id: string;
  role: Role;
  chains?: string;
  gate: () => boolean;
}

const flag = (name: string) => () => process.env[name] === 'true';
const keyed = (keyName: string) => (gate: () => boolean) => () =>
  gate() && !!process.env[keyName]?.trim();

export const PROVIDER_FEEDS: FeedSpec[] = [
  // Canonical introducers (DISCOVERY_INTRODUCERS allowlist).
  { id: 'helius', role: 'introducer', chains: 'sol', gate: keyed('HELIUS_API_KEY')(flag('HELIUS_FEED_ENABLED')) },
  { id: 'ankr', role: 'introducer', chains: 'eth/base/bsc', gate: flag('ANKR_FEED_ENABLED') },
  // Recall-only emitter.
  { id: 'fomo', role: 'emitter', chains: 'multi', gate: keyed('FOMO_API_KEY')(flag('FOMO_FEED_ENABLED')) },
  // Enrichers (recall/hydrate, never promote when scoped).
  { id: 'dexpaprika', role: 'enricher', gate: flag('DEXPAPRIKA_FEED_ENABLED') },
  { id: 'gecko', role: 'enricher', gate: flag('GECKO_FEED_ENABLED') },
  { id: 'dexscreener', role: 'enricher', gate: flag('DEXSCREENER_FEED_ENABLED') },
  { id: 'routescan', role: 'enricher', gate: flag('ROUTESCAN_FEED_ENABLED') },
  { id: 'cmc', role: 'enricher', gate: flag('CMC_DEX_FEED_ENABLED') },
  // Regime context + entity overlay.
  { id: 'defillama', role: 'regime', gate: flag('DEFILLAMA_FEED_ENABLED') },
  { id: 'arkham', role: 'entity', gate: keyed('ARKHAM_API_KEY')(flag('ARKHAM_ENABLED')) },
  // On-chain verification + tape + decision layers.
  { id: 'blockscout', role: 'verify', gate: flag('BLOCKSCOUT_FEED_ENABLED') },
  { id: 'rh-tape', role: 'tape', gate: flag('RH_TAPE_ENABLED') },
  { id: 'JEV', role: 'decision', gate: flag('JEV_ENABLED') },
];

const ROLE_ORDER: Role[] = [
  'introducer',
  'emitter',
  'enricher',
  'regime',
  'entity',
  'verify',
  'tape',
  'decision',
];

const fmt = (f: FeedSpec) => f.id + (f.chains ? `·${f.chains}` : '');

export function providerBannerLines(): string[] {
  const scoping = process.env.DISCOVERY_INTRODUCERS?.trim();
  const lines: string[] = [];

  for (const role of ROLE_ORDER) {
    const feeds = PROVIDER_FEEDS.filter((f) => f.role === role);
    if (feeds.length === 0) continue;
    const active = feeds.filter((f) => f.gate());
    const inert = feeds.filter((f) => !f.gate());
    const activeStr =
      active.length > 0 ? active.map(fmt).join(', ') : '(inert)';
    const offStr = inert.length > 0 ? ` | off: ${inert.map(fmt).join(', ')}` : '';
    lines.push(`[PROVIDERS] ${role.padEnd(10)} → ${activeStr}${offStr}`);
  }

  if (scoping) {
    lines.push(`[PROVIDERS] DISCOVERY_INTRODUCERS=${scoping} → only these canonical introducers PROMOTE; emitters/enrichers recall/hydrate`);
  } else {
    lines.push('[PROVIDERS] DISCOVERY_INTRODUCERS unset → every enabled feed participates in discovery (back-compat)');
  }
  lines.push('[GOVERNOR] shared free-tier budget: daily-cap / rpm-bucket / cache / backoff | hard-freeze on 402 + 429');

  return lines;
}

export function printProviderBanner(): void {
  for (const line of providerBannerLines()) console.log(line);
}

/** Reflect the effect of DISCOVERY_INTRODUCERS on a single discovery source. */
export function sourceParticipation(source: string): 'promote' | 'recall-only' {
  const scoping = process.env.DISCOVERY_INTRODUCERS?.trim();
  if (!scoping) return 'promote';
  return isIntroducerEnabled(source, scoping) ? 'promote' : 'recall-only';
}