# Provider Calibration Matrix (verified 2026-09-29)

Living calibration of the discovery/enrichment data providers against **current
official sources** (web-verified) plus **code-level checks** against `src/`.

Two prior reports fed into this: the **provider-architecture v2** report
(5-role split, 3-introducer + 2-fallback) and an **18-source calibration matrix**.
This doc is the reconciled, verified version. Stale/incorrect lines from the
earlier calibration are marked `✗ (corrected)` and set right here.

---

## 1. Verification methodology

- **Web-verified** = checked against the provider's official pricing/docs
  (`*\.com/api/pricing`, `docs.*.so/docs/pricing`, `arkm.com/llms`, etc.) on
  the date above. Free-tier numbers change; re-verify before acting on them.
- **Code-verified** = confirmed against the repo `src/` (adapter exists? field
  actually parsed? feed wired?).

---

## 2. Free-tier facts (verified)

| Provider | Free tier | Rate limit | Overage / when empty | Status |
| --- | --- | --- | --- | --- |
| **DEXPaprika** | keyless = IP-shared; **free key = 100K credits/mo** | keyless ~**15 req/min**; keyed **30 req/min** | **402 Payment Required** when exhausted; 1 req = 1 credit | ✗ earlier calib said "no rate limit observed" → **corrected: limited** |
| **Helius** | **1M credits/mo** | 10 RPC rps, 2 DAS rps, 2 enhanced rps | `getSignaturesForAddress`/`getTransaction` = **10 cr each**; `getProgramAccounts` = 10 cr; `getProgramAccountsV2` = 1 cr; DAS = 10 cr; **webhook event = 1 cr** | ✅ v2 (credit cost was the correction) |
| **Birdeye** | **30K CU/mo, no overage** | 1 rps | Standard = "Limited" access (~**20** public endpoints, not 48) | ✗ v2 said "~20–48" → **20**; `stats/single = 5 CU` unverified |
| **CMC DEX** | keyless = **18 Standard + 17 DEX = 35 endpoints**; Basic key = **15K cr/mo** | Basic 50 rpm | — | ✅ v2 |
| **CoinStats** | **20K credits/mo** | 2 req/s | 429 on exceed | ✗ earlier calib said "50K/5rps" → **20K/2rps** |
| **DexScreener** | keyless (no key) | **300 rpm** on 4 pair/token endpoints, **60 rpm** on other 9 | batching 30 → /tokens/v1 ~9K inputs/min | ✅ |
| **GeckoTerminal** | free | **30 calls/min** public | — | ✅ tightest budget |
| **Arkham** | free **trial = 100K credits** (individual) / 1M (org) | — | paused at cap; paid ~$900/mo; **x402 PAYG $0.20/credit**; `/intelligence/address/{a}` = **1 cr**, `/all` = **2 cr** | ✗ v2 said "trial = 1K, no free API" → **100K trial, cheap per-address** |
| **Moralis** | 40K CU/day | 40 rps | — | ✅ (not P0-critical) |

---

## 3. Code-level verification (against `src/`)

| Claim | Code result |
| --- | --- |
| Pons RH factory `0x7ed598…` has an adapter | ✗ — only in a **comment** in `ankr-discovery-feed.ts:35`; no adapter; RH factory confirmed absent on-chain (`eth_getCode` returns `0x`) |
| `CohortSource = 'gmgn'\|'fomo'\|'pump'` exists; leaderboard fed | `CohortSource` union exists, but the leaderboard `observe()` is **un-fed** (no FOMO/Pump adapters) |
| `market-regime.ts` voter | ✗ — file **deleted** (earlier calib "✓ voter" is **stale**) |
| DeFiLlama in the tool-registry | ✗ — **fully absent from `src`** (earlier calib listed it as an active voter — **stale**) |
| DexScreener parses only `volume.h24` | `dexscreener-feed.ts:43/141` previously only `h24` → **now also `h1` → `volume1hUsd`** (fixed `0fc0c40`); `gmgn-adapter.ts normalizeDexScreenerPair` already read `volume.h1` |

---

## 4. Material corrections (these change the design)

1. **Arkham** — usable free **trial (100K credits)**, and per-address emit-level
   enrichment is cheap (**1–2 cr**). v2's "no free API" understates it.
2. **Helius** — `getSignaturesForAddress`/`getTransaction` are **10 cr each, not 1**.
   Polling sigs+txs is **20 cr/token**, strengthening "use webhook (1 cr/event),
   never poll `getProgramAccounts`".
3. **Birdeye** free = **~20** endpoints (not 48); `stats/single` CU **unverified**.
4. **DEXPaprika** is **limited** (keyless IP-shared 15 rpm; keyed 30 rpm /
   100K cr/mo; 402 when empty) — the earlier "no rate limit observed" was wrong.
5. **CoinStats** free = **20K credits / 2 rps**, not 50K/5rps.

---

## 5. Recommended introducer set (reconciled)

| Source | Role | Basis |
| --- | --- | --- |
| ankr (eth/bsc) | on-chain introducer | PairCreated, keyless via RPC pool |
| gecko (base) | introducer | new_pools, 30/min |
| **helius (sol)** | introducer | **implemented `a149d0b`** — bounded cursor walk, fail-soft, never gPA; webhook preferred in prod |
| dexpaprika | fallback introducer | keyless, 30 rpm / 100K cr |
| pons (rh) | fallback introducer | **blocked on confirmed RH factory** |

Enrichment (S4 emit-level) cheap paths confirmed: Arkham trial (1–2 cr/addr),
CMC keyless 35 endpoints, DexScreener 300 rpm.
