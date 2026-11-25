import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'

// The /withdraw POST body, against a stubbed backend. The sequencer reads exactly the three
// brc20_withdraw hex keys, so they are spelled out here independently of the kit's code.

const TOKEN = '0x2222222222222222222222222222222222222222'
const PUBKEY = 'ab'.repeat(256)
const BLS_PRIVKEY = `0x${'11'.repeat(32)}`
const OWN = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const RECIPIENT = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

vi.mock('../../src/core/providers.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/providers.ts')>()),
  getOrdinalsWallet: () => ({ address: OWN }),
  signMessageLocalVerify: async () => 'bip322sig',
}))

vi.mock('../../src/core/store.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/store.ts')>()),
  readSwapWalletInfo: async () => ({
    bitcoinAddress: OWN,
    swapPubkey: `0x${PUBKEY}`,
    swapPrivkey: BLS_PRIVKEY,
  }),
}))

const SWAP_BASE = 'https://sa-proxy.bestinslot.xyz'
let withdrawBodies: any[]

function serveBackend() {
  withdrawBodies = []
  const reply = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const route = String(url).slice(SWAP_BASE.length + 1)
      switch (route) {
        case 'get_swap_info':
          return reply({
            success: true,
            result: {
              factory_address: '0x0000000000000000000000000000000000001234',
              wbtc_address: '0x00000000000000000000000000000000000000aa',
              wbtc_handler_address: 'bc1qhandler',
              fee_policy: { swap_fee_bps: 25, priority_tokens: [], min_btc_exposure_sats: '0' },
            },
          })
        case 'get_swap_wallet_nonce':
          return reply({ success: true, result: '7' })
        case 'get_miner_fee':
          return reply({ success: true, result: '330' })
        case 'withdraw':
          withdrawBodies.push(JSON.parse(String(init?.body)))
          return reply({ success: true })
        default:
          return { ...reply({ error: `unexpected ${route}` }), ok: false, status: 404 }
      }
    })
  )
}

async function freshSwapModule() {
  vi.resetModules()
  return await import('../../src/core/bis_swap.ts')
}

const CHAIN = {
  inscriptionId: 'abc',
  commitTxId: 'c1',
  commitTxHex: '0a0a',
  revealTxId: 'c2',
  revealTxHex: '0b0b',
  sendTxId: 'c3',
  sendTxHex: '0c0c',
  feeSats: 1000,
}

beforeEach(() => {
  serveBackend()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withdraw request body', () => {
  it('carries the held chain hexes to another address', async () => {
    const { prepareAndSendWithdrawOrderToOrdinalWallet } = await freshSwapModule()
    await prepareAndSendWithdrawOrderToOrdinalWallet(TOKEN, RECIPIENT, 5n, {
      brc20Withdraw: CHAIN,
    })
    assert.deepEqual(withdrawBodies[0].brc20_withdraw, {
      commit_txhex: '0a0a',
      reveal_txhex: '0b0b',
      send_txhex: '0c0c',
    })
  })

  it('carries the held chain hexes to the own ordinals wallet', async () => {
    const { prepareAndSendWithdrawOrderToSelfOrdinalWallet } = await freshSwapModule()
    await prepareAndSendWithdrawOrderToSelfOrdinalWallet(TOKEN, 5n, { brc20Withdraw: CHAIN })
    assert.deepEqual(withdrawBodies[0].brc20_withdraw, {
      commit_txhex: '0a0a',
      reveal_txhex: '0b0b',
      send_txhex: '0c0c',
    })
  })

  it('leaves the body unchanged without the option', async () => {
    const { prepareAndSendWithdrawOrderToSelfOrdinalWallet } = await freshSwapModule()
    await prepareAndSendWithdrawOrderToSelfOrdinalWallet(TOKEN, 5n)
    assert.deepEqual(Object.keys(withdrawBodies[0]).sort(), [
      'amt',
      'bip322_signature',
      'bls_signature',
      'btc_fee',
      'pubkey',
      'target_addr',
      'token1FeeBps',
      'token2FeeBps',
      'token_addr',
    ])
    assert.equal('brc20_withdraw' in withdrawBodies[0], false)
  })
})
