# LI.FI Multi-Chain Execution Plan

Goal: make LI.FI/Jumper the **only execution layer** for every filled trade on every
configured chain. GMGN stays as the screener / market-data / security-audit source.
Relay is removed. Screening is already multi-chain
(`MULTICHAIN_CHAINS=sol,bsc,base,eth,robinhood`, payloads carry `network`); execution is
currently Robinhood-only.

## Facts verified against LI.FI

- `GET https://li.quest/v1/chains`: Ethereum `1`, BSC `56`, Base `8453`, Robinhood Chain `4663` (key `out`, native ETH), Solana supported via encoded chain id `1151111081099710`.
- The pasted SDK example uses Robinhood `91124`. That is wrong: Robinhood Chain is **4663**.
- `GET https://li.quest/v1/tokens?chains=4663` returns ETH, WETH, USDG (two listed
  addresses), and **no USDC on Robinhood Chain today**.
- USDC exists on Ethereum, BSC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`), Base
  (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) and Solana (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).

## Current code state

- `src/services/approval-execution.ts:57` only allows execution for `robinhood`; line
  `168` hardcodes `chainId: 4663` and `side: 'buy'`.
- The Q09 executor seam already exists
  (`executor.submit({ token, chainId, side, amountUsd, timeoutMs })` at
  `approval-execution.ts:44`), but it returns no quote/fill/simulation data.
- `src/adapters/evm-adapter.ts:40` maps only `robinhood: 4663` and silently defaults
  unknown chains to `4663` (fail-open bug).
- Relay is wired into `evm-adapter.ts`, `relay-adapter.ts`, Discord swap/send commands,
  `message-handler.ts`, and prompt/SOUL docs.
- `src/config/startup-validation.ts:50` requires `EVM_PRIVATE_KEY` for live mode but has
  no per-chain key requirement and no `LIFI_INTEGRATOR`.

## Phase 0 - Capability probe (no production code)

Create `scripts/lifi-capability-probe.ts` and run it with `tsx` (`npm run probe:lifi`).
For each chain (`eth`, `bsc`, `base`, `robinhood`, `sol`) it must print:

1. chain id + key + native coin from `/v1/chains`;
2. funding token candidates for that chain from `/v1/tokens`;
3. a real quote for `funding -> known meme token` (same-chain, then one cross-chain
   USDC-on-Ethereum to SOL-on-Solana);
4. a `build-transaction` result (or SDK route) proving we can get a signed payload:
   EVM `to/data/value` or Solana transaction.

Exit criteria: quotes + buildable transactions for all five chains. Robinhood is the
risk cell (USDG or ETH funding; no USDC). Solana routes through Jupiter/Mayan/CCTP and
needs a Solana signer.

Phase 0 also verifies the SDK packages from the pasted snippet
(`@lifi/sdk`, `@lifi/sdk-provider-ethereum`, `@lifi/sdk-provider-solana`,
`@solana/web3.js`). If the provider packages fight the current Node/viem versions, use
the LI.FI REST API with viem + `@solana/web3.js` as the production path; the SDK stays
optional.

## Phase 1 - Execution registry

Add `src/config/execution-registry.ts`:

- canonical chain keys (`eth`, `bsc`, `base`, `robinhood`, `sol`);
- LI.FI chain ids (EVM ids + Solana encoded id `1151111081099710`);
- native gas coin per chain (`ETH`, `BNB`, `SOL`);
- default funding token per chain (`USDC` where available, `USDG` on Robinhood);
- explorer URL template.

Make `EXECUTABLE_CHAINS` derive from the registry plus `MULTICHAIN_CHAINS`. Unknown
chains fail closed; remove the `|| 4663` default from `evm-adapter.ts`.

Add env knobs to `.env.example`:

```env
LIFI_INTEGRATOR=memeland
LIFI_REQUEST_SPACING_MS=300
LIFI_EXECUTION_TIMEOUT_MS=60000
EXECUTION_FUNDING_TOKEN_ETH=USDC
EXECUTION_FUNDING_TOKEN_BSC=USDC
EXECUTION_FUNDING_TOKEN_BASE=USDC
EXECUTION_FUNDING_TOKEN_ROBINHOOD=USDG
EXECUTION_FUNDING_TOKEN_SOL=USDC
SOLANA_PRIVATE_KEY=...
```

Extend `startup-validation.ts`: live auto-execution requires `LIFI_INTEGRATOR`,
`EVM_PRIVATE_KEY` when any EVM chain is executable, and `SOLANA_PRIVATE_KEY` when `sol`
is executable. Per-chain funding tokens are validated against the LI.FI token list
during startup (fail closed).

## Phase 2 - Lifi executor

Add `src/adapters/lifi-executor.ts` implementing the Q09 interface, widened to carry
the chain:

```ts
submit(req: {
  chain: string;              // canonical key, normalized
  token: string;              // target meme token address/mint
  side: 'buy' | 'sell';
  amountUsd: number;
  timeoutMs?: number;
});
```

Primary flow (REST, deterministic for a bot):

1. `POST /v1/quote` with `fromChain`, `toChain`, `fromToken` (funding), `toToken`
   (meme), `fromAmount`, `fromAddress`, `toAddress`, slippage, integrator;
2. `POST /v1/build-transaction` for the selected route;
3. sign + broadcast:
   - EVM: existing viem wallet path (`to`, `data`, `value`);
   - Solana: keypair from `SOLANA_PRIVATE_KEY` via `@solana/web3.js`, then
     `sendAndConfirmTransaction`;
4. poll `/v1/status` by `uuid`/txHash until `DONE`, `FAILED`, or timeout;
5. return `{ outcome: 'confirmed' | 'failed' | 'timed_out', txHash?, reason? }`.

Alternative: SDK `getRoutes` + `executeRoute` with the Ethereum/Solana providers from
the pasted snippet, chosen only if Phase 0 proves it handles both wallets and route
status cleanly.

Executor behavior:

- DRY_RUN fetches a real quote and returns `simulated`, never broadcasts;
- LI.FI handles approvals via its transaction payload; the existing sellability,
  honeypot, fill-sim, cost, and governance gates stay *before* `submit`;
- reuse the GMGN pacing pattern as a LiFi global request queue to avoid burst 429s;
- idempotency reuses the existing governance nonce: never broadcast the same nonce
  twice, and reconcile `timed_out` via `/v1/status` before retrying.

## Phase 3 - Wire execution

In `src/services/approval-execution.ts`:

- remove the hardcoded `chainId: 4663`, pass `chain` into the executor and let the
  registry map it;
- `EXECUTABLE_CHAINS` comes from the registry so a Base/BSC/ETH/Sol payload is not
  rejected;
- record `chain`/`side` in the trade journal and decision ledger (currently buys only).

In `src/index.ts`:

- route approval + auto-execute by `payload.network` (normalized), not only
  `channelName === 'call-meme-robinhood'`;
- inject `LifiExecutor` as `executor` on the `executeMemeBuy` call;
- gate per-chain auto-execute with the hub risk manager and keep the global kill switch.

In Discord handlers, replace `RelayAdapter` swap/send calls with `LifiExecutor` so
manual `/swap` and `/send` also go through LI.FI.

## Phase 4 - Strip Relay

- delete `src/adapters/relay-adapter.ts`;
- remove Relay quote/execute paths from `evm-adapter.ts` and its retry tests;
- remove Relay imports/calls in `command-handlers.ts`, `message-handler.ts`, `index.ts`;
- remove Relay references from prompts and `src/orchestrator/SOUL.md`;
- accept single-provider risk deliberately: unknown LI.FI chain/token => fail closed.

## Phase 5 - Tests and pilot

Unit tests (mocked fetch):

- registry maps `robinhood -> 4663`, `eth -> 1`, `bsc -> 56`, `base -> 8453`,
  `sol -> 1151111081099710`; unknown chain fails closed;
- executor returns `simulated` in DRY_RUN and never broadcasts;
- EVM path signs with viem; Solana path signs with keypair;
- same nonce never broadcasts twice; status polling resolves `timed_out`;
- `approval-execution` journals the correct chain and passes `chain` through.

Pilot order: dry-run quote test on all chains, then live Robinhood (existing surface),
then Base, BSC, Ethereum, and Solana last. Small notional per chain, kill switch armed,
one chain per release.

## Open decisions before implementation

1. Robinhood funding: USDG (native stablecoin listed by LI.FI) or ETH? USDC is not
   listed on Robinhood today.
2. Solana signing: separate `SOLANA_PRIVATE_KEY` keypair, or derive the Solana keypair
   and EVM key from one mnemonic? LI.FI cannot collapse Solana and EVM into one address;
   they are different key formats.
3. Execution transport: LI.FI REST (recommended, viem + `@solana/web3.js`) or the
   `@lifi/sdk` providers from the pasted snippet? Phase 0 decides.
4. If LI.FI fails on one chain, fail closed (recommended) versus a temporary fallback.
