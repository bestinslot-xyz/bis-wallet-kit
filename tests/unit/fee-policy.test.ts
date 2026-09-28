import type { FeePolicy } from '../../src/lib/fee-policy.ts'
import { assert, describe, it } from 'vitest'
import { MISSING_FEE_POLICY_ERROR, parseFeePolicy, swapFeeBps } from '../../src/lib/fee-policy.ts'
import vectors from './fee_vectors.json'

// fee_vectors.json is a verbatim copy of SwapSequencer's test/fee_vectors.json.
// The backend rejects a swap whose signed fee split differs from its own, so both
// implementations must agree on every case. Never edit one copy alone.

type AddressName = keyof typeof vectors.addresses

// "<NAME>_UPPER" is that token's address with its hex digits upper-cased.
function resolve(name: string): string {
  if (name.endsWith('_UPPER')) {
    const addr = vectors.addresses[name.slice(0, -'_UPPER'.length) as AddressName]
    return `0x${addr.slice(2).toUpperCase()}`
  }
  return vectors.addresses[name as AddressName]
}

describe('swapFeeBps — shared vectors', () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      // Same resolution as the backend test: WBTC is always first, then the
      // listed priority names in order.
      const policy: FeePolicy = {
        swap_fee_bps: c.swap_fee_bps,
        priority_tokens: [
          vectors.addresses.WBTC,
          ...c.priority_tokens.filter(n => n !== 'WBTC').map(resolve),
        ],
        min_btc_exposure_sats: '5000000',
      }
      assert.deepEqual(swapFeeBps(resolve(c.token_in), resolve(c.token_out), policy), {
        token1FeeBps: BigInt(c.expected.token1_fee_bps),
        token2FeeBps: BigInt(c.expected.token2_fee_bps),
      })
    })
  }
})

describe('parseFeePolicy', () => {
  const WBTC = vectors.addresses.WBTC
  const ORDI = vectors.addresses.ORDI

  it('accepts the backend shape and lowercases the priority list', () => {
    const policy = parseFeePolicy({
      swap_fee_bps: 25,
      priority_tokens: [WBTC, `0x${ORDI.slice(2).toUpperCase()}`],
      min_btc_exposure_sats: '5000000',
    })
    assert.deepEqual(policy, {
      swap_fee_bps: 25,
      priority_tokens: [WBTC, ORDI],
      min_btc_exposure_sats: '5000000',
    })
  })

  it('throws the "backend too old" error when fee_policy is missing', () => {
    assert.throws(() => parseFeePolicy(undefined), MISSING_FEE_POLICY_ERROR)
    assert.throws(() => parseFeePolicy(null), /older than this wallet-kit release/)
  })

  it('rejects malformed policies', () => {
    const ok = { swap_fee_bps: 25, priority_tokens: [WBTC], min_btc_exposure_sats: '0' }
    assert.throws(() => parseFeePolicy('25'), /Invalid fee_policy/)
    assert.throws(() => parseFeePolicy({ ...ok, swap_fee_bps: 2.5 }), /swap_fee_bps/)
    assert.throws(() => parseFeePolicy({ ...ok, swap_fee_bps: '25' }), /swap_fee_bps/)
    assert.throws(() => parseFeePolicy({ ...ok, swap_fee_bps: 10001 }), /swap_fee_bps/)
    assert.throws(() => parseFeePolicy({ ...ok, priority_tokens: [] }), /priority_tokens/)
    assert.throws(() => parseFeePolicy({ ...ok, priority_tokens: ['ordi'] }), /priority_tokens/)
    assert.throws(
      () => parseFeePolicy({ ...ok, min_btc_exposure_sats: 5000000 }),
      /min_btc_exposure_sats/
    )
    assert.throws(
      () => parseFeePolicy({ ...ok, min_btc_exposure_sats: '-1' }),
      /min_btc_exposure_sats/
    )
  })
})
