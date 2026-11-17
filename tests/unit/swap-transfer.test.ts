import { Buffer } from 'node:buffer'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'
import {
  swapPubkeyHash,
  transferBLSMessage,
  transferOrderSignatureText,
} from '../../src/lib/swap-transfer.ts'

// The swap backend (SwapSequencer transfer_ops.js) and the contract (BiS_Swap.transferMessage)
// verify these exact formats, so they are spelled out here independently of the kit's code.

const TOKEN = '0x2222222222222222222222222222222222222222'
const PUBKEY = 'ab'.repeat(256)
const RECIPIENT_PUBKEY = 'cd'.repeat(256)
const BLS_PRIVKEY = `0x${'11'.repeat(32)}`
const SIGNET_CONTRACT = '0xf41B09041DC546F0466D6F74cda81971012B589D'
const MAINNET_CONTRACT = '0x62879BB3dD949c4CF06f71BF7c281DcF24D163e7'

describe('transfer message formats', () => {
  // The same hex SwapSequencer's test/transfer_ops.test.js and SequencedSwapContract's
  // test/Transfer.t.sol (test_TransferMessage_GoldenBytes) pin.
  it('packs the BLS message as the contract does', () => {
    const msg = transferBLSMessage({
      chainId: 0x425243323073n,
      contractAddress: SIGNET_CONTRACT,
      fromPubkey: 'aa'.repeat(256),
      nonce: 7n,
      tokenAddress: TOKEN,
      toPubkey: `0x${'bb'.repeat(256)}`,
      amt: 5n * 10n ** 18n,
      btcFee: 1000n,
    })
    assert.equal(
      msg.toString('hex'),
      '4249535f535741505f5452414e53464552' +
        '0000000000000000000000000000000000000000000000000000425243323073' +
        'f41b09041dc546f0466d6f74cda81971012b589d' +
        'af5a53a0f9c13b47fdc31663e904a28cfddeef555c0e82b4432a3b0ca7de0a84' +
        '00000007' +
        '08' +
        '2222222222222222222222222222222222222222' +
        'b08ec124abe86135cbad1f5e91a84d868cc19a46f6fea3373bbcc7f3338e2447' +
        '0000000000000000000000000000000000000000000000004563918244f40000' +
        '00000000000000000000000000000000000000000000000000000000000003e8'
    )
  })

  it('writes the order text the backend verifies', () => {
    assert.equal(
      transferOrderSignatureText({
        toBtcAddress: 'tb1qrecipient',
        tokenAddress: TOKEN.toUpperCase().replace('0X', '0x'),
        amt: 5n,
        btcFee: 330n,
      }),
      `Transfer Order:
Recipient Address: tb1qrecipient
Token Address: ${TOKEN}
Amount: 5
Token 1 Fee Bps: 0
Token 2 Fee Bps: 0
BTC Fee: 330

By signing this message, you authorize the creation of a transfer order with the above parameters.`
    )
  })
})

// The transfer flow end to end against a stubbed backend.

const signedTexts: string[] = []

vi.mock('../../src/core/providers.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/providers.ts')>()),
  getOrdinalsWallet: () => ({ address: 'bc1pordinals' }),
  signMessageLocalVerify: async (text: string) => {
    signedTexts.push(text)
    return 'bip322sig'
  },
}))

vi.mock('../../src/core/store.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/store.ts')>()),
  readSwapWalletInfo: async () => ({
    bitcoinAddress: 'bc1pordinals',
    swapPubkey: `0x${PUBKEY}`,
    swapPrivkey: BLS_PRIVKEY,
  }),
}))

const SWAP_BASE = 'https://sa-proxy.bestinslot.xyz'
let requests: { route: string; body: any }[]

interface BackendOpts {
  allowTransfers?: unknown
  recipient?: unknown
}

function serveBackend(opts: BackendOpts) {
  requests = []
  const reply = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const route = String(url).slice(SWAP_BASE.length + 1)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ route, body })
      switch (route) {
        case 'get_swap_info':
          return reply(200, {
            success: true,
            result: {
              factory_address: '0x0000000000000000000000000000000000001234',
              wbtc_address: '0x00000000000000000000000000000000000000aa',
              wbtc_handler_address: 'bc1qhandler',
              fee_policy: { swap_fee_bps: 25, priority_tokens: [], min_btc_exposure_sats: '0' },
              ...(opts.allowTransfers === undefined
                ? {}
                : { allow_transfers: opts.allowTransfers }),
            },
          })
        case 'get_transfer_recipient':
          return reply(200, {
            success: true,
            result: opts.recipient ?? {
              registered: true,
              exiting: false,
              pubkey: `0x${RECIPIENT_PUBKEY}`,
            },
          })
        case 'get_swap_wallet_nonce':
          return reply(200, { success: true, result: '7' })
        case 'get_miner_fee':
          return reply(200, { success: true, result: '330' })
        case 'transfer':
          return reply(200, { success: true })
        default:
          return reply(404, { error: `unexpected ${route}` })
      }
    })
  )
}

async function freshSwapModule() {
  vi.resetModules()
  return await import('../../src/core/bis_swap.ts')
}

async function rejection(p: Promise<unknown>): Promise<string> {
  return await p.then(
    () => assert.fail('expected a rejection'),
    error => String(error)
  )
}

beforeEach(() => {
  signedTexts.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getTransferRecipient', () => {
  it('reports a registered recipient with its pubkey', async () => {
    serveBackend({})
    const { getTransferRecipient } = await freshSwapModule()
    assert.deepEqual(await getTransferRecipient('  bc1precipient '), {
      registered: true,
      exiting: false,
      pubkey: `0x${RECIPIENT_PUBKEY}`,
    })
    assert.deepEqual(requests.at(-1), {
      route: 'get_transfer_recipient',
      body: { btc_address: 'bc1precipient' },
    })
  })

  it('reads an unknown address, or one without a pubkey, as unregistered', async () => {
    for (const recipient of [
      { registered: false, exiting: false, pubkey: null },
      { registered: true, exiting: false },
    ]) {
      serveBackend({ recipient })
      const { getTransferRecipient } = await freshSwapModule()
      assert.equal((await getTransferRecipient('bc1precipient')).registered, false)
    }
  })

  it('rejects an empty address before any request', async () => {
    serveBackend({})
    const { getTransferRecipient } = await freshSwapModule()
    assert.match(await rejection(getTransferRecipient('  ')), /empty/)
    assert.equal(requests.length, 0)
  })
})

describe('prepareAndSendTransferOrder', () => {
  it('signs the order text and the mainnet contract message, then sends the transfer', async () => {
    serveBackend({ allowTransfers: true })
    const { prepareAndSendTransferOrder } = await freshSwapModule()

    assert.deepEqual(
      await prepareAndSendTransferOrder(
        TOKEN.toUpperCase().replace('0X', '0x'),
        ' bc1precipient',
        1000n
      ),
      {
        success: true,
      }
    )

    assert.deepEqual(signedTexts, [
      transferOrderSignatureText({
        toBtcAddress: 'bc1precipient',
        tokenAddress: TOKEN,
        amt: 1000n,
        btcFee: 330n,
      }),
    ])
    const msg = transferBLSMessage({
      chainId: 0x4252433230n,
      contractAddress: MAINNET_CONTRACT,
      fromPubkey: PUBKEY,
      nonce: 7n,
      tokenAddress: TOKEN,
      toPubkey: RECIPIENT_PUBKEY,
      amt: 1000n,
      btcFee: 330n,
    })
    const P = bls12_381.G1.hashToCurve(msg, { DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_' })
    const sig = bls12_381.shortSignatures.sign(P, Buffer.from(BLS_PRIVKEY.slice(2), 'hex'))

    const sent = requests.find(r => r.route === 'transfer')
    assert.deepEqual(sent?.body, {
      pubkey: `0x${PUBKEY}`,
      to_btc_address: 'bc1precipient',
      token_addr: TOKEN,
      amt: '1000',
      bls_signature: `0x${sig.x.toString(16).padStart(128, '0')}${sig.y.toString(16).padStart(128, '0')}`,
      token1FeeBps: '0',
      token2FeeBps: '0',
      btc_fee: '330',
      bip322_signature: 'bip322sig',
    })
    assert.equal(requests.find(r => r.route === 'get_miner_fee')?.body.type, 'transfer')
  })

  it('refuses before any prompt while the backend has transfers off or does not serve the flag', async () => {
    for (const allowTransfers of [false, undefined]) {
      serveBackend({ allowTransfers })
      const { prepareAndSendTransferOrder } = await freshSwapModule()
      assert.match(
        await rejection(prepareAndSendTransferOrder(TOKEN, 'bc1precipient', 1n)),
        /not enabled/
      )
      assert.equal(signedTexts.length, 0)
      assert.equal(
        requests.some(r => r.route === 'transfer'),
        false
      )
    }
  })

  it('refuses an unregistered, exiting or own recipient, and a non-positive amount, before any prompt', async () => {
    const cases: [BackendOpts['recipient'] | undefined, bigint, RegExp][] = [
      [{ registered: false, exiting: false, pubkey: null }, 1n, /no swap wallet/],
      [{ registered: true, exiting: true, pubkey: `0x${RECIPIENT_PUBKEY}` }, 1n, /emergency exit/],
      [{ registered: true, exiting: false, pubkey: `0x${PUBKEY.toUpperCase()}` }, 1n, /itself/],
      [undefined, 0n, /positive/],
    ]
    for (const [recipient, amt, error] of cases) {
      serveBackend({ allowTransfers: true, recipient })
      const { prepareAndSendTransferOrder } = await freshSwapModule()
      assert.match(await rejection(prepareAndSendTransferOrder(TOKEN, 'bc1precipient', amt)), error)
      assert.equal(signedTexts.length, 0)
      assert.equal(
        requests.some(r => r.route === 'transfer'),
        false
      )
    }
  })

  it('hashes a pubkey whatever its case or 0x prefix', () => {
    assert.equal(swapPubkeyHash(PUBKEY), swapPubkeyHash(`0x${PUBKEY.toUpperCase()}`))
  })
})
