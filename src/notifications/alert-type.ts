export const ALERT_TYPES = [
  'DISCOVERY',
  'ENRICHMENT_CHANGE',
  'CONSENSUS_PASS',
  'RISK_WARNING',
  'APPROVAL_REQUIRED',
  'POSITION_EXIT',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export interface AlertPayload {
  type: AlertType;
  title: string;
  body?: string;
  at?: string;
}

/** Human-readable prefix that makes alert category visible without losing content. */
export function alertTag(type: AlertType): string {
  return `[${type}]`;
}

export function createAlert(type: AlertType, title: string, body?: string, at = new Date().toISOString()): AlertPayload {
  return { type, title, body, at };
}

export function formatAlert(payload: AlertPayload): string {
  const tag = alertTag(payload.type);
  return payload.body ? `${tag} ${payload.title}\n${payload.body}` : `${tag} ${payload.title}`;
}
