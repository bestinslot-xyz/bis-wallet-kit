import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'
import vectors from './fee_vectors.json'

// getSwapInfo caches per network in module state with no reset hook, so every
// test re-imports bis_swap.ts on a fresh module graph (vi.resetModules) and
// stubs fetch. The network store resets with it, to its 'mainnet' default.

const SWAP_INFO_URL = 'https://sa-proxy.bestinslot.xyz/get_swap_info'
const { WBTC, ORDI, XYZ, ABC } = vectors.addresses
const FEE_POLICY = {
  swap_fee_bps: 25,
  priority_tokens: [WBTC, ORDI],
  min_btc_exposure_sats: '5000000',
}

let fetchMock: ReturnType<typeof vi.fn>

function swapInfoBody(feePolicy?: unknown) {
  return {
    success: true,
    result: {
      factory_address: '0x0000000000000000000000000000000000001234',
      wbtc_address: `0x${WBTC.slice(2).toUpperCase()}`,
      wbtc_handler_address: 'bc1qhandler',
      ...(feePolicy === undefined ? {} : { fee_policy: feePolicy }),
    },
  }
}

function serve(body: unknown) {
  fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url) === SWAP_INFO_URL)
      return { ok: true, status: 200, statusText: 'OK', json: async () => body }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
}

async function freshSwapModule() {
  vi.resetModules()
  return await import('../../src/core/bis_swap.ts')
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getSwapInfo fee_policy', () => {
  it('parses fee_policy and caches the result per network', async () => {
    serve(swapInfoBody(FEE_POLICY))
    const { getSwapInfo } = await freshSwapModule()

    const info = await getSwapInfo()
    assert.deepEqual(info, {
      factory_address: '0x0000000000000000000000000000000000001234',
      wbtc_address: WBTC,
      wbtc_handler_address: 'bc1qhandler',
      fee_policy: FEE_POLICY,
    })
    await getSwapInfo()
    assert.equal(fetchMock.mock.calls.length, 1)
    assert.equal(String(fetchMock.mock.calls[0]![0]), SWAP_INFO_URL)
  })

  it('returns fee_policy: null for an older backend and does not cache it', async () => {
    serve(swapInfoBody())
    const { getSwapInfo } = await freshSwapModule()

    assert.equal((await getSwapInfo()).fee_policy, null)
    await getSwapInfo()
    assert.equal(fetchMock.mock.calls.length, 2)
  })

  it('serves fee_policy: null for a malformed policy, without caching it', async () => {
    serve(swapInfoBody({ ...FEE_POLICY, swap_fee_bps: 2.5 }))
    const { getSwapInfo, getSwapFeesBps } = await freshSwapModule()

    const info = await getSwapInfo()
    assert.deepEqual(info, {
      factory_address: '0x0000000000000000000000000000000000001234',
      wbtc_address: WBTC,
      wbtc_handler_address: 'bc1qhandler',
      fee_policy: null,
    })
    await assertRejects(getSwapFeesBps(WBTC, XYZ), /Invalid fee_policy/)
  })

  it('reports the missing-policy error once a malformed policy is followed by none', async () => {
    let body: unknown = swapInfoBody({ ...FEE_POLICY, swap_fee_bps: 2.5 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }))
    )
    const { getSwapFeesBps } = await freshSwapModule()

    await assertRejects(getSwapFeesBps(WBTC, XYZ), /Invalid fee_policy/)
    body = swapInfoBody()
    await assertRejects(getSwapFeesBps(WBTC, XYZ), /older than this wallet-kit release/)
  })
})

describe('getSwapInfo fee_policy freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not refetch within the 60s TTL', async () => {
    serve(swapInfoBody(FEE_POLICY))
    const { getSwapInfo } = await freshSwapModule()

    await getSwapInfo()
    vi.setSystemTime(Date.now() + 59_000)
    await getSwapInfo()
    assert.equal(fetchMock.mock.calls.length, 1)
  })

  it('refetches after the 60s TTL and picks up the new fee_policy', async () => {
    let body: unknown = swapInfoBody(FEE_POLICY)
    const dynamicFetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === SWAP_INFO_URL)
        return { ok: true, status: 200, statusText: 'OK', json: async () => body }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    })
    vi.stubGlobal('fetch', dynamicFetchMock)
    const { getSwapInfo, getSwapFeesBps } = await freshSwapModule()

    await getSwapInfo()
    assert.deepEqual(await getSwapFeesBps(XYZ, ABC), { token1FeeBps: 13n, token2FeeBps: 12n })

    body = swapInfoBody({ ...FEE_POLICY, priority_tokens: [WBTC, ORDI, ABC] })
    vi.setSystemTime(Date.now() + 60_001)

    await getSwapInfo()
    assert.equal(dynamicFetchMock.mock.calls.length, 2)
    assert.deepEqual(await getSwapFeesBps(XYZ, ABC), { token1FeeBps: 0n, token2FeeBps: 25n })
  })
})

describe('getSwapFeesBps', () => {
  it('charges the WBTC side 25 bps', async () => {
    serve(swapInfoBody(FEE_POLICY))
    const { getSwapFeesBps } = await freshSwapModule()

    assert.deepEqual(await getSwapFeesBps(WBTC, XYZ), { token1FeeBps: 25n, token2FeeBps: 0n })
    assert.deepEqual(await getSwapFeesBps(XYZ, WBTC), { token1FeeBps: 0n, token2FeeBps: 25n })
  })

  it('allows token/token swaps: priority side pays, otherwise 13/12', async () => {
    serve(swapInfoBody(FEE_POLICY))
    const { getSwapFeesBps } = await freshSwapModule()

    assert.deepEqual(await getSwapFeesBps(XYZ, ORDI), { token1FeeBps: 0n, token2FeeBps: 25n })
    assert.deepEqual(await getSwapFeesBps(XYZ, ABC), { token1FeeBps: 13n, token2FeeBps: 12n })
    assert.deepEqual(await getSwapFeesBps(ABC, XYZ), { token1FeeBps: 13n, token2FeeBps: 12n })
  })

  it('matches addresses case-insensitively', async () => {
    serve(swapInfoBody(FEE_POLICY))
    const { getSwapFeesBps } = await freshSwapModule()

    const upper = (addr: string) => `0x${addr.slice(2).toUpperCase()}`
    assert.deepEqual(await getSwapFeesBps(upper(XYZ), upper(WBTC)), {
      token1FeeBps: 0n,
      token2FeeBps: 25n,
    })
    assert.deepEqual(await getSwapFeesBps(upper(ORDI), XYZ), {
      token1FeeBps: 25n,
      token2FeeBps: 0n,
    })
  })

  it('fails with a clear error when the backend has no fee_policy', async () => {
    serve(swapInfoBody())
    const { getSwapFeesBps } = await freshSwapModule()

    await assertRejects(getSwapFeesBps(WBTC, XYZ), /older than this wallet-kit release/)
  })
})

async function assertRejects(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise
  } catch (error) {
    assert.match(String(error), pattern)
    return
  }
  assert.fail(`expected a rejection matching ${pattern}`)
}
