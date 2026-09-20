/**
 * PR12.g (SRC-185 PillCrew/claimchain): an extract-verify-groundedness gate for
 * LLM voter output. A claim is only trusted when a sufficient fraction of its
 * tokens can be matched against at least one supplied evidence fact. Fail-
 * closed: an ungrounded claim is never accepted, and a vote built on it must
 * not be allowed to gate trading. Pure, deterministic, chain-agnostic.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this',
  'that', 'its', 'as', 'by', 'from', 'has', 'have', 'had', 'not', 'no', 'can',
  'could', 'should', 'may', 'might', 'into', 'than', 'so', 'such',
]);

function tokens(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Split a voter message into assertion atoms by sentence boundary. */
export function extractClaims(text: string): string[] {
  return String(text || '')
    .split(/[.!?;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface GroundednessVerdict {
  claim: string;
  /** True when the claim matches at least one evidence fact at `minScore`. */
  grounded: boolean;
  /** Best token-overlap fraction against any single evidence fact. */
  bestScore: number;
  reason: string;
}

export interface GroundednessOptions {
  /** Fraction of claim tokens that must appear in one evidence fact. */
  minScore?: number;
  /** Minimum number of evidence facts that must match. */
  minEvidence?: number;
  /** Minimum grounded-ratio across claims to accept the message as a whole. */
  requiredRatio?: number;
}

export interface GroundednessGateResult {
  verdicts: GroundednessVerdict[];
  groundedRatio: number;
  /** True when at least one claim exists and all are individually grounded. */
  grounded: boolean;
  /** Whole-message acceptance flag (grounded ratio >= requiredRatio). */
  accepted: boolean;
}

function overlapScore(claimTokens: string[], evidenceTokens: string[]): number {
  if (claimTokens.length === 0) return 0;
  if (evidenceTokens.length === 0) return 0;
  const eSet = new Set(evidenceTokens);
  const hits = claimTokens.filter((t) => eSet.has(t)).length;
  return hits / claimTokens.length;
}

/**
 * Verify that each claim in `claimText` is grounded in at least one evidence
 * fact. Fail-closed: empty claim text, no evidence, or an ungrounded claim all
 * push the result toward rejection.
 */
export function groundednessGate(
  claimText: string,
  evidence: string[],
  options: GroundednessOptions = {},
): GroundednessGateResult {
  const minScore = options.minScore ?? 0.5;
  const minEvidence = options.minEvidence ?? 1;
  const requiredRatio = options.requiredRatio ?? 1;
  const claims = extractClaims(claimText);
  const facts = (Array.isArray(evidence) ? evidence : [])
    .map((e) => tokens(e))
    .filter((t) => t.length > 0);

  if (claims.length === 0) {
    return { verdicts: [], groundedRatio: 0, grounded: false, accepted: false };
  }

  const verdicts: GroundednessVerdict[] = claims.map((claim) => {
    const ct = tokens(claim);
    let bestScore = 0;
    let matches = 0;
    for (const ft of facts) {
      const s = overlapScore(ct, ft);
      if (s > bestScore) bestScore = s;
      if (s >= minScore) matches++;
    }
    const grounded = matches >= Math.max(1, minEvidence);
    return {
      claim,
      grounded,
      bestScore,
      reason: grounded
        ? `grounded by ${matches} evidence fact(s), best ${bestScore.toFixed(2)}`
        : `ungrounded (best ${bestScore.toFixed(2)} < ${minScore.toFixed(2)})`,
    };
  });

  const groundedRatio = verdicts.filter((v) => v.grounded).length / verdicts.length;
  const grounded = verdicts.every((v) => v.grounded);
  return {
    verdicts,
    groundedRatio,
    grounded,
    accepted: groundedRatio >= requiredRatio,
  };
}
