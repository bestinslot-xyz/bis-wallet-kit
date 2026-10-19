import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'
import { balances } from '../../src/node.ts'

const ADDRESS = 'bc1plnw9577kddxn4ry37xsul99d04tp7w3sf0cclt6k0zc7u3l8swmsfylw0g'

let bodies: any[]

beforeEach(() => {
  bodies = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, opts?: any) => {
      bodies.push(JSON.parse(opts.body))
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          success: true,
          result: {
            ticker: 'ordi',
            available_balance_in_18_dec: '5000000000000000000',
            transferrable_balance_in_18_dec: '1000000000000000000',
            decimals: 18,
          },
        }),
      }
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getBaseBRC20BalanceOfAddress', () => {
  it('sends the token address with a lowercase 0x prefix', async () => {
    for (const token of [
      '0x077fe0e97B1bAD5040D5053384fF8099AB816481',
      '0X077FE0E97B1BAD5040D5053384FF8099AB816481',
    ]) {
      await balances.getBaseBRC20BalanceOfAddress(ADDRESS, token)
    }
    assert.deepEqual(
      bodies.map(b => b.token_address),
      ['0x077fe0e97b1bad5040d5053384ff8099ab816481', '0x077fe0e97b1bad5040d5053384ff8099ab816481']
    )
    assert.equal(bodies[0].ordinal_address, ADDRESS)
  })

  it('returns the balances as bigints', async () => {
    const res = await balances.getBaseBRC20BalanceOfAddress(
      ADDRESS,
      '0x077fe0e97b1bad5040d5053384ff8099ab816481'
    )
    assert.deepEqual(res, {
      availableBalanceIn18Decimals: 5n * 10n ** 18n,
      transferrableBalanceIn18Decimals: 10n ** 18n,
      decimals: 18,
      ticker: 'ordi',
    })
  })
})
