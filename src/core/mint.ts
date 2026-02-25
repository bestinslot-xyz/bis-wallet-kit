import type { APIOrdinalUtxoInfo } from '../core/helpers'
import type { SignFunction, SignResponse } from '../provider/api'
import type { PaymentOpts } from '../types/common'
import type { InscribeFees, InscribeMultipleResult, InscribeResult, SendInscriptionResult } from '../types/inscription'
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
  getOrdinalUtxos,
  getTxhex,
  saveExtraUtxos,
  txHexByIdCache,
  validateTxes,
  witnessStackToScriptWitness,
} from '../core/helpers'
import { getOrdinalsWallet, getPaymentWallet, getSignFn } from '../core/providers'
import { getWalletInfo } from '../core/store'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { InscriptionDetails } from '../types/inscription'
import { WalletInfo } from '../types/wallet'

const ENABLE_RBF_NO_LOCKTIME = 0xFFFFFFFD

const DUST_VALUE_P2PKH = 546
const DUST_VALUE_P2WPKH = 294
const DUST_VALUE_P2SH = 540
const DUST_VALUE_P2TR = 330
const DUST_VALUE_MAX = Math.max(
  DUST_VALUE_P2PKH,
  DUST_VALUE_P2WPKH,
  DUST_VALUE_P2SH,
  DUST_VALUE_P2TR,
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

function getDustValue(wallet: WalletInfo): number {
  if (wallet.isOpReturn)
    return 0
  else if (wallet.addr == null)
    throw new Error('Wallet address is null')
  else if (Address.decode(wallet.addr).type === 'p2sh')
    return DUST_VALUE_P2SH
  else if (Address.decode(wallet.addr).type === 'p2w-pkh')
    return DUST_VALUE_P2WPKH
  else if (Address.decode(wallet.addr).type === 'p2tr')
    return DUST_VALUE_P2TR
  else if (Address.decode(wallet.addr).type === 'p2pkh')
    return DUST_VALUE_P2PKH

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

const ADDITIONAL_INPUT_P2PKH_VBYTES = 147
const ADDITIONAL_INPUT_P2SH_VBYTES = 153 // TODO: fix here!!
const ADDITIONAL_INPUT_P2WPKH_VBYTES = 68 // TODO: fix here!! (NOTE: P2WPKH in P2SH is 91)
const ADDITIONAL_INPUT_P2WSH_VBYTES = 68 // TODO: fix here!! (NOTE: P2WSH in P2SH is 103)
const ADDITIONAL_INPUT_P2TR_VBYTES = 58 // TODO: fix here!!

function calculateAdditionalFee(scriptType: string, feeRate: number): number {
  if (scriptType === 'pubkeyhash')
    return Math.ceil(ADDITIONAL_INPUT_P2PKH_VBYTES) * feeRate
  if (scriptType === 'scripthash')
    return Math.ceil(ADDITIONAL_INPUT_P2SH_VBYTES) * feeRate
  if (scriptType === 'witness_v0_keyhash')
    return Math.ceil(ADDITIONAL_INPUT_P2WPKH_VBYTES) * feeRate
  if (scriptType === 'witness_v0_scripthash')
    return Math.ceil(ADDITIONAL_INPUT_P2WSH_VBYTES) * feeRate
  if (scriptType === 'witness_v1_taproot')
    return Math.ceil(ADDITIONAL_INPUT_P2TR_VBYTES) * feeRate
  return 0
}

const TO_X_ONLY = (pubKey: Buffer) => (pubKey.length === 32 ? pubKey : pubKey.slice(1, 33))

async function getMintMultipleFeeAll(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  paymentAddress: string | null,
  payment: number | null,
): Promise<InscribeFees> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
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
    payment,
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
  paymentOpts?: PaymentOpts,
): Promise<InscribeFees> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (!Array.isArray(inscriptionDetailsArray))
    throw new Error('inscriptionDetailsArray must be of type array [bis.InscriptionDetails]')

  for (const inscriptionDetails of inscriptionDetailsArray) {
    if (!(inscriptionDetails instanceof InscriptionDetails))
      throw new Error('inscriptionDetails must be of type bis.InscriptionDetails')
  }

  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('feeRate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentOpts != null) {
    if (typeof paymentOpts.paymentAddress != 'string')
      throw new Error('paymentAddress must be a string')
    if (
      typeof paymentOpts.paymentAmount != 'number'
      || !Number.isInteger(paymentOpts.paymentAmount)
    ) {
      throw new TypeError('paymentAmount must be an integer')
    }
  }

  return await getMintMultipleFeeAll(
    inscriptionDetailsArray,
    feeRate,
    postage,
    paymentOpts?.paymentAddress || null,
    paymentOpts?.paymentAmount || null,
  )
}

export async function inscribeWithParent(
  inscriptionDetails: InscriptionDetails,
  parentInscriptionId: string,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
): Promise<InscribeResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')
  if (!(inscriptionDetails instanceof InscriptionDetails))
    throw new Error('inscriptionDetails must be of type bis.InscriptionDetails')
  if (typeof parentInscriptionId !== 'string')
    throw new Error('parentInscriptionId must be a string')
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('feeRate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentOpts != null) {
    if (typeof paymentOpts.paymentAddress != 'string')
      throw new Error('paymentAddress must be a string')
    if (
      typeof paymentOpts.paymentAmount != 'number'
      || !Number.isInteger(paymentOpts.paymentAmount)
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
    signFn,
  )
}

export async function inscribeMultiple(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
): Promise<InscribeMultipleResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // Checks
  if (!Array.isArray(inscriptionDetailsArray))
    throw new Error('inscriptionDetailsArray must be of type array [bis.InscriptionDetails]')
  for (const inscriptionDetails of inscriptionDetailsArray) {
    if (!(inscriptionDetails instanceof InscriptionDetails))
      throw new Error('inscriptionDetails must be of type bis.InscriptionDetails')
  }
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('feeRate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')

  if (paymentOpts != null) {
    const { paymentAddress, paymentAmount } = paymentOpts
    if (paymentAddress != null && typeof paymentAddress != 'string')
      throw new Error('paymentAddress must be a string')
    if (
      paymentAmount != null
      && (typeof paymentAmount != 'number' || !Number.isInteger(paymentAmount))
    ) {
      throw new Error('paymentAmount must be an integer')
    }
  }

  if (typeof dryRun != 'boolean')
    throw new Error('dryRun must be a boolean')

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  return await mintMultipleAll(
    inscriptionDetailsArray,
    feeRate,
    postage,
    paymentOpts?.paymentAddress ?? null,
    paymentOpts?.paymentAmount ?? null,
    dryRun,
    signFn,
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
): Promise<BuildRevealTxMultipleResult> {
  if (!payment || payment < 0)
    payment = 0

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)
  const script = buildRevealScriptMultiple(pubkey, inscriptionDetailsArray, postage)
  const tapleaf = Tap.encodeScript(script)
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const inputs = [
    {
      txid: commitTxId,
      vout: 0,
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
  if (!isValid)
    throw new Error('Invalid signature')

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
  signFn: SignFunction,
): Promise<InscribeMultipleResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
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
    payment,
  )
  const signedCommitTx = await signFn(
    commitTx.unsigned_psbt_hex,
    payerAddress,
    inscriptionAddress,
    [],
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
  )
  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signed_reveal_tx_hex])

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

  await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signed_reveal_tx_hex])

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
    }
    else if (inputs[i]?.utxo.script_type === 'scripthash') {
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
    }
    else if (inputs[i]?.utxo.script_type === 'witness_v0_keyhash') {
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
    }
    else if (inputs[i]?.utxo.script_type === 'witness_v0_scripthash') {
      // P2WSH
      throw new Error('P2WSH is not supported yet')
    }
    else if (inputs[i]?.utxo.script_type === 'witness_v1_taproot') {
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
      }
      else {
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
    }
    else if (inputs[i]?.utxo.script_type === 'pubkey') {
      throw new Error('pubkey input')
    }
    else if (inputs[i]?.utxo.script_type === 'anchor') {
      throw new Error('anchor input')
    }
    else if (inputs[i]?.utxo.script_type === 'witness_unknown') {
      throw new Error('witness_unknown input')
    }
    else if (inputs[i]?.utxo.script_type === 'nulldata') {
      throw new Error('nulldata input')
    }
    else if (inputs[i]?.utxo.script_type === 'multisig') {
      throw new Error('multisig input')
    }
    else if (inputs[i]?.utxo.script_type === 'nonstandard') {
      throw new Error('nonstandard input')
    }
    else {
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
  parentInscriptionId?: Buff,
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
  postage: number,
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
// payment is the amount to send to payment_wallet (can be null, bust be bigger than DUST_LIMIT)
function buildTransaction(
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
    }
    else {
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
  while (totalOutputAmount < amount + fee) {
    let deficit = amount + fee - totalOutputAmount
    // const additional_fee = Math.ceil(is_payer_p2sh ? bis.ADDITIONAL_INPUT_P2SH_VBYTES : bis.ADDITIONAL_INPUT_P2TR_VBYTES) * fee_rate // TODO: fix here!!
    while (deficit > 0) {
      if (utxos.length === 0)
        throw new Error('Not enough funds')

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
      }
      else {
        const benefit
          = utxos[utxos.length - 1]!.value
            - calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
        deficit -= benefit
        inputs.push({ utxo: utxos.pop()!, wallet: payerWallet })
        totalOutputAmount += inputs[inputs.length - 1]!.utxo.value
      }
    }
  }

  const additionalOutputFee = Math.ceil(changeWallet.outputScript.length + 9) * feeRate // TODO: fix here!! is it done???
  fee = estimateFee(inputs, outputs, feeRate)
  const excess = totalOutputAmount - fee - amount
  let feePayerOutputIndex = -1
  if (excess > getDustValue(changeWallet) + additionalOutputFee) {
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
    }
    else {
      outputs.push({
        wallet: changeWallet,
        out_script: changeWallet.outputScript,
        value: toStrip,
      })
      feePayerOutputIndex = outputs.length - 1
    }
  }
  else {
    if (outputWallet != null) {
      outputs[opReturnSizes.length]!.value = totalOutputAmount
      feePayerOutputIndex = opReturnSizes.length
    }
    else {
      feePayerOutputIndex = -1
    }
  }

  if (usesPayment) {
    if (payment == null)
      throw new Error('Payment is null')

    if (outputWallet != null) {
      outputs[opReturnSizes.length]!.value -= payment
      outputs[opReturnSizes.length + 1]!.value += payment
    }
    else {
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
  }
  else {
    const tempWallet = outputs[feePayerOutputIndex]!.wallet
    if (!tempWallet)
      throw new Error('Fee payer output does not exist')

    if (outputs[feePayerOutputIndex]!.value - fee < getDustValue(tempWallet)) {
      throw new Error('Fee payer output cannot pay the fee')
    }
    outputs[feePayerOutputIndex]!.value -= fee
  }

  const finalTx = constructTxFromInOuts(inputs, outputs)
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
  }
}

interface TransactionInOuts {
  ins: { hash: Buffer, index: number }[]
  outs: { value: number, script: Buffer }[]
}
async function buildPsbtFromTx(
  tx: TransactionInOuts,
  cardinalUtxos: UtxoInfo[],
  payerWallet: WalletInfo,
  forceInUtxos: UtxoInfoWithWallet[],
): Promise<bitcoinjs.Psbt> {
  const networkType = getBitcoinNetwork()

  const resPsbt = new bitcoinjs.Psbt({ network: networkType })

  const willBeAddedSigs: { idx: number, signature: Buffer }[] = []
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
    if (utxoObj == null)
      throw new Error('Cannot find utxo in cardinal_utxos')

    const txhex = await getTxhex(input.hash.toString('hex'))
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    for (const output in tx.outs) {
      // TODO: what tf this is doing man?!?
      try {
        tx.setWitness(Number.parseInt(output), [])
      }
      catch {}
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
    }
    else if (utxoObj.script_type === 'scripthash') {
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
    }
    else if (utxoObj.script_type === 'witness_v0_keyhash') {
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
    }
    else if (utxoObj.script_type === 'witness_v0_scripthash') {
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
    }
    else if (utxoObj.script_type === 'witness_v1_taproot') {
      // P2TR
      const witnessUtxo = tx.outs[input.index]
      if (utxoObj.witnessUtxoScript != null) {
        witnessUtxo!.script = utxoObj.witnessUtxoScript
      }

      let sequence = ENABLE_RBF_NO_LOCKTIME
      if (utxoObj.sequence != null) {
        sequence = utxoObj.sequence
      }

      if (!signerWallet.publicKey)
        throw new Error('publicKey is null on p2tr input')

      if (utxoObj.tapLeafScript == null) {
        // only add tapInternalKey if its key spend path
        resPsbt.addInput({
          hash: input.hash.toString('hex'),
          index: input.index,
          sequence,
          witnessUtxo,
          tapInternalKey: TO_X_ONLY(Buffer.from(signerWallet.publicKey, 'hex')),
        })
      }
      else {
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
    }
    else {
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
): Promise<BuildCommitTxResult> {
  if (payment == null || payment < 0)
    payment = 0
  const changeWallet = payerWallet

  if (!payerWallet.addr)
    throw new Error('Payer wallet address is not set.')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

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
    if (!paymentWallet)
      throw new Error('Payment wallet is not available.')

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
      '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    ),
    script,
    cblock,
  ]

  const revealFee = Tx.util.getTxSize(dummyRevealTx).vsize * feeRate // TODO: check new version: dummy_reveal_tx.virtualSize() * fee_rate

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
  )
  const unsignedCommitTx = unsignedCommitTxResp.tx
  const commitFee = unsignedCommitTxResp.tx_fee

  // psbt test for commit tx
  const unsignedCommitPsbt = await buildPsbtFromTx(
    unsignedCommitTx,
    cardinalUtxos,
    payerWallet,
    forceInUtxos,
  )

  return {
    unsigned_commit_tx: unsignedCommitTx,
    unsigned_psbt_hex: unsignedCommitPsbt.toHex(),
    output_value: unsignedCommitTx.outs[0]!.value,
    commit_fee: commitFee,
    reveal_fee: revealFee,
  }
}

interface BuildCommitTxMultipleResult {
  unsigned_psbt_hex: string
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
  payment: number | null,
): Promise<BuildCommitTxMultipleResult> {
  if (!payment || payment < 0)
    payment = 0

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
      '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    ),
    script,
    cblock,
  ]

  const revealFee = Tx.util.getTxSize(dummyRevealTx).vsize * feeRate // TODO: check new version: dummy_reveal_tx.virtualSize() * fee_rate

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
    null,
  )
  const unsignedCommitTx = unsignedCommitTxResp.tx
  const commitFee = unsignedCommitTxResp.tx_fee

  // psbt test for commit tx
  const unsignedCommitPsbt = await buildPsbtFromTx(unsignedCommitTx, cardinalUtxos, payerWallet, [])

  return {
    unsigned_psbt_hex: unsignedCommitPsbt.toHex(),
    output_value: unsignedCommitTx.outs[0]!.value,
    commit_fee: commitFee,
    reveal_fee: revealFee,
  }
}

interface BuildCommitTxWithParentResult {
  unsigned_psbt_hex: string
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
  parentInscriptionId: string,
): Promise<BuildCommitTxWithParentResult> {
  const changeWallet = payerWallet
  const parentInscriptionIdBuff = convertInscriptionIdToBuffer(parentInscriptionId)

  if (!payerWallet.addr)
    throw new Error('Payer wallet address is not set.')

  if (!inscriptionWallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const ordinalUtxos = await getOrdinalUtxos(inscriptionWallet.addr)
  let parentUtxo = null
  for (const utxo of ordinalUtxos) {
    for (const inscrId of utxo.inscription_ids) {
      if (inscrId === parentInscriptionId) {
        parentUtxo = utxo
        break
      }
    }
    if (parentUtxo)
      break
  }
  if (!parentUtxo)
    throw new Error('Parent inscription utxo not found in ordinal utxos')

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
    null,
  )
  const unsignedCommitTx = unsignedCommitTxResp.tx
  const commitFee = unsignedCommitTxResp.tx_fee

  // psbt test for commit tx
  const unsignedCommitPsbt = await buildPsbtFromTx(unsignedCommitTx, cardinalUtxos, payerWallet, [])

  return {
    unsigned_psbt_hex: unsignedCommitPsbt.toHex(),
    output_value: unsignedCommitTx.outs[0]!.value,
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

  let fee = estimateFee(inputs, outputs, feeRate)
  while (totalInputAmount < totalTargetAmount + fee) {
    let deficit = totalTargetAmount + fee - totalInputAmount
    // const additional_fee = Math.ceil(is_payer_p2sh ? bis.ADDITIONAL_INPUT_P2SH_VBYTES : bis.ADDITIONAL_INPUT_P2TR_VBYTES) * fee_rate // TODO: fix here!!
    while (deficit > 0) {
      if (utxos.length === 0)
        throw new Error('Not enough funds')

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
      }
      else {
        const benefit
          = utxos[utxos.length - 1]!.value
            - calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
        deficit -= benefit
        inputs.push({ utxo: utxos.pop()!, wallet: payerWallet })
        totalInputAmount += inputs[inputs.length - 1]!.utxo.value
      }
    }
  }

  if (!changeWallet.outputScript)
    throw new Error('build_transaction_multi_output change_wallet.outputScript is null')

  const additionalChangeOutputFee = Math.ceil(changeWallet.outputScript.length + 9) * feeRate // TODO: fix here!! is it done???
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
  }
  else {
    if (
      outputs[feePayerOutputIdx]!.value - fee
      < getDustValue(outputs[feePayerOutputIdx]!.wallet)
    ) {
      throw new Error('Fee payer output cannot pay the fee')
    }
    outputs[feePayerOutputIdx]!.value -= fee
  }

  const finalTx = constructTxFromInOuts(inputs, outputs)
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
  dryRun: boolean,
): Promise<SendMultiInscriptionWithBufferResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // set to null if 0
  if (payment === 0) {
    paymentAddr = null
    payment = null
  }

  if (!Array.isArray(inscriptionIds))
    throw new Error('inscription_ids must be an array')
  if (!Array.isArray(targetPostages))
    throw new Error('target_postages must be an array')
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')
  for (const tp of targetPostages) {
    if (tp != null && (typeof tp != 'number' || !Number.isInteger(tp)))
      throw new Error('target_postages must be an array of integers or null')
  }
  for (const inscrId of inscriptionIds) {
    if (typeof inscrId != 'string')
      throw new Error('inscription_ids must be an array of strings')
  }
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('fee_rate must be an integer')
  if (typeof bufferValue != 'number' || !Number.isInteger(bufferValue))
    throw new Error('buffer_value must be an integer')
  if (typeof targetAddr != 'string')
    throw new Error('target_addr must be a string')
  if (typeof dryRun != 'boolean')
    throw new Error('dry_run must be a boolean')
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
    if (payment < getDustValue(paymentWallet))
      throw new Error('payment must be bigger than dust')
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
    signFn,
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
  signFunc: SignFunction,
): Promise<SendMultiInscriptionWithBufferResult> {
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')

  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
  )

  const inputUtxos: UtxoInfoWithWallet[] = []
  const targetWallets: WalletInfo[] = []
  const amounts: number[] = []
  const inscrWalletSignIdxes: number[] = []

  if (!inscriptionWallet.addr)
    throw new Error('inscription_wallet is null')

  for (let i = 0; i < inscriptionIds.length; i++) {
    const inscriptionDetails = await getInscriptionDetails(
      inscriptionIds[i]!,
      inscriptionWallet.addr,
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

  if (!payerWallet.addr)
    throw new Error('payer_wallet.addr is null')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  const unsignedTxResp = buildTransactionMultiOutput(
    cardinalUtxos,
    inputUtxos,
    payerWallet,
    targetWallets,
    amounts,
    payerWallet,
    feeRate,
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, inputUtxos)
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(
    unsignedPsbtHex,
    payerWallet.addr,
    inscriptionWallet.addr,
    inscrWalletSignIdxes,
  )

  const isValid = await validateTxes([signedTx.signedTxHex])
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
    outputUtxos.push(`${signedTx.txId}:${i}`)
    outputValues.push(unsignedTx.outs[i]!.value)
  }
  bufferUtxo = `${signedTx.txId}:${inscriptionIds.length}`
  bufferOutputValue = unsignedTx.outs[inscriptionIds.length]!.value

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

  await broadcastTxes([signedTx.signedTxHex])

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
  signFunc: SignFunction,
): Promise<SendInscriptionResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
  )

  if (!inscriptionWallet.addr)
    throw new Error('inscription_wallet is null')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payerWallet.addr)
    throw new Error('payer_wallet.addr is null')

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
    null,
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, [inscrUtxo])
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [0])

  const isValid = await validateTxes([signedTx.signedTxHex])
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

  await broadcastTxes([signedTx.signedTxHex])

  return {
    txId: signedTx.txId,
    signedTxHex: signedTx.signedTxHex,
    vout: 0,
    outputValue: unsignedTx.outs[0]!.value,
  }
}

interface InscriptionUTXODetails {
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
async function getInscriptionDetails(
  inscriptionId: string,
  inscriptionAddr: string,
  ordinalUtxos?: APIOrdinalUtxoInfo[],
): Promise<InscriptionUTXODetails | null> {
  let utxos = null
  if (ordinalUtxos) {
    utxos = ordinalUtxos
  }
  else {
    utxos = await getOrdinalUtxos(inscriptionAddr)
  }

  for (const utxo of utxos) {
    for (let i = 0; i < utxo.inscription_ids.length; i++) {
      if (utxo.inscription_ids[i]! === inscriptionId) {
        return {
          satpoint: utxo.satpoints[i]!,
          value: utxo.value,
          script_type: utxo.script_type,
          block_height: utxo.block_height,
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
  payment: number | null,
): Promise<number> {
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')

  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
  )

  const inputUtxos: UtxoInfoWithWallet[] = []
  const targetWallets: WalletInfo[] = []
  const amounts: number[] = []
  const inscrWalletSignIdxes: number[] = []

  if (!inscriptionWallet.addr)
    throw new Error('Inscription wallet address is not set.')

  for (let i = 0; i < inscriptionIds.length; i++) {
    const inscriptionDetails = await getInscriptionDetails(
      inscriptionIds[i]!,
      inscriptionWallet.addr,
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

  if (!payerWallet.addr)
    throw new Error('payer_wallet.addr is null')

  const cardinalUtxos = await getCardinalUtxos(payerWallet.addr)

  const unsignedTxResp = buildTransactionMultiOutput(
    cardinalUtxos,
    inputUtxos,
    payerWallet,
    targetWallets,
    amounts,
    payerWallet,
    feeRate,
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
  payment: number | null,
): Promise<number> {
  if (payment === 0) {
    paymentAddr = null
    payment = null
  }

  if (!Array.isArray(inscriptionIds))
    throw new Error('inscription_ids must be an array')
  if (!Array.isArray(targetPostages))
    throw new Error('target_postages must be an array')
  if (inscriptionIds.length !== targetPostages.length)
    throw new Error('inscription_ids and target_postages must have the same length')
  for (const tp of targetPostages) {
    if (tp != null && (typeof tp != 'number' || !Number.isInteger(tp)))
      throw new Error('target_postages must be an array of integers or null')
  }
  for (const inscrId of inscriptionIds) {
    if (typeof inscrId != 'string')
      throw new Error('inscription_ids must be an array of strings')
  }
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('fee_rate must be an integer')
  if (typeof bufferValue != 'number' || !Number.isInteger(bufferValue))
    throw new Error('buffer_value must be an integer')
  if (typeof targetAddr != 'string')
    throw new Error('target_addr must be a string')
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
    if (payment < getDustValue(paymentWallet))
      throw new Error('payment must be bigger than dust')
  }

  return await sendMultiInscriptionWithBufferFeeRateAll(
    inscriptionIds,
    targetPostages,
    targetWallet,
    bufferValue,
    feeRate,
    paymentWallet,
    payment,
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
): Promise<SignResponse> {
  if (payment == null || payment < 0)
    payment = 0

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = buildRevealScript(pubkey, inscriptionDetails)
  const tapleaf = Tap.encodeScript(script)

  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const inputs = [
    {
      txid: commitTxid,
      vout: 0,
    },
  ]

  const txdataVout = [
    {
      value: postage,
      scriptPubKey: inscriptionWallet.outputScript,
    },
  ]
  if (payment > 0) {
    if (!paymentWallet)
      throw new Error('Payment wallet is not available.')

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
  if (!isValid)
    throw new Error('Invalid signature')

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
): Promise<BuildRevealTxWithParentResult> {
  if (payment == null || payment < 0)
    payment = 0
  const changeWallet = payerWallet
  const parentInscriptionIdBuff = convertInscriptionIdToBuffer(parentInscriptionId)

  if (!inscriptionWallet.addr)
    throw new Error('Inscription wallet address is not set.')
  if (!payerWallet.addr)
    throw new Error('Payer wallet address is not set.')

  const ordinalUtxos = await getOrdinalUtxos(inscriptionWallet.addr)
  let parentUtxo = null
  for (const utxo of ordinalUtxos) {
    for (const inscrId of utxo.inscription_ids) {
      if (inscrId === parentInscriptionId) {
        parentUtxo = utxo
        break
      }
    }
    if (parentUtxo)
      break
  }
  if (!parentUtxo)
    throw new Error('Parent inscription utxo not found in ordinal utxos')

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
  const utxos = cardinalUtxos.slice()
  utxos.sort((a, b) => a.value - b.value)

  const inputs: TxInput[] = [
    {
      utxo: {
        script_type: 'witness_v1_taproot',
        utxo: `${commitTxid}:0`,
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
    if (!paymentWallet)
      throw new Error('Payment wallet is not available.')

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
      if (utxos.length === 0)
        throw new Error('Not enough funds')

      if (
        utxos[utxos.length - 1]!.value
        >= deficit + calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
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
      }
      else {
        const benefit
          = utxos[utxos.length - 1]!.value
            - calculateAdditionalFee(utxos[utxos.length - 1]!.script_type, feeRate)
        deficit -= benefit
        const utxo = utxos.pop()!
        inputs.push({ utxo, wallet: payerWallet })
        currentMinerFee += utxo.value
      }
    }
    fee = estimateFee(inputs, outputs, feeRate)
  }

  if (!changeWallet.outputScript)
    throw new Error('Change wallet output script is not set.')

  const changeOutputFee = Math.ceil(changeWallet.outputScript.length + 9) * feeRate
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
    if (!paymentWallet)
      throw new Error('Payment wallet is not available.')
    if (!paymentWallet.outputScript)
      throw new Error('Payment wallet output script is not set.')

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

    if (!wallet.outputScript)
      throw new Error('Input wallet output script is not set.')

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

    if (!scriptPubKey)
      throw new Error('Output script is not set.')

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
  if (!isValid)
    throw new Error('Invalid signature')

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
  signFunc: SignFunction,
) {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
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
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    [],
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
  )

  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])

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

  await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])
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
  signFunc: SignFunction,
): Promise<InscribeResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    [],
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    [],
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
  )

  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])

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

  await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])
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
 *
 * @returns an object containing the estimated commit fee, reveal fee, total fee, unsigned commit transaction hex, signed reveal transaction hex, inscription ID, and postage used
 */
export async function mintAllCheckFees(
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
): Promise<InscribeCheckFeesResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
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
  signFunc: SignFunction,
): Promise<SendInscriptionResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
  )

  if (!inscriptionWallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payerWallet.addr)
    throw new Error('Payer wallet address is not set.')

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
    null,
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, [inscrUtxo])
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [0])

  const isValid = await validateTxes([signedTx.signedTxHex])

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

  await broadcastTxes([signedTx.signedTxHex])

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
  signFunc: SignFunction,
): Promise<SendInscriptionResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

  if (targetPostage == null || targetPostage <= 0) {
    targetPostage = 1 // 1 sat for inscription
  }

  const paymentAddr = userPaymentWallet.address
  const paymentPublicKey = userPaymentWallet.pubkey
  const inscriptionAddr = userOrdinalsWallet.address
  const inscriptionPublicKey = userOrdinalsWallet.pubkey

  const payerWallet = new WalletInfo(false, null, paymentAddr, null, paymentPublicKey)
  const inscriptionWallet = new WalletInfo(false, null, inscriptionAddr, null, inscriptionPublicKey)

  if (!payerWallet.addr)
    throw new Error('Payment wallet address is not set.')
  if (!inscriptionWallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, payerWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payerWallet.addr)
    throw new Error('Payer wallet address is not set.')

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
    null,
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, [inscrUtxo])
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [])

  const isValid = await validateTxes([signedTx.signedTxHex])

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

  await broadcastTxes([signedTx.signedTxHex])
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
  signFunc: SignFunction,
): Promise<InscribeResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
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
    parentInscriptionId,
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    [],
  )

  const commitTxid = signedCommitTx.txId
  let signedRevealTx = null
  try {
    saveExtraUtxos(
      [signedCommitTx.signedTxHex],
      ['0000000000000000000000000000000000000000000000000000000000000000i0', `${commitTxid}:0:0`],
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
    )

    signedRevealTx = await signFunc(
      revealTx.partially_signed_psbt_hex,
      payerAddr,
      inscriptionAddress,
      [1],
      undefined,
      [0],
    )
  }
  finally {
    clearExtraUtxos()
  }

  const isValid = await validateTxes([signedCommitTx.signedTxHex, signedRevealTx.signedTxHex])

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
  await broadcastTxes([signedCommitTx.signedTxHex, signedRevealTx.signedTxHex])
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
  signFunc: SignFunction,
): Promise<SignResponse> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
  )

  if (!inscriptionWallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    throw new Error('Inscription is not at the first sat of utxo')
  }

  if (!payerWallet.addr)
    throw new Error('Payer wallet address is not set.')

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
    feeRate,
  )
  const unsignedTx = unsignedTxResp.tx

  const unsignedPsbt = await buildPsbtFromTx(unsignedTx, cardinalUtxos, payerWallet, extraUtxoObjs)
  const unsignedPsbtHex = unsignedPsbt.toHex()

  const signedTx = await signFunc(unsignedPsbtHex, payerWallet.addr, inscriptionWallet.addr, [0])

  const isValid = await validateTxes([signedTx.signedTxHex])

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

  await broadcastTxes([signedTx.signedTxHex])
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
): Promise<SendInscriptionFeeRateResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
  )

  if (!inscriptionWallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscriptionDetails = await getInscriptionDetails(inscriptionId, inscriptionWallet.addr)
  if (inscriptionDetails == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscriptionDetails.satpoint.split(':')[2] !== '0') {
    throw new Error('Inscription is not at the first sat of utxo')
  }

  if (!payerWallet.addr)
    throw new Error('Payer wallet address is not set.')

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
    feeRate,
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
): Promise<InscribeResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
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
  )
  const signedCommitTx = await signFunc(
    commitTx.unsigned_psbt_hex,
    payerAddr,
    inscriptionAddress,
    [],
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
  )

  const isValid = await validateTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])

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

  await broadcastTxes([signedCommitTx.signedTxHex, revealTx.signedTxHex])
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
): Promise<InscribeCheckFeesResult> {
  // Get connected wallet
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userPaymentWallet || !userOrdinalsWallet)
    throw new Error('Wallets not found')

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
    inscriptionPublicKey,
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
