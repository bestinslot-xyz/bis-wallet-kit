import { Buffer } from 'node:buffer'
import { getBitcoinNetwork } from '@@/lib/bitcoin'
import { getWeb3 } from '@@/lib/web3'
import { encode as nadaEncode } from '@bestinslot/nada'
import { init as initZstd, compress as zstdCompress } from '@bokuweb/zstd-wasm'
import { Buff } from '@cmdcode/buff-utils'
import { Script } from '@cmdcode/tapscript'
import { encode as base64Encode } from 'base64-arraybuffer'
import { bitcoinjs } from '../main'
import { broadcast_txes, clear_extra_utxos, save_extra_utxos } from './helpers'
import { InscriptionDetails, mint_all, mint_all_payment_wallet, send_inscription_all, send_inscription_in_payment_wallet_to_op_return_all, send_inscription_to_op_return_all, WalletInfo } from './mint'
import { getSignFn } from './providers'
import { getWalletInfo } from './store'

export function evm_encode_deploy(bytecode: string, abi: any, params: any): string {
  if (bytecode.slice(0, 2) !== '0x') {
    bytecode = `0x${bytecode}`
  }

  const web3 = getWeb3()
  const contract = new web3.eth.Contract(abi)
  const transaction = contract.deploy({ data: bytecode, arguments: params })
  const encoded = transaction.encodeABI()
  return encoded
}

export function evm_encode_func_call(abi: any, func_name: string, params: any): string {
  const web3 = getWeb3()
  const contract = new web3.eth.Contract(abi)
  if (typeof contract.methods[func_name] !== 'function') {
    throw new TypeError(`Function "${func_name}" not found in ABI.`)
  }
  const method = contract.methods[func_name](...params)
  const encoded = method.encodeABI()
  return encoded
}

// evm_get_addr_from_btc_addr
export function evm_get_addr_from_btc_address(btc_addr: string) {
  const network = getBitcoinNetwork()
  const pkscript = bitcoinjs.address.toOutputScript(btc_addr, network).toString('hex')
  const pkscript_buf = Buff.hex(pkscript)

  // get keccak256 hash of pkscript
  const web3 = getWeb3()
  const hash = web3.utils.keccak256(pkscript_buf)
  // get the last 20 bytes of the hash
  const addr = hash.slice(-40)
  return `0x${addr}`
}

export function evm_get_addr_from_pkscript(pkscript: string) {
  const pkscript_buf = Buff.hex(pkscript)

  // get keccak256 hash of pkscript
  const web3 = getWeb3()
  const hash = web3.utils.keccak256(pkscript_buf)
  // get the last 20 bytes of the hash
  const addr = hash.slice(-40)
  return `0x${addr}`
}

/**
 * Recursively builds the type string from an ABI definition.
 */
function buildType(def: any): string {
  if (def.type.startsWith('tuple')) {
    const componentTypes = def.components.map(buildType).join(',')
    const base = `tuple(${componentTypes})`
    if (def.type.endsWith('[]'))
      return `${base}[]`
    return base
  }

  return def.type
}

/**
 * Recursively decodes a value and maps it with its type and name.
 */
function decodeValue(typeDef: any, decodedValue: any): { type: string, value: any } {
  const baseType = typeDef.type

  if (baseType.startsWith('tuple')) {
    const isArray = baseType.endsWith('[]')

    if (isArray) {
      return {
        type: buildType(typeDef),
        value: decodedValue.map((item: any) => {
          return decodeTupleComponents(typeDef.components, item)
        }),
      }
    }

    return {
      type: buildType(typeDef),
      value: decodeTupleComponents(typeDef.components, decodedValue),
    }
  }

  return {
    type: baseType,
    value: decodedValue,
  }
}

/**
 * Recursively maps tuple components to name-type-value.
 */
function decodeTupleComponents(components: any[], decoded: any) {
  const result: { [name: string]: { type: string, value: any } } = {}
  components.forEach((comp, idx) => {
    const name = comp.name || `component${idx}`
    result[name] = decodeValue(comp, decoded[idx])
  })

  return result
}

/**
 * Decodes a responseHex from a contract call using function name and ABI.
 */
interface TypedValue {
  type: string
  value: string | number | boolean | TypedValue | TypedValue[] | { [key: string]: TypedValue }
}

export type DecodedFnResponse = Record<string, TypedValue>

// evm_decode_func_call_resp
export function decodeFunctionResponseWithTypes(abi: any, functionName: string, responseHex: string) {
  const w3 = getWeb3()

  const fnAbi = abi.find(
    (item: any) => item.name === functionName && item.type === 'function',
  )

  if (!fnAbi || !fnAbi.outputs) {
    throw new Error(`Function "${functionName}" not found or has no outputs.`)
  }

  const outputTypes = fnAbi.outputs.map(buildType)
  const decoded = w3.eth.abi.decodeParameters(outputTypes, responseHex)

  const result: DecodedFnResponse = {}
  fnAbi.outputs.forEach((outDef: any, i: any) => {
    const name = outDef.name || `output${i}`
    const value = decoded[i]
    result[name] = decodeValue(outDef, value)
  })

  return result
}

export async function compressSmartContractData(input_hex: string): Promise<string> {
  await initZstd() // Needed before using zstdCompress

  // Remove '0x' prefix if present
  if (input_hex.startsWith('0x')) {
    input_hex = input_hex.slice(2)
  }

  const originalBytes = Buff.hex(input_hex).to_bytes()

  // 1. Run Zstd compression and store the raw result
  const zstdResult = zstdCompress(new Uint8Array(originalBytes), 22)

  // 2. Check if the result is just zeros (a sign of failure)
  const isZstdResultInvalid = zstdResult.length > 0 && zstdResult.every(byte => byte === 0)

  // 3. Prepare the list of compression variants
  const uncompressed = [0x00, ...Array.from(originalBytes)]
  const nadaCompressed = [0x01, ...nadaEncode(originalBytes)]
  const allVariants = [uncompressed, nadaCompressed]

  // 4. Only add the Zstd result if it's valid
  if (!isZstdResultInvalid) {
    const zstdCompressed = [0x02, ...Array.from(zstdResult)]
    allVariants.push(zstdCompressed)
  }

  // 5. Find the shortest variant
  const shortest = allVariants.reduce((a, b) => a.length <= b.length ? a : b)

  // Convert to base64
  // Use Uint8Array.from to ensure we are working with a Uint8Array
  const typedArray = Uint8Array.from(shortest)
  const base64Encoded = base64Encode(typedArray.buffer)

  // Remove suffix '=', could be more than one
  const base64WithoutPadding = base64Encoded.replace(/=+$/, '')

  return base64WithoutPadding
}

// ignores payment_addr and payment if payment is <= 0
// set dry_run to true to get the tx hexes without broadcasting
// inscription_details must be of type bis.InscriptionDetails, you can use bis.Buff.hex, bis.Buff.str etc.. for parameters of the object (see @cmdcode/buff-utils)
// payment_addr must be a string
// payment must be an integer (in sats)
export async function deploy_smart_contract(
  input_hex: string,
  estimated_gas: number,
  gas_per_vbyte: number,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof input_hex != 'string')
    throw new Error('input_hex must be a string')
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

  // Compress
  const input_b64 = await compressSmartContractData(input_hex)

  let content = Buff.str(`{"p":"brc20-prog","op":"d","b":"${input_b64}"}`)
  if (content.length * gas_per_vbyte < estimated_gas) {
    const gas_deficit = estimated_gas - content.length * gas_per_vbyte
    const needed_padding = Math.ceil(gas_deficit / gas_per_vbyte)
    const padding = '20'.repeat(needed_padding)
    content = content.append(padding)
  }

  const inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mint_result = await mint_all(inscription_details, fee_rate, postage, payment_addr, payment, true, signFn)
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    save_extra_utxos([mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex], [inscription_id, satpoint])

    const target_wallet = new WalletInfo(true, Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)), null, null, null)
    send_inscription_tx = await send_inscription_to_op_return_all(inscription_id, target_wallet, 1, fee_rate, true, signFn)
  }
  finally {
    clear_extra_utxos()
  }
  if (send_inscription_tx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dry_run) {
    return {
      commit_txid: mint_result.commit_txid,
      signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
      reveal_txid: mint_result.reveal_txid,
      signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
      inscription_id: mint_result.inscription_id,
      postage: mint_result.postage,
      secret: mint_result.secret,
      send_to_op_return_txid: send_inscription_tx.txid,
      signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
    }
  }

  const txes = [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex, send_inscription_tx.signed_tx_hex]
  await broadcast_txes(txes)
  return {
    commit_txid: mint_result.commit_txid,
    signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
    reveal_txid: mint_result.reveal_txid,
    signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
    inscription_id: mint_result.inscription_id,
    postage: mint_result.postage,
    secret: mint_result.secret,
    send_to_op_return_txid: send_inscription_tx.txid,
    signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
  }
}

// ignores payment_addr and payment if payment is <= 0
// set dry_run to true to get the tx hexes without broadcasting
// inscription_details must be of type bis.InscriptionDetails, you can use bis.Buff.hex, bis.Buff.str etc.. for parameters of the object (see @cmdcode/buff-utils)
// payment_addr must be a string
// payment must be an integer (in sats)
export async function deploy_smart_contract_abi(
  bytecode: string,
  abi: any,
  params: any,
  estimated_gas: number,
  gas_per_vbyte: number,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  if (typeof abi != 'object')
    throw new Error('abi must be an object')
  if (typeof bytecode != 'string')
    throw new Error('bytecode must be a string')
  if (!Array.isArray(params))
    throw new Error('params must be an array')

  const encoded_deploy = evm_encode_deploy(bytecode, abi, params)
  return await deploy_smart_contract(encoded_deploy, estimated_gas, gas_per_vbyte, fee_rate, postage, payment_addr, payment, dry_run)
}

// ignores payment_addr and payment if payment is <= 0
// set dry_run to true to get the tx hexes without broadcasting
// inscription_details must be of type bis.InscriptionDetails, you can use bis.Buff.hex, bis.Buff.str etc.. for parameters of the object (see @cmdcode/buff-utils)
// payment_addr must be a string
// payment must be an integer (in sats)
export async function call_smart_contract(
  smart_contract_contract_addr: string,
  input_hex: string,
  estimated_gas: number,
  gas_per_vbyte: number,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof smart_contract_contract_addr != 'string')
    throw new Error('smart_contract_contract_addr must be a string')
  if (typeof input_hex != 'string')
    throw new Error('input_hex must be a string')
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

  // Compress
  const input_b64 = await compressSmartContractData(input_hex)

  let content = Buff.str(`{"p":"brc20-prog","op":"c","c":"${smart_contract_contract_addr}","b":"${input_b64}"}`)
  if (content.length * gas_per_vbyte < estimated_gas) {
    const gas_deficit = estimated_gas - content.length * gas_per_vbyte
    const needed_padding = Math.ceil(gas_deficit / gas_per_vbyte)
    const padding = '20'.repeat(needed_padding)
    content = content.append(padding)
  }

  const inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mint_result = await mint_all(inscription_details, fee_rate, postage, payment_addr, payment, true, signFn)
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    save_extra_utxos([mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex], [inscription_id, satpoint])

    const target_wallet = new WalletInfo(true, Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)), null, null, null)
    send_inscription_tx = await send_inscription_to_op_return_all(inscription_id, target_wallet, 1, fee_rate, true, signFn)
  }
  finally {
    clear_extra_utxos()
  }
  if (send_inscription_tx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dry_run) {
    return {
      commit_txid: mint_result.commit_txid,
      signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
      reveal_txid: mint_result.reveal_txid,
      signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
      inscription_id: mint_result.inscription_id,
      postage: mint_result.postage,
      secret: mint_result.secret,
      send_to_op_return_txid: send_inscription_tx.txid,
      signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
    }
  }

  const txes = [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex, send_inscription_tx.signed_tx_hex]
  await broadcast_txes(txes)
  return {
    commit_txid: mint_result.commit_txid,
    signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
    reveal_txid: mint_result.reveal_txid,
    signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
    inscription_id: mint_result.inscription_id,
    postage: mint_result.postage,
    secret: mint_result.secret,
    send_to_op_return_txid: send_inscription_tx.txid,
    signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
  }
}

// ignores payment_addr and payment if payment is <= 0
// set dry_run to true to get the tx hexes without broadcasting
// inscription_details must be of type bis.InscriptionDetails, you can use bis.Buff.hex, bis.Buff.str etc.. for parameters of the object (see @cmdcode/buff-utils)
// payment_addr must be a string
// payment must be an integer (in sats)
export async function call_smart_contract_abi(
  smart_contract_contract_addr: string,
  abi: any,
  func_name: string,
  params: any,
  estimated_gas: number,
  gas_per_vbyte: number,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  if (typeof abi != 'object')
    throw new Error('abi must be an object')
  if (typeof func_name != 'string')
    throw new Error('func_name must be a string')
  if (!Array.isArray(params))
    throw new Error('params must be an array')

  const encoded_func_call = evm_encode_func_call(abi, func_name, params)
  return await call_smart_contract(smart_contract_contract_addr, encoded_func_call, estimated_gas, gas_per_vbyte, fee_rate, postage, payment_addr, payment, dry_run)
}

async function call_smart_contract_from_payment_wallet(
  smart_contract_contract_addr: string,
  input_hex: string,
  estimated_gas: number,
  gas_per_vbyte: number,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof smart_contract_contract_addr != 'string')
    throw new Error('smart_contract_contract_addr must be a string')
  if (typeof input_hex != 'string')
    throw new Error('input_hex must be a string')
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

  // Compress
  const input_b64 = await compressSmartContractData(input_hex)

  let content = Buff.str(`{"p":"brc20-prog","op":"c","c":"${smart_contract_contract_addr}","b":"${input_b64}"}`)
  if (content.length * gas_per_vbyte < estimated_gas) {
    const gas_deficit = estimated_gas - content.length * gas_per_vbyte
    const needed_padding = Math.ceil(gas_deficit / gas_per_vbyte)
    const padding = '20'.repeat(needed_padding)
    content = content.append(padding)
  }

  const inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mint_result = await mint_all_payment_wallet(inscription_details, fee_rate, postage, payment_addr, payment, true, signFn)
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    save_extra_utxos([mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex], [inscription_id, satpoint])

    const target_wallet = new WalletInfo(true, Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)), null, null, null)
    send_inscription_tx = await send_inscription_in_payment_wallet_to_op_return_all(inscription_id, target_wallet, 1, fee_rate, true, signFn)
  }
  finally {
    clear_extra_utxos()
  }
  if (send_inscription_tx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dry_run) {
    return {
      commit_txid: mint_result.commit_txid,
      signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
      reveal_txid: mint_result.reveal_txid,
      signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
      inscription_id: mint_result.inscription_id,
      postage: mint_result.postage,
      secret: mint_result.secret,
      send_to_op_return_txid: send_inscription_tx.txid,
      signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
    }
  }

  const txes = [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex, send_inscription_tx.signed_tx_hex]
  await broadcast_txes(txes)
  return {
    commit_txid: mint_result.commit_txid,
    signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
    reveal_txid: mint_result.reveal_txid,
    signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
    inscription_id: mint_result.inscription_id,
    postage: mint_result.postage,
    secret: mint_result.secret,
    send_to_op_return_txid: send_inscription_tx.txid,
    signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
  }
}

export async function call_smart_contract_abi_from_payment_wallet(
  smart_contract_contract_addr: string,
  abi: any,
  func_name: string,
  params: any,
  estimated_gas: number,
  gas_per_vbyte: number,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  if (typeof abi != 'object')
    throw new Error('abi must be an object')
  if (typeof func_name != 'string')
    throw new Error('func_name must be a string')
  if (!Array.isArray(params))
    throw new Error('params must be an array')

  const encoded_func_call = evm_encode_func_call(abi, func_name, params)
  return await call_smart_contract_from_payment_wallet(smart_contract_contract_addr, encoded_func_call, estimated_gas, gas_per_vbyte, fee_rate, postage, payment_addr, payment, dry_run)
}

export async function deposit_to_brc20_prog(
  tick: string,
  amount: string,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof tick != 'string')
    throw new Error('tick must be a string')
  if (typeof amount != 'string')
    throw new Error('amount must be a string')
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

  const content = Buff.str(`{"p":"brc-20","op":"transfer","tick":"${tick}","amt":"${amount}"}`)
  const inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mint_result = await mint_all(inscription_details, fee_rate, postage, payment_addr, payment, true, signFn)
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    save_extra_utxos([mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex], [inscription_id, satpoint])

    const target_wallet = new WalletInfo(true, Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)), null, null, null)
    send_inscription_tx = await send_inscription_to_op_return_all(inscription_id, target_wallet, 1, fee_rate, true, signFn)
  }
  finally {
    clear_extra_utxos()
  }
  if (send_inscription_tx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dry_run) {
    return {
      commit_txid: mint_result.commit_txid,
      signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
      reveal_txid: mint_result.reveal_txid,
      signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
      inscription_id: mint_result.inscription_id,
      postage: mint_result.postage,
      secret: mint_result.secret,
      send_to_op_return_txid: send_inscription_tx.txid,
      signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
    }
  }

  const txes = [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex, send_inscription_tx.signed_tx_hex]
  await broadcast_txes(txes)
  return {
    commit_txid: mint_result.commit_txid,
    signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
    reveal_txid: mint_result.reveal_txid,
    signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
    inscription_id: mint_result.inscription_id,
    postage: mint_result.postage,
    secret: mint_result.secret,
    send_to_op_return_txid: send_inscription_tx.txid,
    signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
  }
}

export async function withdraw_from_brc20_prog(
  tick: string,
  amount: string,
  target_addr: string,
  fee_rate: number,
  postage: number | null,
  payment_addr: string | null,
  payment: number | null,
  dry_run: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof tick != 'string')
    throw new Error('tick must be a string')
  if (typeof amount != 'string')
    throw new Error('amount must be a string')
  if (typeof target_addr != 'string')
    throw new Error('target_addr must be a string')
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

  const content = Buff.str(`{"p":"brc20-module","op":"withdraw","tick":"${tick}","amt":"${amount}","module":"BRC20PROG"}`)
  const inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mint_result = await mint_all(inscription_details, fee_rate, postage, payment_addr, payment, true, signFn)
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    save_extra_utxos([mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex], [inscription_id, satpoint])

    const target_wallet = new WalletInfo(false, null, target_addr, null, null)
    send_inscription_tx = await send_inscription_all(inscription_id, target_wallet, null, fee_rate, true, signFn)
  }
  finally {
    clear_extra_utxos()
  }
  if (send_inscription_tx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dry_run) {
    return {
      commit_txid: mint_result.commit_txid,
      signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
      reveal_txid: mint_result.reveal_txid,
      signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
      inscription_id: mint_result.inscription_id,
      postage: mint_result.postage,
      secret: mint_result.secret,
      transfer_txid: send_inscription_tx.txid,
      signed_transfer_tx_hex: send_inscription_tx.signed_tx_hex,
    }
  }

  const txes = [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex, send_inscription_tx.signed_tx_hex]
  await broadcast_txes(txes)
  return {
    commit_txid: mint_result.commit_txid,
    signed_commit_tx_hex: mint_result.signed_commit_tx_hex,
    reveal_txid: mint_result.reveal_txid,
    signed_reveal_tx_hex: mint_result.signed_reveal_tx_hex,
    inscription_id: mint_result.inscription_id,
    postage: mint_result.postage,
    secret: mint_result.secret,
    transfer_txid: send_inscription_tx.txid,
    signed_transfer_tx_hex: send_inscription_tx.signed_tx_hex,
  }
}
