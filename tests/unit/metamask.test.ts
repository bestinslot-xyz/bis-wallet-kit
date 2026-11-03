// @vitest-environment jsdom
import { Buffer } from 'node:buffer'
import { getWallets } from '@wallet-standard/app'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setNetwork } from '../../src/core/store-network.ts'
import { METAMASK } from '../../src/provider/metamask.ts'

const invokeMethod = vi.fn(async (call: { request: { params: { psbt: string } } }) => ({
  psbt: call.request.params.psbt,
}))

vi.mock('@metamask/multichain-api-client', () => ({
  getDefaultTransport: () => ({}),
  getMultichainClient: () => ({ invokeMethod }),
}))

const address = 'bc1qmetamaskaccount'

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

  it('signs a PSBT as built through the Multichain API, never filling it', async () => {
    const psbt = Buffer.from('70736274ff01', 'hex').toString('base64')
    const signedHex = await METAMASK.signPSBT(psbt, false, [{ address, signingIndexes: [0] }])
    expect(signedHex).toBe('70736274ff01')
    expect(invokeMethod).toHaveBeenCalledWith({
      scope: 'bip122:000000000019d6689c085ae165831e93',
      request: {
        method: 'signPsbt',
        params: { psbt, options: { fill: false, broadcast: false }, account: { address } },
      },
    })
  })

  it('signs one PSBT per prompt, so the kit signs a commit before building on it', () => {
    expect(METAMASK.getSignMany?.()).toBeNull()
  })

  afterAll(() => unregister())
})
