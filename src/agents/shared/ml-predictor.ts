/**
 * ML Predictor voter — v1 is a deterministic feature model over OHLCV klines
 * (returns, RSI-ish momentum, volume trend) that maps to P(up) ∈ [0,1]. v2 can
 * swap in a trained LSTM/GBM behind the same `predictUpMomentum` signature —
 * the interface, not the model, is what the swarm depends on.
 *
 * Fail-closed semantics: insufficient klines → neutral (0.5 / score 50), never
 * a confident guess.
 */

export interface KlineLike {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PredictionResult {
  /** Probability the token is up over the next window, 0..1. */
  pUp: number;
  /** 0-100 vote score (50 = neutral). */
  score: number;
  reasons: string[];
}

/** Simple Wilder-style RSI over close prices. Returns 0-100 or null when insufficient. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Feature-model momentum predictor. Features (all computed from the LAST 20
 * candles, min 10 required):
 *   - ret1 / ret3 / ret5  : recent return magnitudes (directional)
 *   - rsi14               : overbought/oversold mean-reversion term
 *   - volTrend            : volume(3) / volume(prev 3) — rising participation
 *   - rangeRatio          : (h-l)/c — chop penalty
 * Weights are hand-set logistic coefficients; pUp = sigmoid(sum), then mapped
 * to a 0-100 score centered at 50.
 */
export function predictUpMomentum(candles: KlineLike[]): PredictionResult {
  const closes = candles.map((c) => c.close);
  if (closes.length < 10) {
    return { pUp: 0.5, score: 50, reasons: [`insufficient klines (${closes.length}) — neutral vote`] };
  }
  const use = candles.slice(-20);
  const c = use.map((x) => x.close);
  const last = c[c.length - 1];
  const prev = c[c.length - 2] || last;

  const ret = (n: number): number => {
    if (c.length <= n) return 0;
    const base = c[c.length - 1 - n];
    return base > 0 ? last / base - 1 : 0;
  };
  const ret1 = ret(1);
  const ret3 = ret(3);
  const ret5 = ret(5);

  const r = rsi(closes, 14);
  const rsi14 = r === null ? 50 : r;

  // Volume trend: avg last 3 vs avg prior 3
  let volTrend = 0;
  if (use.length >= 6) {
    const last3 = use.slice(-3).reduce((s, x) => s + x.volume, 0) / 3;
    const prev3 = use.slice(-6, -3).reduce((s, x) => s + x.volume, 0) / 3;
    volTrend = prev3 > 0 ? last3 / prev3 - 1 : 0;
  }

  const rangeRatio = prev > 0 ? (use[use.length - 1].high - use[use.length - 1].low) / prev : 0;

  // Logistic coefficients (interpretable, hand-set from momentum logic)
  const z =
    0.0 +
    6.0 * ret1 +
    3.0 * ret3 +
    1.5 * ret5 +
    0.01 * (rsi14 - 50) + // RSI lean: >50 momentum, <50 fade
    -0.02 * Math.max(0, rsi14 - 75) + // overbought penalty
    0.8 * volTrend +
    -1.2 * Math.min(rangeRatio, 0.4); // chop penalty

  const pUp = 1 / (1 + Math.exp(-z));
  const pUpClamped = Math.max(0.001, Math.min(0.999, pUp));
  // Linear mapping centered at 50: p=0.5 → 50, p=0.75 → 100, p=0.25 → 0.
  const score = Math.round(50 + (pUpClamped - 0.5) * 200);
  const clamped = Math.max(0, Math.min(100, score));

  const reasons: string[] = [
    `ret1 ${(ret1 * 100).toFixed(1)}% / ret3 ${(ret3 * 100).toFixed(1)}% / ret5 ${(ret5 * 100).toFixed(1)}%`,
    `rsi14 ${rsi14.toFixed(0)}`,
    `volume trend ${(volTrend * 100).toFixed(0)}%`,
  ];
  if (rangeRatio > 0.3) reasons.push('chop detected');
  return { pUp: pUpClamped, score: clamped, reasons };
}

/**
 * GeckoTerminal kline fetcher — free API (30 calls/min), no key.
 * networkId: 'solana' | 'bsc' | 'eth' | 'base' | 'robinhood' (from /networks).
 * poolAddress: the DEX pool address on that network.
 */
export async function fetchGeckoKlines(
  networkId: string,
  poolAddress: string,
  timeframe: 'minute' | 'hour' | 'day' = 'minute',
  aggregate = 15,
  limit = 50
): Promise<KlineLike[] | null> {
  const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(networkId)}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json;version=20230203' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const raw: unknown = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(raw)) return null;
  const out: KlineLike[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row as [number, number, number, number, number, number];
    if (Number(c) > 0) out.push({ timestamp: Number(t), open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: Number(v) });
  }
  return out.length > 0 ? out : null;
}