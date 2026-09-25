import { Buffer } from 'node:buffer'
import { afterEach, assert, describe, it, vi } from 'vitest'
import { XVERSE } from '../../src/provider/xverse.ts'

const ADDRESS = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'

function decodePayload(token: string) {
  const [, payload] = token.split('.')
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
}

describe('xverse signMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks Xverse to sign with the wallet address, not the wallet type', async () => {
    const signMessage = vi.fn(async () => Buffer.from('sig').toString('base64'))
    vi.stubGlobal('window', { XverseProviders: { BitcoinProvider: { signMessage } } })

    await XVERSE.signMessage('gm', 'payment', ADDRESS)

    const request = decodePayload(signMessage.mock.calls[0]![0] as string)
    assert.equal(request.address, ADDRESS)
    assert.equal(request.message, 'gm')
  })
})
