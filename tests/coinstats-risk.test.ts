import { describe, it, expect } from 'vitest';
import { CoinStatsRiskService } from '../src/services/coinstats-risk.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('CoinStatsRiskService (P4.2 finalist security second-read)', () => {
  it('maps token-risks findings into security penalties', async () => {
    const svc = new CoinStatsRiskService({
      apiKey: 'key',
      fetch: (async (url: string) => {
        expect(url).toContain('/v1/token-risks');
        return ok({
          data: [{
            risk_score: 72,
            findings: [
              { severity: 'critical', title: 'Honeypot' },
              { severity: 'high', title: 'Centralized mint' },
              { severity: 'low', title: 'Low liquidity' },
            ],
          }],
        });
      }) as never,
    });
    const r = await svc.screen('ethereum', '0xabc');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(72);
    expect(r!.penalties).toContain('coinstats: Honeypot (critical)');
    expect(r!.penalties).toContain('coinstats: Centralized mint (high)');
    expect(r!.penalties).not.toContain('coinstats: Low liquidity'); // low not penalized
  });

  it('returns null when not configured (fail-open — GoPlus remains primary)', async () => {
    const svc = new CoinStatsRiskService();
    expect(await svc.screen('ethereum', '0xabc')).toBeNull();
  });

  it('returns null on transport failure (never blocks the funnel)', async () => {
    const svc = new CoinStatsRiskService({
      apiKey: 'k',
      fetch: (async () => { throw new Error('down'); }) as never,
    });
    expect(await svc.screen('base', '0xabc')).toBeNull();
  });
});
