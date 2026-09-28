# Provider Operations & Free-Tier Budget Map (2026-09-29)

Who **introduces / emits / enriches / transports what**, with the **free-tier math** to
pull as much data as possible without exhausting credits or rates. Every number below is
per the verified free tiers in `provider-role-and-endpoints-report.md`.

**Operating rules that govern every row (read first):**
1. **Cache everything.** Enrichment results are keyed `chain:address:endpoint:tier` with a
   TTL (5m–1h). Never re-fetch inside TTL. This is what actually keeps us under free caps.
2. **Cheap-first waterfall.** A candidate only *reaches* an expensive call if it passed a
   cheaper gate. Price/first % (free) → market (250/250-cr) → security (cheap) → thesis/dev
   (expensive, shortlist only).
3. **Per-provider daily cap.** Each provider below has one; when hit, freeze that provider for
   the cycle (skip, don't retry hot). `402`/`429` → backoff + let `CandidateRegistry.stats()`
   demote it. Never let one provider crash the funnel.
4. **Pace under rpm.** A tiny per-provider leaky bucket (the reported rpm) is applied before
   issuing a batch.

---

## 1. TRANSPORT — raw access

| Source | Free tier | Endpoints used | Feeds | Budget rule |
| --- | --- | --- | --- | --- |
| **Helius RPC/DAS** | 1M cr/mo, 10 RPC rps, 2 DAS rps | RPC `getSignaturesForAddress`·`getTransaction`; DAS `getTokenAccounts` | introducer + security | see §2 + §4.3 |
| **RH + EVM RPC pool** | keyless, per-provider caps | `eth_getLogs`, `eth_blockNumber` | Ankr introducer | chunked, see §2 |
| **Geyser/Yellowstone** (opt.) | self-host | program/account stream | future sol engine | n/a |

---

## 2. CANONICAL INTRODUCERS — the only "exists" authority

Introduce a raw address **only** from a real on-chain event; emit zero market data
(`freshLane: true`). These are cheap and **frequent**.

### Helius — Solana (impl, `HeliusDiscoveryFeed`)
| Endpoint | Cr | Frequency | What it feeds | Budget |
| --- | --- | --- | --- | --- |
| `getSignaturesForAddress` | 10 | 1×/cycle/program (cursor-persisted) | new-mint lead list | ≤3 calls/cycle = 30 cr |
| `getTransaction` (jsonParsed) | 10 | only for sigs that may be `create` | SPL-`create` → mint | ≤3/cycle = 30 cr |
| **webhook** (preferred) | **1/event** | push | mint creation | ~0 cr — use if a public endpoint exists |
| `getProgramAccounts` | 10 | **never** | — | the ~288K cr/day trap |
| `getProgramAccountsV2` | 1 | rarely | paginated enumeration | cheap alt if ever needed |

**Cycle budget cap ≈ 50–100 cr** (`perCycleCredits` default 50) held well under 1M/mo
(~36K cr/mo at hourly cycles). Verify the real launch-program decode live; ship webhook when possible.

### Ankr PairCreated — EVM (impl, `AnkrDiscoveryFeed`)
| Endpoint | Cost | Frequency | What it feeds | Budget |
| --- | --- | --- | --- | --- |
| `eth_getLogs` (PairCreated topic0) | RPC pool | per cycle, chunked lookback | new pair → token0/token1 mints | `lookbackBlocks≈300`, chunk-halve on too-wide; bounded ~5–15 calls/chain/cycle |

Runs keyless through the RPC failover pool. Only eth/base/bsc (factories verified); RH has no
verified factory — **no RH copy**.

---

## 3. CANDIDATE EMITTERS — "looks interesting", never "exists"

Emit `CandidateHint`; the registry verifies on-chain before the address becomes a candidate.
Expensive calls here are **shortlist-only**.

### FOMO API (free 250K cr/mo · 20 rpm free · WS unmetered) — *primary trader/leaderboard feed*
| Endpoint | Cr | Frequency | What it feeds | Budget |
| --- | --- | --- | --- | --- |
| `/v2/leaderboard/24h` · `/7d` · `/30d` | 250 ea | 1×/cycle | **24h∩7d∩30d persistent-trader intersection** | 3 calls = 750 cr/cycle (~5K cr/day) |
| `/v2/leaderboard/tokens/trending\|most-held\|graduated` | 250 ea | 1×/cycle | token candidate hints | 3 calls = 750 cr/cycle |
| `WSS /ws/alerts` (`chain=robinhood`&`=solana`) | **0 (unmetered)** | continuous | realtime buys/sells/theses + landmark pushes | ~0 cr — highest-value feed, keep open |
| `/v2/alerts` (REST) | 125 | fallback off WS | same as WS | only if WS down |
| `/v2/users/{handle}` (identity resolve) | **2,500** | **shortlist only** | handle→Solana+EVM wallets (Trader Identity Resolver) | **≤3/day = 7.5K cr** |
| `/v2/thesis[/token\|/user/{id}]` | **1,250** | **shortlist only** | the "why" + position context | **≤8/day = 10K cr** |
| `/v2/token/{addr}/devs` `/holders` `/stats` | 250 ea | gated candidates | dev/serial-deployer rug signal, smart-money holders, flow | ≤6/day = 1.5K cr |
| `/v2/users/{handle}/positions\|balances` | 250 | gated | eval entry/exit + mirror | ≤4/day |
| `/v2/trade/{id}` `/comments` | 250 | gated | thesis thread | rare |

**Daily spend ≈ 15K–20K cr of 250K** (~8%). **Free-cap math guards nothing else; the real
free wall is the request cadence — respect 20 rpm** (leaderboards = 6 calls/min, fine).

### GMGN (keyed, leaky-bucket ~10 req/s weight-based)
| Endpoint | Cost | Frequency | What it feeds | Budget |
| --- | --- | --- | --- | --- |
| trending / rank | weight | 1×/cycle | candidate hints + market overlay | ≤2 calls/cycle |
| `token_security` | weight | gated | security enrich | only post-gate, cached |
| token `info/pool/holders/traders`, smart-money, PnL | weight | gated | enrichment + emit hints | only for surviving candidates |

No hard monthly credit cap (volume-based access), but the leaky bucket (~10 req/s) is the
real limiter — pace batches and keep calls gated/cached.

---

## 4. ENRICHERS — hydrate known candidates

### 4.1 Market data
| Source | Free tier | Endpoints + Cr | Budget rule |
| --- | --- | --- | --- |
| **DexScreener** | 300 rpm pair/token; 60 rpm profiles | batch `/latest/dex/tokens` (≤30 addr/call) → volume h24/h1, liquidity, fdv; `/token-profiles`; `/token-boosts` | **primary market enricher** — batch 30 to burn ~1 call per 30 tokens (≈9K inputs/min ceiling). Cache + use `volume.h1` (impl `0fc0c40`). |
| **DEXPaprika** | keyless 15 rpm / key 30 rpm, **100K cr/mo**, 1 req=1 cr, **402** | `search`, tickers, `dexs/{chain}/pools` | **cap ~3,000 calls/day** (~3K cr/say 3% of 100K). Use keyed 30 rpm; handle `402` as "provider exhausted, skip cycle". |
| **GeckoTerminal** | **30 calls/min** | `new_pools`, `trending`, `pools/{net}/{addr}`, `tokens/{net}` | **≤8 calls/cycle**, pace to <30/min. Tightest budget of all — treat as scarce. |
| **CMC DEX** | keyless 35; key **15K cr/mo, 50 rpm** | new-pair walking, holders, `/v1/dex/*` | optional; keyed **500 cr/day**, 50 rpm. |
| **CoinStats** | **20K cr/mo, 2 rps** | wallet/portfolio, prices | optional; **~660 cr/day**, 2 rps. |
| **Birdeye** | **30K CU/mo, 1 rps, no overage, ~20 endpoints** | price/OHLCV, `/defi/v3/price/stats/single` (~5 CU, **unverified**) | **tightest CU**; **≤1,000 CU/day**, 1 rps. Optional, probe `stats/single` CU before trusting a floor. |

### 4.2 Security
| Source | Free tier | Endpoints + Cr | Budget rule |
| --- | --- | --- | --- |
| **GoPlus** | free, license-free, daily CU | `token_security`, `token_solana`, wallet security | only for candidates that reached the security gate; **cache per address**; daily CU cap. |
| **Helius DAS** | 1M cr/mo | `getTokenAccounts` (10 cr) → holder count, top-10 %, mint/freeze authority | only for sol candidates at the gate; ~20/cycle = 200 cr/hr. |
| **Arkham** | trial 100K cr | `/intelligence/address/{a}` (1 cr), `/all` (2 cr), `entity`, `entity_prediction`, `search` (30 cr), batch (250 cr) | **entity/deployer/label/counterparty** (1–2 cr each); **avoid batch(250) & search(30)** except shortlist; cap ~100 cr/day → trial lasts the whole experiment. |

### 4.3 Wallet
- **custom wallet-graph** (internal, P0) — free, from transport.
- **Arkham** entity labels — entity lookup (1 cr).
- **Helius** `getAssetsByOwner` (10 cr) — positions per wallet; gated.
- **FOMO** `/v2/users/{handle}/positions|balances` (250) — copy-trading mirror; gated.

### 4.4 Regime / context (NOT token-score voters)
| Source | Endpoint | Cost | Budget |
| --- | --- | --- | --- |
| **DeFiLlama** | `/v2/chains`, `/overview/dexs` | free, no auth | **cache hourly**; no credit wall. |

---

## 5. Recommended scheduling (per screening cycle) — max data, min burn

**Cheap-introducer / emitter loop first (≠gated):**
1. Helius: sigs → decode `create` → **INTRODUCE** mints (≤100 cr).
2. Ankr: PairCreated logs → **INTRODUCE** pairs (bounded RPC).
3. FOMO: 3 leaderboards + 3 token boards (1.5K cr) + keep `/ws/alerts` open (0). **EMIT** hints.
4. GMGN: trending/rank → **EMIT** hints + overlay (weight).

**Merge → on-chain verify → candidate.**

**Enrich only candidates that passed the cheap gate (waterfall):**
5. Market: **DexScreener batch 30** (volume1h) → DEXPaprika (cap 3K/day) → Gecko (≤8/cycle) → CMC/CoinStats/Birdeye (daily caps, optional).
6. Security: GoPlus → Helius `getTokenAccounts` (sol) → Arkham entity (1–2 cr).
7. **Shortlist only** (expensive): FOMO thesis (1,250) + identity resolve (2,500) + devs/holders; GMGN holders/traders/smart-money; Arkham batch-free entity, not score.

**Cross-provider free-wall handling:** every provider behind a per-provider cap + rpm bucket;
`402`/`429` → skip provider this cycle (exponential backoff), log, let `CandidateRegistry.stats()`
demote it. No provider may block the funnel.

---

## 6. Expected free-tier headroom (per month)

| Provider | Free cap | Our plan | Headroom |
| --- | --- | --- | --- |
| Helius | 1,000,000 cr | ~50–250 cr/hr ≈ 6–60k | **>94%** |
| FOMO API | 250,000 cr | ~15–20k | **~92%** (only thesis/resolve taps the wall) |
| DEXPaprika | 100,000 cr | ~90k (3K/day) | ~10% (the tightest after Gecko) |
| GeckoTerminal | 30/min, no mo cap | ≤8/cycle | rate-pace only |
| Birdeye | 30K CU | ≤30k | ~0–10% — keep optional / probe CU |
| CMC | 15,000 cr | ≤15k | ~0 (drain if keyed hard) — keep optional |
| CoinStats | 20K cr | ≤20k | ~0 — keep optional |
| Arkham | 100,000 cr | ~3–10k | **>90%** |
| GoPlus | daily CU | gated+cached | comfortable |

**Takeaway:** DexScreener + Helius + FOMO + DEXPaprika + Arkham + GoPlus run comfortably on
free tiers. **Birdeye, CMC, CoinStats are the tightest and should stay optional** — only pull
if the empirical registry data shows unique value (per the second-opinion demotions). Everything
stays in-budget because **expensive endpoints are shortlist-gated and cheap ones are cached.**