import type { InscriptionDetails } from '../types/inscription'
import type { SignProgressOptions } from './sign-progress'
import { Buffer } from 'node:buffer'
import { Address } from '@cmdcode/tapscript'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { textInscription } from '../types/inscription'
import { hasExtraTxes, validateTxes } from './helpers'
import { assertFeeRate, ENABLE_RBF_NO_LOCKTIME, mintAll, mintAllCheckFees, TO_X_ONLY } from './mint'
import { getOrdinalsWallet, getSignFn } from './providers'
import { SignProgress } from './sign-progress'
import { getWalletInfo } from './store'

/** Script types a withdraw's send can pay; the inscription input is `p2tr` or `p2wpkh`. */
type SendScriptType = 'p2tr' | 'p2wpkh' | 'p2sh' | 'p2pkh'

/** Smallest output value each script type relays at, as `getDustValue` uses. */
const DUST: Record<SendScriptType, number> = { p2tr: 330, p2wpkh: 294, p2sh: 540, p2pkh: 546 }
/** Serialized output size in bytes: value, script length and script. */
const OUTPUT_BYTES: Record<SendScriptType, number> = { p2tr: 43, p2wpkh: 31, p2sh: 32, p2pkh: 34 }
/**
 * Weight of a key-path input: 41 base bytes (outpoint, empty scriptSig, sequence) at 4 WU each,
 * plus its witness (one 64-byte Schnorr signature for p2tr; a 72-byte DER signature and a 33-byte
 * key for p2wpkh).
 */
const INPUT_WEIGHT: Partial<Record<SendScriptType, number>> = {
  p2tr: 41 * 4 + 66,
  p2wpkh: 41 * 4 + 108,
}
/** Version, locktime and the in/out counts at 4 WU each, plus the segwit marker and flag. */
const TX_OVERHEAD_WEIGHT = 10 * 4 + 2
/** A decimal amount as inscribed: digits with an optional fractional part. */
const AMOUNT_RE = /^\d+(?:\.\d+)?$/

function asScriptType(type: string): SendScriptType {
  if (type === 'p2w-pkh') return 'p2wpkh'
  if (type === 'p2tr' || type === 'p2wpkh' || type === 'p2sh' || type === 'p2pkh') return type
  throw new Error(`Cannot price a withdraw send for a ${type} address`)
}

/**
 * The vsize of a withdraw's send: one key-path input of `inputType` (the inscription) and one
 * `outputType` output.
 *
 * @throws When `inputType` is not `p2tr` or `p2wpkh`, or `outputType` is not a payable script type.
 */
export function sendVsize(inputType: string, outputType: string): number {
  const input = INPUT_WEIGHT[asScriptType(inputType)]
  if (input == null) throw new Error(`Cannot sign a withdraw send from a ${inputType} address`)
  const output = OUTPUT_BYTES[asScriptType(outputType)] * 4
  return Math.ceil((TX_OVERHEAD_WEIGHT + input + output) / 4)
}

/**
 * The reveal output value that lets a withdraw's send pay its own fee: the target's dust plus the
 * send's fee at `feeRate`. The send spends only that output, so nothing else in the wallet funds it.
 *
 * @param scriptType The inscription address's script type (`p2tr` or `p2wpkh`).
 * @param feeRate The send's fee rate in sat/vB.
 * @param targetScriptType The target address's script type; defaults to `scriptType`.
 */
export function selfFundedSendPostage(
  scriptType: string,
  feeRate: number,
  targetScriptType: string = scriptType
): number {
  return (
    DUST[asScriptType(targetScriptType)] +
    Math.ceil(sendVsize(scriptType, targetScriptType) * feeRate)
  )
}

export interface Brc20ProgWithdrawArgs {
  /** The BRC-20 ticker, as it appears in the inscription. */
  tick: string
  /** The decimal amount, as it appears in the inscription. */
  amount: string
  /** The address the withdrawn BRC-20 lands on. */
  targetAddress: string
  /** Fee rate in sat/vB for the commit, reveal and send. */
  feeRate: number
}

export interface PrepareBrc20ProgWithdrawArgs extends Brc20ProgWithdrawArgs, SignProgressOptions {}

/** A signed, unbroadcast BRC2.0 withdraw chain: commit, reveal, and the send to the target. */
export interface PreparedBrc20Withdraw {
  inscriptionId: string
  commitTxId: string
  commitTxHex: string
  revealTxId: string
  revealTxHex: string
  /** Spends only `<revealTxId>:0` and pays the target's dust, so it stays valid while held. */
  sendTxId: string
  sendTxHex: string
  /** Miner fees of the three transactions, in sats. */
  feeSats: number
}

interface WithdrawPlan {
  inscription: InscriptionDetails
  ordinalsAddress: string
  ordinalsPubkey: string
  ordinalsType: SendScriptType
  targetScript: Buffer
  dust: number
  postage: number
}

function planWithdraw(args: Brc20ProgWithdrawArgs): WithdrawPlan {
  const { tick, amount, targetAddress, feeRate } = args
  if (typeof tick !== 'string' || tick.length === 0 || /["\\]/.test(tick))
    throw new Error('tick must be a non-empty string without " or \\')
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount))
    throw new Error('amount must be a decimal string, such as "1.5"')
  if (typeof targetAddress !== 'string') throw new Error('targetAddress must be a string')
  assertFeeRate(feeRate)
  // The relay holds only the three signed transactions, so the commit must spend confirmed or
  // broadcast outputs, never an unbroadcast chained one.
  if (hasExtraTxes())
    throw new Error('A BRC2.0 withdraw chain cannot spend outputs of unbroadcast transactions')

  const ordinals = getOrdinalsWallet()
  if (!ordinals?.pubkey) throw new Error('Wallets not found')
  const ordinalsType = asScriptType(Address.decode(ordinals.address).type)
  const targetType = asScriptType(Address.decode(targetAddress).type)
  return {
    inscription: textInscription(
      `{"p":"brc20-module","op":"withdraw","tick":"${tick}","amt":"${amount}","module":"BRC20PROG"}`
    ),
    ordinalsAddress: ordinals.address,
    ordinalsPubkey: ordinals.pubkey,
    ordinalsType,
    targetScript: bitcoinjs.address.toOutputScript(targetAddress, getBitcoinNetwork()),
    dust: DUST[targetType],
    postage: selfFundedSendPostage(ordinalsType, feeRate, targetType),
  }
}

/**
 * Signs a BRC2.0 withdraw inscription chain without broadcasting it. The commit and reveal inscribe
 * `{"p":"brc20-module","op":"withdraw",...}` to the ordinals address, with a reveal output large
 * enough to pay the send's fee; the send moves the inscription from `<revealTxId>:0` to
 * `targetAddress` as its only input and output. The three are tested for mempool acceptance as one
 * package.
 *
 * `onSignRequest` is called before each wallet prompt with `{ step, total }`; `total` is 2.
 */
export async function prepareBrc20ProgWithdraw(
  args: PrepareBrc20ProgWithdrawArgs
): Promise<PreparedBrc20Withdraw> {
  const plan = planWithdraw(args)
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets) throw new Error('Wallets not found')
  const signFn = new SignProgress(args, 2).wrap(getSignFn(walletInfo.provider))

  const minted = await mintAll(
    plan.inscription,
    args.feeRate,
    plan.postage,
    null,
    null,
    true,
    signFn
  )
  const reveal = bitcoinjs.Transaction.fromHex(minted.signed_reveal_tx_hex)
  const revealOut = reveal.outs[0]
  if (revealOut?.value !== plan.postage)
    throw new Error('Withdraw reveal output does not carry the send postage')

  const psbt = new bitcoinjs.Psbt({ network: getBitcoinNetwork() })
  psbt.addInput({
    hash: minted.reveal_txid,
    index: 0,
    sequence: ENABLE_RBF_NO_LOCKTIME,
    witnessUtxo: { script: revealOut.script, value: revealOut.value },
    ...(plan.ordinalsType === 'p2tr'
      ? { tapInternalKey: TO_X_ONLY(Buffer.from(plan.ordinalsPubkey, 'hex')) }
      : {}),
  })
  psbt.addOutput({ script: plan.targetScript, value: plan.dust })
  const send = await signFn(psbt.toHex(), plan.ordinalsAddress, plan.ordinalsAddress, [0])

  const txHexes = [minted.signed_commit_tx_hex, minted.signed_reveal_tx_hex, send.signedTxHex]
  const accepted = await validateTxes(txHexes)
  if (accepted == null)
    throw new Error('Withdraw validation failed (testmempoolaccept request failed)')
  for (const entry of accepted) {
    if (!entry.allowed) throw new Error(entry['reject-reason'])
  }

  return {
    inscriptionId: minted.inscription_id,
    commitTxId: minted.commit_txid,
    commitTxHex: minted.signed_commit_tx_hex,
    revealTxId: minted.reveal_txid,
    revealTxHex: minted.signed_reveal_tx_hex,
    sendTxId: send.txId,
    sendTxHex: send.signedTxHex,
    feeSats: minted.commit_fee + minted.reveal_fee + plan.postage - plan.dust,
  }
}

/**
 * The miner fees, in sats, of the chain `prepareBrc20ProgWithdraw` signs for the same arguments:
 * commit, reveal and send. Nothing is signed.
 */
export async function getBrc20ProgWithdrawFee(args: Brc20ProgWithdrawArgs): Promise<number> {
  const plan = planWithdraw(args)
  const fees = await mintAllCheckFees(plan.inscription, args.feeRate, plan.postage, null, null)
  return fees.commit_fee + fees.reveal_fee + plan.postage - plan.dust
}
