import type { RefusalCode } from './refusal-code.js';

export interface CheckResult {
  id: string;
  passed: boolean;
  reason?: string;
}

export type DecisionResult<T> =
  | {
      allowed: true;
      value: T;
      decisionId: string;
      checks: CheckResult[];
    }
  | {
      allowed: false;
      decisionId: string;
      refusal: RefusalCode;
      reason: string;
      checks: CheckResult[];
    };

export function allowDecision<T>(value: T, decisionId: string, checks: CheckResult[] = []): DecisionResult<T> {
  return { allowed: true, value, decisionId, checks };
}

export function refuseDecision<T = never>(
  decisionId: string,
  refusal: RefusalCode,
  reason: string,
  checks: CheckResult[] = [],
): DecisionResult<T> {
  return { allowed: false, decisionId, refusal, reason, checks };
}

export function isAllowed<T>(result: DecisionResult<T>): boolean {
  return result.allowed;
}
