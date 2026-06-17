import { assert, beforeAll, describe, expect, it } from 'vitest'
import { swap } from '../../src/node.ts'
import { connectSignetWallet, env, hasSwapTokens } from './_helpers.ts'

describe('swap (signet)', () => {
  let ordinalsAddress: string

  beforeAll(async () => {
    const w = await connectSignetWallet()
    ordinalsAddress = w.address
    // A swap (smart) wallet is required for balance reads and quotes.
    await swap.createSwapWallet()
  })

  // ---- Status & fees (no fixtures needed) ----

  it('returns swap status', async () => {
    const status = await swap.getSwapStatus()
    assert.ok(typeof status.reorg_handler_running === 'boolean')
    assert.ok(typeof status.emergency_stop === 'boolean')
  })

  it.each(['swap', 'add_liquidity', 'remove_liquidity', 'withdraw', 'unwrap'] as const)(
    'returns a miner fee for %s',
    async (type) => {
      const fee = await swap.getMinerFee(type)
      assert.ok(typeof fee === 'bigint')
      assert.ok(fee >= 0n)
    },
  )

  it('returns the wrap order miner fee', async () => {
    const fee = await swap.getMinerFeesOfWrapOrder(env.swapAmount, 2)
    assert.ok(typeof fee.total_fee === 'number')
    assert.ok(typeof fee.fee_rate === 'number')
  })

  // ---- Smart-wallet balances ----

  it('returns smart-wallet balances for the ordinals address', async () => {
    const balances = await swap.getSwapBalances(ordinalsAddress)
    assert.ok(Array.isArray(balances))
    for (const b of balances) {
      assert.ok(typeof b.token_address === 'string')
      assert.ok(typeof b.balance === 'string')
      assert.ok(typeof b.is_lp === 'boolean')
    }
  })

  it.skipIf(!env.swapToken)('returns the smart-wallet balance for a token', async () => {
    const bal = await swap.getSwapBalance(env.swapToken!)
    assert.ok(typeof bal === 'bigint')
    assert.ok(bal >= 0n)
  })

  // ---- Token / pair reads ----

  it.skipIf(!env.swapToken)('returns token decimals', async () => {
    const decimals = await swap.getTokenDecimals(env.swapToken!)
    assert.ok(typeof decimals === 'number')
    assert.ok(decimals >= 0)
  })

  it.skipIf(!env.swapPair)('returns pair reserves', async () => {
    const reserves = await swap.getPairReserves(env.swapPair!)
    assert.ok(typeof reserves.reserveA === 'bigint')
    assert.ok(typeof reserves.reserveB === 'bigint')
    assert.ok(typeof reserves.total_supply === 'bigint')
  })

  // ---- Pool precondition ----

  it('fails fast with a clear error when the pair has no pool', async () => {
    // Two arbitrary addresses that aren't a pool → the precondition should reject
    // before reaching the swap math. (Assumes the backend reports zero reserves
    // for an unknown pair.)
    const a = '0x000000000000000000000000000000000000dead'
    const b = '0x000000000000000000000000000000000000beef'
    await expect(swap.getSwapExactInputResult(a, b, 1000n)).rejects.toThrow(/No swap pool/)
  })

  // ---- Quotes ----

  it.skipIf(!hasSwapTokens)('quotes an exact-input swap', async () => {
    const quote = await swap.getSwapExactInputResult(env.swapToken!, env.wbtcToken!, env.swapAmount)
    assert.ok(typeof quote.amount_out === 'bigint')
    assert.ok(typeof quote.price_impact_bps === 'bigint')
  })

  it.skipIf(!hasSwapTokens)('quotes an exact-output swap', async () => {
    const quote = await swap.getSwapExactOutputResult(env.swapToken!, env.wbtcToken!, env.swapAmount)
    assert.ok(typeof quote.amount_in === 'bigint')
    assert.ok(typeof quote.price_impact_bps === 'bigint')
  })

  it.skipIf(!hasSwapTokens)('quotes adding liquidity', async () => {
    const result = await swap.getAddLiquidityResult(
      env.swapToken!,
      env.wbtcToken!,
      env.swapAmount,
      env.swapAmount,
    )
    assert.ok(typeof result.amountA === 'bigint')
    assert.ok(typeof result.amountB === 'bigint')
    assert.ok(typeof result.liquidity === 'bigint')
  })

  // ---- Market data ----

  it.skipIf(!env.swapPair)('returns klines', async () => {
    const result = await swap.getKlines({
      pair_address: env.swapPair!,
      interval: '1h',
      limit: 10,
      startTime: null,
      endTime: null,
    })
    assert.ok(Array.isArray(result.klines))
  })

  it.skipIf(!env.swapPair)('returns pair volume over days', async () => {
    const result = await swap.getPairVolumeOverDays({ pair_address: env.swapPair!, days: 7 })
    assert.ok(typeof result.total_volume_wbtc === 'string')
    assert.ok(typeof result.total_trades === 'number')
  })

  it.skipIf(!env.swapPair)('returns activity for a pair', async () => {
    const result = await swap.getActivityOfPair(env.swapPair!, 10, 0)
    assert.ok(Array.isArray(result.activities))
  })

  // ---- Referral resolution ----

  it.skipIf(!env.referrerId)('resolves a referral ID to a referrer', async () => {
    const { referrerPubkey } = await swap.tryGetSwapReferrerInfo(ordinalsAddress, env.referrerId!)
    // A valid referral resolves to a pubkey; an invalid one returns undefined.
    assert.ok(referrerPubkey === undefined || typeof referrerPubkey === 'string')
  })

  // ---- Execution (moves funds; requires SIGNET_EXECUTE=1 + fixtures) ----

  describe('execution', () => {
    const canExecute = env.execute && hasSwapTokens

    it.skipIf(!canExecute)('executes an exact-input swap', async () => {
      const quote = await swap.getSwapExactInputResult(env.swapToken!, env.wbtcToken!, env.swapAmount)
      const ok = await swap.swapExactInput(
        env.swapToken!,
        env.wbtcToken!,
        env.swapAmount,
        quote.amount_out,
        env.slippageBps,
      )
      assert.equal(ok, true)
    })

    it.skipIf(!canExecute || !env.referrerId)(
      'executes an exact-input swap with a referral',
      async () => {
        const quote = await swap.getSwapExactInputResult(
          env.swapToken!,
          env.wbtcToken!,
          env.swapAmount,
        )
        const ok = await swap.swapExactInput(
          env.swapToken!,
          env.wbtcToken!,
          env.swapAmount,
          quote.amount_out,
          env.slippageBps,
          env.referrerId!,
        )
        assert.equal(ok, true)
      },
    )

    it.skipIf(!canExecute)('executes an exact-output swap', async () => {
      const quote = await swap.getSwapExactOutputResult(env.swapToken!, env.wbtcToken!, env.swapAmount)
      const ok = await swap.swapExactOutput(
        env.swapToken!,
        env.wbtcToken!,
        quote.amount_in,
        env.swapAmount,
        env.slippageBps,
      )
      assert.equal(ok, true)
    })

    it.skipIf(!canExecute)('adds liquidity', async () => {
      const added = await swap.addLiquidity(
        env.swapToken!,
        env.wbtcToken!,
        env.swapAmount,
        env.swapAmount,
        env.slippageBps,
      )
      assert.equal(added, true)
    })
  })
})
