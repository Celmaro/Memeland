import { describe, it, expect } from 'vitest';
import { MarketRegimeFilter } from '../src/services/market-regime.js';

describe('MarketRegimeFilter', () => {
  it('classifies from BTC/ETH 24h changes and does not carry a whale overlay', () => {
    const filter = new MarketRegimeFilter();
    const status = filter.updateMarketRegime(5, 6, 30);
    expect(status.regime).toBe('TRENDING_BULL');
    expect(status).not.toHaveProperty('whaleRiskOff');
  });
});
