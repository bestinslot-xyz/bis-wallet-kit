import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'
import { listPairs } from '../../src/core/bis_swap.ts'

// The swap backend reports volume/TVL/APR as null for a token/token pair whose BTC
// exposure is below its threshold. listPairs converts the numeric strings to
// bigint and must pass those nulls through instead of calling BigInt(null).

const WBTC = '0x1111111111111111111111111111111111111111'
const ORDI = '0x2222222222222222222222222222222222222222'
const NUTKIN = '0x3333333333333333333333333333333333333333'
const XYZ = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const BTC_ROW = {
  pair_address: '0x00000000000000000000000000000000000000a1',
  pair_name: 'FRBTC/XYZ',
  token_a_addr: WBTC,
  token_a_symbol: 'FRBTC',
  token_b_addr: XYZ,
  token_b_symbol: 'XYZ',
  price: 10000,
  price_change_24h: 100,
  price_change_7d: 0,
  volume_24h: '1000000',
  volume_7d: '2000000',
  lp_fee_tier: 0.3,
  tvl: '20000000',
  apr: 5.475,
  price_quote_token: WBTC,
  exposure_sats: '10000000',
  market_cap: '210000000',
}

const TOKEN_TOKEN_ROW = {
  pair_address: '0x00000000000000000000000000000000000000a2',
  pair_name: 'NUTKIN/ORDI',
  token_a_addr: ORDI,
  token_a_symbol: 'ORDI',
  token_b_addr: NUTKIN,
  token_b_symbol: 'NUTKIN',
  price: 2.5e17,
  price_change_24h: 0,
  price_change_7d: 0,
  volume_24h: null,
  volume_7d: null,
  lp_fee_tier: 0.3,
  tvl: null,
  apr: null,
  price_quote_token: ORDI,
  exposure_sats: '0',
  market_cap: null,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ page: 1, count: 20, total: 2, data: [BTC_ROW, TOKEN_TOKEN_ROW] }),
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listPairs', () => {
  it('converts a WBTC pair row to bigints and keeps the new fields', async () => {
    const { data } = await listPairs()

    assert.deepEqual(data[0], {
      ...BTC_ROW,
      volume_24h: 1_000_000n,
      volume_7d: 2_000_000n,
      tvl: 20_000_000n,
      exposure_sats: 10_000_000n,
      market_cap: 210_000_000n,
    })
  })

  it('reads a market_cap missing from an older backend as null', async () => {
    const row: Partial<typeof BTC_ROW> = { ...BTC_ROW }
    delete row.market_cap
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ page: 1, count: 20, total: 1, data: [row] }),
    })
    const { data } = await listPairs()

    assert.equal(data[0].market_cap, null)
  })

  it('passes null volume, TVL and APR through for a token/token pair', async () => {
    const { data } = await listPairs()

    assert.deepEqual(data[1], {
      ...TOKEN_TOKEN_ROW,
      volume_24h: null,
      volume_7d: null,
      tvl: null,
      exposure_sats: 0n,
      market_cap: null,
    })
  })
})
