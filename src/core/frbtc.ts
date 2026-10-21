import type { Brc20SendPart, Brc20SendQuote, ChainStep } from './brc20-send'
import type { SignProgressOptions } from './sign-progress'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { WalletInfo } from '../types/wallet'
import { evmEncodeFunctionCall, getEvmAddressFromBitcoinAddress } from './brc20'
import {
  assertFeeRate,
  assertRecipient,
  callInscription,
  opReturnTarget,
  runChain,
} from './brc20-send'
import { ethCallOnPublicRpc } from './helpers'
import { getOrdinalsWallet } from './providers'
import { getNetwork } from './store-network'

/** Subfrost's frBTC contract on BRC2.0, per network. */
const FRBTC_ADDRESSES: Record<string, string> = {
  mainnet: '0xdbb5b6a1d422fca2813cf486e5f986adb09d8337',
  signet: '0x1eb63d0d0e5a86146b4e1cebc79b1d6e35093288',
}

/**
 * Value of the marker output an unwrap pays the frBTC signer, and the smallest wrap: the dust limit
 * of every standard output type.
 */
export const FRBTC_SIGNER_DUST_SATS = 546
/** Index of the signer output in the send transaction, right after the OP_RETURN target at vout 0. */
const SIGNER_VOUT = 1
/**
 * `wrap()` and `unwrap2()` read their own send transaction through the BRC2.0 tx-details precompile,
 * which charges 400k gas plus 400k per input of that transaction. The call inscription is padded for
 * a send of up to FRBTC_MAX_SEND_INPUTS inputs, and a send that would spend more is refused before
 * broadcast. The rest of the ceiling covers the contract's own work (mint or burn, payment record).
 */
const GAS_PER_BITCOIN_RPC_CALL = 400000
const FRBTC_MAX_SEND_INPUTS = 8
const FRBTC_CALL_GAS_CEILING = GAS_PER_BITCOIN_RPC_CALL * (1 + FRBTC_MAX_SEND_INPUTS) + 400000

const FRBTC_ABI = [
  {
    name: 'wrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'unwrap2',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'vout', type: 'uint256' },
      { name: 'pkscriptRecipient', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getSignerAddress',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes' }],
  },
]

/**
 * Returns the frBTC contract address on the selected network, lowercased.
 *
 * @throws {Error} On a network without frBTC (testnet).
 */
export function getFrBtcAddress(): string {
  const address = FRBTC_ADDRESSES[getNetwork()]
  if (!address) throw new Error(`frBTC is not deployed on ${getNetwork()}`)
  return address
}

/** Reads the output script of the frBTC signer, which receives wrapped BTC and unwrap markers. */
export async function getFrBtcSignerScript(): Promise<Buffer> {
  const result = await ethCallOnPublicRpc(getFrBtcAddress(), FRBTC_ABI, 'getSignerAddress', [])
  // ABI-encoded `bytes`: offset word, length word, then the data.
  const hex = result.startsWith('0x') ? result.slice(2) : result
  const length = Number.parseInt(hex.slice(64, 128), 16)
  if (!Number.isSafeInteger(length) || length === 0)
    throw new Error('frBTC returned no signer address')
  return Buffer.from(hex.slice(128, 128 + length * 2), 'hex')
}

/**
 * Reads the frBTC balance held by a Bitcoin address's BRC2.0 (EVM) address.
 *
 * @param bitcoinAddress - The Bitcoin address whose BRC2.0 balance to read; the ordinals address for a connected wallet.
 * @returns The balance in sats (frBTC has 8 decimals).
 */
export async function getFrBtcBalanceOfAddress(bitcoinAddress: string): Promise<bigint> {
  const result = await ethCallOnPublicRpc(getFrBtcAddress(), FRBTC_ABI, 'balanceOf', [
    getEvmAddressFromBitcoinAddress(bitcoinAddress),
  ])
  return BigInt(result)
}

function assertSats(amount: bigint, min: bigint): void {
  if (typeof amount !== 'bigint' || amount < min)
    throw new Error(`amount must be a bigint of at least ${min} sats`)
}

function assertDryRun(dryRun: boolean): void {
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean')
}

function ordinalsAddress(): string {
  const address = getOrdinalsWallet()?.address
  if (!address) throw new Error('Ordinals wallet not found')
  return address
}

export interface WrapBtcToBrc20ProgArgs extends SignProgressOptions {
  /** BTC to wrap, in sats. The wallet's BRC2.0 address receives the frBTC. */
  amount: bigint
  feeRate: number
  dryRun: boolean
}

export interface UnwrapBtcFromBrc20ProgArgs extends SignProgressOptions {
  /** frBTC to unwrap, in sats, taken from the wallet's BRC2.0 balance. */
  amount: bigint
  /** Bitcoin address the signer pays the BTC to. */
  recipient: string
  feeRate: number
  dryRun: boolean
}

export interface FrBtcResult {
  /** The call inscription's commit, reveal and send transactions. */
  call: Brc20SendPart
  /** Every broadcast transaction id, in chain order. */
  txIds: string[]
}

async function runFrBtcStep(
  step: ChainStep,
  feeRate: number,
  dryRun: boolean,
  options: SignProgressOptions
): Promise<Brc20SendQuote | FrBtcResult> {
  const res = await runChain([step], feeRate, dryRun, options)
  if (!('parts' in res)) return res
  return { call: res.parts[step.name]!, txIds: res.txIds }
}

/**
 * Wraps BTC into frBTC held by the wallet's own BRC2.0 address. One call inscription runs `wrap()` on
 * the frBTC contract, and its send transaction pays `amount` sats to the frBTC signer at vout 1; the
 * contract mints frBTC, less its `premium()` fee, to the inscription's owner, the ordinals address.
 */
export async function wrapBtcToBrc20Prog(
  args: WrapBtcToBrc20ProgArgs
): Promise<Brc20SendQuote | FrBtcResult> {
  const { amount, feeRate, dryRun } = args
  assertDryRun(dryRun)
  assertFeeRate(feeRate)
  assertSats(amount, BigInt(FRBTC_SIGNER_DUST_SATS))
  ordinalsAddress()

  const signerScript = await getFrBtcSignerScript()
  const calldata = evmEncodeFunctionCall(FRBTC_ABI, 'wrap', [])
  return await runFrBtcStep(
    {
      name: 'frBtcWrap',
      inscription: await callInscription(getFrBtcAddress(), calldata, FRBTC_CALL_GAS_CEILING),
      target: opReturnTarget(),
      extraOutputs: [
        { wallet: new WalletInfo(false, signerScript, null, null, null), value: Number(amount) },
      ],
      maxSendInputs: FRBTC_MAX_SEND_INPUTS,
    },
    feeRate,
    dryRun,
    args
  )
}

/**
 * Unwraps frBTC held by the wallet's own BRC2.0 address into BTC paid to `recipient`. One call
 * inscription runs `unwrap2(amount, 1, recipientScript)` on the frBTC contract, and its send
 * transaction pays a 546-sat marker to the frBTC signer at vout 1. The contract burns the frBTC and
 * queues the payment; the signer pays it out in a later Bitcoin transaction.
 *
 * @throws {Error} When the BRC2.0 frBTC balance is below `amount`, before anything is signed.
 */
export async function unwrapBtcFromBrc20Prog(
  args: UnwrapBtcFromBrc20ProgArgs
): Promise<Brc20SendQuote | FrBtcResult> {
  const { amount, recipient, feeRate, dryRun } = args
  assertDryRun(dryRun)
  assertFeeRate(feeRate)
  assertSats(amount, 1n)
  assertRecipient(recipient)

  const balance = await getFrBtcBalanceOfAddress(ordinalsAddress())
  if (balance < amount)
    throw new Error(`Insufficient BRC2.0 frBTC balance: ${balance} sats, need ${amount}`)

  const recipientScript = bitcoinjs.address.toOutputScript(recipient, getBitcoinNetwork())
  const signerScript = await getFrBtcSignerScript()
  const calldata = evmEncodeFunctionCall(FRBTC_ABI, 'unwrap2', [
    amount.toString(),
    SIGNER_VOUT,
    `0x${recipientScript.toString('hex')}`,
  ])
  return await runFrBtcStep(
    {
      name: 'frBtcUnwrap',
      inscription: await callInscription(getFrBtcAddress(), calldata, FRBTC_CALL_GAS_CEILING),
      target: opReturnTarget(),
      extraOutputs: [
        {
          wallet: new WalletInfo(false, signerScript, null, null, null),
          value: FRBTC_SIGNER_DUST_SATS,
        },
      ],
      maxSendInputs: FRBTC_MAX_SEND_INPUTS,
    },
    feeRate,
    dryRun,
    args
  )
}
