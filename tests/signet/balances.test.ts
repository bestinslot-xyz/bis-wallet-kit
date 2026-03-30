import process from 'node:process'
import { assert, beforeAll, describe, it } from 'vitest'
import { balances, wallet } from '../../src/main.ts'

const KNOWN_TOKEN_ADDRESS = '0x237DFc53abe56C2818213A77610Fb4498a0Aeba5'
const KNOWN_TOKEN_TICKER = 'atat'

describe('tests for balances (signet)', () => {
  let walletAddress: string

  beforeAll(async () => {
    if (!process.env.PRIVATE_KEY_WIF) {
      throw new Error('PRIVATE_KEY_WIF environment variable is not set')
    }
    const localWallet = await wallet.connectLocalWallet(
      process.env.PRIVATE_KEY_WIF!,
      'signet',
      'p2tr',
      'unisat',
    )
    walletAddress = localWallet.address
  })

  it.skipIf(!KNOWN_TOKEN_ADDRESS)(
    'should return BRC2.0 prog balance by token address',
    async () => {
      const balance = await balances.getBRC20ProgBalanceOfAddress(
        walletAddress,
        KNOWN_TOKEN_ADDRESS,
      )
      assert.ok(typeof balance === 'bigint')
    },
  )

  it.skipIf(!KNOWN_TOKEN_TICKER)('should return BRC2.0 prog balance by ticker', async () => {
    const balance = await balances.getBRC20ProgBalanceOfTicker(walletAddress, KNOWN_TOKEN_TICKER)
    assert.ok(typeof balance === 'bigint')
  })
})
