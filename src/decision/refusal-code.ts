export const RefusalCode = {
  UNKNOWN: 'UNKNOWN',
  FAILED_LOAD: 'FAILED_LOAD',
  AUTHORIZATION: 'AUTHORIZATION',
  CONSENSUS: 'CONSENSUS',
  SECURITY: 'SECURITY',
  RISK: 'RISK',
  LIMIT: 'LIMIT',
  DUPLICATE: 'DUPLICATE',
} as const;

export type RefusalCode = (typeof RefusalCode)[keyof typeof RefusalCode];
