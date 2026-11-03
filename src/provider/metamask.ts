import type { BitcoinWalletBackend } from './bitcoin-wallet'
import { Buffer } from 'node:buffer'
import { getDefaultTransport, getMultichainClient } from '@metamask/multichain-api-client'
import { getNetwork } from '../core/store-network'
import { createBitcoinWalletProvider } from './bitcoin-wallet'
import { findBitcoinStandardWallet, standardWalletBackend } from './wallet-standard'

// MetaMask's CAIP-2 scopes for Bitcoin (BIP-122 genesis hashes); it has none for signet.
const SCOPES: Record<string, `bip122:${string}`> = {
  mainnet: 'bip122:000000000019d6689c085ae165831e93',
  testnet: 'bip122:000000000933ea01ad0ee984209779ba',
}

type SignPsbt = (call: {
  scope: string
  request: {
    method: 'signPsbt'
    params: {
      psbt: string
      options: { fill: boolean; broadcast: boolean }
      account: { address: string }
    }
  }
}) => Promise<{ psbt: string }>

let invoke: SignPsbt | undefined

/**
 * Signs `psbt` as built. MetaMask's Wallet Standard `bitcoin:signTransaction` always asks
 * `signPsbt` to fill the PSBT, which rebuilds the transaction from MetaMask's own UTXOs and fee
 * rate, keeping only the outputs; so the kit calls the same Multichain API method with
 * `fill: false`, on the session MetaMask's Wallet Standard connect opened.
 */
async function signPsbtAsBuilt(address: string, psbt: Uint8Array): Promise<Uint8Array> {
  const scope = SCOPES[getNetwork()]
  if (!scope) throw new Error(`MetaMask does not support Bitcoin ${getNetwork()}.`)
  if (!invoke) {
    // The client's default RPC types cover EVM methods only; Bitcoin's signPsbt is typed here.
    const client = getMultichainClient({ transport: getDefaultTransport() })
    invoke = client.invokeMethod.bind(client) as unknown as SignPsbt
  }
  const result = await invoke({
    scope,
    request: {
      method: 'signPsbt',
      params: {
        psbt: Buffer.from(psbt).toString('base64'),
        options: { fill: false, broadcast: false },
        account: { address },
      },
    },
  })
  return Buffer.from(result.psbt, 'base64')
}

/**
 * MetaMask's Bitcoin account: it connects and signs messages through the Bitcoin Wallet Standard,
 * and signs PSBTs through MetaMask's Multichain API (see `signPsbtAsBuilt`), one prompt each.
 * MetaMask gives one payment address and no public key, so it connects as a single-address wallet
 * and its key is read from a message signature; its chains are mainnet, testnet and regtest, not
 * signet.
 */
export const METAMASK = createBitcoinWalletProvider('MetaMask', (): BitcoinWalletBackend | null => {
  const wallet = findBitcoinStandardWallet(/metamask/i)
  if (!wallet) return null
  return {
    ...standardWalletBackend(wallet),
    signPsbts: async requests => {
      const signed: Uint8Array[] = []
      for (const r of requests) {
        // The wallet signs every input it owns; MetaMask has one address, so that is r's.
        const address = r.inputs[0]?.address ?? wallet.accounts[0]?.address
        if (!address) throw new Error('MetaMask has no connected account.')
        signed.push(await signPsbtAsBuilt(address, r.psbt))
      }
      return signed
    },
    signsManyAtOnce: false,
  }
})
