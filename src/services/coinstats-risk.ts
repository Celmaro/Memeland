/**
 * P4.2 — CoinStats token-risks (verified 2026-09-27: /v1/token-risks, Hexens-
 * backed, free tier 20k credits/mo @ 2 rps, a few credits per EVM finalist).
 *
 * NOT a discovery source (CoinStats has no DEX new-pool data). Used as a
 * security SECOND READ on EVM finalists only — on top of GoPlus — surfacing
 * honeypot/mint-blacklist/hidden-fee/upgradeable-proxy findings that the
 * primary gate may not flag. Fail-open: any error / no key / non-EVM → null,
 * the GoPlus primary gate remains authoritative.
 */

export interface CoinStatsRiskResult {
  score: number;
  penalties: string[];
  raw: unknown;
}

interface RawRiskResponse {
  data?: Array<{
    risk_score?: number | string;
    findings?: Array<{ severity?: string; title?: string }>;
  }>;
}

export interface CoinStatsRiskOptions {
  apiKey?: string;
  fetch?: (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;
  baseUrl?: string;
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 30, high: 20, medium: 10, minor: 0 };

export class CoinStatsRiskService {
  private readonly apiKey?: string;
  private readonly fetch: (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;
  private readonly baseUrl: string;

  constructor(opts: CoinStatsRiskOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.COINSTATS_API_KEY;
    this.fetch = opts.fetch ?? ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
    this.baseUrl = opts.baseUrl ?? 'https://api.coinstats.app';
  }

  /** Screen an EVM finalist's contract. EVM chains only; null on any failure. */
  public async screen(chain: string, address: string): Promise<CoinStatsRiskResult | null> {
    if (!this.apiKey) return null;
    // CoinStats chain names differ from ours; only wire the EVM families it covers.
    const platform = this.coinstatsPlatform(chain);
    if (!platform) return null;
    try {
      const url = `${this.baseUrl}/v1/token-risks?contractAddress=${encodeURIComponent(address)}&chain=${encodeURIComponent(platform)}`;
      const res = await this.fetch(url);
      if (!res.ok) return null;
      const body = (await res.json()) as RawRiskResponse;
      const row = Array.isArray(body?.data) ? body.data[0] : undefined;
      if (!row) return null;
      const score = Number(row.risk_score) || 0;
      const penalties: string[] = [];
      for (const f of row.findings ?? []) {
        const w = SEVERITY_WEIGHT[f.severity ?? ''] ?? 0;
        if (w >= 20 && f.title) penalties.push(`coinstats: ${f.title} (${f.severity})`);
      }
      return { score, penalties, raw: row };
    } catch {
      return null; // fail-open — GoPlus remains primary
    }
  }

  private coinstatsPlatform(chain: string): string | null {
    const c = chain.toLowerCase();
    if (c === 'eth' || c === 'ethereum') return 'ethereum';
    if (c === 'bsc' || c === 'binance') return 'binance-smart-chain';
    if (c === 'base') return 'base';
    if (c === 'robinhood' || c === 'rh') return 'robinhood';
    return null; // solana excluded (token-risks is EVM-focused)
  }
}
