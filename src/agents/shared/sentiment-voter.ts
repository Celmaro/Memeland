/**
 * Sentiment voter (Arch 3, #4) — redesigned from the old alpha-robinhood
 * "Robinhood chain" X scraper into a chain-agnostic social score:
 *   - X API v2 mention counts (OPTIONAL — when X_API_BEARER_TOKEN absent, the
 *     voter degrades to on-chain social fields and reports "X unavailable").
 *   - On-chain social fields from GMGN: square_mentions, visiting_count,
 *     twitter_create_token_count, dexscrBoostFee/dexscrAd (paid social).
 *
 * I2-1 semantic rewire (deep-review): sentiment is NOT an additive vote that
 * must help a candidate cross the 80% floor — that's exactly why scores stalled
 * at 57-70%. It splits ORGANIC (real social participation / X mentions) from
 * PAID (DexScreener boost/ad), CAPS the paid contribution so hype can't be a
 * false positive, and exposes a `contradiction` flag: strong paid hype or
 * mentions with NO on-chain buy flow tilts BEARISH. Sentiment's real role is
 * prefilter-priority (strong organic → ranks a candidate into emit) and a
 * veto/tiebreak in the swarm — never a standalone lift over a hard gate.
 *
 * Deterministic math only — no LLM per candidate. Score 0-100, neutral 50.
 * Never fabricates: absent sources simply don't contribute.
 */

import type { GMGNRawToken } from '../../adapters/gmgn-adapter.js';
import type { VoterOpinion } from '../../orchestrator/voters.js';
import { XApiAdapter } from '../../adapters/x-api-adapter.js';
import { DexScreenerBoostsFeed, dexscreenerBoostsEnabled } from '../../adapters/dexscreener-boosts.js';

export interface SentimentResult extends VoterOpinion {
  /** True when paid hype exceeds the cap / is the only driver — bearish tilt. */
  contradiction?: boolean;
  /** Organic sub-score (X mentions + on-chain participation), before paid. */
  organicScore?: number;
  /** Paid hype sub-score (DexScreener boost/ad), capped. */
  paidScore?: number;
}

/** Paid hype cap: paid social can never push a candidate toward PASS alone. */
const PAID_SCORE_CAP = 5;
/** Organic mentions considered "strong" (prefilter-priority lane trigger). */
export const STRONG_ORGANIC_THRESHOLD = 10;

export class SentimentVoter {
  private xApi: XApiAdapter;
  private boosts: DexScreenerBoostsFeed | null;
  private boostsCache: Set<string> = new Set();
  private boostsLoaded = false;

  constructor(xApi?: XApiAdapter | null, boosts?: DexScreenerBoostsFeed | null) {
    // Default: self-instantiate so X works without wiring; pass null explicitly
    // only from tests that want the on-chain-only path.
    this.xApi = xApi ?? new XApiAdapter();
    this.boosts = boosts ?? null;
  }

  public isXConfigured(): boolean {
    return this.xApi.isConfigured();
  }

  /** Load the direct DexScreener boost set once per process (env-gated, fail-open). */
  private async loadBoosts(): Promise<void> {
    if (this.boostsLoaded || !this.boosts || !dexscreenerBoostsEnabled()) return;
    try {
      const [boosts, ads] = await Promise.all([this.boosts.getBoosts(), this.boosts.getAds()]);
      for (const b of [...boosts, ...ads]) {
        if (b.tokenAddress) this.boostsCache.add(b.tokenAddress.toLowerCase());
      }
    } catch {
      // fail-open: paid-hype from GMGN proxy still applies
    } finally {
      this.boostsLoaded = true;
    }
  }

  /**
   * Score a batch of candidates in ONE pass. X search runs once for the whole
   * batch; per-token scores are computed from mention counts + GMGN social
   * fields. X errors never fail the batch — they degrade to on-chain fields.
   */
  public async evaluateBatch(candidates: GMGNRawToken[]): Promise<Map<string, SentimentResult>> {
    const out = new Map<string, SentimentResult>();
    if (candidates.length === 0) return out;

    await this.loadBoosts(); // direct DexScreener paid-hype set (once)

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

    // 2. Per-token score: split organic vs paid, cap paid, detect contradiction
    for (const t of candidates) {
      const key = t.address.toLowerCase();
      const reasons: string[] = [];
      let organicScore = 50;
      let paidScore = 0;

      // --- ORGANIC: real social participation (on-chain + X) ---
      const visiting = Number(t.visitingCount || 0);
      const squareMentions = Number(t.squareMentions || 0);
      if (visiting > 0) {
        organicScore += Math.min(15, visiting / 50);
        reasons.push(`visitors ${visiting}`);
      }
      if (squareMentions > 0) {
        organicScore += Math.min(10, squareMentions * 2);
        reasons.push(`square mentions ${squareMentions}`);
      }
      if (Number(t.twitterCreateTokenCount || 0) > 3) {
        organicScore -= 10; // repeated dev token creation = farm signal
        reasons.push('dev farm pattern (many created tokens)');
      }

      // X mentions (organic)
      const m = mentions.get(key) || 0;
      if (m > 0) {
        organicScore += Math.min(m * 3, 15);
        reasons.push(`${m} X mention(s)`);
      }

      // --- PAID: DexScreener boost/ad — CAPPED so hype is not a false positive ---
      // Direct vendor-free set (I2-2) OR the GMGN proxy field (dexscrBoostFee).
      const directBoost = this.boostsCache.has(key);
      const paid = (t.dexscrBoostFee && t.dexscrBoostFee > 0 ? 1 : 0) + (t.dexscrAd ? 1 : 0) + (directBoost ? 1 : 0);
      if (paid > 0) {
        paidScore = Math.min(PAID_SCORE_CAP, paid * PAID_SCORE_CAP);
        reasons.push(`paid DexScreener ${directBoost ? 'boost(api)' : t.dexscrAd ? 'ad' : 'boost'} (capped)`);
      }

      // --- Contradiction: hype (paid or strong mentions) with NO real demand
      // tilts BEARISH — sentiment cannot independently lift over a hard gate.
      // Suppressed when there's genuine organic participation (visitors / square
      // mentions / X), which is itself a demand signal distinct from raw transfers.
      const buyFlow = Number(t.buys || 0) + Number(t.swaps || 0);
      const organicParticipation = visiting > 0 || squareMentions > 0 || m > 0;
      const hypeWithoutDemand = (m >= 3 || paid > 0) && buyFlow === 0 && !organicParticipation;
      const contradiction = hypeWithoutDemand;

      let finalScore = organicScore;
      if (paidScore > 0) finalScore = Math.min(100, finalScore + paidScore);
      if (contradiction) {
        finalScore = Math.max(30, finalScore - 20); // hype w/o flow is bearish
        reasons.push('contradiction: hype but no on-chain buy flow');
      }

      if (!xAvailable && !this.isXConfigured()) {
        reasons.push('X API not configured — on-chain social only');
      }

      const finalScoreClamped = Math.max(0, Math.min(100, Math.round(finalScore)));
      out.set(key, {
        voter: 'sentiment',
        score: finalScoreClamped,
        reasons: reasons.length > 0 ? reasons : ['no social signal — neutral'],
        contradiction,
        organicScore,
        paidScore,
      });
    }
    return out;
  }

  /** Convenience: single-token evaluation (reuses the batch path). */
  public async evaluateOne(token: GMGNRawToken): Promise<SentimentResult> {
    const map = await this.evaluateBatch([token]);
    return map.get(token.address.toLowerCase()) ?? { voter: 'sentiment', score: 50, reasons: ['neutral'], contradiction: false, organicScore: 50, paidScore: 0 };
  }
}