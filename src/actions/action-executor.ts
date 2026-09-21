import type { Action, ActionContext } from './action.js';

export type ActionHandler = (context: ActionContext) => Promise<unknown> | unknown;

export type ActionExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/** Transport-independent action registry and executor. */
export class ActionExecutor {
  private readonly handlers = new Map<Action['type'], ActionHandler>();

  register(type: Action['type'], handler: ActionHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  async execute(context: ActionContext): Promise<ActionExecutionResult> {
    const handler = this.handlers.get(context.action.type);
    if (!handler) return { ok: false, error: `No handler registered for action type: ${context.action.type}` };
    try {
      return { ok: true, result: await handler(context) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
