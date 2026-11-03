// @vitest-environment jsdom
import { Buffer } from 'node:buffer'
import { getWallets } from '@wallet-standard/app'
import * as bitcoinjs from 'bitcoinjs-lib'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { txHexByIdCache } from '../../src/core/helpers.ts'
import { setNetwork } from '../../src/core/store-network.ts'
import { METAMASK, withPreviousTxs } from '../../src/provider/metamask.ts'

const invokeMethod = vi.fn(async (call: { request: { params: { psbt: string } } }) => ({
  psbt: call.request.params.psbt,
}))

vi.mock('@metamask/multichain-api-client', () => ({
  getDefaultTransport: () => ({}),
  getMultichainClient: () => ({ invokeMethod }),
}))

const address = 'bc1qmetamaskaccount'
const P2WPKH = Buffer.concat([Buffer.from('0014', 'hex'), Buffer.alloc(20, 1)])
const P2TR = Buffer.concat([Buffer.from('5120', 'hex'), Buffer.alloc(32, 2)])

// A cached previous tx paying `script`, and a PSBT spending its output 0 with witnessUtxo only.
function spending(scripts: Buffer[]) {
  const psbt = new bitcoinjs.Psbt()
  const prevs = scripts.map((script, n) => {
    const prev = new bitcoinjs.Transaction()
    prev.addInput(Buffer.alloc(32, 10 + n), 0)
    prev.addOutput(script, 10000)
    txHexByIdCache[prev.getId()] = prev.toHex()
    psbt.addInput({ hash: prev.getId(), index: 0, witnessUtxo: { script, value: 10000 } })
    return prev
  })
  psbt.addOutput({ script: P2WPKH, value: 9000 })
  return { psbt, prevs }
}

describe('mETAMASK', () => {
  let unregister: () => void

  beforeAll(() => {
    setNetwork('mainnet')
    unregister = getWallets().register({
      version: '1.0.0',
      name: 'MetaMask',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      chains: ['bitcoin:mainnet'],
      accounts: [
        { address, publicKey: new Uint8Array(), chains: ['bitcoin:mainnet'], features: [] },
      ],
      features: {
        'bitcoin:connect': { connect: async () => ({ accounts: [] }) },
        'bitcoin:signTransaction': {
          signTransaction: () => {
            throw new Error('bitcoin:signTransaction would fill (rebuild) the PSBT')
          },
        },
        'bitcoin:signMessage': { signMessage: async () => [] },
      } as never,
    })
  })

  afterEach(() => invokeMethod.mockClear())
  afterAll(() => unregister())

  it('signs a PSBT as built through the Multichain API, never filling it', async () => {
    const { psbt } = spending([P2WPKH])
    await METAMASK.signPSBT(psbt.toBase64(), false, [{ address, signingIndexes: [0] }])
    const call = invokeMethod.mock.calls[0]![0] as {
      scope: string
      request: { method: string; params: Record<string, unknown> }
    }
    expect(call.scope).toBe('bip122:000000000019d6689c085ae165831e93')
    expect(call.request.method).toBe('signPsbt')
    expect(call.request.params.options).toEqual({ fill: false, broadcast: false })
    expect(call.request.params.account).toEqual({ address })
  })

  it('adds the previous tx to SegWit v0 inputs, which BDK needs, and leaves taproot ones', async () => {
    const { psbt, prevs } = spending([P2WPKH, P2TR])
    const filled = bitcoinjs.Psbt.fromBuffer(Buffer.from(await withPreviousTxs(psbt.toBuffer())))
    expect(filled.data.inputs[0]!.nonWitnessUtxo?.toString('hex')).toBe(prevs[0]!.toHex())
    expect(filled.data.inputs[1]!.nonWitnessUtxo).toBeUndefined()
  })

  it('signs one PSBT per prompt, so the kit signs a commit before building on it', () => {
    expect(METAMASK.getSignMany?.()).toBeNull()
  })
})
