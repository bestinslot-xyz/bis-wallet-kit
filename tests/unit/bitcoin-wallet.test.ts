import type { Wallet, WalletAccount } from '@wallet-standard/base'
import type { BitcoinWalletBackend } from '../../src/provider/bitcoin-wallet.ts'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import * as bitcoinMessage from 'bitcoinjs-message'
import { ECPairFactory } from 'ecpair'
import * as tinysecp from 'tiny-secp256k1'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { getOrdinalsWallet, getPaymentWallet } from '../../src/core/providers.ts'
import { setNetwork } from '../../src/core/store-network.ts'
import { saveWalletInfo } from '../../src/core/store.ts'
import {
  createBitcoinWalletProvider,
  publicKeyFromSignature,
} from '../../src/provider/bitcoin-wallet.ts'
import { standardWalletBackend } from '../../src/provider/wallet-standard.ts'

const network = bitcoinjs.networks.testnet
const key = ECPairFactory(tinysecp).makeRandom({ network })
const pubkey = Buffer.from(key.publicKey)
const address = bitcoinjs.payments.p2wpkh({ pubkey, network }).address!

beforeAll(() => setNetwork('testnet'))

const legacySign = (message: string) =>
  bitcoinMessage.sign(message, Buffer.from(key.privateKey!), true, network.messagePrefix)

describe('publicKeyFromSignature', () => {
  it('recovers the key from a legacy 65-byte signature', () => {
    expect(publicKeyFromSignature('hi', legacySign('hi'), address)).toBe(pubkey.toString('hex'))
  })

  it('reads the key from a BIP-322 simple witness', () => {
    const witness = Buffer.concat([
      Buffer.from([2, 72]),
      Buffer.alloc(72, 1),
      Buffer.from([33]),
      pubkey,
    ])
    expect(publicKeyFromSignature('hi', witness, address)).toBe(pubkey.toString('hex'))
  })

  it('returns null when the key does not pay the address', () => {
    const other = ECPairFactory(tinysecp).makeRandom({ network })
    const otherAddress = bitcoinjs.payments.p2wpkh({
      pubkey: Buffer.from(other.publicKey),
      network,
    }).address!
    expect(publicKeyFromSignature('hi', legacySign('hi'), otherAddress)).toBeNull()
  })
})

function fakeBackend(overrides: Partial<BitcoinWalletBackend> = {}): BitcoinWalletBackend {
  return {
    connect: async () => [{ address, publicKey: null, purpose: 'payment' }],
    accounts: () => [address],
    onAccountsChanged: () => () => {},
    signMessage: async (_address, message) => legacySign(Buffer.from(message).toString('utf8')),
    // Signs every input with the test key, as a wallet holding one address would.
    signPsbts: async requests =>
      requests.map(r => {
        const psbt = bitcoinjs.Psbt.fromBuffer(Buffer.from(r.psbt))
        psbt.signAllInputs({ publicKey: pubkey, sign: h => Buffer.from(key.sign(h)) })
        return psbt.toBuffer()
      }),
    signsManyAtOnce: true,
    ...overrides,
  }
}

// A P2WPKH spend of a 10k-sat output paying `address`.
function unsignedPsbtHex(): string {
  const psbt = new bitcoinjs.Psbt({ network })
  const script = bitcoinjs.payments.p2wpkh({ pubkey, network }).output!
  psbt.addInput({ hash: Buffer.alloc(32, 3), index: 0, witnessUtxo: { script, value: 10000 } })
  psbt.addOutput({ script, value: 9000 })
  return psbt.toHex()
}

describe('session wallet lookup', () => {
  it("serves both roles from a single-address session's 'all' wallet, whatever the provider", () => {
    const wallet = { address, pubkey: pubkey.toString('hex'), purpose: 'all' as const }
    saveWalletInfo({ provider: 'metamask', wallets: [wallet], signature: null })
    expect(getPaymentWallet()).toEqual(wallet)
    expect(getOrdinalsWallet()).toEqual(wallet)
  })

  it('keeps the payment and ordinals wallets of a split session apart', () => {
    const payment = { address, pubkey: 'aa', purpose: 'payment' as const }
    const ordinals = { address: 'tb1pordinals', pubkey: 'bb', purpose: 'ordinals' as const }
    saveWalletInfo({ provider: 'xverse', wallets: [payment, ordinals], signature: null })
    expect(getPaymentWallet()).toEqual(payment)
    expect(getOrdinalsWallet()).toEqual(ordinals)
  })
})

describe('createBitcoinWalletProvider', () => {
  it('connects a payment-only wallet as one address, reading its key from a signature', async () => {
    const signMessage = vi.fn(fakeBackend().signMessage)
    const provider = createBitcoinWalletProvider('Test', () => fakeBackend({ signMessage }))
    expect(await provider.getWallets()).toEqual([
      { address, pubkey: pubkey.toString('hex'), purpose: 'all' },
    ])
    expect(signMessage).toHaveBeenCalledOnce()
  })

  it('keeps separate payment and ordinals accounts and their keys', async () => {
    const backend = fakeBackend({
      connect: async () => [
        { address, publicKey: 'aa', purpose: 'payment' },
        { address: 'tb1pordinals', publicKey: 'bb', purpose: 'ordinals' },
      ],
    })
    const provider = createBitcoinWalletProvider('Test', () => backend)
    expect(await provider.getWallets()).toEqual([
      { address, pubkey: 'aa', purpose: 'payment' },
      { address: 'tb1pordinals', pubkey: 'bb', purpose: 'ordinals' },
    ])
  })

  it('signs and finalizes a PSBT', async () => {
    const provider = createBitcoinWalletProvider('Test', () => fakeBackend())
    const signed = await provider.sign(unsignedPsbtHex(), address, address, [])
    const tx = bitcoinjs.Transaction.fromHex(signed.signedTxHex)
    expect(tx.getId()).toBe(signed.txId)
    expect(tx.ins[0]!.witness).toHaveLength(2)
  })

  it('offers batch signing only when the wallet signs many PSBTs in one request', () => {
    expect(createBitcoinWalletProvider('A', () => fakeBackend()).getSignMany?.()).toBeTypeOf(
      'function'
    )
    const oneAtATime = fakeBackend({ signsManyAtOnce: false })
    expect(createBitcoinWalletProvider('B', () => oneAtATime).getSignMany?.()).toBeNull()
  })

  it('says the wallet is not installed when there is no backend', async () => {
    await expect(createBitcoinWalletProvider('Ghost', () => null).getWallets()).rejects.toThrow(
      'Ghost is not installed.'
    )
  })
})

function fakeStandardWallet(chains: `${string}:${string}`[]) {
  // MetaMask reports the address bytes as the account's public key.
  const account: WalletAccount = {
    address,
    publicKey: new TextEncoder().encode(address),
    chains,
    features: [],
  }
  const signTransaction = vi.fn(async (...inputs: { psbt: Uint8Array }[]) =>
    inputs.map(i => ({ signedPsbt: i.psbt }))
  )
  const wallet = {
    version: '1.0.0',
    name: 'MetaMask',
    icon: 'data:image/svg+xml;base64,AA==',
    chains,
    accounts: [account],
    features: {
      'bitcoin:connect': { connect: async () => ({ accounts: [account] }) },
      'bitcoin:signTransaction': { signTransaction },
      'bitcoin:signMessage': { signMessage: async () => [{ signature: new Uint8Array(65) }] },
    },
  } as unknown as Wallet
  return { wallet, account, signTransaction }
}

describe('standardWalletBackend', () => {
  it('refuses a network the wallet does not list', async () => {
    const { wallet } = fakeStandardWallet(['bitcoin:mainnet'])
    await expect(standardWalletBackend(wallet).connect()).rejects.toThrow(
      'MetaMask does not support Bitcoin testnet.'
    )
  })

  it('maps one account to a payment account without a usable key', async () => {
    const { wallet } = fakeStandardWallet(['bitcoin:testnet'])
    expect(await standardWalletBackend(wallet).connect()).toEqual([
      { address, publicKey: null, purpose: 'payment' },
    ])
  })

  it('signs several PSBTs in one signTransaction call with the account and chain', async () => {
    const { wallet, account, signTransaction } = fakeStandardWallet(['bitcoin:testnet'])
    const psbts = [new Uint8Array([1]), new Uint8Array([2])]
    const signed = await standardWalletBackend(wallet).signPsbts(
      psbts.map(psbt => ({ psbt, inputs: [{ address, signingIndexes: [0] }] }))
    )
    expect(signed).toEqual(psbts)
    expect(signTransaction).toHaveBeenCalledOnce()
    expect(signTransaction.mock.calls[0]![0]).toEqual({
      psbt: psbts[0],
      inputsToSign: [{ account, signingIndexes: [0] }],
      chain: 'bitcoin:testnet',
    })
  })
})
