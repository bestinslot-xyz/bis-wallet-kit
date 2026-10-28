import { Buffer } from 'node:buffer'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import * as ethers from 'ethers'
import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'
import {
  parseSwapRoute,
  resolveSwapPath,
  swap2OrderSignatureText,
  swapBLSMessage,
  swapOrderSignatureText,
} from '../../src/lib/swap-route.ts'

// The swap backend (SwapSequencer userapi.js / uniswap_ops.js) verifies these
// exact formats, so they are spelled out here independently of the kit's code.

const A = '0x00000000000000000000000000000000000000aa'
const X = '0x00000000000000000000000000000000000000bb'
const B = '0x00000000000000000000000000000000000000cc'
const PUBKEY = 'ab'.repeat(256)
const REFERRER = 'cd'.repeat(256)

function pad64(hex: string): string {
  return hex.padStart(64, '0')
}

// The BIP322 swap texts and BLS messages as the kit built them for a direct
// swap before routing existed, kept verbatim as the byte-identity reference.
function legacySwapText(p: {
  token1_addr: string
  token2_addr: string
  in_amt: string
  min_out_amt: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  referrer_pubkey?: string
  ref_return_bps?: string
}): string {
  return `Swap Order:
Token 1 Address: ${p.token1_addr.toLowerCase()}
Token 2 Address: ${p.token2_addr.toLowerCase()}
Input Amount: ${p.in_amt}
Minimum Output Amount: ${p.min_out_amt}
Token 1 Fee Bps: ${p.token1FeeBps}
Token 2 Fee Bps: ${p.token2FeeBps}
BTC Fee: ${p.btc_fee}
${p.referrer_pubkey ? `Referrer Pubkey: ${p.referrer_pubkey}\n` : ''}${p.ref_return_bps && BigInt(p.ref_return_bps) > 0n ? `Referrer Return Bps: ${p.ref_return_bps}\n` : ''}
By signing this message, you authorize the creation of a swap order with the above parameters.`
}

function legacySwap2Text(p: {
  token1_addr: string
  token2_addr: string
  max_in_amt: string
  out_amt: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  referrer_pubkey?: string
  ref_return_bps?: string
}): string {
  return `Swap Order:
Token 1 Address: ${p.token1_addr.toLowerCase()}
Token 2 Address: ${p.token2_addr.toLowerCase()}
Maximum Input Amount: ${p.max_in_amt}
Output Amount: ${p.out_amt}
Token 1 Fee Bps: ${p.token1FeeBps}
Token 2 Fee Bps: ${p.token2FeeBps}
BTC Fee: ${p.btc_fee}
${p.referrer_pubkey ? `Referrer Pubkey: ${p.referrer_pubkey}\n` : ''}${p.ref_return_bps && BigInt(p.ref_return_bps) > 0n ? `Referrer Return Bps: ${p.ref_return_bps}\n` : ''}
By signing this message, you authorize the creation of a swap order with the above parameters.`
}

function legacyBLSMessage(
  opType: '03' | '04',
  p: {
    nonce: bigint
    token1_addr: string
    token2_addr: string
    amount1: bigint
    amount2: bigint
    token1FeeBps: bigint
    token2FeeBps: bigint
    btc_fee: bigint
    referrer_pubkey?: string
    ref_return_bps?: bigint
  }
): string {
  let msg = ethers.keccak256(Buffer.from(PUBKEY, 'hex')).slice(2)
  msg += p.nonce.toString(16).padStart(8, '0')
  msg += opType
  msg += p.token1_addr.slice(2).padStart(64, '0')
  msg += p.token2_addr.slice(2).padStart(64, '0')
  msg += p.amount1.toString(16).padStart(64, '0')
  msg += p.amount2.toString(16).padStart(64, '0')
  msg += p.token1FeeBps.toString(16).padStart(64, '0')
  msg += p.token2FeeBps.toString(16).padStart(64, '0')
  msg += p.btc_fee.toString(16).padStart(64, '0')
  if (p.referrer_pubkey) {
    msg += ethers.keccak256(Buffer.from(p.referrer_pubkey, 'hex')).slice(2)
    msg += 2500n.toString(16).padStart(8, '0')
    if (p.ref_return_bps && p.ref_return_bps > 0n) {
      msg += p.ref_return_bps.toString(16).padStart(8, '0')
    }
  }
  return msg
}

const REFERRER_CASES = [
  {},
  { referrer_pubkey: REFERRER },
  { referrer_pubkey: REFERRER, ref_return_bps: 0n },
  { referrer_pubkey: REFERRER, ref_return_bps: 1200n },
]

describe('direct swap messages are unchanged', () => {
  // Mixed-case input addresses: the text lowercases them and the BLS bytes are case-blind.
  const T1 = '0x00000000000000000000000000000000000000AA'
  const T2 = B

  for (const ref of REFERRER_CASES) {
    const refText = {
      referrer_pubkey: ref.referrer_pubkey,
      ref_return_bps: ref.ref_return_bps?.toString(),
    }
    const label = JSON.stringify(refText)

    it(`swap1 BIP322 text ${label}`, () => {
      const fields = {
        in_amt: '1000',
        min_out_amt: '990',
        token1FeeBps: '25',
        token2FeeBps: '0',
        btc_fee: '330',
        ...refText,
      }
      assert.equal(
        swapOrderSignatureText({ path: resolveSwapPath(undefined, T1, T2), ...fields }),
        legacySwapText({ token1_addr: T1, token2_addr: T2, ...fields })
      )
    })

    it(`swap2 BIP322 text ${label}`, () => {
      const fields = {
        max_in_amt: '1010',
        out_amt: '1000',
        token1FeeBps: '0',
        token2FeeBps: '25',
        btc_fee: '330',
        ...refText,
      }
      assert.equal(
        swap2OrderSignatureText({ path: resolveSwapPath(undefined, T1, T2), ...fields }),
        legacySwap2Text({ token1_addr: T1, token2_addr: T2, ...fields })
      )
    })

    for (const opType of ['03', '04'] as const) {
      it(`op ${opType} BLS message bytes ${label}`, () => {
        const fields = {
          nonce: 7n,
          amount1: 1000n,
          amount2: 990n,
          token1FeeBps: 25n,
          token2FeeBps: 0n,
          btc_fee: 330n,
          ...ref,
        }
        const built = swapBLSMessage(opType, {
          pubkey: PUBKEY,
          path: resolveSwapPath(undefined, T1, T2),
          ...fields,
        })
        const legacy = legacyBLSMessage(opType, { token1_addr: T1, token2_addr: T2, ...fields })
        assert.ok(Buffer.from(built, 'hex').equals(Buffer.from(legacy, 'hex')))
      })
    }
  }

  it('matches a frozen direct swap1 text', () => {
    assert.equal(
      swapOrderSignatureText({
        path: [A, B],
        in_amt: '1000',
        min_out_amt: '990',
        token1FeeBps: '25',
        token2FeeBps: '0',
        btc_fee: '330',
      }),
      [
        'Swap Order:',
        `Token 1 Address: ${A}`,
        `Token 2 Address: ${B}`,
        'Input Amount: 1000',
        'Minimum Output Amount: 990',
        'Token 1 Fee Bps: 25',
        'Token 2 Fee Bps: 0',
        'BTC Fee: 330',
        '',
        'By signing this message, you authorize the creation of a swap order with the above parameters.',
      ].join('\n')
    )
  })
})

describe('routed swap messages', () => {
  it('swap1 BIP322 text carries the route line after Token 2 Address', () => {
    assert.equal(
      swapOrderSignatureText({
        path: [A, X, B],
        in_amt: '1000',
        min_out_amt: '990',
        token1FeeBps: '25',
        token2FeeBps: '0',
        btc_fee: '330',
        referrer_pubkey: REFERRER,
        ref_return_bps: '1200',
      }),
      [
        'Swap Order:',
        `Token 1 Address: ${A}`,
        `Token 2 Address: ${B}`,
        `Route: ${A} -> ${X} -> ${B}`,
        'Input Amount: 1000',
        'Minimum Output Amount: 990',
        'Token 1 Fee Bps: 25',
        'Token 2 Fee Bps: 0',
        'BTC Fee: 330',
        `Referrer Pubkey: ${REFERRER}`,
        'Referrer Return Bps: 1200',
        '',
        'By signing this message, you authorize the creation of a swap order with the above parameters.',
      ].join('\n')
    )
  })

  it('swap2 BIP322 text carries the lowercased route line', () => {
    assert.equal(
      swap2OrderSignatureText({
        path: [A.toUpperCase().replace('0X', '0x'), X, B],
        max_in_amt: '1010',
        out_amt: '1000',
        token1FeeBps: '0',
        token2FeeBps: '25',
        btc_fee: '330',
      }),
      [
        'Swap Order:',
        `Token 1 Address: ${A}`,
        `Token 2 Address: ${B}`,
        `Route: ${A} -> ${X} -> ${B}`,
        'Maximum Input Amount: 1010',
        'Output Amount: 1000',
        'Token 1 Fee Bps: 0',
        'Token 2 Fee Bps: 25',
        'BTC Fee: 330',
        '',
        'By signing this message, you authorize the creation of a swap order with the above parameters.',
      ].join('\n')
    )
  })

  for (const opType of ['03', '04'] as const) {
    it(`op ${opType} BLS message lists every path address in order`, () => {
      const msg = swapBLSMessage(opType, {
        pubkey: PUBKEY,
        nonce: 7n,
        path: [A, X, B],
        amount1: 1000n,
        amount2: 990n,
        token1FeeBps: 25n,
        token2FeeBps: 0n,
        btc_fee: 330n,
      })
      const expected = [
        ethers.keccak256(Buffer.from(PUBKEY, 'hex')).slice(2),
        '00000007',
        opType,
        pad64(A.slice(2)),
        pad64(X.slice(2)),
        pad64(B.slice(2)),
        pad64(1000n.toString(16)),
        pad64(990n.toString(16)),
        pad64(25n.toString(16)),
        pad64('0'),
        pad64(330n.toString(16)),
      ].join('')
      assert.equal(msg, expected)
    })
  }
})

describe('resolveSwapPath', () => {
  it('defaults to the direct path, lowercased', () => {
    assert.deepEqual(resolveSwapPath(undefined, A.toUpperCase().replace('0X', '0x'), B), [A, B])
  })

  it('accepts a 2- or 3-token path from token1 to token2', () => {
    assert.deepEqual(resolveSwapPath([A, B], A, B), [A, B])
    assert.deepEqual(resolveSwapPath([A, X.toUpperCase().replace('0X', '0x'), B], A, B), [A, X, B])
  })

  it('rejects malformed paths', () => {
    const C = '0x00000000000000000000000000000000000000dd'
    assert.throws(() => resolveSwapPath([A], A, B), /2 to 3/)
    assert.throws(() => resolveSwapPath([A, X, C, B], A, B), /2 to 3/)
    assert.throws(() => resolveSwapPath([A, '0x1234', B], A, B), /invalid token address/)
    assert.throws(() => resolveSwapPath([A, A, B], A, B), /repeat/)
    assert.throws(() => resolveSwapPath([X, A, B], A, B), /start at the input token/)
    assert.throws(() => resolveSwapPath([A, X], A, B), /end at the output token/)
  })
})

const RAW_ROUTE = {
  path: [A, X, B],
  amounts: ['1000', '500', '250'],
  hops: [
    {
      pair_address: '0x00000000000000000000000000000000000000E1',
      token_in: A,
      token_out: X,
      amount_in: '1000',
      amount_out: '500',
      lp_fee_bps: 30,
    },
    {
      pair_address: '0x00000000000000000000000000000000000000e2',
      token_in: X,
      token_out: B,
      amount_in: '500',
      amount_out: '250',
      lp_fee_bps: 30,
    },
  ],
  lp_fee_bps_total: 60,
  token1FeeBps: '25',
  token2FeeBps: '0',
}

const ROUTE = {
  path: [A, X, B],
  amounts: [1000n, 500n, 250n],
  hops: [
    {
      pair_address: '0x00000000000000000000000000000000000000e1',
      token_in: A,
      token_out: X,
      amount_in: 1000n,
      amount_out: 500n,
      lp_fee_bps: 30n,
    },
    {
      pair_address: '0x00000000000000000000000000000000000000e2',
      token_in: X,
      token_out: B,
      amount_in: 500n,
      amount_out: 250n,
      lp_fee_bps: 30n,
    },
  ],
  lp_fee_bps_total: 60n,
  token1FeeBps: 25n,
  token2FeeBps: 0n,
}

describe('parseSwapRoute', () => {
  it('converts amounts and fees to bigint', () => {
    assert.deepEqual(parseSwapRoute(RAW_ROUTE, A, B), ROUTE)
  })

  it('rejects a route for other tokens or with mismatched amounts', () => {
    assert.throws(() => parseSwapRoute(RAW_ROUTE, A, X), /end at the output token/)
    assert.throws(
      () => parseSwapRoute({ ...RAW_ROUTE, amounts: ['1000', '250'] }, A, B),
      /do not match its path/
    )
  })
})

// The swap flow end to end against a stubbed backend: what getSwapRoute asks
// for, and what prepareAndSendSwapOrder / prepareAndSendSwap2Order sign and send.

const BLS_PRIVKEY = `0x${'11'.repeat(32)}`
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
const FEE_POLICY = { swap_fee_bps: 25, priority_tokens: [A], min_btc_exposure_sats: '0' }

let requests: { route: string; body: any }[]

function serveBackend(opts: { multiHop: boolean; route?: unknown; routeStatus?: number }) {
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
              wbtc_address: A,
              wbtc_handler_address: 'bc1qhandler',
              fee_policy: FEE_POLICY,
              allow_multi_hop_routes: opts.multiHop,
            },
          })
        case 'get_swap_route':
          return opts.routeStatus === 404
            ? reply(404, { error: 'No pool route can fill this amount.', code: 'PAIR_NOT_FOUND' })
            : reply(200, { success: true, result: opts.route ?? RAW_ROUTE })
        case 'get_pair_reserves':
          return reply(200, {
            success: true,
            result: { reserveA: '1000000', reserveB: '1000000', total_supply: '1000000' },
          })
        case 'get_swap_wallet_nonce':
          return reply(200, { success: true, result: '7' })
        case 'get_miner_fee':
          return reply(200, { success: true, result: '330' })
        case 'swap':
        case 'swap2':
          return reply(200, { success: true })
        default:
          return reply(404, { error: `unexpected ${route}` })
      }
    })
  )
}

function blsSignatureOf(msg: string): string {
  const P = bls12_381.G1.hashToCurve(Buffer.from(msg, 'hex'), {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })
  const sig = bls12_381.shortSignatures.sign(P, Buffer.from(BLS_PRIVKEY.slice(2), 'hex'))
  return `0x${sig.x.toString(16).padStart(128, '0')}${sig.y.toString(16).padStart(128, '0')}`
}

async function freshSwapModule() {
  vi.resetModules()
  return await import('../../src/core/bis_swap.ts')
}

beforeEach(() => {
  signedTexts.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getSwapRoute', () => {
  it('asks the backend for the route and parses it', async () => {
    serveBackend({ multiHop: true })
    const { getSwapRoute } = await freshSwapModule()

    assert.deepEqual(await getSwapRoute(A, B, 1000n), ROUTE)
    const req = requests.find(r => r.route === 'get_swap_route')
    assert.deepEqual(req?.body, { token_in: A, token_out: B, amount: '1000', exact_out: false })
  })

  it('sends exact_out for an exact-output quote', async () => {
    serveBackend({ multiHop: true })
    const { getSwapRoute } = await freshSwapModule()

    await getSwapRoute(A, B, 250n, { exactOut: true })
    const req = requests.find(r => r.route === 'get_swap_route')
    assert.equal(req?.body.exact_out, true)
    assert.equal(req?.body.amount, '250')
  })

  it('rejects a routed path while multi-hop routes are off', async () => {
    serveBackend({ multiHop: false })
    const { getSwapRoute } = await freshSwapModule()

    await getSwapRoute(A, B, 1000n).then(
      () => assert.fail('expected a rejection'),
      error => assert.match(String(error), /multi-hop routes are off/)
    )
  })

  it('surfaces PAIR_NOT_FOUND as a BackendError', async () => {
    serveBackend({ multiHop: true, routeStatus: 404 })
    const { getSwapRoute } = await freshSwapModule()

    const error = await getSwapRoute(A, B, 1000n).catch(e => e)
    // The fresh module graph has its own BackendError class, so match by name.
    assert.equal(error.name, 'BackendError')
    assert.equal(error.code, 'PAIR_NOT_FOUND')
  })
})

describe('swap orders sign and send the path', () => {
  it('a routed exact-input swap signs the route and sends path', async () => {
    serveBackend({ multiHop: true })
    const { prepareAndSendSwapOrder } = await freshSwapModule()

    await prepareAndSendSwapOrder(A, B, 1000n, 250n, 0n, undefined, [A, X, B])

    const order = requests.find(r => r.route === 'swap')!.body
    assert.deepEqual(order.path, [A, X, B])
    assert.equal(order.token1_addr, A)
    assert.equal(order.token2_addr, B)
    assert.include(signedTexts[0]!, `Token 2 Address: ${B}\nRoute: ${A} -> ${X} -> ${B}\n`)
    const msg = swapBLSMessage('03', {
      pubkey: PUBKEY,
      nonce: 7n,
      path: [A, X, B],
      amount1: 1000n,
      amount2: 250n,
      token1FeeBps: BigInt(order.token1FeeBps),
      token2FeeBps: BigInt(order.token2FeeBps),
      btc_fee: 330n,
    })
    assert.equal(order.bls_signature, blsSignatureOf(msg))
    // Every hop's pool is checked, not the (possibly missing) direct pool.
    assert.equal(requests.filter(r => r.route === 'get_pair_reserves').length, 2)
  })

  it('a routed exact-output swap signs the route and sends path', async () => {
    serveBackend({ multiHop: true })
    const { prepareAndSendSwap2Order } = await freshSwapModule()

    await prepareAndSendSwap2Order(A, B, 1000n, 250n, 100n, undefined, [A, X, B])

    const order = requests.find(r => r.route === 'swap2')!.body
    assert.deepEqual(order.path, [A, X, B])
    assert.equal(order.max_in_amt, '1010')
    assert.include(signedTexts[0]!, `Route: ${A} -> ${X} -> ${B}\nMaximum Input Amount: 1010\n`)
    const msg = swapBLSMessage('04', {
      pubkey: PUBKEY,
      nonce: 7n,
      path: [A, X, B],
      amount1: 1010n,
      amount2: 250n,
      token1FeeBps: BigInt(order.token1FeeBps),
      token2FeeBps: BigInt(order.token2FeeBps),
      btc_fee: 330n,
    })
    assert.equal(order.bls_signature, blsSignatureOf(msg))
  })

  it('a direct swap sends no path and signs the legacy messages', async () => {
    serveBackend({ multiHop: true })
    const { prepareAndSendSwapOrder } = await freshSwapModule()

    await prepareAndSendSwapOrder(A, B, 1000n, 250n, 0n, undefined, [A, B])

    const order = requests.find(r => r.route === 'swap')!.body
    assert.notProperty(order, 'path')
    assert.equal(
      signedTexts[0],
      legacySwapText({
        token1_addr: A,
        token2_addr: B,
        in_amt: '1000',
        min_out_amt: '250',
        token1FeeBps: order.token1FeeBps,
        token2FeeBps: order.token2FeeBps,
        btc_fee: '330',
      })
    )
    const legacy = legacyBLSMessage('03', {
      nonce: 7n,
      token1_addr: A,
      token2_addr: B,
      amount1: 1000n,
      amount2: 250n,
      token1FeeBps: BigInt(order.token1FeeBps),
      token2FeeBps: BigInt(order.token2FeeBps),
      btc_fee: 330n,
    })
    assert.equal(order.bls_signature, blsSignatureOf(legacy))
  })

  it('refuses a routed path while multi-hop routes are off, before signing', async () => {
    serveBackend({ multiHop: false })
    const { prepareAndSendSwapOrder } = await freshSwapModule()

    await prepareAndSendSwapOrder(A, B, 1000n, 250n, 0n, undefined, [A, X, B]).then(
      () => assert.fail('expected a rejection'),
      error => assert.match(String(error), /does not accept multi-hop routes/)
    )
    assert.equal(signedTexts.length, 0)
    assert.isUndefined(requests.find(r => r.route === 'swap'))
  })
})
