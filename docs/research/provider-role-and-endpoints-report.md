# Provider Role + Free-Tier Endpoint Report (my own synthesis, 2026-09-29)

Reconciles the **v2 architecture report**, the **18-source calibration matrix**, and the
**second-opinion review** against (a) current official free-tier endpoints and (b) the
repo `src/`. Goal: assign every source to the **four-role model** and list the actual
free endpoints each exposes.

---

## 0. TL;DR — the four roles, and who goes where

| Role | Meaning | Sources |
| --- | --- | --- |
| **1. TRANSPORT** | raw chain access; no units of "token" | Helius RPC/WS/DAS, RH RPC, Ethereum/Base/BSC RPC pool, Geyser/Yellowstone (optional) |
| **2. CANONICAL INTRODUCER** | detects a real chain/protocol event (fact, not opinion) | **Helius (sol, impl)**, **Ankr/PairCreated (eth, base, bsc)** |
| **3. CANDIDATE EMITTER** | can surface an interesting address/unit for investigation — NOT truth | **GMGN**, gated leaderboards |
| **4. ENRICHER** | adds facts to an existing candidate | DEXPaprika, GeckoTerminal, DexScreener, CMC, CoinStats, Birdeye, GoPlus, Arkham, Moralis, Blockscout, Routescan, DeFiLlama (regime) |

The single most important correction to BOTH prior documents: **many listed sources
have no public free API and are trading-terminal UIs, not data feeds** — they belong in
role 3 (candidate emitter) only where a real API exists, or are better sourced
**directly on-chain**.

---

## 1. Free-tier endpoint catalog (verified)

### 1.1 Canonical introducers / transport — Solana

**Helius** (key required; free = 1M cr/mo, 10 RPC rps / 2 DAS rps)
- RPC: `getSignaturesForAddress` (**10 cr**), `getTransaction` (**10 cr**),
  `getProgramAccounts` (**10 cr** — avoid), `getProgramAccountsV2` (**1 cr**)
- DAS: `getTokenAccounts` (**10 cr**), `getAssetsByOwner` (10 cr),
  `getAsset`, `getAssetsByCreator`, `searchAssets` (10 cr each)
- Enhanced: `getParsedTransaction`/`getParsedTransactions` (**100 cr**, free-until-2026-09-21
  on paid plans only for Parsed Events)
- **Webhooks** — **1 cr/event**; the preferred production introduction path
- Code: `HeliusDiscoveryFeed` (impl `a149d0b`) uses `getSignaturesForAddress` +
  `getTransaction` SPL-`create` decode; `HeliusFeed.tokenAccounts` (DAS) for security.
  **Never polls `getProgramAccounts`.**

**Pump.fun** — **no official public data API** (verified). The program *is* the discovery
surface:
- New mints are raw SPL `create` instructions — already captured by the Helius feed decode.
- Real-time alternative: **PumpPortal WS** `wss://pumpportal.fun/api/data` (third-party,
  free, no key) streams token-create/migrate/trade events.
- Bitquery pumpfun API = paid ($49/mo).

### 1.2 Canonical introducers — EVM

**Ankr-style PairCreated** (repo `AnkrDiscoveryFeed`, keyless via RPC failover pool)
- `eth_getLogs` on Uniswap V2 / Pancake V2 / Uni-V2-Base factories; topic0
  `PairCreated`. Free (RPC credits). Confirmed factories in `ankr-discovery-feed.ts`.
- Scope correction (second-opinion #3): this is a **Uniswap-V2-compatible-factory
  introducer**, not a universal "ETH introducer". V3/Aerodrome/Pancake-V3 need their own logs.
- RH: **no verified factory** (confirmed `eth_getCode` = `0x`); Pons introducer blocked.

### 1.3 Candidate emitters — REAL APIs only

| Source | Free API? | Endpoints (free) | Verdict |
| --- | --- | --- | --- |
| **GMGN** | ✅ (key; `GMGN_API_KEY`, gmgn-cli/OpenAPI) | trending/rank, `token_security`, `token info/pool/holders/traders`, smart-money, PnL; leaky-bucket ~10 req/s weight-based | **only real candidate-emitter API** |
| **pump.fun** | ❌ official; ✅ PumpPortal WS / on-chain | — | go on-chain or WS |
| **BullX** | ❌ no public free API | — | on-chain or skip |
| **Photon** | ❌ no public free API (trades via Bitquery = paid) | — | on-chain or skip |
| **Axiom (axiom.trade)** | ❌ "does not provide a public API" | unofficial reverse-engineered lib | on-chain or skip |
| **fomo (fomo.family)** | ❌ no public free API | UI + social platform | on-chain or skip |

**Finding:** of the six "candidate emitter" sources named in the second opinion, **only
GMGN has a developer API**. BullX/Photon/Axiom/fomo are trading-terminal UIs. Treating them
as first-class feeds is not implementable today without scraping or paid middlemen; the
trader-intelligence layer is best built **on-chain** (wallet graph from transport data) — the
report's "custom-onchain P0" already says this.

### 1.4 Enrichers

| Source | Free tier | Free endpoints | Rate/lock |
| --- | --- | --- | --- |
| **DEXPaprika** | keyless 15 rpm / key 30 rpm, 100K cr/mo, 1 req=1 cr, **402 when empty** | `search`, tickers, `dexs/{chain}/pools`, pools/{id} | corrected: **limited** |
| **GeckoTerminal** | 30 calls/min | `new_pools`, `trending_networks`, `pools/{network}/{address}`, `tokens/{network}` | tightest budget |
| **DexScreener** | 300 rpm (pair/token), 60 rpm (profiles/boosts) | `/latest/dex/tokens`, `/latest/dex/pairs`, `/token-profiles`, `/token-boosts`, `/latest/dex/search`; batch 30 → ~9K/min | confirmed |
| **CMC DEX** | keyless 35 endpoints (18 Standard + 17 DEX); key 15K cr/mo, 50 rpm | `/v1/swap`, DEX new-pair walking, `/v1/dex/*` | confirmed |
| **CoinStats** | 20K cr/mo, 2 rps | wallet/portfolio, prices, 34 endpoints | corrected: **20K/2rps** |
| **Birdeye** | 30K CU/mo, 1 rps, **no overage**, ~20 endpoints, "Limited" access | price/OHLCV, `/defi/v3/price/stats/single` (CU **unverified**) | confirmed; keep optional |
| **GoPlus** | free security API, license-free, daily CU budget | `token_security`, `token_solana`, wallet security | confirmed; free tier exists |
| **Arkham** | free **trial 100K cr** (ind) / 1M (org); paused at cap; x402 PAYG $0.20/cr | `/intelligence/address/{a}` (1 cr), `/all` (2 cr), `entity`, `entity_prediction`, `token`, `search` (30 cr) | corrected: has a real free trial |
| **DeFiLlama** | **free, no auth, 31+ endpoints** | `/protocols`, `/v2/chains`, `/overview/dexs`, yields, stablecoins, fees | regime/context only |
| **Moralis** | 40K CU/day, 40 rps | wallet token balances, EVM API | gated/W3 |
| **Routescan / Blockscout** | keyless explorer | new-token, holders, ERC-20 transfers | keep optional |

---

## 2. Who is FIRST-DISCOVERY vs ENRICHMENT

### First-discovery (canonical introducers) — the "units" are on-chain facts
- **EVM:** Ankr PairCreated (eth/base/bsc V2-style) — a real contract event.
- **Sol:** Helius instruction decode / webhook of SPL `create` + protocol programs
  (pump/meteora/raydium/orca parsers) — a real instruction. Helius = provider, not the engine.
- These are the ONLY sources that should promote a raw address into the **candidate universe**.
  They have **no market data at birth** (price/liquidity/volume = 0, `freshLane: true`).

### Candidate emitters (recall without authority)
- **GMGN** trending/trenches/signals → emit `CandidateHint`; the registry verifies on-chain
  (does the mint exist? does the pair exist?) before the mint becomes a candidate.
- Pump.fun/BullX/Photon/Axiom/fomo → **no free API**; route to on-chain producer parsers or
  PumpPortal WS. GMGN is the only immediate API in this tier.

### Enrichment (hydrate known candidates)
- Market: DEXPaprika, GeckoTerminal, DexScreener, CMC, CoinStats, Birdeye (1h volume).
- Security: GoPlus, Arkham (entity/deployer/labels), CoinStats risk, Helius DAS
  `getTokenAccounts` (holder concentration + mint/freeze authority) + custom on-chain.
- Regime/context (NOT token-score voters): DeFiLlama (chain/DEX TVL regime).
- Wallet: custom wallet-graph (internal), Arkham entity labels, Helius `getAssetsByOwner`.

**Decision input:** let `CandidateRegistry.stats()` (coverage/latency/dup/false-positive/
spend — already implemented `3ad1ee3`) drive promote/demote empirically over 2–4 wks.

---

## 3. Review of the second opinion

Overall: **strongly agree; adopt it as the directive.** The four-role split is the right
architecture and matches what the repo has already moved toward. Remaining disagreements below
are factual, not conceptual.

| # | Second-opinion claim | My verdict |
| --- | --- | --- |
| 1. “introducer vs enrichment is too binary” | ✅ **Agree.** Four roles (transport/introducer/emitter/enricher) is correct. |
| 2. “Don't say GMGN = never introducer” | ✅ **Agree**, with a guardrail — GMGN emits `CandidateHint`, never a confirmed candidate; on-chain verify before promotion. |
| 3. “ETH→PairCreated is too broad; name it Uniswap-V2-factory introducer” | ✅ **Agree** — genuinely narrower; V3/Aerodrome/Pancake-V3 need own log parsers. |
| 4. “Helius = provider, not the Solana discovery engine” | ✅ **Agree.** Make the engine program-aware (pump/meteora/raydium/orca parsers) with Helius as transport. Matches impl direction. |
| 5. “Expand the metric past first_seen_latency” | ✅ **Agree + already done** in `CandidateRegistry.stats()` (coverage/latency/dup/fp/spend). |
| 6–7. “Add trader/attention intelligence layer; leaderboard = own pipeline” | ✅ **Agree in principle** — but see critical caveat below. |
| 8. “custom-onchain should be P0” | ✅ **Agree strongly.** This is the durable moat; third parties are not. |
| 9. Demote CMC/CoinStats/Moralis/Birdeye, keep optional | ✅ **Agree** (CMC enrichment-optional; Birdeye non-architectural; Moralis gated). |
| 10. “Arkham for entity resolution, not another score” | ✅ **Agree.** entity/deployer/label/counterparty is the valuable use. |
| 11. “DeFiLlama = regime/context, not a token-score voter” | ✅ **Agree.** |
| 12. Revised architecture diagram | ✅ **Adopt** — clean and implementable. |
| 13. Observation/Feature/Inference + 14. Lineage in FeatureSnapshot | ✅ **Agree, high value.** Makes the system auditable and ML-ready. |

### Critical caveat the second opinion misses
- **The "candidate emitter" list is not implementable as stated.** Of
  GMGN/FOMO/Pump.fun/Axiom/BullX/Photon, **only GMGN has a public developer API.**
  BullX, Photon, Axiom, and fomo are UI terminals with **no public free API**; pump.fun has
  **no official data API** (use PumpPortal WS or on-chain instruction parsing). So the
  "leaderboard/trader intelligence" subsystem cannot be fed by those terminals' official
  APIs today — it must be built on **on-chain data** (wallet graph from transport),
  which the report's "custom-onchain P0" already owns.

### A source-count nit (the second opinion flags this — it's correct)
- The prior report is inconsistent: "17 sources" in one place, "18 numbered" elsewhere.
  Reconcile to a single, explicit inventory. This report fixes it via the role table above.

---

## 4. Decision summary

- **Implement as directive:** the four-role model; Ankr (EVM) and Helius (Sol) as the only
  canonical introducers; GMGN as the only immediate candidate-emitter API; everything else
  enrichment. custom-onchain = P0. Keep the empirical promot/demote via registry stats.
- **Do NOT implement verbatim:** treating BullX/Photon/Axiom/fomo as sourceable own feed;
  the universal "ETH introducer" framing; DeFiLlama as a token-score voter.