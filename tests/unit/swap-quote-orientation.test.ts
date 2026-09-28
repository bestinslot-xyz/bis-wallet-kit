import type { UniswapInfoProxy } from '../../src/lib/uniswap_ops.ts'
import { assert, describe, it } from 'vitest'
import { quotedPrice } from '../../src/lib/swap-reporting.ts'
import { saveInfo, swap2Request, swapRequest } from '../../src/lib/uniswap_ops.ts'

const WBTC = '0x00000000000000000000000000000000000000bc'
const TOKEN = '0x0000000000000000000000000000000000000abc'
const OTHER = '0x0000000000000000000000000000000000000def'
const FACTORY = '0x0000000000000000000000000000000000001234'
const PUBKEY = 'ab'.repeat(256)
const MINER_FEE = 330n

describe('quotedPrice', () => {
  it('is sats per whole output token when WBTC is the input', () => {
    // 1,000 sats in for 2 whole 18-decimal tokens out -> 500 sats per token
    assert.equal(quotedPrice(WBTC, WBTC, 1_000n, 2n * 10n ** 18n, 8, 18), 500)
  })

  it('is sats per whole input token when WBTC is the output', () => {
    // 2 whole tokens in for 1,000 sats out -> 500 sats per token
    assert.equal(quotedPrice(TOKEN, WBTC, 2n * 10n ** 18n, 1_000n, 18, 8), 500)
  })

  it('is output base units per whole input token for a token/token swap', () => {
    // 1 whole TOKEN in for 2 whole OTHER out: 2e18 (the output is not scaled by its decimals)
    assert.equal(quotedPrice(TOKEN, WBTC, 10n ** 18n, 2n * 10n ** 18n, 18, 18), 2e18)
  })

  it('matches WBTC case-insensitively', () => {
    assert.equal(
      quotedPrice(WBTC.toUpperCase().replace('0X', '0x'), WBTC, 1_000n, 2n * 10n ** 18n, 8, 18),
      500
    )
  })
})

describe('swap price impact with a mixed-case WBTC address', () => {
  // A pool of 10 BTC (WBTC sorts first) against 1,000,000 TOKEN (6 decimals).
  const proxy: UniswapInfoProxy = {
    balanceOf: async () => 10n ** 15n,
    reservesOf: async () => ({
      reserveA: 1_000_000_000n,
      reserveB: 1_000_000_000_000n,
      total_supply: 1_000_000_000n,
    }),
  }
  const upperWbtc = `0x${WBTC.slice(2).toUpperCase()}`

  // Buying with 1 BTC moves the WBTC-per-TOKEN price by 20.96%; measured the
  // other way round (TOKEN per WBTC) it would read 17.33%.
  it('measures exact-input impact in WBTC terms whatever the saved casing', async () => {
    for (const wbtc of [WBTC, upperWbtc]) {
      saveInfo(wbtc, FACTORY)
      const result = await swapRequest(
        proxy,
        PUBKEY,
        WBTC,
        TOKEN,
        100_000_000n,
        0n,
        '',
        0n,
        25n,
        0n,
        MINER_FEE
      )
      assert.equal(result.success, true)
      assert.equal(result.price_impact_bps, 2096n)
    }
  })

  it('measures exact-output impact in WBTC terms whatever the saved casing', async () => {
    for (const wbtc of [WBTC, upperWbtc]) {
      saveInfo(wbtc, FACTORY)
      const result = await swap2Request(
        proxy,
        PUBKEY,
        WBTC,
        TOKEN,
        2n ** 256n - 1n,
        90_661_089_388n,
        '',
        0n,
        25n,
        0n,
        MINER_FEE
      )
      assert.equal(result.success, true)
      assert.equal(result.price_impact_bps, 2096n)
    }
  })

  it('runs a token/token swap through the same math', async () => {
    saveInfo(upperWbtc, FACTORY)
    const result = await swapRequest(
      proxy,
      PUBKEY,
      TOKEN,
      OTHER,
      1_000_000n,
      0n,
      '',
      0n,
      13n,
      12n,
      MINER_FEE
    )
    assert.equal(result.success, true)
    assert.equal(result.reserve_in, 1_000_000_000n)
    assert.equal(result.reserve_out, 1_000_000_000_000n)
  })
})
