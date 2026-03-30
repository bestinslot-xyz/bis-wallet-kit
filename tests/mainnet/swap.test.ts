import { assert, beforeAll, describe, it } from 'vitest'
import { swap, wallet } from '../../src/main.ts'

const KNOWN_TOKEN_ADDRESS = '0x077fe0e97B1bAD5040D5053384fF8099AB816481'

describe('tests for swap (mainnet)', () => {
  beforeAll(() => {
    wallet.setNetwork('mainnet')
  })

  it('should return a valid swap status', async () => {
    const status = await swap.getSwapStatus()
    assert.ok(typeof status.reorg_handler_running === 'boolean')
    assert.ok(typeof status.emergency_stop === 'boolean')
  })

  it('should return miner fee for swap type', async () => {
    const fee = await swap.getMinerFee('swap')
    assert.ok(typeof fee === 'bigint')
    assert.ok(fee >= 0n)
  })

  it('should return miner fee for add_liquidity type', async () => {
    const fee = await swap.getMinerFee('add_liquidity')
    assert.ok(typeof fee === 'bigint')
    assert.ok(fee >= 0n)
  })

  it.skipIf(!KNOWN_TOKEN_ADDRESS)('should return token decimals for a known token', async () => {
    const decimals = await swap.getTokenDecimals(KNOWN_TOKEN_ADDRESS)
    assert.ok(typeof decimals === 'number')
    assert.ok(decimals >= 0)
  })
})
