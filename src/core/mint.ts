import type { APIOrdinalUtxoInfo } from './helpers'
import type { SignFunction, SignResponse } from './providers'
import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import {
  get_pubkey, // Generate a secp256k1 public key for a given secret ke
  get_seckey, // Convert a number or byte value into a secp256k1 secret key.
} from '@cmdcode/crypto-tools/keys'
import { Address, Script, Signer, Tap, Tx } from '@cmdcode/tapscript'
import { bitcoinjs, getBitcoinNetwork } from '../lib/bitcoin'
import { broadcast_txes, check_txes, clear_extra_utxos, get_cardinal_utxos, get_ordinal_utxos, get_txhex, save_extra_utxos, txHexByIdCache, witnessStackToScriptWitness } from './helpers'
import { getOrdinalsWallet, getPaymentWallet, getSignFn } from './providers'
import { getWalletInfo } from './store'

const ENABLE_RBF_NO_LOCKTIME = 0xFFFFFFFD

const DUST_VALUE_P2PKH = 546 // TODO: check
const DUST_VALUE_P2WPKH = 294 // TODO: check
const DUST_VALUE_P2SH = 540 // TODO: check
const DUST_VALUE_P2TR = 330 // TODO: check
const DUST_VALUE_MAX = Math.max(DUST_VALUE_P2PKH, DUST_VALUE_P2WPKH, DUST_VALUE_P2SH, DUST_VALUE_P2TR)

export class InscriptionDetails {
  mime_type: Buff | null
  metadata: Buff | null
  metaprotocol: Buff | null
  content_encoding: Buff | null
  delegate: Buff | null
  file_data: Buff | null

  constructor(
    mime_type: Buff | null,
    metadata: Buff | null,
    metaprotocol: Buff | null,
    content_encoding: Buff | null,
    delegate: Buff | null,
    file_data: Buff | null,
  ) {
    if (mime_type != null && !(mime_type instanceof Buff)) {
      throw new Error('mime_type must be of type Buff or null')
    }
    if (metadata != null && !(metadata instanceof Buff)) {
      throw new Error('metadata must be of type Buff or null')
    }
    if (metaprotocol != null && !(metaprotocol instanceof Buff)) {
      throw new Error('metaprotocol must be of type Buff or null')
    }
    if (content_encoding != null && !(content_encoding instanceof Buff)) {
      throw new Error('content_encoding must be of type Buff or null')
    }
    if (delegate != null && !(delegate instanceof Buff)) {
      throw new Error('delegate must be of type Buff or null')
    }
    if (file_data != null && !(file_data instanceof Buff)) {
      throw new Error('file_data must be of type Buff or null')
    }

    this.mime_type = mime_type
    this.metadata = metadata
    this.metaprotocol = metaprotocol
    this.content_encoding = content_encoding
    this.delegate = delegate
    this.file_data = file_data
  }
}

export class WalletInfo {
  addr: string | null | undefined
  redeemScript: Buffer | null
  is_op_return: boolean
  outputScript: Buffer
  publicKey: string | null

  constructor(
    is_op_return: boolean,
    outputScript: Buffer | null,
    addr: string | null | undefined,
    redeemScript: Buffer | null,
    publicKey: string | null,
  ) {
    this.addr = addr
    this.redeemScript = redeemScript
    this.is_op_return = is_op_return
    this.publicKey = publicKey

    // Set outputScript based on conditions
    if (addr != null && outputScript == null) {
      this.outputScript = Buffer.from(Script.encode(Address.toScriptPubKey(addr), false))
    }
    else {
      if (outputScript == null) {
        throw new Error('outputScript and addr cannot be null')
      }
      this.outputScript = outputScript
    }
  }

  getRedeemScript(): Buffer {
    // Return the cached redeemScript if it exists
    if (this.redeemScript != null) {
      return this.redeemScript
    }

    // Derive redeemScript from publicKey
    if (this.publicKey == null) {
      throw new Error('publicKey is required to derive redeemScript')
    }

    const network_type = getBitcoinNetwork()

    const pubKeyBuffer = Buffer.from(this.publicKey, 'hex')
    const p2wpkh = bitcoinjs.payments.p2wpkh({
      pubkey: pubKeyBuffer,
      network: network_type,
    })

    const p2sh = bitcoinjs.payments.p2sh({
      redeem: p2wpkh,
      network: network_type,
    })

    if (!p2sh.redeem?.output) {
      throw new Error('Failed to derive redeemScript')
    }

    return p2sh.redeem.output
  }
}

// get_secret
function createSecretToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Buffer.from(array).toString('hex')
}

export function convertInscriptionIdToBuffer(inscriptionId: string): Buff {
  const txid = inscriptionId.slice(0, 64)
  const inscr_idx = Number.parseInt(inscriptionId.slice(65))

  // txid should be reversed
  // inscr_idx is little endian 4 bytes, appended after reversed txid and trailing zeroes are removed
  const inscr_idx_buf = new Buff(inscr_idx, 4, 'le')
  // remove trailing zeros from inscr_idx_buf
  let i = 3
  while (i >= 0 && inscr_idx_buf[i] === 0) i--
  const inscr_idx_buf_trimmed = inscr_idx_buf.slice(0, i + 1)
  const reversed_txid = Buff.hex(txid).reverse()

  return reversed_txid.append(inscr_idx_buf_trimmed)
}

function get_dust_value(wallet: WalletInfo): number {
  if (wallet.is_op_return)
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

function repeat_str(str: string, num: number): string {
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
  script_type: 'pubkeyhash' | 'scripthash' | 'witness_v0_keyhash' | 'witness_v0_scripthash' | 'witness_v1_taproot' | 'pubkey' | 'anchor' | 'witness_unknown' | 'nulldata' | 'multisig' | 'nonstandard'
  value: number
  tapLeafScript?: Array<TapLeafScriptInfo>
  wallet?: WalletInfo
  witnessUtxoScript?: Buffer
  sequence?: number
  finalScriptWitness?: Buffer
}
interface UtxoInfoWithWallet {
  utxo: string
  script_type: 'pubkeyhash' | 'scripthash' | 'witness_v0_keyhash' | 'witness_v0_scripthash' | 'witness_v1_taproot' | 'pubkey' | 'anchor' | 'witness_unknown' | 'nulldata' | 'multisig' | 'nonstandard'
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
export function estimate_fee(inputs: TxInput[], outputs: TxOutput[], fee_rate: number): number {
  const tx = constructTxFromInOuts(inputs, outputs)
  const vbytes = tx.virtualSize() // tx.virtualSize() // TODO: check this
  return Math.ceil(vbytes * fee_rate)
}

const ADDITIONAL_INPUT_P2PKH_VBYTES = 147
const ADDITIONAL_INPUT_P2SH_VBYTES = 153 // TODO: fix here!!
const ADDITIONAL_INPUT_P2WPKH_VBYTES = 68 // TODO: fix here!! (NOTE: P2WPKH in P2SH is 91)
const ADDITIONAL_INPUT_P2WSH_VBYTES = 68 // TODO: fix here!! (NOTE: P2WSH in P2SH is 103)
const ADDITIONAL_INPUT_P2TR_VBYTES = 58 // TODO: fix here!!

function calc_additional_fee(script_type: string, fee_rate: number): number {
  if (script_type === 'pubkeyhash')
    return Math.ceil(ADDITIONAL_INPUT_P2PKH_VBYTES) * fee_rate
  if (script_type === 'scripthash')
    return Math.ceil(ADDITIONAL_INPUT_P2SH_VBYTES) * fee_rate
  if (script_type === 'witness_v0_keyhash')
    return Math.ceil(ADDITIONAL_INPUT_P2WPKH_VBYTES) * fee_rate
  if (script_type === 'witness_v0_scripthash')
    return Math.ceil(ADDITIONAL_INPUT_P2WSH_VBYTES) * fee_rate
  if (script_type === 'witness_v1_taproot')
    return Math.ceil(ADDITIONAL_INPUT_P2TR_VBYTES) * fee_rate
  return 0
}

const toXOnly = (pubKey: Buffer) => (pubKey.length === 32 ? pubKey : pubKey.slice(1, 33))

interface CheckInscribeMultipleFeeResult {
  total_fee: number
  commit_fee: number
  reveal_fee: number
  postage: number
  secret: string
}
async function check_mint_multiple_fee_all(
  inscription_details_array: InscriptionDetails[],
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
): Promise<CheckInscribeMultipleFeeResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(inscription_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx_multiple(payer_wallet, inscription_wallet, secret, inscription_details_array, fee_rate, postage, payment_wallet, payment)
  return {
    total_fee: commit_tx.commit_fee + commit_tx.reveal_fee,
    commit_fee: commit_tx.commit_fee,
    reveal_fee: commit_tx.reveal_fee,
    postage,
    secret,
  }
}

export async function checkInscribeMultipleFee(
  inscription_details_array: InscriptionDetails[],
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
): Promise<CheckInscribeMultipleFeeResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (!Array.isArray(inscription_details_array))
    throw new Error('inscription_details_array must be of type array [bis.InscriptionDetails]')

  for (const inscription_details of inscription_details_array) {
    if (!(inscription_details instanceof InscriptionDetails))
      throw new Error('inscription_details_array must be of type array [bis.InscriptionDetails]')
  }

  if (typeof fee_rate != 'number' || !Number.isInteger(fee_rate))
    throw new Error('fee_rate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (payment_addr != null && typeof payment_addr != 'string')
    throw new Error('payment_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer')

  return await check_mint_multiple_fee_all(inscription_details_array, fee_rate, postage, payment_addr, payment)
}

interface InscribeMultipleResult {
  commit_txid: string
  signed_commit_tx_hex: string
  reveal_txid: string
  signed_reveal_tx_hex: string
  inscription_ids: string[]
  postage: number
  secret: string
}

export async function inscribe(
  inscription_details: InscriptionDetails,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
): Promise<InscribeMultipleResult> {
  return await inscribeMultiple([inscription_details], fee_rate, postage, payment_addr, payment, dry_run)
}

export async function inscribeMultiple(
  inscription_details_array: InscriptionDetails[],
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
): Promise<InscribeMultipleResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // Checks
  if (!Array.isArray(inscription_details_array))
    throw new Error('inscription_details_array must be of type array [bis.InscriptionDetails]')
  for (const inscription_details of inscription_details_array) {
    if (!(inscription_details instanceof InscriptionDetails))
      throw new Error('inscription_details_array must be of type array [bis.InscriptionDetails]')
  }
  if (typeof fee_rate != 'number' || !Number.isInteger(fee_rate))
    throw new Error('fee_rate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (payment_addr != null && typeof payment_addr != 'string')
    throw new Error('payment_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer')
  if (typeof dry_run != 'boolean')
    throw new Error('dry_run must be a boolean')

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  return await mintMultipleAll(inscription_details_array, fee_rate, postage, payment_addr, payment, dry_run, signFn)
}

interface BuildRevealTxMultipleResult {
  txid: string
  signed_reveal_tx_hex: string
}
async function build_reveal_tx_multiple(
  inscription_wallet: WalletInfo,
  commit_txid: string,
  commit_output_value: number,
  secret: string,
  inscription_details_array: InscriptionDetails[],
  postage: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
): Promise<BuildRevealTxMultipleResult> {
  if (!payment || payment < 0)
    payment = 0

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)
  const script = build_reveal_script_multiple(pubkey, inscription_details_array, postage)
  const tapleaf = Tap.encodeScript(script)
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const inputs = [{
    txid: commit_txid,
    vout: 0,
  }]

  const txdata_vout = []
  for (let i = 0; i < inscription_details_array.length; i++) {
    txdata_vout.push({
      value: postage,
      scriptPubKey: inscription_wallet.outputScript,
    })
  }

  if (payment && payment > 0 && payment_wallet) {
    txdata_vout.push({
      value: payment,
      scriptPubKey: payment_wallet.outputScript,
    })
  }
  const txdata = Tx.create({
    vin: [{
      // Use the txid of the funding transaction used to send the sats.
      txid: inputs[0]!.txid,
      // Specify the index value of the output that you are going to spend from.
      vout: inputs[0]!.vout,
      // Also include the value and script of that ouput.
      prevout: {
        // Feel free to change this if you sent a different amount.
        value: commit_output_value,
        // This is what our address looks like in script form.
        scriptPubKey: ['OP_1', tpubkey],
      },
    }],
    vout: txdata_vout,
  })

  const sig = Signer.taproot.sign(seckey, txdata, 0, { extension: tapleaf })
  txdata.vin[0]!.witness = [sig, script, cblock]

  const isValid = Signer.taproot.verify(txdata, 0, { pubkey, throws: true })
  if (!isValid)
    throw new Error('Invalid signature')

  return {
    txid: Tx.util.getTxid(txdata),
    signed_reveal_tx_hex: Tx.encode(txdata).hex,
  }
}

async function mintMultipleAll(
  inscription_details_array: InscriptionDetails[],
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
  sign_fn: SignFunction,
): Promise<InscribeMultipleResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(inscription_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx_multiple(payer_wallet, inscription_wallet, secret, inscription_details_array, fee_rate, postage, payment_wallet, payment)
  const signed_commit_tx = await sign_fn(commit_tx.unsigned_psbt_hex, payer_addr, inscription_address, [])
  const commit_txid = signed_commit_tx.txid
  const reveal_tx = await build_reveal_tx_multiple(inscription_wallet, commit_txid, commit_tx.output_value, secret, inscription_details_array, postage, payment_wallet, payment)
  const isValid = await check_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_reveal_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  const inscription_ids = []
  for (let i = 0; i < inscription_details_array.length; i++) {
    inscription_ids.push(`${reveal_tx.txid}i${i}`)
  }

  if (dry_run) {
    return {
      commit_txid: signed_commit_tx.txid,
      signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
      reveal_txid: reveal_tx.txid,
      signed_reveal_tx_hex: reveal_tx.signed_reveal_tx_hex,
      inscription_ids,
      postage,
      secret,
    }
  }

  await broadcast_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_reveal_tx_hex])

  return {
    commit_txid: signed_commit_tx.txid,
    signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
    reveal_txid: reveal_tx.txid,
    signed_reveal_tx_hex: reveal_tx.signed_reveal_tx_hex,
    inscription_ids,
    postage,
    secret,
  }
}

function constructTxFromInOuts(inputs: TxInput[], outputs: TxOutput[]): bitcoinjs.Transaction {
  const final_tx = new bitcoinjs.Transaction() /* network_type */
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]?.utxo.script_type === 'pubkeyhash') { // P2PKH
      if (inputs[i]?.wallet.publicKey == null) {
        throw new Error('publicKey is null on p2pkh input')
      }

      const hash = inputs[i]?.utxo.utxo.split(':')[0]
      const index_str = inputs[i]?.utxo.utxo.split(':')[1]
      if (!hash || !index_str) {
        throw new Error('Invalid utxo format, expected txid:index')
      }
      const index = Number.parseInt(index_str)
      final_tx.ins.push({
        hash: Buffer.from(hash, 'hex'),
        index,
        script: Buffer.from(`48${repeat_str('00', 72)}21${inputs[i]?.wallet.publicKey}`, 'hex'),
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witness: [],
      })
    }
    else if (inputs[i]?.utxo.script_type === 'scripthash') { // P2SH
      if (inputs[i]?.wallet.getRedeemScript() == null) {
        throw new Error('Redeem script is null on p2sh input')
      }

      const hash = inputs[i]?.utxo.utxo.split(':')[0]
      const index_str = inputs[i]?.utxo.utxo.split(':')[1]
      if (!hash || !index_str) {
        throw new Error('Invalid utxo format, expected txid:index')
      }
      const index = Number.parseInt(index_str)
      const publicKey = inputs[i]?.wallet.publicKey
      if (publicKey == null) {
        throw new Error('publicKey is null on p2sh input')
      }
      final_tx.ins.push({
        hash: Buffer.from(hash, 'hex'),
        index,
        script: Buffer.from(Script.encode(inputs[i]?.wallet.getRedeemScript(), true)),
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witness: [Buffer.from(repeat_str('00', 71), 'hex'), Buffer.from(publicKey, 'hex')],
      })
    }
    else if (inputs[i]?.utxo.script_type === 'witness_v0_keyhash') { // P2WPKH
      if (inputs[i]?.wallet.publicKey == null) {
        throw new Error('publicKey is null on p2wpkh input')
      }

      const hash = inputs[i]?.utxo.utxo.split(':')[0]
      const index_str = inputs[i]?.utxo.utxo.split(':')[1]
      if (!hash || !index_str) {
        throw new Error('Invalid utxo format, expected txid:index')
      }
      const index = Number.parseInt(index_str)
      const publicKey = inputs[i]?.wallet.publicKey
      if (publicKey == null) {
        throw new Error('publicKey is null on p2wpkh input')
      }
      final_tx.ins.push({
        hash: Buffer.from(hash, 'hex'),
        index,
        script: Buffer.from('', 'hex'),
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witness: [Buffer.from(repeat_str('00', 72), 'hex'), Buffer.from(publicKey, 'hex')],
      })
    }
    else if (inputs[i]?.utxo.script_type === 'witness_v0_scripthash') { // P2WSH
      throw new Error('P2WSH is not supported yet')
    }
    else if (inputs[i]?.utxo.script_type === 'witness_v1_taproot') { // P2TR
      if (inputs[i]?.utxo.tapLeafScript) {
        const hash = inputs[i]?.utxo.utxo.split(':')[0]
        const index_str = inputs[i]?.utxo.utxo.split(':')[1]
        if (!hash || !index_str) {
          throw new Error('Invalid utxo format, expected txid:index')
        }
        const index = Number.parseInt(index_str)
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
        final_tx.ins.push({
          hash: Buffer.from(hash, 'hex'),
          index,
          script: Buffer.from('', 'hex'),
          sequence: ENABLE_RBF_NO_LOCKTIME,
          witness: [Buffer.from(repeat_str('00', 65), 'hex'), tapleafScriptScript, controlBlock],
        })
      }
      else {
        const hash = inputs[i]?.utxo.utxo.split(':')[0]
        const index_str = inputs[i]?.utxo.utxo.split(':')[1]
        if (!hash || !index_str) {
          throw new Error('Invalid utxo format, expected txid:index')
        }
        const index = Number.parseInt(index_str)
        final_tx.ins.push({
          hash: Buffer.from(hash, 'hex'),
          index,
          script: Buffer.from('', 'hex'),
          sequence: ENABLE_RBF_NO_LOCKTIME,
          witness: [Buffer.from(repeat_str('00', 65), 'hex')],
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
    final_tx.addOutput(outputs[i]!.out_script, outputs[i]!.value)
  }

  return final_tx
}

function build_reveal_script(pubkey: Buff, inscr: InscriptionDetails, parent_inscription_id?: Buff): (string | Buff)[] {
  const script = [
    pubkey,
    'OP_CHECKSIG',
    'OP_0',
    'OP_IF',
    Buff.str('ord'),
  ]
  if (inscr.mime_type) {
    script.push('01')
    script.push(inscr.mime_type)
  }
  if (parent_inscription_id) {
    script.push('03')
    script.push(parent_inscription_id)
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
  if (inscr.content_encoding) {
    script.push('09')
    script.push(inscr.content_encoding)
  }
  if (inscr.delegate) {
    script.push('0B')
    script.push(inscr.delegate)
  }
  if (inscr.file_data) {
    script.push('OP_0')
    for (let i = 0; i < inscr.file_data.length; i += 520) {
      script.push(inscr.file_data.subarray(i, i + 520))
    }
  }
  script.push('OP_ENDIF')

  return script
}

function build_reveal_script_multiple(
  pubkey: Buff,
  inscrs: InscriptionDetails[],
  postage: number,
): (string | Buff)[] {
  const script: (string | Buff)[] = [
    pubkey,
    'OP_CHECKSIG',
  ]
  let inscr_idx = 0
  for (const inscr of inscrs) {
    script.push('OP_0')
    script.push('OP_IF')
    script.push(Buff.str('ord'))
    if (inscr_idx !== 0) {
      script.push('02') // pointer
      script.push(Buff.num(inscr_idx * postage, undefined, 'le'))
    }
    if (inscr.mime_type) {
      script.push('01')
      script.push(inscr.mime_type)
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
    if (inscr.content_encoding) {
      script.push('09')
      script.push(inscr.content_encoding)
    }
    if (inscr.delegate) {
      script.push('0B')
      script.push(inscr.delegate)
    }
    if (inscr.file_data) {
      script.push('OP_0')
      for (let i = 0; i < inscr.file_data.length; i += 520) {
        script.push(inscr.file_data.subarray(i, i + 520))
      }
    }
    script.push('OP_ENDIF')

    inscr_idx++
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
function build_transaction(
  utxos_: UtxoInfo[],
  force_in_utxos: UtxoInfoWithWallet[],
  payer_wallet: WalletInfo,
  op_return_wallets: WalletInfo[],
  output_wallet: WalletInfo | null,
  change_wallet: WalletInfo,
  fee_rate: number,
  amount: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
): BuildTransactionResult {
  const utxos = utxos_.slice()

  utxos.sort((a: UtxoInfo, b: UtxoInfo) => a.value - b.value)
  const inputs: TxInput[] = []
  const outputs: TxOutput[] = []
  const op_return_szs = []

  for (let i = 0; i < op_return_wallets.length; i++) {
    if (op_return_wallets[i]!.is_op_return) {
      outputs.push({
        out_script: op_return_wallets[i]!.outputScript,
        value: 0,
      })
      op_return_szs.push(op_return_wallets[i]!.outputScript.length)
    }
    else {
      throw new Error('Invalid wallet type (one of op_return_wallets is not op_return)')
    }
  }
  if (output_wallet != null) {
    outputs.push({
      wallet: output_wallet,
      out_script: output_wallet.outputScript,
      value: 0,
    })
  }

  let uses_payment = false
  if (payment_wallet != null && payment != null && payment >= get_dust_value(payment_wallet)) {
    outputs.push({
      wallet: payment_wallet,
      out_script: payment_wallet.outputScript,
      value: 0,
    })
    amount += payment
    uses_payment = true
  }

  let total_output_amount = 0
  for (const utxo of force_in_utxos) { // TODO: these may also come from output_wallet (e.g. rune_mint)
    inputs.push({ utxo, wallet: utxo.wallet })
    total_output_amount += utxo.value
    for (let i = 0; i < utxos.length; i++) {
      if (utxos[i]!.utxo === utxo.utxo) {
        utxos.splice(i, 1)
        break
      }
    }
  }

  let fee = estimate_fee(inputs, outputs, fee_rate)
  while (total_output_amount < amount + fee) {
    let deficit = amount + fee - total_output_amount
    // const additional_fee = Math.ceil(is_payer_p2sh ? bis.ADDITIONAL_INPUT_P2SH_VBYTES : bis.ADDITIONAL_INPUT_P2TR_VBYTES) * fee_rate // TODO: fix here!!
    while (deficit > 0) {
      if (utxos.length === 0)
        throw new Error('Not enough funds')

      const lastUtxo = utxos[utxos.length - 1]!
      const requiredAmount = deficit + calc_additional_fee(lastUtxo.script_type, fee_rate)

      if (lastUtxo.value >= requiredAmount) {
        // First try to find a "good" UTXO (value > 10000)
        for (const utxo of utxos.filter(utxo => utxo.value > 10000)) {
          const needed = deficit + calc_additional_fee(utxo.script_type, fee_rate)
          if (utxo.value >= needed) {
            inputs.push({ utxo, wallet: payer_wallet })
            total_output_amount += utxo.value
            deficit = 0
            utxos.splice(utxos.indexOf(utxo), 1)
            break
          }
        }

        // Only if deficit is still not covered, try all UTXOs
        if (deficit > 0) {
          for (const utxo of utxos) {
            const needed = deficit + calc_additional_fee(utxo.script_type, fee_rate)
            if (utxo.value >= needed) {
              inputs.push({ utxo, wallet: payer_wallet })
              total_output_amount += utxo.value
              deficit = 0
              utxos.splice(utxos.indexOf(utxo), 1)
              break
            }
          }
        }
      }
      else {
        const benefit = utxos[utxos.length - 1]!.value - calc_additional_fee(utxos[utxos.length - 1]!.script_type, fee_rate)
        deficit -= benefit
        inputs.push({ utxo: utxos.pop()!, wallet: payer_wallet })
        total_output_amount += inputs[inputs.length - 1]!.utxo.value
      }
    }
  }

  const additional_output_fee = Math.ceil((change_wallet.outputScript.length) + 9) * fee_rate // TODO: fix here!! is it done???
  fee = estimate_fee(inputs, outputs, fee_rate)
  const excess = total_output_amount - fee - amount
  let fee_payer_output_idx = -1
  if (excess > get_dust_value(change_wallet) + additional_output_fee) { // we have enough to output to change
    const to_strip = total_output_amount - amount
    if (amount > 0) {
      outputs[op_return_szs.length]!.value = amount
      outputs.push({
        wallet: change_wallet,
        out_script: change_wallet.outputScript,
        value: to_strip,
      })
      fee_payer_output_idx = outputs.length - 1
    }
    else {
      outputs.push({
        wallet: change_wallet,
        out_script: change_wallet.outputScript,
        value: to_strip,
      })
      fee_payer_output_idx = outputs.length - 1
    }
  }
  else {
    if (output_wallet != null) {
      outputs[op_return_szs.length]!.value = total_output_amount
      fee_payer_output_idx = op_return_szs.length
    }
    else {
      fee_payer_output_idx = -1
    }
  }

  if (uses_payment) {
    if (payment == null)
      throw new Error('Payment is null')

    if (output_wallet != null) {
      outputs[op_return_szs.length]!.value -= payment
      outputs[op_return_szs.length + 1]!.value += payment
    }
    else {
      outputs[op_return_szs.length]!.value += payment
      total_output_amount -= payment
    }
  }

  // op_returns
  // output_wallet <- amount (+ possibly fees)
  // payment_wallet <- payment (may not exist)
  // change_wallet <- change (may not exist)

  fee = estimate_fee(inputs, outputs, fee_rate)
  if (fee_payer_output_idx === -1) {
    if (total_output_amount < fee) {
      throw new Error('Not enough funds to pay fee')
    }
  }
  else {
    const tempWallet = outputs[fee_payer_output_idx]!.wallet
    if (!tempWallet)
      throw new Error('Fee payer output does not exist')

    if (outputs[fee_payer_output_idx]!.value - fee < get_dust_value(tempWallet)) {
      throw new Error('Fee payer output cannot pay the fee')
    }
    outputs[fee_payer_output_idx]!.value -= fee
  }

  const final_tx = constructTxFromInOuts(inputs, outputs)
  let tx_fee = 0
  for (const input of inputs) {
    tx_fee += input.utxo.value
  }
  for (const output of outputs) {
    tx_fee -= output.value
  }

  return {
    tx: final_tx,
    tx_fee,
  }
}

interface TransactionInOuts {
  ins: { hash: Buffer, index: number }[]
  outs: { value: number, script: Buffer }[]
}
export async function build_psbt_from_tx(
  tx: TransactionInOuts,
  cardinal_utxos: UtxoInfo[],
  payer_wallet: WalletInfo,
  force_in_utxos: UtxoInfoWithWallet[],
): Promise<bitcoinjs.Psbt> {
  const network_type = getBitcoinNetwork()

  const res_psbt = new bitcoinjs.Psbt({ network: network_type })

  const will_be_added_sigs: { idx: number, signature: Buffer }[] = []
  for (const input of tx.ins) {
    // get corresponding cardinal utxo
    const utxo = `${input.hash.toString('hex')}:${input.index}`
    let utxo_obj = null
    let signer_wallet = payer_wallet
    for (const utxo_obj_ of cardinal_utxos) {
      if (utxo_obj_.utxo === utxo) {
        utxo_obj = utxo_obj_
        break
      }
    }
    if (utxo_obj == null && force_in_utxos) {
      for (const utxo_obj_ of force_in_utxos) {
        if (utxo_obj_.utxo === utxo) {
          utxo_obj = utxo_obj_
          signer_wallet = utxo_obj_.wallet
          break
        }
      }
    }
    if (utxo_obj == null)
      throw new Error('Cannot find utxo in cardinal_utxos')

    const txhex = await get_txhex(input.hash.toString('hex'))
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    for (const output in tx.outs) { // TODO: what tf this is doing man?!?
      try {
        tx.setWitness(Number.parseInt(output), [])
      }
      catch { }
    }

    if (utxo_obj.script_type === 'pubkeyhash') { // P2PKH
      if (signer_wallet.publicKey == null) {
        throw new Error('publicKey is null on p2pkh input')
      }

      res_psbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        // witnessUtxo: tx.outs[input.index],
        nonWitnessUtxo: tx.toBuffer(),
      })
    }
    else if (utxo_obj.script_type === 'scripthash') { // P2SH
      if (signer_wallet.getRedeemScript() == null) {
        throw new Error('Redeem script is null on p2sh input')
      }

      res_psbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        // witnessUtxo: tx.outs[input.index],
        nonWitnessUtxo: tx.toBuffer(),
        redeemScript: signer_wallet.getRedeemScript(),
      })
    }
    else if (utxo_obj.script_type === 'witness_v0_keyhash') { // P2WPKH
      if (signer_wallet.publicKey == null) {
        throw new Error('publicKey is null on p2wpkh input')
      }

      res_psbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witnessUtxo: tx.outs[input.index],
      })
    }
    else if (utxo_obj.script_type === 'witness_v0_scripthash') { // P2WSH
      if (signer_wallet.getRedeemScript() == null) {
        throw new Error('Redeem script is null on p2wsh input')
      }

      res_psbt.addInput({
        hash: input.hash.toString('hex'),
        index: input.index,
        sequence: ENABLE_RBF_NO_LOCKTIME,
        witnessUtxo: tx.outs[input.index],
        witnessScript: signer_wallet.getRedeemScript(), // TODO: is this correct??
      })
    }
    else if (utxo_obj.script_type === 'witness_v1_taproot') { // P2TR
      const witnessUtxo = tx.outs[input.index]
      if (utxo_obj.witnessUtxoScript != null) {
        witnessUtxo!.script = utxo_obj.witnessUtxoScript
      }

      let sequence = ENABLE_RBF_NO_LOCKTIME
      if (utxo_obj.sequence != null) {
        sequence = utxo_obj.sequence
      }

      if (!signer_wallet.publicKey)
        throw new Error('publicKey is null on p2tr input')

      if (utxo_obj.tapLeafScript == null) { // only add tapInternalKey if its key spend path
        res_psbt.addInput({
          hash: input.hash.toString('hex'),
          index: input.index,
          sequence,
          witnessUtxo,
          tapInternalKey: toXOnly(Buffer.from(signer_wallet.publicKey, 'hex')),
        })
      }
      else {
        res_psbt.addInput({
          hash: input.hash.toString('hex'),
          index: input.index,
          sequence,
          witnessUtxo,
          tapLeafScript: utxo_obj.tapLeafScript,
          // tapInternalKey: toXOnly(__Buffer.from(signer_wallet.publicKey, 'hex')),
          // NOTE: XVerse only works with no tapInternalKey!!
        })

        if (utxo_obj.finalScriptWitness != null) {
          will_be_added_sigs.push({ idx: res_psbt.inputCount - 1, signature: utxo_obj.finalScriptWitness })
        }
      }
    }
    else {
      throw new Error('unknown input')
    }
  }

  for (const output of tx.outs) {
    res_psbt.addOutput(output)
  }

  for (const sig of will_be_added_sigs) {
    res_psbt.updateInput(sig.idx, { finalScriptWitness: sig.signature })
  }

  return res_psbt
}

interface BuildCommitTxResult {
  unsigned_commit_tx: bitcoinjs.Transaction
  unsigned_psbt_hex: string
  output_value: number
  commit_fee: number
  reveal_fee: number
}
async function build_commit_tx(
  payer_wallet: WalletInfo,
  inscription_wallet: WalletInfo,
  secret: string,
  inscription_details: InscriptionDetails,
  fee_rate: number,
  postage: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
  force_in_utxos: UtxoInfoWithWallet[],
): Promise<BuildCommitTxResult> {
  if (payment == null || payment < 0)
    payment = 0
  const change_wallet = payer_wallet

  if (!payer_wallet.addr)
    throw new Error('Payer wallet address is not set.')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = build_reveal_script(pubkey, inscription_details)
  const tapleaf = Tap.encodeScript(script)

  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const network_type = getBitcoinNetwork()

  const commit_tx_address = bitcoinjs.payments.p2tr({ pubkey: Buffer.from(tpubkey, 'hex'), network: network_type })

  const dummy_reveal_vout = [{
    value: 0,
    scriptPubKey: inscription_wallet.outputScript,
  }]
  if (payment > 0) {
    if (!payment_wallet)
      throw new Error('Payment wallet is not available.')

    dummy_reveal_vout.push({
      value: 0,
      scriptPubKey: payment_wallet.outputScript,
    })
  }
  const dummy_reveal_tx = Tx.create({
    vin: [{
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
    }],
    vout: dummy_reveal_vout,
  })
  dummy_reveal_tx.vin[0]!.witness = [Buff.hex('00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'), script, cblock]

  const reveal_fee = Tx.util.getTxSize(dummy_reveal_tx).vsize * fee_rate // TODO: check new version: dummy_reveal_tx.virtualSize() * fee_rate

  // get change addr pk
  const commit_wallet = new WalletInfo(false, null, commit_tx_address.address, null, tpubkey)
  const unsigned_commit_tx_resp = build_transaction(cardinal_utxos, force_in_utxos, payer_wallet, [], commit_wallet, change_wallet, fee_rate, postage + reveal_fee + payment, null, null)
  const unsigned_commit_tx = unsigned_commit_tx_resp.tx
  const commit_fee = unsigned_commit_tx_resp.tx_fee

  // psbt test for commit tx
  const unsigned_commit_psbt = await build_psbt_from_tx(unsigned_commit_tx, cardinal_utxos, payer_wallet, force_in_utxos)

  return {
    unsigned_commit_tx,
    unsigned_psbt_hex: unsigned_commit_psbt.toHex(),
    output_value: unsigned_commit_tx.outs[0]!.value,
    commit_fee,
    reveal_fee,
  }
}

interface BuildCommitTxMultipleResult {
  unsigned_psbt_hex: string
  output_value: number
  commit_fee: number
  reveal_fee: number
}
async function build_commit_tx_multiple(
  payer_wallet: WalletInfo,
  inscription_wallet: WalletInfo,
  secret: string,
  inscription_details_array: InscriptionDetails[],
  fee_rate: number,
  postage: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
): Promise<BuildCommitTxMultipleResult> {
  if (!payment || payment < 0)
    payment = 0

  const change_wallet = payer_wallet
  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr as string)
  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)
  const script = build_reveal_script_multiple(pubkey, inscription_details_array, postage)
  const tapleaf = Tap.encodeScript(script)
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })
  const network_type = getBitcoinNetwork()
  const commit_tx_address = bitcoinjs.payments.p2tr({ pubkey: Buffer.from(tpubkey, 'hex'), network: network_type })

  const dummy_reveal_vout = []
  for (let i = 0; i < inscription_details_array.length; i++) {
    dummy_reveal_vout.push({
      value: 0,
      scriptPubKey: inscription_wallet.outputScript,
    })
  }
  if (payment && payment > 0) {
    dummy_reveal_vout.push({
      value: 0,
      scriptPubKey: payment_wallet?.outputScript,
    })
  }
  const dummy_reveal_tx = Tx.create({
    vin: [{
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
    }],
    vout: dummy_reveal_vout,
  })
  dummy_reveal_tx.vin[0]!.witness = [Buff.hex('00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'), script, cblock]

  const reveal_fee = Tx.util.getTxSize(dummy_reveal_tx).vsize * fee_rate // TODO: check new version: dummy_reveal_tx.virtualSize() * fee_rate

  // get change addr pk
  const commit_wallet = new WalletInfo(false, null, commit_tx_address.address, null, tpubkey)
  const unsigned_commit_tx_resp = build_transaction(cardinal_utxos, [], payer_wallet, [], commit_wallet, change_wallet, fee_rate, postage * inscription_details_array.length + reveal_fee + (payment || 0), null, null)
  const unsigned_commit_tx = unsigned_commit_tx_resp.tx
  const commit_fee = unsigned_commit_tx_resp.tx_fee

  // psbt test for commit tx
  const unsigned_commit_psbt = await build_psbt_from_tx(unsigned_commit_tx, cardinal_utxos, payer_wallet, [])

  return {
    unsigned_psbt_hex: unsigned_commit_psbt.toHex(),
    output_value: unsigned_commit_tx.outs[0]!.value,
    commit_fee,
    reveal_fee,
  }
}

interface BuildCommitTxWithParentResult {
  unsigned_psbt_hex: string
  output_value: number
  commit_fee: number
}
async function build_commit_tx_with_parent(
  payer_wallet: WalletInfo,
  inscription_wallet: WalletInfo,
  secret: string,
  inscription_details: InscriptionDetails,
  fee_rate: number,
  postage: number,
  parent_inscription_id: string,
): Promise<BuildCommitTxWithParentResult> {
  const change_wallet = payer_wallet
  const parent_inscription_id_buff = convertInscriptionIdToBuffer(parent_inscription_id)

  if (!payer_wallet.addr)
    throw new Error('Payer wallet address is not set.')

  if (!inscription_wallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const ordinal_utxos = await get_ordinal_utxos(inscription_wallet.addr)
  let parent_utxo = null
  for (const utxo of ordinal_utxos) {
    for (const inscr_id of utxo.inscription_ids) {
      if (inscr_id === parent_inscription_id) {
        parent_utxo = utxo
        break
      }
    }
    if (parent_utxo)
      break
  }
  if (!parent_utxo)
    throw new Error('Parent inscription utxo not found in ordinal utxos')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = build_reveal_script(pubkey, inscription_details, parent_inscription_id_buff)
  const tapleaf = Tap.encodeScript(script)

  const [tpubkey] = Tap.getPubKey(pubkey, { target: tapleaf })

  const network_type = getBitcoinNetwork()

  const commit_tx_address = bitcoinjs.payments.p2tr({ pubkey: Buffer.from(tpubkey, 'hex'), network: network_type })

  // get change addr pk
  const commit_wallet = new WalletInfo(false, null, commit_tx_address.address, null, tpubkey)
  const unsigned_commit_tx_resp = build_transaction(cardinal_utxos, [], payer_wallet, [], commit_wallet, change_wallet, fee_rate, postage, null, null)
  const unsigned_commit_tx = unsigned_commit_tx_resp.tx
  const commit_fee = unsigned_commit_tx_resp.tx_fee

  // psbt test for commit tx
  const unsigned_commit_psbt = await build_psbt_from_tx(unsigned_commit_tx, cardinal_utxos, payer_wallet, [])

  return {
    unsigned_psbt_hex: unsigned_commit_psbt.toHex(),
    output_value: unsigned_commit_tx.outs[0]!.value,
    commit_fee,
  }
}

export function build_transaction_multi_output(
  utxos_: UtxoInfo[],
  force_in_utxos: UtxoInfoWithWallet[],
  payer_wallet: WalletInfo,
  output_wallets: WalletInfo[],
  amounts: number[],
  change_wallet: WalletInfo,
  fee_rate: number,
): BuildTransactionResult {
  if (output_wallets.length !== amounts.length)
    throw new Error('output_wallets and amounts must have the same length')
  const utxos = utxos_.slice()

  utxos.sort((a: UtxoInfo, b: UtxoInfo) => a.value - b.value)
  const inputs = []
  const outputs = []

  for (let i = 0; i < output_wallets.length; i++) {
    outputs.push({
      wallet: output_wallets[i]!,
      out_script: output_wallets[i]!.outputScript,
      value: amounts[i]!,
    })
  }

  let total_target_amount = 0
  for (let i = 0; i < amounts.length; i++) {
    total_target_amount += amounts[i]!
  }

  let total_input_amount = 0
  for (const utxo of force_in_utxos) { // TODO: these may also come from output_wallet (e.g. rune_mint)
    inputs.push({ utxo, wallet: utxo.wallet })
    total_input_amount += utxo.value
    for (let i = 0; i < utxos.length; i++) {
      if (utxos[i]!.utxo === utxo.utxo) {
        utxos.splice(i, 1)
        break
      }
    }
  }

  let fee = estimate_fee(inputs, outputs, fee_rate)
  while (total_input_amount < total_target_amount + fee) {
    let deficit = total_target_amount + fee - total_input_amount
    // const additional_fee = Math.ceil(is_payer_p2sh ? bis.ADDITIONAL_INPUT_P2SH_VBYTES : bis.ADDITIONAL_INPUT_P2TR_VBYTES) * fee_rate // TODO: fix here!!
    while (deficit > 0) {
      if (utxos.length === 0)
        throw new Error('Not enough funds')

      const lastUtxo = utxos[utxos.length - 1]!
      const requiredAmount = deficit + calc_additional_fee(lastUtxo.script_type, fee_rate)

      if (lastUtxo.value >= requiredAmount) {
        // First try to find a "good" UTXO (value > 10000)
        for (const utxo of utxos.filter(utxo => utxo.value > 10000)) {
          const needed = deficit + calc_additional_fee(utxo.script_type, fee_rate)
          if (utxo.value >= needed) {
            inputs.push({ utxo, wallet: payer_wallet })
            total_input_amount += utxo.value
            deficit = 0
            utxos.splice(utxos.indexOf(utxo), 1)
            break
          }
        }

        // Only if deficit is still not covered, try all UTXOs
        if (deficit > 0) {
          for (const utxo of utxos) {
            const needed = deficit + calc_additional_fee(utxo.script_type, fee_rate)
            if (utxo.value >= needed) {
              inputs.push({ utxo, wallet: payer_wallet })
              total_input_amount += utxo.value
              deficit = 0
              utxos.splice(utxos.indexOf(utxo), 1)
              break
            }
          }
        }
      }
      else {
        const benefit = utxos[utxos.length - 1]!.value - calc_additional_fee(utxos[utxos.length - 1]!.script_type, fee_rate)
        deficit -= benefit
        inputs.push({ utxo: utxos.pop()!, wallet: payer_wallet })
        total_input_amount += inputs[inputs.length - 1]!.utxo.value
      }
    }
  }

  if (!change_wallet.outputScript)
    throw new Error('build_transaction_multi_output change_wallet.outputScript is null')

  const additional_change_output_fee = Math.ceil(change_wallet.outputScript.length + 9) * fee_rate // TODO: fix here!! is it done???
  fee = estimate_fee(inputs, outputs, fee_rate)
  const excess = total_input_amount - fee - total_target_amount
  let fee_payer_output_idx = -1
  if (excess > get_dust_value(change_wallet) + additional_change_output_fee) { // we have enough to output to change
    const to_strip = total_input_amount - total_target_amount
    outputs.push({
      wallet: change_wallet,
      out_script: change_wallet.outputScript,
      value: to_strip,
    })
    fee_payer_output_idx = outputs.length - 1
  }

  // op_returns
  // output_wallet <- amount (+ possibly fees)
  // payment_wallet <- payment (may not exist)
  // change_wallet <- change (may not exist)

  fee = estimate_fee(inputs, outputs, fee_rate)
  if (fee_payer_output_idx === -1) {
    if ((total_input_amount - total_target_amount) < fee) {
      throw new Error('Not enough funds to pay fee')
    }
  }
  else {
    if (outputs[fee_payer_output_idx]!.value - fee < get_dust_value(outputs[fee_payer_output_idx]!.wallet)) {
      throw new Error('Fee payer output cannot pay the fee')
    }
    outputs[fee_payer_output_idx]!.value -= fee
  }

  const final_tx = constructTxFromInOuts(inputs, outputs)
  let tx_fee = 0
  for (const input of inputs) {
    tx_fee += input.utxo.value
  }
  for (const output of outputs) {
    tx_fee -= output.value
  }

  return {
    tx: final_tx,
    tx_fee,
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
  inscription_ids: string[],
  target_postages: number[],
  target_addr: string,
  buffer_value: number,
  fee_rate: number,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
): Promise<SendMultiInscriptionWithBufferResult> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // set to null if 0
  if (payment === 0) {
    payment_addr = null
    payment = null
  }

  if (!Array.isArray(inscription_ids))
    throw new Error('inscription_ids must be an array')
  if (!Array.isArray(target_postages))
    throw new Error('target_postages must be an array')
  if (inscription_ids.length !== target_postages.length)
    throw new Error('inscription_ids and target_postages must have the same length')
  for (const tp of target_postages) {
    if (tp != null && (typeof tp != 'number' || !Number.isInteger(tp)))
      throw new Error('target_postages must be an array of integers or null')
  }
  for (const inscr_id of inscription_ids) {
    if (typeof inscr_id != 'string')
      throw new Error('inscription_ids must be an array of strings')
  }
  if (typeof fee_rate != 'number' || !Number.isInteger(fee_rate))
    throw new Error('fee_rate must be an integer')
  if (typeof buffer_value != 'number' || !Number.isInteger(buffer_value))
    throw new Error('buffer_value must be an integer')
  if (typeof target_addr != 'string')
    throw new Error('target_addr must be a string')
  if (typeof dry_run != 'boolean')
    throw new Error('dry_run must be a boolean')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer or null')
  if (payment_addr != null && typeof payment_addr != 'string')
    throw new Error('payment_addr must be a string or null')
  if (payment != null && payment_addr == null)
    throw new Error('payment_addr must be provided if payment is provided')
  if (payment == null && payment_addr != null)
    throw new Error('payment must be provided if payment_addr is provided')

  const target_wallet = new WalletInfo(false, null, target_addr, null, null)

  let payment_wallet = null
  if (payment != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
    if (payment < get_dust_value(payment_wallet))
      throw new Error('payment must be bigger than dust')
  }

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  return await send_multi_inscription_with_buffer_all(
    inscription_ids,
    target_postages,
    target_wallet,
    buffer_value,
    fee_rate,
    payment_wallet,
    payment,
    dry_run,
    signFn,
  )
}

async function send_multi_inscription_with_buffer_all(
  inscription_ids: string[],
  target_postages: number[],
  target_wallet: WalletInfo,
  buffer_value: number,
  fee_rate: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<SendMultiInscriptionWithBufferResult> {
  if (inscription_ids.length !== target_postages.length)
    throw new Error('inscription_ids and target_postages must have the same length')

  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payment_addr = paymentWallet.address
  const payment_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payment_addr, null, payment_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)

  const input_utxos: UtxoInfoWithWallet[] = []
  const target_wallets: WalletInfo[] = []
  const amounts: number[] = []
  const inscr_wallet_sign_idxes: number[] = []

  if (!inscription_wallet.addr)
    throw new Error('inscription_wallet is null')

  for (let i = 0; i < inscription_ids.length; i++) {
    const inscription_details = await get_inscription_details(inscription_ids[i]!, inscription_wallet.addr)
    if (inscription_details == null) {
      throw new Error('Inscription cannot be found in wallet')
    }
    if (inscription_details.satpoint.split(':')[2] !== '0') { // TODO: implement this case as well
      throw new Error('Inscription is at the first sat of utxo')
    }
    let target_postage = target_postages[i]!
    if (target_postage <= 0 || target_postage == null) {
      target_postage = inscription_details.value // NOTE: do not change the inscription_value
    }

    if (i !== inscription_ids.length - 1) {
      if (target_postage !== inscription_details.value) {
        throw new Error('All inscriptions except the last one must have the same output value')
      }
    }

    if (target_postage < get_dust_value(target_wallet)) {
      throw new Error('Target postage is below dust value')
    }

    const inscr_utxo = {
      utxo: `${inscription_details.satpoint.split(':')[0]}:${inscription_details.satpoint.split(':')[1]}`,
      value: inscription_details.value,
      script_type: inscription_details.script_type,
      wallet: inscription_wallet,
    }
    input_utxos.push(inscr_utxo)
    target_wallets.push(target_wallet)
    amounts.push(target_postage)
    inscr_wallet_sign_idxes.push(i)
  }
  target_wallets.push(target_wallet)
  amounts.push(buffer_value)
  if (payment != null) {
    target_wallets.push(payment_wallet as WalletInfo)
    amounts.push(payment)
  }

  if (!payer_wallet.addr)
    throw new Error('payer_wallet.addr is null')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  const unsigned_tx_resp = build_transaction_multi_output(cardinal_utxos, input_utxos, payer_wallet, target_wallets, amounts, payer_wallet, fee_rate)
  const unsigned_tx = unsigned_tx_resp.tx

  const unsigned_psbt = await build_psbt_from_tx(unsigned_tx, cardinal_utxos, payer_wallet, input_utxos)
  const unsigned_psbt_hex = unsigned_psbt.toHex()

  const signed_tx = await sign_func(unsigned_psbt_hex, payer_wallet.addr, inscription_wallet.addr, inscr_wallet_sign_idxes)

  const isValid = await check_txes([signed_tx.signed_tx_hex])
  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  const output_utxos: string[] = []
  const output_values: number[] = []
  let buffer_utxo: string | null = null
  let buffer_output_value: number | null = null
  for (let i = 0; i < inscription_ids.length; i++) {
    output_utxos.push(`${signed_tx.txid}:${i}`)
    output_values.push(unsigned_tx.outs[i]!.value)
  }
  buffer_utxo = `${signed_tx.txid}:${inscription_ids.length}`
  buffer_output_value = unsigned_tx.outs[inscription_ids.length]!.value

  if (dry_run) {
    // TODO: hacky part, change or remove
    txHexByIdCache[signed_tx.txid] = signed_tx.signed_tx_hex
    return {
      txid: signed_tx.txid,
      signed_tx_hex: signed_tx.signed_tx_hex,
      output_utxos,
      output_values,
      buffer_utxo,
      buffer_output_value,
    }
  }

  await broadcast_txes([signed_tx.signed_tx_hex])

  return {
    txid: signed_tx.txid,
    signed_tx_hex: signed_tx.signed_tx_hex,
    output_utxos,
    output_values,
    buffer_utxo,
    buffer_output_value,
  }
}

interface SendInscriptionAllResult {
  txid: string
  signed_tx_hex: string
  vout: number
  output_value: number
}
export async function send_inscription_all(
  inscription_id: string,
  target_wallet: WalletInfo,
  target_postage: number | null,
  fee_rate: number,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<SendInscriptionAllResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payment_addr = paymentWallet.address
  const payment_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payment_addr, null, payment_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)

  if (!inscription_wallet.addr)
    throw new Error('inscription_wallet is null')

  const inscription_details = await get_inscription_details(inscription_id, inscription_wallet.addr)
  if (inscription_details == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscription_details.satpoint.split(':')[2] !== '0') { // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payer_wallet.addr)
    throw new Error('payer_wallet.addr is null')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  if (target_postage == null || target_postage <= 0) {
    target_postage = get_dust_value(target_wallet)
  }

  const inscr_utxo: UtxoInfoWithWallet = {
    utxo: `${inscription_details.satpoint.split(':')[0]}:${inscription_details.satpoint.split(':')[1]}`,
    value: inscription_details.value,
    script_type: inscription_details.script_type,
    wallet: inscription_wallet,
  }

  const unsigned_tx_resp = build_transaction(cardinal_utxos, [inscr_utxo], payer_wallet, [], target_wallet, payer_wallet, fee_rate, target_postage, null, null)
  const unsigned_tx = unsigned_tx_resp.tx

  const unsigned_psbt = await build_psbt_from_tx(unsigned_tx, cardinal_utxos, payer_wallet, [inscr_utxo])
  const unsigned_psbt_hex = unsigned_psbt.toHex()

  const signed_tx = await sign_func(unsigned_psbt_hex, payer_wallet.addr, inscription_wallet.addr, [0])

  const isValid = await check_txes([signed_tx.signed_tx_hex])
  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    txHexByIdCache[signed_tx.txid] = signed_tx.signed_tx_hex
    return {
      txid: signed_tx.txid,
      signed_tx_hex: signed_tx.signed_tx_hex,
      vout: 0,
      output_value: unsigned_tx.outs[0]!.value,
    }
  }

  await broadcast_txes([signed_tx.signed_tx_hex])

  return {
    txid: signed_tx.txid,
    signed_tx_hex: signed_tx.signed_tx_hex,
    vout: 0,
    output_value: unsigned_tx.outs[0]!.value,
  }
}

interface InscriptionUTXODetails {
  satpoint: string
  value: number
  script_type: 'pubkeyhash' | 'scripthash' | 'witness_v0_keyhash' | 'witness_v0_scripthash' | 'witness_v1_taproot' | 'pubkey' | 'anchor' | 'witness_unknown' | 'nulldata' | 'multisig' | 'nonstandard'
  block_height: number | null
  utxo: string
}
async function get_inscription_details(
  inscription_id: string,
  inscription_addr: string,
  ordinal_utxos?: APIOrdinalUtxoInfo[],
): Promise<InscriptionUTXODetails | null> {
  let utxos = null
  if (ordinal_utxos) {
    utxos = ordinal_utxos
  }
  else {
    utxos = await get_ordinal_utxos(inscription_addr)
  }

  for (const utxo of utxos) {
    for (let i = 0; i < utxo.inscription_ids.length; i++) {
      if (utxo.inscription_ids[i]! === inscription_id) {
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

async function send_multi_inscription_with_buffer_fee_rate_all(
  inscription_ids: string[],
  target_postages: number[],
  target_wallet: WalletInfo,
  buffer_value: number,
  fee_rate: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
): Promise<number> {
  if (inscription_ids.length !== target_postages.length)
    throw new Error('inscription_ids and target_postages must have the same length')

  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payment_addr = paymentWallet.address
  const payment_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payment_addr, null, payment_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)

  const input_utxos: UtxoInfoWithWallet[] = []
  const target_wallets: WalletInfo[] = []
  const amounts: number[] = []
  const inscr_wallet_sign_idxes: number[] = []

  if (!inscription_wallet.addr)
    throw new Error('Inscription wallet address is not set.')

  for (let i = 0; i < inscription_ids.length; i++) {
    const inscription_details = await get_inscription_details(inscription_ids[i]!, inscription_wallet.addr)
    if (inscription_details == null) {
      throw new Error('Inscription cannot be found in wallet')
    }
    if (inscription_details.satpoint.split(':')[2] !== '0') { // TODO: implement this case as well
      throw new Error('Inscription is at the first sat of utxo')
    }
    let target_postage = target_postages[i]!
    if (target_postage <= 0 || target_postage == null) {
      target_postage = inscription_details.value // NOTE: do not change the inscription_value
    }

    if (i !== inscription_ids.length - 1) {
      if (target_postage !== inscription_details.value) {
        throw new Error('All inscriptions except the last one must have the same output value')
      }
    }

    if (target_postage < get_dust_value(target_wallet)) {
      throw new Error('Target postage is below dust value')
    }

    const inscr_utxo: UtxoInfoWithWallet = {
      utxo: `${inscription_details.satpoint.split(':')[0]}:${inscription_details.satpoint.split(':')[1]}`,
      value: inscription_details.value,
      script_type: inscription_details.script_type,
      wallet: inscription_wallet,
    }
    input_utxos.push(inscr_utxo)
    target_wallets.push(target_wallet)
    amounts.push(target_postage)
    inscr_wallet_sign_idxes.push(i)
  }
  target_wallets.push(target_wallet)
  amounts.push(buffer_value)
  if (payment != null) {
    target_wallets.push(payment_wallet as WalletInfo)
    amounts.push(payment)
  }

  if (!payer_wallet.addr)
    throw new Error('payer_wallet.addr is null')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  const unsigned_tx_resp = build_transaction_multi_output(cardinal_utxos, input_utxos, payer_wallet, target_wallets, amounts, payer_wallet, fee_rate)
  return unsigned_tx_resp.tx_fee
}

// send_multi_inscription_with_buffer_fee_rate
export async function getMultiInscriptionWithBufferFeeRate(
  inscription_ids: string[],
  target_postages: number[],
  target_addr: string,
  buffer_value: number,
  fee_rate: number,
  payment_addr: string | null,
  payment: number | null,
): Promise<number> {
  if (payment === 0) {
    payment_addr = null
    payment = null
  }

  if (!Array.isArray(inscription_ids))
    throw new Error('inscription_ids must be an array')
  if (!Array.isArray(target_postages))
    throw new Error('target_postages must be an array')
  if (inscription_ids.length !== target_postages.length)
    throw new Error('inscription_ids and target_postages must have the same length')
  for (const tp of target_postages) {
    if (tp != null && (typeof tp != 'number' || !Number.isInteger(tp)))
      throw new Error('target_postages must be an array of integers or null')
  }
  for (const inscr_id of inscription_ids) {
    if (typeof inscr_id != 'string')
      throw new Error('inscription_ids must be an array of strings')
  }
  if (typeof fee_rate != 'number' || !Number.isInteger(fee_rate))
    throw new Error('fee_rate must be an integer')
  if (typeof buffer_value != 'number' || !Number.isInteger(buffer_value))
    throw new Error('buffer_value must be an integer')
  if (typeof target_addr != 'string')
    throw new Error('target_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer or null')
  if (payment_addr != null && typeof payment_addr != 'string')
    throw new Error('payment_addr must be a string or null')
  if (payment != null && payment_addr == null)
    throw new Error('payment_addr must be provided if payment is provided')
  if (payment == null && payment_addr != null)
    throw new Error('payment must be provided if payment_addr is provided')

  const target_wallet = new WalletInfo(false, null, target_addr, null, null)

  let payment_wallet = null
  if (payment != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
    if (payment < get_dust_value(payment_wallet))
      throw new Error('payment must be bigger than dust')
  }

  return await send_multi_inscription_with_buffer_fee_rate_all(inscription_ids, target_postages, target_wallet, buffer_value, fee_rate, payment_wallet, payment)
}

async function build_reveal_tx(
  inscription_wallet: WalletInfo,
  commit_txid: string,
  commit_output_value: number,
  secret: string,
  inscription_details: InscriptionDetails,
  _fee_rate: number, /* NOTE: UNUSED */
  postage: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
): Promise<SignResponse> {
  if (payment == null || payment < 0)
    payment = 0

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = build_reveal_script(pubkey, inscription_details)
  const tapleaf = Tap.encodeScript(script)

  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })

  const inputs = [{
    txid: commit_txid,
    vout: 0,
  }]

  const txdata_vout = [{
    value: postage,
    scriptPubKey: inscription_wallet.outputScript,
  }]
  if (payment > 0) {
    if (!payment_wallet)
      throw new Error('Payment wallet is not available.')

    txdata_vout.push({
      value: payment,
      scriptPubKey: payment_wallet.outputScript,
    })
  }
  const txdata = Tx.create({
    vin: [{
      // Use the txid of the funding transaction used to send the sats.
      txid: inputs[0]!.txid,
      // Specify the index value of the output that you are going to spend from.
      vout: inputs[0]!.vout,
      // Also include the value and script of that ouput.
      prevout: {
        // Feel free to change this if you sent a different amount.
        value: commit_output_value,
        // This is what our address looks like in script form.
        scriptPubKey: ['OP_1', tpubkey],
      },
    }],
    vout: txdata_vout,
  })

  const sig = Signer.taproot.sign(seckey, txdata, 0, { extension: tapleaf })
  txdata.vin[0]!.witness = [sig, script, cblock]

  const isValid = Signer.taproot.verify(txdata, 0, { pubkey, throws: true })
  if (!isValid)
    throw new Error('Invalid signature')

  return {
    txid: Tx.util.getTxid(txdata),
    signed_tx_hex: Tx.encode(txdata).hex,
  }
}

interface BuildRevealTxWithParentResult {
  txid: string
  partially_signed_psbt_hex: string
}
async function build_reveal_tx_with_parent(
  payer_wallet: WalletInfo,
  inscription_wallet: WalletInfo,
  commit_txid: string,
  commit_output_value: number,
  secret: string,
  inscription_details: InscriptionDetails,
  parent_inscription_id: string,
  fee_rate: number,
  payment_wallet: WalletInfo | null,
  payment: number | null,
): Promise<BuildRevealTxWithParentResult> {
  if (payment == null || payment < 0)
    payment = 0
  const change_wallet = payer_wallet
  const parent_inscription_id_buff = convertInscriptionIdToBuffer(parent_inscription_id)

  if (!inscription_wallet.addr)
    throw new Error('Inscription wallet address is not set.')
  if (!payer_wallet.addr)
    throw new Error('Payer wallet address is not set.')

  const ordinal_utxos = await get_ordinal_utxos(inscription_wallet.addr)
  let parent_utxo = null
  for (const utxo of ordinal_utxos) {
    for (const inscr_id of utxo.inscription_ids) {
      if (inscr_id === parent_inscription_id) {
        parent_utxo = utxo
        break
      }
    }
    if (parent_utxo)
      break
  }
  if (!parent_utxo)
    throw new Error('Parent inscription utxo not found in ordinal utxos')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  const seckey = get_seckey(secret)
  const pubkey = get_pubkey(seckey, true)

  const script = build_reveal_script(pubkey, inscription_details, parent_inscription_id_buff)

  const scriptBuf = Buffer.from(Script.encode(script, false))

  const tapleaf = Tap.encodeScript(script)

  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf })
  const tapLeafScript = {
    leafVersion: 192,
    script: scriptBuf,
    controlBlock: Buffer.from(cblock, 'hex'),
  }

  const network_type = getBitcoinNetwork()
  const commit_tx_address = bitcoinjs.payments.p2tr({ pubkey: Buffer.from(tpubkey, 'hex'), network: network_type })

  const commit_wallet = new WalletInfo(false, null, commit_tx_address.address, null, tpubkey)
  const utxos = cardinal_utxos.slice()
  utxos.sort((a, b) => a.value - b.value)

  const inputs: TxInput[] = [
    {
      utxo: {
        script_type: 'witness_v1_taproot',
        utxo: `${commit_txid}:0`,
        tapLeafScript: [{
          leafVersion: 192,
          script: scriptBuf,
          controlBlock: Buffer.from(cblock, 'hex'),
        }],
        value: commit_output_value,
      },
      wallet: commit_wallet,
    },
    {
      utxo: {
        script_type: 'witness_v1_taproot',
        utxo: `${parent_utxo.txid}:${parent_utxo.vout}`,
        value: parent_utxo.value,
      },
      wallet: inscription_wallet,
    },
  ]
  const outputs: TxOutput[] = [
    {
      out_script: inscription_wallet.outputScript,
      value: commit_output_value,
    },
    {
      out_script: inscription_wallet.outputScript,
      value: parent_utxo.value,
    },
  ]
  if (payment > 0) {
    if (!payment_wallet)
      throw new Error('Payment wallet is not available.')

    outputs.push({
      out_script: payment_wallet.outputScript,
      value: payment,
    })
  }

  let fee = estimate_fee(inputs, outputs, fee_rate)
  let current_miner_fee = -payment
  while (current_miner_fee < fee) {
    let deficit = fee - current_miner_fee
    while (deficit > 0) {
      if (utxos.length === 0)
        throw new Error('Not enough funds')

      if (utxos[utxos.length - 1]!.value >= deficit + calc_additional_fee(utxos[utxos.length - 1]!.script_type, fee_rate)) {
        for (const utxo of utxos.filter(utxo => utxo.value > 10000)) {
          if (utxo.value >= deficit + calc_additional_fee(utxo.script_type, fee_rate)) {
            inputs.push({ utxo, wallet: payer_wallet })
            current_miner_fee += utxo.value
            deficit = 0
            utxos.splice(utxos.indexOf(utxo), 1)
            break
          }
        }
        if (deficit > 0) {
          for (const utxo of utxos) {
            if (utxo.value >= deficit + calc_additional_fee(utxo.script_type, fee_rate)) {
              inputs.push({ utxo, wallet: payer_wallet })
              current_miner_fee += utxo.value
              deficit = 0
              utxos.splice(utxos.indexOf(utxo), 1)
              break
            }
          }
        }
      }
      else {
        const benefit = utxos[utxos.length - 1]!.value - calc_additional_fee(utxos[utxos.length - 1]!.script_type, fee_rate)
        deficit -= benefit
        const utxo = utxos.pop()!
        inputs.push({ utxo, wallet: payer_wallet })
        current_miner_fee += utxo.value
      }
    }
    fee = estimate_fee(inputs, outputs, fee_rate)
  }

  if (!change_wallet.outputScript)
    throw new Error('Change wallet output script is not set.')

  const change_output_fee = Math.ceil(change_wallet.outputScript.length + 9) * fee_rate
  const minimum_change = get_dust_value(change_wallet)
  const excess = current_miner_fee - fee

  if (excess > minimum_change + change_output_fee) {
    const change_value = excess - change_output_fee
    outputs.push({
      out_script: change_wallet.outputScript,
      value: change_value,
    })
    current_miner_fee -= change_value
  }

  fee = estimate_fee(inputs, outputs, fee_rate)
  if (current_miner_fee < fee) {
    throw new Error('Not enough funds to cover the fee')
  }

  if (!inscription_wallet.outputScript)
    throw new Error('Inscription wallet output script is not set.')

  const txdata_vin = [{
    txid: commit_txid,
    vout: 0,
    prevout: {
      value: commit_output_value,
      scriptPubKey: ['OP_1', tpubkey],
    },
  }, {
    txid: parent_utxo.txid,
    vout: parent_utxo.vout,
    prevout: {
      value: parent_utxo.value,
      scriptPubKey: inscription_wallet.outputScript,
    },
  }]

  const txdata_vout = [{
    value: commit_output_value,
    scriptPubKey: inscription_wallet.outputScript,
  }, {
    value: parent_utxo.value,
    scriptPubKey: inscription_wallet.outputScript,
  }]
  if (payment > 0) {
    if (!payment_wallet)
      throw new Error('Payment wallet is not available.')
    if (!payment_wallet.outputScript)
      throw new Error('Payment wallet output script is not set.')

    txdata_vout.push({
      value: payment,
      scriptPubKey: payment_wallet.outputScript,
    })
  }

  for (let i = txdata_vin.length; i < inputs.length; i++) {
    const input = inputs[i]!
    const utxo = input.utxo
    const txid = utxo.utxo.split(':')[0]!
    const vout = Number.parseInt(utxo.utxo.split(':')[1]!)
    const wallet = input.wallet

    if (!wallet.outputScript)
      throw new Error('Input wallet output script is not set.')

    txdata_vin.push({
      txid,
      vout,
      prevout: {
        value: utxo.value,
        scriptPubKey: wallet.outputScript,
      },
    })
  }
  for (let i = txdata_vout.length; i < outputs.length; i++) {
    const output = outputs[i]!
    const scriptPubKey = output.out_script
    const value = output.value

    if (!scriptPubKey)
      throw new Error('Output script is not set.')

    txdata_vout.push({
      value,
      scriptPubKey,
    })
  }

  const txdata = Tx.create({
    vin: txdata_vin,
    vout: txdata_vout,
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

  const force_in_utxos: UtxoInfoWithWallet[] = [
    {
      utxo: `${commit_txid}:0`,
      script_type: 'witness_v1_taproot',
      witnessUtxoScript: commit_wallet.outputScript,
      sequence: undefined,
      tapLeafScript: [tapLeafScript],
      finalScriptWitness,
      wallet: commit_wallet,
      value: commit_output_value,
    },
    {
      utxo: `${parent_utxo.txid}:${parent_utxo.vout}`,
      script_type: 'witness_v1_taproot',
      witnessUtxoScript: inscription_wallet.outputScript,
      sequence: undefined,
      tapLeafScript: undefined,
      finalScriptWitness: undefined,
      wallet: inscription_wallet,
      value: parent_utxo.value,
    },
  ]

  const partially_signed_psbt = await build_psbt_from_tx(tx, cardinal_utxos, payer_wallet, force_in_utxos)
  return {
    txid: Tx.util.getTxid(txdata),
    partially_signed_psbt_hex: partially_signed_psbt.toHex(),
  }
}

export async function mint_all(
  inscription_details: InscriptionDetails,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
  sign_func: SignFunction,
) {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(inscription_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx(payer_wallet, inscription_wallet, secret, inscription_details, fee_rate, postage, payment_wallet, payment, [])
  const signed_commit_tx = await sign_func(commit_tx.unsigned_psbt_hex, payer_addr, inscription_address, [])

  const commit_txid = signed_commit_tx.txid
  const reveal_tx = await build_reveal_tx(inscription_wallet, commit_txid, commit_tx.output_value, secret, inscription_details, fee_rate, postage, payment_wallet, payment)

  const isValid = await check_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    return {
      commit_txid: signed_commit_tx.txid,
      signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
      reveal_txid: reveal_tx.txid,
      signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
      inscription_id: `${reveal_tx.txid}i0`,
      postage,
      secret,
    }
  }

  await broadcast_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_tx_hex])
  return {
    commit_txid: signed_commit_tx.txid,
    signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
    reveal_txid: reveal_tx.txid,
    signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
    inscription_id: `${reveal_tx.txid}i0`,
    postage,
    secret,
  }
}

interface InscribeResult {
  commit_txid: string
  signed_commit_tx_hex: string
  reveal_txid: string
  signed_reveal_tx_hex: string
  inscription_id: string
  postage: number
  secret: string
}
export async function mint_all_payment_wallet(
  inscription_details: InscriptionDetails,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<InscribeResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(payer_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx(payer_wallet, payer_wallet, secret, inscription_details, fee_rate, postage, payment_wallet, payment, [])
  const signed_commit_tx = await sign_func(commit_tx.unsigned_psbt_hex, payer_addr, inscription_address, [])

  const commit_txid = signed_commit_tx.txid
  const reveal_tx = await build_reveal_tx(payer_wallet, commit_txid, commit_tx.output_value, secret, inscription_details, fee_rate, postage, payment_wallet, payment)

  const isValid = await check_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    return {
      commit_txid: signed_commit_tx.txid,
      signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
      reveal_txid: reveal_tx.txid,
      signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
      inscription_id: `${reveal_tx.txid}i0`,
      postage,
      secret,
    }
  }

  await broadcast_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_tx_hex])
  return {
    commit_txid: signed_commit_tx.txid,
    signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
    reveal_txid: reveal_tx.txid,
    signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
    inscription_id: `${reveal_tx.txid}i0`,
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
export async function mint_all_check_fees(
  inscription_details: InscriptionDetails,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
): Promise<InscribeCheckFeesResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(inscription_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx(payer_wallet, inscription_wallet, secret, inscription_details, fee_rate, postage, payment_wallet, payment, [])
  const dummy_commit_txid = commit_tx.unsigned_commit_tx.getId()
  const reveal_tx = await build_reveal_tx(inscription_wallet, dummy_commit_txid, commit_tx.output_value, secret, inscription_details, fee_rate, postage, payment_wallet, payment)

  return {
    commit_fee: commit_tx.commit_fee,
    reveal_fee: commit_tx.reveal_fee,
    total_fee: commit_tx.commit_fee + commit_tx.reveal_fee,
    unsigned_commit_tx_hex: commit_tx.unsigned_commit_tx.toHex(),
    signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
    inscription_id: `${reveal_tx.txid}i0`,
    postage,
  }
}

export async function send_inscription_to_op_return_all(
  inscription_id: string,
  target_wallet: WalletInfo,
  target_postage: number,
  fee_rate: number,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<SignResponse> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payment_addr = paymentWallet.address
  const payment_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payment_addr, null, payment_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)

  if (!inscription_wallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscription_details = await get_inscription_details(inscription_id, inscription_wallet.addr)
  if (inscription_details == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscription_details.satpoint.split(':')[2] !== '0') { // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payer_wallet.addr)
    throw new Error('Payer wallet address is not set.')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  if (target_postage <= 0 || target_postage == null) {
    target_postage = 1 // 1 sat for inscription
  }

  const inscr_utxo: UtxoInfoWithWallet = {
    utxo: `${inscription_details.satpoint.split(':')[0]}:${inscription_details.satpoint.split(':')[1]}`,
    value: inscription_details.value,
    script_type: inscription_details.script_type,
    wallet: inscription_wallet,
  }

  const unsigned_tx_resp = build_transaction(cardinal_utxos, [inscr_utxo], payer_wallet, [], target_wallet, payer_wallet, fee_rate, target_postage, null, null)
  const unsigned_tx = unsigned_tx_resp.tx

  const unsigned_psbt = await build_psbt_from_tx(unsigned_tx, cardinal_utxos, payer_wallet, [inscr_utxo])
  const unsigned_psbt_hex = unsigned_psbt.toHex()

  const signed_tx = await sign_func(unsigned_psbt_hex, payer_wallet.addr, inscription_wallet.addr, [0])

  const isValid = await check_txes([signed_tx.signed_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    return signed_tx
  }

  await broadcast_txes([signed_tx.signed_tx_hex])

  return signed_tx
}

export async function send_inscription_in_payment_wallet_to_op_return_all(
  inscription_id: string,
  target_wallet: WalletInfo,
  target_postage: number,
  fee_rate: number,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<SignResponse> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payment_addr = paymentWallet.address
  const payment_public_key = paymentWallet.pubkey
  const inscription_addr = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payment_addr, null, payment_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_addr, null, inscription_public_key)

  if (!payer_wallet.addr)
    throw new Error('Payment wallet address is not set.')
  if (!inscription_wallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscription_details = await get_inscription_details(inscription_id, payer_wallet.addr)
  if (inscription_details == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscription_details.satpoint.split(':')[2] !== '0') { // TODO: implement this case as well
    throw new Error('Inscription is at the first sat of utxo')
  }

  if (!payer_wallet.addr)
    throw new Error('Payer wallet address is not set.')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  if (target_postage <= 0 || target_postage == null) {
    target_postage = 1 // 1 sat for inscription
  }

  const inscr_utxo: UtxoInfoWithWallet = {
    utxo: `${inscription_details.satpoint.split(':')[0]}:${inscription_details.satpoint.split(':')[1]}`,
    value: inscription_details.value,
    script_type: inscription_details.script_type,
    wallet: payer_wallet,
  }

  const unsigned_tx_resp = build_transaction(cardinal_utxos, [inscr_utxo], payer_wallet, [], target_wallet, payer_wallet, fee_rate, target_postage, null, null)
  const unsigned_tx = unsigned_tx_resp.tx

  const unsigned_psbt = await build_psbt_from_tx(unsigned_tx, cardinal_utxos, payer_wallet, [inscr_utxo])
  const unsigned_psbt_hex = unsigned_psbt.toHex()

  const signed_tx = await sign_func(unsigned_psbt_hex, payer_wallet.addr, inscription_wallet.addr, [])

  const isValid = await check_txes([signed_tx.signed_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    return signed_tx
  }

  await broadcast_txes([signed_tx.signed_tx_hex])
  return signed_tx
}

export async function mint_with_parent_all(
  inscription_details: InscriptionDetails,
  parent_inscription_id: string,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<InscribeResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(inscription_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx_with_parent(payer_wallet, inscription_wallet, secret, inscription_details, fee_rate, postage, parent_inscription_id)
  const signed_commit_tx = await sign_func(commit_tx.unsigned_psbt_hex, payer_addr, inscription_address, [])

  const commit_txid = signed_commit_tx.txid
  let signed_reveal_tx = null
  try {
    save_extra_utxos([signed_commit_tx.signed_tx_hex], ['0000000000000000000000000000000000000000000000000000000000000000i0', `${commit_txid}:0:0`])
    const reveal_tx = await build_reveal_tx_with_parent(payer_wallet, inscription_wallet, commit_txid, commit_tx.output_value, secret, inscription_details, parent_inscription_id, fee_rate, payment_wallet, payment)

    signed_reveal_tx = await sign_func(reveal_tx.partially_signed_psbt_hex, payer_addr, inscription_address, [1], undefined, [0])
  }
  finally {
    clear_extra_utxos()
  }

  const isValid = await check_txes([signed_commit_tx.signed_tx_hex, signed_reveal_tx.signed_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    return {
      commit_txid: signed_commit_tx.txid,
      signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
      reveal_txid: signed_reveal_tx.txid,
      signed_reveal_tx_hex: signed_reveal_tx.signed_tx_hex,
      inscription_id: `${signed_reveal_tx.txid}i0`,
      postage,
      secret,
    }
  }
  await broadcast_txes([signed_commit_tx.signed_tx_hex, signed_reveal_tx.signed_tx_hex])
  return {
    commit_txid: signed_commit_tx.txid,
    signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
    reveal_txid: signed_reveal_tx.txid,
    signed_reveal_tx_hex: signed_reveal_tx.signed_tx_hex,
    inscription_id: `${signed_reveal_tx.txid}i0`,
    postage,
    secret,
  }
}

interface OutputUtxoInfo {
  wallet: WalletInfo
  value: number
}
export async function send_inscription_to_op_return_with_extra_inputs_and_extra_output_all(
  inscription_id: string,
  extra_input_utxos: UtxoInfoWithWallet[],
  target_wallet: WalletInfo,
  target_postage: number,
  extra_output_utxos: OutputUtxoInfo[],
  fee_rate: number,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<SignResponse> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)

  if (!inscription_wallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscription_details = await get_inscription_details(inscription_id, inscription_wallet.addr)
  if (inscription_details == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscription_details.satpoint.split(':')[2] !== '0') {
    throw new Error('Inscription is not at the first sat of utxo')
  }

  if (!payer_wallet.addr)
    throw new Error('Payer wallet address is not set.')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  if (target_postage <= 0 || target_postage == null) {
    target_postage = 1 // 1 sat for inscription
  }

  const inscr_utxo: UtxoInfoWithWallet = {
    utxo: `${inscription_details.satpoint.split(':')[0]}:${inscription_details.satpoint.split(':')[1]}`,
    value: inscription_details.value,
    script_type: inscription_details.script_type,
    wallet: inscription_wallet,
  }
  const extra_utxo_objs: UtxoInfoWithWallet[] = [inscr_utxo]
  for (const extra_input of extra_input_utxos) {
    extra_utxo_objs.push(extra_input)
  }

  const output_wallets: WalletInfo[] = [target_wallet]
  const amounts: number[] = [target_postage]
  for (const extra_output of extra_output_utxos) {
    output_wallets.push(extra_output.wallet)
    amounts.push(extra_output.value)
  }

  const unsigned_tx_resp = build_transaction_multi_output(cardinal_utxos, extra_utxo_objs, payer_wallet, output_wallets, amounts, payer_wallet, fee_rate)
  const unsigned_tx = unsigned_tx_resp.tx

  const unsigned_psbt = await build_psbt_from_tx(unsigned_tx, cardinal_utxos, payer_wallet, extra_utxo_objs)
  const unsigned_psbt_hex = unsigned_psbt.toHex()

  const signed_tx = await sign_func(unsigned_psbt_hex, payer_wallet.addr, inscription_wallet.addr, [0])

  const isValid = await check_txes([signed_tx.signed_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    return {
      txid: signed_tx.txid,
      signed_tx_hex: signed_tx.signed_tx_hex,
    }
  }

  await broadcast_txes([signed_tx.signed_tx_hex])
  return {
    txid: signed_tx.txid,
    signed_tx_hex: signed_tx.signed_tx_hex,
  }
}

interface SendInscriptionFeeRateResult {
  txid: string
  unsigned_tx_hex: string
  tx_fee: number
}
export async function send_inscription_to_op_return_with_extra_inputs_and_extra_output_fee_rate(
  inscription_id: string,
  extra_input_utxos: UtxoInfoWithWallet[],
  target_wallet: WalletInfo,
  target_postage: number,
  extra_output_utxos: OutputUtxoInfo[],
  fee_rate: number,
): Promise<SendInscriptionFeeRateResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)

  if (!inscription_wallet.addr)
    throw new Error('Inscription wallet address is not set.')

  const inscription_details = await get_inscription_details(inscription_id, inscription_wallet.addr)
  if (inscription_details == null) {
    throw new Error('Inscription cannot be found in wallet')
  }
  if (inscription_details.satpoint.split(':')[2] !== '0') {
    throw new Error('Inscription is not at the first sat of utxo')
  }

  if (!payer_wallet.addr)
    throw new Error('Payer wallet address is not set.')

  const cardinal_utxos = await get_cardinal_utxos(payer_wallet.addr)

  if (target_postage <= 0 || target_postage == null) {
    target_postage = 1 // 1 sat for inscription
  }

  const inscr_utxo: UtxoInfoWithWallet = {
    utxo: `${inscription_details.satpoint.split(':')[0]}:${inscription_details.satpoint.split(':')[1]}`,
    value: inscription_details.value,
    script_type: inscription_details.script_type,
    wallet: inscription_wallet,
  }
  const extra_utxo_objs: UtxoInfoWithWallet[] = [inscr_utxo]
  for (const extra_input of extra_input_utxos) {
    extra_utxo_objs.push(extra_input)
  }

  const output_wallets: WalletInfo[] = [target_wallet]
  const amounts: number[] = [target_postage]
  for (const extra_output of extra_output_utxos) {
    output_wallets.push(extra_output.wallet)
    amounts.push(extra_output.value)
  }

  const unsigned_tx_resp = build_transaction_multi_output(cardinal_utxos, extra_utxo_objs, payer_wallet, output_wallets, amounts, payer_wallet, fee_rate)
  const unsigned_tx = unsigned_tx_resp.tx

  return {
    txid: unsigned_tx.getId(),
    unsigned_tx_hex: unsigned_tx.toHex(),
    tx_fee: unsigned_tx_resp.tx_fee,
  }
}

export async function mint_with_extra_input_in_commit_all(
  inscription_details: InscriptionDetails,
  extra_input_utxos: UtxoInfoWithWallet[],
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
  sign_func: SignFunction,
): Promise<InscribeResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(inscription_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx(payer_wallet, inscription_wallet, secret, inscription_details, fee_rate, postage, payment_wallet, payment, extra_input_utxos)
  const signed_commit_tx = await sign_func(commit_tx.unsigned_psbt_hex, payer_addr, inscription_address, [])

  const commit_txid = signed_commit_tx.txid
  const reveal_tx = await build_reveal_tx(inscription_wallet, commit_txid, commit_tx.output_value, secret, inscription_details, fee_rate, postage, payment_wallet, payment)

  const isValid = await check_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_tx_hex])

  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  if (dry_run) {
    return {
      commit_txid: signed_commit_tx.txid,
      signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
      reveal_txid: reveal_tx.txid,
      signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
      inscription_id: `${reveal_tx.txid}i0`,
      postage,
      secret,
    }
  }

  await broadcast_txes([signed_commit_tx.signed_tx_hex, reveal_tx.signed_tx_hex])
  return {
    commit_txid: signed_commit_tx.txid,
    signed_commit_tx_hex: signed_commit_tx.signed_tx_hex,
    reveal_txid: reveal_tx.txid,
    signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
    inscription_id: `${reveal_tx.txid}i0`,
    postage,
    secret,
  }
}

export async function mint_with_extra_input_in_commit_fee_rate(
  inscription_details: InscriptionDetails,
  extra_input_utxos: UtxoInfoWithWallet[],
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
): Promise<InscribeCheckFeesResult> {
  // Get connected wallet
  const paymentWallet = getPaymentWallet()
  const inscriptionWallet = getOrdinalsWallet()
  if (!paymentWallet || !inscriptionWallet)
    throw new Error('Wallets not found')

  const payer_addr = paymentWallet.address
  const payer_public_key = paymentWallet.pubkey
  const inscription_address = inscriptionWallet.address
  const inscription_public_key = inscriptionWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)
  const inscription_wallet = new WalletInfo(false, null, inscription_address, null, inscription_public_key)
  let payment_wallet = null
  if (payment_addr != null) {
    payment_wallet = new WalletInfo(false, null, payment_addr, null, null)
  }

  if (postage == null || postage <= 0) {
    postage = get_dust_value(inscription_wallet)
  }

  const secret = createSecretToken()
  const commit_tx = await build_commit_tx(payer_wallet, inscription_wallet, secret, inscription_details, fee_rate, postage, payment_wallet, payment, extra_input_utxos)
  const dummy_commit_txid = commit_tx.unsigned_commit_tx.getId()
  const reveal_tx = await build_reveal_tx(inscription_wallet, dummy_commit_txid, commit_tx.output_value, secret, inscription_details, fee_rate, postage, payment_wallet, payment)

  return {
    commit_fee: commit_tx.commit_fee,
    reveal_fee: commit_tx.reveal_fee,
    total_fee: commit_tx.commit_fee + commit_tx.reveal_fee,
    unsigned_commit_tx_hex: commit_tx.unsigned_commit_tx.toHex(),
    signed_reveal_tx_hex: reveal_tx.signed_tx_hex,
    inscription_id: `${reveal_tx.txid}i0`,
    postage,
  }
}
