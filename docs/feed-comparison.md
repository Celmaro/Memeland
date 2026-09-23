# Keyless feed comparison — DEXPaprika vs GeckoTerminal vs DexScreener

Status: 2026-09-23, after the keyless-first flip (discovery = DEXPaprika +
GeckoTerminal + DexScreener; GMGN = enrichment only). Codex.io was **removed**
(paywalled HTTP 402 — research A15's keyless claim is stale).

All three are keyless `MarketDataProvider` implementations, normalized to
`GMGNRawToken` via `normalizeDexToken` (volume1h = volume24h/24 fallback).
The differences below are what the operator needs to know for tuning the
discovery tier.

## Capability matrix

| Capability | DEXPaprika | GeckoTerminal | DexScreener |
|---|---|---|---|
| **Chain coverage** | sol/bsc/base/eth/**robinhood** | sol/bsc/base/eth/**robinhood** | sol/bsc/base/eth — **no robinhood** |
| **API key** | none | none | none |
| **Rate limit** | none observed (pools/search) | **30/min shared** (hard) | none stated; timeout-y from this host, OK from Zeabur |
| **Freshness (indexer latency)** | minutes | minutes | minutes (token-profiles) |
| **New-pool discovery** | `pools/search?order_by=volume_usd_24h` (rank by vol) | `new_pools` (freshest) + `trending_pools` | `token-profiles/latest/v1` (profiled tokens) |
| **Rank/trenches analog** | sort by volume_usd_24h | trending_pools (climbing vol) | token-profiles (newly listed) |
| **Volume 24h** | ✅ real field | ✅ real field | ❌ profiles have no volume (0) |
| **Liquidity** | ✅ real field | ✅ real field | ❌ profiles have no liquidity (0) |
| **Price** | ✅ | ✅ base_token_price_usd | ❌ (0) |
| **FDV/mcap** | ✅ fdv | ✅ fdv_usd | ❌ |
| **Pair address** | ✅ (pool->pairAddress) | ✅ pool address | ❌ |
| **Volume 1h** | ❌ (24h only → /24 fallback) | ❌ (24h only → /24 fallback) | ❌ (no volume at all) |
| **Exchange/dex name** | ✅ | ✅ | ❌ |
| **Endpoint shape** | `GET /pools/search` | `GET /networks/{net}/new_pools` + `/trending_pools` | `GET /token-profiles/latest/v1` |
| **Dedup identity** | contract address | contract address (base token) | token address |

## What each one is best at

### DEXPaprika — the volume-first discovery feed ✅ BEST at
- **Ranking by 24h volume** across ALL 5 chains (incl. robinhood). This is the
  closest keyless analog to GMGN's rank endpoint.
- **Real liquidity + fdv + price** — the prefilter can apply
  `minLiquidityUsd` / `minVolume1hUsd` on real numbers, not zeros.
- **No rate limit observed** — safe to call every cycle without pacing.
- The parallel agent's 2026-09-23 rewrite (`0a0f9a4`) moved it to the unified
  `/pools/search` API (the old `/pairs` endpoint 410s). Works live on Zeabur.

### GeckoTerminal — the freshness + trending feed ✅ BEST at
- **`new_pools`** — the freshest-pool endpoint of the three (brand-new DEX
  entries, the meme alpha window). The only keyless feed with an explicit
  "new pools" concept.
- **`trending_pools`** — the rank/trenches analog (pools climbing in volume).
- **Width of response** — pool address, base-token address, reserve, price,
  volume, fdv in one row.
- **Covers robinhood** (per ml-predictor's existing geckoNetworkIdFor).
- ⚠️ **Hard 30/min budget** — the new `GeckoDiscoveryFeed` self-paces at
  2s/request so a 5-chain pass (10 requests) respects it.

### DexScreener — the weak one today ⚠️
- **No robinhood chain**, and the `token-profiles` endpoint returns **no
  volume/liquidity/price** — every normalized candidate enters the prefilter
  with `volume1hUsd=0`, so `minVolume1hUsd` rejects it all (the pre-rewrite
  "booster dead code" problem the parallel agent fixed for dexpaprika is
  **still inherent to dexscreener**).
- What it's actually good at: **discovery of newly token-profiled** tokens on
  sol/bsc/base/eth that the other two may lag on. But with zero volume data it
  can only pass the prefilter if the operator lowers `minVolume1hUsd` to 0 —
  which the fail-closed gate forbids.
- **Verdict: keep it wired but effectively OFF unless a volume-carrying
  DexScreener endpoint (e.g. `/latest/dex/search` with pair data) replaces
  `token-profiles`.** Flag: switch `DexScreenerFeed` to `/latest/dex/search`
  (returns real pairs with volume/liquidity) — same keyless contract, but the
  candidates become prefilter-viable.

## What NONE of them can do (find-more gap)

1. **Sub-minute freshness** — all three are indexer-backed (minutes latency).
   The meme alpha window (first hours of a pair) needs **RPC-level discovery**:
   `eth_getLogs` on DEX factory `PairCreated` events. See
   [`docs/research/ankr-discovery-tier.md`](./ankr-discovery-tier.md) — Ankr
   RPC (eth_getLogs ≈ $0.00002/read) closes this gap.
2. **1-hour volume** — none expose it; the /24 fallback is an estimate, never
   observed data. GMGN remains the only real `volume1h` source (enrichment).
3. **Security/holder data** — none have GoPlus-style audits, holder
   concentration, or smart-money tags. This is why GMGN stays the enrichment
   layer (audit + klines + track feed), not the discovery layer.
4. **Order-flow/tape** — none have fill-level data; that's the Q04 RH tape
   transport.

## Merge order after this pass (runScreeningPass)

```
dexpaprika  → gecko  → dexscreener  → tape  → track  → gmgn
(volume-first) (fresh/trend) (weak)    (fill)  (sm)     (enrichment last)
```

- DEXPaprika first: real volume/liquidity-ranked candidates across all 5 chains.
- Gecko second: fresh pools + trending — the rank/trenches analog.
- DexScreener third: currently near-useless (no volume); candidate for
  `/latest/dex/search` swap.
- GMGN last: enrichment — per-token audit, klines, smart-money track overlay.
  Its 429-prone rank/trenches/hot discovery no longer gates the funnel.

## Tunables (env)

| Var | Effect |
|---|---|
| `DEXPAPRIKA_FEED_ENABLED` | discovery tier on/off |
| `GECKO_FEED_ENABLED` | Gecko new_pools + trending on/off (self-paced 30/min) |
| `DEXSCREENER_FEED_ENABLED` | profiles feed on/off (weak — see above) |
| `SCREENING_TIMEOUT_MS` | per-pass budget; default raised **60s → 180s** (5-chain pass needs ~90-120s; 60s was discarding every pass — the `beforeGate=0` funnel bug) |