/**
 * P1.4 — Arkham entity enricher (provider-architecture v2: entity resolution).
 *
 * Arkham is used for what its graph is uniquely good at — entity / deployer /
 * label / counterparty resolution — NOT as another token score (second-opinion
 * #10). Free trial 100K credits; `/intelligence/address/{a}` = 1 cr, `/all`
 * = 2 cr, entity = 1–2 cr. The expensive `batch` (250) and `search` (30)
 * endpoints are deliberately gated to a shortlist via the caller.
 *
 * All reads route through the ProviderGovernor with a tight ~100 cr/day cap so
 * the trial lasts the whole experiment. Fail-soft: any error → `null` entity.
 */

import { ProviderGovernor, globalProviderGovernor } from '../services/provider-governor.js';

export interface ArkhamEntity {
  address: string;
  ownerType: string; // e.g. 'EXCHANGE' | 'INVESTOR' | 'DEPLOYER' | ...
  displayName?: string;
  tags?: string[];
  label?: string;
  counterparts?: string[];
}

export interface ArkhamEnrichOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  governor?: ProviderGovernor;
  /** Default 100 cr/day — the free trial ceiling we design to. */
  dailyCap?: number;
}

const ARKHAM_URL = 'https://api.arkhamintelligence.com';

export class ArkhamEnrich {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly governor: ProviderGovernor;
  private readonly dailyCap: number;

  constructor(opts: ArkhamEnrichOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? ARKHAM_URL).replace(/\/$/, '');
    this.fetch = opts.fetch ?? (globalThis.fetch as typeof fetch);
    this.governor = opts.governor ?? globalProviderGovernor;
    this.dailyCap = opts.dailyCap ?? 100;
  }

  private cfg() {
    return { id: 'arkham', dailyCap: this.dailyCap, rpm: 30, assumedCostPerCall: 1, ttlMs: 24 * 60 * 60 * 1000 };
  }

  /** Resolve an address to a labeled entity (1 cr). `cacheable` lets the daily
   *  cache keep known addresses from re-spending (default true). */
  public async entity(address: string, cacheable = true): Promise<ArkhamEntity | null> {
    const key = cacheable ? `${address}` : null;
    const attempt = await this.governor.run<unknown>('arkham', this.cfg(), key, async () => {
      const res = await this.fetch(`${this.baseUrl}/intelligence/address/${encodeURIComponent(address)}`, {
        headers: { accept: 'application/json', 'API-KEY': this.apiKey },
      });
      const data = await res.json();
      return { status: res.status, data };
    });
    if (!attempt.ok) return null;
    return normalizeEntity(address, attempt.data);
  }
}

function normalizeEntity(address: string, raw: unknown): ArkhamEntity | null {
  const e = (raw ?? {}) as Record<string, unknown>;
  const ownerType = typeof e.ownerType === 'string' ? e.ownerType : typeof e.owner_type === 'string' ? (e.owner_type as string) : 'UNKNOWN';
  if (!e.displayName && !e.label && !Array.isArray(e.tags)) return null;
  const tags = Array.isArray(e.tags) ? (e.tags.map(String).filter(Boolean) as string[]) : [];
  const counterparts = Array.isArray(e.counterparts) ? (e.counterparts.map(String).filter(Boolean) as string[]) : [];
  return {
    address,
    ownerType,
    displayName: typeof e.displayName === 'string' ? e.displayName : undefined,
    label: typeof e.label === 'string' ? e.label : undefined,
    tags,
    counterparts,
  };
}