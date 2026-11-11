import type { SignFunction, SignManyFunction, SignPsbtRequest, SignResponse } from '../provider/api'
import type { PaymentOpts } from '../types/common'
import type {
  InscribeFees,
  InscribeMultipleResult,
  InscribeResult,
  SendInscriptionResult,
} from '../types/inscription'
import type { Utxo } from './chain-providers'
import type { OrdinalUtxoInfo } from './helpers'
import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import {
  get_pubkey, // Generate a secp256k1 public key for a given secret key
  get_seckey, // Convert a number or byte value into a secp256k1 secret key.
} from '@cmdcode/crypto-tools/keys'
import { Address, Script, Signer, Tap, Tx } from '@cmdcode/tapscript'
import * as bitcoinjs from 'bitcoinjs-lib'
import {
  broadcastTxes,
  clearExtraUtxos,
  getCardinalUtxos,
  getInscriptionUtxo,
  getTxhex,
  recordInscribedOutputs,
  saveExtraUtxos,
  txHexByIdCache,
  utxoOutputTypeFromOutputScript,
  validateTxes,
  witnessStackToScriptWitness,
} from '../core/helpers'
import { getOrdinalsWallet, getPaymentWallet, getSignFn } from '../core/providers'
import { getWalletInfo } from '../core/store'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { InscriptionDetails } from '../types/inscription'
import { WalletInfo } from '../types/wallet'
import {
  bestRecoverable,
  inscribedSatRanges,
  inscriptionsByOutput,
  isInscribed,
  lastInscribedEndIn,
  outputRanges,
} from './used-inscriptions'

const ENABLE_RBF_NO_LOCKTIME = 0xfffffffd

const DUST_VALUE_P2PKH = 546
const DUST_VALUE_P2WPKH = 294
const DUST_VALUE_P2SH = 540
const DUST_VALUE_P2TR = 330
const DUST_VALUE_MAX = Math.max(
  DUST_VALUE_P2PKH,
  DUST_VALUE_P2WPKH,
  DUST_VALUE_P2SH,
  DUST_VALUE_P2TR
)

function createSecretToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Buffer.from(array).toString('hex')
}

function convertInscriptionIdToBuffer(inscriptionId: string): Buff {
  const txid = inscriptionId.slice(0, 64)
  const inscriptionIdx = Number.parseInt(inscriptionId.slice(65))

  // txid should be reversed
  // inscr_idx is little endian 4 bytes, appended after reversed txid and trailing zeroes are removed
  const inscriptionIdxBuffer = new Buff(inscriptionIdx, 4, 'le')
  // remove trailing zeros from inscr_idx_buf
  let i = 3
  while (i >= 0 && inscriptionIdxBuffer[i] === 0) i--
  const inscriptionIdxBufferTrimmed = inscriptionIdxBuffer.slice(0, i + 1)
  const reversedTxId = Buff.hex(txid).reverse()

  return reversedTxId.append(inscriptionIdxBufferTrimmed)
}

/** Fee rates are sat/vB and may be fractional; every fee built from one is rounded up to whole sats. */
export function assertFeeRate(feeRate: number): void {
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate <= 0)
    throw new Error('feeRate must be a positive number')
}

export function getDustValue(wallet: WalletInfo): number {
  if (wallet.isOpReturn) return 0
  else if (wallet.addr == null) throw new Error('Wallet address is null')
  else if (Address.decode(wallet.addr).type === 'p2sh') return DUST_VALUE_P2SH
  else if (Address.decode(wallet.addr).type === 'p2w-pkh') return DUST_VALUE_P2WPKH
  else if (Address.decode(wallet.addr).type === 'p2tr') return DUST_VALUE_P2TR
  else if (Address.decode(wallet.addr).type === 'p2pkh') return DUST_VALUE_P2PKH

  return DUST_VALUE_MAX
}

function repeatStr(str: string, num: number): string {
  // return new Array(num + 1).join(str)
  return Array.from({ length: num }).fill(str).join('')
}

interface TapLeafScriptInfo {
  script: Buffer
  controlBlock: Buffer
  leafVersion: number
}

interface UtxoInfo {
  utxo: string
  script_type:
    | 'pubkeyhash'
    | 'scripthash'
    | 'witness_v0_keyhash'
    | 'witness_v0_scripthash'
    | 'witness_v1_taproot'
    | 'pubkey'
    | 'anchor'
    | 'witness_unknown'
    | 'nulldata'
    | 'multisig'
    | 'nonstandard'
  value: number
  tapLeafScript?: Array<TapLeafScriptInfo>
  wallet?: WalletInfo
  witnessUtxoScript?: Buffer
  sequence?: number
  finalScriptWitness?: Buffer
  /** Used BRC-20 inscriptions on the output; see `Utxo.inscription_ids`. */
  inscription_ids?: string[] | null
  satpoints?: string[] | null
}

interface UtxoInfoWithWallet {
  utxo: string
  script_type:
    | 'pubkeyhash'
    | 'scripthash'
    | 'witness_v0_keyhash'
    | 'witness_v0_scripthash'
    | 'witness_v1_taproot'
    | 'pubkey'
    | 'anchor'
    | 'witness_unknown'
    | 'nulldata'
    | 'multisig'
    | 'nonstandard'
  value: number
  tapLeafScript?: Array<TapLeafScriptInfo>
  wallet: WalletInfo
  witnessUtxoScript?: Buffer
  sequence?: number
  finalScriptWitness?: Buffer
}
interface TxInput {
  utxo: UtxoInfo
  wallet: WalletInfo
}
interface TxOutput {
  value: number
  out_script: Buffer
  wallet?: WalletInfo
}

function estimateFee(inputs: TxInput[], outputs: TxOutput[], feeRate: number): number {
  const tx = constructTxFromInOuts(inputs, outputs)
  const vbytes = tx.virtualSize() // tx.virtualSize() // TODO: check this
  return Math.ceil(vbytes * feeRate)
}

/** Setting aside used inscriptions needs `shortfall` more sats than the selected inputs leave. */
class SetAsideShortfallError extends Error {
  constructor(readonly shortfall: number) {
    super('Not enough funds to set aside used BRC-20 inscriptions')
  }
}

/** No set-aside output keeps used inscriptions out of the outputs; build without them instead. */
class SetAsideImpossibleError extends Error {
  constructor() {
    super('Cannot keep used BRC-20 inscriptions out of the transaction outputs')
  }
}

/**
 * Keeps the sats of used BRC-20 inscriptions on selected inputs out of every output that does not
 * pay the change address.
 *
 * Selected inputs without inscriptions go first, right after the forced inputs, so inscribed sats
 * fill the change or the fee where they can. When an output that does not pay the change address
 * would still receive one, a set-aside output to the change address goes right before it, sized
 * (at least the dust limit) to reach past the last inscribed sat, so it takes every inscribed sat
 * from there on. The set-aside output and its fee come out of the change output.
 *
 * Forced inputs keep their place, and their inscriptions are the caller's to place.
 *
 * @param inputs The transaction inputs, forced inputs first. Reordered in place.
 * @param forcedCount How many leading inputs are forced.
 * @param outputs The outputs with their final values, fee already taken. Updated in place.
 * @param changeIndex The index of the change output, or -1 when there is none.
 * @param changeWallet The wallet change and set-aside outputs pay.
 * @param feeRate The fee rate in sat/vB.
 * @returns The new index of each output, by its index before the call.
 * @throws {SetAsideShortfallError} When the change cannot pay the set-aside outputs and their fee.
 */
function setAsideUsedInscriptions(
  inputs: TxInput[],
  forcedCount: number,
  outputs: TxOutput[],
  changeIndex: number,
  changeWallet: WalletInfo,
  feeRate: number
): number[] {
  const original = outputs.slice()
  const selected = inputs.slice(forcedCount)
  if (!selected.some(input => isInscribed(input.utxo))) return original.map((_, i) => i)

  inputs.splice(
    forcedCount,
    selected.length,
    ...selected.filter(input => !isInscribed(input.utxo)),
    ...selected.filter(input => isInscribed(input.utxo))
  )

  const ownScript = changeWallet.outputScript
  const sinks = new Set<TxOutput>()
  const paysChange = (o: TxOutput) => sinks.has(o) || o.out_script.equals(ownScript)
  const inscribed = inscribedSatRanges(
    inputs.map((input, i) => ({ utxo: input.utxo, skip: i < forcedCount }))
  )
  const change = changeIndex === -1 ? null : outputs[changeIndex]!
  const dust = getDustValue(changeWallet)
  const feeBefore =
    inputs.reduce((sum, input) => sum + input.utxo.value, 0) -
    outputs.reduce((sum, output) => sum + output.value, 0)

  // One set-aside output before the first output that would receive an inscribed sat, reaching
  // past the last inscribed sat, leaves every later output clean.
  let setAside = 0
  const ranges = outputRanges(outputs.map(o => o.value))
  const k = outputs.findIndex(
    (o, j) => !paysChange(o) && lastInscribedEndIn(ranges[j]!, inscribed) !== -1
  )
  if (k !== -1) {
    // A set-aside output before an output that forced-input sats reach would take those sats.
    const forcedEnd = inputs.slice(0, forcedCount).reduce((sum, input) => sum + input.utxo.value, 0)
    if (ranges[k]![0] < forcedEnd) throw new SetAsideImpossibleError()
    const lastInscribedEnd = Math.max(...inscribed.map(([, b]) => b))
    const sink: TxOutput = {
      wallet: changeWallet,
      out_script: ownScript,
      value: Math.max(dust, lastInscribedEnd - ranges[k]![0]),
    }
    outputs.splice(k, 0, sink)
    sinks.add(sink)
    setAside = sink.value
  }
  const finalRanges = outputRanges(outputs.map(o => o.value))
  if (
    outputs.some((o, j) => !paysChange(o) && lastInscribedEndIn(finalRanges[j]!, inscribed) !== -1)
  ) {
    throw new SetAsideImpossibleError()
  }

  if (setAside > 0) {
    const feeIncrease = Math.max(0, estimateFee(inputs, outputs, feeRate) - feeBefore)
    if (change == null) {
      const changeOutputFee = Math.ceil((ownScript.length + 9) * feeRate)
      throw new SetAsideShortfallError(setAside + feeIncrease + dust + changeOutputFee)
    }
    change.value -= setAside + feeIncrease
    if (change.value < dust) throw new SetAsideShortfallError(dust - change.value)
  }

  return original.map(o => outputs.indexOf(o))
}

/** Records where the selected inputs' used inscriptions land, for the saved extra transactions. */
function recordSetAside(
  tx: bitcoinjs.Transaction,
  inputs: TxInput[],
  forcedCount: number,
  outputs: TxOutput[]
) {
  if (!inputs.slice(forcedCount).some(input => isInscribed(input.utxo))) return
  recordInscribedOutputs(
    inputs.map(input => input.utxo.utxo),
    tx.outs,
    inscriptionsByOutput(
      inputs.map((input, i) => ({ utxo: input.utxo, skip: i < forcedCount })),
      outputs.map(o => o.value)
    )
  )
}

/** Whether a build failed because its inputs cannot pay for its outputs and fee. */
function isShortOfFunds(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.message.startsWith('Not enough funds') ||
      e.message === 'Fee payer output cannot pay the fee')
  )
}

/**
 * Runs a transaction build that spends an output with used BRC-20 inscriptions only when the
 * outputs without them cannot pay for it, and then only the one giving the most recoverable BTC
 * (`bestRecoverable`), so the clean BTC of the others never ends up in its set-aside output. It
 * returns the first of these builds that succeeds:
 *
 * 1. from the outputs without inscriptions, with change of at least `minChange`;
 * 2. adding the best inscribed output, with a change reserve that starts at `minChange` and grows
 *    while setting aside its inscriptions runs short;
 * 3. from the outputs without inscriptions, without `minChange`.
 *
 * `minChange` asks for change a later transaction will spend (a wrap's commit gathers its send's
 * BTC this way), and is honored only when the pool holds outputs with used inscriptions: then the
 * change is clean BTC that may come from splitting such an output.
 *
 * @param build Builds the transaction from the given change reserve and UTXO pool.
 * @param pool The UTXOs to select from.
 * @param minChange The change to aim for, in sats.
 * @throws The plain build's error when the funds fall short, and a "Not enough funds" error naming
 *   the used inscriptions when only the best inscribed output could pay but no layout keeps its
 *   inscriptions out of the outputs.
 */
function withSetAsideReserve(
  build: (reserve: number, pool: UtxoInfo[]) => BuildTransactionResult,
  pool: UtxoInfo[],
  minChange: number
) {
  if (!pool.some(isInscribed)) return build(0, pool)
  const plain = pool.filter(u => !isInscribed(u))
  const best = bestRecoverable(pool)
  let plainError: unknown
  try {
    return build(minChange, plain)
  } catch (e) {
    if (!isShortOfFunds(e)) throw e
    plainError = e
  }
  let setAsideBlocked = false
  // minChange is best effort: without it the best inscribed output is still split, and its clean
  // BTC returns as whatever change remains.
  for (const base of best ? (minChange > 0 ? [minChange, 0] : [0]) : []) {
    let reserve = base
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return build(reserve, [...plain, best!])
      } catch (e) {
        if (e instanceof SetAsideShortfallError) {
          reserve += e.shortfall
          setAsideBlocked = true
        } else if (e instanceof SetAsideImpossibleError) {
          setAsideBlocked = true
          break
        } else if (isShortOfFunds(e)) {
          break
        } else {
          throw e
        }
      }
    }
  }
  if (minChange > 0) {
    try {
      return build(0, plain)
    } catch (e) {
      if (!isShortOfFunds(e)) throw e
      plainError = e
    }
  }
  if (setAsideBlocked) {
    throw new Error(
      'Not enough funds: this transaction cannot spend outputs with used BRC-20 inscriptions without sending them on, so it needs BTC on outputs without inscriptions'
    )
  }
  throw plainError
}

const ADDITIONAL_INPUT_P2PKH_VBYTES = 147
const ADDITIONAL_INPUT_P2SH_VBYTES = 153 // TODO: fix here!!
const ADDITIONAL_INPUT_P2WPKH_VBYTES = 68 // TODO: fix here!! (NOTE: P2WPKH in P2SH is 91)
const ADDITIONAL_INPUT_P2WSH_VBYTES = 68 // TODO: fix here!! (NOTE: P2WSH in P2SH is 103)
const ADDITIONAL_INPUT_P2TR_VBYTES = 58 // TODO: fix here!!

function calculateAdditionalFee(scriptType: string, feeRate: number): number {
  if (scriptType === 'pubkeyhash') return Math.ceil(ADDITIONAL_INPUT_P2PKH_VBYTES * feeRate)
  if (scriptType === 'scripthash') return Math.ceil(ADDITIONAL_INPUT_P2SH_VBYTES * feeRate)
  if (scriptType === 'witness_v0_keyhash')
    return Math.ceil(ADDITIONAL_INPUT_P2WPKH_VBYTES * feeRate)
  if (scriptType === 'witness_v0_scripthash')
    return Math.ceil(ADDITIONAL_INPUT_P2WSH_VBYTES * feeRate)
  if (scriptType === 'witness_v1_taproot') return Math.ceil(ADDITIONAL_INPUT_P2TR_VBYTES * feeRate)
  return 0
}

const TO_X_ONLY = (pubKey: Buffer) => (pubKey.length === 32 ? pubKey : pubKey.slice(1, 33))

async function getMintMultipleFeeAll(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  paymentAddress: string | null,
  payment: number | null
): Promise<InscribeFees> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddress = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddress, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )
  let paymentWallet = null
  if (paymentAddress != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddress, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTxMultiple(
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetailsArray,
    feeRate,
    postage,
    paymentWallet,
    payment
  )
  return {
    totalFee: commitTx.commit_fee + commitTx.reveal_fee,
    commitFee: commitTx.commit_fee,
    revealFee: commitTx.reveal_fee,
    postage,
    secret,
  }
}

/**
 * Calculate the fees for inscribing multiple inscriptions with the given details, fee rate, postage, payment address, and payment amount.
 *
 * @param inscriptionDetailsArray - An array of InscriptionDetails instances containing the details of each inscription to be minted.
 * @param feeRate - The fee rate in satoshis per virtual byte to be used for the fee calculation.
 * @param postage - The postage amount in satoshis to be included in the fee calculation, or null to use the default dust value.
 * @param paymentOpts - An object containing the payment address and payment amount, or null if no payment is required.
 * @returns A promise that resolves to an object containing the total fee, commit fee, reveal fee, postage, and secret for the inscriptions.
 */
export async function getInscribeMultipleFee(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  paymentOpts?: PaymentOpts
): Promise<InscribeFees> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets) throw new Error('Wallets not found')

  if (!Array.isArray(inscriptionDetailsArray))
    throw new Error('inscriptionDetailsArray must be of type array [bis.InscriptionDetails]')

  for (const inscriptionDetails of inscriptionDetailsArray) {
    if (!(inscriptionDetails instanceof InscriptionDetails))
      throw new Error('inscriptionDetails must be of type bis.InscriptionDetails')
  }

  assertFeeRate(feeRate)
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentOpts != null) {
    if (typeof paymentOpts.paymentAddress != 'string')
      throw new Error('paymentAddress must be a string')
    if (
      typeof paymentOpts.paymentAmount != 'number' ||
      !Number.isInteger(paymentOpts.paymentAmount)
    ) {
      throw new TypeError('paymentAmount must be an integer')
    }
  }

  return await getMintMultipleFeeAll(
    inscriptionDetailsArray,
    feeRate,
    postage,
    paymentOpts?.paymentAddress || null,
    paymentOpts?.paymentAmount || null
  )
}

export async function inscribeWithParent(
  inscriptionDetails: InscriptionDetails,
  parentInscriptionId: string,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts
): Promise<InscribeResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets) throw new Error('Wallets not found')
  if (!(inscriptionDetails instanceof InscriptionDetails))
    throw new Error('inscriptionDetails must be of type bis.InscriptionDetails')
  if (typeof parentInscriptionId !== 'string')
    throw new Error('parentInscriptionId must be a string')
  assertFeeRate(feeRate)
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentOpts != null) {
    if (typeof paymentOpts.paymentAddress != 'string')
      throw new Error('paymentAddress must be a string')
    if (
      typeof paymentOpts.paymentAmount != 'number' ||
      !Number.isInteger(paymentOpts.paymentAmount)
    ) {
      throw new TypeError('paymentAmount must be an integer')
    }
  }

  const signFn = getSignFn(walletInfo.provider)
  return await mintWithParentAll(
    inscriptionDetails,
    parentInscriptionId,
    feeRate,
    postage,
    paymentOpts?.paymentAddress ?? null,
    paymentOpts?.paymentAmount ?? null,
    dryRun,
    signFn
  )
}

export async function inscribeMultiple(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts
): Promise<InscribeMultipleResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets) throw new Error('Wallets not found')

  // Checks
  if (!Array.isArray(inscriptionDetailsArray))
    throw new Error('inscriptionDetailsArray must be of type array [bis.InscriptionDetails]')
  for (const inscriptionDetails of inscriptionDetailsArray) {
    if (!(inscriptionDetails instanceof InscriptionDetails))
      throw new Error('inscriptionDetails must be of type bis.InscriptionDetails')
  }
  assertFeeRate(feeRate)
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')

  if (paymentOpts != null) {
    const { paymentAddress, paymentAmount } = paymentOpts
    if (paymentAddress != null && typeof paymentAddress != 'string')
      throw new Error('paymentAddress must be a string')
    if (
      paymentAmount != null &&
      (typeof paymentAmount != 'number' || !Number.isInteger(paymentAmount))
    ) {
      throw new Error('paymentAmount must be an integer')
    }
  }

  if (typeof dryRun != 'boolean') throw new Error('dryRun must be a boolean')

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  return await mintMultipleAll(
    inscriptionDetailsArray,
    feeRate,
    postage,
    paymentOpts?.paymentAddress ?? null,
    paymentOpts?.paymentAmount ?? null,
    dryRun,
    signFn
  )
}

interface BuildRevealTxMultipleResult {
  txid: string
  signed_reveal_tx_hex: string
}

async function buildRevealTxMultiple(
  inscriptionWallet: WalletInfo,
  commitTxId: string,
  commitOutputValue: number,
  secret: string,
  inscriptionDetailsArray: InscriptionDetails[],
  postage: number,
  paymentWallet: WalletInfo | null,
  payment: number | null,
  commitVout: number
): Promise<BuildRevealTxMultipleResult> {
  if (!payment || payment < 0) payment = 0

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)
  const script = buildRevealScriptMultiple(pubkey, inscriptionDetailsArray, postage)
  const tapleaf = Tap.encodeScript(script)
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const inputs = [
    {
      txid: commitTxId,
      vout: commitVout,
    },
  ]

  const txDataVout = []
  for (let i = 0; i < inscriptionDetailsArray.length; i++) {
    txDataVout.push({
      value: postage,
      scriptPubKey: inscriptionWallet.outputScript,
    })
  }

  if (payment && payment > 0 && paymentWallet) {
    txDataVout.push({
      value: payment,
      scriptPubKey: paymentWallet.outputScript,
    })
  }
  const txData = Tx.create({
    vin: [
      {
        // Use the txid of the funding transaction used to send the sats.
        txid: inputs[0]!.txid,
        // Specify the index value of the output that you are going to spend from.
        vout: inputs[0]!.vout,
        // Also include the value and script of that ouput.
        prevout: {
          // Feel free to change this if you sent a different amount.
          value: commitOutputValue,
          // This is what our address looks like in script form.
          scriptPubKey: ['OP_1', tpubkey],
        },
      },
    ],
    vout: txDataVout,
  })

  const sig = Signer.taproot.sign(seckey, txData, 0, { extension: tapleaf })
  txData.vin[0]!.witness = [sig, script, cblock]

  const isValid = Signer.taproot.verify(txData, 0, { pubkey, throws: true })
  if (!isValid) throw new Error('Invalid signature')

  return {
    txid: Tx.util.getTxid(txData),
    signed_reveal_tx_hex: Tx.encode(txData).hex,
  }
}

async function mintMultipleAll(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  paymentAddress: string | null,
  payment: number | null,
  dryRun: boolean,
  signFn: SignFunction
): Promise<InscribeMultipleResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddress = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddress, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )
  let paymentWallet = null
  if (paymentAddress != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddress, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTxMultiple(
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetailsArray,
    feeRate,
    postage,
    paymentWallet,
    payment
  )
  const signedCommitTx = await signFn(
    commitTx.unsigned_psbt_hex,
    payerAddress,
    inscriptionAddress,
    []
  )

  const commitTxId = signedCommitTx.txId
  const revealTx = await buildRevealTxMultiple(
    inscriptionWallet,
    commitTxId,
    commitTx.output_value,
    secret,
    inscriptionDetailsArray,
    postage,
    paymentWallet,
    payment,
    commitTx.commit_vout
  )

  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signed_reveal_tx_hex])
  if (isValid == null)
    throw new Error(
      'Multiple inscription commit/reveal validation failed (testmempoolaccept request failed)'
    )

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  const inscriptionIds = []
  for (let i = 0; i < inscriptionDetailsArray.length; i++) {
    inscriptionIds.push(`${revealTx.txid}i${i}`)
  }

  if (dryRun) {
    return {
      commitTxId: signedCommitTx.txId,
      signedCommitTxHex: signedCommitTx.signedTxHex,
      revealTxId: revealTx.txid,
      signedRevealTxHex: revealTx.signed_reveal_tx_hex,
      inscriptionIds,
      postage,
      secret,
    }
  }

  if ((await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signed_reveal_tx_hex])) == null)
    throw new Error('Broadcast request failed')

  return {
    commitTxId: signedCommitTx.txId,
    signedCommitTxHex: signedCommitTx.signedTxHex,
    revealTxId: revealTx.txid,
    signedRevealTxHex: revealTx.signed_reveal_tx_hex,
    inscriptionIds,
    postage,
    secret,
  }
}

function constructTxFromInOuts(inputs: TxInput[], outputs: TxOutput[]): bitcoinjs.Transaction {
  const finalTx = new bitcoinjs.Transaction() /* network_type */
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]?.utxo.script_type === 'pubkeyhash') {
      // P2PKH
      if (inputs[i]?.wallet.publicKey == null) {
        throw new Error('publicKey is null on p2pkh input')
      }

      const hash = inputs[i]?.utxo.utxo.split(':')[0]
      const indexStr = inputs[i]?.utxo.utxo.split(':')[1]
      if (!hash || !indexStr) {
        throw new Error('Invalid utxo format, expected txid:index')
      }
      const index = Number.parseInt(indexStr)
      finalTx.ins.push({
        hash: Buffer.from(hash, 'hex'),
        index,
        script: Buffer.from(`48${repeatStr('00', 72)}21${inputs[i]?.wallet.publicKey}`, 'hex'),
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witness: [],
      })
    } else if (inputs[i]?.utxo.script_type === 'scripthash') {
      // P2SH
      if (inputs[i]?.wallet.getRedeemScript() == null) {
        throw new Error('Redeem script is null on p2sh input')
      }

      const hash = inputs[i]?.utxo.utxo.split(':')[0]
      const indexStr = inputs[i]?.utxo.utxo.split(':')[1]
      if (!hash || !indexStr) {
        throw new Error('Invalid utxo format, expected txid:index')
      }
      const index = Number.parseInt(indexStr)
      const publicKey = inputs[i]?.wallet.publicKey
      if (publicKey == null) {
        throw new Error('publicKey is null on p2sh input')
      }
      finalTx.ins.push({
        hash: Buffer.from(hash, 'hex'),
        index,
        script: Buffer.from(Script.encode(inputs[i]?.wallet.getRedeemScript(), true)),
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witness: [Buffer.from(repeatStr('00', 71), 'hex'), Buffer.from(publicKey, 'hex')],
      })
    } else if (inputs[i]?.utxo.script_type === 'witness_v0_keyhash') {
      // P2WPKH
      if (inputs[i]?.wallet.publicKey == null) {
        throw new Error('publicKey is null on p2wpkh input')
      }

      const hash = inputs[i]?.utxo.utxo.split(':')[0]
      const indexStr = inputs[i]?.utxo.utxo.split(':')[1]
      if (!hash || !indexStr) {
        throw new Error('Invalid utxo format, expected txid:index')
      }
      const index = Number.parseInt(indexStr)
      const publicKey = inputs[i]?.wallet.publicKey
      if (publicKey == null) {
        throw new Error('publicKey is null on p2wpkh input')
      }
      finalTx.ins.push({
        hash: Buffer.from(hash, 'hex'),
        index,
        script: Buffer.from('', 'hex'),
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witness: [Buffer.from(repeatStr('00', 72), 'hex'), Buffer.from(publicKey, 'hex')],
      })
    } else if (inputs[i]?.utxo.script_type === 'witness_v0_scripthash') {
      // P2WSH
      throw new Error('P2WSH is not supported yet')
    } else if (inputs[i]?.utxo.script_type === 'witness_v1_taproot') {
      // P2TR
      if (inputs[i]?.utxo.tapLeafScript) {
        const hash = inputs[i]?.utxo.utxo.split(':')[0]
        const indexStr = inputs[i]?.utxo.utxo.split(':')[1]
        if (!hash || !indexStr) {
          throw new Error('Invalid utxo format, expected txid:index')
        }
        const index = Number.parseInt(indexStr)
        const tapLeafScript = inputs[i]?.utxo.tapLeafScript
        if (!tapLeafScript) {
          throw new Error('tapLeafScript is undefined on p2tr input')
        }
        const tapLeafScriptItem = tapLeafScript[0]
        if (!tapLeafScriptItem) {
          throw new Error('tapLeafScript is empty on p2tr input')
        }
        const tapleafScriptScript = tapLeafScriptItem.script
        const controlBlock = tapLeafScriptItem.controlBlock
        if (!tapleafScriptScript || !controlBlock) {
          throw new Error('tapLeafScript script or controlBlock is null on p2tr input')
        }
        finalTx.ins.push({
          hash: Buffer.from(hash, 'hex'),
          index,
          script: Buffer.from('', 'hex'),
          sequence: ENABLE_RBF_NO_LOCKTIME,
          witness: [Buffer.from(repeatStr('00', 65), 'hex'), tapleafScriptScript, controlBlock],
        })
      } else {
        const hash = inputs[i]?.utxo.utxo.split(':')[0]
        const indexStr = inputs[i]?.utxo.utxo.split(':')[1]
        if (!hash || !indexStr) {
          throw new Error('Invalid utxo format, expected txid:index')
        }
        const index = Number.parseInt(indexStr)
        finalTx.ins.push({
          hash: Buffer.from(hash, 'hex'),
          index,
          script: Buffer.from('', 'hex'),
          sequence: ENABLE_RBF_NO_LOCKTIME,
          witness: [Buffer.from(repeatStr('00', 65), 'hex')],
        })
      }
    } else if (inputs[i]?.utxo.script_type === 'pubkey') {
      throw new Error('pubkey input')
    } else if (inputs[i]?.utxo.script_type === 'anchor') {
      throw new Error('anchor input')
    } else if (inputs[i]?.utxo.script_type === 'witness_unknown') {
      throw new Error('witness_unknown input')
    } else if (inputs[i]?.utxo.script_type === 'nulldata') {
      throw new Error('nulldata input')
    } else if (inputs[i]?.utxo.script_type === 'multisig') {
      throw new Error('multisig input')
    } else if (inputs[i]?.utxo.script_type === 'nonstandard') {
      throw new Error('nonstandard input')
    } else {
      throw new Error('unknown input')
    }
  }
  for (let i = 0; i < outputs.length; i++) {
    finalTx.addOutput(outputs[i]!.out_script, outputs[i]!.value)
  }

  return finalTx
}

function buildRevealScript(
  pubkey: Buff,
  inscr: InscriptionDetails,
  parentInscriptionId?: Buff
): (string | Buff)[] {
  const script = [pubkey, 'OP_CHECKSIG', 'OP_0', 'OP_IF', Buff.str('ord')]
  if (inscr.mimeType) {
    script.push('01')
    script.push(inscr.mimeType)
  }
  if (parentInscriptionId) {
    script.push('03')
    script.push(parentInscriptionId)
  }
  if (inscr.metadata) {
    for (let i = 0; i < inscr.metadata.length; i += 520) {
      script.push('05')
      script.push(inscr.metadata.subarray(i, i + 520))
    }
  }
  if (inscr.metaprotocol) {
    script.push('07')
    script.push(inscr.metaprotocol)
  }
  if (inscr.contentEncoding) {
    script.push('09')
    script.push(inscr.contentEncoding)
  }
  if (inscr.delegate) {
    script.push('0B')
    script.push(inscr.delegate)
  }
  if (inscr.data) {
    script.push('OP_0')
    for (let i = 0; i < inscr.data.length; i += 520) {
      script.push(inscr.data.subarray(i, i + 520))
    }
  }
  script.push('OP_ENDIF')

  return script
}

function buildRevealScriptMultiple(
  pubkey: Buff,
  inscrs: InscriptionDetails[],
  postage: number
): (string | Buff)[] {
  const script: (string | Buff)[] = [pubkey, 'OP_CHECKSIG']
  let inscriptionIdx = 0
  for (const inscr of inscrs) {
    script.push('OP_0')
    script.push('OP_IF')
    script.push(Buff.str('ord'))
    if (inscriptionIdx !== 0) {
      script.push('02') // pointer
      script.push(Buff.num(inscriptionIdx * postage, undefined, 'le'))
    }
    if (inscr.mimeType) {
      script.push('01')
      script.push(inscr.mimeType)
    }
    if (inscr.metadata) {
      for (let i = 0; i < inscr.metadata.length; i += 520) {
        script.push('05')
        script.push(inscr.metadata.subarray(i, i + 520))
      }
    }
    if (inscr.metaprotocol) {
      script.push('07')
      script.push(inscr.metaprotocol)
    }
    if (inscr.contentEncoding) {
      script.push('09')
      script.push(inscr.contentEncoding)
    }
    if (inscr.delegate) {
      script.push('0B')
      script.push(inscr.delegate)
    }
    if (inscr.data) {
      script.push('OP_0')
      for (let i = 0; i < inscr.data.length; i += 520) {
        script.push(inscr.data.subarray(i, i + 520))
      }
    }
    script.push('OP_ENDIF')

    inscriptionIdx++
  }

  return script
}

interface BuildTransactionResult {
  tx: bitcoinjs.Transaction
  tx_fee: number
  /**
   * The index in `tx.outs` of each output, change included, in the order the builder lays them out
   * without a set-aside output (see `setAsideUsedInscriptions`). It is the identity unless the
   * transaction spends used BRC-20 inscriptions.
   */
  output_index: number[]
}
// NOTE: utxos input must have utxo, value and script_type parameters
// selects from utxos
// always uses force_in_utxos (must also include a wallet field)
// inputs are from payer_wallet
// op_return_wallets are put to first outputs with 0 value (can be an empty array)
// output_wallet is the wallet to send the amount to
// change_wallet is the wallet to send the change to
// fee_rate is in sat/vbyte
// amount is in sat
// payment_wallet is the wallet to send the payment to (can be null)
// payment is the amount to send to payment_wallet (can be null, must be bigger than DUST_LIMIT)
// min_change is change a later transaction will spend (see withSetAsideReserve), 0 for none
export function buildTransaction(
  utxoInfos: UtxoInfo[],
  forceInUtxos: UtxoInfoWithWallet[],
  payerWallet: WalletInfo,
  opReturnWallets: WalletInfo[],
  outputWallet: WalletInfo | null,
  changeWallet: WalletInfo,
  feeRate: number,
  amount: number,
  paymentWallet: WalletInfo | null,
  payment: number | null,
  minChange = 0
): BuildTransactionResult {
  return withSetAsideReserve(
    (reserve, pool) =>
      buildTransactionWithReserve(
        pool,
        forceInUtxos,
        payerWallet,
        opReturnWallets,
        outputWallet,
        changeWallet,
        feeRate,
        amount,
        paymentWallet,
        payment,
        reserve
      ),
    utxoInfos,
    minChange
  )
}

// `reserve` is extra input value selection gathers for change, to pay set-aside outputs.
function buildTransactionWithReserve(
  utxoInfos: UtxoInfo[],
  forceInUtxos: UtxoInfoWithWallet[],
  payerWallet: WalletInfo,
  opReturnWallets: WalletInfo[],
  outputWallet: WalletInfo | null,
  changeWallet: WalletInfo,
  feeRate: number,
  amount: number,
  paymentWallet: WalletInfo | null,
  payment: number | null,
  reserve: number
): BuildTransactionResult {
  const utxos = utxoInfos.slice()

  utxos.sort((a: UtxoInfo, b: UtxoInfo) => a.value - b.value)
  const inputs: TxInput[] = []
  const outputs: TxOutput[] = []
  const opReturnSizes = []

  for (let i = 0; i < opReturnWallets.length; i++) {
    if (opReturnWallets[i]!.isOpReturn) {
      outputs.push({
        out_script: opReturnWallets[i]!.outputScript,
        value: 0,
      })
      opReturnSizes.push(opReturnWallets[i]!.outputScript.length)
    } else {
      throw new Error('Invalid wallet type (one of op_return_wallets is not op_return)')
    }
  }
  if (outputWallet != null) {
    outputs.push({
      wallet: outputWallet,
      out_script: outputWallet.outputScript,
      value: 0,
    })
  }

  let usesPayment = false
  if (paymentWallet != null && payment != null && payment >= getDustValue(paymentWallet)) {
    outputs.push({
      wallet: paymentWallet,
      out_script: paymentWallet.outputScript,
      value: 0,
    })
    amount += payment
    usesPayment = true
  }

  let totalOutputAmount = 0
  for (const utxo of forceInUtxos) {
    // TODO: these may also come from output_wallet (e.g. rune_mint)
    inputs.push({ utxo, wallet: utxo.wallet })
    totalOutputAmount += utxo.value
    for (let i = 0; i < utxos.length; i++) {
      if (utxos[i]!.utxo === utxo.utxo) {
        utxos.splice(i, 1)
        break
      }
    }
  }

  let fee = estimateFee(inputs, outputs, feeRate)
  while (totalOutputAmount < amount + fee + reserve) {
    let deficit = amount + fee + reserve - totalOutputAmount
    // const additional_fee = Math.ceil(is_payer_p2sh ? bis.ADDITIONAL_INPUT_P2SH_VBYTES : bis.ADDITIONAL_INPUT_P2TR_VBYTES) * fee_rate // TODO: fix here!!
    while (deficit > 0) {
      if (utxos.length === 0) throw new Error('Not enough funds')

      const lastUtxo = utxos[utxos.length - 1]!
      const requiredAmount = deficit + calculateAdditionalFee(lastUtxo.script_type, feeRate)

      if (lastUtxo.value >= requiredAmount) {
        // First try to find a "good" UTXO (value > 10000)
        for (const utxo of utxos.filter(utxo => utxo.value > 10000)) {
          const needed = deficit + calculateAdditionalFee(utxo.script_type, feeRate)
          if (utxo.value >= needed) {
            inputs.push({ utxo, wallet: payerWallet })
            totalOutputAmount += utxo.value
            deficit = 0
            utxos.splice(utxos.indexOf(utxo), 1)
            break
          }
        }

        // Only if deficit is still not covered, try all UTXOs
        if (deficit > 0) {
          for (const utxo of utxos) {
            const needed = deficit + calculateAdditionalFee(utxo.script_type, feeRate)
            if (utxo.value >= needed) {
              inputs.push({ utxo, wallet: payerWallet })
              totalOutputAmount += utxo.value
              deficit = 0
              utxos.splice(utxos.indexOf(utxo), 1)
              break
            }
          }
        }
      } else {
        const benefit =
          utxos[utxos.length - 1]!.value -
          calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
        deficit -= benefit
        inputs.push({ utxo: utxos.pop()!, wallet: payerWallet })
        totalOutputAmount += inputs[inputs.length - 1]!.utxo.value
      }
    }
  }

  const additionalOutputFee = Math.ceil((changeWallet.outputScript.length + 9) * feeRate)
  fee = estimateFee(inputs, outputs, feeRate)
  const excess = totalOutputAmount - fee - amount
  let feePayerOutputIndex = -1
  const hasChange = excess > getDustValue(changeWallet) + additionalOutputFee
  if (hasChange) {
    // we have enough to output to change
    const toStrip = totalOutputAmount - amount
    if (amount > 0) {
      outputs[opReturnSizes.length]!.value = amount
      outputs.push({
        wallet: changeWallet,
        out_script: changeWallet.outputScript,
        value: toStrip,
      })
      feePayerOutputIndex = outputs.length - 1
    } else {
      outputs.push({
        wallet: changeWallet,
        out_script: changeWallet.outputScript,
        value: toStrip,
      })
      feePayerOutputIndex = outputs.length - 1
    }
  } else {
    if (outputWallet != null) {
      outputs[opReturnSizes.length]!.value = totalOutputAmount
      feePayerOutputIndex = opReturnSizes.length
    } else {
      feePayerOutputIndex = -1
    }
  }

  if (usesPayment) {
    if (payment == null) throw new Error('Payment is null')

    if (outputWallet != null) {
      outputs[opReturnSizes.length]!.value -= payment
      outputs[opReturnSizes.length + 1]!.value += payment
    } else {
      outputs[opReturnSizes.length]!.value += payment
      totalOutputAmount -= payment
    }
  }

  // op_returns
  // output_wallet <- amount (+ possibly fees)
  // payment_wallet <- payment (may not exist)
  // change_wallet <- change (may not exist)

  fee = estimateFee(inputs, outputs, feeRate)
  if (feePayerOutputIndex === -1) {
    if (totalOutputAmount < fee) {
      throw new Error('Not enough funds to pay fee')
    }
  } else {
    const tempWallet = outputs[feePayerOutputIndex]!.wallet
    if (!tempWallet) throw new Error('Fee payer output does not exist')

    if (outputs[feePayerOutputIndex]!.value - fee < getDustValue(tempWallet)) {
      throw new Error('Fee payer output cannot pay the fee')
    }
    outputs[feePayerOutputIndex]!.value -= fee
  }

  const outputIndex = setAsideUsedInscriptions(
    inputs,
    forceInUtxos.length,
    outputs,
    hasChange ? outputs.length - 1 : -1,
    changeWallet,
    feeRate
  )
  const finalTx = constructTxFromInOuts(inputs, outputs)
  recordSetAside(finalTx, inputs, forceInUtxos.length, outputs)
  let txFee = 0
  for (const input of inputs) {
    txFee += input.utxo.value
  }
  for (const output of outputs) {
    txFee -= output.value
  }

  return {
    tx: finalTx,
    tx_fee: txFee,
    output_index: outputIndex,
  }
}

interface TransactionInOuts {
  ins: { hash: Buffer; index: number }[]
  outs: { value: number; script: Buffer }[]
}
export async function buildPsbtFromTx(
  tx: TransactionInOuts,
  cardinalUtxos: UtxoInfo[],
  payerWallet: WalletInfo,
  forceInUtxos: UtxoInfoWithWallet[]
): Promise<bitcoinjs.Psbt> {
  const networkType = getBitcoinNetwork()

  const resPsbt = new bitcoinjs.Psbt({ network: networkType })

  const willBeAddedSigs: { idx: number; signature: Buffer }[] = []
  for (const input of tx.ins) {
    // get corresponding cardinal utxo
    const utxo = `${input.hash.toString('hex')}:${input.index}`
    let utxoObj = null
    let signerWallet = payerWallet
    for (const cardinalUtxoObj of cardinalUtxos) {
      if (cardinalUtxoObj.utxo === utxo) {
        utxoObj = cardinalUtxoObj
        break
      }
    }
    if (utxoObj == null && forceInUtxos) {
      for (const forcedInUtxoObj of forceInUtxos) {
        if (forcedInUtxoObj.utxo === utxo) {
          utxoObj = forcedInUtxoObj
          signerWallet = forcedInUtxoObj.wallet
          break
        }
      }
    }
    if (utxoObj == null) throw new Error('Cannot find utxo in cardinal_utxos')

    const txhex = await getTxhex(input.hash.toString('hex'))
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    for (const output in tx.outs) {
      try {
        tx.setWitness(Number.parseInt(output), [])
      } catch {}
    }

    if (utxoObj.script_type === 'pubkeyhash') {
      // P2PKH
      if (signerWallet.publicKey == null) {
        throw new Error('publicKey is null on p2pkh input')
      }

      resPsbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        // witnessUtxo: tx.outs[input.index],
        nonWitnessUtxo: tx.toBuffer(),
      })
    } else if (utxoObj.script_type === 'scripthash') {
      // P2SH
      if (signerWallet.getRedeemScript() == null) {
        throw new Error('Redeem script is null on p2sh input')
      }

      resPsbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        // witnessUtxo: tx.outs[input.index],
        nonWitnessUtxo: tx.toBuffer(),
        redeemScript: signerWallet.getRedeemScript(),
      })
    } else if (utxoObj.script_type === 'witness_v0_keyhash') {
      // P2WPKH
      if (signerWallet.publicKey == null) {
        throw new Error('publicKey is null on p2wpkh input')
      }

      resPsbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witnessUtxo: tx.outs[input.index],
      })
    } else if (utxoObj.script_type === 'witness_v0_scripthash') {
      // P2WSH
      if (signerWallet.getRedeemScript() == null) {
        throw new Error('Redeem script is null on p2wsh input')
      }

      resPsbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witnessUtxo: tx.outs[input.index],
        witnessScript: signerWallet.getRedeemScript(), // TODO: is this correct??
      })
    } else if (utxoObj.script_type === 'witness_v1_taproot') {
      // P2TR
      const witnessUtxo = tx.outs[input.index]
      if (utxoObj.witnessUtxoScript != null) {
        witnessUtxo!.script = utxoObj.witnessUtxoScript
      }

      let sequence = ENABLE_RBF_NO_LOCKTIME
      if (utxoObj.sequence != null) {
        sequence = utxoObj.sequence
      }

      if (!signerWallet.publicKey) throw new Error('publicKey is null on p2tr input')

      if (utxoObj.tapLeafScript == null) {
        // only add tapInternalKey if its key spend path
        resPsbt.addInput({
          hash: input.hash.toString('hex'),
          index: input.index,
          sequence,
          witnessUtxo,
          tapInternalKey: TO_X_ONLY(Buffer.from(signerWallet.publicKey, 'hex')),
        })
      } else {
        resPsbt.addInput({
          hash: input.hash.toString('hex'),
          index: input.index,
          sequence,
          witnessUtxo,
          tapLeafScript: utxoObj.tapLeafScript,
          // tapInternalKey: toXOnly(__Buffer.from(signer_wallet.publicKey, 'hex')),
          // NOTE: XVerse only works with no tapInternalKey!!
        })

        if (utxoObj.finalScriptWitness != null) {
          willBeAddedSigs.push({
            idx: resPsbt.inputCount - 1,
            signature: utxoObj.finalScriptWitness,
          })
        }
      }
    } else {
      throw new Error('unknown input')
    }
  }

  for (const output of tx.outs) {
    resPsbt.addOutput(output)
  }

  for (const sig of willBeAddedSigs) {
    resPsbt.updateInput(sig.idx, { finalScriptWitness: sig.signature })
  }

  return resPsbt
}

interface BuildCommitTxResult {
  unsigned_commit_tx: bitcoinjs.Transaction
  unsigned_psbt_hex: string
  /** The index of the taproot commit output in `unsigned_commit_tx`. */
  commit_vout: number
  output_value: number
  commit_fee: number
  reveal_fee: number
}
async function buildCommitTx(
  payerWallet: WalletInfo,
  inscriptionWallet: WalletInfo,
  secret: string,
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number,
  paymentWallet: WalletInfo | null,
  payment: number | null,
  forceInUtxos: UtxoInfoWithWallet[],
  fetchedCardinalUtxos?: Utxo[],
  minChange = 0
): Promise<BuildCommitTxResult> {
  if (payment == null || payment < 0) payment = 0
  const changeWallet = payerWallet

  if (!payerWallet.addr) throw new Error('Payer wallet address is not set.')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr, fetchedCardinalUtxos)

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = buildRevealScript(pubkey, inscriptionDetails)
  const tapleaf = Tap.encodeScript(script)

  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const networkType = getBitcoinNetwork()

  const commitTxAddress = bitcoinjs.payments.p2tr({
    pubkey: Buffer.from(tpubkey, 'hex'),
    network: networkType,
  })

  const dummyRevealVout = [
    {
      value: 0,
      scriptPubKey: inscriptionWallet.outputScript,
    },
  ]
  if (payment > 0) {
    if (!paymentWallet) throw new Error('Payment wallet is not available.')

    dummyRevealVout.push({
      value: 0,
      scriptPubKey: paymentWallet.outputScript,
    })
  }
  const dummyRevealTx = Tx.create({
    vin: [
      {
        // Use the txid of the funding transaction used to send the sats.
        txid: '0000000000000000000000000000000000000000000000000000000000000000',
        // Specify the index value of the output that you are going to spend from.
        vout: 0,
        // Also include the value and script of that ouput.
        prevout: {
          // Feel free to change this if you sent a different amount.
          value: 0,
          // This is what our address looks like in script form.
          scriptPubKey: ['OP_1', tpubkey],
        },
      },
    ],
    vout: dummyRevealVout,
  })
  dummyRevealTx.vin[0]!.witness = [
    Buff.hex(
      '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
    ),
    script,
    cblock,
  ]

  const revealFee = Math.ceil(Tx.util.getTxSize(dummyRevealTx).vsize * feeRate)

  // get change addr pk
  const commitWallet = new WalletInfo(false, null, commitTxAddress.address, null, tpubkey)
  const unsignedCommitTxResp = buildTransaction(
    cardinalUtxos,
    forceInUtxos,
    payerWallet,
    [],
    commitWallet,
    changeWallet,
    feeRate,
    postage + revealFee + payment,
    null,
    null,
    minChange
  )
  const unsignedCommitTx = unsignedCommitTxResp.tx
  const commitFee = unsignedCommitTxResp.tx_fee
  const commitVout = unsignedCommitTxResp.output_index[0]!

  // psbt test for commit tx
  const unsignedCommitPsbt = await buildPsbtFromTx(
    unsignedCommitTx,
    cardinalUtxos,
    payerWallet,
    forceInUtxos
  )

  return {
    unsigned_commit_tx: unsignedCommitTx,
    unsigned_psbt_hex: unsignedCommitPsbt.toHex(),
    commit_vout: commitVout,
    output_value: unsignedCommitTx.outs[commitVout]!.value,
    commit_fee: commitFee,
    reveal_fee: revealFee,
  }
}

export interface ReclaimInput {
  utxo: string
  value: number
  script_type: UtxoInfo['script_type']
}

/**
 * Builds an unsigned combined commit tx that reclaims transfer inscriptions
 * back to the inscription wallet while paying for a new taproot commit
 * output in the same transaction.
 *
 * Output layout:
 *  - outputs `0..n-1`: one self-send per reclaim input, 1:1 with the
 *    reclaim inputs (same index, same value), so the ordinal sat carried
 *    by each reclaim input flows onto its own output.
 *  - output `n`: the taproot commit output, funded purely by the cardinal
 *    utxos (never by reclaimed sats).
 *  - any trailing output: payer change.
 *
 * The candidate utxo set is passed in by the caller; the only network access
 * is the PSBT-building step, which looks up each spent input's prevout tx
 * (mirrors buildCommitTx).
 */
export async function buildReclaimCommitTx(
  cardinalUtxos: UtxoInfo[],
  reclaimInputs: ReclaimInput[],
  payerWallet: WalletInfo,
  inscriptionWallet: WalletInfo,
  secret: string,
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number
): Promise<{
  unsignedCommitTx: bitcoinjs.Transaction
  unsignedPsbtHex: string
  commitVout: number
  commitOutputValue: number
  commitFee: number
  revealFee: number
}> {
  if (reclaimInputs.length === 0)
    throw new Error('buildReclaimCommitTx requires at least one reclaim input')

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)
  const script = buildRevealScript(pubkey, inscriptionDetails)
  const tapleaf = Tap.encodeScript(script)
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })
  const networkType = getBitcoinNetwork()
  const commitTxAddress = bitcoinjs.payments.p2tr({
    pubkey: Buffer.from(tpubkey, 'hex'),
    network: networkType,
  })

  // reveal-fee sizing: identical dummy-reveal construction as buildCommitTx
  const dummyRevealTx = Tx.create({
    vin: [
      {
        txid: '00'.repeat(32),
        vout: 0,
        prevout: { value: 0, scriptPubKey: ['OP_1', tpubkey] },
      },
    ],
    vout: [{ value: 0, scriptPubKey: inscriptionWallet.outputScript }],
  })
  dummyRevealTx.vin[0]!.witness = [Buff.hex('00'.repeat(64)), script, cblock]
  const revealFee = Math.ceil(Tx.util.getTxSize(dummyRevealTx).vsize * feeRate)
  const commitOutputValue = postage + revealFee

  const commitWallet = new WalletInfo(false, null, commitTxAddress.address, null, tpubkey)

  // reclaim self-sends first (1:1 with inputs), commit output after them
  const forceInUtxos: UtxoInfoWithWallet[] = reclaimInputs.map(r => ({
    utxo: r.utxo,
    value: r.value,
    script_type: r.script_type,
    wallet: inscriptionWallet,
  }))
  const outputWallets: WalletInfo[] = reclaimInputs.map(() => inscriptionWallet)
  const amounts: number[] = reclaimInputs.map(r => r.value)
  outputWallets.push(commitWallet)
  amounts.push(commitOutputValue)

  const built = buildTransactionMultiOutput(
    cardinalUtxos,
    forceInUtxos,
    payerWallet,
    outputWallets,
    amounts,
    payerWallet, // change
    feeRate
  )

  const commitVout = built.output_index[reclaimInputs.length]!

  const unsignedCommitPsbt = await buildPsbtFromTx(
    built.tx,
    cardinalUtxos,
    payerWallet,
    forceInUtxos
  )

  return {
    unsignedCommitTx: built.tx,
    unsignedPsbtHex: unsignedCommitPsbt.toHex(),
    commitVout,
    commitOutputValue,
    commitFee: built.tx_fee,
    revealFee,
  }
}

/**
 * Builds, signs, and validates a full reclaim commit+reveal pair offline: creates
 * a fresh secret, builds the reclaim commit tx (Task 1), signs its PSBT with the
 * caller-supplied signFunc, builds the reveal tx spending the relocated commit
 * output, and checks both signed txes with the mempool-accept validator before
 * returning them for the caller to broadcast.
 *
 * Pure w.r.t. network selection: all utxos are passed in by the caller. Network
 * access (prevout lookups, mempool-accept validation) is delegated to the same
 * helpers buildCommitTx-based flows already use.
 */
export async function assembleReclaimCommitAndReveal(
  cardinalUtxos: UtxoInfo[],
  reclaimInputs: ReclaimInput[],
  payerWallet: WalletInfo,
  inscriptionWallet: WalletInfo,
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number,
  signFunc: SignFunction
): Promise<{
  commitTxId: string
  signedCommitTxHex: string
  revealTxId: string
  signedRevealTxHex: string
  inscriptionId: string
  commitVout: number
  postage: number
  secret: string
}> {
  const secret = createSecretToken()

  const commit = await buildReclaimCommitTx(
    cardinalUtxos,
    reclaimInputs,
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage
  )

  const ordAddrIdxes = reclaimInputs.map((_, i) => i)

  const signedCommit = await signFunc(
    commit.unsignedPsbtHex,
    payerWallet.addr!,
    inscriptionWallet.addr!,
    ordAddrIdxes
  )

  const reveal = await buildRevealTx(
    inscriptionWallet,
    signedCommit.txId,
    commit.commitOutputValue,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    null,
    null,
    commit.commitVout
  )

  const isValid = await validateTxes([signedCommit.signedTxHex, reveal.signedTxHex])
  if (isValid == null)
    throw new Error('Reclaim commit/reveal validation failed (testmempoolaccept request failed)')
  for (const entry of isValid) {
    if (!entry.allowed) throw new Error(entry['reject-reason'])
  }

  return {
    commitTxId: signedCommit.txId,
    signedCommitTxHex: signedCommit.signedTxHex,
    revealTxId: reveal.txId,
    signedRevealTxHex: reveal.signedTxHex,
    inscriptionId: `${reveal.txId}i0`,
    commitVout: commit.commitVout,
    postage,
    secret,
  }
}

/**
 * Fetches the connected wallets' cardinal utxos and delegates to
 * assembleReclaimCommitAndReveal to build, sign, and validate the reclaim
 * commit+reveal pair, then broadcasts both txes unless dryRun is set.
 */
export async function mintWithReclaimsAll(
  inscriptionDetails: InscriptionDetails,
  reclaimInputs: ReclaimInput[],
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<{
  commitTxId: string
  signedCommitTxHex: string
  revealTxId: string
  signedRevealTxHex: string
  inscriptionId: string
  commitVout: number
  postage: number
  secret: string
}> {
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerWallet = new WalletInfo(
    false,
    null,
    userPaymentWallet.address,
    null,
    userPaymentWallet.pubkey
  )
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    userOrdinalsWallet.address,
    null,
    userOrdinalsWallet.pubkey
  )

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr!)

  const res = await assembleReclaimCommitAndReveal(
    cardinalUtxos,
    reclaimInputs,
    payerWallet,
    inscriptionWallet,
    inscriptionDetails,
    feeRate,
    postage,
    signFunc
  )

  if (!dryRun && (await broadcastTxes([res.signedCommitTxHex, res.signedRevealTxHex])) == null)
    throw new Error('Broadcast request failed')

  return res
}

/** One inscription of an `inscribeAllToOpReturn` package. */
export interface BatchedReveal {
  revealTxId: string
  signedRevealTxHex: string
  inscriptionId: string
  secret: string
}

/**
 * How the send tx of `inscribeAllToOpReturn` moves its inscriptions into OP_RETURN outputs.
 *
 * - `single`: one OP_RETURN output worth `postage * (n - 1) + 1` sats, which covers the first sat
 *   of every inscription input. The postage of all but the last inscription is burned.
 * - `interleaved`: a 1-sat OP_RETURN output per inscription, each followed by a payer output that
 *   takes back the rest of that inscription's postage (the last one merges into change). Only `n`
 *   sats are burned. Multiple OP_RETURN outputs relay from Bitcoin Core 30.
 * - `auto`: whichever of the two costs the payer less at the fee rate.
 *
 * Either layout leaves one postage minus a sat after its last OP_RETURN. The send pays the fee
 * from it, or adds a payer input and returns it as change when that costs less (low fee rates).
 */
export type BatchedSendLayout = 'single' | 'interleaved' | 'auto'

export interface InscribeAllToOpReturnResult {
  commitTxId: string
  signedCommitTxHex: string
  /** One reveal per inscription, in the order the inscriptions were given. */
  reveals: BatchedReveal[]
  sendTxId: string
  signedSendTxHex: string
  /** The send layout used; `auto` resolves to one of the other two. */
  sendLayout: Exclude<BatchedSendLayout, 'auto'>
  /** Miner fees of the commit, the reveals and the send, plus the sats burned in OP_RETURN outputs. */
  totalFee: number
}

interface BatchedSendPlan {
  layout: Exclude<BatchedSendLayout, 'auto'>
  /** Value of each reveal's inscription output. */
  postage: number
  outputWallets: WalletInfo[]
  amounts: number[]
  /** Sats the send puts into OP_RETURN outputs. */
  burned: number
  /**
   * Whether the send adds a payer input so the postage left after the last OP_RETURN returns as
   * change. Without one, that postage pays the fee when it covers it.
   */
  fundingInput: boolean
}

function batchedSendPlan(
  layout: Exclude<BatchedSendLayout, 'auto'>,
  fundingInput: boolean,
  count: number,
  inscriptionWallet: WalletInfo,
  payerWallet: WalletInfo,
  opReturnWallet: WalletInfo
): BatchedSendPlan {
  const dust = getDustValue(inscriptionWallet)
  if (layout === 'single') {
    const value = dust * (count - 1) + 1
    return {
      layout,
      postage: dust,
      outputWallets: [opReturnWallet],
      amounts: [value],
      burned: value,
      fundingInput,
    }
  }
  // Each input splits into 1 sat for its OP_RETURN and a payer output that must clear dust.
  const postage = Math.max(dust, getDustValue(payerWallet) + 1)
  const outputWallets: WalletInfo[] = []
  const amounts: number[] = []
  for (let i = 0; i < count; i++) {
    outputWallets.push(opReturnWallet)
    amounts.push(1)
    if (i < count - 1) {
      outputWallets.push(payerWallet)
      amounts.push(postage - 1)
    }
  }
  return { layout, postage, outputWallets, amounts, burned: count, fundingInput }
}

/**
 * The sats a send under `plan` costs the payer (miner fee plus burned sats), built offline with
 * placeholder inscription inputs, or `Infinity` when the cardinals cannot fund it.
 */
function batchedSendCost(
  plan: BatchedSendPlan,
  count: number,
  cardinals: UtxoInfo[],
  inscriptionWallet: WalletInfo,
  payerWallet: WalletInfo,
  feeRate: number
): number {
  const scriptType = utxoOutputTypeFromOutputScript(
    inscriptionWallet.outputScript,
    getBitcoinNetwork()
  )
  const placeholders: UtxoInfoWithWallet[] = Array.from({ length: count }, (_, i) => ({
    utxo: `${'00'.repeat(32)}:${i}`,
    value: plan.postage,
    script_type: scriptType,
    wallet: inscriptionWallet,
  }))
  try {
    const send = buildTransactionMultiOutput(
      cardinals,
      placeholders,
      payerWallet,
      plan.outputWallets,
      plan.amounts,
      payerWallet,
      feeRate,
      plan.fundingInput
    )
    return send.tx_fee + plan.burned
  } catch {
    return Infinity
  }
}

/**
 * The unsigned part of an `inscribeAllToOpReturn` package: the wallets, the send plan, one reveal
 * leaf per inscription and the unsigned commit tx. The send plan is the cheapest candidate at
 * `feeRate`; on a tie the earlier one, so a send adds a funding input only when that saves sats.
 * `cardinals` funds the commit in place of a fetch of the payer's cardinal UTXOs.
 */
async function planInscribeAllToOpReturn(
  inscriptions: InscriptionDetails[],
  reclaimInputs: ReclaimInput[],
  opReturnWallet: WalletInfo,
  feeRate: number,
  sendLayout: BatchedSendLayout,
  cardinals?: UtxoInfo[]
) {
  if (inscriptions.length === 0) throw new Error('inscribeAllToOpReturn requires an inscription')
  assertFeeRate(feeRate)

  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerWallet = new WalletInfo(
    false,
    null,
    userPaymentWallet.address,
    null,
    userPaymentWallet.pubkey
  )
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    userOrdinalsWallet.address,
    null,
    userOrdinalsWallet.pubkey
  )
  const payerAddr = payerWallet.addr
  const inscriptionAddr = inscriptionWallet.addr
  if (!payerAddr || !inscriptionAddr) throw new Error('Wallet address is not set.')

  const networkType = getBitcoinNetwork()
  const commitCardinals = cardinals ?? (await getCardinalUtxos(payerAddr))
  const layouts: Exclude<BatchedSendLayout, 'auto'>[] =
    sendLayout === 'auto' ? ['single', 'interleaved'] : [sendLayout]
  let plan: BatchedSendPlan | null = null
  let sendCost = Infinity
  for (const layout of layouts) {
    for (const fundingInput of [false, true]) {
      const candidate = batchedSendPlan(
        layout,
        fundingInput,
        inscriptions.length,
        inscriptionWallet,
        payerWallet,
        opReturnWallet
      )
      const cost = batchedSendCost(
        candidate,
        inscriptions.length,
        commitCardinals,
        inscriptionWallet,
        payerWallet,
        feeRate
      )
      if (plan == null || cost < sendCost) {
        plan = candidate
        sendCost = cost
      }
    }
  }
  if (plan == null) throw new Error('No batched send layout')
  const postage = plan.postage

  const leaves = inscriptions.map(inscription => {
    const secret = createSecretToken()
    const pubkey = get_pubkey(get_seckey(secret), true)
    const script = buildRevealScript(pubkey, inscription)
    const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: Tap.encodeScript(script) })

    const dummyRevealTx = Tx.create({
      vin: [
        {
          txid: '00'.repeat(32),
          vout: 0,
          prevout: { value: 0, scriptPubKey: ['OP_1', tpubkey] },
        },
      ],
      vout: [{ value: 0, scriptPubKey: inscriptionWallet.outputScript }],
    })
    dummyRevealTx.vin[0]!.witness = [Buff.hex('00'.repeat(64)), script, cblock]
    const revealFee = Math.ceil(Tx.util.getTxSize(dummyRevealTx).vsize * feeRate)

    const commitAddress = bitcoinjs.payments.p2tr({
      pubkey: Buffer.from(tpubkey, 'hex'),
      network: networkType,
    }).address
    return {
      inscription,
      secret,
      revealFee,
      commitWallet: new WalletInfo(false, null, commitAddress, null, tpubkey),
      commitOutputValue: postage + revealFee,
    }
  })

  const reclaimUtxos: UtxoInfoWithWallet[] = reclaimInputs.map(r => ({
    utxo: r.utxo,
    value: r.value,
    script_type: r.script_type,
    wallet: inscriptionWallet,
  }))
  const commit = buildTransactionMultiOutput(
    commitCardinals,
    reclaimUtxos,
    payerWallet,
    [...reclaimInputs.map(() => inscriptionWallet), ...leaves.map(l => l.commitWallet)],
    [...reclaimInputs.map(r => r.value), ...leaves.map(l => l.commitOutputValue)],
    payerWallet,
    feeRate
  )

  return {
    payerWallet,
    inscriptionWallet,
    payerAddr,
    inscriptionAddr,
    commitCardinals,
    plan,
    sendCost,
    leaves,
    reclaimUtxos,
    commit,
  }
}

/**
 * The fees an `inscribeAllToOpReturn` package with the same arguments would pay, built offline
 * without signing: the commit, the reveals, and the send's miner fee plus the sats it burns in
 * OP_RETURN outputs. The send is priced against `cardinals` (or a fresh fetch) as they stand
 * before the commit, the way `inscribeAllToOpReturn` picks its send plan.
 */
export async function getInscribeAllToOpReturnFee(
  inscriptions: InscriptionDetails[],
  reclaimInputs: ReclaimInput[],
  opReturnWallet: WalletInfo,
  feeRate: number,
  sendLayout: BatchedSendLayout = 'single',
  cardinals?: UtxoInfo[]
): Promise<{ totalFee: number; sendLayout: Exclude<BatchedSendLayout, 'auto'> }> {
  const { plan, sendCost, leaves, commit } = await planInscribeAllToOpReturn(
    inscriptions,
    reclaimInputs,
    opReturnWallet,
    feeRate,
    sendLayout,
    cardinals
  )
  if (!Number.isFinite(sendCost)) throw new Error('Not enough funds')
  return {
    totalFee: commit.tx_fee + leaves.reduce((sum, l) => sum + l.revealFee, 0) + sendCost,
    sendLayout: plan.layout,
  }
}

/**
 * `psbt`'s unsigned transaction with each input's scriptSig as signing will leave it, so its txid
 * is the signed tx's; or null when a signature lands in a scriptSig. SegWit and taproot inputs
 * sign in the witness and keep an empty scriptSig, and a P2SH-P2WPKH input's scriptSig is the push
 * of its redeem script. Any other input, such as legacy P2PKH, makes it null.
 */
export function unsignedTxOnceSigned(psbt: bitcoinjs.Psbt): bitcoinjs.Transaction | null {
  const tx = bitcoinjs.Transaction.fromBuffer(
    (psbt.data.globalMap.unsignedTx as unknown as { toBuffer: () => Buffer }).toBuffer()
  )
  const isWitnessProgram = (script: Buffer) =>
    (script[0] === 0x00 || (script[0]! >= 0x51 && script[0]! <= 0x60)) &&
    script.length === script[1]! + 2
  for (const [i, input] of psbt.data.inputs.entries()) {
    const txIn = tx.ins[i]!
    if (input.redeemScript) {
      if (!isWitnessProgram(input.redeemScript) || input.redeemScript[0] !== 0x00) return null
      txIn.script = bitcoinjs.script.compile([input.redeemScript])
      continue
    }
    const prevout =
      input.witnessUtxo?.script ??
      (input.nonWitnessUtxo
        ? bitcoinjs.Transaction.fromBuffer(input.nonWitnessUtxo).outs[txIn.index]?.script
        : undefined)
    if (!prevout || !isWitnessProgram(prevout)) return null
  }
  return tx
}

/**
 * Inscribes several inscriptions from one commit tx and sends them all to OP_RETURN outputs in
 * one tx, so the wallet signs two transactions however many inscriptions there are. The signed
 * package is validated with testmempoolaccept and returned for the caller to broadcast.
 *
 * Commit outputs: one self-send per reclaim input (same index and value as the input), then one
 * taproot commit output per inscription, then payer change. Each inscription keeps its own reveal
 * tx, because BRC-20 indexers only accept an inscription made in the first input of its reveal.
 *
 * The send tx spends the reveal outputs as inputs `0..n-1` in the given order, and its outputs
 * follow `sendLayout`. Either way the first sat of every inscription input lands in an OP_RETURN
 * output, in input order, so ord moves each inscription there and indexers process them in that
 * order.
 *
 * With `signManyFunc`, the commit and the send are signed in one wallet prompt whenever the commit's
 * txid is known before signing (see `unsignedTxOnceSigned`); the package is refused if the signed
 * commit's txid differs. Otherwise `signFunc` signs the commit, then the send.
 */
export async function inscribeAllToOpReturn(
  inscriptions: InscriptionDetails[],
  reclaimInputs: ReclaimInput[],
  opReturnWallet: WalletInfo,
  feeRate: number,
  signFunc: SignFunction,
  sendLayout: BatchedSendLayout = 'single',
  signManyFunc: SignManyFunction | null = null
): Promise<InscribeAllToOpReturnResult> {
  const {
    payerWallet,
    inscriptionWallet,
    payerAddr,
    inscriptionAddr,
    commitCardinals,
    plan,
    leaves,
    reclaimUtxos,
    commit,
  } = await planInscribeAllToOpReturn(
    inscriptions,
    reclaimInputs,
    opReturnWallet,
    feeRate,
    sendLayout
  )
  const networkType = getBitcoinNetwork()
  const postage = plan.postage

  const commitPsbt = await buildPsbtFromTx(commit.tx, commitCardinals, payerWallet, reclaimUtxos)
  const commitRequest: SignPsbtRequest = {
    unsignedPsbtHex: commitPsbt.toHex(),
    paymentAddr: payerAddr,
    ordAddr: inscriptionAddr,
    ordAddrIdxes: reclaimInputs.map((_, i) => i),
  }
  // With a batch signer and a commit txid that signing leaves alone, the send is built against the
  // unsigned commit and both are signed in one prompt; otherwise the commit is signed first.
  const presignedCommit = signManyFunc ? unsignedTxOnceSigned(commitPsbt) : null
  let signedCommit: SignResponse | null = null
  if (!presignedCommit) {
    signedCommit = await signFunc(
      commitRequest.unsignedPsbtHex,
      commitRequest.paymentAddr,
      commitRequest.ordAddr,
      commitRequest.ordAddrIdxes
    )
  }
  const commitTxId = presignedCommit ? presignedCommit.getId() : signedCommit!.txId
  const commitTxHex = presignedCommit ? presignedCommit.toHex() : signedCommit!.signedTxHex

  const reveals: BatchedReveal[] = []
  for (const [i, leaf] of leaves.entries()) {
    const reveal = await buildRevealTx(
      inscriptionWallet,
      commitTxId,
      leaf.commitOutputValue,
      leaf.secret,
      leaf.inscription,
      feeRate,
      postage,
      null,
      null,
      commit.output_index[reclaimInputs.length + i]!
    )
    reveals.push({
      revealTxId: reveal.txId,
      signedRevealTxHex: reveal.signedTxHex,
      inscriptionId: `${reveal.txId}i0`,
      secret: leaf.secret,
    })
  }

  let send: BuildTransactionResult
  let signedSend: SignResponse
  try {
    saveExtraUtxos([commitTxHex, ...reveals.map(r => r.signedRevealTxHex)], null)

    // A single-address wallet sees the reveal and reclaim outputs as cardinal; they carry inscriptions.
    const revealTxIds = new Set(reveals.map(r => r.revealTxId))
    const sendCardinals = (await getCardinalUtxos(payerAddr)).filter(
      u => !revealTxIds.has(u.txid) && !(u.txid === commitTxId && u.vout < reclaimInputs.length)
    )
    const inscriptionScriptType = utxoOutputTypeFromOutputScript(
      inscriptionWallet.outputScript,
      networkType
    )
    const inscriptionUtxos: UtxoInfoWithWallet[] = reveals.map(r => ({
      utxo: `${r.revealTxId}:0`,
      value: postage,
      script_type: inscriptionScriptType,
      wallet: inscriptionWallet,
    }))
    send = buildTransactionMultiOutput(
      sendCardinals,
      inscriptionUtxos,
      payerWallet,
      plan.outputWallets,
      plan.amounts,
      payerWallet,
      feeRate,
      plan.fundingInput
    )
    const sendPsbt = await buildPsbtFromTx(send.tx, sendCardinals, payerWallet, inscriptionUtxos)
    const sendRequest: SignPsbtRequest = {
      unsignedPsbtHex: sendPsbt.toHex(),
      paymentAddr: payerAddr,
      ordAddr: inscriptionAddr,
      ordAddrIdxes: inscriptionUtxos.map((_, i) => i),
    }
    if (presignedCommit) {
      const [commitResponse, sendResponse] = await signManyFunc!([commitRequest, sendRequest])
      if (!commitResponse || !sendResponse)
        throw new Error('The wallet returned too few signed txs.')
      // The send spends the commit through the reveals, so a commit the wallet altered orphans it.
      if (commitResponse.txId !== commitTxId)
        throw new Error('The wallet changed the commit tx while signing; nothing was broadcast.')
      signedCommit = commitResponse
      signedSend = sendResponse
    } else {
      signedSend = await signFunc(
        sendRequest.unsignedPsbtHex,
        sendRequest.paymentAddr,
        sendRequest.ordAddr,
        sendRequest.ordAddrIdxes
      )
    }
  } finally {
    clearExtraUtxos()
  }
  if (!signedCommit) throw new Error('The commit tx is unsigned.')

  const isValid = await validateTxes([
    signedCommit.signedTxHex,
    ...reveals.map(r => r.signedRevealTxHex),
    signedSend.signedTxHex,
  ])
  if (isValid == null)
    throw new Error('Batched inscription validation failed (testmempoolaccept request failed)')
  for (const entry of isValid) {
    if (!entry.allowed) throw new Error(entry['reject-reason'])
  }

  return {
    commitTxId: signedCommit.txId,
    signedCommitTxHex: signedCommit.signedTxHex,
    reveals,
    sendTxId: signedSend.txId,
    signedSendTxHex: signedSend.signedTxHex,
    sendLayout: plan.layout,
    totalFee:
      commit.tx_fee + leaves.reduce((sum, l) => sum + l.revealFee, 0) + send.tx_fee + plan.burned,
  }
}

/**
 * Estimates the fees for a reclaim mint by building the unsigned reclaim
 * commit tx (Task 1) and a fee-sizing reveal tx offline, without signing or
 * broadcasting. Mirrors mintWithExtraInputInCommitFeeRate. `fetchedCardinalUtxos`, the
 * payer's `fetchCardinalUtxos` response, funds the commit in place of a new fetch.
 */
export async function mintWithReclaimsCheckFees(
  inscriptionDetails: InscriptionDetails,
  reclaimInputs: ReclaimInput[],
  feeRate: number,
  postage: number | null,
  fetchedCardinalUtxos?: Utxo[]
): Promise<{
  unsigned_commit_tx_hex: string
  signed_reveal_tx_hex: string
  inscription_id: string
  total_fee: number
  commit_vout: number
}> {
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerWallet = new WalletInfo(
    false,
    null,
    userPaymentWallet.address,
    null,
    userPaymentWallet.pubkey
  )
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    userOrdinalsWallet.address,
    null,
    userOrdinalsWallet.pubkey
  )

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr!, fetchedCardinalUtxos)

  const secret = createSecretToken()
  const commit = await buildReclaimCommitTx(
    cardinalUtxos,
    reclaimInputs,
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage
  )

  const dummyCommitTxId = commit.unsignedCommitTx.getId()
  const reveal = await buildRevealTx(
    inscriptionWallet,
    dummyCommitTxId,
    commit.commitOutputValue,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    null,
    null,
    commit.commitVout
  )

  return {
    unsigned_commit_tx_hex: commit.unsignedCommitTx.toHex(),
    signed_reveal_tx_hex: reveal.signedTxHex,
    inscription_id: `${reveal.txId}i0`,
    total_fee: commit.commitFee + commit.revealFee,
    commit_vout: commit.commitVout,
  }
}

/**
 * Resolves reclaim inscriptions (transfer inscriptions to reclaim toward the
 * base-deposit sufficiency check) into `ReclaimInput`s for
 * `buildReclaimCommitTx`/`mintWithReclaimsAll`/`mintWithReclaimsCheckFees`.
 *
 * Looks up each inscription's current UTXO via `getInscriptionDetails` and
 * enforces that it sits at sat offset 0 of its satpoint, which the reclaim
 * commit tx assumes when self-sending the reclaim input.
 */
export async function resolveReclaimInputs(
  reclaimInscriptions: { inscriptionId: string; amount: bigint }[],
  ordinalsAddress: string
): Promise<ReclaimInput[]> {
  const out: ReclaimInput[] = []
  const seenUtxos = new Set<string>()
  for (const r of reclaimInscriptions) {
    const details = await getInscriptionDetails(r.inscriptionId, ordinalsAddress)
    if (details == null)
      throw new Error(`Reclaim inscription not found in wallet: ${r.inscriptionId}`)
    if (details.satpoint.split(':')[2] !== '0')
      throw new Error(`Reclaim inscription not at sat offset 0: ${r.inscriptionId}`)
    const [txid, vout] = details.satpoint.split(':')
    const utxo = `${txid}:${vout}`
    if (seenUtxos.has(utxo))
      throw new Error(`Duplicate reclaim UTXO: ${utxo} (inscription ${r.inscriptionId})`)
    seenUtxos.add(utxo)
    out.push({ utxo, value: details.value, script_type: details.script_type })
  }
  return out
}

interface BuildCommitTxMultipleResult {
  unsigned_psbt_hex: string
  /** The index of the taproot commit output. */
  commit_vout: number
  output_value: number
  commit_fee: number
  reveal_fee: number
}
async function buildCommitTxMultiple(
  payerWallet: WalletInfo,
  inscriptionWallet: WalletInfo,
  secret: string,
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number,
  paymentWallet: WalletInfo | null,
  payment: number | null
): Promise<BuildCommitTxMultipleResult> {
  if (!payment || payment < 0) payment = 0

  const changeWallet = payerWallet
  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr as string)
  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)
  const script = buildRevealScriptMultiple(pubkey, inscriptionDetailsArray, postage)
  const tapleaf = Tap.encodeScript(script)
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })
  const networkType = getBitcoinNetwork()
  const commitTxAddress = bitcoinjs.payments.p2tr({
    pubkey: Buffer.from(tpubkey, 'hex'),
    network: networkType,
  })

  const dummyRevealVout = []
  for (let i = 0; i < inscriptionDetailsArray.length; i++) {
    dummyRevealVout.push({
      value: 0,
      scriptPubKey: inscriptionWallet.outputScript,
    })
  }
  if (payment && payment > 0) {
    dummyRevealVout.push({
      value: 0,
      scriptPubKey: paymentWallet?.outputScript,
    })
  }
  const dummyRevealTx = Tx.create({
    vin: [
      {
        // Use the txid of the funding transaction used to send the sats.
        txid: '0000000000000000000000000000000000000000000000000000000000000000',
        // Specify the index value of the output that you are going to spend from.
        vout: 0,
        // Also include the value and script of that ouput.
        prevout: {
          // Feel free to change this if you sent a different amount.
          value: 0,
          // This is what our address looks like in script form.
          scriptPubKey: ['OP_1', tpubkey],
        },
      },
    ],
    vout: dummyRevealVout,
  })
  dummyRevealTx.vin[0]!.witness = [
    Buff.hex(
      '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
    ),
    script,
    cblock,
  ]

  const revealFee = Math.ceil(Tx.util.getTxSize(dummyRevealTx).vsize * feeRate)

  // get change addr pk
  const commitWallet = new WalletInfo(false, null, commitTxAddress.address, null, tpubkey)
  const unsignedCommitTxResp = buildTransaction(
    cardinalUtxos,
    [],
    payerWallet,
    [],
    commitWallet,
    changeWallet,
    feeRate,
    postage * inscriptionDetailsArray.length + revealFee + (payment || 0),
    null,
    null
  )
  const unsignedCommitTx = unsignedCommitTxResp.tx
  const commitFee = unsignedCommitTxResp.tx_fee

  const commitVout = unsignedCommitTxResp.output_index[0]!

  // psbt test for commit tx
  const unsignedCommitPsbt = await buildPsbtFromTx(unsignedCommitTx, cardinalUtxos, payerWallet, [])

  return {
    unsigned_psbt_hex: unsignedCommitPsbt.toHex(),
    commit_vout: commitVout,
    output_value: unsignedCommitTx.outs[commitVout]!.value,
    commit_fee: commitFee,
    reveal_fee: revealFee,
  }
}

interface BuildCommitTxWithParentResult {
  unsigned_psbt_hex: string
  /** The index of the taproot commit output. */
  commit_vout: number
  output_value: number
  commit_fee: number
}
async function buildCommitTxWithParent(
  payerWallet: WalletInfo,
  inscriptionWallet: WalletInfo,
  secret: string,
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number,
  parentInscriptionId: string
): Promise<BuildCommitTxWithParentResult> {
  const changeWallet = payerWallet
  const parentInscriptionIdBuff = convertInscriptionIdToBuffer(parentInscriptionId)

  if (!payerWallet.addr) throw new Error('Payer wallet address is not set.')

  if (!inscriptionWallet.addr) throw new Error('Inscription wallet address is not set.')

  const parentUtxo = await getInscriptionUtxo(inscriptionWallet.addr, parentInscriptionId)
  if (!parentUtxo) throw new Error('Parent inscription utxo not found in ordinal utxos')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = buildRevealScript(pubkey, inscriptionDetails, parentInscriptionIdBuff)
  const tapleaf = Tap.encodeScript(script)

  const [tpubkey] = Tap.getPubKey(pubkey, { target: tapleaf })

  const networkType = getBitcoinNetwork()

  const commitTxAddress = bitcoinjs.payments.p2tr({
    pubkey: Buffer.from(tpubkey, 'hex'),
    network: networkType,
  })

  // get change addr pk
  const commitWallet = new WalletInfo(false, null, commitTxAddress.address, null, tpubkey)
  const unsignedCommitTxResp = buildTransaction(
    cardinalUtxos,
    [],
    payerWallet,
    [],
    commitWallet,
    changeWallet,
    feeRate,
    postage,
    null,
    null
  )
  const unsignedCommitTx = unsignedCommitTxResp.tx
  const commitFee = unsignedCommitTxResp.tx_fee
  const commitVout = unsignedCommitTxResp.output_index[0]!

  // psbt test for commit tx
  const unsignedCommitPsbt = await buildPsbtFromTx(unsignedCommitTx, cardinalUtxos, payerWallet, [])

  return {
    unsigned_psbt_hex: unsignedCommitPsbt.toHex(),
    commit_vout: commitVout,
    output_value: unsignedCommitTx.outs[commitVout]!.value,
    commit_fee: commitFee,
  }
}

/**
 * Builds a transaction with multiple outputs. This is used for batch minting or batch sending.
 *
 * @param utxoArray - array of UTXOs to select from
 * @param forceInUtxos - array of UTXOs that must be included in the transaction (e.g. for minting, the UTXO with the inscription must be included)
 * @param payerWallet - the wallet that will pay for the transaction (must be the same for all inputs)
 * @param outputWallets - array of wallets to send the outputs to (must be the same length as amounts)
 * @param amounts - array of amounts to send to each output wallet (must be the same length as outputWallets)
 * @param changeWallet - the wallet to send the change to
 * @param feeRate - the fee rate in sat/vbyte
 * @param fundingInput - add a payer UTXO even when `forceInUtxos` cover the outputs and the fee, so
 *   their surplus returns as change instead of going to the miner
 *
 * @returns an object containing the built transaction and the fee paid for the transaction
 */
export function buildTransactionMultiOutput(
  utxoArray: UtxoInfo[],
  forceInUtxos: UtxoInfoWithWallet[],
  payerWallet: WalletInfo,
  outputWallets: WalletInfo[],
  amounts: number[],
  changeWallet: WalletInfo,
  feeRate: number,
  fundingInput = false
): BuildTransactionResult {
  return withSetAsideReserve(
    (reserve, pool) =>
      buildTransactionMultiOutputWithReserve(
        pool,
        forceInUtxos,
        payerWallet,
        outputWallets,
        amounts,
        changeWallet,
        feeRate,
        fundingInput,
        reserve
      ),
    utxoArray,
    0
  )
}

// `reserve` is extra input value selection gathers for change, to pay set-aside outputs.
function buildTransactionMultiOutputWithReserve(
  utxoArray: UtxoInfo[],
  forceInUtxos: UtxoInfoWithWallet[],
  payerWallet: WalletInfo,
  outputWallets: WalletInfo[],
  amounts: number[],
  changeWallet: WalletInfo,
  feeRate: number,
  fundingInput: boolean,
  reserve: number
): BuildTransactionResult {
  if (outputWallets.length !== amounts.length)
    throw new Error('output_wallets and amounts must have the same length')
  const utxos = utxoArray.slice()

  utxos.sort((a: UtxoInfo, b: UtxoInfo) => a.value - b.value)
  const inputs = []
  const outputs = []

  for (let i = 0; i < outputWallets.length; i++) {
    outputs.push({
      wallet: outputWallets[i]!,
      out_script: outputWallets[i]!.outputScript,
      value: amounts[i]!,
    })
  }

  let totalTargetAmount = 0
  for (let i = 0; i < amounts.length; i++) {
    totalTargetAmount += amounts[i]!
  }

  let totalInputAmount = 0
  for (const utxo of forceInUtxos) {
    // TODO: these may also come from output_wallet (e.g. rune_mint)
    inputs.push({ utxo, wallet: utxo.wallet })
    totalInputAmount += utxo.value
    for (let i = 0; i < utxos.length; i++) {
      if (utxos[i]!.utxo === utxo.utxo) {
        utxos.splice(i, 1)
        break
      }
    }
  }

  if (fundingInput) {
    // The smallest UTXO worth more than the input and the change output it adds, one without
    // used inscriptions when there is one.
    const changeFee = Math.ceil((changeWallet.outputScript!.length + 9) * feeRate)
    const worthIt = (u: UtxoInfo) =>
      u.value > calculateAdditionalFee(u.script_type, feeRate) + changeFee
    let index = utxos.findIndex(u => worthIt(u) && !isInscribed(u))
    if (index === -1) index = utxos.findIndex(worthIt)
    if (index === -1) throw new Error('Not enough funds')
    const [utxo] = utxos.splice(index, 1)
    inputs.push({ utxo: utxo!, wallet: payerWallet })
    totalInputAmount += utxo!.value
  }

  let fee = estimateFee(inputs, outputs, feeRate)
  while (totalInputAmount < totalTargetAmount + fee + reserve) {
    let deficit = totalTargetAmount + fee + reserve - totalInputAmount
    // const additional_fee = Math.ceil(is_payer_p2sh ? bis.ADDITIONAL_INPUT_P2SH_VBYTES : bis.ADDITIONAL_INPUT_P2TR_VBYTES) * fee_rate // TODO: fix here!!
    while (deficit > 0) {
      if (utxos.length === 0) throw new Error('Not enough funds')

      const lastUtxo = utxos[utxos.length - 1]!
      const requiredAmount = deficit + calculateAdditionalFee(lastUtxo.script_type, feeRate)

      if (lastUtxo.value >= requiredAmount) {
        // First try to find a "good" UTXO (value > 10000)
        for (const utxo of utxos.filter(utxo => utxo.value > 10000)) {
          const needed = deficit + calculateAdditionalFee(utxo.script_type, feeRate)
          if (utxo.value >= needed) {
            inputs.push({ utxo, wallet: payerWallet })
            totalInputAmount += utxo.value
            deficit = 0
            utxos.splice(utxos.indexOf(utxo), 1)
            break
          }
        }

        // Only if deficit is still not covered, try all UTXOs
        if (deficit > 0) {
          for (const utxo of utxos) {
            const needed = deficit + calculateAdditionalFee(utxo.script_type, feeRate)
            if (utxo.value >= needed) {
              inputs.push({ utxo, wallet: payerWallet })
              totalInputAmount += utxo.value
              deficit = 0
              utxos.splice(utxos.indexOf(utxo), 1)
              break
            }
          }
        }
      } else {
        const benefit =
          utxos[utxos.length - 1]!.value -
          calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
        deficit -= benefit
        inputs.push({ utxo: utxos.pop()!, wallet: payerWallet })
        totalInputAmount += inputs[inputs.length - 1]!.utxo.value
      }
    }
  }

  if (!changeWallet.outputScript)
    throw new Error('build_transaction_multi_output change_wallet.outputScript is null')

  const additionalChangeOutputFee = Math.ceil((changeWallet.outputScript.length + 9) * feeRate)
  fee = estimateFee(inputs, outputs, feeRate)
  const excess = totalInputAmount - fee - totalTargetAmount
  let feePayerOutputIdx = -1
  if (excess > getDustValue(changeWallet) + additionalChangeOutputFee) {
    // we have enough to output to change
    const toStrip = totalInputAmount - totalTargetAmount
    outputs.push({
      wallet: changeWallet,
      out_script: changeWallet.outputScript,
      value: toStrip,
    })
    feePayerOutputIdx = outputs.length - 1
  }

  // op_returns
  // output_wallet <- amount (+ possibly fees)
  // payment_wallet <- payment (may not exist)
  // change_wallet <- change (may not exist)

  fee = estimateFee(inputs, outputs, feeRate)
  if (feePayerOutputIdx === -1) {
    if (totalInputAmount - totalTargetAmount < fee) {
      throw new Error('Not enough funds to pay fee')
    }
  } else {
    if (
      outputs[feePayerOutputIdx]!.value - fee <
      getDustValue(outputs[feePayerOutputIdx]!.wallet)
    ) {
      throw new Error('Fee payer output cannot pay the fee')
    }
    outputs[feePayerOutputIdx]!.value -= fee
  }

  const outputIndex = setAsideUsedInscriptions(
    inputs,
    forceInUtxos.length,
    outputs,
    feePayerOutputIdx,
    changeWallet,
    feeRate
  )
  const finalTx = constructTxFromInOuts(inputs, outputs)
  recordSetAside(finalTx, inputs, forceInUtxos.length, outputs)
  let txFee = 0
  for (const input of inputs) {
    txFee += input.utxo.value
  }
  for (const output of outputs) {
    txFee -= output.value
  }

  return {
    tx: finalTx,
    tx_fee: txFee,
    output_index: outputIndex,
  }
}

interface SendMultiInscriptionWithBufferResult {
  txid: string
  signed_tx_hex: string
  output_utxos: string[]
  output_values: number[]
  buffer_utxo: string
  buffer_output_value: number
}

export async function sendMultiInscriptionWithBuffer(
  inscriptionIds: string[],
  targetPostages: number[],
  targetAddr: string,
  bufferValue: number,
  feeRate: number,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean
): Promise<SendMultiInscriptionWithBufferResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets) throw new Error('Wallets not found')

  // set to null if 0
  if (payment === 0) {
    paymentAddr = null
    payment = null
  }

  if (!Array.isArray(inscriptionIds)) throw new Error('inscription_ids must be an array')
  if (!Array.isArray(targetPostages)) throw new Error('target_postages must be an array')
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')
  for (const tp of targetPostages) {
    if (tp != null && (typeof tp != 'number' || !Number.isInteger(tp)))
      throw new Error('target_postages must be an array of integers or null')
  }
  for (const inscrId of inscriptionIds) {
    if (typeof inscrId != 'string') throw new Error('inscription_ids must be an array of strings')
  }
  assertFeeRate(feeRate)
  if (typeof bufferValue != 'number' || !Number.isInteger(bufferValue))
    throw new Error('buffer_value must be an integer')
  if (typeof targetAddr != 'string') throw new Error('target_addr must be a string')
  if (typeof dryRun != 'boolean') throw new Error('dry_run must be a boolean')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer or null')
  if (paymentAddr != null && typeof paymentAddr != 'string')
    throw new Error('payment_addr must be a string or null')
  if (payment != null && paymentAddr == null)
    throw new Error('payment_addr must be provided if payment is provided')
  if (payment == null && paymentAddr != null)
    throw new Error('payment must be provided if payment_addr is provided')

  const targetWallet = new WalletInfo(false, null, targetAddr, null, null)

  let paymentWallet = null
  if (payment != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
    if (payment < getDustValue(paymentWallet)) throw new Error('payment must be bigger than dust')
  }

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  return await sendMultiInscriptionWithBufferAll(
    inscriptionIds,
    targetPostages,
    targetWallet,
    bufferValue,
    feeRate,
    paymentWallet,
    payment,
    dryRun,
    signFn
  )
}

async function sendMultiInscriptionWithBufferAll(
  inscriptionIds: string[],
  targetPostages: number[],
  targetWallet: WalletInfo,
  bufferValue: number,
  feeRate: number,
  paymentWallet: WalletInfo | null,
  payment: number | null,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<SendMultiInscriptionWithBufferResult> {
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')

  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const paymentAddr = userPaymentWallet.address
  const paymentPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, paymentAddr, null, paymentPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )

  const inputUtxos: UtxoInfoWithWallet[] = []
  const targetWallets: WalletInfo[] = []
  const amounts: number[] = []
  const inscrWalletSignIdxes: number[] = []

  if (!inscriptionWallet.addr) throw new Error('inscription_wallet is null')

  for (let i = 0; i < inscriptionIds.length; i++) {
    const inscriptionDetails = await getInscriptionDetails(
      inscriptionIds[i]!,
      inscriptionWallet.addr
    )
    if (inscriptionDetails == null) {
      throw new Error('Inscription cannot be found in wallet')
    }
    if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
      // TODO: implement this case as well
      throw new Error('Inscription is at the first sat of utxo')
    }
    let targetPostage = targetPostages[i]!
    if (targetPostage <= 0 || targetPostage == null) {
      targetPostage = inscriptionDetails.value // NOTE: do not change the inscription_value
    }

    if (i !== inscriptionIds.length - 1) {
      if (targetPostage !== inscriptionDetails.value) {
        throw new Error('All inscriptions except the last one must have the same output value')
      }
    }

    if (targetPostage < getDustValue(targetWallet)) {
      throw new Error('Target postage is below dust value')
    }

    const inscrUtxo = {
      utxo: `${inscriptionDetails.satpoint.split(':')[0]}:${inscriptionDetails.satpoint.split(':')[1]}`,
      value: inscriptionDetails.value,
      script_type: inscriptionDetails.script_type,
      wallet: inscriptionWallet,
    }
    inputUtxos.push(inscrUtxo)
    targetWallets.push(targetWallet)
    amounts.push(targetPostage)
    inscrWalletSignIdxes.push(i)
  }
  targetWallets.push(targetWallet)
  amounts.push(bufferValue)
  if (payment != null) {
    targetWallets.push(paymentWallet as WalletInfo)
    amounts.push(payment)
  }

  if (!payerWallet.addr) throw new Error('payer_wallet.addr is null')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  const unsignedTxResp = buildTransactionMultiOutput(
    cardinalUtxos,
    inputUtxos,
    payerWallet,
    targetWallets,
    amounts,
    payerWallet,
    feeRate
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, inputUtxos)
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(
    unsignedPsbtHex,
    payerWallet.addr,
    inscriptionWallet.addr,
    inscrWalletSignIdxes
  )

  const isValid = await validateTxes([signedTx.signedTxHex])
  if (isValid == null)
    throw new Error(
      'Multi-inscription buffered send validation failed (testmempoolaccept request failed)'
    )
  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  const outputUtxos: string[] = []
  const outputValues: number[] = []
  let bufferUtxo: string | null = null
  let bufferOutputValue: number | null = null
  for (let i = 0; i < inscriptionIds.length; i++) {
    const vout = unsignedTxResp.output_index[i]!
    outputUtxos.push(`${signedTx.txId}:${vout}`)
    outputValues.push(unsignedTx.outs[vout]!.value)
  }
  const bufferVout = unsignedTxResp.output_index[inscriptionIds.length]!
  bufferUtxo = `${signedTx.txId}:${bufferVout}`
  bufferOutputValue = unsignedTx.outs[bufferVout]!.value

  if (dryRun) {
    // TODO: hacky part, change or remove
    txHexByIdCache[signedTx.txId] = signedTx.signedTxHex
    return {
      txid: signedTx.txId,
      signed_tx_hex: signedTx.signedTxHex,
      output_utxos: outputUtxos,
      output_values: outputValues,
      buffer_utxo: bufferUtxo,
      buffer_output_value: bufferOutputValue,
    }
  }

  if ((await broadcastTxes([signedTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')

  return {
    txid: signedTx.txId,
    signed_tx_hex: signedTx.signedTxHex,
    output_utxos: outputUtxos,
    output_values: outputValues,
    buffer_utxo: bufferUtxo,
    buffer_output_value: bufferOutputValue,
  }
}

/**
 * Sends an inscription to a target address with specified postage and fee rate. This function is used for sending a single inscription, but it can also be used for batch sending by calling it multiple times with different inscription IDs and the same target address.
 *
 * @param inscriptionId - the ID of the inscription to send
 * @param targetWallet - the wallet to send the inscription to (only the address field is used)
 * @param targetPostage - the amount of satoshis to send with the inscription (must be greater than or equal to the dust value for the target wallet)
 * @param feeRate - the fee rate in sat/vbyte to use for the transaction
 * @param dryRun - if true, the transaction will not be broadcasted and the signed transaction hex will be returned for inspection
 * @param signFunc - the function to use for signing the transaction, which takes the unsigned PSBT hex, payer address, inscription address, and an array of input indexes that belong to the inscription wallet, and returns an object containing the signed transaction hex and transaction ID
 *
 * @returns an object containing the transaction ID, signed transaction hex, vout index of the output containing the inscription, and the value of the output containing the inscription
 */
export async function sendInscriptionAll(
  inscriptionId: string,
  targetWallet: WalletInfo,
  targetPostage: number | null,
  feeRate: number,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<SendInscriptionResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const paymentAddr = userPaymentWallet.address
  const paymentPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, paymentAddr, null, paymentPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )

  if (!inscriptionWallet.addr) throw new Error('inscription_wallet is null')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payerWallet.addr) throw new Error('payer_wallet.addr is null')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  if (targetPostage == null || targetPostage <= 0) {
    targetPostage = getDustValue(targetWallet)
  }

  const inscrUtxo: UtxoInfoWithWallet = {
    utxo: `${inscriptionDetails.satpoint.split(':')[0]}:${inscriptionDetails.satpoint.split(':')[1]}`,
    value: inscriptionDetails.value,
    script_type: inscriptionDetails.script_type,
    wallet: inscriptionWallet,
  }

  const unsignedTxResp = buildTransaction(
    cardinalUtxos,
    [inscrUtxo],
    payerWallet,
    [],
    targetWallet,
    payerWallet,
    feeRate,
    targetPostage,
    null,
    null
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, [inscrUtxo])
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [0])

  const isValid = await validateTxes([signedTx.signedTxHex])
  if (isValid == null)
    throw new Error('Inscription send validation failed (testmempoolaccept request failed)')
  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    txHexByIdCache[signedTx.txId] = signedTx.signedTxHex
    return {
      txId: signedTx.txId,
      signedTxHex: signedTx.signedTxHex,
      vout: 0,
      outputValue: unsignedTx.outs[0]!.value,
    }
  }

  if ((await broadcastTxes([signedTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')

  return {
    txId: signedTx.txId,
    signedTxHex: signedTx.signedTxHex,
    vout: 0,
    outputValue: unsignedTx.outs[0]!.value,
  }
}

export interface InscriptionUTXODetails {
  satpoint: string
  value: number
  script_type:
    | 'pubkeyhash'
    | 'scripthash'
    | 'witness_v0_keyhash'
    | 'witness_v0_scripthash'
    | 'witness_v1_taproot'
    | 'pubkey'
    | 'anchor'
    | 'witness_unknown'
    | 'nulldata'
    | 'multisig'
    | 'nonstandard'
  block_height: number | null
  utxo: string
}
/**
 * Locates an inscription's UTXO on `inscriptionAddr`. Searches `ordinalUtxos` when given;
 * otherwise reads it with `getInscriptionUtxo` (saved extra transactions first, then the
 * chain provider).
 */
export async function getInscriptionDetails(
  inscriptionId: string,
  inscriptionAddr: string,
  ordinalUtxos?: OrdinalUtxoInfo[]
): Promise<InscriptionUTXODetails | null> {
  if (ordinalUtxos) return findInscriptionDetails(inscriptionId, ordinalUtxos)

  const utxo = await getInscriptionUtxo(inscriptionAddr, inscriptionId)
  return utxo ? findInscriptionDetails(inscriptionId, [utxo]) : null
}

function findInscriptionDetails(
  inscriptionId: string,
  utxos: OrdinalUtxoInfo[]
): InscriptionUTXODetails | null {
  for (const utxo of utxos) {
    for (let i = 0; i < utxo.inscription_ids.length; i++) {
      if (utxo.inscription_ids[i]! === inscriptionId) {
        return {
          satpoint: utxo.satpoints[i]!,
          value: utxo.value,
          script_type: utxo.script_type,
          block_height: utxo.block_height ?? null,
          utxo: utxo.utxo,
        }
      }
    }
  }

  return null
}

async function sendMultiInscriptionWithBufferFeeRateAll(
  inscriptionIds: string[],
  targetPostages: number[],
  targetWallet: WalletInfo,
  bufferValue: number,
  feeRate: number,
  paymentWallet: WalletInfo | null,
  payment: number | null
): Promise<number> {
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')

  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const paymentAddr = userPaymentWallet.address
  const paymentPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, paymentAddr, null, paymentPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )

  const inputUtxos: UtxoInfoWithWallet[] = []
  const targetWallets: WalletInfo[] = []
  const amounts: number[] = []
  const inscrWalletSignIdxes: number[] = []

  if (!inscriptionWallet.addr) throw new Error('Inscription wallet address is not set.')

  for (let i = 0; i < inscriptionIds.length; i++) {
    const inscriptionDetails = await getInscriptionDetails(
      inscriptionIds[i]!,
      inscriptionWallet.addr
    )
    if (inscriptionDetails == null) {
      throw new Error('Inscription cannot be found in wallet')
    }
    if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
      // TODO: implement this case as well
      throw new Error('Inscription is at the first sat of utxo')
    }
    let targetPostage = targetPostages[i]!
    if (targetPostage <= 0 || targetPostage == null) {
      targetPostage = inscriptionDetails.value // NOTE: do not change the inscription_value
    }

    if (i !== inscriptionIds.length - 1) {
      if (targetPostage !== inscriptionDetails.value) {
        throw new Error('All inscriptions except the last one must have the same output value')
      }
    }

    if (targetPostage < getDustValue(targetWallet)) {
      throw new Error('Target postage is below dust value')
    }

    const inscrUtxo: UtxoInfoWithWallet = {
      utxo: `${inscriptionDetails.satpoint.split(':')[0]}:${inscriptionDetails.satpoint.split(':')[1]}`,
      value: inscriptionDetails.value,
      script_type: inscriptionDetails.script_type,
      wallet: inscriptionWallet,
    }
    inputUtxos.push(inscrUtxo)
    targetWallets.push(targetWallet)
    amounts.push(targetPostage)
    inscrWalletSignIdxes.push(i)
  }
  targetWallets.push(targetWallet)
  amounts.push(bufferValue)
  if (payment != null) {
    targetWallets.push(paymentWallet as WalletInfo)
    amounts.push(payment)
  }

  if (!payerWallet.addr) throw new Error('payer_wallet.addr is null')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  const unsignedTxResp = buildTransactionMultiOutput(
    cardinalUtxos,
    inputUtxos,
    payerWallet,
    targetWallets,
    amounts,
    payerWallet,
    feeRate
  )
  return unsignedTxResp.tx_fee
}

/**
 * Sends multiple inscriptions in one transaction with a buffer output and returns the fee paid for the transaction. This is used for batch minting or batch sending when the user wants to know the fee before actually sending the transaction.
 *
 * @param inscriptionIds - array of inscription IDs to send
 * @param targetPostages - array of target postages for each inscription
 * @param targetAddr - address to send the inscriptions to
 * @param bufferValue - value of the buffer output
 * @param feeRate - fee rate in sat/vbyte
 * @param paymentAddr - address to send the payment to (if payment is not null)
 * @param payment - amount to pay (if payment is not null)
 *
 * @returns the fee paid for the transaction in satoshis
 */
export async function getMultiInscriptionWithBufferFeeRate(
  inscriptionIds: string[],
  targetPostages: number[],
  targetAddr: string,
  bufferValue: number,
  feeRate: number,
  paymentAddr: string | null,
  payment: number | null
): Promise<number> {
  if (payment === 0) {
    paymentAddr = null
    payment = null
  }

  if (!Array.isArray(inscriptionIds)) throw new Error('inscription_ids must be an array')
  if (!Array.isArray(targetPostages)) throw new Error('target_postages must be an array')
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')
  for (const tp of targetPostages) {
    if (tp != null && (typeof tp != 'number' || !Number.isInteger(tp)))
      throw new Error('target_postages must be an array of integers or null')
  }
  for (const inscrId of inscriptionIds) {
    if (typeof inscrId != 'string') throw new Error('inscription_ids must be an array of strings')
  }
  assertFeeRate(feeRate)
  if (typeof bufferValue != 'number' || !Number.isInteger(bufferValue))
    throw new Error('buffer_value must be an integer')
  if (typeof targetAddr != 'string') throw new Error('target_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer or null')
  if (paymentAddr != null && typeof paymentAddr != 'string')
    throw new Error('payment_addr must be a string or null')
  if (payment != null && paymentAddr == null)
    throw new Error('payment_addr must be provided if payment is provided')
  if (payment == null && paymentAddr != null)
    throw new Error('payment must be provided if payment_addr is provided')

  const targetWallet = new WalletInfo(false, null, targetAddr, null, null)

  let paymentWallet = null
  if (payment != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
    if (payment < getDustValue(paymentWallet)) throw new Error('payment must be bigger than dust')
  }

  return await sendMultiInscriptionWithBufferFeeRateAll(
    inscriptionIds,
    targetPostages,
    targetWallet,
    bufferValue,
    feeRate,
    paymentWallet,
    payment
  )
}

async function buildRevealTx(
  inscriptionWallet: WalletInfo,
  commitTxid: string,
  commitOutputValue: number,
  secret: string,
  inscriptionDetails: InscriptionDetails,
  _feeRate: number /* NOTE: UNUSED */,
  postage: number,
  paymentWallet: WalletInfo | null,
  payment: number | null,
  commitVout: number = 0
): Promise<SignResponse> {
  if (payment == null || payment < 0) payment = 0

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = buildRevealScript(pubkey, inscriptionDetails)
  const tapleaf = Tap.encodeScript(script)

  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const inputs = [
    {
      txid: commitTxid,
      vout: commitVout,
    },
  ]

  const txdataVout = [
    {
      value: postage,
      scriptPubKey: inscriptionWallet.outputScript,
    },
  ]
  if (payment > 0) {
    if (!paymentWallet) throw new Error('Payment wallet is not available.')

    txdataVout.push({
      value: payment,
      scriptPubKey: paymentWallet.outputScript,
    })
  }
  const txdata = Tx.create({
    vin: [
      {
        // Use the txid of the funding transaction used to send the sats.
        txid: inputs[0]!.txid,
        // Specify the index value of the output that you are going to spend from.
        vout: inputs[0]!.vout,
        // Also include the value and script of that ouput.
        prevout: {
          // Feel free to change this if you sent a different amount.
          value: commitOutputValue,
          // This is what our address looks like in script form.
          scriptPubKey: ['OP_1', tpubkey],
        },
      },
    ],
    vout: txdataVout,
  })

  const sig = Signer.taproot.sign(seckey, txdata, 0, { extension: tapleaf })
  txdata.vin[0]!.witness = [sig, script, cblock]

  const isValid = Signer.taproot.verify(txdata, 0, { pubkey, throws: true })
  if (!isValid) throw new Error('Invalid signature')

  return {
    txId: Tx.util.getTxid(txdata),
    signedTxHex: Tx.encode(txdata).hex,
  }
}

interface BuildRevealTxWithParentResult {
  txid: string
  partially_signed_psbt_hex: string
}
async function buildRevealTxWithParent(
  payerWallet: WalletInfo,
  inscriptionWallet: WalletInfo,
  commitTxid: string,
  commitOutputValue: number,
  secret: string,
  inscriptionDetails: InscriptionDetails,
  parentInscriptionId: string,
  feeRate: number,
  paymentWallet: WalletInfo | null,
  payment: number | null,
  commitVout: number
): Promise<BuildRevealTxWithParentResult> {
  if (payment == null || payment < 0) payment = 0
  const changeWallet = payerWallet
  const parentInscriptionIdBuff = convertInscriptionIdToBuffer(parentInscriptionId)

  if (!inscriptionWallet.addr) throw new Error('Inscription wallet address is not set.')
  if (!payerWallet.addr) throw new Error('Payer wallet address is not set.')

  const parentUtxo = await getInscriptionUtxo(inscriptionWallet.addr, parentInscriptionId)
  if (!parentUtxo) throw new Error('Parent inscription utxo not found in ordinal utxos')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = buildRevealScript(pubkey, inscriptionDetails, parentInscriptionIdBuff)

  const scriptBuf = Buffer.from(Script.encode(script, false))

  const tapleaf = Tap.encodeScript(script)

  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })
  const tapLeafScript = {
    leafVersion: 192,
    script: scriptBuf,
    controlBlock: Buffer.from(cblock, 'hex'),
  }

  const networkType = getBitcoinNetwork()
  const commitTxAddress = bitcoinjs.payments.p2tr({
    pubkey: Buffer.from(tpubkey, 'hex'),
    network: networkType,
  })

  const commitWallet = new WalletInfo(false, null, commitTxAddress.address, null, tpubkey)
  // This reveal selects its fee inputs by hand, so it spends no used-inscription outputs: their
  // sats could reach the payment output.
  const utxos = cardinalUtxos.filter(u => !isInscribed(u))
  utxos.sort((a, b) => a.value - b.value)

  const inputs: TxInput[] = [
    {
      utxo: {
        script_type: 'witness_v1_taproot',
        utxo: `${commitTxid}:${commitVout}`,
        tapLeafScript: [
          {
            leafVersion: 192,
            script: scriptBuf,
            controlBlock: Buffer.from(cblock, 'hex'),
          },
        ],
        value: commitOutputValue,
      },
      wallet: commitWallet,
    },
    {
      utxo: {
        script_type: 'witness_v1_taproot',
        utxo: `${parentUtxo.txid}:${parentUtxo.vout}`,
        value: parentUtxo.value,
      },
      wallet: inscriptionWallet,
    },
  ]
  const outputs: TxOutput[] = [
    {
      out_script: inscriptionWallet.outputScript,
      value: commitOutputValue,
    },
    {
      out_script: inscriptionWallet.outputScript,
      value: parentUtxo.value,
    },
  ]
  if (payment > 0) {
    if (!paymentWallet) throw new Error('Payment wallet is not available.')

    outputs.push({
      out_script: paymentWallet.outputScript,
      value: payment,
    })
  }

  let fee = estimateFee(inputs, outputs, feeRate)
  let currentMinerFee = -payment
  while (currentMinerFee < fee) {
    let deficit = fee - currentMinerFee
    while (deficit > 0) {
      if (utxos.length === 0) throw new Error('Not enough funds')

      if (
        utxos[utxos.length - 1]!.value >=
        deficit + calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
      ) {
        for (const utxo of utxos.filter(utxo => utxo.value > 10000)) {
          if (utxo.value >= deficit + calculateAdditionalFee(utxo.script_type, feeRate)) {
            inputs.push({ utxo, wallet: payerWallet })
            currentMinerFee += utxo.value
            deficit = 0
            utxos.splice(utxos.indexOf(utxo), 1)
            break
          }
        }
        if (deficit > 0) {
          for (const utxo of utxos) {
            if (utxo.value >= deficit + calculateAdditionalFee(utxo.script_type, feeRate)) {
              inputs.push({ utxo, wallet: payerWallet })
              currentMinerFee += utxo.value
              deficit = 0
              utxos.splice(utxos.indexOf(utxo), 1)
              break
            }
          }
        }
      } else {
        const benefit =
          utxos[utxos.length - 1]!.value -
          calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
        deficit -= benefit
        const utxo = utxos.pop()!
        inputs.push({ utxo, wallet: payerWallet })
        currentMinerFee += utxo.value
      }
    }
    fee = estimateFee(inputs, outputs, feeRate)
  }

  if (!changeWallet.outputScript) throw new Error('Change wallet output script is not set.')

  const changeOutputFee = Math.ceil((changeWallet.outputScript.length + 9) * feeRate)
  const minimumChange = getDustValue(changeWallet)
  const excess = currentMinerFee - fee

  if (excess > minimumChange + changeOutputFee) {
    const changeValue = excess - changeOutputFee
    outputs.push({
      out_script: changeWallet.outputScript,
      value: changeValue,
    })
    currentMinerFee -= changeValue
  }

  fee = estimateFee(inputs, outputs, feeRate)
  if (currentMinerFee < fee) {
    throw new Error('Not enough funds to cover the fee')
  }

  if (!inscriptionWallet.outputScript)
    throw new Error('Inscription wallet output script is not set.')

  const txdataVin = [
    {
      txid: commitTxid,
      vout: 0,
      prevout: {
        value: commitOutputValue,
        scriptPubKey: ['OP_1', tpubkey],
      },
    },
    {
      txid: parentUtxo.txid,
      vout: parentUtxo.vout,
      prevout: {
        value: parentUtxo.value,
        scriptPubKey: inscriptionWallet.outputScript,
      },
    },
  ]

  const txdataVout = [
    {
      value: commitOutputValue,
      scriptPubKey: inscriptionWallet.outputScript,
    },
    {
      value: parentUtxo.value,
      scriptPubKey: inscriptionWallet.outputScript,
    },
  ]
  if (payment > 0) {
    if (!paymentWallet) throw new Error('Payment wallet is not available.')
    if (!paymentWallet.outputScript) throw new Error('Payment wallet output script is not set.')

    txdataVout.push({
      value: payment,
      scriptPubKey: paymentWallet.outputScript,
    })
  }

  for (let i = txdataVin.length; i < inputs.length; i++) {
    const input = inputs[i]!
    const utxo = input.utxo
    const txid = utxo.utxo.split(':')[0]!
    const vout = Number.parseInt(utxo.utxo.split(':')[1]!)
    const wallet = input.wallet

    if (!wallet.outputScript) throw new Error('Input wallet output script is not set.')

    txdataVin.push({
      txid,
      vout,
      prevout: {
        value: utxo.value,
        scriptPubKey: wallet.outputScript,
      },
    })
  }
  for (let i = txdataVout.length; i < outputs.length; i++) {
    const output = outputs[i]!
    const scriptPubKey = output.out_script
    const value = output.value

    if (!scriptPubKey) throw new Error('Output script is not set.')

    txdataVout.push({
      value,
      scriptPubKey,
    })
  }

  const txdata = Tx.create({
    vin: txdataVin,
    vout: txdataVout,
  })

  const sig = Signer.taproot.sign(seckey, txdata, 0, { extension: tapleaf })
  txdata.vin[0]!.witness = [sig, script, cblock]

  const isValid = Signer.taproot.verify(txdata, 0, { pubkey, throws: true })
  if (!isValid) throw new Error('Invalid signature')

  const tx: TransactionInOuts = {
    ins: [],
    outs: [],
  }
  for (const inp of txdata.vin) {
    const hash = Buffer.from(inp.txid, 'hex')
    const index = inp.vout
    tx.ins.push({ hash, index })
  }
  for (const out of txdata.vout) {
    const script = out.scriptPubKey as Buffer
    const value = out.value as number
    tx.outs.push({ script, value })
  }
  const finalScriptWitness = witnessStackToScriptWitness([
    Buffer.from(sig),
    Buffer.from(scriptBuf),
    Buffer.from(cblock, 'hex'),
  ])

  const forceInUtxos: UtxoInfoWithWallet[] = [
    {
      utxo: `${commitTxid}:0`,
      script_type: 'witness_v1_taproot',
      witnessUtxoScript: commitWallet.outputScript,
      sequence: undefined,
      tapLeafScript: [tapLeafScript],
      finalScriptWitness,
      wallet: commitWallet,
      value: commitOutputValue,
    },
    {
      utxo: `${parentUtxo.txid}:${parentUtxo.vout}`,
      script_type: 'witness_v1_taproot',
      witnessUtxoScript: inscriptionWallet.outputScript,
      sequence: undefined,
      tapLeafScript: undefined,
      finalScriptWitness: undefined,
      wallet: inscriptionWallet,
      value: parentUtxo.value,
    },
  ]

  const partiallySignedPsbt = await buildPsbtFromTx(tx, cardinalUtxos, payerWallet, forceInUtxos)
  return {
    txid: Tx.util.getTxid(txdata),
    partially_signed_psbt_hex: partiallySignedPsbt.toHex(),
  }
}

/**
 * Mints an inscription by building and signing the commit and reveal transactions. The commit transaction is built using the buildCommitTx function, and the reveal transaction is built using the buildRevealTx function. The function also validates the transactions before broadcasting them to the network. If dryRun is true, the transactions will not be broadcasted and the signed transaction hex will be returned for inspection.
 *
 * @param inscriptionDetails - details of the inscription to mint, including content type, content length, and the actual content in hex format
 * @param feeRate - fee rate in sat/vbyte to use for the transactions
 * @param postage - postage amount in satoshis to use for the transactions
 * @param paymentAddr - address to send the payment to (if payment is not null)
 * @param payment - amount to pay (if payment is not null)
 * @param dryRun - if true, the transactions will not be broadcasted and the signed transaction hex will be returned for inspection
 * @param signFunc - function to sign the transactions
 *
 * @returns an object containing the commit transaction ID, signed commit transaction hex, reveal transaction ID, signed reveal transaction hex, inscription ID, postage used, and the secret token used for minting
 */
export async function mintAll(
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
  signFunc: SignFunction
) {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )
  let paymentWallet = null
  if (paymentAddr != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTx(
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    []
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    []
  )

  const commitTxid = signedCommitTx.txId
  const revealTx = await buildRevealTx(
    inscriptionWallet,
    commitTxid,
    commitTx.output_value,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    commitTx.commit_vout
  )

  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])
  if (isValid == null)
    throw new Error('Mint commit/reveal validation failed (testmempoolaccept request failed)')

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    return {
      commit_txid: signedCommitTx.txId,
      signed_commit_tx_hex: signedCommitTx.signedTxHex,
      reveal_txid: revealTx.txId,
      signed_reveal_tx_hex: revealTx.signedTxHex,
      inscription_id: `${revealTx.txId}i0`,
      postage,
      secret,
    }
  }

  if ((await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')
  return {
    commit_txid: signedCommitTx.txId,
    signed_commit_tx_hex: signedCommitTx.signedTxHex,
    reveal_txid: revealTx.txId,
    signed_reveal_tx_hex: revealTx.signedTxHex,
    inscription_id: `${revealTx.txId}i0`,
    postage,
    secret,
  }
}

/**
 * Mints an inscription using the connected payment wallet for both the commit and reveal transactions. This function is a wrapper around the mintAll function that simplifies the minting process when the user wants to use the same wallet for both transactions. It retrieves the connected wallets, builds and signs the transactions, validates them, and broadcasts them to the network. If dryRun is true, it returns the signed transaction hex without broadcasting.
 *
 * @param inscriptionDetails - details of the inscription to mint, including content type, content length, and the actual content in hex format
 * @param feeRate - fee rate in sat/vbyte to use for the transactions
 * @param postage - postage amount in satoshis to use for the transactions
 * @param paymentAddr - address to send the payment to (if payment is not null)
 * @param payment - amount to pay (if payment is not null)
 * @param dryRun - if true, the transactions will not be broadcasted and the signed transaction hex will be returned for inspection
 * @param signFunc - function to sign the transactions
 *
 * @returns an object containing the commit transaction ID, signed commit transaction hex, reveal transaction ID, signed reveal transaction hex, inscription ID, postage used, and the secret token used for minting
 */
export async function mintAllPaymentWallet(
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<InscribeResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  let paymentWallet = null
  if (paymentAddr != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(payerWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTx(
    payerWallet,
    payerWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    []
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    []
  )

  const commitTxid = signedCommitTx.txId
  const revealTx = await buildRevealTx(
    payerWallet,
    commitTxid,
    commitTx.output_value,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    commitTx.commit_vout
  )

  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])
  if (isValid == null)
    throw new Error(
      'Payment-wallet mint commit/reveal validation failed (testmempoolaccept request failed)'
    )

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    return {
      commitTxId: signedCommitTx.txId,
      signedCommitTxHex: signedCommitTx.signedTxHex,
      revealTxId: revealTx.txId,
      signedRevealTxHex: revealTx.signedTxHex,
      inscriptionId: `${revealTx.txId}i0`,
      postage,
      secret,
    }
  }

  if ((await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')
  return {
    commitTxId: signedCommitTx.txId,
    signedCommitTxHex: signedCommitTx.signedTxHex,
    revealTxId: revealTx.txId,
    signedRevealTxHex: revealTx.signedTxHex,
    inscriptionId: `${revealTx.txId}i0`,
    postage,
    secret,
  }
}

interface InscribeCheckFeesResult {
  commit_fee: number
  reveal_fee: number
  total_fee: number
  unsigned_commit_tx_hex: string
  signed_reveal_tx_hex: string
  inscription_id: string
  postage: number
}
/**
 * Checks the fees for minting an inscription by building the commit and reveal transactions without signing or broadcasting them. This function is useful for users who want to estimate the fees before actually minting the inscription. It returns the estimated commit fee, reveal fee, total fee, unsigned commit transaction hex, signed reveal transaction hex, inscription ID, and postage used.
 *
 * @param inscriptionDetails - details of the inscription to mint, including content type, content length, and the actual content in hex format
 * @param feeRate - fee rate in sat/vbyte to use for the transactions
 * @param postage - postage amount in satoshis to use for the transactions
 * @param paymentAddr - address to send the payment to (if payment is not null)
 * @param payment - amount to pay (if payment is not null)
 * @param fetchedCardinalUtxos - the payer's `fetchCardinalUtxos` response to fund the commit from in place of a new fetch
 *
 * @returns an object containing the estimated commit fee, reveal fee, total fee, unsigned commit transaction hex, signed reveal transaction hex, inscription ID, and postage used
 */
export async function mintAllCheckFees(
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  fetchedCardinalUtxos?: Utxo[]
): Promise<InscribeCheckFeesResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )
  let paymentWallet = null
  if (paymentAddr != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTx(
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    [],
    fetchedCardinalUtxos
  )
  const dummyCommitTxid = commitTx.unsigned_commit_tx.getId()
  const revealTx = await buildRevealTx(
    inscriptionWallet,
    dummyCommitTxid,
    commitTx.output_value,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    commitTx.commit_vout
  )

  return {
    commit_fee: commitTx.commit_fee,
    reveal_fee: commitTx.reveal_fee,
    total_fee: commitTx.commit_fee + commitTx.reveal_fee,
    unsigned_commit_tx_hex: commitTx.unsigned_commit_tx.toHex(),
    signed_reveal_tx_hex: revealTx.signedTxHex,
    inscription_id: `${revealTx.txId}i0`,
    postage,
  }
}

/**
 * Sends an inscription to a target address using an OP_RETURN output. This function builds a transaction that spends the inscription UTXO and creates an OP_RETURN output with the inscription data, along with a target output with the specified postage. It then signs and broadcasts the transaction. If dryRun is true, it returns the signed transaction hex without broadcasting.
 *
 * @param inscriptionId - ID of the inscription to send, in the format of "txid:output_index"
 * @param targetWallet - wallet information of the target address to send the inscription to
 * @param targetPostage - postage amount in satoshis to include in the target output
 * @param feeRate - fee rate in sat/vbyte to use for the transaction
 * @param dryRun - if true, the transaction will not be broadcasted
 * @param signFunc - function to sign the transaction
 *
 * @returns an object containing the transaction ID and signed transaction hex of the sent transaction
 */
export async function sendInscriptionToOpReturnAll(
  inscriptionId: string,
  targetWallet: WalletInfo,
  targetPostage: number | null,
  feeRate: number,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<SendInscriptionResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  if (targetPostage == null || targetPostage <= 0) {
    targetPostage = 1 // 1 sat for inscription
  }

  const paymentAddr = userPaymentWallet.address
  const paymentPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, paymentAddr, null, paymentPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )

  if (!inscriptionWallet.addr) throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payerWallet.addr) throw new Error('Payer wallet address is not set.')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  if (targetPostage <= 0 || targetPostage == null) {
    targetPostage = 1 // 1 sat for inscription
  }

  const inscrUtxo: UtxoInfoWithWallet = {
    utxo: `${inscriptionDetails.satpoint.split(':')[0]}:${inscriptionDetails.satpoint.split(':')[1]}`,
    value: inscriptionDetails.value,
    script_type: inscriptionDetails.script_type,
    wallet: inscriptionWallet,
  }

  const unsignedTxResp = buildTransaction(
    cardinalUtxos,
    [inscrUtxo],
    payerWallet,
    [],
    targetWallet,
    payerWallet,
    feeRate,
    targetPostage,
    null,
    null
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, [inscrUtxo])
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [0])

  const isValid = await validateTxes([signedTx.signedTxHex])
  if (isValid == null)
    throw new Error(
      'OP_RETURN inscription send validation failed (testmempoolaccept request failed)'
    )

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    return {
      txId: signedTx.txId,
      signedTxHex: signedTx.signedTxHex,
      vout: 0,
      outputValue: targetPostage,
    }
  }

  if ((await broadcastTxes([signedTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')

  return {
    txId: signedTx.txId,
    signedTxHex: signedTx.signedTxHex,
    vout: 0,
    outputValue: targetPostage,
  }
}

/**
 * Sends an inscription to a target address using an OP_RETURN output, with the payment wallet as the source of funds for the transaction. This function is similar to sendInscriptionToOpReturnAll, but it specifically uses the payment wallet for funding the transaction, which can be useful in cases where the inscription wallet does not have enough funds to cover the transaction fees. It builds a transaction that spends the inscription UTXO and creates an OP_RETURN output with the inscription data, along with a target output with the specified postage. It then signs and broadcasts the transaction. If dryRun is true, it returns the signed transaction hex without broadcasting.
 *
 * @param inscriptionId - ID of the inscription to send, in the format of "txid:output_index"
 * @param targetWallet - wallet information of the target address to send the inscription to
 * @param targetPostage - postage amount in satoshis to include in the target output
 * @param feeRate - fee rate in sat/vbyte to use for the transaction
 * @param dryRun - if true, the transaction will not be broadcasted
 * @param signFunc - function to sign the transaction
 *
 * @returns an object containing the transaction ID and signed transaction hex of the sent transaction
 */
export async function sendInscriptionInPaymentWalletToOpReturnAll(
  inscriptionId: string,
  targetWallet: WalletInfo,
  targetPostage: number | null,
  feeRate: number,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<SendInscriptionResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  if (targetPostage == null || targetPostage <= 0) {
    targetPostage = 1 // 1 sat for inscription
  }

  const paymentAddr = userPaymentWallet.address
  const paymentPublicKey = userPaymentWallet.pubkey
  const inscriptionAddr = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, paymentAddr, null, paymentPublicKey)
  const inscriptionWallet = new WalletInfo(false, null, inscriptionAddr, null, inscriptionPublicKey)

  if (!payerWallet.addr) throw new Error('Payment wallet address is not set.')
  if (!inscriptionWallet.addr) throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, payerWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payerWallet.addr) throw new Error('Payer wallet address is not set.')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  if (targetPostage <= 0 || targetPostage == null) {
    targetPostage = 1 // 1 sat for inscription
  }

  const inscrUtxo: UtxoInfoWithWallet = {
    utxo: `${inscriptionDetails.satpoint.split(':')[0]}:${inscriptionDetails.satpoint.split(':')[1]}`,
    value: inscriptionDetails.value,
    script_type: inscriptionDetails.script_type,
    wallet: payerWallet,
  }

  const unsignedTxResp = buildTransaction(
    cardinalUtxos,
    [inscrUtxo],
    payerWallet,
    [],
    targetWallet,
    payerWallet,
    feeRate,
    targetPostage,
    null,
    null
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, [inscrUtxo])
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [])

  const isValid = await validateTxes([signedTx.signedTxHex])
  if (isValid == null)
    throw new Error(
      'Payment-wallet OP_RETURN inscription send validation failed (testmempoolaccept request failed)'
    )

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    return {
      txId: signedTx.txId,
      signedTxHex: signedTx.signedTxHex,
      vout: 0,
      outputValue: targetPostage,
    }
  }

  if ((await broadcastTxes([signedTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')
  return {
    txId: signedTx.txId,
    signedTxHex: signedTx.signedTxHex,
    vout: 0,
    outputValue: targetPostage,
  }
}

/**
 * Mints an inscription with a parent inscription by building and signing the commit and reveal transactions that reference the parent inscription. This function is used when the user wants to create a new inscription that is linked to an existing parent inscription, allowing for hierarchical relationships between inscriptions. It retrieves the connected wallets, builds and signs the transactions, validates them, and broadcasts them to the network. If dryRun is true, it returns the signed transaction hex without broadcasting.
 *
 * @param inscriptionDetails - details of the inscription to mint, including content type, content length, and the actual content in hex format
 * @param parentInscriptionId - ID of the parent inscription to link to, in the format of "txid:output_index"
 * @param feeRate - fee rate in sat/vbyte to use for the transactions
 * @param postage - postage amount in satoshis to use for the transactions
 * @param paymentAddr - address to send the payment to (if payment is not null)
 * @param payment - amount to pay (if payment is not null)
 * @param dryRun - if true, the transactions will not be broadcasted and the signed transaction hex will be returned for inspection
 * @param signFunc - function to sign the transactions
 *
 * @returns an object containing the commit transaction ID, signed commit transaction hex, reveal transaction ID, signed reveal transaction hex, inscription ID, postage used, and the secret token used for minting
 */
export async function mintWithParentAll(
  inscriptionDetails: InscriptionDetails,
  parentInscriptionId: string,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<InscribeResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )
  let paymentWallet = null
  if (paymentAddr != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTxWithParent(
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    parentInscriptionId
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    []
  )

  const commitTxid = signedCommitTx.txId
  let signedRevealTx = null
  try {
    saveExtraUtxos(
      [signedCommitTx.signedTxHex],
      ['0000000000000000000000000000000000000000000000000000000000000000i0', `${commitTxid}:0:0`]
    )
    const revealTx = await buildRevealTxWithParent(
      payerWallet,
      inscriptionWallet,
      commitTxid,
      commitTx.output_value,
      secret,
      inscriptionDetails,
      parentInscriptionId,
      feeRate,
      paymentWallet,
      payment,
      commitTx.commit_vout
    )

    signedRevealTx = await signFunc(
      revealTx.partially_signed_psbt_hex,
      payerAddr,
      inscriptionAddress,
      [1],
      undefined,
      [0]
    )
  } finally {
    clearExtraUtxos()
  }

  const isValid = await validateTxes([signedCommitTx.signedTxHex, signedRevealTx.signedTxHex])
  if (isValid == null)
    throw new Error(
      'Mint-with-parent commit/reveal validation failed (testmempoolaccept request failed)'
    )

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    return {
      commitTxId: signedCommitTx.txId,
      signedCommitTxHex: signedCommitTx.signedTxHex,
      revealTxId: signedRevealTx.txId,
      signedRevealTxHex: signedRevealTx.signedTxHex,
      inscriptionId: `${signedRevealTx.txId}i0`,
      postage,
      secret,
    }
  }
  if ((await broadcastTxes([signedCommitTx.signedTxHex, signedRevealTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')
  return {
    commitTxId: signedCommitTx.txId,
    signedCommitTxHex: signedCommitTx.signedTxHex,
    revealTxId: signedRevealTx.txId,
    signedRevealTxHex: signedRevealTx.signedTxHex,
    inscriptionId: `${signedRevealTx.txId}i0`,
    postage,
    secret,
  }
}

interface OutputUtxoInfo {
  wallet: WalletInfo
  value: number
}
/**
 * Sends an inscription to a target address using an OP_RETURN output, with extra input UTXOs and extra output UTXOs included in the transaction. This function allows for more complex transactions where the user wants to include additional inputs and outputs beyond just the inscription UTXO and the target output. It builds a transaction that spends the inscription UTXO along with the extra input UTXOs, creates an OP_RETURN output with the inscription data, includes a target output with the specified postage, and adds any extra output UTXOs. It then signs and broadcasts the transaction. If dryRun is true, it returns the signed transaction hex without broadcasting.
 *
 * @param inscriptionId - ID of the inscription to send, in the format of "txid:output_index"
 * @param extraInputUtxos - array of extra input UTXOs to include in the transaction, each with its associated wallet information
 * @param targetWallet - wallet information of the target address to send the inscription to
 * @param targetPostage - postage amount in satoshis to include in the target output
 * @param extraOutputUtxos - array of extra output UTXOs to include in the transaction, each with its associated wallet information and value
 * @param feeRate - fee rate in sat/vbyte to use for the transaction
 * @param dryRun - if true, the transaction will not be broadcasted
 * @param signFunc - function to sign the transaction
 *
 * @returns an object containing the transaction ID and signed transaction hex of the sent transaction
 */
export async function sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll(
  inscriptionId: string,
  extraInputUtxos: UtxoInfoWithWallet[],
  targetWallet: WalletInfo,
  targetPostage: number,
  extraOutputUtxos: OutputUtxoInfo[],
  feeRate: number,
  dryRun: boolean,
  signFunc: SignFunction
): Promise<SignResponse> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )

  if (!inscriptionWallet.addr) throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    throw new Error('Inscription is not at the first sat of utxo')
  }

  if (!payerWallet.addr) throw new Error('Payer wallet address is not set.')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  if (targetPostage <= 0 || targetPostage == null) {
    targetPostage = 1 // 1 sat for inscription
  }

  const inscrUtxo: UtxoInfoWithWallet = {
    utxo: `${inscriptionDetails.satpoint.split(':')[0]}:${inscriptionDetails.satpoint.split(':')[1]}`,
    value: inscriptionDetails.value,
    script_type: inscriptionDetails.script_type,
    wallet: inscriptionWallet,
  }
  const extraUtxoObjs: UtxoInfoWithWallet[] = [inscrUtxo]
  for (const extraInput of extraInputUtxos) {
    extraUtxoObjs.push(extraInput)
  }

  const outputWallets: WalletInfo[] = [targetWallet]
  const amounts: number[] = [targetPostage]
  for (const extraOutput of extraOutputUtxos) {
    outputWallets.push(extraOutput.wallet)
    amounts.push(extraOutput.value)
  }

  const unsignedTxResp = buildTransactionMultiOutput(
    cardinalUtxos,
    extraUtxoObjs,
    payerWallet,
    outputWallets,
    amounts,
    payerWallet,
    feeRate
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, extraUtxoObjs)
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [0])

  const isValid = await validateTxes([signedTx.signedTxHex])
  if (isValid == null)
    throw new Error(
      'OP_RETURN inscription send with extra inputs/output validation failed (testmempoolaccept request failed)'
    )

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    return {
      txId: signedTx.txId,
      signedTxHex: signedTx.signedTxHex,
    }
  }

  if ((await broadcastTxes([signedTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')
  return {
    txId: signedTx.txId,
    signedTxHex: signedTx.signedTxHex,
  }
}

interface SendInscriptionFeeRateResult {
  txid: string
  unsigned_tx_hex: string
  tx_fee: number
}
/**
 * Calculates the fee for sending an inscription to a target address using an OP_RETURN output, with extra input UTXOs and extra output UTXOs included in the transaction, based on a specified fee rate. This function builds the transaction without signing or broadcasting it, allowing the user to estimate the fees before actually sending the inscription. It returns the transaction ID, unsigned transaction hex, and the calculated transaction fee.
 *
 * @param inscriptionId - ID of the inscription to send, in the format of "txid:output_index"
 * @param extraInputUtxos - array of extra input UTXOs to include in the transaction, each with its associated wallet information
 * @param targetWallet - wallet information of the target address to send the inscription to
 * @param targetPostage - postage amount in satoshis to include in the target output
 * @param extraOutputUtxos - array of extra output UTXOs to include in the transaction, each with its associated wallet information and value
 * @param feeRate - fee rate in sat/vbyte to use for the transaction
 * @param fetchedCardinalUtxos - the payer's `fetchCardinalUtxos` response to fund from in place of a new fetch
 *
 * @returns an object containing the transaction ID, unsigned transaction hex, and calculated transaction fee
 */
export async function sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate(
  inscriptionId: string,
  extraInputUtxos: UtxoInfoWithWallet[],
  targetWallet: WalletInfo,
  targetPostage: number,
  extraOutputUtxos: OutputUtxoInfo[],
  feeRate: number,
  fetchedCardinalUtxos?: Utxo[]
): Promise<SendInscriptionFeeRateResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )

  if (!inscriptionWallet.addr) throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    throw new Error('Inscription is not at the first sat of utxo')
  }

  if (!payerWallet.addr) throw new Error('Payer wallet address is not set.')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr, fetchedCardinalUtxos)

  if (targetPostage <= 0 || targetPostage == null) {
    targetPostage = 1 // 1 sat for inscription
  }

  const inscrUtxo: UtxoInfoWithWallet = {
    utxo: `${inscriptionDetails.satpoint.split(':')[0]}:${inscriptionDetails.satpoint.split(':')[1]}`,
    value: inscriptionDetails.value,
    script_type: inscriptionDetails.script_type,
    wallet: inscriptionWallet,
  }
  const extraUtxoObjs: UtxoInfoWithWallet[] = [inscrUtxo]
  for (const extraInput of extraInputUtxos) {
    extraUtxoObjs.push(extraInput)
  }

  const outputWallets: WalletInfo[] = [targetWallet]
  const amounts: number[] = [targetPostage]
  for (const extraOutput of extraOutputUtxos) {
    outputWallets.push(extraOutput.wallet)
    amounts.push(extraOutput.value)
  }

  const unsignedTxResp = buildTransactionMultiOutput(
    cardinalUtxos,
    extraUtxoObjs,
    payerWallet,
    outputWallets,
    amounts,
    payerWallet,
    feeRate
  )
  const unsignedTx = unsignedTxResp.tx

  return {
    txid: unsignedTx.getId(),
    unsigned_tx_hex: unsignedTx.toHex(),
    tx_fee: unsignedTxResp.tx_fee,
  }
}

/**
 * Mints an inscription with extra input UTXOs included in the commit transaction. This function builds and signs the commit and reveal transactions for minting an inscription, while allowing the user to include additional input UTXOs in the commit transaction. This can be useful in cases where the user wants to fund the commit transaction with specific UTXOs or needs to include additional inputs for other reasons. The function retrieves the connected wallets, builds and signs the transactions, validates them, and broadcasts them to the network. If dryRun is true, it returns the signed transaction hex without broadcasting.
 *
 * @param inscriptionDetails - details of the inscription to mint, including content type, content length, and the actual content in hex format
 * @param extraInputUtxos - array of extra input UTXOs to include in the commit transaction, each with its associated wallet information
 * @param feeRate - fee rate in sat/vbyte to use for the transactions
 * @param postage - postage amount in satoshis to use for the transactions
 * @param paymentAddr - address to send the payment to (if payment is not null)
 * @param payment - amount to pay (if payment is not null)
 * @param dryRun - if true, the transactions will not be broadcasted and the signed transaction hex will be returned for inspection
 * @param signFunc - function to sign the transactions
 * @param minChange - change, in sats, the commit should leave for a later transaction (see `buildTransaction`)
 *
 * @returns an object containing the commit transaction ID, signed commit transaction hex, reveal transaction ID, signed reveal transaction hex, inscription ID, postage used, and the secret token used for minting
 */
export async function mintWithExtraInputInCommitAll(
  inscriptionDetails: InscriptionDetails,
  extraInputUtxos: UtxoInfoWithWallet[],
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
  signFunc: SignFunction,
  minChange = 0
): Promise<InscribeResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )
  let paymentWallet = null
  if (paymentAddr != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTx(
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    extraInputUtxos,
    undefined,
    minChange
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    []
  )

  const commitTxid = signedCommitTx.txId
  const revealTx = await buildRevealTx(
    inscriptionWallet,
    commitTxid,
    commitTx.output_value,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    commitTx.commit_vout
  )

  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])
  if (isValid == null)
    throw new Error(
      'Mint with extra commit input validation failed (testmempoolaccept request failed)'
    )

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dryRun) {
    return {
      commitTxId: signedCommitTx.txId,
      signedCommitTxHex: signedCommitTx.signedTxHex,
      revealTxId: revealTx.txId,
      signedRevealTxHex: revealTx.signedTxHex,
      inscriptionId: `${revealTx.txId}i0`,
      postage,
      secret,
    }
  }

  if ((await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])) == null)
    throw new Error('Broadcast request failed')
  return {
    commitTxId: signedCommitTx.txId,
    signedCommitTxHex: signedCommitTx.signedTxHex,
    revealTxId: revealTx.txId,
    signedRevealTxHex: revealTx.signedTxHex,
    inscriptionId: `${revealTx.txId}i0`,
    postage,
    secret,
  }
}

/**
 * Checks the fees for minting an inscription with extra input UTXOs included in the commit transaction by building the commit and reveal transactions without signing or broadcasting them. This function is useful for users who want to estimate the fees before actually minting the inscription with extra inputs. It returns the estimated commit fee, reveal fee, total fee, unsigned commit transaction hex, signed reveal transaction hex, inscription ID, and postage used.
 *
 * @param inscriptionDetails - details of the inscription to mint, including content type, content length, and the actual content in hex format
 * @param extraInputUtxos - array of extra input UTXOs to include in the commit transaction, each with its associated wallet information
 * @param feeRate - fee rate in sat/vbyte to use for the transactions
 * @param postage - postage amount in satoshis to use for the transactions
 * @param paymentAddr - address to send the payment to (if payment is not null)
 * @param payment - amount to pay (if payment is not null)
 * @param fetchedCardinalUtxos - the payer's `fetchCardinalUtxos` response to fund the commit from in place of a new fetch
 * @param minChange - change, in sats, the commit should leave for a later transaction (see `buildTransaction`)
 *
 * @returns an object containing the estimated commit fee, reveal fee, total fee, unsigned commit transaction hex, signed reveal transaction hex, inscription ID, and postage used
 */
export async function mintWithExtraInputInCommitFeeRate(
  inscriptionDetails: InscriptionDetails,
  extraInputUtxos: UtxoInfoWithWallet[],
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  fetchedCardinalUtxos?: Utxo[],
  minChange = 0
): Promise<InscribeCheckFeesResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet) throw new Error('Wallets not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey
  const inscriptionAddress = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)
  const inscriptionWallet = new WalletInfo(
    false,
    null,
    inscriptionAddress,
    null,
    inscriptionPublicKey
  )
  let paymentWallet = null
  if (paymentAddr != null) {
    paymentWallet = new WalletInfo(false, null, paymentAddr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = getDustValue(inscriptionWallet)
  }

  const secret = createSecretToken()
  const commitTx = await buildCommitTx(
    payerWallet,
    inscriptionWallet,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    extraInputUtxos,
    fetchedCardinalUtxos,
    minChange
  )
  const dummyCommitTxId = commitTx.unsigned_commit_tx.getId()
  const revealTx = await buildRevealTx(
    inscriptionWallet,
    dummyCommitTxId,
    commitTx.output_value,
    secret,
    inscriptionDetails,
    feeRate,
    postage,
    paymentWallet,
    payment,
    commitTx.commit_vout
  )

  return {
    commit_fee: commitTx.commit_fee,
    reveal_fee: commitTx.reveal_fee,
    total_fee: commitTx.commit_fee + commitTx.reveal_fee,
    unsigned_commit_tx_hex: commitTx.unsigned_commit_tx.toHex(),
    signed_reveal_tx_hex: revealTx.signedTxHex,
    inscription_id: `${revealTx.txId}i0`,
    postage,
  }
}
