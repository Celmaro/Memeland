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

