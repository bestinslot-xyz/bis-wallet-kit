# `@bestinslot/wallet-kit-mcp` — Design

Date: 2026-09-11
Status: Design — approved decisions, not yet implemented.

## Goal

Let an AI agent drive a Bitcoin wallet through the full workflow:

1. Ask the agent to create a wallet and return an **address** to fund.
2. The human funds that address.
3. Ask the agent about coin prices (current + historical) and execute swaps.

The agent talks to an **MCP server** that wraps the existing
`@bestinslot/wallet-kit` node build. The server is the tool surface; the SDK is
unchanged (see "SDK impact").

## Guiding principle: separation of intelligence from custody

The dominant pattern in production agent-wallet systems (Coinbase Agentic
Wallets / CDP Server Wallets v2, Cobo, Vultisig, Fystack) is that **the model
never sees the private key or raw transaction bytes.** The agent expresses
*intent*; a server-side boundary holds the key, enforces a policy, and signs.

bis-wallet-kit's local provider is a single in-process WIF signer — self-hosted
self-custody rather than MPC/TEE — which is a legitimate variant of the same
idea, provided the key stays behind the server boundary. The critical rule this
imposes:

> The SDK's `createWallet()` returning a WIF to its caller is correct (it is a
> library function called by trusted code). The MCP layer must **never** forward
> that WIF through a tool result, log, or error — doing so would put the private
> key into the model's context and transcript.

## Architecture

- **Packaging:** a new workspace package `@bestinslot/wallet-kit-mcp` in this
  repo's pnpm workspace (alongside `examples/`), depending on the published
  `@bestinslot/wallet-kit`. Launched via `npx @bestinslot/wallet-kit-mcp`.
- **Transport:** stdio MCP server (the shape MCP clients like Claude, Codex,
  Gemini expect from an `npx` launch).
- **One shared server, one wallet.** All agent sessions talk to the same server
  process and the same single wallet. The server knows its own balances,
  address, and network. No agent ever receives the key. Per-session / multi-key
  wallets are explicitly out of scope (see "Future").
- **The server is the custody boundary.** It loads/holds the key, applies the
  policy (write gating + optional spend caps), and calls the SDK to sign and
  broadcast.

## Key lifecycle

- The server obtains its key from **env (`BIS_WALLET_WIF`)** or a **keystore
  file** at a configured path (`BIS_WALLET_KEYSTORE`). The human wires this out
  of band.
- **`create_wallet`** generates the key *server-side*, connects it via the SDK's
  node provider, writes the WIF to the configured keystore path (and/or the
  server's stderr) — **never** the tool response — and **returns only the
  address** (plus network and address type) to the agent.
- The agent hands the address to the human to fund. Funding status is observed
  through `get_balances`.
- On restart, the server restores the same wallet from env/keystore. No key
  material ever crosses the MCP boundary to the agent.

## Fee rates and fiat price (mempool.space, at the MCP layer only)

The SDK stays **oracle-free** — no new dependency, no network coupling in the
library. The MCP server (already a network-capable app) owns the mempool.space
dependency.

- **Fee rates:** `GET {mempool}/api/v1/fees/recommended` →
  `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` (sat/vB).
  - Exposed to the agent as an `estimate_fee` read tool.
  - Write tools take `feeRate` as **optional**; when omitted the server fills in
    a recommendation (default `halfHourFee`).
- **Fiat price:** `GET {mempool}/api/v1/prices` → `{ USD, EUR, … }`. The server
  fetches the BTC/USD rate and passes it into the SDK's existing
  `satsToUsd(sats, btcUsd)` to present balances/quotes/prices in USD. (The SDK's
  oracle-free `satsToUsd` is designed exactly for a caller-supplied rate.)
- **Per-network base URL:** endpoints differ by network — mainnet
  `mempool.space/api`, testnet `mempool.space/testnet/api`, signet
  `mempool.space/signet/api`. The server maps by the wallet's network and allows
  an override via `MEMPOOL_API_URL` (self-hosted instances; test stubbing).
- **Failure handling:** if mempool is unreachable and the agent did not supply a
  `feeRate`, the write tool **fails clearly** — no silent fallback to a
  hardcoded rate (consistent with the "no false success" rule applied to
  broadcast in the SDK).

## Write gating (env flag + preview/confirm)

Read tools are always registered. Fund-moving tools are gated two ways:

1. **Registration flag.** Write tools are registered only when
   `BIS_WALLET_ALLOW_WRITES=true`. An agent cannot call a tool that is not
   registered.
2. **Preview / confirm.** Each write tool runs in two steps:
   - First call returns a **preview** (amount, destination, quote, miner fee,
     price impact where applicable) plus a **single-use, short-TTL confirm
     token bound to those exact parameters**.
   - Execution requires a second call echoing that token. Because multiple
     agents share one wallet, the token is bound to the calling session and
     expires quickly to prevent replay/races. A token whose parameters no longer
     match (or that has expired / been used) is rejected.
3. **Optional spend caps** (recommended, from precedent): server-side limits —
   `BIS_WALLET_MAX_SATS_PER_TX` and a per-session running total — rejected
   before preview.

## Tool surface (first cut)

### Read tools (always registered)

| Tool | Wraps | Returns |
| --- | --- | --- |
| `get_address` | session ordinals/payment address | address, network, type |
| `get_balances` | `getAllBalanceDetails`, swap balances | confirmed/mempool sats, token balances, USD via mempool price |
| `list_pairs` | `swap.listPairs` | pairs with price, 24h/7d change, volume, TVL |
| `get_klines` | `swap.getKlines` | historical OHLC candles |
| `get_swap_quote` | `getSwapExactInputResult` / `…OutputResult` | quoted price, price impact, miner fee |
| `get_reserves` | `getPairReserves` | pool reserves |
| `estimate_fee` | mempool `fees/recommended` | sat/vB tiers |

### Write tools (registered only with `BIS_WALLET_ALLOW_WRITES=true`, preview+confirm)

| Tool | Wraps |
| --- | --- |
| `create_wallet` | `createWallet` — returns address only |
| `send_btc` | local provider `sendBTC(amountSats, toAddress, feeRate?)` |
| `swap_exact_input` / `swap_exact_output` | `swap.swapExactInput` / `…Output` |
| `deposit` / `wrap_btc` | `swap.deposit` / `swap.wrapBtc` |
| `withdraw` / `unwrap_btc` | `swap.withdraw` / `swap.unwrapBtc` |

`create_wallet` is a write-class tool because it mutates server wallet state and
writes key material; it never returns the WIF.

## Security model

- **Key confidentiality:** WIF is loaded from env/keystore, held server-side,
  and never returned through any tool result, log line visible to the agent, or
  error message. `create_wallet` returns address only.
- **Blast-radius control:** writes disabled by default; preview/confirm prevents
  a single hallucinated tool call from moving funds; optional spend caps bound
  the worst case.
- **Multi-agent safety:** confirm tokens are session-bound, parameter-bound,
  single-use, and short-lived.
- **No false success:** broadcast / fee / price failures surface as errors,
  never silent fallbacks.

## SDK impact

**None required.** Everything maps to existing SDK functions on the node build
(`createWallet`, `sendBTC`, the `swap`/`balances` namespaces, `satsToUsd`). The
fee/price oracle lives entirely in the MCP package. `satsToUsd`'s oracle-free
signature is what makes fiat display trivial without touching the SDK.

Optional (not required for v1): an `estimate_fee`-style helper could later live
in the SDK, but keeping it in the MCP layer preserves the SDK's oracle-free
property, so v1 keeps it in the server.

## Configuration (env)

| Var | Purpose |
| --- | --- |
| `BIS_WALLET_WIF` | Private key (WIF) to load on start (mutually exclusive-ish with keystore) |
| `BIS_WALLET_KEYSTORE` | Path to a keystore file the server reads/writes |
| `BIS_NETWORK` | mainnet / testnet / signet |
| `BIS_WALLET_ALLOW_WRITES` | Register fund-moving tools when `true` |
| `BIS_WALLET_MAX_SATS_PER_TX` | Optional per-tx spend cap |
| `MEMPOOL_API_URL` | Override mempool.space base URL (self-hosted / testing) |

## Testing approach

- Unit-test the server tools against a mocked SDK + stubbed `fetch` (mempool and
  backend), asserting: `create_wallet` never returns key material; write tools
  are absent without the flag; preview returns a token and execution requires a
  matching, unexpired, single-use token; spend caps reject over-limit previews;
  fee/price omission + mempool failure produce a clear error.
- Reuse the SDK's own tested paths for build/sign/broadcast (already covered in
  the SDK's unit suite) rather than re-testing them here.

## Out of scope / future

- Per-session or multi-key wallets (server managing many keys mapped to
  sessions).
- MPC / TEE / enclave signing (the precedent's production posture); the local
  WIF signer is the v1 custody model.
- HD wallets / mnemonic backup (the SDK is single-key by design).
- Automated funding; the human funds the returned address.

## Open questions

- Keystore file format and at-rest protection (plaintext WIF vs. passphrase
  encryption). Default proposal: passphrase-encrypted via `BIS_WALLET_PASSPHRASE`
  when a keystore path is used; refine during implementation.
