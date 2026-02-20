import { Buffer } from 'node:buffer'
import { encode as nadaEncode } from '@bestinslot/nada'
import { init as initZstd, compress as zstdCompress } from '@bokuweb/zstd-wasm'
import { Buff } from '@cmdcode/buff-utils'
import { Script } from '@cmdcode/tapscript'
import { encode as base64Encode } from 'base64-arraybuffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { getWeb3 } from '../lib/web3'
import { broadcast_txes, clearExtraUtxos, saveExtraUtxos } from './helpers'
import {
  InscriptionDetails,
  mint_all,
  mint_all_payment_wallet,
  send_inscription_all,
  send_inscription_in_payment_wallet_to_op_return_all,
  send_inscription_to_op_return_all,
  WalletInfo,
} from './mint'
import { getSignFn } from './providers'
import { getWalletInfo } from './store'

function evmEncodeDeploy(bytecode: string, abi: any, params: any): string {
  if (bytecode.slice(0, 2) !== '0x') {
    bytecode = `0x${bytecode}`
  }

  const web3 = getWeb3()
  const contract = new web3.eth.Contract(abi)
  const transaction = contract.deploy({ data: bytecode, arguments: params })
  const encoded = transaction.encodeABI()
  return encoded
}

function evmEncodeFunctionCall(abi: any, functionName: string, params: any): string {
  const web3 = getWeb3()
  const contract = new web3.eth.Contract(abi)
  if (typeof contract.methods[functionName] !== 'function') {
    throw new TypeError(`Function "${functionName}" not found in ABI.`)
  }
  const method = contract.methods[functionName](...params)
  const encoded = method.encodeABI()
  return encoded
}

/**
 * Derives an EVM address from a given Bitcoin address by converting the Bitcoin address to its corresponding output script,
 * hashing it with Keccak256, and taking the last 20 bytes of the hash as the EVM address.
 *
 * @param bitcoinAddress - The Bitcoin address to derive the EVM address from.
 * @returns A string representing the derived EVM address in hexadecimal format, prefixed with '0x'.
 */
export function getEvmAddressFromBitcoinAddress(bitcoinAddress: string) {
  const network = getBitcoinNetwork()
  const pkscript = bitcoinjs.address.toOutputScript(bitcoinAddress, network).toString('hex')
  const pkscriptBuffer = Buff.hex(pkscript)

  // get keccak256 hash of pkscript
  const web3 = getWeb3()
  const hash = web3.utils.keccak256(pkscriptBuffer)
  // get the last 20 bytes of the hash
  const addr = hash.slice(-40)
  return `0x${addr}`
}

/**
 * Derives an EVM address from a given Bitcoin output script (pkscript) by hashing it with Keccak256 and taking the last
 * 20 bytes of the hash as the EVM address.
 *
 * @param pkscript - The Bitcoin output script (pkscript) in hexadecimal format to derive the EVM address from.
 * @returns A string representing the derived EVM address in hexadecimal format, prefixed with '0x'.
 */
export function getEvmAddressFromPkScript(pkscript: string) {
  const pkscriptBuffer = Buff.hex(pkscript)

  // get keccak256 hash of pkscript
  const web3 = getWeb3()
  const hash = web3.utils.keccak256(pkscriptBuffer)
  // get the last 20 bytes of the hash
  const addr = hash.slice(-40)
  return `0x${addr}`
}

/**
 * Recursively builds the type string from an ABI definition.
 *
 * For example, a tuple with components would be represented as "tuple(type1,type2,...)", and if it's an array, it would be "tuple(type1,type2,...)[ ]".
 *
 * This function handles nested tuples and arrays by calling itself recursively on the components of the tuple.
 *
 * @param def - The ABI definition object for a function output or input parameter.
 * @returns A string representing the type of the parameter, properly formatted for tuples and arrays.
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
 *
 * This function checks if the type is a tuple (or an array of tuples) and decodes it accordingly. For non-tuple types, it simply returns the type and value.
 *
 * For tuples, it uses the `decodeTupleComponents` function to decode each component of the tuple and maps them by their names (or default names if not provided).
 *
 * @param typeDef - The ABI definition object for a function output or input parameter.
 * @param decodedValue - The decoded value to be mapped.
 * @returns An object containing the type and value of the decoded parameter.
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
 *
 * For each component in the tuple, it decodes the value using the `decodeValue` function and maps it to its name (or a default name if not provided).
 * This allows for easy access to the values of tuple components by their names when decoding function responses that include tuples.
 *
 * @param components - An array of ABI definition objects for the components of the tuple.
 * @param decoded - The decoded values corresponding to the components of the tuple.
 *
 * @returns An object mapping component names to their type and decoded value. If a component does not have a name, it will be assigned a default name like "component0", "component1", etc.
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

/**
 * Decodes a response hex string from a contract function call using the provided ABI and function name. It returns an object
 * mapping output parameter names to their types and decoded values.
 *
 * @param abi - The ABI of the contract.
 * @param functionName - The name of the function whose response is being decoded.
 * @param responseHex - The hex string response from the contract function call to decode.
 * @returns  An object mapping output parameter names to their types and decoded values.
 */
export function decodeFunctionResponseWithTypes(
  abi: any,
  functionName: string,
  responseHex: string,
) {
  const w3 = getWeb3()

  const fnAbi = abi.find((item: any) => item.name === functionName && item.type === 'function')

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

/**
 * Compresses the input hex string using both Zstd and Nada compression algorithms, and returns the shortest result encoded in base64 without padding.
 *
 * @param inputHex - The input data in hexadecimal string format to be compressed.
 * @returns A base64 encoded string representing the compressed data, prefixed with a byte indicating the compression method used (0x00 for uncompressed, 0x01 for Nada, 0x02 for Zstd), and without any padding characters.
 */
export async function compressSmartContractData(inputHex: string): Promise<string> {
  await initZstd() // Needed before using zstdCompress

  // Remove '0x' prefix if present
  if (inputHex.startsWith('0x')) {
    inputHex = inputHex.slice(2)
  }

  const originalBytes = Buff.hex(inputHex).to_bytes()

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
  const shortest = allVariants.reduce((a, b) => (a.length <= b.length ? a : b))

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
/**
 *
 * @param input_hex
 * @param estimated_gas
 * @param gas_per_vbyte
 * @param fee_rate
 * @param postage
 * @param payment_addr
 * @param payment
 * @param dry_run
 */
export async function deploySmartContract(
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

  const res = await mint_all(
    inscription_details,
    fee_rate,
    postage,
    payment_addr,
    payment,
    true,
    signFn,
  )
  const inscription_id = res.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    saveExtraUtxos([res.signed_commit_tx_hex, res.signed_reveal_tx_hex], [inscription_id, satpoint])

    const target_wallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    send_inscription_tx = await send_inscription_to_op_return_all(
      inscription_id,
      target_wallet,
      1,
      fee_rate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }
  if (send_inscription_tx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dry_run) {
    return {
      commit_txid: res.commit_txid,
      signed_commit_tx_hex: res.signed_commit_tx_hex,
      reveal_txid: res.reveal_txid,
      signed_reveal_tx_hex: res.signed_reveal_tx_hex,
      inscription_id: res.inscription_id,
      postage: res.postage,
      secret: res.secret,
      send_to_op_return_txid: send_inscription_tx.txid,
      signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
    }
  }

  const txes = [
    res.signed_commit_tx_hex,
    res.signed_reveal_tx_hex,
    send_inscription_tx.signed_tx_hex,
  ]
  await broadcast_txes(txes)
  return {
    commit_txid: res.commit_txid,
    signed_commit_tx_hex: res.signed_commit_tx_hex,
    reveal_txid: res.reveal_txid,
    signed_reveal_tx_hex: res.signed_reveal_tx_hex,
    inscription_id: res.inscription_id,
    postage: res.postage,
    secret: res.secret,
    send_to_op_return_txid: send_inscription_tx.txid,
    signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
  }
}

// ignores payment_addr and payment if payment is <= 0
// set dry_run to true to get the tx hexes without broadcasting
// inscription_details must be of type bis.InscriptionDetails, you can use bis.Buff.hex, bis.Buff.str etc.. for parameters of the object (see @cmdcode/buff-utils)
// payment_addr must be a string
// payment must be an integer (in sats)
/**
 *
 * @param bytecode
 * @param abi
 * @param params
 * @param estimated_gas
 * @param gas_per_vbyte
 * @param fee_rate
 * @param postage
 * @param payment_addr
 * @param payment
 * @param dry_run
 */
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

  const encoded_deploy = evmEncodeDeploy(bytecode, abi, params)
  return await deploySmartContract(
    encoded_deploy,
    estimated_gas,
    gas_per_vbyte,
    fee_rate,
    postage,
    payment_addr,
    payment,
    dry_run,
  )
}

// ignores payment_addr and payment if payment is <= 0
// set dry_run to true to get the tx hexes without broadcasting
// inscription_details must be of type bis.InscriptionDetails, you can use bis.Buff.hex, bis.Buff.str etc.. for parameters of the object (see @cmdcode/buff-utils)
// payment_addr must be a string
// payment must be an integer (in sats)
/**
 *
 * @param smart_contract_contract_addr
 * @param input_hex
 * @param estimated_gas
 * @param gas_per_vbyte
 * @param fee_rate
 * @param postage
 * @param payment_addr
 * @param payment
 * @param dry_run
 */
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

  let content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${smart_contract_contract_addr}","b":"${input_b64}"}`,
  )
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

  const res = await mint_all(
    inscription_details,
    fee_rate,
    postage,
    payment_addr,
    payment,
    true,
    signFn,
  )
  const inscription_id = res.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    saveExtraUtxos([res.signed_commit_tx_hex, res.signed_reveal_tx_hex], [inscription_id, satpoint])

    const target_wallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    send_inscription_tx = await send_inscription_to_op_return_all(
      inscription_id,
      target_wallet,
      1,
      fee_rate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }
  if (send_inscription_tx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dry_run) {
    return {
      commit_txid: res.commit_txid,
      signed_commit_tx_hex: res.signed_commit_tx_hex,
      reveal_txid: res.reveal_txid,
      signed_reveal_tx_hex: res.signed_reveal_tx_hex,
      inscription_id: res.inscription_id,
      postage: res.postage,
      secret: res.secret,
      send_to_op_return_txid: send_inscription_tx.txid,
      signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
    }
  }

  const txes = [
    res.signed_commit_tx_hex,
    res.signed_reveal_tx_hex,
    send_inscription_tx.signed_tx_hex,
  ]
  await broadcast_txes(txes)
  return {
    commit_txid: res.commit_txid,
    signed_commit_tx_hex: res.signed_commit_tx_hex,
    reveal_txid: res.reveal_txid,
    signed_reveal_tx_hex: res.signed_reveal_tx_hex,
    inscription_id: res.inscription_id,
    postage: res.postage,
    secret: res.secret,
    send_to_op_return_txid: send_inscription_tx.txid,
    signed_send_to_op_return_tx_hex: send_inscription_tx.signed_tx_hex,
  }
}

// ignores payment_addr and payment if payment is <= 0
// set dry_run to true to get the tx hexes without broadcasting
// inscription_details must be of type bis.InscriptionDetails, you can use bis.Buff.hex, bis.Buff.str etc.. for parameters of the object (see @cmdcode/buff-utils)
// payment_addr must be a string
// payment must be an integer (in sats)
/**
 *
 * @param smart_contract_contract_addr
 * @param abi
 * @param func_name
 * @param params
 * @param estimated_gas
 * @param gas_per_vbyte
 * @param fee_rate
 * @param postage
 * @param payment_addr
 * @param payment
 * @param dry_run
 */
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

  const encoded_func_call = evmEncodeFunctionCall(abi, func_name, params)
  return await call_smart_contract(
    smart_contract_contract_addr,
    encoded_func_call,
    estimated_gas,
    gas_per_vbyte,
    fee_rate,
    postage,
    payment_addr,
    payment,
    dry_run,
  )
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

  let content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${smart_contract_contract_addr}","b":"${input_b64}"}`,
  )
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

  const mint_result = await mint_all_payment_wallet(
    inscription_details,
    fee_rate,
    postage,
    payment_addr,
    payment,
    true,
    signFn,
  )
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    saveExtraUtxos(
      [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex],
      [inscription_id, satpoint],
    )

    const target_wallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    send_inscription_tx = await send_inscription_in_payment_wallet_to_op_return_all(
      inscription_id,
      target_wallet,
      1,
      fee_rate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
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

  const txes = [
    mint_result.signed_commit_tx_hex,
    mint_result.signed_reveal_tx_hex,
    send_inscription_tx.signed_tx_hex,
  ]
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

/**
 *
 * @param smart_contract_contract_addr
 * @param abi
 * @param func_name
 * @param params
 * @param estimated_gas
 * @param gas_per_vbyte
 * @param fee_rate
 * @param postage
 * @param payment_addr
 * @param payment
 * @param dry_run
 */
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

  const encoded_func_call = evmEncodeFunctionCall(abi, func_name, params)
  return await call_smart_contract_from_payment_wallet(
    smart_contract_contract_addr,
    encoded_func_call,
    estimated_gas,
    gas_per_vbyte,
    fee_rate,
    postage,
    payment_addr,
    payment,
    dry_run,
  )
}

/**
 *
 * @param tick
 * @param amount
 * @param fee_rate
 * @param postage
 * @param payment_addr
 * @param payment
 * @param dry_run
 */
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

  const mint_result = await mint_all(
    inscription_details,
    fee_rate,
    postage,
    payment_addr,
    payment,
    true,
    signFn,
  )
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    saveExtraUtxos(
      [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex],
      [inscription_id, satpoint],
    )

    const target_wallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    send_inscription_tx = await send_inscription_to_op_return_all(
      inscription_id,
      target_wallet,
      1,
      fee_rate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
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

  const txes = [
    mint_result.signed_commit_tx_hex,
    mint_result.signed_reveal_tx_hex,
    send_inscription_tx.signed_tx_hex,
  ]
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

/**
 *
 * @param tick
 * @param amount
 * @param target_addr
 * @param fee_rate
 * @param postage
 * @param payment_addr
 * @param payment
 * @param dry_run
 */
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

  const content = Buff.str(
    `{"p":"brc20-module","op":"withdraw","tick":"${tick}","amt":"${amount}","module":"BRC20PROG"}`,
  )
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

  const mint_result = await mint_all(
    inscription_details,
    fee_rate,
    postage,
    payment_addr,
    payment,
    true,
    signFn,
  )
  const inscription_id = mint_result.inscription_id
  const satpoint = `${inscription_id.split('i')[0]}:0:0`
  let send_inscription_tx = null
  try {
    saveExtraUtxos(
      [mint_result.signed_commit_tx_hex, mint_result.signed_reveal_tx_hex],
      [inscription_id, satpoint],
    )

    const target_wallet = new WalletInfo(false, null, target_addr, null, null)
    send_inscription_tx = await send_inscription_all(
      inscription_id,
      target_wallet,
      null,
      fee_rate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
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

  const txes = [
    mint_result.signed_commit_tx_hex,
    mint_result.signed_reveal_tx_hex,
    send_inscription_tx.signed_tx_hex,
  ]
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
