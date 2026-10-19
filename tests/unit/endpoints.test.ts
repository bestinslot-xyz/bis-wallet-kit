import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'

// The endpoint overrides, selected network and /v1/info cache are module state,
// so every test imports a fresh module graph (vi.resetModules) and stubs fetch.

type FetchMock = ReturnType<typeof vi.fn>

let fetchMock: FetchMock

function serve(routes: Record<string, unknown> = {}) {
  fetchMock = vi.fn(async (url: string | URL) => {
    const key = String(url)
    const body = key in routes ? routes[key] : { data: [] }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body }
  })
  vi.stubGlobal('fetch', fetchMock)
}

function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map(call => String(call[0]))
}

async function fresh() {
  vi.resetModules()
  const store = await import('../../src/core/store-network.ts')
  const helpers = await import('../../src/core/helpers.ts')
  return { ...store, ...helpers }
}

beforeEach(() => {
  serve()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('default endpoints', () => {
  it('keep the legacy hosts on mainnet', async () => {
    const { getEndpoints } = await fresh()
    assert.deepEqual(getEndpoints('mainnet'), {
      indexer: 'https://ts-proxy.bestinslot.xyz/v3/mainnet',
      tx: 'https://ts-proxy.bestinslot.xyz/v3/mainnet',
      sequencerRead: 'https://sa-proxy.bestinslot.xyz',
      sequencer: 'https://sa-proxy.bestinslot.xyz',
      rpc: 'https://rpc.brc20.build',
    })
  })

  it('keep the legacy hosts on signet', async () => {
    const { getEndpoints } = await fresh()
    assert.deepEqual(getEndpoints('signet'), {
      indexer: 'https://ts-proxy.bestinslot.xyz/v3/signet',
      tx: 'https://ts-proxy.bestinslot.xyz/v3/signet',
      sequencerRead: 'https://sas-proxy.bestinslot.xyz',
      sequencer: 'https://sas-proxy.bestinslot.xyz',
      rpc: 'https://rpc-signet.brc20.build',
    })
  })

  it('give testnet an indexer and tx host but no sequencer or rpc', async () => {
    const { getEndpoints, getSwapBackendUrl, getPublicRpcUrl, setNetwork } = await fresh()
    assert.deepEqual(getEndpoints('testnet'), {
      indexer: 'https://ts-proxy.bestinslot.xyz/v3/testnet',
      tx: 'https://ts-proxy.bestinslot.xyz/v3/testnet',
    })
    setNetwork('testnet')
    await expectRejects(
      getSwapBackendUrl('status'),
      /No 'sequencer' endpoint configured for testnet/
    )
    await expectRejects(getPublicRpcUrl(), /No 'rpc' endpoint configured for testnet/)
  })

  it('build the same request URLs as before on each network', async () => {
    const { fetchCardinalUtxos, getSwapBackendUrl, getPublicRpcUrl, setNetwork, validateTxes } =
      await fresh()

    await fetchCardinalUtxos('bc1qaddr')
    await validateTxes(['00'])
    assert.equal(
      await getSwapBackendUrl('get_tokens'),
      'https://sa-proxy.bestinslot.xyz/get_tokens'
    )
    assert.equal(await getSwapBackendUrl('swap'), 'https://sa-proxy.bestinslot.xyz/swap')
    assert.equal(await getPublicRpcUrl(), 'https://rpc.brc20.build')

    setNetwork('signet')
    await fetchCardinalUtxos('tb1qaddr')
    assert.equal(
      await getSwapBackendUrl('get_swap_info'),
      'https://sas-proxy.bestinslot.xyz/get_swap_info'
    )
    assert.equal(await getPublicRpcUrl(), 'https://rpc-signet.brc20.build')

    // Legacy hosts never trigger a /v1/info lookup.
    assert.deepEqual(fetchedUrls(), [
      'https://ts-proxy.bestinslot.xyz/v3/mainnet/cardinal_utxos/bc1qaddr',
      'https://ts-proxy.bestinslot.xyz/v3/mainnet/testmempoolaccept',
      'https://ts-proxy.bestinslot.xyz/v3/signet/cardinal_utxos/tb1qaddr',
    ])
  })
})

describe('setEndpoints', () => {
  it('overrides only the keys passed, per network', async () => {
    const { getEndpoints, setEndpoints } = await fresh()
    setEndpoints({ signet: { rpc: 'https://my-rpc.example' } })

    assert.equal(getEndpoints('signet').rpc, 'https://my-rpc.example')
    assert.equal(getEndpoints('signet').sequencer, 'https://sas-proxy.bestinslot.xyz')
    assert.equal(getEndpoints('mainnet').rpc, 'https://rpc.brc20.build')
  })

  it('reads the selected network when no network is passed', async () => {
    const { getEndpoints, setEndpoints, setNetwork } = await fresh()
    setEndpoints({ signet: { indexer: 'https://indexer.example' } })
    setNetwork('signet')
    assert.equal(getEndpoints().indexer, 'https://indexer.example')
  })

  it('replaces earlier overrides, and {} restores the defaults', async () => {
    const { getEndpoints, setEndpoints } = await fresh()
    setEndpoints({ mainnet: { rpc: 'https://a.example' } })
    setEndpoints({ mainnet: { tx: 'https://b.example' } })
    assert.equal(getEndpoints('mainnet').rpc, 'https://rpc.brc20.build')
    assert.equal(getEndpoints('mainnet').tx, 'https://b.example')

    setEndpoints({})
    assert.equal(getEndpoints('mainnet').tx, 'https://ts-proxy.bestinslot.xyz/v3/mainnet')
  })

  it('lets testnet use a configured sequencer', async () => {
    const { getSwapBackendUrl, setEndpoints, setNetwork } = await fresh()
    setEndpoints({ testnet: { sequencer: 'https://seq.example/' } })
    setNetwork('testnet')
    assert.equal(await getSwapBackendUrl('status'), 'https://seq.example/status')
  })

  it('rejects unknown networks, unknown keys and non-http URLs', async () => {
    const { setEndpoints } = await fresh()
    assert.throws(() => setEndpoints({ regtest: {} } as never), /unknown network 'regtest'/)
    assert.throws(
      () => setEndpoints({ mainnet: { indexr: 'https://x.example' } } as never),
      /unknown endpoint 'indexr'/
    )
    assert.throws(() => setEndpoints({ mainnet: { rpc: 'not a url' } }), /not a valid URL/)
    assert.throws(() => setEndpoints({ mainnet: { rpc: 'ftp://x.example' } }), /http\(s\) URL/)
  })
})

describe('route split', () => {
  const READ = 'https://read.example'
  const WRITE = 'https://write.example'

  it('sends display reads to sequencerRead and everything else to sequencer', async () => {
    const { getSwapBackendUrl, setEndpoints } = await fresh()
    setEndpoints({ mainnet: { sequencerRead: READ, sequencer: WRITE } })

    const reads = [
      'get_tokens',
      'get_table_data?limit=10',
      'volume/0xpair?days=7',
      'klines/0xpair?interval=1h&limit=10',
      'tvl/0xpair?days=30',
      'pair-activity/0xpair?limit=10&offset=0',
      'recent-activity',
      'recent-activity?limit=5',
      'wallet-activity/02abc?limit=10',
      'get_token_decimals',
    ]
    for (const path of reads) {
      assert.equal(await getSwapBackendUrl(path), `${READ}/${path}`, path)
    }

    const writes = [
      'status',
      'get_swap_info',
      'get_miner_fee',
      'get_swap_wallet_nonce',
      'get_balance',
      'get_all_balances',
      'get_pair_reserves',
      'get_swap_referrer_info',
      'check_swap_allowance',
      'check_brc20_balance',
      'check_base_brc20_balance',
      'estimate_wrap_gas',
      'get_deposit_signature',
      'deposit',
      'wrap',
      'add_liq_req',
      'remove_liq_req',
      'swap',
      'swap2',
      'withdraw',
      'unwrap',
    ]
    for (const path of writes) {
      assert.equal(await getSwapBackendUrl(path), `${WRITE}/${path}`, path)
    }
  })

  it('splits indexer reads from tx submission', async () => {
    const { broadcastTxes, getTxhex, setEndpoints, validateTxes } = await fresh()
    setEndpoints({ mainnet: { indexer: 'https://idx.example/', tx: 'https://tx.example' } })

    await getTxhex('ab'.repeat(32))
    await validateTxes(['00'])
    await broadcastTxes(['00'])

    assert.deepEqual(fetchedUrls(), [
      `https://idx.example/gettxhex/${'ab'.repeat(32)}`,
      'https://tx.example/testmempoolaccept',
      'https://tx.example/sendrawtransactions',
    ])
  })
})

describe('/v1 network guard', () => {
  const DATA = 'https://signet-api.example/v1/data'
  const INFO = 'https://signet-api.example/v1/info'

  it('checks /v1/info once per origin and proceeds when the network matches', async () => {
    serve({ [INFO]: { network: 'signet', version: '1.0.0' } })
    const { fetchCardinalUtxos, getTxhex, setEndpoints, setNetwork } = await fresh()
    setEndpoints({ signet: { indexer: DATA } })
    setNetwork('signet')

    await fetchCardinalUtxos('tb1qaddr')
    await getTxhex('cd'.repeat(32))

    assert.deepEqual(fetchedUrls(), [
      INFO,
      `${DATA}/cardinal_utxos/tb1qaddr`,
      `${DATA}/gettxhex/${'cd'.repeat(32)}`,
    ])
  })

  it('throws before the request when the service serves another network', async () => {
    serve({ [INFO]: { network: 'mainnet', version: '1.0.0' } })
    const { fetchCardinalUtxos, setEndpoints, setNetwork } = await fresh()
    setEndpoints({ signet: { indexer: DATA } })
    setNetwork('signet')

    await expectRejects(
      fetchCardinalUtxos('tb1qaddr'),
      /signet-api\.example serves 'mainnet', but the selected network is 'signet'/
    )
    assert.deepEqual(fetchedUrls(), [INFO])
  })

  it('surfaces a mismatch on tx submission instead of returning null', async () => {
    serve({ [INFO]: { network: 'mainnet' } })
    const { broadcastTxes, setEndpoints, setNetwork } = await fresh()
    setEndpoints({ signet: { tx: 'https://signet-api.example/v1/tx' } })
    setNetwork('signet')

    await expectRejects(broadcastTxes(['00']), /serves 'mainnet'/)
  })

  it('retries the lookup after a failed /v1/info request', async () => {
    let calls = 0
    fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === INFO && calls++ === 0)
        return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({}) }
      const body = String(url) === INFO ? { network: 'signet' } : { data: [] }
      return { ok: true, status: 200, statusText: 'OK', json: async () => body }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchCardinalUtxos, setEndpoints, setNetwork } = await fresh()
    setEndpoints({ signet: { indexer: DATA } })
    setNetwork('signet')

    await expectRejects(fetchCardinalUtxos('tb1qaddr'), /Could not read .*\/v1\/info/)
    await fetchCardinalUtxos('tb1qaddr')
    assert.deepEqual(fetchedUrls(), [INFO, INFO, `${DATA}/cardinal_utxos/tb1qaddr`])
  })
})

async function expectRejects(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise
  } catch (error) {
    assert.match(String(error instanceof Error ? error.message : error), pattern)
    return
  }
  assert.fail(`expected rejection matching ${pattern}`)
}
