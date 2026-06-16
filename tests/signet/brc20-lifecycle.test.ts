import process from 'node:process'
import { assert, describe, it } from 'vitest'
import { balances, jsonInscription, mint, swap, wallet } from '../../src/node.ts'

/**
 * Long-running end-to-end lifecycle against a live signet endpoint:
 * mint BRC-20 → deposit into the smart wallet → wrap BTC → add liquidity →
 * swap both ways → withdraw, waiting for the chain/indexer between steps.
 *
 * It moves real funds and waits on multiple blocks, so it's off unless
 * SIGNET_E2E=1 and all fixtures are set, and is never part of CI. Amounts and
 * timeouts may need tuning for your ticker on the first run.
 *
 * Required env (in .env.signet):
 *   SIGNET_E2E=1
 *   PRIVATE_KEY_WIF            funded signet wallet (BTC for fees + the BTC to wrap)
 *   SIGNET_E2E_TICKER         a deployed BRC-20 ticker with mint limit >= the amount
 *   SIGNET_E2E_TOKEN          the programmable (EVM) token address for that ticker
 *   SIGNET_WBTC_TOKEN         the WBTC token address
 * Optional:
 *   SIGNET_E2E_MINT_AMOUNT    default 1000 (ticker units)
 *   SIGNET_E2E_BTC_SATS       default 10000 (sats to wrap)
 *   SIGNET_E2E_FEE_RATE       default 2 (sats/vByte)
 */

const WIF = process.env.PRIVATE_KEY_WIF
const TICKER = process.env.SIGNET_E2E_TICKER
const TOKEN = process.env.SIGNET_E2E_TOKEN
const WBTC = process.env.SIGNET_WBTC_TOKEN
const FEE_RATE = Number(process.env.SIGNET_E2E_FEE_RATE ?? '2')
const MINT_AMOUNT = process.env.SIGNET_E2E_MINT_AMOUNT ?? '1000'
// Parsed inside the test (not at import) so a malformed value can't throw during
// collection and fail the whole signet suite when this test is meant to skip.
const BTC_SATS_RAW = process.env.SIGNET_E2E_BTC_SATS ?? '10000'
const SLIPPAGE_BPS = 100n

const ENABLED = process.env.SIGNET_E2E === '1' && !!WIF && !!TICKER && !!TOKEN && !!WBTC

async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  { label = 'condition', timeoutMs = 30 * 60_000, intervalMs = 20_000 } = {},
): Promise<T> {
  const start = Date.now()
  for (let attempt = 1; ; attempt++) {
    const value = await fn()
    if (done(value))
      return value
    const elapsed = Math.round((Date.now() - start) / 1000)
    if (Date.now() - start > timeoutMs)
      throw new Error(`Timed out waiting for ${label} after ${elapsed}s`)
    console.warn(`waiting for ${label}… (attempt ${attempt}, ${elapsed}s elapsed)`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

describe('lifecycle: BRC-20 → swap (signet, end-to-end)', () => {
  it.skipIf(!ENABLED)(
    'mints, deposits, wraps, adds liquidity, swaps both ways, and withdraws',
    { timeout: 60 * 60_000 },
    async () => {
      const w = await wallet.connectLocalWallet(WIF!, 'signet', 'p2tr', 'unisat')
      const address = w.address
      await swap.createSwapWallet()

      // 1. Record the starting base BRC-20 balance (normalised to 18 decimals).
      const before = await balances.getBaseBRC20BalanceOfAddress(address, TOKEN!)
      const startBase = before.availableBalanceIn18Decimals
      console.warn(`start base balance: ${startBase}`)

      // 2. Mint BRC-20 via a broadcast inscription.
      const mintInscription = jsonInscription({ p: 'brc-20', op: 'mint', tick: TICKER!, amt: MINT_AMOUNT })
      const minted = await mint.inscribe(mintInscription, FEE_RATE, null, false)
      assert.ok(typeof minted.revealTxId === 'string')
      console.warn(`mint reveal tx: ${minted.revealTxId}`)

      // 3. Wait for the next block + indexer to reflect the mint.
      const after = await pollUntil(
        () => balances.getBaseBRC20BalanceOfAddress(address, TOKEN!),
        b => b.availableBalanceIn18Decimals > startBase,
        { label: 'mint to be indexed' },
      )
      const mintedDelta = after.availableBalanceIn18Decimals - startBase
      assert.ok(mintedDelta > 0n)
      console.warn(`minted delta (18dec): ${mintedDelta}`)

      // 4. Deposit half into the smart wallet (deposit auto-converts base→prog and creates the allowance).
      const depositAmt = mintedDelta / 2n
      await swap.deposit(TOKEN!, depositAmt, FEE_RATE)
      await pollUntil(
        () => swap.getSwapBalance(TOKEN!),
        bal => bal >= depositAmt,
        { label: 'token deposit to settle' },
      )

      // 5. Wrap a little BTC into the smart wallet as WBTC.
      const btcSats = BigInt(BTC_SATS_RAW)
      const wbtcBefore = await swap.getSwapBalance(WBTC!)
      await swap.wrapBtc(btcSats, FEE_RATE)
      const wbtcAfter = await pollUntil(
        () => swap.getSwapBalance(WBTC!),
        bal => bal > wbtcBefore,
        { label: 'BTC wrap to settle' },
      )
      const wrappedWbtc = wbtcAfter - wbtcBefore

      // 6. Add liquidity with a portion of each side.
      const added = await swap.addLiquidity(TOKEN!, WBTC!, depositAmt / 2n, wrappedWbtc / 2n, SLIPPAGE_BPS)
      assert.equal(added, true)

      // 7. Small swaps in both directions.
      const tokenIn = depositAmt / 10n
      const q1 = await swap.getSwapExactInputResult(TOKEN!, WBTC!, tokenIn)
      assert.equal(await swap.swapExactInput(TOKEN!, WBTC!, tokenIn, q1.amount_out, SLIPPAGE_BPS), true)

      const wbtcIn = wrappedWbtc / 10n
      const q2 = await swap.getSwapExactInputResult(WBTC!, TOKEN!, wbtcIn)
      assert.equal(await swap.swapExactInput(WBTC!, TOKEN!, wbtcIn, q2.amount_out, SLIPPAGE_BPS), true)

      // 8. Withdraw the remaining token balance back to the ordinals wallet.
      const remaining = await swap.getSwapBalance(TOKEN!)
      assert.ok(remaining > 0n)
      assert.equal(await swap.withdraw(TOKEN!, remaining), true)

      // 9. Wait for the withdraw to settle (smart-wallet balance drops).
      await pollUntil(
        () => swap.getSwapBalance(TOKEN!),
        bal => bal < remaining,
        { label: 'withdraw to settle' },
      )
    },
  )
})
