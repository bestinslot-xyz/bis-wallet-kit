import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base'
import type { BitcoinWalletAccount, BitcoinWalletBackend } from './bitcoin-wallet'
import { Buffer } from 'node:buffer'
import { getWallets } from '@wallet-standard/app'
import { getNetwork } from '../core/store-network'

// Bitcoin Wallet Standard features, named as wallets (MetaMask) register them.
const CONNECT: IdentifierString = 'bitcoin:connect'
const SIGN_TRANSACTION: IdentifierString = 'bitcoin:signTransaction'
const SIGN_MESSAGE: IdentifierString = 'bitcoin:signMessage'
const EVENTS: IdentifierString[] = ['bitcoin:events', 'standard:events']

interface ConnectFeature {
  connect: (input: { purposes: ('payment' | 'ordinals')[] }) => Promise<{
    accounts: readonly WalletAccount[]
  }>
}
interface SignTransactionFeature {
  signTransaction: (
    ...inputs: {
      psbt: Uint8Array
      inputsToSign: { account: WalletAccount; signingIndexes: number[] }[]
      chain?: string
    }[]
  ) => Promise<readonly { signedPsbt: Uint8Array }[]>
}
interface SignMessageFeature {
  signMessage: (
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ) => Promise<readonly { signature: Uint8Array }[]>
}
interface EventsFeature {
  on: (
    event: 'change',
    listener: (properties: { accounts?: readonly WalletAccount[] }) => void
  ) => () => void
}

let registry: ReturnType<typeof getWallets> | undefined

/**
 * The installed wallet whose name matches `name` and that registers the Bitcoin Wallet Standard
 * features the kit signs with, or null. Wallets register as the page loads, so this is read at
 * each use.
 */
export function findBitcoinStandardWallet(name: RegExp): Wallet | null {
  if (typeof window === 'undefined') return null
  registry ??= getWallets()
  return (
    registry
      .get()
      .find(
        w =>
          name.test(w.name) &&
          CONNECT in w.features &&
          SIGN_TRANSACTION in w.features &&
          SIGN_MESSAGE in w.features
      ) ?? null
  )
}

/** A key's hex when `bytes` is a compressed (33-byte) or x-only (32-byte) public key. */
function publicKeyHex(bytes: ArrayLike<number>): string | null {
  return bytes.length === 33 || bytes.length === 32
    ? Buffer.from(Array.from(bytes)).toString('hex')
    : null
}

/**
 * A `BitcoinWalletBackend` over a Bitcoin Wallet Standard wallet. `bitcoin:connect` returns the
 * accounts in the order of the requested purposes; a wallet that returns only one account (as
 * MetaMask does, payment only) is used as a single-address wallet.
 */
export function standardWalletBackend(wallet: Wallet): BitcoinWalletBackend {
  const feature = <T>(name: IdentifierString) => wallet.features[name] as T
  const chain = (): IdentifierString => `bitcoin:${getNetwork()}`
  const account = (address: string): WalletAccount => {
    const match = wallet.accounts.find(a => a.address === address)
    if (!match) throw new Error(`${wallet.name} has no connected account ${address}.`)
    return match
  }

  const connect = async (): Promise<BitcoinWalletAccount[]> => {
    if (!wallet.chains.includes(chain()))
      throw new Error(`${wallet.name} does not support Bitcoin ${getNetwork()}.`)
    const { accounts } = await feature<ConnectFeature>(CONNECT).connect({
      purposes: ['payment', 'ordinals'],
    })
    return accounts.slice(0, 2).map((a, i) => ({
      address: a.address,
      publicKey: publicKeyHex(a.publicKey),
      purpose: i === 0 ? 'payment' : 'ordinals',
    }))
  }

  const events = EVENTS.map(name => wallet.features[name] as EventsFeature | undefined).find(
    Boolean
  )

  return {
    connect,
    accounts: () => wallet.accounts.map(a => a.address),
    onAccountsChanged: handler =>
      events?.on('change', ({ accounts }) => {
        if (accounts) handler(accounts.map(a => a.address))
      }) ?? (() => {}),
    signMessage: async (address, message) => {
      const [out] = await feature<SignMessageFeature>(SIGN_MESSAGE).signMessage({
        account: account(address),
        message,
      })
      if (!out) throw new Error(`${wallet.name} returned no signature.`)
      return out.signature
    },
    signPsbts: async requests => {
      const outputs = await feature<SignTransactionFeature>(SIGN_TRANSACTION).signTransaction(
        ...requests.map(r => ({
          psbt: r.psbt,
          inputsToSign: r.inputs.map(input => ({
            account: account(input.address),
            signingIndexes: input.signingIndexes,
          })),
          chain: chain(),
        }))
      )
      return outputs.map(o => o.signedPsbt)
    },
    signsManyAtOnce: true,
  }
}
