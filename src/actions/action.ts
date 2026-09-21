export type Action =
  | { type: 'approve-order'; orderId: string }
  | { type: 'cancel-order'; orderId: string }
  | { type: 'send-native'; chain: string; to: string; amountBaseUnits: string; decimals: number }
  | { type: 'swap'; chain: string; tokenIn: string; tokenOut: string; amountBaseUnits: string }
  | { type: 'set-screening-config'; domain: string; config: Record<string, unknown> };

export interface ActorIdentity {
  id: string;
  roles?: string[];
}

export interface ActionContext {
  action: Action;
  actor: ActorIdentity;
  source: 'discord' | 'telegram' | 'api' | 'internal';
  requestId: string;
  now?: number;
}
