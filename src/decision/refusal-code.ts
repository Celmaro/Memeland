export const RefusalCode = {
  UNKNOWN: 'UNKNOWN',
  FAILED_LOAD: 'FAILED_LOAD',
  AUTHORIZATION: 'AUTHORIZATION',
  CONSENSUS: 'CONSENSUS',
  SECURITY: 'SECURITY',
  RISK: 'RISK',
  LIMIT: 'LIMIT',
  /**
   * The candidate rendered too little evidence to judge: too many gate slots
   * abstained (a feed was UNAVAILABLE) for the weighted average to mean
   * anything. Distinct from CONSENSUS because the score was never a real
   * read — it was a denominator with holes in it.
   */
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  DUPLICATE: 'DUPLICATE',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  ASYMMETRIC_CONFLICT: 'ASYMMETRIC_CONFLICT',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
} as const;

export type RefusalCode = (typeof RefusalCode)[keyof typeof RefusalCode];
