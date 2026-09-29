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
| **3. CANDIDATE EMITTER** | can surface an interesting address/unit for investigation — NOT truth | **FOMO API (fomoapi.io)**, **GMGN** — trader/attention intelligence + leaderboards |
| **4. ENRICHER** | adds facts to an existing candidate | DEXPaprika, GeckoTerminal, DexScreener, CMC, CoinStats, Birdeye, GoPlus, Arkham, Moralis, Blockscout, Routescan, DeFiLlama (regime) |

The single most important correction to BOTH prior documents: **many listed sources
are trading-terminal UIs, not data feeds.** The ones with a real free-tier developer
API are **FOMO API (fomoapi.io)**, **GMGN**, plus the classic market/security/RPC feeds.
BullX, Photon, and Axiom expose **no public free API** — they belong either on-chain or skipped.

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

### 1.3 Candidate emitters / trader intelligence — REAL APIs only

| Source | Free tier? | Endpoints (free) | Verdict |
| --- | --- | --- | --- |
| **GMGN** | ✅ (key; gmgn-cli/OpenAPI/Agent API) | trending/rank, `token_security`, token `info/pool/holders/traders`, smart-money, PnL; leaky-bucket ~10 req/s weight-based | solid candidate-emitter API |
| **FOMO API (fomoapi.io)** | ✅ **250K cr/mo (~1K calls)**, every endpoint; `/ws/alerts` realtime 7d then 15s; **unmetered WS messages** | leaderboards, trader PnL, wallet resolution, theses, dev attribution, smart-money holders, app-feed WS — see §1.3a | **best free trader-intelligence API**; covers **Robinhood Chain + Solana + base/bsc/eth/monad/arc** |
| **pump.fun** | ❌ official; ✅ PumpPortal WS / on-chain | — | go on-chain or WS |
| **BullX** | ❌ no public free API | — | on-chain or skip |
| **Photon** | ❌ no public free API (trades via Bitquery = paid) | — | on-chain or skip |
| **Axiom (axiom.trade)** | ❌ "does not provide a public API" | unofficial reverse-engineered lib | on-chain or skip |

**Finding (corrected):** of the six "candidate emitter" sources named in the second
opinion, **exactly two have a real developer API: GMGN and FOMO API.** BullX / Photon /
Axiom are trading-terminal UIs with no public free API; pump.fun has no official data API.
FOMO API is the strongest fit for the leaderboard/trader-intelligence subsystem — see below.

#### 1.3a FOMO API (fomoapi.io) — the trader/attention-intelligence feed

Independent, **unofficial** developer product mirroring fomo.family's public data (not
affiliated/endorsed). Provenance caveat applies: it is a proxied view of a social-trading
app, so it is **candidate-emitting/intelligence, never canonical discovery truth.**

- **Free:** 250,000 credits/mo ≈ 1,000 normal calls (≈100 wallet resolutions, ≈200 theses);
  **every endpoint**; App feed WS `/ws/alerts` realtime for 7 days then 15s delayed;
  messages **unmetered**; 1 key; free cap 20 req/min; +500K cr for adding a card (no charge).
- **Credits:** normal/leaderboard/trades/balances/holders = **250**; `/v2/alerts` = 125;
  thesis = **1,250**; wallet resolution `/v2/users/{handle}` + `/v2/users/id/{userId}` = **2,500**.
- **Chains:** Robinhood Chain (4663) **— FOMO's most active chain —**, Solana, Ethereum,
  Base, BSC, Monad, Arc (5042), Hyperliquid perps. Note RH/Sol coverage is free-tier.
- **Endpoints:**
  - `/v2/leaderboard/{24h|7d|30d|all}` — ranked traders, **PnL + volume + both on-chain
    wallets + userId per row** → feeds the **24h ∩ 7d ∩ 30d persistent-trader intersection**.
  - `/v2/leaderboard/tokens/trending|most-held|graduated` — token boards.
  - `/v2/users/{handle}` — **Trader Identity Resolver**: handle → Solana + EVM wallets,
    PnL (`24h/7d/30d/all`), account age, hold time, clan; `/id/{userId}` reverse.
  - `/v2/users/{handle}/positions|balances|following|followers|spotlight` —
    positions w/ entry/exit & realized/unrealized PnL, multi-chain portfolio, follow graph.
  - `/v2/token/{address}/devs` — **deployer + insiders + thesis** (rug / serial-deployer signal);
    `/holders` — smart-money holders; `/stats` — buy/sell flow, top10-holder%.
  - `/v2/trades/{tradeId}` + `/comments`; `/v2/thesis[/token/{mint}|/user/{id}]` — the written "why".
  - `/v2/search`, `/v2/tokens/search`; `WSS /ws/alerts` (per-trader / per-chain, unmetered),
    `GET /v2/alerts`, `/v2/notifications`. On-chain `/ws/trades` is Growth+.
- **Role:** **CANDIDATE EMITTER + trader/attention intelligence.** Maps ~1:1 onto the second
  opinion's leaderboard pipeline: leaderboard → identity resolve → wallet graph → PnL persistence
  → 24h∩7d∩30d intersection. It does NOT vouch for what a token *is* — on-chain verification still gates promotion.

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

### Candidate emitters / trader intelligence (recall without authority)
- **FOMO API** leaderboards (`24h|7d|30d`) + trader PnL + theses + dev/insider attribution + app-feed WS.
  Its `/v2/leaderboard/*` and `/v2/users/{handle}` rows are emitted as `CandidateHint`; the
  registry verifies on-chain (does the mint exist? does the pair exist?) before promotion.
  This is the primary feed for the **24h ∩ 7d ∩ 30d persistent-trader intersection**.
- **GMGN** trending/trenches/signals → emit `CandidateHint` (same verify-gate).
- Pump.fun/BullX/Photon/Axiom → **no official free API**; route to on-chain producer parsers
  or PumpPortal WS (pump.fun only). GMGN + FOMO API are the immediate APIs in this tier.
- **Provenance rule:** fomoapi.io and GMGN reflect a social-trading app's view — they say
  "this looks interesting", never "this exists". Canonical existence is decided on-chain.

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
| 6–7. “Add trader/attention intelligence layer; leaderboard = own pipeline” | ✅ **Agree, and now directly feasible** — **FOMO API (fomoapi.io)** is purpose-built for it (leaderboards 24h/7d/30d, trader PnL, wallet resolution, theses, app-feed WS) and free-tier. The remaining hand-built part is the **cross-platform intersection + wallet graph** (custom-onchain). |
| 8. “custom-onchain should be P0” | ✅ **Agree strongly.** This is the durable moat; third parties are not. |
| 9. Demote CMC/CoinStats/Moralis/Birdeye, keep optional | ✅ **Agree** (CMC enrichment-optional; Birdeye non-architectural; Moralis gated). |
| 10. “Arkham for entity resolution, not another score” | ✅ **Agree.** entity/deployer/label/counterparty is the valuable use. |
| 11. “DeFiLlama = regime/context, not a token-score voter” | ✅ **Agree.** |
| 12. Revised architecture diagram | ✅ **Adopt** — clean and implementable. |
| 13. Observation/Feature/Inference + 14. Lineage in FeatureSnapshot | ✅ **Agree, high value.** Makes the system auditable and ML-ready. |

### Critical caveat the second opinion misses — corrected
- **Of the six "candidate emitter" sources, only TWO have a real developer API: GMGN and
  FOMO API.** FOMO API (fomoapi.io) is free-tier and, unlike GMGN, is purpose-built for the
  leaderboard/trader-intelligence layer — `/v2/leaderboard/{24h|7d|30d}`, trader PnL persistence,
  wallet resolution, theses, dev attribution, and an unmetered app-feed WS. It even covers
  **Robinhood Chain** (FOMO's most active chain).
- **BullX, Photon, and Axiom are UI terminals with no public free API**; pump.fun has **no
  official data API** (use PumpPortal WS or on-chain instruction parsing).
- So the leaderboard/trader-intelligence subsystem CAN be fed free today via FOMO API (+ GMGN),
  and the durable moat still sits in **custom on-chain** (wallet graph) — the report's P0.

### A source-count nit (the second opinion flags this — it's correct)
- The prior report is inconsistent: "17 sources" in one place, "18 numbered" elsewhere.
  Reconcile to a single, explicit inventory. This report fixes it via the role table above.

---

## 4. Decision summary

- **Implement as directive:** the four-role model; Ankr (EVM) and Helius (Sol) as the only
  canonical introducers; **FOMO API + GMGN** as the candidate-emitter / trader-intelligence
  tier (FOMO for the 24h∩7d∩30d leaderboard intersection — incl. Robinhood Chain); everything
  else enrichment. custom-onchain = P0. Keep the empirical promote/demote via registry stats.
- **Do NOT implement verbatim:** treating BullX/Photon/Axiom as sourceable feeds; the universal
  "ETH introducer" framing; DeFiLlama as a token-score voter; fomo *without* the on-chain
  verify gate (it is a proxied social-app view, not discovery truth).

---

## 5. Addendum — fresh pass vs actual current `master` (2026-09-29)

### 5.0 Git-state reconciliation (reads this section first)

A later review was run against head **`143ea05d`** and reported a red CI: **1 of 1,140 tests
fails** in `tests/robinhood-agent-additional-sources.test.ts` (composition-root DexScreener
test — expected 1 candidate, received 0). That review predates the pushed work on this branch.

**Actual current `master` is `c5d165f7`**, and `143ea05d` is **5 commits below it**
(`143ea05d` → `1dba05f` → `88db13d` → `4c00920` → `6c22a64b` → `c5d165f7`). The DexScreener
failure at `143ea05d` is the **cross-test `globalSourceQuota` leak** — a test in file `(c)`
injects a throwing DexScreener, which registers a cooldown on the process-global quota and
leaks into the following healthy-collector test. That was already fixed in `c5d165f7`
(`afterEach` now clears `globalSourceQuota`).

**Verified on current `master` (`c5d165f7`, clean tree, via SSH fetch of the real remote):**
- `tests/robinhood-agent-additional-sources.test.ts` → **4/4 pass**.
- Full gate `npx vitest run --coverage` → **158 files / 1136 tests pass**, coverage thresholds
  hold, `tsc --noEmit` clean.

So the fresh-pass's priority #1 ("fix failing DexScreener test") is **already satisfied** on
the current branch. Do not re-apply it.

### 5.1 Approved scope correction (two-of-six)

Of the six "candidate-emitter" sources named in the second opinion
(GMGN / FOMO / Pump.fun / Axiom / DEXScreener / BullX / Photon), **only two have a real
developer API in-repo: GMGN and FOMO API.** There is **no adapter for BullX, Photon, or Axiom**
(UI terminals, no public free API), and pump.fun has no official data API (route on-chain /
PumpPortal WS). Approved scope = the leaderboard/trader-intelligence layer is fed via
**GMGN + FOMO API**; the rest are on-chain.

### 5.2 Fresh-pass claims verified against current code

| Fresh-pass claim | Verdict | Evidence (current `master`) |
| --- | --- | --- |
| A DiscoveryCoordinator already exists; don't build another | ✅ | `src/discovery/candidate-emitter.ts` — `DISCOVERY_PRIORITY` is exactly `dexpaprika, gecko, dexscreener, tape, track, ankr, routescan, cmc, solana-rpc, ws-tape, solanatracker, fomo`; handles priority, fail-soft, cooldowns, GMGN overlay. |
| **The real gap: source-level observations are lost before `CandidateRegistry`** | ✅ **Confirmed** | `discoverAll()` (candidate-emitter.ts:106-149) merges by address and returns **only the merged `GMGNRawToken[]`**. The agent then calls `globalCandidateRegistry.observe()` (robinhood-screening-agent.ts:955-964) **once per survivor** with a single `source = discoveredBy ?? source`. Per-source first-seen, multi-source sighting, and latency (`latencyMs`) are therefore never recorded — each candidate carries only its surviving source. "Who saw it first / how many did Gecko find / how much later" is currently unanswerable from registry stats. |
| Pool/Dex identity is dropped by normalization | ✅ | `MarketToken` has `pairAddress?` / `dex?` (market-data-provider.ts:27-28; ankr/dexscreener/dexpaprika/cmc all set them), but `normalizeDexToken()` (robinhood-discovery.ts:49+) maps to `GMGNRawToken`, which retains neither. Token↔pool separation is lost. |
| FOMO isn't on the CandidateHint path it documents | ✅ | `FomoTokenBoardProvider implements MarketDataProvider` (fomo-emitter.ts:18); `fomo` sits in `DISCOVERY_PRIORITY` as a normal emitter. `candidate-hints.ts` (`CandidateHint` → verify → promote) exists but is **not** FOMO/GMGN's canonical path. |
| TraderPersistence is already good; needs durability | ✅ | `trader-persistence.ts` has 24h/7d/30d freshness + `strictPersistent`; `wallet-graph.ts` has wallet-native cohorts + provider attribution. Still process-local `Map`s — restart loses history. |
| FeatureSnapshot is sound but not final/persistent + coarse provenance | ✅ | `features/feature-snapshot.ts` has `evidenceLineage`, `modelVersion`, `Object.freeze()`, but is attached to a payload, not a durable record; `buildFeatureSnapshot()` accepts one `source`/`fetchedAt` applied across a whole group. |
| DecisionLedger / PaperTradingLedger are JSONL/Map, not rebuilt from durable history | ✅ | `database/decision-ledger.jsonl` append-only; runtime state is `events[]`/`Map`; `PaperTradingLedger` is a process-local `Map` — paper-gate knowledge resets on restart. |

### 5.3 Adopted forward directive (from the fresh pass)

1. **Green CI first** — already done on current `master` (§5.0). Any future change must not
   regress it.
2. **Add PostgreSQL as the durable evidence/history layer** — but **do not start by converting
   every JSON file to SQL.** Start at the **observation boundary** (migrate the lost source-level
   observations first), then move existing ledgers behind their current APIs.
3. **Discovery layer produces two outputs**, not one merged list:
   `{ candidates: GMGNRawToken[], observations: DiscoveryObservation[] }` (or an
   `onObservation` sink before merge), so `CandidateRegistry` sees every per-source sighting.
4. **Model token / pool / wallet / trade as separate entities**; preserve `pairAddress` / `dex`
   through normalization.
5. **Make FOMO/GMGN true hint sources** — `CandidateHint` → on-chain verify → promote — while
   on-chain/RPC/WS sources may introduce candidates directly.
6. **Redis = ephemeral only** (queues/locks/rate-limits/TTL); **Postgres = durable**
   (observations, snapshots, decisions, fills, paper trades, learning datasets).
7. **`ResearchCoordinator`** — the one genuinely new coordinator (cheap→medium→costly evidence
   policy) — do **not** build a second DiscoveryCoordinator.
8. **FeatureSnapshot must be truly final + persisted** — build it only after all enrichment and
   security evidence, with per-feature provenance.
9. Do **not** build microservices/Kafka/Temporal — one process, data plane separated from the
   decision plane.

### 5.4 Caveat on the fresh-pass's test count

The fresh pass reports "1,140 tests" at `143ea05d`; current `master` runs **1,136** tests. The
delta is from the price-migration rewrite of `tests/price-feed-service.test.ts` (fewer, denser
cases) landing between the two heads — it is not a test removal from the review's own work.

---

## 6. Author's improvement recommendations (beyond the reviews)

What I would add on top of the adopted directive. Each is grounded to a current file and tagged
`P0/P1/P2` × `S/M/L` (priority × effort). None requires microservices or a schema dump; all are
incremental and keep the current architecture recognizable.

### 6.1 Per-pass `pass_receipt` — audit, not log-grep (P0 · S)
We diagnose `fired=0` by grepping `[PREFILTER REJECTS]` / `[STALE GATE]` lines. Promote that to an
**immutable per-pass record**: timestamp, chains scanned, candidate count by source, budget spent,
sources that failed/degraded, and gate outcomes (prefilter / stale / consensus / execution). Write
it beside the existing diagnostics. Turns "did the bot fire" from log-grep into a queryable fact.
→ `screening-cycle.ts`, `robinhood-screening-agent.ts`.

### 6.2 Structured logger + per-pass trace id (P0 · S)
Adapters log ad hoc `[PRICE SERVICE ERROR]`, `[GMGN ERROR]`, `[DISCOVERY]`, `[AGENT RUNNER]` with
no shared schema or correlation id. A single `trace(id)` wrapper (request-id per pass) lets you
answer "what did this pass actually touch" without text-grep, and pairs with 6.1 to make the
receipt reproducible. → `source-quota.ts`, `DiscoveryCoordinator`, adapters.

### 6.3 Source-health canary → availability into promote/demote (P1 · S/M)
`CandidateRegistry.stats()` has coverage/latency/dup/fp/spend but **no availability/uptime**
dimension — exactly what the second opinion asked for (point #5). Add a periodic canary that pings
each free endpoint and records a rolling availability score. Makes promote/demote robust to
"source was down this week," not only "source was first-seen early." → `discovery-registry.ts`,
`provider-governor.ts`.

### 6.4 Centralize address normalization + a canonical entity key (P1 · S)
Dedup today is `address.toLowerCase()` (EVM) vs base58 (sol) handled implicitly and inconsistently.
A single `canonicalEntityKey(chain, address)` used by `CandidateRegistry.id()`, the coordinator
merge, and any future token/pool table kills a whole class of dedup bugs (lowercased sol addresses,
checksummed eth) — before Postgres makes them expensive. → `discovery-registry.ts`,
`candidate-emitter.ts`.

### 6.5 Hard-gate vs soft-feature degradation (P1 · M)
The system fail-closes broadly on missing data. Distinguish:
- **HARD gates** (must-have for safety): security, sellability, on-chain existence → fail-closed.
- **SOFT features** (degrade gracefully): Arkham entity labels, sentiment, klines → mark
  low-confidence and apply a risk discount instead of killing the pass.
This generalizes the `feed-down ≠ dead-pair` distinction we already proved for volume across the
whole enrichment layer, preserving liveness when a non-critical provider blips. → `prefilter`,
`swarm-consensus.ts`, `source-quota.ts`.

### 6.6 Golden normalization fixtures per chain (P1 · S)
The CoinGecko→GeckoTerminal migration broke 3 tests precisely because a provider shape changed.
Add golden fixtures for the normalization boundary (`normalizeDexToken`, `normalizeTapeWindow`)
per chain so a provider format change is caught in CI at the boundary, not as a deep behavioral
regression. Optionally: env-gated contract tests against the real free endpoints that regenerate
the fixtures. → `robinhood-discovery.ts`, `tests/`.

### 6.7 Self-writing `DISCOVERY_INTRODUCERS` proposal (P2 · M)
The 2–4 week empirical observation is scaffolded, but acting on it is a manual env edit. Add a mode
where, once stats mature, the system *proposes* an allowlist (`[DISCOVERY PROPOSAL] promote:
[gecko, ankr]; demote: [cmc]`) and flags when config contradicts the measured primary. Closes the
"measure, don't hand-pick" loop. → `discovery-registry.ts`, `isIntroducerEnabled` gate.

### 6.8 Instrument the 24h∩7d∩30d intersection surface (P2 · S)
`persistence-cohort.ts` already computes the persistent-trader tiers. Add a small recorded surface
(cohort size, `COHORT_CONVERGENCE` events, count of tier-C traders) so the trader-intelligence
layer's value is measurable during the observation window — otherwise we can't tell whether
FOMO/GMGN spend earns its keep. → `persistence-cohort.ts`, `trader-persistence.ts`.

### 6.9 Single typed provider-config schema with boot validation (P2 · S)
There are ~a dozen provider env-gates (`ANKR_FEED_ENABLED`, `DISCOVERY_INTRODUCERS`, `GMGN_API_KEY`,
`FOMO_API_KEY`, budget envs). `startup-validation.ts` exists but is partial. Centralize into one
typed config object validated loudly at boot so a misconfigured provider fails fast
(`FOMO_API_KEY missing`) instead of silently yielding no candidates. → `startup-validation.ts`,
`config/`.

### 6.10 Full clock injection for determinism (P2 · S/M)
Several components already take an injectable `now()` (`candidate-emitter.ts`, `source-quota.ts`,
`ttl-cache.ts`). Extend that to every time-dependent module (registry `observed_at`, persistence
windows, staleness) so the whole suite is deterministic under a frozen clock — exact reproductions
of any reported pass. → `discovery-registry.ts`, `trader-persistence.ts`, `staleness-clock.ts`.

### 6.11 Where these sit in the adopted sequence
- **Phase A (before DB):** 6.1, 6.2, 6.4, 6.6, 6.10 — observability + normalization hardening,
  DB-independent, all small.
- **Phase B (with durability):** 6.3 (availability into stats), 6.5 (degradation tiers), 6.7,
  6.8, 6.9.
- **Do now, alongside P13/P10 correctness fixes:** 6.1 + 6.2 (they make the existing diagnostic
  work auditable).