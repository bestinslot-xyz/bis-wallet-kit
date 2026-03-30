import { assert, beforeAll, describe, it } from 'vitest'
import { balances, wallet } from '../../src/main.ts'

const KNOWN_ADDRESS = 'bc1plnw9577kddxn4ry37xsul99d04tp7w3sf0cclt6k0zc7u3l8swmsfylw0g'
const KNOWN_TOKEN_ADDRESS = '0x077fe0e97B1bAD5040D5053384fF8099AB816481'

describe('tests for balances', () => {
  beforeAll(() => {
    wallet.setNetwork('mainnet')
  })

  it('should return correct BRC2.0 balance', async () => {
    const balance = await balances.getBRC20ProgBalanceOfTicker(KNOWN_ADDRESS, '0xdead')
    assert.equal(balance, BigInt(10000000000000000000000n)) // 10000 with 18 decimals
  })

  it.skipIf(!KNOWN_TOKEN_ADDRESS)(
    'should return base BRC-20 balance by token address',
    async () => {
      const result = await balances.getBaseBRC20BalanceOfAddress(KNOWN_ADDRESS, KNOWN_TOKEN_ADDRESS)
      assert.ok(typeof result.availableBalanceIn18Decimals === 'bigint')
      assert.ok(typeof result.transferrableBalanceIn18Decimals === 'bigint')
      assert.ok(typeof result.decimals === 'number')
      assert.ok(typeof result.ticker === 'string')
    },
  )

  it.skipIf(!KNOWN_TOKEN_ADDRESS)(
    'should return BRC2.0 prog balance by token address',
    async () => {
      const balance = await balances.getBRC20ProgBalanceOfAddress(
        KNOWN_ADDRESS,
        KNOWN_TOKEN_ADDRESS,
      )
      assert.ok(typeof balance === 'bigint')
    },
  )

  it('should return BRC2.0 token address for ticker', async () => {
    const tokenAddress = await balances.getBRC20ProgTokenAddressOfTicker('0xdead')
    assert.equal(tokenAddress, '0xb001d3751fe207fdc0d26fcaf2ebc041ca82d1aa')
  })
})
