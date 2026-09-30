import { describe, expect, it } from 'vitest';
import { ApprovalOrderStateMachine, StateMachine } from '../src/lifecycle/state-machine.js';

describe('state machine kernel', () => {
  it('rejects invalid transitions', () => {
    const machine = new StateMachine('idle', {
      idle: ['running'],
      running: ['idle', 'stopped'],
      stopped: [],
    });
    expect(machine.canTransitionTo('running')).toBe(true);
    expect(() => machine.transitionTo('stopped')).toThrow('Invalid idle -> stopped transition');
  });

  it('allows legal approval-order transitions only', () => {
    const order = new ApprovalOrderStateMachine();
    expect(order.state).toBe('PENDING');
    order.transitionTo('APPROVED');
    expect(order.state).toBe('APPROVED');
    expect(order.canTransitionTo('REJECTED')).toBe(false);
    expect(() => order.transitionTo('REJECTED')).toThrow('Invalid APPROVED -> REJECTED transition');
    // P1-2: an APPROVED order can fail (fill failed execution).
    expect(order.canTransitionTo('FAILED')).toBe(true);
    order.transitionTo('FAILED');
    expect(order.state).toBe('FAILED');
  });

  it('PENDING cannot jump straight to FAILED (must approve first)', () => {
    const order = new ApprovalOrderStateMachine();
    expect(order.canTransitionTo('FAILED')).toBe(false);
    expect(() => order.transitionTo('FAILED')).toThrow('Invalid PENDING -> FAILED transition');
  });
});
