# Research: Shyft · Chainstack · dRPC · PublicNode — endpoints, rate limits, stack placement

Status: researched 2026-09-29 against current vendor docs; transport wiring + Sol
introducer repoint landed in the same change. Replaces the Helius SOL introducer
and Moralis (Moralis was never present in the repo — nothing to remove there).

All four are **raw RPC / WebSocket / gRPC infrastructure** (transport). None is
a discovery/emitter/enricher indexer API — so they slot into the **transport
layer**: the per-chain RPC failover pool (`rpc-failover.ts`) and the WS/gRPC
tape housing. The only *role* they take beyond transport is the **Sol canonical
introducer**, via a thin on-chain SPL-create walker (`solana-rpc-discovery-feed`)
that speaks standard Solana JSON-RPC over the failover manager's active Sol RPC.

---

## 1. Shyft — Solana RPC + WS
- RPC `https://rpc.shyft.to?api_key=<KEY>`
- WS  `wss://rpc.shyft.to?api_key=<KEY>`
- **Free tier**: unlimited credits at **10 RPC requests/sec**; API calls cap at
  ~1 req/sec (screener-grade burst is fine on RPC).
- Role: **Sol transport** (primary `SOLANA_RPC_URL` candidate). Standard
  Solana JSON-RPC → hosts the SPL-create walker introducer. WS can host a realtime
  Sol tape.

## 2. Chainstack — Solana RPC + WS
- RPC `https://solana-mainnet.core.chainstack.com/<token>`
- WS  `wss://solana-mainnet.core.chainstack.com/<token>`
- **Limits**: Developer plan ≈ **5 RPS**; Growth ≈ 50 RPS; shared free tier is
  request-limited/day. Credit-based (625 CU/s Dev).
- Role: **Sol transport** (failover). Standard JSON-RPC → Sol introducer walk
  + WS tape.

## 3. dRPC — multi-chain RPC + WS (pay-as-you-go, CU-based)
- Free tier: **210M Compute Units / 30 days**, dynamic **~2,100 CU/sec**,
  ~5 API keys. All methods = **20 CU flat** (~$0.30/1M CU), so free ≈
  **~10.5M method calls/mo**, burst ~105 req/sec.
- Endpoints (user keyed, `https://lb.drpc.live/<chain>/<key>` + WS):
  - `ethereum` (eth), `bsc`, `robinhood` (RH), and a **`lambda` wallet-data** RPC (Sol wallet reads).
- Role: **EVM/RH transport** (eth/bsc/robinhood failover) + **Sol wallet-data
  transport** (`lambda` endpoint → wallet/holdings reads). WS variants are tape housing.

## 4. PublicNode — free public RPC + WS (+ Yellowstone gRPC)
- No API key; fair-use. Official Solana public ceiling is ~100 req/10s/IP (40
  for a single RPC); EVM chains are generous.
- Endpoints: `solana-rpc.publicnode.com`, `ethereum-rpc.publicnode.com`,
  `bsc-rpc.publicnode.com`, `base-rpc.publicnode.com`,
  `robinhood-rpc.publicnode.com` (each + WS), plus Yellowstone gRPC
  (`solana-yellowstone-grpc.publicnode.com:443`, `ethereum-rpc…`) for high-throughput tape.
- Role: **default EVM/Sol/RH transport** (already the free failover defaults in
  `rpc-failover.ts`); gRPC = future high-throughput Yellowstone tape.

---

## Placement in the four-role stack
| Provider | Role | How it lands |
| --- | --- | --- |
| Shyft (Sol RPC/WS) | **transport** (+ Sol introducer via walker) | `SOLANA_RPC_URL` + Sol failover pool; WS tape |
| Chainstack (Sol RPC/WS) | **transport** | Sol failover pool; WS tape |
| dRPC (eth/bsc/rh + lambda) | **transport** | EVM/RH failover; lambda → Sol wallet-data RPC |
| PublicNode (all chains + gRPC) | **transport** | EVM/RH/Sol failover defaults; gRPC tape (future) |

Introducer note: the **Sol canonical introducer** is no longer Helius. It is now
`solana-rpc-discovery-feed` — a bounded, fail-soft SPL-create walker
(`getSignaturesForAddress` on the pump.fun program + `getTransaction` decode)
running over the failover manager's active Sol RPC (Shyft → Chainstack →
PublicNode sol). This is the "appropriate place" for the new Sol RPCs: they are
the transport housing the on-chain introducer. PumpDev remains the Sol
pre-graduation fresh-lane introducer; SolanaTracker remains the Sol enricher.

Rate-limit note: raw RPC hosts are protected by `globalRateLimiter` (429 circuit
breaker + backoff) in the failover manager, and the walker's per-cycle signature
budget caps worst-case spend — so the generous free tiers above are never burned.

---

## 5. Blockscout — explorer REST / PRO API (verify + convergence layer)
- Per-chain REST `/api/v2`: `eth.blockscout.com`, `bsc.blockscout.com`,
  `base.blockscout.com`, `robinhoodchain.blockscout.com`
  (used for token-transfers → BuyEvent[]).
- **PRO API** `https://api.blockscout.com/v2/api?chain_id=<id>&…&apikey=proapi_…`
  (Etherscan-compatible: `module=account&action=balance`, `module=token`, etc.).
- **Rate limits**: free **100K credits/day @ 5 RPS** across all chains; $49/mo →
  100M credits @ 15 RPS; $199/mo → 500M @ 30 RPS. Key sent as `apikey` query param
  (also works as `Authorization: Bearer` / `proapi` header on per-chain REST).
- Role: **verify** (+ I0-1 convergence BuyEvent hydration). Key raises the
  per-chain `/api/v2` cap; wire as `BLOCKSCOUT_API_KEY` (never a discovery source).

## 6. Routescan — multi-chain explorer API (discovery + enricher)
- Base `https://api.routescan.io/v2/network/mainnet/evm/{chainId}/…`
  (also `/…/network/{network}/evm/{chainId}/…`; already the `ROUTESCAN_DEFAULT_BASE`).
- Endpoints: `/erc20?sort=createdAt,desc` (new-token discovery),
  `/erc20/{address}/holders`, `/erc20-transfers?tokenAddress=…`.
- **Rate limits** (per plan, caps on req/s AND calls/day):
  - Free **Keyless**: **2 req/s · 10,000 calls/day** (all endpoints).
  - Free **Registered** key: **5 req/s · 100,000 calls/day** (10× daily) — send
    key in `apikey` header.
  - Paid: 10/20/30 req/s · 200k/500k/1M calls/day ($160/$240/$320/mo).
- Role: **enricher / discovery** (createdAt-ordered fresh lane + ranked holders).
  Base already correct; optional `ROUTESCAN_API_KEY` unlocks the registered tier.

---

## 7. Infura — managed RPC (eth/base/bsc/sol) — transport
- Endpoints (`https://{chain}-mainnet.infura.io/v3/<KEY>` or `mainnet.infura.io`):
  - eth `https://mainnet.infura.io/v3/<KEY>`
  - base `https://base-mainnet.infura.io/v3/<KEY>`
  - bsc `https://bsc-mainnet.infura.io/v3/<KEY>`
  - sol `https://solana-mainnet.infura.io/v3/<KEY>`
- **Rate limits**: Core (free) ~**3M credits/day @ 2,000 credits/sec** (≈37K
  standard requests/day @ 80 cr/eth_call; some docs list a 100K req/day free cap).
  Developer 15M cr/day; credit-based, so RPS depends on method cost.
- Role: **EVM + Sol transport** (failover pool). Keyed via `EVM_*_RPC_URL` /
  `SOLANA_RPC_URL` or `RPC_FAILOVER_URLS`.

## 8. ZAN — managed RPC + WS (eth/sol/bsc/base/rh) — transport
- Endpoints (`https://api.zan.top/node/v1/{chain}/mainnet/<KEY>` + WS):
  - eth/sol/bsc/base/robinhood HTTP + `wss://api.zan.top/node/ws/v1/{chain}/mainnet/<KEY>`
- **Rate limits**: free **150M credits / 30 days** across 28+ chains; credit-based
  RPS. Notably covers **Robinhood** (only RH-capable managed provider besides the
  official chain RPC), and has Sol WS.
- Role: **EVM/Sol/RH transport** (failover pool) + **WS tape housing** (eth/sol WS).

## 9. Pocket Network — free public RPC (eth/sol/base/bsc) — transport
- Endpoints (no key): `eth.api.pocket.network`, `solana.api.pocket.network`,
  `base.api.pocket.network`, `bsc.api.pocket.network` (60+ chains).
- **Rate limits**: no key, **lightly rate-limited** (no published hard RPS; fair-use).
- Role: **free keyless transport** — added to the per-chain **code defaults** in
  `rpc-failover.ts` (no key → safe in source; already a Sol default).

## 10. OnFinality — managed RPC + WS (eth/sol/bsc/base) — transport
- Endpoints (`https://{chain}.api.onfinality.io/rpc?apikey=<KEY>` + WS):
  - base `https://base.api.onfinality.io/rpc?apikey=<KEY>`
  - bsc `https://bnb.api.onfinality.io/rpc?apikey=<KEY>`
  - eth `https://eth.api.onfinality.io/rpc?apikey=<KEY>`
  - sol `https://solana.api.onfinality.io/rpc?apikey=<KEY>`
- **Rate limits**: free ~**500K responses/day**; public rate limit ~**3,000 response
  units/min/IP** (HTTP); free plan unlocks ~40 req/s per endpoint.
- Role: **EVM/Sol transport** (failover pool) + **WS tape housing**.

---

## Failover delivery (dRPC / Chainstack + the new keyed hosts)
The keyed endpoints (Infura, ZAN, Onfinality, Chainstack, **dRPC**) are **not**
hardcoded — they ride `RPC_FAILOVER_URLS` (env JSON). The CLI `-k` flag genuinely
cannot carry embedded quotes/commas (confirmed by a parse error), so multi-URL JSON
is delivered **base64** (`base64:` prefix, decoded by `rpc-failover.ts` — base64 has
no quotes/commas/`&`). `RPC_FAILOVER_URLS` now holds:
- **sol**: Infura · ZAN · OnFinality · Chainstack (Shyft stays the `SOLANA_RPC_URL`
  primary; dRPC sol is paid/lambda-only so it stays out of the full-node pool)
- **eth/bsc/base**: Infura · ZAN · OnFinality · **dRPC**
- **rh**: ZAN · **dRPC** (dRPC key `AiQT-EarAERphtg2mtapAFrzQtDVu3oR8YVhjmVXwXgc`)

## 11. JSON-RPC WS tape housing (ZAN + OnFinality WS)
`src/adapters/jsonrpc-ws-tape.ts` — a generic, fail-soft JSON-RPC-over-WS realtime
tape (mirrors `PumpDevTape`'s socket model: exponential-backoff reconnect, bounded
ring buffer, injectable socket). Reads `JSONRPC_WS_TAPES` (env base64/JSON map of
`chain -> [wsUrl]`), one tape per host. Subscription model:
- **EVM** (eth/bsc/base/rh): `eth_subscribe` `newHeads` → fresh-block tape.
- **Sol**: `programSubscribe` (pump.fun `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
  → surfaces the written account pubkey = new token mint (pre-graduation introducer
  tape over raw Sol WS, key-free).
- Wired hosts: ZAN WS (eth/bsc/base/rh/sol) + OnFinality WS (eth/bsc/base/sol).
- Gated by `JSONRPC_WS_TAPE_ENABLED` + `JSONRPC_WS_TAPES`; banner id `jsonrpc-ws-tape`.



## 12. Strategic move — own-RPC/own-tape first (P0 slice)

Implementing the "discovery/corroboration/verify on the bot's own RPC/tape;
downgrade third-party indexers to best-effort" directive.

- **WS-tape → discovery**: `robinhood-screening-agent.collectJsonRpcWsTapeCandidates`
  drains the injected Sol `JsonRpcWsTape.recentEvents()` (pump.fun `programSubscribe`
  mints) as a pre-graduation introducer — same signal PumpDev streams, key-free over
  raw Sol WS. Guarded by `JSONRPC_WS_TAPE_ENABLED` + `DISCOVERY_INTRODUCERS`.
  Injected via `injectJsonRpcWsTapes(...)` after startup (tapes are wired after the
  agent construct). Merged into the candidate funnel under source `solana-rpc`.

- **RPC verify cross-check**: `src/services/onchain/rpc-verify.ts` — a second,
  independent on-chain confirmation via `eth_getTransactionReceipt` on the active
  failover RPC (complements Blockscout`s `verify` role). Pure transport, fail-soft
  (transport/parse error -> null -> "unconfirmed", never a false confirmation).
  This is the primitive the VerifyCoordinator consumes.

## 13. P0 — time-current trader persistence

`trader-persistence.ts` observations now carry `fetchedAt` (stamped by the FOMO
leaderboard collector with `provider: 'fomo'` + `rank`). `persistentTraders()`
applies a per-window freshness budget (24h~6h, 7d~1d, 30d~3d) so a stale window
decays out of "current" presence: a trader historically in 24h but not on the
current board no longer counts as persistent — fixing the accumulate-forever bug.
`lastSeenAt` exposed on PersistentTrader.

## 14. Phase 2 — VerifyCoordinator + best-effort demotion (enrichment)

- **Two-source verify**: Blockscout token-transfer `hash`/`blockNumber` are now
  carried on `BuyEvent.txHash`/`blockNumber`. On convergence hydration the agent
  runs an independent on-chain confirmation — `rpcVerifyCrossCheck` →
  `eth_getTransactionReceipt` over the failover pool (`src/services/onchain/rpc-verify.ts`).
  Explorer-indexed view + raw-chain view = two independent confirmations; RPC
  disagreement/absence degrades to "unconfirmed", never a false pass.
- **Best-effort demotion**: `src/services/source-quota.ts` classifies HTTP
  failures (400/402/429 → quota, 5xx/network → transient) and puts a source in a
  cooldown window; the collector short-circuits and logs only the first hit, so a
  third-party indexer outage (GMGN/Paprika/Gecko/Routescan/CMC/SolTracker) is
  non-blocking and log-quiet. Applied in `collectProviderCandidates`.
