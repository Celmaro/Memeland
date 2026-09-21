import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../src/actions/action-executor.js';
import type { ActionContext } from '../src/actions/action.js';

describe('action executor', () => {
  it('dispatches a registered action with request context', async () => {
    const handler = vi.fn().mockResolvedValue({ queued: true });
    const executor = new ActionExecutor().register('approve-order', handler);

    const context: ActionContext = {
      action: { type: 'approve-order', orderId: 'order-1' },
      actor: { id: 'operator' },
      source: 'discord',
      requestId: 'req-1',
    };

    const result = await executor.execute(context);
    expect(result).toEqual({ ok: true, result: { queued: true } });
    expect(handler).toHaveBeenCalledWith(context);
  });

  it('fails closed when no handler is registered', async () => {
    const executor = new ActionExecutor();
    const result = await executor.execute({
      action: { type: 'swap', chain: 'robinhood', tokenIn: 'a', tokenOut: 'b', amountBaseUnits: '1' },
      actor: { id: 'operator' },
      source: 'internal',
      requestId: 'req-2',
    });
    expect(result.ok).toBe(false);
  });
});
