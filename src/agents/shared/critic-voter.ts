/**
 * Critic voter (Arch 3, #7) — adversarial LLM pass over a candidate that has
 * already passed the deterministic gates. It searches for reasons the token
 * FAILS; fatal findings lower the vote, silence keeps neutral.
 *
 * Fail-open semantics: critic is a CONFIRMATION voter, never a gate. If the
 * LLM is unavailable or times out, the vote is neutral (50) and the swarm
 * proceeds with the remaining voters — screening must never halt because the
 * critic wasn't reachable.
 */

import type { AIService } from '../../services/ai-service.js';
import type { GMGNRawToken } from '../../adapters/gmgn-adapter.js';
import type { VoterOpinion } from '../../orchestrator/voters.js';

export interface CriticInput {
  token: GMGNRawToken;
  chain: string;
  thesis: string;
  reasons: string[];
}

const NEUTRAL: VoterOpinion = { voter: 'critic', score: 50, reasons: ['critic unavailable — abstain'], abstain: true };

function parseScore(raw: string): number | null {
  const m = raw.match(/SCORE\s*[:=]?\s*(\d{1,3})/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export class CriticVoter {
  constructor(private ai: AIService | null) {}

  public isAvailable(): boolean {
    return this.ai !== null;
  }

  /**
   * Adversarial review. Prompt asks for at most 3 failure reasons + SCORE: N.
   * Score semantics: 100 = nothing wrong found, 0 = fatal flaw. The LLM's
   * verdict is clamped to 0-100; anything unparsable → neutral 50.
   */
  public async evaluate(input: CriticInput): Promise<VoterOpinion> {
    if (!this.ai) return NEUTRAL;
    const t = input.token;
    const price = t.priceUsd > 0 ? `$${t.priceUsd}` : 'unknown';
    const mc = t.marketCapUsd > 0 ? `$${(t.marketCapUsd / 1e6).toFixed(2)}M` : 'unknown';
    const liq = t.liquidityUsd > 0 ? `$${(t.liquidityUsd / 1000).toFixed(1)}k` : 'unknown';
    const vol = t.volume1hUsd > 0 ? `$${(t.volume1hUsd / 1000).toFixed(1)}k` : 'unknown';

    const prompt = [
      `You are the CRITIC in a 7-agent memecoin swarm. Your only job: find reasons this candidate will FAIL.`,
      ``,
      `CANDIDATE: ${t.symbol} (${t.name}) on ${input.chain}`,
      `CA: ${t.address}`,
      `price=${price} mc=${mc} liq=${liq} vol1h=${vol}`,
      `buyers=${t.buys} sellers=${t.sells} holders=${t.holderCount}`,
      `smartDegen=${t.smartDegenCount} renowned=${t.renownedCount}`,
      `rugRatio=${t.rugRatio ?? 'unknown'} bundlerRate=${t.bundlerRate ?? 'unknown'} top10Holders=${t.top10HolderRate ?? 'unknown'}`,
      t.creatorClose ? `creator has CLOSED/sold.` : '',
      `THE THESIS: ${input.thesis}`,
      `AGENT REASONS: ${input.reasons.join(' | ')}`,
      ``,
      `Rules:`,
      `1. List AT MOST 3 concrete failure reasons. No hypotheticals — only what the data shows.`,
      `2. End with "SCORE: N" where N is 0-100. 100 = nothing wrong, 0 = fatal flaw. Start at 80 and subtract.`,
      `3. If the data is thin, score 60-70 (uncertain, not a conviction).`,
      `4. Never invent numbers. If a field says "unknown", skip it.`,
    ].filter((l) => l !== '').join('\n');

    try {
      const raw = await this.ai.generateCompletion(
        [{ role: 'system', content: 'You are a terse adversarial trading critic. Output only the critique and SCORE line.' }, { role: 'user', content: prompt }],
        400
      );
      const parsed = parseScore(raw);
      if (parsed === null) return NEUTRAL;
      const score = Math.max(0, Math.min(100, parsed));
      const failLines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\s*[-•*]/.test(l) && !/SCORE/i.test(l))
        .slice(0, 3)
        .map((l) => l.replace(/^[-•*\s]+/, '').slice(0, 160));
      return {
        voter: 'critic',
        score,
        reasons: failLines.length > 0 ? failLines : [`critic score ${score}/100`],
      };
    } catch (err: any) {
      console.warn(`[CRITIC] LLM pass unavailable (${err.message}) — neutral vote.`);
      return NEUTRAL;
    }
  }
}