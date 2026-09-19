# Memeland External-Source Review

**Date:** 2026-09-19
**Scope:** Adopt / Adapt / Study / Skip classification of 260 external sources listed in `mml.docx`, judged end-to-end against Memeland's operating, safety, and edge constraints.
**Method:** **All 262 sources** in the manifest are now deep-reviewed by cloning, reading code beyond READMEs / fetching external docs, extracting evidence, and deleting clones: pass 1 = 24, Batch 9 = +4 Robinhood-chain, Batch 10 (subagent A) = +22 meme-smart-money/agents, Batch 11 (subagent B) = +24 MCP-data/market-data/chain, Batch 12 (subagent Meitner) = +24 trading-risk/agents/chain-execution, Batch 13 (subagent Pasteur) = +26 chain-data-infra/MCP-data/meme P0, Batch 14 (subagent Sagan) = +7 meme-smart-money P1, Batch 15 (subagent Volta + manual) = +8 agents/market-data/general, Batch 16 (subagent Kepler) = +11 meme-smart-money/GMGN external web, Batch 17 (subagent Boole) = +7 MCP-data/trading-risk/chain-execution, Batch 18 (subagent Rawls) = +33 general GitHub repos (incl. added SRC-261/262), Batch 19 (subagent Einstein) = +30 general GitHub repos, Batch 20 (subagent Planck) = +40 market-data/chain-data-infra/general external web. No source remains triage-only. No live-runtime code was modified.

---

## 1. Executive Summary

Memeland's architecture already encodes the right fail-closed philosophy (deterministic security gates before consensus, candidate-only output for LLMs, execution behind approval/risk gates, decoupled kill-switch, verified-outcome learning). Most external projects confirmed that shape rather than adding new edge.

The highest-value, lowest-risk moves are **porting algorithms, not adding frameworks**:

- **Copy GMGN's wallet-scoring algorithms** (track-record by outcome distribution, copy-tradeability backtest, dev-reputation with self-dealing discount, empty-history guard). This is a pure, chain-agnostic, deterministic port that reduces blind reliance on raw GMGN flow.
- **Adopt the GMGN `aitrader` pipeline shape** (cheap discovery -> top-N narrowing -> deterministic gates first -> LLM explains survivors only -> candidate output, never auto-execute; separate rules-based escape monitor). This is an architectural validation, not a dependency.
- **Reduce GMGN dependence on Robinhood Chain** using the RH-native RPC patterns from the FOMO ecosystem: keyless `eth_getLogs`/WS fill tape, wallet resolution from co-occurrence windows, receipt-verified fill ownership, and free sellability simulation. Ported to Memeland's existing adapters, this creates an independent confirmation source that works during GMGN outages.
- **Fold the smart-money scanner abstraction, accumulation detector, wallet-convergence signal, and rug-score heuristics** (holder concentration, LP lock/burn, mint/freeze/mutable) into existing voters and shared services.
- **Solana copy-trade mechanics** (proportional sizing, RPC failover pool, paper-broker dry-run) map cleanly onto the Solana feed's fail-closed design.

What stays out (Skip): full trading platforms (Freqtrade, Hummingbot), autonomous hedge-fund/agent swarms, MCP-wrapper ecosystems, browser scrapers, Solana-only MEV bots, and any unofficial/ToS-violating GMGN clients. These add operational weight or risk without demonstrable edge for a personal bot.

**Net verdict:** Memeland is well-positioned to go green. The plan below is a shortlist of focused, verifiable integrations - not a feature grab.

---

## 2. Source Inventory and Method

Canonical manifest: `source-manifest.json` (260 unique sources; CSV: `source-manifest.csv`; summary: `source-manifest-summary.json`).

- 202 GitHub repositories, 58 external/non-GitHub sources.
- Priority heuristic across the list: P0=91, P1=92, P2=77.
- Categories: meme-smart-money 65, general 78, mcp-data-tools 31, market-data 25, trading-risk-research 21, chain-data-infra 18, chain-execution 11, agents 7, robinhood 4.
- Deep-reviewed: **262** (status `reviewed` in the manifest, evidence in `notes/source-notes.md`).
- Triage-only: **0** (all manifest sources are now deep-reviewed).

Cloning was done in bounded batches (<=3 concurrent), tarball-based, and all 24 review clones were deleted. One stray artifact remains (see section 12).

---

## 3. Memeland Standing Constraints (Reference)

Full text in `memeland-constraints.md`. The key gates used to judge every finding:

- Personal-use bot; Node >=20 / TypeScript / ESM / npm / Vitest; RH Chain EVM (ID 4663, native ETH) primary, plus Solana/BSC/Base/Ethereum feeds.
- Seven-voter consensus (quant, ML, security, sentiment, whale, regime, critic) with >=80 gate; risk layers include `RiskManager`, `RiskEngineV2`, approval queue, kill-switch, and decoupled `MarketSentinel`.
- GMGN is the primary discovery/flow/security feed; provider independence is strategic value. GoPlus, GeckoTerminal, DeFiLlama, Hyperliquid, DexScreener, etc. are complementary.
- Discovery near market-data adapters; security before consensus; execution behind approval/risk gates; learning only after a verified outcome.
- Prefer deterministic local calculations, caching, batching, and shared adapters over added LLMs/frameworks; no duplicate schedulers/caches/uncontrolled fan-out.
- New intel sources fail soft; security/execution sources fail closed. Kill-switches observable and testable.
- Copied code still receives a security audit before it may run with keys. Keys/RPCs/webhooks/credentials must never be exposed or persisted.

---

## 4. Green-Label Shortlist

The concrete, recommended next integrations. Each item: *copy what -> where it belongs -> cost -> dependency change -> how to measure edge.*

### Adopt (green - port now)

1. **GMGN wallet-scoring algorithms -> whale / copy-trade voter** (`SRC-100`).
   - Copy: track-record from outcome distribution (not win rate); copy-tradeability with latency/slippage/gas/hold-time/bot-frequency backtest; dev-reputation with self-dealing discount; empty-history guard.
   - Belongs in: shared wallet-scoring service feeding the whale voter and the copy-trading timing path.
   - Cost: small deterministic TS module; no new network dependency (consumes existing normalized flow data).
   - Dependency: reduces blind reliance on raw GMGN flow; does not add or require GMGN keys.
   - Measure: compare per-wallet scores to actual copy-trade outcomes in dry-run; track the win/MAE distribution.

2. **GMGN `aitrader` pipeline shape -> discovery/consensus architecture** (`SRC-101`).
   - Copy: cheap trending -> top-N coarse filter -> deterministic rug/consensus gates run FIRST -> score/rank -> LLM explains survivors -> candidate output, never auto-executes -> separate rules-based escape/rug monitor polling outside the loop.
   - Belongs in: opportunity ledger + strategist discovery flow; aligns with Memeland's existing fail-closed gate.
   - Cost: architectural alignment, not a dependency; no new code mass.
   - Measure: record how often the LLM layer actually changes a deterministic decision; target ~0 for execution and ~high for readable rationale.

### Adapt (green with porting/hardening)

3. **RH-chain RPC fill tape + wallet resolution -> whale feed** (`SRC-076`, `SRC-117`, `SRC-070`).
   - Copy: token-filtered `eth_getLogs` loop for fill attribution; co-occurrence-window wallet resolution weighted by 1/number-of-makers; receipt-verified ownership; cursor/lag recovery; keyless public RPC.
   - Belongs in: shared RH chain data adapter + whale feed, independent of GMGN.
   - Cost: one RPC endpoint per chain (HTTPS + optional WSS); port listener/resolve logic to TS/viem.
   - Dependency: removes/softens GMGN dependence for RH flow; adds RPC-only dependency.
   - Measure: RH free-RPC fills should independently confirm the same whale moves as GMGN during normal operation; divergences tracked as coverage signal.

4. **Smart-money scanner abstraction + accumulation + preference scoring -> whale tracking** (`SRC-056`).
   - Copy: `BaseChainScanner`/`EvmChainScanner`/`SolanaScanner` shape; accumulation detector (>=3 buys of same token in 24h over a volume floor with cooldown); priority scoring matrix.
   - Belongs in: shared wallet tracker; per-chain scanner workers.
   - Cost: moderate TS port; per-chain RPC.

5. **Wallet-convergence signal -> shared consensus/whale heuristic** (`SRC-038`).
   - Copy: N distinct known-good wallets buying the same token within a time window as an independent confirmation + coordinated-cluster detector.
   - Belongs in: shared flow aggregation (computed from Memeland's own normalized data, not DOM scraping).

6. **Rug-score cross-chain heuristics -> security voter / rug scoring** (`SRC-080`).
   - Copy: holder-concentration thresholds, LP lock/burn, mint/freeze/mutable controls; pair with existing sellability/honeypot simulation.
   - Belongs in: existing `rug-scoring.ts` + security voter; Solana-specific plumbing only in the Solana feed.
   - Note: source scoring is crude/unnormalized; port ideas, normalize, do not copy wholesale.

7. **Solana copy-trade mechanics -> Solana feed** (`SRC-108`).
   - Copy: actual fill decoding from logs, proportional sizing with per-leader multiplier, RPC failover pool, and `PaperBroker` dry-run executor.
   - Belongs in: Solana copy-trading execution path, behind existing approval/risk gates.
   - Cost: moderate TS port; RPC pool (reuses Memeland's RPC failover).
   - Measure: dry-run paper fills vs live copied fills; slippage/fill-rate regression.

8. **Robinhood-chain execution layer -> RH adapters/executor** (`SRC-180` - best RH source found).
   - Copy: fast-submit directly to the RH sequencer (`eth_sendRawTransaction` to `sequencer.mainnet.chain.robinhood.com`, ~8ms hop saved, IP-pinned); the Arbitrum Nitro broadcast-feed tape (`wss://feed.mainnet.chain.robinhood.com/feed`, header `Arbitrum-Feed-Client-Version: 2`) for sub-second pre-RPC fills; a global wallet-tx serializer (`txlock`) to stop nonce collisions on multi-tx open/close; 350ms receipt polling.
   - Belongs in: Memeland's RH chain adapter + execution path, behind existing approval/risk gates.
   - Cost: small, focused TS modules; reuses Memeland's RPC failover and key pool.
   - Dependency: reduces GMGN/RPC latency for RH fills and execution; adds RH-native endpoints.
   - Measure: fill confirmation latency and execution nonce-collision rate before/after.

9. **Quoter honeypot -> security/rug voter (RH + EVM)** (`SRC-180`).
   - Copy: buy 0.01 ETH then sell back via `quoteExactInputSingle` to prove real liquidity/sellability on chain 4663 - the only reliable solver where block explorers lag; plus a rising-vs-prev volume-spike detector and stablecoin filter.
   - Belongs in: existing rug/honeypot scoring + security voter; fail-closed.
   - Cost: small; one `eth_call`/quoter per candidate.
   - Measure: false-positive rug flags dropped while true honeypots still caught.

### Study (yellow - keep the idea)

8. Backtesting + hyperopt patterns from Freqtrade (`SRC-098`); connector/controller abstraction from Hummingbot (`SRC-113`); bull/bear + risk-debate pattern from TradingAgents (`SRC-207`); Director-to-Quant-to-Risk-to-Execution separation from AutoHedge (division only, not autonomous exec) (`SRC-208`); honeypot.is as an optional EVM witness (`SRC-128`); RH-chain network config from the token toolkit (`SRC-205`); the two awesome-directories as discovery indexes (`SRC-062`, `SRC-136`).

### Skip (red - no integration effort)

9. Full Freqtrade/Hummingbot deployments; `redactedmeme/swarm`; autonomous hedge-fund frameworks; GmGnAPI unofficial SRP client (`SRC-073`); browser-GMGN scraper (`SRC-170`) and wallet-convergence extension (`SRC-038` extension); MCP wrappers that only proxy Solsniffer/honeypot (`SRC-131`, `SRC-128` wrapper); cloudflare/Durable-Object deploy from `fomopulse`; Solana-only MEV bots into RH (`SRC-156`); full Smart-Money-Tracker platform / thin whale-tracker stub (`SRC-118`).

---

## 5. Adopt / Adapt / Study / Skip Matrix (262 deep-reviewed)

| ID | Source | Verdict | One-line rationale |
|----|--------|---------|--------------------|
| SRC-070 | chainstacklabs/fomo-solana-rh-listeners | Study + Adapt | RH RPC listener/wallet-resolution architecture reusable; reference-grade quality |
| SRC-076 | cvxv666/fomo-robinhood-radar | **Adapt** | Wallet resolution + receipt-verified fills + free RH sellability = GMGN independence |
| SRC-117 | itsnex1s/fomopulse-robinhood-chain-tape | **Adapt** | Keyless RH fill tape; parse/receipt/cursor/lag patterns |
| SRC-100 | GMGNAI/gmgn-skills | **Adopt** | Deterministic wallet/dev/copy scoring heuristics (chain-agnostic) |
| SRC-101 | GMGNAI/skillmarket-demos | **Adopt** | Candidate-only + LLM-explainer pipeline; rules-based escape monitor |
| SRC-073 | ChipaDevTeam/GmGnAPI | Skip | Unofficial SRP/captcha client; redundant with official OpenAPI |
| SRC-056 | ArgosSystems/Smart-Money-Tracker | Adapt/Study/Skip | Scanner + accumulation + priority scoring; platform too heavy to port wholesale |
| SRC-118 | jamsturg/crypto-whale-tracker | Skip | Incomplete 2-file stub |
| SRC-038 | 0xuezhang985/wallet-convergence-alert | Adapt concept | Convergence signal from own data; extension itself is DOM-fragile |
| SRC-080 | degenfrends/solana-rugchecker | Adapt concept | Holder/LP/mint heuristics; crude scoring, port ideas |
| SRC-128 | kukapay/honeypot-detector-mcp | Study | honeypot.is as secondary EVM witness; skip MCP wrapper |
| SRC-131 | kukapay/rug-check-mcp | Skip | Wrapper for Solsniffer; redundant, key dependency |
| SRC-207 | TauricResearch/TradingAgents | Study | Debate/validation pattern; too LLM-heavy for live low-latency path |
| SRC-208 | The-Swarm-Corporation/AutoHedge | Study division | Director/Quant/Risk/Exec split; skip autonomous execution |
| SRC-188 | redactedmeme/swarm | Skip | Over-engineered token-PR swarm; no edge |
| SRC-205 | Stormeye85/robinhood-token-sniper | Study config | RH RPC/explorer config reference; skip token deployer |
| SRC-156 | mortdeus/solana-copy-sniper-mev-trading-bot | Study techniques | Solana MEV execution; unsafe to copy wholesale |
| SRC-108 | harutocodes/pumpfun-copytrade | **Adapt** | Copy sizing + paper broker + RPC pool for Solana feed |
| SRC-098 | freqtrade/freqtrade | Study | Backtest/hyperopt/risk patterns; skip CEX Python platform |
| SRC-113 | hummingbot/hummingbot | Study | Connector/controller abstraction; skip heavy HFT platform |
| SRC-157 | muratmula/ai-robinhood-chain | Study baseline | Sibling build of Memeland's own architecture; no new edge |
| SRC-170 | nirholas/scrape-smart-wallets | Study patterns | Retry/overlap/result-envelope ideas; skip scraper as production |
| SRC-062 | BlockRunAI/awesome-finance-mcp | Study index | Discovery map; not an integration dependency |
| SRC-136 | LLMQuant/awesome-trading-agents | Study index | Research index only |
| SRC-169 | nirholas/robinhood-chain-mcp | **Adapt** + Study | Kill-switch env, eligibility gate, pre-sign spend caps, confirm gate |
| SRC-180 | pamgarcia1993/robinhood-lp-bot | **Adopt** + Adapt | Fast-submit sequencer, Nitro feed tape, Quoter honeypot, txlock serializer |
| SRC-199 | sirenconemd/robinhood-trading-toolkit | Skip | Closed Windows app, no code shipped |
| SRC-212 | Thorsten02041973/robinhood-cli | Study/Adapt | Confirms RH constants + router-guard; skip plaintext-key sniper |

### Batch 10/11 additions (46 sources; full evidence in source-notes.md Batches 10 & 11)

**Adopt (port now)**
- **SRC-143 web3-signals-mcp** - highest-value find. IC-weight learning + Platt-scaled probability calibration + regime/abstain gating + walk-forward validation. Port the *methodology* (lightweight TS) to Memeland's scoring dimensions; skip the heavy Python/ML/Postgres/x402 stack.
- **SRC-187 pumpdotfun-sdk** - vend the bonding-curve math, AMM simulator, slippage, and event-parsing into the Solana engine (pure, no external-data coupling).
- **SRC-200 pons-sniper** - curve quote math, `snipeTax` decay timing, verify-before-fire, event-read fill executor, nonce manager, gas caching - directly portable to RH chain 4663, zero GMGN, green-label execution core.
- **SRC-154 tradingcodex** - execution-governance concepts: idempotent order reservation, payload-hash-locked single-consumption approval receipts, append-only audit, deny-first RBAC. Port ~4 TS service functions, skip the Django runtime.
- **SRC-213 OrderBooks** - slippage/impact fill-simulation pattern -> DEX pool-depth impact calc in TS.

**Adapt (green with porting/hardening)**
- **SRC-052 alpaca-mcp-server** - trust-boundary envelope, per-tool output-risk registry, timeout-idempotent order submission, toolset allowlist (small TS middleware for LLM surfaces + executor).
- **SRC-084 solana-mcp** - portable risk rubric (mint/freeze authority, LP burn/lock, concentration, age, mcap) + bundle detection; Solana plumbing skipped.
- **SRC-040 bsc-fourmeme-bot** - slippage/fee-on-transfer sell helpers + dry-run; skip the volume-wash/naive-copy layers.
- **SRC-051 memeoy** - paper fill simulator, bounded self-tuning tuner, fail-closed filter chain, momentum/revival evaluators, wallet-reputation-from-snapshots.
- **SRC-061 gmgn-terminal-bot** - leader-bag sell-fraction tracking, watermark/dedupe poll, source/executor interface split; skip GMGN-unofficial coupling + plaintext key-at-rest.
- **SRC-071 pumpfun-bonkfun-bot** - RPC deadline + null-result fill handling, `failure_reason`, token-bucket limiter, dynamic priority/fee median for the Solana executor.
- **SRC-072 gmgn-wallet-holdings** - batch-RPC `balanceOf`/`%`, RH-4663 chain/alias config, cache/in-flight dedupe as a local holdings watcher.
- **SRC-081 memecoin-agent** - deterministic weighted scoring, smart-wallet participation, holder concentration.
- **SRC-086 memenet** - fail-closed `classifySignal`/`antiSpam`, multi-source `allSettled` fusion, TTL cache for free DexScreener/CoinGecko, `costControl`.
- **SRC-087 memecoin-prototype** - subgraph swap->OHLCV local candle-builder (deterministic on-chain data primitive).
- **SRC-147 4Meme-Pilot** - bonding-curve stages, `rug_risk` composite, slippage-protected buy/sell + on-chain estimates for BSC 4.meme; **flag:** hardcoded `AGENT_API_SECRET` - keep keys local-only.
- **SRC-189 meme-coin-trading-bot** - state-free RugChecker, daily-loss halt/cooldowns/burned-token blacklist, fail-closed rule-matcher schema, staged TP/SL, paper round-trip liquidity guard.
- **SRC-222 dexscraper** - keyless multi-chain DexScreener feed via WS/REST + filter/rank param encoding; drop binary-parse heuristic + cloudscraper bypass.
- **SRC-223/224/225 Vybe APIs** - realized-PnL-ranked trader-following, holder/trader concentration, related-wallet/bundle discovery - reimplement on public RPC, not the paid Solana vendor.
- **SRC-058 tradingview-mcp** - walk-forward train/test + overfitting-verdict concept into the quant/learning gate (TS port); zero-dep indicator/backtest reference.
- **SRC-104 FinanceMCP** - router pattern + TA indicators + HTTP hardening.
- **SRC-137 data-mcp** - error-contract + api-provider patterns + testing rigor.

**Study (yellow - keep the idea)**
- **SRC-162 meme-radar** risk-filter/wallet-classification/request-budget scoring architecture (not its GMGN data layer).
- **SRC-204 crypto-pump-scanner** multi-layer confirmation + circuit-breaker as generic momentum patterns (CEX-only, skip direct).
- **SRC-210 memecoins-trading-agent** WS balance-delta buy-detection + N-wallet convergence framing (incomplete skeleton).
- **SRC-109 Vibe-Trading** fail-closed figure-grounding gate + backtest annualisation/metrics policy reference.
- **SRC-232 gmgn-TrendingAnalyzer** cross-timeframe consistency-count + median-mc quality-filter idea (rebuild over own data, not GMGN scrape).
- **SRC-215 solana-mcp** weighted opportunity-score + safety-rubric template.

**Skip (red - no integration effort)**
- **SRC-078** solana-meme-tool (README-only, verified 6.8KB tarball); **SRC-130/132** kukapay pumpfun/whale MCPs (thin proxies over opaque Dune/Whale-Alert SQL); **SRC-201** soladdev solana-meme-tool (`NEXT_PUBLIC_*` secrets, redacted shell, wash-trading); **SRC-049** FinRobot (heavy AutoGen equities research); **SRC-226** DexScreener-Trending (traffic bot for rank manipulation - also a research note: do not weight trending ranks heavily).
- MCP-data Skips: SRC-043/045/059/079/094/125/126/127/129 (vendor proxies, equity-domain, or insecure signing surfaces). SRC-129 jupiter-mcp kept only for its order/execute split idea, with SRC-052-style safety.

---

### Batch 12/13 additions (50 sources; full evidence in source-notes.md Batches 12 & 13)

**Adopt (port now)**
- **SRC-236 quant-scripts (e.g. QuantDinger tech-set)** - anti-overfit toolchain: deflated Sharpe, purged/embargoed cross-validation, leakage detector, latched kill-switch, trade-cost analysis (TCA). Port these as a TS learning/backtest harness around Memeland's existing scorecard.
- **SRC-190 COPUMP** - the only clean dependency-free full Adopt: layered risk gates + multi-constraint sizing (zero-dep, chain-agnostic, test-covered). Copy the architecture style, not a runtime.

**Adapt (green with porting/hardening)**
- **SRC-227/230 solana-trading-bot (Raydium lineage)** - executor-interface DI, veto-with-reason pool filters, fail-closed TP/SL timeout loop.
- **SRC-173 OKX agent-trade-kit** - read-only/demo gates, capability snapshot, remediation-write veto; an MCP safety-stack reference.
- **SRC-124 event-sourced paper journal** - replay-anchored honest scorecard + MCP registry; feed state-machine events into the post-mortem ledger.
- **SRC-175 multi-voter + veto architecture** - mirrors Memeland's fusion model.
- **SRC-102/103 skillmarket aitrader+memex** - adaptive agent pipeline (already Adopt-listed); confirm aitrader scoring + memex discovery.
- **SRC-166/167/168 memescope + pump-fun SDK/workers** - missing-data-never-clean + explained weighted scores; RPC failover/backoff and closed read-only tool registries.
- **SRC-144/146 world-intel-mcp / mcp_massive** - closed read-only tool/MCP registry pattern.
- **SRC-183 cryo** - Study/Adapt the archival RPC block-fetch primitive for replay-based fill/ledger ground truth.

**Study (yellow - keep the idea)**
- **SRC-085 BCa CI/jackknife** and **SRC-182 island/elite-archive search** (quant validation), **SRC-149 Dank unit/dedupe engine**, **SRC-088 hyperindex** + **SRC-206 squid-sdk** capability-interface per-chain adapter pattern, **SRC-148 messari** + **SRC-111 holaplex** (provider formats), **SRC-046 aave** / **SRC-172 okx** / **SRC-181 Agent-Reach** / **SRC-192 finance-skills** / **SRC-217 tradermonty** (selected MCP data shapes, **Adapt/Skip** - only the portable client shells), **SRC-066 awesome-memecoin-trading** (curation index).

**Skip (red - no integration effort)**
- **SRC-220 uxuycom** - **plaintext MySQL creds** (`root:1234qwer@...` at rest) - security fail, do not use.
- **SRC-229 AnoMeme** (mock-only demo), **SRC-178 openpumpio** (closed hosted API), **SRC-174 onchainos-skills** (heavy/speculative).
- **Heavy platforms** SRC-083 OctoBot, SRC-161 Nautilus, SRC-099 LangAlpha; CEX-bound execution layers (freqtrade family already listed).
- **Near-dupes counted once:** SRC-065 = SRC-177 (QuantDinger mirror); SRC-227 = SRC-230 (solana-trading-bot v3 lineage, count once); SRC-053 vs SRC-171 (alpha-arena, distinct projects - both noted).

**Cross-cutting themes from Batches 12/13:** no external source provides RH-4663 coverage - every adopted data-side value is a portable TS/Python pattern, not a chain-native data source. Recurring winners: RPC failover/backoff (063/167/168), capability-interface per-chain adapters (218/088/206), closed read-only MCP/tool registries (146/168), fail-closed risk gates + incident tables (190/217/035/102), missing-data-never-clean + explained weighted scores (166/102/190), and anti-overfitting validation (236/085/182/149).

### Batch 14/15 additions (15 sources; full evidence in source-notes.md Batches 14 & 15)

**Adapt (green with porting/hardening)**
- **SRC-195 solana-copy-trading (Rust)** - sim-mode-first design, confirm-pair slippage (diff-price) telemetry; port the fill-tape/mirror sizing logic.
- **SRC-116 pump-copy-trading (TS)** - copy sizing + mirrored-sell at >=0.95 (sell-all), SIMULATION_MODE flag; but **HIGH security flag: live paid Helius key + Jupiter key committed in plaintext** - pattern only, never the keys.
- **SRC-141 LW-ARTS/trenchkit (TS GMGN scanner)** - hard-gate -> research -> weighted-conviction pipeline, NaN handling, distinct-wallet convergence detector; adopt the scoring arch, **Skip the GMGN dependency**.
- **SRC-165 nirholas/kol-quest** - fetchJSON retry/429-backoff wrapper, idempotent poll+ingest, multi-source dedup-merge, PnL/winrate model.
- **SRC-160 cryptoelecthon (TrenchTools monorepo)** - shield scoring + statistical manipulation/cluster detector + FIFO PnL; port the pure-logic slice.
- **SRC-064 cryptofeed (Python)** - closed-candle-only timing, watchdog + exponential-backoff reconnect, raw-message observer tap, 429 stagger, normalized-schema taxonomy; **Skip** the CEX framework.
- **SRC-068 ccxt (TS)** - port the `Precise` `bigint` decimal-math class + leaky-bucket Throttler as small primitives; **Skip** the CEX-only library (no DEX/RH-4663).

**Study (yellow - keep the idea)**
- **SRC-074 crownobyl/trenchkit** + **SRC-145 KOLscan** - wallet-quality/leaderboard metric formulas as RH 4663 analytics queries (trait filters, insider/consistency/quick-sell ratios, leaderboard field model); scrapers themselves **Skip**.
- **SRC-176 OpenBB** - provider-extension-behind-unified-facade + one-core-many-surfaces architecture as design reference (lighter equivalents exist in SRC-218/159); **Skip** the AGPL equities-centric platform.
- **SRC-036 tx-parser** and **SRC-050 onchain-trading-bot** and **SRC-112 lookahead-free** and **SRC-159 nansen-cli** - selected decode/client patterns.

**Skip (red - no integration effort)**
- **SRC-214 CryptoTradingAgents** - LLM-heavy LangGraph debate research, no live execution, too slow for Memeland's low-latency path (consistent with SRC-207 verdict).
- **Plaintext/paid-key commits:** SRC-116 (Helius + Jupiter live keys in-repo) - never use those creds.

**Cross-cutting themes from Batches 14/15:** the three trench/toolkit members (SRC-074/141/160) are distinct projects, not dupes - SRC-116 and SRC-195 are two genuinely different copy bots. No external source covers RH-4663; wins are again portable non-GMGN TS/Python patterns: retry/429/backoff discipline (064/068/165), exact-decimal math (068), copy-sizing mirrored-exit logic (116/195), weighted-conviction scanners (141/165), and explainable wallet-quality/leaderboard metrics (074/145/160). The one repeated **security guardrail: never copy committed API keys** (SRC-116).

### Batch 16/17 additions (18 sources; full evidence in source-notes.md Batches 16 & 17 - external web deep-reads)

**Adopt (documented API contracts / patterns for Memeland's primary source)**
- **SRC-001 GMGN Agent API** - official agent-skills contract: keyed `gmgn-market`/`token`/`portfolio` (read) vs `gmgn-swap` (+`GMGN_PRIVATE_KEY`, signed) boundary; `--raw` single-line JSON; SOL/BSC-BNB/Base/ETH only, IPv4-only. Codify this exact contract in Memeland's GMGN adapter.
- **SRC-002 GMGN Callout OpenAPI** - official partner callout/webhook contract; adopt the schema for Memeland's signal callouts.
- **SRC-028 Mobula GMGN APIs guide** - public multi-chain alternative to GMGN (GMGN-independence candidate); capture its request/response shape.

**Adapt (pattern, with porting/chain work)**
- **SRC-003 AI Trader (GMGN skill-market)** - adapt the candidate-only + LLM-explainer pipeline (consistent with already-Adopted SRC-101).
- **SRC-033 Meme Sentinels** + **SRC-237 GMGN RH-chain blog** - adapt the RH-chain meme detection/eligibility signals described.
- **SRC-026 Dune MCP / SRC-246 Bitquery MCP** - adapt the **closed read-only discovery/analysis registry** pattern (tool names `chain_capabilities`/`token_ohlcv`/`trending_tokens`/`profitable_traders_by_token`, `searchTablesByContractAddress`) into Memeland's RH-4663 read-tools MCP surface; normalize to `{chainId,address,timestamp,metric,value,source}`, reject missing chain support.
- **SRC-249 orderflow.art** - adapt the order-flow/tape visualization idea as a data shape, not a dependency.

**Study (yellow - keep the idea)**
- **SRC-004 MemeX (GMGN skill-market demo)** - scoring/UX ideas, not code.
- **SRC-257 CoinGecko meme category** + **SRC-032 DegenAgent** - category index / showcase heuristics.
- **SRC-008 anchor-lang / SRC-253 solana.com / SRC-254 solanatracker** - Solana program/ecosystem/API references (Study for Solana feed; not RH-4663).

**Skip (red - no integration effort)**
- **SRC-015 CoinMarketCap meme view** - paid-gated, redundant with GMGN/CoinGecko.
- **SRC-248 OpenPump (MCP Market listing)** - hosted Solana-only paid API, custody delegated (consistent with prior SRC-178 verdict).

**Cross-cutting themes from Batches 16/17:** official GMGN docs confirm Memeland's primary source is **SOL/BSC-Base/ETH only - no RH 4663**; the RH-chain GMGN guide (SRC-237) is the one direct RH reference. None of the hosted MCP/analytics vendors (Dune/Bitquery/crypto.com) document RH-4663 either, so every MCP/data win is again a **portable read-only-registry/normalized-schema pattern**, not a chain-native source. GMGN-independence options (Mobula SRC-028, Bitquery) now have concrete documented shapes. Security: never put API keys in committed URLs/query strings (Dune OAuth vs `?api_key=` warning); keep OAuth/refresh state and hosted-vendor billing out of the live trading path.

---

## 6. End-to-End Feasibility

Seen as one pipeline - discovery -> flow -> security -> consensus -> execution -> risk -> learning - the external ecosystem's best ideas slot into Memeland without new orchestration layers:

- **Discovery:** GMGN ranking is primary; RH-native RPC fill tape adds an independent RH discovery/confirmation feed (goals 1 and 7). `aitrader`'s cheap-to-narrow shape avoids LLM cost in the wide phase.
- **Flow vs bots:** GMGN bot-detection metrics + wallet convergence + accumulation detector feed the security/whale voters (goals 2 and 3). Bot-risk signals deterministic and testable; FARSIGHT hardening of `RiskManagerV2` stays.
- **Security:** rug-score heuristics broaden coverage cheaply. honeypot.is is an optional EVM witness; all security additions fail closed.
- **Consensus:** the seven voters remain; the external value is more/better signal inputs, not more voter agents.
- **Execution:** Solana copy-trade mechanics port cleanly into the existing gated executor; paper-broker dry-run preserves fail-closed.
- **Risk:** MarketSentinel/kill-switch stays decoupled and independent of signal optimism.
- **Learning:** verified-outcome rule stays; wallet scoring feeds the "did copy-tradeability prediction match reality" loop without double counting.

Everything green is a **module-level port**, not a platform adoption - important because the bot is a practical personal deployment with memory/CPU/network/maintenance limits.

---

## 7. GMGN Dependence Analysis

Current state: GMGN supplies rankings, trenches, metadata, smart-money/KOL flows, and security fields. It has explicit pacing/caching/rotation/rate-limit behavior that Memeland must preserve through the shared adapter.

- **GMGN is strategically valuable but a single point of failure** for flow and discovery. The RH-native RPC tape (SRC-076/117/070) is the single highest-value independence lever for the home chain: free, keyless, read-only capable. Fill ownership must be receipt-verified and wallet resolution inference-based (the fomo radar algorithm), well within Memeland's reach.
- **Keep the official GMGN OpenAPI** (key + timestamp + client_id for reads; Ed25519/RSA-SHA256 signed routes, +/-5s timestamp, replay-protected by client_id) for anything signed. Do not switch to the unofficial SRP/captcha client (SRC-073).
- **Signed order routes require the private key**; Memeland must keep these strictly behind its existing approval/risk gates. GMGN's own topology confirms independent wallet scoring (copy-tradeability backtest) reduces the need to over-trust raw flow.
- **Recommendation:** introduce a shared chain-flow adapter that can read fills from public RPC as an independent RH confirmation while GMGN remains the primary ranking source; this gives a real, testable outage path without replacing GMGN.

---

## 8. Service-Placement Recommendations

Pure port targets that move *signal* into existing agents/services rather than new ones:

- **Wallet scoring / copy-tradeability backtest** -> shared wallet/copy-scoring service; consumed by the whale and copy-trade timing.
- **RH fill tape + wallet resolution** -> shared RH chain data adapter (near market-data adapters; confirms GMGN flow).
- **Accumulation detector, convergence signal, priority scoring** -> shared flow/whale aggregation; feeds whale + security voters.
- **Rug-score cross-chain heuristics** -> existing rug/security voter (before consensus), fail closed.
- **Solana copy sizing + paper broker** -> Solana execution path, behind approval/risk gates.
- **Escape/rug monitor** -> operates outside the trading loop (parallel to `MarketSentinel`); pure rules, never gated by LLM.

These follow Memeland's placement constraints: data ownership/latency/lifecycle become clearer by giving each capability a single normalized owner; no capability is moved merely to make a diagram prettier.

---

## 9. Chain-Portability Assessment

- **RH Chain (home):** highest portability. Everything EVM (`eth_getLogs`, WS, receipt verify, sellability `eth_call`) applies directly and is free/keyless. FOMO ecosystem listeners/resolve/tracking all copy here.
- **Other EVM (BSC/Base/Ethereum):** high portability. GMGN scoring, rug heuristics, wallet scoring, convergence are chain-agnostic. honeypot.is covers ETH/BSC/Base as an optional witness but not RH.
- **Solana:** medium portability, separate plumbing. Wallet-signature scanning (not slot scanning), copy-trade sizing/fill decoding, RPC pool, Jito/WS execution techniques are the relevant pieces. Solana-only libs (rugchecker SPL, pump.fun SDKs) apply only to the Solana feed.
- **Avoid:** treating Solana-special MEV behavior (Jito shred/gRPC) as an RH primitive, and RH RPC logic as a general Solana primitive. Encapsulate per-chain in scanner adapters.

---

## 10. API / RPC / Key / Cost / Latency / Maintenance Requirements

| Capability | Dependency added | Key needed | Typical cost/latency | Operational note |
|-----------|-----------------|-----------|----------------------|------------------|
| RH RPC fill tape | 1 RPC endpoint/chain (HTTPS+optional WSS) | No (public) | ~1s post-landing | Watch public RPC fairness/rate limits; add failover |
| GMGN wallet scoring | none (existing flow data) | No | local | Pure computation; cache normalized inputs |
| GMGN signed routes | GMGN key + client_id | Yes (private key) | - | Keep behind approval gate; +/-5s / replay rules |
| honeypot.is witness | external API | No | cheap | Does NOT cover Robinhood Chain; EVM-only |
| Solana copy-trade | RPC pool per Solana | Optional read key | latency as copied | Use paper broker first; failover pool |
| rug-score enrichment | existing RPC/metadata, GoPlus | - | cheap | Normalize thresholds; fail closed |
| Freqtrade/Hummingbot-style | n/a (Study only) | - | heavy | Do not deploy |

General rule: all new read dependencies are cheap/keyless or fit Memeland's existing key-pool + cache + fail-soft pattern. Nothing here requires new secrets to be persisted outside the existing credential store. Private keys stay isolated for signed/execution paths only.

---

## 11. Security and Fail-Closed Notes

- Port deterministic algorithms, but **restrict to the network/metadata/flow read path** until audited. Copy-trade execution code goes behind the existing approval gate and runs in paper mode first.
- Fill/transfer ownership must always be receipt-verified - do not credit a wallet for a swap delivered by an outside key or dust push (SRC-076).
- Untrusted repo/tool content and LLM output must never directly control execution or config; candidate-only output is required.
- New intel sources fail soft; security and execution sources fail closed. Kill-switch remains decoupled and observable.
- Review copied code for secret handling, subprocess/shell usage, and remote-tool calls before it runs with keys.

---

## 12. Deep-Review vs Triage Transparency and Cleanup

- **Deep-reviewed (262):** evidence in `notes/source-notes.md` (Batches 1-20); verdicts above; status `reviewed` in `source-manifest.json/.csv`. This is now every source in the manifest.
- **Triage-only (0):** the previous 101 triage-classified sources were all deep-read in Batches 18-20 and their statuses are now `reviewed`. No source remains unverified.
- **Clone cleanup:** every deep-review clone (pass 1 and Batches 9-19) was deleted from the temporary clones dir after reading (clones dir is empty). Web sources (Batch 20) were fetched via curl/Invoke-WebRequest and produced no clones. No runtime code was modified; this phase is documentation/research only.

---

## 13. Deep-Review Completion (Previously Triage-Classified Sources)

The 101 sources carried forward from earlier waves as triage-only were all deep-read in Batches 18-20. Categories below are ordered by strategic proximity to Memeland and now reflect completed coverage.

**Post-Batch-20 status:** robinhood (4/4), agents (7/7), trading-risk-research (21/21), mcp-data-tools (31/31), meme-smart-money (65/65), chain-execution (11/11), chain-data-infra (18/18), market-data (25/25), and general (78/78) are now **fully deep-reviewed**. SRC-261 (tsukiema1/FLYWHEEL) and SRC-262 (zostaff/grok-trading-desk) were added to the manifest during this wave and reviewed. Verdict details for every source are in the matrix and Batches 10-20 highlights.

### robinhood (4) - P0, all deep-reviewed (Batch 9)
SRC-169 nirholas/robinhood-chain-mcp -> **Adapt** execution-guard model + Study keyless data reads. SRC-180 pamgarcia1993/robinhood-lp-bot -> **Adopt** as RH execution reference (fast-submit sequencer, Nitro broadcast-feed tape, Quoter honeypot, txlock serializer). SRC-212 Thorsten02041973/robinhood-cli -> Study/Adapt (pins RH router/WETH/USDG constants + router-guard/RPC-health patterns; skip plaintext-key sniper). SRC-199 sirenconemd/robinhood-trading-toolkit -> Skip (closed app, no code).

### meme-smart-money (65/65 reviewed - complete)
Batch 14 deep-read the trench trio (SRC-074/141/160) and SRC-145/165/195; Batch 16 deep-read the official GMGN agent API/callout docs (SRC-001/002/003/004/028/237) plus CMC/CoinGecko indexes (SRC-015/257), OpenPump MCP listing (SRC-248), and ETHGlobal showcases (SRC-032/033). Verdicts in the matrix. SRC-134/135 (trenchkit dupes) are closed against SRC-136 (reviewed).

### mcp-data-tools (31/31 reviewed - complete)
Batch 17 deep-read the P0 hosted MCPs (SRC-026 Dune, SRC-246 Bitquery, SRC-247 crypto.com). Reusable value is the closed read-only discovery/analysis registry pattern Memeland can replicate for RH 4663; none of these provide RH-4663 coverage natively. Most other kukapay/autonsol/dbotx/solana wrappers were **Skip** (non-redundant keyless data only).

### trading-risk-research (21/21 reviewed - complete)
Include FinRobot, QuantGPT, nautilus_trader, pybroker, fastquant, OctoBot, ai-quant-researcher, alpha-arena variants, plus orderflow.art (Batch 17). Mostly **Study** (backtest/quant patterns); full platforms **Skip**. LLM-quant projects **Study** for learning-feed ideas only.

### chain-data-infra (18/18 reviewed - complete)
Alchemy/QuickNode/Goldsky/Helius/Bitquery providers, Blockscout, SubSquid, Messari subgraphs, TheGraph, cryo, indexers. Use as **provider options**, not code to copy. Relevant where they add keyless RH/Solana coverage; otherwise Study.

### chain-execution (11/11 reviewed - complete)
Solana-focused (Jito-ts, SolanaTracker, warp-id, vybe APIs, top-holder/trader/PnL APIs; Batch 17 added anchor-lang framework, solana.com ecosystem, solanatracker). vybe/solana-tracker trade-PnL APIs are **Study** (PnL scoring input for Solana). Jito/max-speed MEV **Skip** as executable copy.

### market-data (25/25 reviewed - complete)
DexScreener, GeckoTerminal, Birdeye, DeBank, CoinPaprika, Santiment, etc. Mostly complementary feeds; **Study** where they overlap GMGN without cost, **Skip** the redundant ones. SRC-222 dexscraper and portfolio scrapers trend Study (data pipeline) / Skip (scrape fragility).

### agents (7/7 reviewed - complete)
FinRobot, LangAlpha, Vibe-Trading, trade-agent, ai-trading-agent-gemini, CryptoTradingAgents. Overwhelmingly LLM-orchestration research; **Study** patterns only, do not replace Memeland's lean 7-voter swarm.

### general (78/78 reviewed - complete)
Long tail of LLM trading bots, personal quant notebooks, single-strategy experiments, and dashboards. Default **Skip** unless a specific algorithm maps onto a Memeland edge (backtest, garch, crypto indicators). Batch 15 deep-read the highest-value general candidates: SRC-214 CryptoTradingAgents (Skip - LLM-heavy), SRC-036 tx-parser, SRC-050 onchain-trading-bot, SRC-064 cryptofeed (Adapt patterns), SRC-068 ccxt (Adapt `Precise`/Throttler), SRC-159 nansen-cli, SRC-112 lookahead-free, SRC-176 OpenBB (Study arch / Skip platform). Batches 18/19 (Rawls/Einstein) then deep-read the full remaining general long tail (incl. SRC-261 FLYWHEEL -> Adopt propose-vs-decide risk; SRC-262 grok-trading-desk -> Adopt fail-closed vetoes; SRC-150 garchmethod -> Adapt walk-forward GARCH sizing; SRC-139 lumibot -> Study fill model). Most were Skip/Study; a few concrete algorithms map to edges as noted.

### Deep-read backlog cleared (all sources now reviewed)
The former next-pass backlog is now fully cleared (Batches 18-20). Final verification details for every source are in the prioritized Adopt/Adapt items above (Batch 18/19 GitHub bots and Batch 20 external vendor/API docs, incl. Alchemy, QuickNode, Goldsky, Helius, Bitquery, liquidity.vision, GMGN official docs, CMC/CoinGecko, and the market-data/chain-data-infra web sources), all with verdicts in the matrix and `notes/source-notes.md` Batches 18-20.

---

## 14. Final Recommendations

1. **Port GMGN wallet scoring + `aitrader` pipeline shape** into the copy/whale scoring and opportunity-discovery flow (Adopt). This is the fastest green-label lever.
2. **Build an RH-native RPC fill tape + wallet resolution** in the shared chain adapter as an independent GMGN confirmation path (Adapt). Highest strategic independence value.
3. **Fold accumulation + convergence + rug-score heuristics** into existing voters/services (Adapt), all deterministic and fail-closed.
4. **Port Solana copy-trade sizing + paper broker** behind the existing gates (Adapt).
5. **Adopt the scoring-calibration methodology from SRC-143** (IC-weight learning + Platt calibration + regime/abstain gating + walk-forward validation) as the core learning edge for Memeland's voters; **Adopt execution-governance from SRC-154** (idempotent reservation, hash-locked approval receipts, deny-first RBAC) and **fill-simulation from SRC-213**.
6. **Adopt the RH/Solana execution core from SRC-200 + SRC-187 + SRC-072** (curve quote/timing math, verify-before-fire fills, nonce manager, chain-4663 alias + batch balance reads) and **SRC-180** (fast-submit sequencer, Nitro feed tape, Quoter honeypot, txlock) behind the existing approval/risk gates.
7. **Adapt the portable risk rubric from SRC-084 and the keyless multi-chain DexScreener feed from SRC-222** into security voters + shared market-data adapters, reusing SRC-052's trust-boundary/allowlist pattern for any LLM surface.
8. **Do not adopt** full platforms, agent swarms, scrapers, unofficial clients, or traffic/rank-manipulation bots (SRC-226 - and do not weight DexScreener/Dextools trending ranks heavily).
9. **Adopt the anti-overfit learning harness first** (SRC-236 deflated Sharpe/purged CV/leakage detector/latched kill-switch/TCA as a TS port) so new callers can be validated honestly; layer SRC-190's zero-dep layered-risk-gate + multi-constraint sizing behind the existing risk service. Keep SRC-227/230 executor-DI + veto-with-reason filters and SRC-173/124 safety-registry/journal patterns for the RH/Solana execution and post-mortem feeds.
10. **Deep-read of all 262 sources is complete** (Batches 18-20 cleared the remaining 101 triage-only entries; SRC-261/262 added and reviewed). No source remains unverified, so the next step is implementation: port the Adopt/Adapt items listed above behind existing tests, then confirm the suite stays green. Commit + push of the research docs is offered with this handoff.

No testing was required this phase (documentation/research only). The next verification step is to implement Adopt/Adapt items behind existing tests and confirm the suite stays green.


---

## Appendix A. Full Source Read List (262 sources)

All sources reviewed with verdicts in `notes/source-notes.md` (Batches 1-20). Verdict extracted from the per-source evidence.

### meme-smart-money (65)
- SRC-001 | docs.gmgn.ai/index/gmgn-agent-api | P0 | Adopt
- SRC-002 | docs.gmgn.ai/index/gmgn-callout-openapi | P0 | Adopt
- SRC-003 | gmgnai.github.io/skillmarket-demos/aitrader | P0 | Adapt
- SRC-004 | gmgnai.github.io/skillmarket-demos/memex | P0 | Study
- SRC-015 | https://coinmarketcap.com/view/memes | P0 | Skip
- SRC-028 | https://docs.mobula.io/guides/gmgn-apis | P0 | Adapt
- SRC-032 | https://ethglobal.com/showcase/degenagent-zqmdu | P1 | Study
- SRC-033 | https://ethglobal.com/showcase/meme-sentinels-12xqg | P0 | Adapt
- SRC-035 | https://github.com/0xBennie/binance-smart-money-oi-monitor | P0 | Adapt (the rate-limit circuit-breaker, weight-budget headroom, batched serial+spacing+jitter sweep, per-symbol hard-timeout, streaming persist, and notional/velocity math — all light, portable, non-GMGN, adoptable in TS for Memeland's RPC/API layer and meme metrics); Skip as a data dependency (Binance-futures-only, undocumented web API, no RH 4663/memecoin coverage).
- SRC-038 | https://github.com/0xuezhang985/wallet-convergence-alert | P0 | n/a
- SRC-040 | https://github.com/1009682175845693/bsc-fourmeme-bot | P0 | Adapt (execution/slippage + fee-on-transfer sell helpers, dry-run pattern for RH/BSC executor) + Skip (volume wash bot, naive copy-trader, incomplete bundler).
- SRC-051 | https://github.com/alexskin/memeoy | P0 | Adapt (paper fill simulator, bounded self-tuning tuner, fail-closed filter chain, momentum/revival evaluators, wallet-reputation-from-snapshots; each into existing shared services/voters) + Study (LLM degen-score vibe check as advisory sentiment input) + Skip (Next.js dashboard + Turso public-mirror + whole-platform wholesale - heavy for personal use).
- SRC-056 | https://github.com/ArgosSystems/Smart-Money-Tracker | P0 | n/a
- SRC-061 | https://github.com/BikeTysonDegen/gmgn-terminal-bot | P0 | Adapt (leader-bag sell-fraction tracking, watermark/dedupe poll loop, source/executor interface split, offline-replay test pattern) + Skip (GMGN-unofficial coupling, Cloudflare fragility, plaintext key-at-rest, WPF app, whole-platform).
- SRC-066 | https://github.com/buddies2705/awesome-memecoin-trading | P0 | Study (as a discovery/reference list for Memeland's tooling gap analysis, mainly to confirm category landscape and pitfalls — e.g. which providers are Solana-only vs EVM-portable); Skip as anything adoptable (no code, sponsor-biased, no RH 4663 edge).
- SRC-070 | https://github.com/chainstacklabs/fomo-solana-rh-listeners | P0 | n/a
- SRC-071 | https://github.com/chainstacklabs/pumpfun-bonkfun-bot | P0 | Adapt (RPC deadline + null-result fill handling, `TradeResult.failure_reason`, token-bucket limiter, dynamic priority/fee median for the Solana executor) + Study (extreme-fast zero-RPC event-driven buy as a Solana-feed concept; platform/listener abstraction shape) + Skip (wholesale - Python, heavy, Solana-only, not-for-production).
- SRC-072 | https://github.com/chasepal/gmgn-wallet-holdings | P0 | Adapt (port `lib/holdings.js` batch-RPC + `lib/chains.js` chain/alias config + cache/in-flight dedupe as a local holdings watcher; add hold-duration/positioning on top) + Skip (extension UI, FOMO session bridge wholesale).
- SRC-073 | https://github.com/ChipaDevTeam/GmGnAPI | P0 | n/a
- SRC-074 | https://github.com/crownobyl/trenchkit | P1 | Study (port the metric formulas as RH 4663 analytics queries; not code to integrate at runtime).
- SRC-076 | https://github.com/cvxv666/fomo-robinhood-radar | P0 | n/a
- SRC-078 | https://github.com/dartkomnitibe/solana-meme-tool | P0 | Skip — repo publishes no source code, only a sales README; nothing to deep-read or port.
- SRC-080 | https://github.com/degenfrends/solana-rugchecker | P0 | n/a
- SRC-081 | https://github.com/Denzz102/memecoin-agent | P0 | Adapt (port the weighted scoring model + smart-wallet-participation + holder-concentration edge; keep AI narrative optional) + Study (whale heuristic is crude — replace with real on-chain whale detection) + Skip (MySQL+Express+dashboard+Telegram stack wholesale).
- SRC-086 | https://github.com/ejfxgit2025/memenet | P0 | Adapt (port the fail-closed `classifySignal`/`scoreSignal`/`antiSpam` signal model + multi-source fusion with `Promise.allSettled` + TTL caching for free DexScreener/CoinGecko + `costControl` guardrail) + Skip (React/Supabase social feed and paid Firecrawl/Twitter news channels wholesale).
- SRC-087 | https://github.com/ennriqe/crypto-agent-memecoin-prototype | P0 | Adapt (port the subgraph swap→OHLCV local candle-builder as a deterministic on-chain data primitive) + Study (LSTM sequence prediction as a research experiment, low-confidence edge) + Skip (CDP AgentKit execution agent + TensorFlow stack wholesale).
- SRC-100 | https://github.com/GMGNAI/gmgn-skills | P0 | n/a
- SRC-101 | https://github.com/GMGNAI/skillmarket-demos | P0 | n/a
- SRC-102 | https://github.com/GMGNAI/skillmarket-demos/tree/main/aitrader | P0 | Adapt (the deterministic-filter→LLM-explain→human-execute pipeline, escape monitor separate from LLM, dev-reputation scoring, per-chain adapter with keyless mock, fixed-fractional sizing + portfolio risk gate, sanitize-before-LLM — all light, portable, and directly cover RH 4663); Skip as a code dependency (Python/FastAPI, GMGN-CLI data lock-in, live trading path unverified on EVM/RH, display-only exit plans). Adoptable as a TS port of the pattern.
- SRC-103 | https://github.com/GMGNAI/skillmarket-demos/tree/main/memex | P0 | Study (the missing-data→`unknown` handling, AI-never-scores doctrine, and weighted-skill-with-capped-catalyst scoring are genuinely reusable scoring-hygiene patterns, portable and non-GMGN in concept); Skip as a dependency (BSC-only single-file GMGN browser demo, no RH 4663, no backend/chain logic to reuse). Adopt the scoring conventions in Memeland's own RH 4663 safety/candidate model.
- SRC-108 | https://github.com/harutocodes/pumpfun-copytrade | P0 | n/a
- SRC-116 | https://github.com/ironclad-protocol/solana-copy-trading-bot | P1 | Adapt (sizing, arbitrage-skip, sim-mode, queue patterns into Memeland TS); Skip the Solana DEX parser layer. Rotate/don't reuse the exposed keys.
- SRC-117 | https://github.com/itsnex1s/fomopulse-robinhood-chain-tape | P0 | n/a
- SRC-118 | https://github.com/jamsturg/crypto-whale-tracker | P0 | n/a
- SRC-130 | https://github.com/kukapay/pumpfun-wallets-mcp | P0 | Skip — thin proxy over opaque Dune SQL, platform-locked to Pump.fun, no self-contained/portable edge. (Pattern note only: expose self-computed analytics via a thin tool layer rather than proxying someone else's.)
- SRC-131 | https://github.com/kukapay/rug-check-mcp | P0 | n/a
- SRC-132 | https://github.com/kukapay/whale-tracker-mcp | P0 | Skip — thin proxy over a whale data source that doesn't cover meme DEX chains; no self-contained or portable edge.
- SRC-141 | https://github.com/LW-ARTS/trenchkit | P1 | Adapt — port the scoring/convergence/riskgate architecture (chain-agnostic, fail-closed) but Skip as a GMGN-coupled dependency run as-is (Memeland wants low GMGN coupling).
- SRC-145 | https://github.com/marksantiago290/KOLscan-leaderboard-scraping | P1 | Study (leaderboard field schema as a data-model idea); Skip the scraper as implemented.
- SRC-147 | https://github.com/MayurK-cmd/4Meme-Pilot | P0 | Adapt (bonding-curve stage framework, rug_risk composite, fail-closed deterministic scoring, slippage-protected buy/sell + on-chain estimates for the BSC 4.meme leg) + Skip (Gemini-LLM loop, Elfa sentiment, full-stack dashboard, and especially the shared-backend wallet-credential model with its leaked hardcoded secret — keep keys local-only).
- SRC-156 | https://github.com/mortdeus/solana-copy-sniper-mev-trading-bot | P0 | n/a
- SRC-160 | https://github.com/natebag/TrenchTools | P1 | Adapt — port the clean logic modules into Memeland TS; Skip as a dependency (too heavy, Solana-locked, paid-API-backed).
- SRC-162 | https://github.com/nhovongoc0-max/meme-radar | P0 | Study (reusable fail-closed risk-filter + wallet-classification + chart-risk + sellability patterns, and the per-chain/request-budget design — port the *scoring architecture*, not the GMGN data layer) + Skip (GMGN-only coupling conflicts with the green-label bar, no trade execution, heavy local-app/dashboard package).
- SRC-165 | https://github.com/nirholas/kol-quest | P1 | Adapt (`fetchJSON` util, idempotent ingest/poll, multi-source merge + leaderboard data model into TS); Skip as a GMGN-coupling dependency and runnable platform.
- SRC-166 | https://github.com/nirholas/memescope-monday-directory | P0 | Adapt (the weighted safety-score-with-explained-deductions model, missing-data-never-clean handling, and keyless DexScreener client pattern — light, portable, non-GMGN, adaptable to TS for Memeland's RH 4663 candidate scoring); Skip as a dependency/app (Next.js full-stack directory with auth+payments, no RH 4663, placeholder fake news, not a trading/execution tool).
- SRC-167 | https://github.com/nirholas/pump-fun-sdk | P0 | Skip as a dependency (Solana/Pump.fun-only, zero RH 4663, huge heavy monorepo — no install; it would drag in Solana/anchor surface Memeland doesn't want); Adapt the `fallback.ts` RPC-failover + `fetchWithFallback` HTTP fallback pattern and the pure-BN price-impact-BPS/quote-math module into Memeland's TS RPC & quoting layers (replaces/plugs alongside the rolling-window backoff from SRC-063).
- SRC-168 | https://github.com/nirholas/pump-fun-workers | P0 | Adapt the pattern (closed read-only MCP tool registry + hand-rolled Streamable HTTP transport + env RPC URL + formatted-output/limit-clamp/timeout helpers — light, portable, non-GMGN, directly retargetable to RH 4663); Skip as a dependency/app (Solana pump.fun-only data, no RH 4663, no execution — it's just a thin public-API client).
- SRC-170 | https://github.com/nirholas/scrape-smart-wallets | P0 | n/a
- SRC-178 | https://github.com/openpumpio | P0 | Skip as a dependency/service (hosted closed Solana pump.fun trading API — single-chain, no RH 4663, custody delegated to a third party, API-key-gated vendor lock; nothing portable or self-hostable); Study the SDK's typed-HTTP-client/typed-error-hierarchy and per-session MCP-factory patterns as a formatting reference only.
- SRC-187 | https://github.com/rckprtr/pumpdotfun-sdk | P0 | Adopt (vend the bonding-curve math, AMM simulator, slippage and event-parsing into Memeland's Solana engine — pure, simple, no external-data coupling) + Adapt (transaction builders + priority-fee sendTx to match Memeland's RPC/relay setup).
- SRC-188 | https://github.com/redactedmeme/swarm | P0 | n/a
- SRC-189 | https://github.com/ricoboost/meme-coin-trading-bot | P0 | Adapt (state-free rug-check helper, deterministic RiskManager with daily-loss halt/cooldowns/burned-token blacklist, fail-closed rule-matcher schema, staged TP/SL exit engine, paper round-trip liquidity guard) + Skip (whole Solana Yellowstone/Helius/Jupiter stack, ML qualifier, Playwright wallet collectors, FastAPI dashboard).
- SRC-190 | https://github.com/rimtoln/COPUMP | P0 | Adopt (the layered risk-gate + `sizeCopy` multi-constraint sizing + declarative incident-classification architecture — pure, zero-dep, test-covered, chain-agnostic, exactly Memeland's fail-closed decision layer; rework SOL rules to RH 4663 notional caps); Skip as an app/data source (paper sim only, no chain reads, no execution, pump.fun framing, no RH 4663).
- SRC-195 | https://github.com/sergafon/solana-copy-trading | P1 | Adapt (copy-trading determinism, predicted-close, confirm/fill-slippage telemetry, sim-first); Skip as runnable dependency (Rust, Solana-locked instruction crafting).
- SRC-200 | https://github.com/slightlyuseless/pons-sniper | P0 | Adopt (curve `quote.ts` + `snipeTax.ts` + `strategy.ts` timing optimiser + verify-before-fire + event-read fill executor + nonce manager + gas caching — directly on Memeland's chain, deterministic, zero GMGN, green-label execution core) + Adapt (Multi-wallet worst-order batching, batched/fast dual client, position manager exit engine, cheapest-first filters) + Skip (pons v1 restricted-block path, target-deployer single-launch focus, no real opportunity edge).
- SRC-201 | https://github.com/soladdev/solana-meme-tool | P0 | Skip — broken/redacted shell, Solana-only, heavy, unsafe env handling, wash-trading focus; nothing Memeland should adopt. (Reference only for the bucketed wallet-risk-scoring *idea*, better implemented by SRC-081/SRC-162.)
- SRC-204 | https://github.com/stefanoviana/crypto-pump-scanner | P0 | Study (borrow the multi-layer confirmation + weighted-confidence detection and the cascade-TP/trailing/time-exit + circuit-breaker framework as generic momentum patterns) + Skip (direct adoption — CEX futures-only, monolithic, not an on-chain edge).
- SRC-205 | https://github.com/Stormeye85/robinhood-token-sniper | P0 | n/a
- SRC-210 | https://github.com/thegreatola/memecoins-trading-agent | P0 | Study (WS balance-delta buy-detection + timed N-wallet convergence-signal framing + stage pipeline pattern are worth borrowing, conceptually chain-portable) + Skip (adoption — incomplete skeleton, no package.json, Helius/Jupiter/DexScreener/X-locked follower edge).
- SRC-218 | https://github.com/trustwallet/blockatlas | P0 | Skip as a dependency/infra (unmaintained, heavy Go + RabbitMQ/Postgres, no RH 4663, EVM adapter depends on third-party explorer API, no raw on-chain indexing, dead project); Study only the capability-interface adapter/registry pattern and the block→subscription→notify decoupling as a design reference (superseded by SRC-088/206 for Memeland's use).
- SRC-229 | https://github.com/WebRaizo30/AnoMeme | P0 | Skip as a dependency/app (mock/hollow full-stack demo — Elixir backend, no real trading/chain/social/risk logic, hardcoded mock responses, no RH 4663, not portable to Memeland's TS bot); Study only the declarative `TriggerCondition/TradingAction/RiskParameters` intent shape and the `risk_score+factors+recommendations+expires_at` scoring record as minor data-model references (superseded by richer patterns from SRC-190/102/166).
- SRC-232 | https://github.com/yllvar/gmgn-TrendingAnalyzer | P0 | Skip (GMGN-scraping client — Solana-only, TLS-spoofing fragility, anti-goal) + Study (the cross-timeframe "consistency count + median market cap" aggregation as a conceptual quality-filter idea to rebuild over Memeland's own data).
- SRC-237 | https://gmgn.ai/blog/robinhood-chain-meme-coins-with-gmgn | P0 | Adapt
- SRC-248 | https://mcpmarket.com/server/openpump | P0 | Skip
- SRC-257 | https://www.coingecko.com/en/categories/meme-token | P0 | Study

### general (80)
- SRC-006 | https://985monitor.xyz | P2 | n/a
- SRC-012 | https://arxiv.org/html/2501.00826v3 | P2 |  Adapt <transferable methodology: regime-conditioned backtest, ablation, skill-augmentation and agent-weighting patterns to fold into the voter swarm and risk gates>`n- Security/complexity flags: research only, no network/key surface; verdict-ready adapt-as-methodology.`n.
- SRC-018 | https://developers.shrimpy.io | P2 | n/a
- SRC-027 | https://docs.fereai.xyz | P2 |  Skip <hosted paid trading-agent platform, closed and redundant with Memeland's own engine, no data or reusable pattern>`n- Security/complexity flags: closed custody, paid metered usage, external control plane; verdict-ready skip.`n.
- SRC-031 | https://ethglobal.com/showcase/agentstrategy-hiyug | P2 | n/a
- SRC-036 | https://github.com/0xjeffro/tx-parser | P2 | Adapt (port program-router + swap schema + mint-resolution + slippage capture to TS/viem, or run as Go sidecar). High value for Solana swap->candle and whale feed.
- SRC-037 | https://github.com/0xmfox/rabiq | P2 | Adopt the two-lane RPC throttle, `logsSplit`, and Pons phase/curve-pricing patterns as portable RH-4663 edge code that also reduces GMGN coupling.
- SRC-039 | https://github.com/0xwast3/PELLET | P2 | Adopt the ordered first-fail risk-gatechain with `UNKNOWN` refusal and the throw-free provider contract; both are low-coupling, chain-portable, and directly reduce GMGN dependence.
- SRC-044 | https://github.com/a-guard/malicious-validators | P2 | Skip one-off single-chain MEV data analysis with no portable, tested algorithm.
- SRC-047 | https://github.com/AgriciDaniel/claude-obsidian | P2 | Skip no trading, market, or execution logic; an Obsidian/Claude knowledge-graph tool whose only transferable idea is broad PKM/ledger organization.
- SRC-048 | https://github.com/AI-PIN/ChainPlusTrader | P2 | Adapt the Uniswap V3 fee-tier pool discovery and the per-network, error-classified retry backoff; skip the monolithic platform.
- SRC-050 | https://github.com/akanz/onchain-trading-bot | P2 | Adapt (deterministic gate scorer, Wilson qualification, co-buy cluster + price-chase, surge attribution, weighted rate gate - port as pure TS functions). Skip the NestJS/Mongo/Telegram app scaffolding and the GMGN-only data layer.
- SRC-054 | https://github.com/andreysuperiorgit/aegis | P2 | Adopt the RH/EVM scanner (ZeroAddress owner, selector scan, bundle detection, weighted tiered scoring) into the security/rug-risk voter; skip the Grok dependency and sniper plumbing.
- SRC-055 | https://github.com/Argona7/stampede | P2 | Adopt the portable RPC failover/accounting and distinct-wallet rotation weighting; Adapt the calibrated hard walls, Kelly/volatility sizing, and next-block paper ledger into existing Memeland risk and simulation layers.
- SRC-057 | https://github.com/asavinov/intelligent-trading-bot | P2 | Study the extremum-label + interval-precision methodology for Memeland's calibration/anti-overfit work, and the buy/sell score combination for voter fusion; do not adopt the framework.
- SRC-060 | https://github.com/Benita2001/SpecterAI | P2 | Adapt the bounded multi-wallet consensus and bot-filter features; skip Birdeye, Claude, dashboard, and the zombie agent as a complete subsystem.
- SRC-064 | https://github.com/bmoscon/cryptofeed | P2 | Adapt - port the closed-candle timing, watchdog+backoff reconnect loop, raw-message observer tap, 429 handling, and normalized-schema taxonomy as small building blocks. Skip the full cryptofeed framework and CEX-specific exchange layer (no DEX/on-chain feeds).
- SRC-067 | https://github.com/build23w/fdv.lol | P2 | Adapt the HWM trailing hard-stop, profit-lock floor, momentum-fade, and rug blacklist exit policies; skip the rank/shill, LLM agent, and browser dashboard.
- SRC-068 | https://github.com/ccxt/ccxt | P2 | Adapt (port the `Precise` `bigint`-decimal math class and the leaky-bucket Throttler as small, dependency-free TS primitives for Memeland's quoting/sizing + RPC 429 pacing); Skip the ccxt library itself (CEX-only, no DEX/RH-4663/on-chain coverage, heavy 100+-exchange abstraction not used).
- SRC-069 | https://github.com/chainbase-labs/manuscript-core | P2 | Skip heavy monolithic chainbase data-streaming framework with no transferable trading or risk algorithm; rejects Memeland's low-complexity, chain-portable goals.
- SRC-075 | https://github.com/ctubio/Krypto-trading-bot | P2 | Study the EWMA-of-EWMA fair-value smoothing and trend-diff auto-position as possible voter/sizing inputs; skip the C++ market-making engine for Memeland.
- SRC-082 | https://github.com/dragon1086/prism-insight | P2 | Adapt the deterministic regime-scoped entry gate pattern (fail-closed, floor tables, R/R recompute, vol noise-floor stops, hard-vs-shadow) into Memeland's risk layer; skip the monolithic AI stock system.
- SRC-090 | https://github.com/Erfaniaa/financial-dataset-generator | P2 | Study the forward-WMA label and the strided train-row de-correlation for calibration; skip the generator as a tool.
- SRC-092 | https://github.com/Erfaniaa/undervalued-crypto-finder | P2 | Skip a trivial single-indicator daily MA screen with no concrete, testable trading algorithm for Memeland's context.
- SRC-093 | https://github.com/EthanAlgoX/LLM-TradeBot | P2 | Adapt the veto/downgrade risk-override-with-audit-reason and the per-bucket min-sample calibration into Memeland's risk gates and voter calibration; skip the multi-agent monolith.
- SRC-095 | https://github.com/Fincept-Corporation/FinceptTerminal | P2 | Skip heavy Qt desktop research monolith whose trading/backtest value is SaaS-gated; nothing portable for a memecoin swarm bot.
- SRC-096 | https://github.com/FinStep-AI/ContestTrade | P2 | Adopt the forward-outcome reward label plus predicted-Sharpe-weighted voter allocation and only-deduct multi-judge critique as Memeland calibration and consensus-weights machinery.
- SRC-097 | https://github.com/flash131307/multi-agent-investment | P2 | Adopt the consistency-gate lookup, risk-mode dampening, regime-weighted voters, degradation multipliers, and deterministic no-LLM fusion path as Memeland consensus/risk-gate machinery.
- SRC-106 | https://github.com/gustaffsonKotte/qlo | P2 | Study the time-on-curve organic-demand filter (evidence-backed, chain-portable-concept) and adopt the early-stop pagination + raw-pool-state pricing verification; skip the single-chain alert-bot shell.
- SRC-107 | https://github.com/h100envy/nerve | P2 | Adopt SENTINEL eth_simulateV1 round-trip honeypot/tax detection, the bytecode PUSH4 risk-flag scan, and reconcile-by-nonce exactly-once send; plus owns/boundary node discipline, fail-closed scored gates and pinned-block staleness for the swarm. RH-4663 native, no GMGN dependency.
- SRC-110 | https://github.com/HKUSTDial/DeepEar | P2 | Study the ISQ weighted multi-dimension signal-quality scoring schema and the dual-model scanner/evaluator + news-ablation evaluation discipline; skip the heavy LLM research/dashboard/monolith.
- SRC-112 | https://github.com/holdout-labs/lookahead-free | P2 | Adopt - port the DAG + linear-time decision-availability checker and the P0/P1 severity + "value-dependent can't be proven" honesty boundary as a small TS library; wire it into Memeland's backtest/dry-run attribution so every signal build and trade decision is accompanied by a machine-checkable timing evidence layer.
- SRC-114 | https://github.com/Im-Madhur-Gupta/maverick | P2 | Study the structured direction/strength/percentage signal schema, the strength-tier gate, and percentage-based partial sizing; skip the Farcaster-social + Fere-API pipeline and the retry-with-duplicates execution path.
- SRC-115 | https://github.com/immortalhowwl/fly-high | P2 | Adopt the causal next-close simulator (gap-cancelling fills, depth-capped equity/fitness, conservative fee+slippage) and the cold-out holdout + drawdown-penalized fitness search as Memeland's strategy/voter validation discipline. Data-agnostic, chain-portable, no GMGN dependency.
- SRC-120 | https://github.com/JulienPlanchetCoineo/frostybot-js | P2 | Skip CEX-only webhook-to-exchange gateway plumbing; position-target sizing is only marginally related and Memeland already covers sizing with on-chain semantics.
- SRC-121 | https://github.com/kabbersokhi-boop/crypto-trend-hunter | P2 | Skip README/dashboard-driven LLM-sentiment pipeline; only the deterministic momentum formula and per-agent fault-isolation are mildly Study-worthy, neither is a Memeland-specific edge.
- SRC-122 | https://github.com/Kelows/million | P2 | Adopt the chain-portable risk-gate structure (one-way-door caching, concurrent check chains, distribution grace, owner de-dup consensus, control-group calibration, decision ledger); Solana data adapters are not portable.
- SRC-123 | https://github.com/kocer6/MEERKAT | P2 | Adopt the fail-closed unreadable-gate discipline, evidence-carrying composable scoring with coverage-gated readiness, and per-client admission control + reorg-overlap scanner checks; all map directly to Memeland's risk gates and RH-4663 data layer.
- SRC-133 | https://github.com/liangdabiao/autogen-financial-analysis | P2 | Study the historical/parametric/Monte-Carlo VaR + Expected-Shortfall functions and the LOW/MED/HIGH/CRITICAL threshold-bucket pattern as a tail-risk sizing input; Skip the AutoGen/equity monolith around them.
- SRC-138 | https://github.com/LuckyOne7777/LLM-Trading-Lab | P2 | Study Peak Capture Ratio as an exit-capture calibration metric and the FIFO lot accounting as a PnL telemetry reference; Skip the LLM-managed portfolio orchestration (LLM in critical path, equities data).
- SRC-139 | https://github.com/Lumiwealth/lumibot | P2 | Study the mid+slippage/clamp/round-to-tick fill model with per-fill audit payload and the DataSource ABC as the pattern for a pluggable market-data interface to cut GMGN coupling; Skip the monolithic framework itself.
- SRC-140 | https://github.com/lunarresearcher/copy | P2 | Study - copy walls and webhook executor state machine are portable and match existing anchors, but need validation against Memeland's current voters before adoption.
- SRC-142 | https://github.com/lyc0603/copytrading | P2 | Study - the t-stat profitability filter and bot-manipulation feature list are worth copying; the Snowflake+LLM pipeline itself is too heavy.
- SRC-150 | https://github.com/milesdeutscher/garchmethod | P2 | Adapt - port the walk-forward GARCH(1,1) + vol-target sizing into RiskManager for vol-aware position sizing.
- SRC-151 | https://github.com/mnemox-ai/tradememory-protocol | P2 | Adapt - copy the AdaptiveRisk worst-status-wins constraint merge and the outcome-weighted recall-to-Kelly sizing as lightweight TS modules; skip the MCP, evolution, and simulation scaffolding.
- SRC-152 | https://github.com/moazamdotdev/Trading-platform-frontend | P2 | Skip - a wallet-connected swap UI with no backend, no edge, and no transferable logic.
- SRC-155 | https://github.com/moorcheh-ai/memanto | P2 | Study - the memory-lifecycle/conflict-resolution protocol is a good fit for the voter swarm, but the package is heavy and not trading-specific.
- SRC-158 | https://github.com/mvanhorn/last30days-skill | P2 | Skip - a research/search plugin with no trading edge and no transferable trading algorithm.
- SRC-159 | https://github.com/nansen-ai/nansen-cli | P2 | Study (overall framework too heavy, private-API-coupled, execution-only). Adapt the specific fail-closed swap-outcome simulation + sanity-ceiling gate pattern as a portable TS helper for Memeland's execution-governance layer.
- SRC-163 | https://github.com/nikmcfly/MiroFish-Offline | P2 | Study - the persona-based sentiment-simulation concept is novel for a sentiment voter, but infra and offline nature make adoption premature.
- SRC-164 | https://github.com/nirholas/crypto-vision | P2 | Study - extract the circuit-breaker/failover and anomaly-detector modules; skip the platform.
- SRC-176 | https://github.com/OpenBB-finance/OpenBB | P2 | Study the provider-extension/plugin-behind-unified-facade architecture and the one-core-multi-surface (REST/MCP/Python) exposure pattern as a design reference for Memeland's data layer (superseded by lighter equivalents in SRC-218/159); Skip OpenBB as a dependency/platform (AGPL, equities-centric, no RH 4663/memecoin/trading, heavy FastAPI stack not portable to Memeland's TS bot).
- SRC-179 | https://github.com/oratis/influencex | P2 | Skip - a KOL marketing platform with no trading edge or transferable algorithm.
- SRC-184 | https://github.com/pgen0x/azimuth | P2 | Adapt - copy the keyless multi-source discovery, fail-closed-on-positive-security with sticky convictions, layered live-flow gates, lone-candidate conviction floor, PVP guard, tenure sizing and escalating cooldown; skip the heavy daemon, Redis and executor shell.
- SRC-185 | https://github.com/PillCrew/claimchain | P2 | Adapt Groundedness-gate is a real, low-complexity, chain-portable cross-check that belongs in the consensus/sanction path.
- SRC-186 | https://github.com/PillCrew/PillCrew | P2 | Skip No real edge; Solana-only UI app whose only useful patterns (resilient keyless fetch, simple scorecard) are already covered by Memeland anchors.
- SRC-191 | https://github.com/rimtoln/fletch | P2 | Study - borrow the factor-normalization and freshness scoring; the pump.fun screener itself is out of scope.
- SRC-193 | https://github.com/ryan-yuuu/crypto-trading-arena | P2 | Study - the single-connector fan-out and per-voter tool identity are useful for GMGN decoupling, but the harness/infra is too heavy to adopt.
- SRC-194 | https://github.com/semkazz1/FlySwarm | P2 | Adopt - same Node/ESM ecosystem, RH-4663 native, GMGN-independent, and a concrete weighted cohort-voter with explainable thresholds and a working RPC adapter.
- SRC-196 | https://github.com/sevenlabs-hq/carbon | P2 | Skip Rust Solana-indexer infrastructure with no portable edge for a TS multi-chain bot; architecture concept only.
- SRC-197 | https://github.com/shmidtqq65/loxley | P2 | Adopt The pons launchpad scoring + named refusals + farm fingerprint and the pure-engine module are concrete, RH-4663-native, low-coupling algorithms that map straight to a real edge.
- SRC-198 | https://github.com/Shradhesh71/YellowStone-gRPC | P2 | Study Stream-health and multi-channel alert patterns are worth noting for Memeland's sentinel/data-layer observability, but the indexer core is Solana-only and portable to RH-4663.
- SRC-202 | https://github.com/solo-agent/solo | P2 | Skip Heavy general-purpose AI-agent workspace with no trading algorithm or edge that maps to Memeland's goals.
- SRC-203 | https://github.com/sopersone/CROWBRAIN | P2 | Skip A toy SMA observation loop with no edge; its only hygiene patterns are already covered by Memeland's data layer.
- SRC-211 | https://github.com/thetateman/Trading-API | P2 | Skip README-only repo for a hosted single-chain paid API with no code to audit and no portable edge.
- SRC-214 | https://github.com/Tomortec/CryptoTradingAgents | P0 | Adapt (round-capped debate->judge fusion, reflection-memory loop, entry/SL/TP refinement contract; port orchestration to TS). Study the LangGraph plumbing. Skip the framework + CEX data layer.
- SRC-216 | https://github.com/tow3web3/agentinu | P2 | Skip No auditable code (README + animation demo only); asserted edge is opaque and external to Memeland's coupling and portability goals.
- SRC-219 | https://github.com/uerax/all-in-one-bot | P2 | Study the two-candle-above-entry win-rate rule and the concurrent multi-source screening fan-out as portable TS patterns.
- SRC-221 | https://github.com/ValueCell-ai/valuecell | P2 | Skip heavy LLM-driven monolith with ccxt dependency; no concrete portable algorithm beyond guardrails already in Memeland.
- SRC-228 | https://github.com/wealthfolio/wealthfolio | P2 | Skip a portfolio/net-worth tracker with no strategy, scoring, or execution code relevant to Memeland.
- SRC-231 | https://github.com/ygwyg/MAHORAGA | P2 | Study the approval-token TTL binding and pluggable entry/exit strategy harness to harden execution governance.
- SRC-233 | https://github.com/zetryn-ai/ai-agent | P2 | Adopt the downgrade-only guardrail pipeline and the rug-avoidance/entry backtest metrics as portable TS patterns for the consensus gate.
- SRC-234 | https://github.com/ZhuLinsen/daily_stock_analysis | P2 | Skip heavy LLM-driven stock-analysis report platform; multi-source fallback is a generic pattern already pursued by Memeland, and the TA rules are equity-only.
- SRC-235 | https://github.com/zostaff/agent-arena | P2 | Adopt the pure radar detectors, verdict-hardening/fail-safe SKIP, and the gross-net deterministic backtest split as portable TS patterns for the RH-4663 entry layer and evaluation ledger.
- SRC-242 | https://jup.ag | P2 | n/a
- SRC-244 | https://madeonsol.com/developer | P2 | n/a
- SRC-245 | https://maverick-backend.onrender.com/api | P2 | n/a
- SRC-250 | https://p.nomics.com/cryptocurrency-bitcoin-api | P2 | n/a
- SRC-261 | https://github.com/tsukiema1/FLYWHEEL | P2 | Adopt the propose-vs-decide risk architecture, structured observed/limit risk checks, resulting-weight sizing, two-sided liquidity band, and append-only decision ledger; Skip the biological/connectome signal layer.
- SRC-262 | https://github.com/zostaff/grok-trading-desk | P2 | Adopt Fail-closed vetoes, pessimistic fallbacks, cross-market sizing, and cost-gated two-stage filtering map to real operational edges and port to every chain Memeland trades; also a concrete GMGN-decoupling pattern.

### mcp-data-tools (31)
- SRC-026 | https://docs.dune.com/api-reference/agents/mcp | P0 | Adapt
- SRC-043 | https://github.com/6551Team/opennews-mcp | P0 | Skip - provider-dependent closed-API MCP wrapper, redundant with existing news/sentiment adapters, no local algorithm to port; token-in-config and WS-query-string are anti-patterns.
- SRC-045 | https://github.com/aahl/mcp-aktools | P0 | Skip for Memeland - wrong domain (China equities + CEX spot), heavy Python data-stack, open-CORS HTTP default is an anti-pattern; cache/indicator patterns add no net edge over existing modules.
- SRC-046 | https://github.com/aave/skills | P1 | Study (workflow/skill patterns only); Adapt the simulate-then-confirm-from-state conventions into Memeland's execution and post-trade attribution path. Do not adopt the hosted Aave MCP dependency.
- SRC-052 | https://github.com/alpacahq/alpaca-mcp-server | P0 | Adapt the trust-boundary envelope, per-tool output-risk registry, timeout-idempotent order submission, and toolset allowlist (small TS middleware for Memeland's LLM surfaces + executor); Skip the Alpaca brokerage/CEX data plumbing itself. Well-tested reference-grade security patterns, no memecoin/on-chain edge.
- SRC-058 | https://github.com/atilaahmettaner/tradingview-mcp | P0 | Adapt the walk-forward train/test + overfitting verdict concept into Memeland's quant/learning gate (port to TS, measure OOS Sharpe of consensus/voter strategies); Study the zero-dep indicator + backtest engine as a reference for Memeland's deterministic quant layer; Skip the MCP server wholesale (CEX-focused, heavy, Python/pandas, screeners). Not a memecoin/chain-edge source.
- SRC-059 | https://github.com/autonsol/sol-mcp | P0 | Skip — closed-vendor MCP proxy, no reusable algorithmic edge, Solana-only, opaque risk methodology. (Only marginal "Study" of its zod-schema MCP tool pattern, already seen better in SRC-052.)
- SRC-062 | https://github.com/BlockRunAI/awesome-finance-mcp | P0 | n/a
- SRC-079 | https://github.com/dbotx/dbot-mcp-servers | P0 | Skip for ownership reasons (remote execution, closed backend). Study its zod tool-schema style + trading-parameter taxonomy as a spec for Memeland's own TS toolset.
- SRC-084 | https://github.com/dynamolabs/solana-mcp | P0 | Adapt — port the risk-scoring rubric, LP/holder-concentration checks, and bundle detection to Memeland's multi-chain stack; the Helius/pump.fun specifics are Solana-only. Lightweight, no secrets, genuinely reusable edge.
- SRC-094 | https://github.com/financial-datasets/mcp-server | P0 | Skip — stock-market vendor proxy, zero algorithmic value, wrong domain. (MCP-tool boilerplate is the only lesson, already covered by better sources.)
- SRC-104 | https://github.com/guangxiangdebizi/FinanceMCP | P0 | Adapt (router pattern + TA indicators + HTTP hardening) / Skip (the broader equity MCP, its weight, and its domain).
- SRC-125 | https://github.com/kukapay/crypto-indicators-mcp | P0 | Skip — CEX OHLCV passthrough with delegated math and a packaging bug; no ownable edge. (Reference the `indicatorts` library name if Memeland wants a ready TA lib, but prefer SRC-104's zero-dep math.)
- SRC-126 | https://github.com/kukapay/crypto-sentiment-mcp | P0 | Skip — vendor-token passthrough for major-coin sentiment, injection-prone query building. Study the baseline-shift alert pattern (apply to Memeland's own volume/activity series) without adopting the source.
- SRC-127 | https://github.com/kukapay/dexscreener-trending-mcp | P0 | Skip the vm/page-scrape approach. Study the pair-normalization schema + Markdown/structured dual output and the DexScreener-feed idea, but implement against DexScreener's official JSON endpoints instead (see SRC-084/226).
- SRC-128 | https://github.com/kukapay/honeypot-detector-mcp | P0 | n/a
- SRC-129 | https://github.com/kukapay/jupiter-mcp | P0 | Skip for Memeland (Solana/Jupiter-only, insecure-by-default signing surface). Adapt at most the order/execute split + mint-decimals conversion into Memeland's own execution layer — but with SRC-052's trust-boundary and tx-allowlist safety.
- SRC-136 | https://github.com/LLMQuant/awesome-trading-agents#mcps-tradingagents-mcpmode | P0 | n/a
- SRC-137 | https://github.com/LLMQuant/data-mcp | P0 | Adapt its error-contract + api-provider patterns (and testing rigor) into Memeland; Skip the server/data source itself (vendor-metered, equity-domain, heavy).
- SRC-143 | https://github.com/manavaga/web3-signals-mcp | P0 | Adopt the IC-weight-learning + Platt-calibration + regime-gating + walk-forward-validation methodology as the core of Memeland's scoring edge; Skip the repo's heavy Python ML/Postgres/x402/LLM stack and its major-coin data coupling. Highest-value source so far.
- SRC-144 | https://github.com/marc-shade/world-intel-mcp | P0 | Skip as a server/dependency (domain mismatch, heavy); Study the per-source circuit-breaker-with-stale-serve pattern for Memeland's market-data/RPC adapter if fail-soft behavior on provider outages is currently a hard cut-off.
- SRC-146 | https://github.com/massive-com/mcp_massive | P0 | Skip as a dependency (equity-domain commercial API, Python); Study the closed typed function-registry design as a fail-closed pattern for LLM-triggered computation.
- SRC-169 | https://github.com/nirholas/robinhood-chain-mcp | P0 | n/a
- SRC-172 | https://github.com/okx/agent-skills | P1 | Skip as a data/execution dependency (CEX OKX, no RH memecoin edge); Study the skill-format/routing and credential-preflight pattern for Memeland's own agent-facing skills.
- SRC-174 | https://github.com/okx/onchainos-skills | P1 | Study (workflow/security patterns only); Skip the OKX onchainos CLI/MCP dependency (no RH 4663, closed vendor + agent-wallet custody). Reuse the read/write-gate + untrusted-content + top-N enrichment conventions in Memeland's own meme scanner.
- SRC-181 | https://github.com/Panniantong/Agent-Reach | P1 | Adapt (the ordered multi-backend probe/override pattern is lightweight, portable, non-GMGN; adoptable for RPC/price-source failover) + Skip (as a dependency — no chain logic, social-scraping focus, Python stack different from Memeland's TS).
- SRC-192 | https://github.com/RKiding/Awesome-finance-skills | P1 | Adapt (the signal-evolution lifecycle + baseline-then-adjust forecast pattern — portable, light, non-GMGN; adoptable as TS types/state machine for Memeland meme theses); Skip the ML/news stack as a dependency (heavy, stock-focused, no RH 4663 coverage).
- SRC-215 | https://github.com/tony-42069/solana-mcp | P0 | Study the weighted opportunity-score + safety-rubric template and dynamic function-loader; Skip the code itself (unfinished scaffold, DB/LLM/scraper-coupled, Solana-only, permissive CORS).
- SRC-217 | https://github.com/tradermonty/claude-trading-skills | P1 | Adapt (risk-gate fail-closed semantics, snapshot-replay regime scoring, Decimal sizing, endpoint-key-masking — all portable/light/non-GMGN, adoptable in TS); Skip the repo as a dependency (equity-focused, ~2000 files, heavy Python ML/quant stack, no RH 4663).
- SRC-246 | https://mcp.bitquery.io | P0 | Adapt
- SRC-247 | https://mcp.crypto.com | P0 | Study

### market-data (25)
- SRC-005 | http://www.predictions.exchange/dex | P1 | Skip dead page (HTTP 410) with no retrievable content; no data or patterns map to a Memeland edge.
- SRC-009 | https://api.coinpaprika.com | P1 | Study keyless aggregated macro/market-breadth feed that complements GMGN for regime signals but cannot cover RH-4663 or memecoin universe.
- SRC-010 | https://api.dexpaprika.com | P1 | Adopt keyless multi-chain feed (incl. RH-4663) plus Adapt drain-detection/SSE reserve-streaming pattern to de-couple from GMGN.
- SRC-011 | https://app.santiment.net/assets/list?name=decentralized%20exchanges | P1 | Study portable sentiment/network-growth metric patterns; Skip as a live feed because it is a paid key with no RH coverage.
- SRC-013 | https://birdeye.so | P1 | Study complementary keyed feed with RH and Solana coverage that adds security/holder/liquidity signals to the voter stack.
- SRC-016 | https://debank.com/ranking/dex | P1 | Skip <wallet/portfolio-centric, redundant with GMGN/DexScreener, paid keyed units, no RH-4663 trade edge>
- SRC-017 | https://defined.fi/api | P1 | Skip <closed institutional terminal, redundant wallet/order-flow data, no keyless RH feed, bot-check protected>
- SRC-019 | https://dex.watch | P1 | Skip <dead/unreachable site, no documented API, redundant with current DEX screener stack>
- SRC-020 | https://dexindex.io | P1 | Skip <dead/unreachable site, no documented API, redundant with existing DEX aggregators>
- SRC-022 | https://docs.birdeye.so | P1 | Study the documented API contract and batch/CU-cost patterns; supported-network table confirms RH coverage.
- SRC-023 | https://docs.codex.io/networks | P1 | Adopt <unified keyless-to-MPP GraphQL feed with explicit RH-4663 + all Memeland chains covered and wallet/launchpad analytics; strongest candidate to reduce GMGN coupling>
- SRC-024 | https://docs.coincap.io | P1 | Study <portable agentFriendly/x402/MCP API design; feed itself irrelevant to memecoin + no RH>
- SRC-025 | https://docs.dexscreener.com | P1 | Study <keyless free multi-chain fallback + rate-tier/batch patterns; data overlaps GMGN and lacks RH-4663>
- SRC-030 | https://etherscan.io/dextracker | P1 | Skip <Ethereum-only UI dashboard, no programmatic feed, redundant with GMGN/DexScreener>
- SRC-034 | https://geckoterminal.com/api | P1 | Study <keyless multi-chain DEX/new-pool feed complementing GMGN; geo-blocked here and no RH-4663 confirmed>
- SRC-091 | https://github.com/Erfaniaa/financial-indexes-correlation | P1 | Study (time-series alignment + correlation technique only); Skip as a data source / codebase for Memeland (CEX/equity feeds, toy scale).
- SRC-154 | https://github.com/monarchjuno/tradingcodex | P1 | Adopt (execution-governance concepts: idempotent reservation, payload-hash-locked approval receipts, append-only audit, deny-first capability RBAC — port to TS, not heavy); Skip (the Django/Codex runtime itself).
- SRC-213 | https://github.com/tiagosiebler/OrderBooks | P1 | Adopt (the slippage-impact fill-simulation pattern — port to pool-depth impact calc in TS); Adapt (use the LOB class directly only for CLOB perp legs).
- SRC-222 | https://github.com/vincentkoc/dexscraper | P1 | Adapt (keyless multi-chain DexScreener feed via WS/REST + filter/rank param encoding + discovery presets — port to TS, drop the binary-parse heuristic and the cloudscraper bypass); Skip (the fragile protocol reverse-engineering & GPU-adjacent Python deps).
- SRC-226 | https://github.com/w3laba/DexScreener-Trending | P1 | Skip (traffic-bot for trending manipulation; no usable data/signal, ToS risk, credential-from-file). Note the manipulation risk in Memeland research: do not weight DexScreener/Dextools trending heavily.
- SRC-239 | https://graphs.santiment.net/dex_trades | P1 | Study <reconfirms Santiment SanAPI DEX-trades GraphQL shape; paywalled and no RH, redundant with GMGN on covered chains>
- SRC-243 | https://liquidity.vision | P1 | Skip <dead/unreachable Uniswap-v3 LP management UI, no API, no relevance to memecoin trading edge>
- SRC-258 | https://www.coingecko.com/learn/best-free-crypto-api | P1 | Study <useful comparative selection framework for keyless feed redundancy, not a data feed; no RH-4663 detail>
- SRC-259 | https://www.geckoterminal.com | P1 | Study <product pattern for new-pool/early-token discovery and deep multi-chain coverage; geo-blocked here, RH-4663 unconfirmed, overlaps SRC-034>
- SRC-260 | https://www.theblockcrypto.com/data/open-finance/dex-non-custodial | P1 | Skip <aggregate monthly macro charting, paywalled, no API feed, no memecoin/RH-4663 edge, redundant with DefiLlama/CoinGecko volume>

### trading-risk-research (21)
- SRC-041 | https://github.com/51bitquant/ai-hedge-fund-crypto | P1 | Study - keep the deterministic multi-timeframe indicator library and the pre-computed-position-limit pattern for the quant/risk voters; skip the LangGraph/LLM decision architecture and the platform itself.
- SRC-042 | https://github.com/555cute/r20-quantum-trader | P1 | Study (regime four-state detector, pure-function backtest metrics, single-source risk-config pattern as TS ports) / Skip (the platform, council/LLM stack, CEX futures execution).
- SRC-053 | https://github.com/AmadeusGB/alpha-arena | P1 | Skip - thin CeX-only MVP with broken standalone dependency and no edge over Memeland's deterministic-consensus + fail-soft LLM voters. (Note near-duplicate with SRC-171 alpha-arena-okx.)
- SRC-065 | https://github.com/brokermr810/QuantDinger | P1 | Adopt (fee-aware trailing-exit breakeven + free-balance spot sizing + idempotent fill/PnL reconciliation as TS modules) / Skip (the platform itself). See SRC-177 for the same repo; audit once, apply findings to both.
- SRC-083 | https://github.com/Drakkar-Software/OctoBot | P1 | Study (live/sim channel pattern, evaluator plugin-input schema, realistic simulated-exchange backtester) / Skip (the platform).
- SRC-085 | https://github.com/edtechre/pybroker | P1 | Study (read-only reference: BCa bootstrap CI, jackknife profit-factor/Sharpe, Decimal position-ledger with epsilon clamping, declarative stops, walk-forward) - port the small math to TS for Memeland's backtest/replay evaluator; no platform adoption. Consider Adapt for the metric functions if Memeland builds a TS backtest analyzer.
- SRC-089 | https://github.com/enzoampil/fastquant | P1 | Skip - thin, backtrader-bound educational wrapper with no chain edge and stale deps; nothing Memeland can use beyond a trivial registry scheme it already has. (No near-duplicate noted.)
- SRC-098 | https://github.com/freqtrade/freqtrade | P0 | n/a
- SRC-105 | https://github.com/GuntharDeNiro/gunbot-quant | P1 | Adopt (port `volume_concentration_pct`, `max_daily_spike_pct`, `volatility_consistency`, distance-from-ATH + liquidity screening metrics and the declarative filter schema into Memeland's universe/bot-rug voters) / Skip (backtest engine & platform - crude fill model, Python, CEX/Gunbot-bound).
- SRC-113 | https://github.com/hummingbot/hummingbot | P0 | n/a
- SRC-134 | https://github.com/LLMQuant/awesome-trading-agents | P1 | n/a
- SRC-135 | https://github.com/LLMQuant/awesome-trading-agents#agents-atlas-gic | P1 | n/a
- SRC-149 | https://github.com/Miasyster/QuantGPT | P1 | Adapt (port the 4-test anti-overfit battery + the rules/findings/failures knowledge-base and `[Agent+DS Consensus/Disagreement]` convention for Memeland's voter-learning/edge validation) / Skip (the factor-mining platform, Rust engine, WorldQuant/equity integration).
- SRC-161 | https://github.com/nautechsystems/nautilus_trader | P1 | Study (adapt the `PortfolioStatistic` interface, same-code-backtest-and-live principle, engine-level risk/portfolio enforcement into Memeland's TS design) / Skip (the platform - Rust core, huge, institutional venue focus, no memecoin/chain-native edge).
- SRC-171 | https://github.com/oficcejo/alpha-arena-okx | P1 | Adapt (LLM-signal deterministic validation/clamping rules + ATR-regime-conditional dynamic TP/SL as patterns for Memeland's voter gating and exit sizing) / Skip (the platform - single-pair CEX BTC bot, low code quality, no chain-native edge). Note name near-duplicate of SRC-053 alpha-arena; unrelated projects.
- SRC-175 | https://github.com/olaxbt/ai-market-maker | P1 | Adapt (port Memeland's voter layer to: per-voter canonical JSON contract with status, factor-normalization to [0,1], two-level weighted fusion with confidence = magnitude*consensus_ratio, min-factors alignment gate, and a veto-vs-caution risk guard with MDD-stop-blocks-risk-increase + gross-leverage clamp; adopt the Pydantic VetoRule/AlphaFactor/ATR-stop/RR-TP blueprints as TS schemas) / Skip (the platform, Nexus data coupling, LangGraph/FastAPI/web stack).
- SRC-177 | https://github.com/OpenByteInc/QuantDinger | P1 | Adopt (the three fee/sizing/reconcile primitives as TS modules) / Skip (the platform). Duplicate of SRC-065 - audit once, apply findings to both; keep a single "QuantDinger" note in Memeland's edge inventory.
- SRC-182 | https://github.com/paperswithbacktest/pwb-alphaevolve | P1 | Study (the island/elite-archive/lineage selection + staged exploration-exploitation search loop as a TS pattern for robust voter-weight/preset search) / Skip (the LLM strategy-code evolution engine - Backtrader, OpenAI o3, equities data, arbitrary-code-exec by LLM).
- SRC-209 | https://github.com/TheGigaQuant/frostybot-js | P1 | Adapt (port the position-target + maxsize-cap order sizing and precision/floor dust-avoidance + relative-limit-price helpers into Memeland's execution/order-builder as TS utilities) / Skip (the webhook/ccxt/GUI platform, secrets-at-rest scheme, old JS style). Note: only one frostybot-js source assigned; README/wiki actually point to the original CryptoMF/frostybot-js (this is its fork).
- SRC-236 | https://github.com/zostaff/ai-quant-researcher | P1 | Adopt (as TS ports for Memeland's learn/validate layer: deflated Sharpe w/ honest trial count, purged CV + embargo, structural & correlation leakage detection, latched kill-switch, round-turn cost + sqrt-impact, arrival/implementation-shortfall TCA, and consensus meta-labeling act/skip) / Study (the gate-composition pipeline and per-regime risk attribution) / Skip (the LLM code-generation loop + `exec` runtime + anthropic/backtrader-free bar VM as a system).
- SRC-249 | https://orderflow.art | P1 | Study

### chain-data-infra (18)
- SRC-007 | https://alchemy.com | P1 |  Study <provider option; real RH-4663 RPC/archive coverage worth a fallback, but paid key and redundant with existing execution path>`n- Security/complexity flags: keyed auth, third-party API key surface; verdict-ready study-as-provider-option.`n.
- SRC-014 | https://chainstack.com | P1 |  Skip <generic managed-node provider; RH node is the only marginal point and it is redundant with incumbent RPC infra>`n- Security/complexity flags: keyed node access, extra external infra; verdict-ready skip as code-to-copy.`n.
- SRC-021 | https://dexrabbit.bitquery.io | P1 | n/a
- SRC-029 | https://docs.moralis.com | P1 | n/a
- SRC-063 | https://github.com/blockscout/blockscout | P1 | Skip as a component; Study the `RequestCoordinator`/`RollingWindow` backoff + batched ERC-20 `eth_call` pattern if RPC failover ever needs adaptive per-method throttling.
- SRC-088 | https://github.com/enviodev/hyperindex | P1 | Skip as a framework/dependency; Study the block-range batching + cursor + reorg-guard + dynamic contract-registration pattern to harden the RH chain-flow adapter if reorg handling is currently weak.
- SRC-111 | https://github.com/holaplex/indexer | P1 | Skip - Solana-only geyser/RabbitMQ/Postgres infra, irrelevant to RH EVM and too heavy for a personal bot.
- SRC-148 | https://github.com/messari/subgraphs | P1 | Skip as a dependency/source (no RH coverage, heavy); Study the standardized DEX schema and multi-oracle price-fallback design as a reference if Memeland consolidates per-chain pool analytics.
- SRC-183 | https://github.com/paradigmxyz/cryo | P1 | Skip as tooling; Study/Adapt the ERC-20 transfer log-filter/decode shape and RPC rate-limit gauging into the RH chain-flow adapter.
- SRC-206 | https://github.com/subsquid/squid-sdk | P1 | Skip as a framework; Study the `RpcEndpointSettings` surface (rateLimit, maxBatchCallSize, retry, head poll) as a checklist for Memeland's RPC adapter if batch sizing/retry are currently ad hoc.
- SRC-220 | https://github.com/uxuycom/indexer | P1 | Skip as a codebase (Go/MySQL, plaintext DB creds, non-RH token standard); Study the block/tx batch-worker + finality-delay + event-topic-filter config pattern for Memeland's RH scanner.
- SRC-238 | https://goldsky.com | P1 | n/a
- SRC-240 | https://helius.dev | P1 |  Skip <paid Solana-only infra redundant with incumbent Solana/GMGN path and no RH or cross-chain value>`n- Security/complexity flags: keyed access, third-party Solana trust; verdict-ready skip.`n.
- SRC-241 | https://ide.bitquery.io | P1 | n/a
- SRC-251 | https://quicknode.com | P1 |  Study <provider option with the most explicit RH-4663 mainnet + debug/archive coverage; good backup + reference, not raw data edge>`n- Security/complexity flags: keyed auth, cost-metered usage; verdict-ready study-as-provider-option.`n.
- SRC-252 | https://shyft.to | P1 | n/a
- SRC-255 | https://thegraph.com | P1 | n/a
- SRC-256 | https://triton.one | P1 | n/a

### chain-execution (11)
- SRC-008 | https://anchor-lang.com | P1 | Study
- SRC-119 | https://github.com/jito-labs/jito-ts | P1 | Study (SDK for the future Solana execution leg: Jito bundle + tip-account + confirm-to-final-state loop, Geyser as a non-GMGN data stream; borrow the `Result<T,E>` + retry-with-backoff + token-refresh patterns for Memeland's gateway layer) / Skip (as a current core dependency - RH-chain primary venue, gRPC/auth-keypair weight, older web3.js pin). No near-duplicates noted.
- SRC-124 | https://github.com/krakenfx/kraken-cli | P1 | Adapt/Study — Adapt the event-sourced paper journal + replay-anchored honest scorecard and MCP-registry/research-LAB patterns in TS; Study the session/timeline and recording-frame design as reference architecture.
- SRC-173 | https://github.com/okx/agent-trade-kit | P1 | Adapt — port the MCP safety architecture (read-only/demo gates, capability snapshot, remediation-write veto, module filter, rate limiter, atomic safe-file) into Memeland; Skip the OKX-specific trading modules for chain portability.
- SRC-223 | https://github.com/vybenetwork/solana-top-holders-api | P1 | Adapt (concentration/entity-label risk calculus + axios-retry + disk-cache patterns — reimplement on top of cross-chain RPC; do not call Vybe per-token); Skip (the proprietary keyed Solana-only data source & demo dashboard as-is).
- SRC-224 | https://github.com/vybenetwork/solana-top-traders-api | P1 | Adapt (realized-PnL-ranked trader-following concept + axios-retry/cache).
- SRC-225 | https://github.com/vybenetwork/solana-trader-pnl-api | P1 | Adapt (per-wallet realized-PnL track-record + related-wallet/bundle discovery concepts — implement against public RPC across chains); Skip (the proprietary keyed Solana-only API & demo UI).
- SRC-227 | https://github.com/warp-id/solana-trading-bot | P1 | Adapt — port the TransactionExecutor-interface DI, veto-with-reason pool filters, and fail-closed TP/SL+timeout loop; Study its Slim-jito/warp tip-bundling fee flow for execution cost.
- SRC-230 | https://github.com/wwwwwwworld/solana-trading-bot-v3 | P1 | Adapt — treat as the maintained successor of SRC-227; port the executor-interface DI, veto filters, consecutive-match gate, fail-closed TP/SL timeout loop, and one-token serialization to Memeland's Solana leg. Note: near-duplicate of SRC-227 — do not double-count.
- SRC-253 | https://solana.com | P1 | Study
- SRC-254 | https://solanatracker.io | P1 | Adapt

### agents (7)
- SRC-049 | https://github.com/AI4Finance-Foundation/FinRobot | P1 | Skip — heavy LLM/equities research platform; no on-chain/memecoin edge, not chain-portable, high infra+API cost, and its LLM-orchestrates-deterministic-core philosophy is already better served by lighter sources in this audit.
- SRC-077 | https://github.com/danilobatson/ai-trading-agent-gemini | P1 | Study (LunarCrush social-metrics client/schema + the deterministic positive-indicator social BUY/SELL fallback as a possible secondary input to Memeland's retail-hype voter) / Skip (the platform - demo web app, no execution/risk, paid top-100 API).
- SRC-099 | https://github.com/ginlix-ai/LangAlpha | P1 | Study (the OHLCV `Coverage`/`gaps`/`revision`/`watermark` protocol model for Memeland's candle/replay data-integrity; PTC's process-data-in-code pattern for LLM voter context) / Skip (the platform - equities research harness, huge stack, no on-chain/execution edge).
- SRC-109 | https://github.com/HKUDS/Vibe-Trading | P1 | Study (fail-closed figure-grounding gate concept + backtest validation metrics/annualisation + deterministic margin/liquidation model as correctness reference) + Skip (adoption: heavyweight LLM research platform, not an on-chain memecoin spot/perpetual execution edge; not portable across chains).
- SRC-153 | https://github.com/mocasus/trade-agent | P1 | Adapt (port: RiskProfileInterface shape + confidence-scaled min/max sizing with reserve + daily-loss/max-position gates, fractional-Kelly with realized-trade parameters, activation-threshold trailing stop, rule-builder condition DSL, and paper-first/auto-stop/kill-switch/audit loop defaults) / Study (partial-exit ladder, plugin-registration interface) / Skip (the platform runtime, LLM strategy slot, ccxt/Bybit-futures execution, thin paper-exchange backtester).
- SRC-207 | https://github.com/TauricResearch/TradingAgents | P0 | n/a
- SRC-208 | https://github.com/The-Swarm-Corporation/AutoHedge | P0 | n/a

### robinhood (4)
- SRC-157 | https://github.com/muratmula/ai-robinhood-chain | P0 | n/a
- SRC-180 | https://github.com/pamgarcia1993/robinhood-lp-bot | P0 | n/a
- SRC-199 | https://github.com/sirenconemd/robinhood-trading-toolkit | P0 | n/a
- SRC-212 | https://github.com/Thorsten02041973/robinhood-cli | P0 | n/a
