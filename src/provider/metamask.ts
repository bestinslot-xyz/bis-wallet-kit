import type { BitcoinWalletBackend } from './bitcoin-wallet'
import { Buffer } from 'node:buffer'
import { getDefaultTransport, getMultichainClient } from '@metamask/multichain-api-client'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getTxhex } from '../core/helpers'
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
 * `psbt` with each SegWit v0 input carrying its previous transaction (`nonWitnessUtxo`) beside the
 * spent output. MetaMask signs with BDK, which refuses a SegWit v0 input without it
 * (`trust_witness_utxo` is off), and then reports the PSBT as not finalized. The kit's own unbroadcast
 * txs (a package's commit and reveals) come from the tx cache `saveExtraUtxos` fills.
 */
export async function withPreviousTxs(psbt: Uint8Array): Promise<Uint8Array> {
  const parsed = bitcoinjs.Psbt.fromBuffer(Buffer.from(psbt))
  for (const [i, input] of parsed.data.inputs.entries()) {
    if (input.nonWitnessUtxo || input.witnessUtxo?.script[0] !== 0x00) continue
    const txid = Buffer.from(parsed.txInputs[i]!.hash).reverse().toString('hex')
    parsed.updateInput(i, { nonWitnessUtxo: Buffer.from(await getTxhex(txid), 'hex') })
  }
  return parsed.toBuffer()
}

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
        signed.push(await signPsbtAsBuilt(address, await withPreviousTxs(r.psbt)))
      }
      return signed
    },
    signsManyAtOnce: false,
  }
})
