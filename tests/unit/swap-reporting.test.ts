import { assert, describe, it } from 'vitest'
import { satsToBtc, satsToUsd, swapSide } from '../../src/lib/swap-reporting.ts'

const WBTC = '0x00000000000000000000000000000000000000bc'
const TOKEN = '0x0000000000000000000000000000000000000abc'

describe('swapSide', () => {
  it('is a buy when WBTC is spent (input)', () => {
    assert.equal(swapSide(WBTC, TOKEN, WBTC), 'buy')
  })

  it('is a sell when WBTC is received (output)', () => {
    assert.equal(swapSide(TOKEN, WBTC, WBTC), 'sell')
  })

  it('is null for a token-to-token swap (no WBTC side)', () => {
    assert.equal(swapSide(TOKEN, '0x0000000000000000000000000000000000000def', WBTC), null)
  })

  it('matches WBTC case-insensitively', () => {
    assert.equal(swapSide(WBTC.toUpperCase(), TOKEN, WBTC), 'buy')
  })
})

describe('sat conversions', () => {
  it('satsToBtc divides by 1e8', () => {
    assert.equal(satsToBtc(100_000_000n), 1)
    assert.equal(satsToBtc(0n), 0)
    assert.equal(satsToBtc(250_000_000n), 2.5)
  })

  it('satsToUsd applies the caller-supplied rate', () => {
    assert.equal(satsToUsd(100_000_000n, 50_000), 50_000)
    assert.equal(satsToUsd(50_000_000n, 60_000), 30_000)
    assert.equal(satsToUsd(0n, 50_000), 0)
  })
})
