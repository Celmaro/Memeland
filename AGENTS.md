# AGENTS.md — Opencatz AI (Multi-Chain Autonomous Memecoin Trading Bot)

## The one rule
Screening is math, not vibes: no trade reaches execution until the 7-voter swarm passes the
≥ 80% weighted consensus gate, the risk veto, and every fired signal ships a scorecard with
reasons. LLMs draft thesis cards and critiques — never the verdict itself.

## Current context (verified 2026-09-18)
- Multi-agent autonomous memecoin trading bot. TypeScript, Node ≥ 20, viem, discord.js.
  Entry: src/index.ts. Chain scope: sol / bsc / base / eth via ONE multi-chain meme agent
  (chain = runtime parameter in collectCandidates, not a per-chain agent class). Robinhood #4663
  retained as the existing EVM execution venue, not a screening target.
- Module removals complete: lp-robinhood (Krystal) and nft (OpenSea) domains REMOVED
  (adapters, agents, strategies, position-scanner, LP/NFT position state, and all
  Discord/Telegram/CLI/API/tool-registry wiring);
  alpha-robinhood redesigned as the Sentiment voter; whale-eth demoted to the Whale/Smart-Money
  exit monitor + macro risk-off feed (no standalone domain).

## Architecture: 7-voter swarm (Arch 3)
  1. Quant/Momentum   algo  — GMGN rank/trenches/hot + technical indicators
  2. ML Predictor     ML    — LSTM/GBM on GeckoTerminal/GMGN klines → P(up, 15m/1h) as 0–100 vote
  3. Security+Holder  algo  — GoPlus + GMGN audit + Blockscout top-10/dev concentration
  4. Alpha/Sentiment  LLM   — X/Reddit/on-chain social score (redesigned alpha; X optional, degrade)
  5. Whale/Smart-Money algo — GMGN smartmoney/kol accumulation + Hyperliquid risk-off;
                             smart-money exit on a HELD token ⇒ tighten SL in position manager
  6. Regime           algo  — market-regime + DeFiLlama chain TVL/DEX-volume context
  7. Critic           LLM   — adversarial pass: "what is wrong with this trade?"
- Gate: swarm-consensus ≥ 80% (weighted, never lowered) → risk-engine-v2 veto → position
  manager (TP/SL/trailing). swarm-learning recalibrates voter weights by realized outcome.

## Autonomy ladder (Arch 5) — never skip a phase
  Phase 1 SIGNAL_ONLY: score live, journal predicted-vs-actual for every fired signal.
  Phase 2 APPROVAL: orders queue to Discord/TG one-click approve; N > 50 approved fills.
  Phase 3 AUTO: only after positive expectancy in Phase 2; daily loss cap + kill-switch.

## Data stack (free tiers, raw fetch, zero new SDKs)
- GMGN OpenAPI — primary screen + wallet tags (smart money/KOL/rat/bundler: no free substitute).
- GeckoTerminal — independent discovery (new_pools/trending), OHLCV, quote fallback; 30/min budget.
- GoPlus — contract security; chain IDs mapped for base/eth/bsc/robinhood, add Solana.
- Blockscout — EVM holders (scale raw units by decimals), wallet activity, ABI, eth_call. Enrichment
  only: no meme-token quotes/OHLCV/honeypot. Use PRO API with free key; per-instance APIs deprecated.
- DeFiLlama — chain TVL, DEX-volume ranking, regime context. Cache 30–60 min; never per-token data.

## Non-negotiables
1. Fail-closed: unknown volume/liquidity/mcap/security ⇒ reject, never pass.
2. Execution modes DRY_RUN / SIGNAL_ONLY / APPROVAL / AUTO_EXECUTE; live trades only in
   AUTO_EXECUTE behind Phase-3 gates with verified keys.
3. Pacing + backup-key rotation on every provider: GMGN (429 ban extends +5s per retry — no
   retry spam; per-chain key pools GMGN_API_KEY_SOL...), GeckoTerminal 30/min, GoPlus batch,
   Blockscout credit budget, DeFiLlama ~300rpm fair use.
4. Chain-aware gates: renounced = Solana-only; honeypot = EVM-only; token_signal booster absent
   on base/eth — degrade silently, never fabricate.
5. Dedupe per chain by lowercase contract address, 60s cooldown.
6. Never commit .env; backups as *_BACKUP_KEYS; GMGN keys IPv4-only; Ed25519 only for trade routes.
7. Consensus floor ≥ 80% never lowers.

## Behavior norms
- Scan on 5–10 min cycles; enrich only post-prefilter candidates via batch endpoints.
- Proof over claims: every report names the live log signature it enabled and shows the funnel
  counter moved. fired=0 across deploys ⇒ diagnostic report, not another patch.
- Cheap deterministic math first; LLM calls reserved for sentiment, critic, thesis, post-mortem.
- TDD: every change keeps the regression floor green before commit.

## Key paths (6)
- src/adapters/gmgn-adapter.ts — widen Chain union (line 4); per-chain key pools
- src/agents/meme-robinhood/robinhood-screening-agent.ts — the single multi-chain meme agent (chain loop)
- src/agents/shared/gmgn-meme-helpers.ts — chain-agnostic prefilter/dedupe/signal logic
- src/orchestrator/swarm-consensus.ts (+ swarm-learning.ts) — the voter gate, never the floor
- src/orchestrator/risk-engine-v2.ts — kill-switch veto in the execution path
- src/services/goplus-security-service.ts + api-key-pool.ts — security layer + rotation pattern
