import type { UniswapInfoProxy } from '../../src/lib/uniswap_ops.ts'
import { assert, describe, it } from 'vitest'
import { saveInfo, swap2Request, swapRequest } from '../../src/lib/uniswap_ops.ts'

const WBTC = '0x00000000000000000000000000000000000000bc'
const TOKEN = '0x0000000000000000000000000000000000000abc'
const FACTORY = '0x0000000000000000000000000000000000001234'
const PUBKEY = 'ab'.repeat(256)
const MINER_FEE = 330n
const BALANCE = 1_000_000n

// Every read awaits a tick, as the real backend round-trips do, so two
// simulations started together interleave.
const tick = () => new Promise(resolve => setTimeout(resolve, 1))
const proxy: UniswapInfoProxy = {
  balanceOf: async () => {
    await tick()
    return BALANCE
  },
  reservesOf: async () => {
    await tick()
    return {
      reserveA: 1_000_000_000n,
      reserveB: 1_000_000_000_000n,
      total_supply: 1_000_000_000n,
    }
  },
}

describe('overlapping simulations', () => {
  it('price each exact-input quote against the real balance', async () => {
    saveInfo(WBTC, FACTORY)
    const spend = (BALANCE * 9n) / 10n
    const quote = () =>
      swapRequest(proxy, PUBKEY, WBTC, TOKEN, spend, 0n, '', 0n, 0n, 0n, MINER_FEE)

    const [a, b] = await Promise.all([quote(), quote()])

    assert.isTrue(a.success, a.error_message)
    assert.isTrue(b.success, b.error_message)
    assert.equal(a.amounts?.[1], b.amounts?.[1])
  })

  it('price an exact-output quote alongside an exact-input one', async () => {
    saveInfo(WBTC, FACTORY)
    const spend = (BALANCE * 9n) / 10n
    const exactIn = swapRequest(proxy, PUBKEY, WBTC, TOKEN, spend, 0n, '', 0n, 0n, 0n, MINER_FEE)
    const exactOut = swap2Request(
      proxy,
      PUBKEY,
      WBTC,
      TOKEN,
      2n ** 256n - 1n,
      800_000_000n,
      '',
      0n,
      0n,
      0n,
      MINER_FEE
    )

    const [a, b] = await Promise.all([exactIn, exactOut])

    assert.isTrue(a.success, a.error_message)
    assert.isTrue(b.success, b.error_message)
  })

  it('hand the ledger on after a request fails', async () => {
    const quote = (spend: bigint) =>
      swapRequest(proxy, PUBKEY, WBTC, TOKEN, spend, 0n, '', 0n, 0n, 0n, MINER_FEE)

    saveInfo('', '')
    await quote(1_000n).then(
      () => assert.fail('expected the unset-info request to throw'),
      (e: Error) => assert.equal(e.message, 'Uniswap info not set')
    )
    saveInfo(WBTC, FACTORY)

    const [over, next] = await Promise.all([quote(BALANCE * 2n), quote(1_000n)])

    assert.equal(over.error_message, 'Insufficient input token balance')
    assert.isTrue(next.success, next.error_message)
  })
})
