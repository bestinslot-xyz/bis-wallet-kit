# Swap

The `swap` namespace wraps the Best in Slot swap/AMM: a dedicated swap wallet, liquidity, swaps,
withdrawals, quotes, and market data. Amounts are `bigint` in the token's base units.

## Swap wallet and status

```ts
import { bitcoinjs, swap, wallet } from '@bestinslot/wallet-kit'

const swapWallet = await swap.createSwapWallet() // generate + store the swap wallet
const status = await swap.getSwapStatus() // { reorg_handler_running, emergency_stop, … }
```

## Balances and pricing

```ts
const balances = await swap.getSwapBalances(ordinalsAddress) // SwapBalance[]; price_sats may be null
const one = await swap.getSwapBalance(tokenAddress) // bigint
const decimals = await swap.getTokenDecimals(tokenAddress) // number
const reserves = await swap.getPairReserves(pairAddress) // PairReserves
const pair = swap.getPairAddress(tokenA, tokenB) // deterministic, order-independent
const fee = await swap.getMinerFee('swap') // bigint (per order type)
```

## Trade

There are two swap directions, mirroring Uniswap's two router modes:

| Function          | Mode         | You fix                    | Bounded by              |
| ----------------- | ------------ | -------------------------- | ----------------------- |
| `swapExactInput`  | exact input  | the amount you **spend**   | minimum amount received |
| `swapExactOutput` | exact output | the amount you **receive** | maximum amount spent    |

```ts
// Exact input: spend exactly amountIn, receive at least amountOutMin.
await swap.swapExactInput(
  tokenInAddress,
  tokenOutAddress,
  amountIn, // bigint — exact amount spent
  amountOutMin, // bigint — expected/quoted output; slippage is applied to derive the enforced minimum
  slippageBPS // bigint, basis points
)

// Exact output: receive exactly amountOut, spend at most the quoted input + slippage.
await swap.swapExactOutput(
  tokenInAddress,
  tokenOutAddress,
  amountIn, // bigint — expected/quoted input (slippage applied to derive the max spent)
  amountOut, // bigint — exact amount received
  slippageBPS
)
```

Quote before sending with `getSwapExactInputResult` (for `swapExactInput`) and
`getSwapExactOutputResult` (for `swapExactOutput`).

Any two tokens with a pool between them can be swapped, including token/token pairs with no WBTC
side (e.g. `ORDI` → `NUTKIN`). Only direct pools are used, there is no routing through WBTC, so
swaps and quotes fail fast with a clear `No swap pool with liquidity for …` error when the two
tokens have no pool of their own, rather than failing deeper in the swap math. The miner fee is
always debited in WBTC, so a token/token trader still needs a little WBTC in the smart wallet.

The quotes' `quoted_price` is sats per whole token when either side is WBTC. For a token/token swap
it is the output token's **base units** per whole input token (not scaled by the output's decimals:
1 XYZ in for 2 ABC out, both 18 decimals, quotes `2e18`).

## Quote fees

Both quote functions return a `fees` breakdown (`SwapFees`) alongside the amount, so a UI can show
the real cost instead of assuming a flat rate:

```ts
const quote = await swap.getSwapExactInputResult(tokenInAddress, tokenOutAddress, amountIn)
quote.fees
// {
//   pool_fee_bps: 30n,       // constant-product pool fee
//   token_in_fee_bps: 0n,    // protocol fee on the input leg
//   token_in_fee: 0n,        //   ↳ in input-token units
//   token_out_fee_bps: 25n,  // protocol fee on the output leg
//   token_out_fee: 2490n,    //   ↳ in output-token units
//   miner_fee_sats: 330n,    // flat miner fee, in WBTC sats
// }
```

**Only `pool_fee_bps` is already reflected in the quoted amount.** The pool takes it on the way
through, so `amount_out` is net of it — don't subtract it again. The other three are charged _on
top_ of the quoted amounts:

```ts
// What the swap really costs and really pays out:
const totalIn = amountIn + quote.fees.token_in_fee
const totalOut = quote.amount_out - quote.fees.token_out_fee
// plus quote.fees.miner_fee_sats, debited in WBTC regardless of which leg it's on
```

The protocol fee's rate and placement are set by the swap backend, which serves them as `fee_policy`
from `getSwapInfo()`; the kit reads them from there and hard-codes neither:

- If either side is a priority token (WBTC first, then any the backend lists), the higher-priority
  side pays the whole rate. So a WBTC pair charges it on the WBTC leg, in `token_in_fee_bps` when
  you spend WBTC and in `token_out_fee_bps` when you receive it, and an `ORDI`/`NUTKIN` pair charges
  it on `ORDI` if the backend ranks `ORDI` higher.
- Otherwise it is split, with the odd bp on the input leg: at 25 bps, 13 on the input and 12 on the
  output.

Read the values from the quote rather than hard-coding them. A backend too old to serve `fee_policy`
makes swaps and swap quotes fail with an error saying so; everything else keeps working.

`miner_fee_sats` is a flat sat amount, not a rate. It can't be folded into a bps figure and stays
meaningful only as an absolute number; use `satsToBtc`/`satsToUsd` to display it.

`getSwapExactOutputResult` returns the same breakdown, with the fees priced off the required
`amount_in` and the output you requested.

## Referrals

Both swap functions take an optional final `referrerId`. When a valid referral ID is supplied, a
share of the swap fee is credited to the referrer's smart wallet (and, where the referrer has
configured a return rate, part of that is rebated back to the swapper). An unknown or expired
referral is ignored — the swap still goes through as a normal swap.

```ts
await swap.swapExactInput(
  tokenInAddress,
  tokenOutAddress,
  amountIn,
  amountOutMin,
  slippageBPS,
  referrerId
)
await swap.swapExactOutput(
  tokenInAddress,
  tokenOutAddress,
  amountIn,
  amountOut,
  slippageBPS,
  referrerId
)
```

Resolve a referral ID to the referrer's swap pubkey and return-rate (bps) without sending a swap —
useful for showing referral info or validating an ID up front:

```ts
const { referrerPubkey, refReturnBps } = await swap.tryGetSwapReferrerInfo(mySwapPubkey, referrerId)
// referrerPubkey is undefined when the referral can't be resolved
```

## Liquidity

Either token may be WBTC or a BRC-20 token, so token/token pools (e.g. `ORDI`/`NUTKIN`) work too.
Adding liquidity to a pair that doesn't exist yet creates it; the swap backend rejects a new pair
unless each side is WBTC or a BRC-20 token. Beyond that, the swap backend decides which new pairs it
accepts, and rejects a pair it does not allow with its own error message, which the kit passes
through unchanged. Liquidity orders carry no protocol fee.

```ts
await swap.addLiquidity(token1, token2, amount1Desired, amount2Desired, slippageBPS)

const { amountA, amountB } = await swap.getRemoveLiquidityResult(token1, token2, liquidity)
await swap.removeLiquidity(token1, token2, liquidity, amountA, amountB, slippageBPS)
```

Quote first with `getAddLiquidityResult` / `getRemoveLiquidityResult`. The amounts you pass are the
**expected** ones from the quote — `slippageBPS` derives the enforced on-chain minimums from them,
so passing an already slippage-adjusted floor applies slippage twice and silently weakens your
protection.

## Move funds in and out

```ts
// Tokens: deposit pulls from your programmable balance, or auto-converts from
// your base BRC-20 balance (and creates the allowance) when it's short.
await swap.deposit(tokenAddress, amount, feeRate /* , createAllowanceIfNeeded = true */)
await swap.withdraw(tokenAddress, amount /* , targetAddress? */) // omit target → self
```

`deposit` also takes an optional 5th param, `reclaimInscriptions: { inscriptionId, amount }[]`. When
the wallet's depositable balance is locked in transfer inscriptions (`transferrable_balance`), pass
those inscriptions to reclaim; the kit sends them back to self inside the same deposit package (no
extra transaction — the reclaim inputs are signed as part of the existing deposit commit) so their
balance funds the deposit. `amount` is the inscription's BRC-20 transfer amount in 18-dec fixed
point — caller-supplied, the kit does not read it on-chain.

```ts
// BTC: wrapBtc deposits BTC into the smart wallet as WBTC; unwrapBtc is the reverse and
// pays the BTC out on L1, so it takes the destination output script — not an address
// and not a token address. Quote first with getUnwrapBtcResult(pkscript, amount).
await swap.wrapBtc(btcSats, feeRate)

// The network must match btcAddress, or you derive a valid-looking script that pays
// somewhere else. Deriving it from the kit's selected network keeps the two in step.
// (Signet uses bitcoinjs' testnet params.)
const network =
  wallet.getNetwork() === 'mainnet' ? bitcoinjs.networks.bitcoin : bitcoinjs.networks.testnet

const pkscript = bitcoinjs.address.toOutputScript(btcAddress, network).toString('hex')
await swap.unwrapBtc(pkscript, amountSats)
```

## Market data

```ts
await swap.listPairs({ order_by: 'tvl_desc', page: 1, count: 20 }) // ListPairsResponse
await swap.getKlines({/* GetKlinesRequest */})
await swap.getPairVolumeOverDays(/* … */)
await swap.getTvlHistory(/* GetTvlHistoryRequest — daily TVL series in WBTC sats */)
await swap.getActivityOfPair(pairAddress, limit, offset)
await swap.getWalletActivities(pubkey, pairAddress, limit, offset) // limit, offset optional
```

Both activity endpoints page with `limit` (max 200) and `offset`. `getActivityOfPair` defaults to 20
and 0. `getWalletActivities` sends each only when given, so the backend applies its own defaults
(100 and 0); an out-of-range value throws before any request. Wallet activities come back
unconfirmed first (null `timestamp`), then newest first. Page until `has_more` is not `true`:

```ts
let offset = 0
for (;;) {
  const page = await swap.getWalletActivities(pubkey, pairAddress, 200, offset)
  render(page.activities)
  if (!page.has_more) break
  offset += page.activities.length
}
```

`has_more`, `limit` and `offset` are optional on both responses. Older backends omit them and return
the full list, which ends the loop above after one page.

Volume and TVL are in WBTC sats; APR is a percentage. For a **token/token pair** all three are null
when the pair doesn't have enough BTC behind it: its `exposure_sats` (the BTC in both tokens' own
BTC pools) must reach the backend's `fee_policy.min_btc_exposure_sats`. Below that they come back as
`null`: `PairInfo.volume_24h` / `volume_7d` / `tvl` / `apr`, `total_volume_wbtc` from
`getPairVolumeOverDays`, and each `getTvlHistory` point's `tvl`. Show them as "N/A", don't treat
`null` as zero. Likewise `SwapBalance.price_sats` is `null` for a token with no BTC price.

Prices are quoted in `price_quote_token` (on `PairInfo` and `GetKlinesResponse`): WBTC for a WBTC
pair; for a token/token pair, the higher-priority fee token if either side is one, else `token_b`. A
token/token `pair_name` reads `BASE/QUOTE`, and its price and klines are the raw ratio in
quote-token base units per whole base token, with no BTC conversion. A token/token LP token's
`SwapBalance` carries the quote token's reserve and decimals in `reserve_btc_amt` / `btc_decimals`,
and its address in `quote_token`.

The `Get…Request` / `Get…Response`, `Kline`, `PairReserves`, `SwapBalance`, `PairActivityEntry`, and
`WalletActivityEntry` types are exported from the same namespace, see the
[generated API reference](./README.md#api-reference) for exact shapes.

## Reporting helpers

Everything is denominated in sats / WBTC. These pure helpers cover the common reporting derivations
so each consumer doesn't reimplement them.

```ts
// Buy/sell side relative to WBTC (you "buy" the token when you spend WBTC, "sell"
// it when you receive WBTC). Returns null for token-to-token swaps.
// For a *swap* activity entry, token_1 is the input and token_2 the output:
if (entry.type === 'swap1' || entry.type === 'swap2') {
  const side = swap.swapSide(entry.token_1, entry.token_2, wbtcAddress) // 'buy' | 'sell' | null
}

// Value conversion — the library stays oracle-free; you supply the BTC/USD rate.
const btc = swap.satsToBtc(amountSats) // sats → BTC (throws above ~90k BTC)
const usd = swap.satsToUsd(amountSats, btcUsd) // sats → USD
```

For **TVL of a WBTC pair**: it's `2 ×` the WBTC-side reserve (the other side is worth the same in
BTC terms), then convert with `satsToBtc` / `satsToUsd` — e.g.
`swap.satsToUsd(wbtcReserve * 2n, btcUsd)`. A token/token pair has no WBTC reserve: use the `tvl`
that `listPairs` reports (in sats, or `null`, see [Market data](#market-data)).
