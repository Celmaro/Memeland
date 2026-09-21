import { describe, expect, it } from 'vitest';
import { OperationalHealthRegistry } from '../src/services/operational-health.js';

describe('operational health registry', () => {
  it('records provider requests with last success, rate limits, and key rotation', () => {
    const registry = new OperationalHealthRegistry();
    registry.recordProviderRequest('gmgn', true, {
      rateLimit: { remaining: 12 },
      keyRotation: { poolSize: 2, activeIndex: 1, lastRotatedAt: 123 },
    });
    registry.recordProviderRequest('gmgn', false, { error: '429' });
    const snapshot = registry.snapshot();
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]).toMatchObject({ name: 'gmgn', ok: false, lastError: '429' });
    expect(snapshot.providers[0].lastSuccessAt).toBeGreaterThan(0);
    expect(snapshot.providers[0].rateLimit).toEqual({ remaining: 12 });
  });

  it('tracks scheduler, worker failures, delivery, kill-switch, funnel, and alerts', () => {
    const registry = new OperationalHealthRegistry();
    registry.setSchedulerStatus({ name: 'screening', running: true, lastStartedAt: 1 });
    registry.recordWorkerFailure('screening', 'boom');
    registry.setDelivery({ discord: true, telegram: true });
    registry.setKillSwitch(true, 99);
    registry.mergeFunnel({ candidatesDiscovered: 5 });
    registry.recordAlert('RISK_WARNING', 'Kill-switch active', 'blocked');

    const snapshot = registry.snapshot();
    expect(snapshot.scheduler).toEqual([{ name: 'screening', running: true, lastStartedAt: 1 }]);
    expect(snapshot.workerFailures).toEqual([{ worker: 'screening', reason: 'boom', at: expect.any(Number) }]);
    expect(snapshot.delivery).toEqual({ discord: true, telegram: true });
    expect(snapshot.killSwitch).toEqual({ active: true, activatedAt: 99 });
    expect(snapshot.funnel.candidatesDiscovered).toBe(5);
    expect(snapshot.alerts[0]).toMatchObject({ type: 'RISK_WARNING', title: 'Kill-switch active', body: 'blocked' });
  });
});
