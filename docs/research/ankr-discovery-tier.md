# Ankr RPC — self-hosted discovery tier (research, 2026-09-23)

Status: **research** — design + costs + integration seam. No code change in this
pass (the keyless REST feeds landed first; RPC discovery is the second wave).

Audit context: Memeland's discovery tier went keyless-first (DEXPaprika +
GeckoTerminal + DexScreener, see `docs/feed-comparison.md`). The final piece of
the self-hosted tier is reading chain state directly — new pair creation
(`PairCreated` logs), pool reserves, and the Quoter round-trip — without any
market-data API. Ankr is the transport that makes that free-tier feasible.

## 1. What Ankr is (from ankr.com/docs)

- **Chain RPC API** — standard JSON-RPC for 80+ networks (Ethereum, Solana, BNB,
  Arbitrum, Base, Bitcoin, TRON, TON, Sui, ...). One endpoint family
  (`rpc.ankr.com/{chain}/{key}`), one key, the key is part of the URL path.
- **Advanced API** — enriched multichannel reads (NFTs, token balances/prices,
  transaction history, logs) over `rpc.ankr.com/multichain/{key}`. These are
  indexer-backed answers, not raw RPC.
- **Demo key** — every interactive panel ships a shared, rate-limited demo key;
  requests work out of the box before signup.
- **Chains we care about**: Ethereum (`rpc.ankr.com/eth`), BNB
  (`rpc.ankr.com/bsc`), Base (`rpc.ankr.com/base`), Arbitrum (`rpc.ankr.com/arbitrum`),
  Solana (`rpc.ankr.com/solana`), plus Robinhood Chain if Ankr serves it (4663 is
  an exotic EVM; verify at ankr.com/docs → chains list).

## 2. Cost math (pricing page, 2026-09-23)

| API | Method | Credits/req | USD/req |
|---|---|---|---|
| EVM-compatible (all methods) | any | 200 | **$0.00002** |
| Solana (all methods) | any | 500 | $0.00005 |
| Advanced API (all methods) | any | 700 | $0.00007 |

- PAYG: 0.10 USD = 1,000,000 API credits → **EVM eth_call/eth_getLogs ≈
  $0.00002 each**.
- Budget projection for a 5-min discovery loop:
  - 5 chains × ~40 RPC reads/pass ≈ 200 reads/pass.
  - 288 passes/day ≈ 57,600 reads/day ≈ $1.15/day ≈ **$35/mo** at full cadence.
  - With the TTL cache + quota guard (only refresh pairs that changed), real
    usage drops to ~10k reads/day ≈ **$6/mo**. Free tier later if Ankr has one
    (demo key is rate-limited, not quota-less).
- WSS tier exists (subscription + notification credits) — viable for a
  real-time `PairCreated` listener later, but the batch REST loop is cheaper to
  start.

## 3. What Ankr buys the discovery tier

### 3a. `eth_getLogs` — new-pair discovery (the missing keyless feed)

The strongest gap in the current keyless tier is **freshness**:

- DEXPaprika `pools/search` — best-effort, indexer latency (minutes).
- GeckoTerminal `new_pools` — indexer latency, 30/min budget.
- DexScreener `token-profiles` — no RH chain, profile-latency.

Directly watching the DEX factory emits pairs the moment they exist:

```text
PairCreated(address indexed token0, address indexed token1,
            address pair, uint256)  // topic0 = 0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9
```

Uniswap-V2-style factories per chain (example addresses to verify at deploy):

| Chain | Factory | Notes |
|---|---|---|
| Ethereum | 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f | Uniswap V2 |
| Base | 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6 | Uniswap V2 on Base |
| BSC | 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73 | PancakeSwap V2 |

`eth_getLogs({ fromBlock: 'latest'-K, address: factory, topics: [PairCreatedSig] })`
→ decode token0/token1/pair → **new-pool candidates before any indexer**. The
`EvmAdapter` in this repo already has `getLogs` (Kernel E, two-lane RPC).

### 3b. `eth_call` — pool reserve / Quoter reads (pool-state enrichment)

- Quoter `quoteExactInputSingle` (already built in `execution-gates.ts` /
  `quoter-call-adapter.ts`) → real sellability proof.
- Pool `getReserves()` / slot0 reads → depth, sqrtPrice, liquidity curve
  (the Gemini-audit "liquidity as a curve" ask).
- `eth_call` on Ankr's demo/paid key replaces the current
  `EVM_ROBINHOOD_RPC_URL` single-host dependency (RABIQ failover already
  supports multiple hosts — add Ankr as a weighted peer).

### 3c. The one seam: `EvmAdapter` gains Ankr as a host

No new adapter class needed. `EvmAdapter` already does weighted failover +
cooldown + lanes (Kernel E). Add Ankr URLs to the hosts list per chain:

```ts
new EvmAdapter({
  hosts: [
    { url: 'https://rpc.ankr.com/eth', rotationWeight: 1 },
    { url: process.env.EVM_ETH_RPC_URL!, rotationWeight: 2 },
  ],
})
```

This is the RABIQ (A8) pattern the research flagged: two-lane throttle + portable
failover, now pointed at a keyed-but-cheap RPC instead of a free-tier single host.

## 4. Design: `src/adapters/ankr-discovery-feed.ts` (next wave)

Contract: `MarketDataProvider` (same as Gecko/DEXPaprika/DexScreener), so it
drops into `collectProviderCandidates` unchanged.

```ts
class AnkrDiscoveryFeed implements MarketDataProvider {
  // fetch: PairCreated logs per factory (eth_getLogs, fromBlock: latest-K)
  // normalize: token0/token1/pair -> MarketToken { address: token0, chainId, pairAddress: pair }
  //        price/liquidity/volume stay 0 here — prefilter enrichment fills them
  //        (GMGN audit is the enrichment layer; this feed is discovery-only)
  // cache: TtlCache, ttlMs default 60s
  // fail-open: RPC error -> empty, warn once per circuit window
}
```

The `PairCreated` log gives addresses only — no volume/liquidity. That matches
the keyless-first split: **discovery = "these pairs just appeared"**, and the
existing prefilter (min liquidity/volume) + GMGN audit is the enrichment. The
volume/liquidity gates will filter most new pairs; the ones that pass are
literally brand-new DEX entries — exactly the meme-token alpha window.

## 5. Move order (after this pass)

1. Verify Ankr serves Robinhood Chain 4663 (chains list; if absent, this feed
   covers eth/bsc/base and RH keeps Gecko/DEXPaprika).
2. Add Ankr hosts to `EvmAdapter` construction (weighted; keep the existing
   native RPC as the primary peer).
3. Implement `ankr-discovery-feed.ts` + tests (fixture-based `eth_getLogs`
   response, matching the existing adapter test style).
4. Wire `GECKO_FEED_ENABLED`-style env gate (`ANKR_FEED_ENABLED`), add to
   `.env.example`, and to the keyless-first merge order (before GMGN).

## 6. Constraints / non-negotiables

- Key stays in the URL path (Ankr's documented model); that's fine for an app
  secret in env, but never commit it (same rule as GMGN keys).
- Free/demo tier is rate-limited — the TTL cache + pacing in the feed must hold
  or the discovery loop 429s. Start with the paid PAYG ($0.00002/read) at low
  cadence; it is cheaper than a single GMGN 429 ban.
- RPC discovery is EVM-only (eth/bsc/base). **Solana/RH use the REST tier**
  (Gecko/DEXPaprika) — don't block discovery on RPC for chains without factories.
- `eth_getLogs` on a huge `fromBlock` window is expensive; always scan a small
  rolling window (e.g. latest ~200 blocks) and rely on the TTL cache + the
  fact that new pairs are rare per block.

## 7. Verdict

Ankr is the right transport for the third discovery leg: keyless-ish (demo key
works immediately), cheap ($35/mo full blast, ~$6/mo realistic), and it plugs
into the existing `EvmAdapter` Kernel E with zero new abstraction. The gap it
closes — **fresh pair discovery before indexers** — is the one the current
Gecko/DEXPaprika keyless tier cannot cover (both have indexer latency).
Revisit after this pass: RH 4663 support check, then the adapter + tests.