/**
 * Sentiment voter (Arch 3, #4) — redesigned from the old alpha-robinhood
 * "Robinhood chain" X scraper into a chain-agnostic social score:
 *   - X API v2 mention counts (OPTIONAL — when X_API_BEARER_TOKEN absent, the
 *     voter degrades to on-chain social fields and reports "X unavailable").
 *   - On-chain social fields from GMGN: square_mentions, visiting_count,
 *     twitter_create_token_count, dexscrBoostFee/dexscrAd (paid social).
 *
 * Deterministic math only — no LLM per candidate. Score 0-100, neutral 50.
 * Never fabricates: absent sources simply don't contribute.
 */

import type { GMGNRawToken } from '../../adapters/gmgn-adapter.js';
import type { VoterOpinion } from '../../orchestrator/voters.js';
import { XApiAdapter } from '../../adapters/x-api-adapter.js';

export class SentimentVoter {
  private xApi: XApiAdapter;

  constructor(xApi?: XApiAdapter | null) {
    // Default: self-instantiate so X works without wiring; pass null explicitly
    // only from tests that want the on-chain-only path.
    this.xApi = xApi ?? new XApiAdapter();
  }

  public isXConfigured(): boolean {
    return this.xApi.isConfigured();
  }

  /**
   * Score a batch of candidates in ONE pass. X search runs once for the whole
   * batch; per-token scores are computed from mention counts + GMGN social
   * fields. X errors never fail the batch — they degrade to on-chain fields.
   */
  public async evaluateBatch(candidates: GMGNRawToken[]): Promise<Map<string, VoterOpinion>> {
    const out = new Map<string, VoterOpinion>();
    if (candidates.length === 0) return out;

    // 1. X mentions (optional; single search per batch, empty on failure)
    let mentions = new Map<string, number>();
    let xAvailable = false;
    if (this.isXConfigured() && this.xApi) {
      try {
        const query = 'memecoin OR meme coin OR pump.fun OR "new listing" OR degen alpha';
        const res = await this.xApi.searchRobinhoodAlpha(query);
        if (res.success && res.tweets.length > 0) {
          xAvailable = true;
          for (const tweet of res.tweets) {
            for (const ca of tweet.contractAddresses) {
              const key = ca.toLowerCase();
              mentions.set(key, (mentions.get(key) || 0) + 1);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[SENTIMENT VOTER] X search failed (degraded to on-chain social): ${err.message}`);
      }
    }

    // 2. Per-token score: base 50 + social fields + mention boost, clamp 0-100
    for (const t of candidates) {
      const key = t.address.toLowerCase();
      const reasons: string[] = [];
      let score = 50;

      // On-chain social participation (GMGN fields)
      const visiting = Number(t.visitingCount || 0);
      const squareMentions = Number(t.squareMentions || 0);
      if (visiting > 0) {
        score += Math.min(15, visiting / 50);
        reasons.push(`visitors ${visiting}`);
      }
      if (squareMentions > 0) {
        score += Math.min(10, squareMentions * 2);
        reasons.push(`square mentions ${squareMentions}`);
      }
      if (Number(t.twitterCreateTokenCount || 0) > 3) {
        score -= 10; // repeated dev token creation = farm signal
        reasons.push('dev farm pattern (many created tokens)');
      }
      if (t.dexscrBoostFee > 0 || t.dexscrAd) {
        score += 5;
        reasons.push('paid DexScreener boost/ad');
      }

      // X mentions
      const m = mentions.get(key) || 0;
      if (m > 0) {
        score += Math.min(m * 3, 15);
        reasons.push(`${m} X mention(s)`);
      } else if (xAvailable) {
        score -= 0; // no noise: absence of X mention is not negative
      }
      if (!xAvailable && !this.isXConfigured()) {
        reasons.push('X API not configured — on-chain social only');
      }

      const finalScore = Math.max(0, Math.min(100, Math.round(score)));
      out.set(key, {
        voter: 'sentiment',
        score: finalScore,
        reasons: reasons.length > 0 ? reasons : ['no social signal — neutral'],
      });
    }
    return out;
  }

  /** Convenience: single-token evaluation (reuses the batch path). */
  public async evaluateOne(token: GMGNRawToken): Promise<VoterOpinion> {
    const map = await this.evaluateBatch([token]);
    return map.get(token.address.toLowerCase()) ?? { voter: 'sentiment', score: 50, reasons: ['neutral'] };
  }
}