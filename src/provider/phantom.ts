import type { BitcoinWalletAccount, BitcoinWalletBackend } from './bitcoin-wallet'
import { Buffer } from 'node:buffer'
import { createBitcoinWalletProvider } from './bitcoin-wallet'
import { findBitcoinStandardWallet, standardWalletBackend } from './wallet-standard'

/** Phantom's injected `window.phantom.bitcoin`, which Phantom deprecated in favour of the Wallet Standard. */
interface PhantomInjectedBitcoin {
  isPhantom?: boolean
  requestAccounts: () => Promise<
    { address: string; publicKey: string; purpose: 'payment' | 'ordinals' }[]
  >
  signMessage: (address: string, message: Uint8Array) => Promise<{ signature: Uint8Array }>
  signPSBT: (
    psbt: Uint8Array,
    options: { inputsToSign: { address: string; signingIndexes: number[] }[] }
  ) => Promise<Uint8Array | string>
  on?: (event: 'accountsChanged', handler: (accounts: { address: string }[]) => void) => void
  removeListener?: (
    event: 'accountsChanged',
    handler: (accounts: { address: string }[]) => void
  ) => void
}

/** A signed PSBT as Phantom returns it: bytes, or a hex or base64 string. */
function psbtBytes(signed: Uint8Array | string): Uint8Array {
  if (typeof signed !== 'string') return signed
  return /^[0-9a-f]+$/i.test(signed) ? Buffer.from(signed, 'hex') : Buffer.from(signed, 'base64')
}

/** A `BitcoinWalletBackend` over the injected provider; it signs one PSBT per wallet request. */
function injectedBackend(provider: PhantomInjectedBitcoin): BitcoinWalletBackend {
  let addresses: string[] = []
  return {
    connect: async (): Promise<BitcoinWalletAccount[]> => {
      const accounts = await provider.requestAccounts()
      addresses = accounts.map(a => a.address)
      return accounts.map(a => ({
        address: a.address,
        publicKey: a.publicKey || null,
        purpose: a.purpose,
      }))
    },
    accounts: () => addresses,
    onAccountsChanged: handler => {
      if (!provider.on) return () => {}
      const listener = (accounts: { address: string }[]) => {
        addresses = (accounts ?? []).map(a => a.address)
        handler(addresses)
      }
      provider.on('accountsChanged', listener)
      return () => provider.removeListener?.('accountsChanged', listener)
    },
    signMessage: async (address, message) =>
      (await provider.signMessage(address, message)).signature,
    signPsbts: async requests => {
      const signed: Uint8Array[] = []
      for (const r of requests) {
        signed.push(psbtBytes(await provider.signPSBT(r.psbt, { inputsToSign: r.inputs })))
      }
      return signed
    },
    signsManyAtOnce: false,
  }
}

function phantomBackend(): BitcoinWalletBackend | null {
  const standard = findBitcoinStandardWallet(/phantom/i)
  if (standard) return standardWalletBackend(standard)
  if (typeof window === 'undefined') return null
  const injected = window.phantom?.bitcoin as PhantomInjectedBitcoin | undefined
  return injected?.isPhantom ? injectedBackend(injected) : null
}

/** Phantom, through the Bitcoin Wallet Standard, or its injected provider while it still ships one. */
export const PHANTOM = createBitcoinWalletProvider('Phantom', phantomBackend)
