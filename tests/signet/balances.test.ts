import process from 'node:process'
import { assert, beforeAll, describe, it } from 'vitest'
import { balances, wallet } from '../../src/main.ts'

// Token address used for the wallet-agnostic prog-balance read (returns 0 for an
// address that holds nothing, so a default is fine). Override via env if desired.
const PROG_TOKEN = process.env.SIGNET_PROG_TOKEN ?? '0x237DFc53abe56C2818213A77610Fb4498a0Aeba5'
// Token-specific reads need fixtures the test wallet actually holds / that exist,
// so they skip unless configured.
const KNOWN_TICKER = process.env.SIGNET_KNOWN_TICKER // a ticker that exists on signet
const BASE_TOKEN = process.env.SIGNET_BASE_BRC20_TOKEN // a token the wallet holds a base balance of

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

  it('should return a BRC2.0 prog balance by token address', async () => {
    const balance = await balances.getBRC20ProgBalanceOfAddress(walletAddress, PROG_TOKEN)
    assert.ok(typeof balance === 'bigint')
  })

  it.skipIf(!KNOWN_TICKER)('should return a BRC2.0 prog balance by ticker', async () => {
    const balance = await balances.getBRC20ProgBalanceOfTicker(walletAddress, KNOWN_TICKER!)
    assert.ok(typeof balance === 'bigint')
  })

  it.skipIf(!KNOWN_TICKER)('should resolve a ticker to its prog token address', async () => {
    const tokenAddress = await balances.getBRC20ProgTokenAddressOfTicker(KNOWN_TICKER!)
    assert.ok(typeof tokenAddress === 'string')
    assert.ok(tokenAddress.startsWith('0x'))
  })

  it.skipIf(!BASE_TOKEN)('should return the base BRC-20 balance by token address', async () => {
    const result = await balances.getBaseBRC20BalanceOfAddress(walletAddress, BASE_TOKEN!)
    assert.ok(typeof result.availableBalanceIn18Decimals === 'bigint')
    assert.ok(typeof result.transferrableBalanceIn18Decimals === 'bigint')
    assert.ok(typeof result.decimals === 'number')
    assert.ok(typeof result.ticker === 'string')
  })
})
