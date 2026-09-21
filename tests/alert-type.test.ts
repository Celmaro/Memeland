import { describe, expect, it } from 'vitest';
import { ALERT_TYPES, createAlert, formatAlert, type AlertType } from '../src/notifications/alert-type.js';

describe('alert type', () => {
  it('exposes the six lifecycle alert categories', () => {
    expect(ALERT_TYPES).toEqual([
      'DISCOVERY',
      'ENRICHMENT_CHANGE',
      'CONSENSUS_PASS',
      'RISK_WARNING',
      'APPROVAL_REQUIRED',
      'POSITION_EXIT',
    ]);
  });

  it('formats alerts with a visible category tag', () => {
    const alert = createAlert('RISK_WARNING', 'Kill-switch active', 'auto-execute blocked');
    expect(alert.type).toBe('RISK_WARNING');
    expect(formatAlert(alert)).toBe('[RISK_WARNING] Kill-switch active\nauto-execute blocked');
  });

  it('keeps the type in the union returned by the alert helper', () => {
    const alert = createAlert('APPROVAL_REQUIRED', 'Approve order');
    expect(typeof alert.type).toBe('string');
    expect((['DISCOVERY', 'ENRICHMENT_CHANGE', 'CONSENSUS_PASS', 'RISK_WARNING', 'APPROVAL_REQUIRED', 'POSITION_EXIT'] as AlertType[])).toContain(alert.type);
  });
});
