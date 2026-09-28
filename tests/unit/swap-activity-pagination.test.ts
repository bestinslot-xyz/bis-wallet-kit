import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { getActivityOfPair, getWalletActivities } from '../../src/api/swap.ts'

// The swap backend pages /wallet-activity and /pair-activity with limit/offset and reports
// has_more. It rejects a malformed limit/offset (including the literal "undefined") with a 400,
// so the kit sends each only when given and validates it first. Older backends ignore both and
// return the full list without has_more/limit/offset.

const PUBKEY = 'ab'.repeat(48)
const PAIR = '0x00000000000000000000000000000000000000a1'

const OLD_BACKEND_BODY = {
  pubkey: PUBKEY,
  btc_address: 'tb1qexample',
  pair_address: PAIR,
  activities: [],
}

let fetchMock: ReturnType<typeof vi.fn>
let body: unknown

function requestedUrl(): URL {
  return new URL(fetchMock.mock.calls[0][0] as string)
}

beforeEach(() => {
  body = OLD_BACKEND_BODY
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getWalletActivities', () => {
  it('omits limit and offset when not given', async () => {
    await getWalletActivities(PUBKEY, PAIR)

    const url = requestedUrl()
    assert.equal(url.pathname, `/wallet-activity/${PUBKEY}`)
    assert.equal(url.searchParams.get('pairAddress'), PAIR)
    assert.isFalse(url.searchParams.has('limit'))
    assert.isFalse(url.searchParams.has('offset'))
    assert.notInclude(url.search, 'undefined')
  })

  it('sends limit and offset when given', async () => {
    await getWalletActivities(PUBKEY, PAIR, 50, 100)

    const url = requestedUrl()
    assert.equal(url.searchParams.get('pairAddress'), PAIR)
    assert.equal(url.searchParams.get('limit'), '50')
    assert.equal(url.searchParams.get('offset'), '100')
  })

  it('sends only the parameter that is given', async () => {
    await getWalletActivities(PUBKEY, PAIR, undefined, 0)

    const url = requestedUrl()
    assert.isFalse(url.searchParams.has('limit'))
    assert.equal(url.searchParams.get('offset'), '0')
  })

  it('accepts the 200 limit boundary', async () => {
    await getWalletActivities(PUBKEY, PAIR, 200)

    assert.equal(requestedUrl().searchParams.get('limit'), '200')
  })

  it.each([
    ['above 200', 201, /Limit cannot exceed 200/],
    ['zero', 0, /Limit must be an integer of at least 1/],
    ['negative', -1, /Limit must be an integer of at least 1/],
    ['fractional', 1.5, /Limit must be an integer of at least 1/],
    ['NaN', Number.NaN, /Limit must be an integer of at least 1/],
  ])('rejects a limit that is %s before fetching', async (_label, limit, message) => {
    await expect(getWalletActivities(PUBKEY, PAIR, limit)).rejects.toThrow(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
  ])('rejects an offset that is %s before fetching', async (_label, offset) => {
    await expect(getWalletActivities(PUBKEY, PAIR, undefined, offset)).rejects.toThrow(
      /Offset must be a non-negative integer/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses an old-backend response without pagination fields', async () => {
    const result = await getWalletActivities(PUBKEY, PAIR, 50, 0)

    assert.deepEqual(result, OLD_BACKEND_BODY)
    assert.isUndefined(result.has_more)
    assert.isUndefined(result.limit)
    assert.isUndefined(result.offset)
  })

  it('returns the pagination fields from a new backend', async () => {
    body = { ...OLD_BACKEND_BODY, limit: 50, offset: 0, has_more: true }

    const result = await getWalletActivities(PUBKEY, PAIR, 50, 0)

    assert.isTrue(result.has_more)
    assert.equal(result.limit, 50)
    assert.equal(result.offset, 0)
  })
})

describe('getActivityOfPair', () => {
  const OLD_PAIR_BODY = {
    pair_address: PAIR,
    token_a: { address: '0x1', symbol: 'A', decimals: 18 },
    token_b: { address: '0x2', symbol: 'B', decimals: 18 },
    activities: [],
  }

  it('parses an old-backend response without pagination fields', async () => {
    body = OLD_PAIR_BODY

    const result = await getActivityOfPair(PAIR)

    assert.deepEqual(result, OLD_PAIR_BODY)
    assert.isUndefined(result.has_more)
    const url = requestedUrl()
    assert.equal(url.searchParams.get('limit'), '20')
    assert.equal(url.searchParams.get('offset'), '0')
  })

  it('returns has_more from a new backend', async () => {
    body = { ...OLD_PAIR_BODY, limit: 20, offset: 20, has_more: false }

    const result = await getActivityOfPair(PAIR, 20, 20)

    assert.isFalse(result.has_more)
    assert.equal(result.offset, 20)
  })
})
