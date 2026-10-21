import type { SignProgressOptions } from './sign-progress'
import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import { Script } from '@cmdcode/tapscript'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { InscriptionDetails } from '../types/inscription'
import { WalletInfo } from '../types/wallet'
import {
  compressSmartContractData,
  evmEncodeFunctionCall,
  getEvmAddressFromBitcoinAddress,
} from './brc20'
import { transferBrc20Inscription } from './brc20-inscriptions'
import {
  broadcastTxes,
  clearExtraUtxos,
  fetchCardinalUtxos,
  saveExtraUtxos,
  utxoOutputTypeFromOutputScript,
} from './helpers'
import {
  getDustValue,
  mintWithExtraInputInCommitAll,
  mintWithExtraInputInCommitFeeRate,
  sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll,
  sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate,
} from './mint'
import { getOrdinalsWallet, getPaymentWallet, getSignFn } from './providers'
import { SignProgress } from './sign-progress'
import { getWalletInfo } from './store'

/** BRC2.0 grants each inscription `content bytes × GAS_PER_BYTE` gas. */
const GAS_PER_BYTE = 12000
/**
 * Gas ceiling for an ERC-20 `transfer`. A transfer to a fresh holder costs about 52k gas; the call
 * inscription's own bytes grant well over this ceiling, so its content is padded only if it ever
 * falls short.
 */
const ERC20_TRANSFER_GAS_CEILING = 100000
/**
 * Value of the payer output each send carries for the next step's commit to spend. Spending it makes
 * every later step a descendant of the earlier ones, so miners and indexers see them in order.
 */
const CHAIN_LINK_VALUE = 1000
const BRC20_AMOUNT_RE = /^\d+(?:\.\d{1,18})?$/

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
]

/** The transactions of one inscribe-and-send step. */
export interface Brc20SendPart {
  commitTxId: string
  revealTxId: string
  /** The transaction that moves the inscription to its target (recipient or OP_RETURN). */
  sendTxId: string
  inscriptionId: string
}

/** Fee breakdown of one inscribe-and-send step. */
export interface Brc20SendStepQuote {
  step: Brc20SendStepName
  /** Miner fees of the commit, reveal and send transactions. */
  minerFeeSats: number
  /** Sats the send leaves on its target output (the recipient's postage, or 1 sat on OP_RETURN). */
  postageSats: number
  /** Sats the send pays to its extra outputs, such as the BTC an frBTC wrap sends to the signer. */
  paymentSats: number
  /** Wallet prompts this step raises. */
  walletPrompts: number
}

/** What a composite send costs, built without signing or broadcasting. */
export interface Brc20SendQuote {
  /** Sats the wallet spends in all: miner fees, postage and payments. */
  totalSats: number
  minerFeeSats: number
  postageSats: number
  paymentSats: number
  /** Wallet prompts the real send raises; `onSignRequest` reports each of them. */
  walletPrompts: number
  feeRate: number
  steps: Brc20SendStepQuote[]
}

export type Brc20SendStepName =
  'brc20Transfer' | 'progWithdraw' | 'progDeposit' | 'progTransfer' | 'frBtcWrap' | 'frBtcUnwrap'

/** An output the send transaction carries right after the target, at vout 1, 2, …. */
export interface ChainExtraOutput {
  wallet: WalletInfo
  value: number
}

export interface ChainStep {
  name: Brc20SendStepName
  inscription: InscriptionDetails
  target: WalletInfo
  extraOutputs?: ChainExtraOutput[]
  /** Most inputs the send may spend; the chain is refused before broadcast when it spends more. */
  maxSendInputs?: number
}

function assertSendInputs(step: ChainStep, sendTxHex: string): void {
  if (step.maxSendInputs == null) return
  const inputs = bitcoinjs.Transaction.fromHex(sendTxHex).ins.length
  if (inputs > step.maxSendInputs)
    throw new Error(
      `${step.name} send spends ${inputs} inputs, more than the ${step.maxSendInputs} its gas covers; consolidate the wallet's UTXOs first`
    )
}

export interface ChainResult {
  parts: Record<string, Brc20SendPart>
  txIds: string[]
}

export function opReturnTarget(): WalletInfo {
  return new WalletInfo(
    true,
    Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
    null,
    null,
    null
  )
}

function textInscription(content: Buff): InscriptionDetails {
  return new InscriptionDetails(Buff.str('text/plain'), null, null, null, null, content)
}

function targetPostage(target: WalletInfo): number {
  return target.isOpReturn ? 1 : getDustValue(target)
}

/**
 * Builds a `brc20-prog` call inscription. BRC2.0 grants `content bytes × GAS_PER_BYTE` gas, so the
 * content is padded with spaces when its bytes alone fall short of `gasCeiling`.
 */
export async function callInscription(
  contractAddress: string,
  calldata: string,
  gasCeiling: number
): Promise<InscriptionDetails> {
  let content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${contractAddress}","b":"${await compressSmartContractData(calldata)}"}`
  )
  if (content.length * GAS_PER_BYTE < gasCeiling) {
    const padding = Math.ceil((gasCeiling - content.length * GAS_PER_BYTE) / GAS_PER_BYTE)
    content = content.append('20'.repeat(padding))
  }
  return textInscription(content)
}

/**
 * The send's outputs after the target: the step's extra outputs, then the link output the next
 * step's commit spends (none on the last step).
 */
function sendOutputs(
  step: ChainStep,
  isLast: boolean,
  payerWallet: WalletInfo
): { outputs: ChainExtraOutput[]; linkVout: number } {
  const outputs = [...(step.extraOutputs ?? [])]
  const linkVout = 1 + outputs.length
  if (!isLast) outputs.push({ wallet: payerWallet, value: CHAIN_LINK_VALUE })
  return { outputs, linkVout }
}

/**
 * Parses a BRC-20 decimal amount string into an 18-decimal bigint.
 *
 * @param value - A non-negative decimal string with at most 18 fractional digits, such as `"0"` or `"12.5"`.
 * @param label - The argument name used in error messages.
 */
export function parseBrc20Amount(value: string, label: string): bigint {
  if (typeof value !== 'string' || !BRC20_AMOUNT_RE.test(value))
    throw new Error(`${label} must be a decimal string with at most 18 fractional digits`)
  const [whole, frac = ''] = value.split('.')
  return BigInt(whole!) * 10n ** 18n + BigInt(frac.padEnd(18, '0'))
}

export function assertRecipient(recipient: string): void {
  if (typeof recipient !== 'string' || recipient.length === 0)
    throw new Error('recipient must be a Bitcoin address')
  try {
    bitcoinjs.address.toOutputScript(recipient, getBitcoinNetwork())
  } catch {
    throw new Error(`recipient is not a valid address on the current network: ${recipient}`)
  }
}

export function assertFeeRate(feeRate: number): void {
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate <= 0)
    throw new Error('feeRate must be a positive number')
}

function connectedWallets() {
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets) throw new Error('Wallets not found')
  const payment = getPaymentWallet()
  const ordinals = getOrdinalsWallet()
  if (!payment?.address) throw new Error('Payment wallet not found')
  if (!ordinals?.address) throw new Error('Ordinals wallet not found')
  return {
    provider: walletInfo.provider,
    payerWallet: new WalletInfo(false, null, payment.address, null, payment.pubkey),
  }
}

/**
 * Builds the commit → reveal → send transactions of each step from the ordinals identity. Each
 * step's commit spends the previous step's link output, and every built transaction stays in the
 * saved extras until the whole chain is built, so no two steps pick the same UTXO.
 */
async function signChain(
  steps: ChainStep[],
  feeRate: number,
  options: SignProgressOptions
): Promise<{ parts: Record<string, Brc20SendPart>; txHexes: string[] }> {
  const { provider, payerWallet } = connectedWallets()
  const progress = new SignProgress(options, steps.length * 2)
  const signFn = progress.wrap(getSignFn(provider))
  const linkScriptType = utxoOutputTypeFromOutputScript(
    payerWallet.outputScript,
    getBitcoinNetwork()
  )

  const parts: Record<string, Brc20SendPart> = {}
  const txHexes: string[] = []
  let link: { utxo: string } | null = null
  try {
    for (const [i, step] of steps.entries()) {
      const isLast = i === steps.length - 1
      saveExtraUtxos(txHexes, null)
      const extraInputs = link
        ? [
            {
              utxo: link.utxo,
              value: CHAIN_LINK_VALUE,
              script_type: linkScriptType,
              wallet: payerWallet,
            },
          ]
        : []
      const minted = await mintWithExtraInputInCommitAll(
        step.inscription,
        extraInputs,
        feeRate,
        null,
        null,
        0,
        true,
        signFn
      )
      txHexes.push(minted.signedCommitTxHex, minted.signedRevealTxHex)
      saveExtraUtxos(txHexes, [minted.inscriptionId, `${minted.revealTxId}:0:0`])

      const { outputs, linkVout } = sendOutputs(step, isLast, payerWallet)
      const sent = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll(
        minted.inscriptionId,
        [],
        step.target,
        targetPostage(step.target),
        outputs,
        feeRate,
        true,
        signFn
      )
      assertSendInputs(step, sent.signedTxHex)
      txHexes.push(sent.signedTxHex)
      link = { utxo: `${sent.txId}:${linkVout}` }
      parts[step.name] = {
        commitTxId: minted.commitTxId,
        revealTxId: minted.revealTxId,
        sendTxId: sent.txId,
        inscriptionId: minted.inscriptionId,
      }
    }
  } finally {
    clearExtraUtxos()
  }
  return { parts, txHexes }
}

/** Prices the same chain as `signChain` from one cardinal UTXO fetch, without signing. */
async function quoteChain(steps: ChainStep[], feeRate: number): Promise<Brc20SendQuote> {
  const { payerWallet } = connectedWallets()
  const linkScriptType = utxoOutputTypeFromOutputScript(
    payerWallet.outputScript,
    getBitcoinNetwork()
  )
  const cardinalUtxos = await fetchCardinalUtxos(payerWallet.addr!)

  const stepQuotes: Brc20SendStepQuote[] = []
  const txHexes: string[] = []
  let link: { utxo: string } | null = null
  try {
    for (const [i, step] of steps.entries()) {
      const isLast = i === steps.length - 1
      saveExtraUtxos(txHexes, null)
      const extraInputs = link
        ? [
            {
              utxo: link.utxo,
              value: CHAIN_LINK_VALUE,
              script_type: linkScriptType,
              wallet: payerWallet,
            },
          ]
        : []
      const minted = await mintWithExtraInputInCommitFeeRate(
        step.inscription,
        extraInputs,
        feeRate,
        null,
        null,
        0,
        cardinalUtxos
      )
      txHexes.push(minted.unsigned_commit_tx_hex, minted.signed_reveal_tx_hex)
      const revealTxId = minted.inscription_id.split('i')[0]!
      saveExtraUtxos(txHexes, [minted.inscription_id, `${revealTxId}:0:0`])

      const postage = targetPostage(step.target)
      const { outputs, linkVout } = sendOutputs(step, isLast, payerWallet)
      const sent = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate(
        minted.inscription_id,
        [],
        step.target,
        postage,
        outputs,
        feeRate,
        cardinalUtxos
      )
      assertSendInputs(step, sent.unsigned_tx_hex)
      txHexes.push(sent.unsigned_tx_hex)
      link = { utxo: `${sent.txid}:${linkVout}` }
      stepQuotes.push({
        step: step.name,
        minerFeeSats: minted.total_fee + sent.tx_fee,
        postageSats: postage,
        paymentSats: (step.extraOutputs ?? []).reduce((sum, o) => sum + o.value, 0),
        walletPrompts: 2,
      })
    }
  } finally {
    clearExtraUtxos()
  }

  const minerFeeSats = stepQuotes.reduce((sum, s) => sum + s.minerFeeSats, 0)
  const postageSats = stepQuotes.reduce((sum, s) => sum + s.postageSats, 0)
  const paymentSats = stepQuotes.reduce((sum, s) => sum + s.paymentSats, 0)
  return {
    totalSats: minerFeeSats + postageSats + paymentSats,
    minerFeeSats,
    postageSats,
    paymentSats,
    walletPrompts: stepQuotes.reduce((sum, s) => sum + s.walletPrompts, 0),
    feeRate,
    steps: stepQuotes,
  }
}

export async function runChain(
  steps: ChainStep[],
  feeRate: number,
  dryRun: boolean,
  options: SignProgressOptions
): Promise<Brc20SendQuote | ChainResult> {
  if (dryRun) return await quoteChain(steps, feeRate)

  const { parts, txHexes } = await signChain(steps, feeRate, options)
  const res = await broadcastTxes(txHexes)
  if (res == null) throw new Error('Broadcast request failed')
  return {
    parts,
    txIds: txHexes.map(hex => bitcoinjs.Transaction.fromHex(hex).getId()),
  }
}

export interface SendAsBrc20Args extends SignProgressOptions {
  tick: string
  /** Amount taken from the sender's base BRC-20 balance, as a decimal string; `"0"` skips it. */
  fromBrc20Amount: string
  /** Amount taken from the sender's BRC2.0 balance, as a decimal string; `"0"` skips it. */
  fromProgAmount: string
  /** Bitcoin address that receives plain BRC-20. */
  recipient: string
  feeRate: number
  dryRun: boolean
}

export interface SendAsBrc20Result {
  /** The BRC-20 transfer inscription sent to the recipient, or null when `fromBrc20Amount` is 0. */
  brc20Transfer: Brc20SendPart | null
  /** The BRC2.0 withdraw inscription sent to the recipient, or null when `fromProgAmount` is 0. */
  progWithdraw: Brc20SendPart | null
  /** Every broadcast transaction id, in chain order. */
  txIds: string[]
}

/**
 * Sends a ticker so the recipient receives plain BRC-20, drawing on the sender's base BRC-20 balance
 * first and its BRC2.0 balance second. The base part is a BRC-20 transfer inscription sent to the
 * recipient; the BRC2.0 part is a `brc20-module` withdraw inscription sent to the recipient. Both
 * parts are signed as one chain and broadcast together.
 */
export async function sendAsBrc20(
  args: SendAsBrc20Args
): Promise<Brc20SendQuote | SendAsBrc20Result> {
  const { tick, fromBrc20Amount, fromProgAmount, recipient, feeRate, dryRun } = args
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean')
  assertFeeRate(feeRate)
  assertRecipient(recipient)
  const fromBrc20 = parseBrc20Amount(fromBrc20Amount, 'fromBrc20Amount')
  const fromProg = parseBrc20Amount(fromProgAmount, 'fromProgAmount')
  if (fromBrc20 === 0n && fromProg === 0n)
    throw new Error('fromBrc20Amount and fromProgAmount cannot both be 0')

  const recipientWallet = new WalletInfo(false, null, recipient, null, null)
  const steps: ChainStep[] = []
  if (fromBrc20 > 0n) {
    steps.push({
      name: 'brc20Transfer',
      inscription: transferBrc20Inscription({ tick, amt: fromBrc20Amount }),
      target: recipientWallet,
    })
  }
  if (fromProg > 0n) {
    steps.push({
      name: 'progWithdraw',
      inscription: textInscription(
        Buff.str(
          `{"p":"brc20-module","op":"withdraw","tick":"${tick}","amt":"${fromProgAmount}","module":"BRC20PROG"}`
        )
      ),
      target: recipientWallet,
    })
  }

  const res = await runChain(steps, feeRate, dryRun, args)
  if (!('parts' in res)) return res
  return {
    brc20Transfer: res.parts.brc20Transfer ?? null,
    progWithdraw: res.parts.progWithdraw ?? null,
    txIds: res.txIds,
  }
}

export interface SendAsBrc20ProgArgs extends SignProgressOptions {
  tick: string
  /** The token's BRC2.0 (ERC-20) contract address. */
  contractAddress: string
  /**
   * Amount deposited from the sender's base BRC-20 balance into its own BRC2.0 balance before the
   * transfer, as a decimal string; `"0"` skips the deposit.
   */
  topUpFromBrc20: string
  /** Total amount the recipient receives, in 18 decimals (the BRC2.0 token unit, as in `swap.deposit`). */
  amount: bigint
  /** Bitcoin address whose BRC2.0 (EVM) address receives the tokens. */
  recipient: string
  feeRate: number
  dryRun: boolean
}

export interface SendAsBrc20ProgResult {
  /** The deposit into the sender's BRC2.0 balance, or null when `topUpFromBrc20` is 0. */
  progDeposit: Brc20SendPart | null
  /** The ERC-20 `transfer` call to the recipient. */
  progTransfer: Brc20SendPart
  /** Every broadcast transaction id, in chain order. */
  txIds: string[]
}

/**
 * Sends a ticker so the recipient receives BRC2.0. When `topUpFromBrc20` is above 0, a deposit first
 * moves that much of the sender's base BRC-20 into its own BRC2.0 balance; then an ERC-20
 * `transfer(recipientEvm, amount)` call moves `amount` to the recipient's EVM address. Both are
 * inscribed from the ordinals identity, which owns the BRC2.0 balance, and the call's commit spends
 * the deposit's output so the deposit is indexed first.
 */
export async function sendAsBrc20Prog(
  args: SendAsBrc20ProgArgs
): Promise<Brc20SendQuote | SendAsBrc20ProgResult> {
  const { tick, contractAddress, topUpFromBrc20, amount, recipient, feeRate, dryRun } = args
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean')
  assertFeeRate(feeRate)
  assertRecipient(recipient)
  if (typeof contractAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress))
    throw new Error('contractAddress must be a 0x-prefixed 20-byte hex address')
  if (typeof amount !== 'bigint' || amount <= 0n)
    throw new Error('amount must be a positive bigint')
  const topUp = parseBrc20Amount(topUpFromBrc20, 'topUpFromBrc20')
  if (topUp > amount) throw new Error('topUpFromBrc20 cannot exceed amount')

  const steps: ChainStep[] = []
  if (topUp > 0n) {
    steps.push({
      name: 'progDeposit',
      inscription: transferBrc20Inscription({ tick, amt: topUpFromBrc20 }),
      target: opReturnTarget(),
    })
  }

  const calldata = evmEncodeFunctionCall(ERC20_TRANSFER_ABI, 'transfer', [
    getEvmAddressFromBitcoinAddress(recipient),
    amount.toString(),
  ])
  steps.push({
    name: 'progTransfer',
    inscription: await callInscription(contractAddress, calldata, ERC20_TRANSFER_GAS_CEILING),
    target: opReturnTarget(),
  })

  const res = await runChain(steps, feeRate, dryRun, args)
  if (!('parts' in res)) return res
  return {
    progDeposit: res.parts.progDeposit ?? null,
    progTransfer: res.parts.progTransfer!,
    txIds: res.txIds,
  }
}
