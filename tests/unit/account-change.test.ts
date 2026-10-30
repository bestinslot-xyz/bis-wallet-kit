import type { BISProvider } from '../../src/provider/api.ts'
import { Buffer } from 'node:buffer'
import { Signer } from 'bip322-js'
import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setProviders } from '../../src/core/chain-providers.ts'
import { BIP322_VERIFY_PRECOMPILE } from '../../src/core/helpers.ts'
import {
  getWallets,
  registerProvider,
  signMessage,
  signMessageLocalVerify,
  signMessageLocalVerifyDeterministic,
  subscribeToAccountChanges,
  WalletAccountChangedError,
} from '../../src/core/providers.ts'
import { setNetwork } from '../../src/core/store-network.ts'
import { getWalletInfo } from '../../src/core/store.ts'
import { InMemoryBrc20RpcProvider } from './in-memory-providers.ts'

// Fixed test vector (private key 0x1111...11, testnet). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const ADDRESS = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const OTHER = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'

// A fake extension wallet registered as 'unisat'. `active` is the account the
// extension reports; `emit` fires its account-change event.
let active: string[] = [ADDRESS]
let emitAccounts: ((accounts: string[]) => void) | undefined

const fake = {
  getWallets: vi.fn(async () => [{ address: ADDRESS, pubkey: null, purpose: 'all' as const }]),
  getAccounts: vi.fn(async () => active),
  onAccountsChanged: vi.fn((handler: (accounts: string[]) => void) => {
    emitAccounts = handler
    return () => {
      emitAccounts = undefined
    }
  }),
  signMessage: vi.fn(async (message: string) =>
    Buffer.from(Signer.sign(WIF, ADDRESS, message) as string, 'base64').toString('hex')
  ),
  signMessageDeterministic: vi.fn(),
  sendBTC: vi.fn(),
  signPSBT: vi.fn(),
  sign: vi.fn(),
} satisfies BISProvider

beforeAll(() => {
  setNetwork('testnet')
  registerProvider('unisat', fake)
})

beforeEach(async () => {
  active = [ADDRESS]
  vi.clearAllMocks()
  await getWallets('unisat')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pre-sign account check', () => {
  it('signs when the wallet still reports the connected account', async () => {
    const sig = await signMessageLocalVerify('gm', 'payment')
    assert.ok(sig.length > 0)
    expect(fake.signMessage).toHaveBeenCalledOnce()
  })

  it('treats an empty account list (locked wallet) as unknown and signs', async () => {
    active = []
    await expect(signMessageLocalVerify('gm', 'payment')).resolves.toBeTruthy()
  })

  it('rejects with WalletAccountChangedError before signing when the account switched', async () => {
    active = [OTHER]
    const listener = vi.fn()
    const unsubscribe = subscribeToAccountChanges(listener)

    const err = await signMessageLocalVerify('gm', 'payment').catch(e => e)
    assert.instanceOf(err, WalletAccountChangedError)
    assert.equal(err.message, 'Connected wallet account changed. Please reconnect.')
    assert.equal(err.code, 'WALLET_ACCOUNT_CHANGED')
    assert.equal(err.expectedAddress, ADDRESS)
    assert.deepEqual(err.accounts, [OTHER])

    expect(fake.signMessage).not.toHaveBeenCalled()
    assert.equal(getWalletInfo(), null)
    expect(listener).toHaveBeenCalledWith({
      provider: 'unisat',
      previousAddresses: [ADDRESS],
      accounts: [OTHER],
    })
    unsubscribe()
  })

  it('checks signMessage and signMessageLocalVerifyDeterministic too', async () => {
    active = [OTHER]
    await expect(signMessage('gm', 'payment')).rejects.toBeInstanceOf(WalletAccountChangedError)

    await getWallets('unisat')
    await expect(signMessageLocalVerifyDeterministic('gm')).rejects.toBeInstanceOf(
      WalletAccountChangedError
    )
    expect(fake.signMessage).not.toHaveBeenCalled()
    expect(fake.signMessageDeterministic).not.toHaveBeenCalled()
  })
})

describe('signMessage on-chain verification', () => {
  const fetchMock = vi.fn(async () => {
    throw new Error('unexpected HTTP request')
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    setProviders({})
  })

  function useChainVerifier(handler: (method: string, params: unknown[]) => unknown) {
    const rpc = new InMemoryBrc20RpcProvider(handler)
    setProviders({ testnet: { brc20Rpc: rpc } })
    return rpc
  }

  it('rejects when the chain verifier reports the signature invalid', async () => {
    useChainVerifier(() => `0x${'00'.repeat(32)}`)
    await expect(signMessage('gm', 'payment')).rejects.toThrow('Signature verification failed.')
  })

  it('resolves when the chain verifier accepts the signature', async () => {
    const rpc = useChainVerifier(() => `0x${'00'.repeat(31)}01`)
    await expect(signMessage('gm', 'payment')).resolves.toBeTruthy()

    assert.equal(rpc.requests.length, 1)
    const [{ method, params }] = rpc.requests
    assert.equal(method, 'eth_call')
    const [call, block] = params as [{ from: string; to: string; data: string }, string]
    assert.equal(call.to, BIP322_VERIFY_PRECOMPILE)
    assert.equal(block, 'latest')
    // verify(bytes,bytes,bytes), with the message 'gm' among its arguments
    assert.ok(call.data.startsWith('0xde8f50a1'))
    assert.include(call.data, Buffer.from('gm').toString('hex'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects when the node rejects the call', async () => {
    useChainVerifier(() => {
      throw new Error('execution reverted')
    })
    await expect(signMessage('gm', 'payment')).rejects.toThrow('Signature verification failed.')
  })

  it('verifies locally on a network with no BRC2.0 RPC', async () => {
    await expect(signMessage('gm', 'payment')).resolves.toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('subscribeToAccountChanges', () => {
  it('clears the session and notifies listeners when the wallet switches account', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToAccountChanges(listener)

    emitAccounts?.([OTHER])

    assert.equal(getWalletInfo(), null)
    expect(listener).toHaveBeenCalledWith({
      provider: 'unisat',
      previousAddresses: [ADDRESS],
      accounts: [OTHER],
    })
    unsubscribe()
  })

  it('ignores events for the connected account or an empty (locked) list', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToAccountChanges(listener)

    emitAccounts?.([ADDRESS])
    emitAccounts?.([])

    assert.ok(getWalletInfo())
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps notifying other listeners when one throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(() => {
      throw new Error('boom')
    })
    const listener = vi.fn()
    const unsubscribeFailing = subscribeToAccountChanges(failing)
    const unsubscribe = subscribeToAccountChanges(listener)

    expect(() => emitAccounts?.([OTHER])).not.toThrow()

    expect(failing).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledOnce()
    unsubscribeFailing()
    unsubscribe()
  })

  it('releases the wallet event subscription once the session is cleared', () => {
    emitAccounts?.([OTHER])

    assert.equal(emitAccounts, undefined)
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    subscribeToAccountChanges(listener)()

    emitAccounts?.([OTHER])

    expect(listener).not.toHaveBeenCalled()
  })
})
