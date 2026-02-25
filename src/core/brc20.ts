import { Buffer } from 'node:buffer'
import { encode as nadaEncode } from '@bestinslot/nada'
import { init as initZstd, compress as zstdCompress } from '@bokuweb/zstd-wasm'
import { Buff } from '@cmdcode/buff-utils'
import { Script } from '@cmdcode/tapscript'
import { encode as base64Encode } from 'base64-arraybuffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { getWeb3 } from '../lib/web3'
import { InscriptionDetails } from '../types/inscription'
import { WalletInfo } from '../types/wallet'
import { broadcastTxes, clearExtraUtxos, saveExtraUtxos } from './helpers'
import {
  mintAll,
  mintAllPaymentWallet,
  sendInscriptionAll,
  sendInscriptionInPaymentWalletToOpReturnAll,
  sendInscriptionToOpReturnAll,
} from './mint'
import { getSignFn } from './providers'
import { getWalletInfo } from './store'

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

/**
 * Encodes a function call to a smart contract using the provided ABI and function name, along with the parameters for the function call. This function uses the Web3 library to create a contract instance and encode the function call data according to the ABI specification. It also includes error handling to ensure that the specified function exists in the ABI and that the parameters are correctly formatted.
 *
 * @param abi - The ABI of the smart contract, which defines the functions and their parameters.
 * @param functionName - The name of the function to call on the smart contract.
 * @param params - An array of parameters to be passed to the function call, which should match the types defined in the ABI for the specified function.
 * @returns A hexadecimal string representing the encoded function call data, which can be included in a transaction to call the smart contract function. The encoding is done according to the ABI specification, and the resulting string can be used as the calldata for a transaction.
 * @throws Will throw an error if the specified function name does not exist in the ABI or if the parameters do not match the expected types defined in the ABI for that function. It will also throw an error if there is an issue with the Web3 library during encoding.
 */
export function evmEncodeFunctionCall(abi: any, functionName: string, params: any): string {
  const web3 = getWeb3()
  const contract = new web3.eth.Contract(abi)
  if (typeof contract.methods[functionName] !== 'function') {
    throw new TypeError(`Function "${functionName}" not found in ABI.`)
  }
  const method = contract.methods[functionName](...params)
  const encoded = method.encodeABI()
  return encoded
}

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
 * Deploys a smart contract by creating an inscription with the provided input data and sending it to the OP_RETURN output. The function first compresses the input data, then creates an inscription with the compressed data and mints it. After minting, it sends the inscription to an OP_RETURN output with a specific format. The function also handles optional payment parameters and allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param inputHex - The input data for the smart contract deployment, represented as a hexadecimal string. This data will be compressed and included in the inscription.
 * @param estimatedGas - The estimated gas required for the smart contract deployment, used to determine if padding is needed for the inscription content.
 * @param gasPerVbyte - The gas cost per virtual byte, used to calculate the total gas cost of the inscription content and determine if padding is needed.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the deployment process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the deployment process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function deploySmartContract(
  inputHex: string,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof inputHex != 'string')
    throw new Error('input_hex must be a string')
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('fee_rate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentAddr != null && typeof paymentAddr != 'string')
    throw new Error('payment_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer')
  if (typeof dryRun != 'boolean')
    throw new Error('dry_run must be a boolean')

  // Compress
  const inputB64 = await compressSmartContractData(inputHex)

  let content = Buff.str(`{"p":"brc20-prog","op":"d","b":"${inputB64}"}`)
  if (content.length * gasPerVbyte < estimatedGas) {
    const gasDeficit = estimatedGas - content.length * gasPerVbyte
    const neededPadding = Math.ceil(gasDeficit / gasPerVbyte)
    const padding = '20'.repeat(neededPadding)
    content = content.append(padding)
  }

  const inscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const res = await mintAll(
    inscriptionDetails,
    feeRate,
    postage,
    paymentAddr,
    payment,
    true,
    signFn,
  )
  const inscriptionId = res.inscription_id
  const satpoint = `${inscriptionId.split('i')[0]}:0:0`
  let sendInscriptionTx = null
  try {
    saveExtraUtxos([res.signed_commit_tx_hex, res.signed_reveal_tx_hex], [inscriptionId, satpoint])

    const targetWallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    sendInscriptionTx = await sendInscriptionToOpReturnAll(
      inscriptionId,
      targetWallet,
      1,
      feeRate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }
  if (sendInscriptionTx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dryRun) {
    return {
      commitTxId: res.commit_txid,
      signedCommitTxHex: res.signed_commit_tx_hex,
      revealTxId: res.reveal_txid,
      signedRevealTxHex: res.signed_reveal_tx_hex,
      inscriptionId: res.inscription_id,
      postage: res.postage,
      secret: res.secret,
      sendToOpReturnTxId: sendInscriptionTx.txId,
      signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
    }
  }

  const txes = [res.signed_commit_tx_hex, res.signed_reveal_tx_hex, sendInscriptionTx.signedTxHex]
  await broadcastTxes(txes)
  return {
    commitTxId: res.commit_txid,
    signedCommitTxHex: res.signed_commit_tx_hex,
    revealTxId: res.reveal_txid,
    signedRevealTxHex: res.signed_reveal_tx_hex,
    inscriptionId: res.inscription_id,
    postage: res.postage,
    secret: res.secret,
    sendToOpReturnTxId: sendInscriptionTx.txId,
    signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
  }
}

/**
 * Deploys a smart contract using the provided bytecode and ABI by creating an inscription with the encoded deployment data and sending it to the OP_RETURN output. The function first encodes the deployment data using the ABI and bytecode, then creates an inscription with the encoded data and mints it. After minting, it sends the inscription to an OP_RETURN output with a specific format. The function also handles optional payment parameters and allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param bytecode - The bytecode of the smart contract to be deployed, represented as a hexadecimal string. This bytecode will be encoded with the ABI and included in the inscription.
 * @param abi - The ABI of the smart contract, used to encode the deployment data along with the bytecode.
 * @param params - An array of parameters to be passed to the contract constructor, which will be encoded along with the bytecode using the ABI.
 * @param estimatedGas - The estimated gas required for the smart contract deployment, used to determine if padding is needed for the inscription content.
 * @param gasPerVbyte - The gas cost per virtual byte, used to calculate the total gas cost of the inscription content and determine if padding is needed.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the deployment process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the deployment process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function deploySmartContractAbi(
  bytecode: string,
  abi: any,
  params: any,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  if (typeof abi != 'object')
    throw new Error('abi must be an object')
  if (typeof bytecode != 'string')
    throw new Error('bytecode must be a string')
  if (!Array.isArray(params))
    throw new Error('params must be an array')

  const encodedDeploy = evmEncodeDeploy(bytecode, abi, params)
  return await deploySmartContract(
    encodedDeploy,
    estimatedGas,
    gasPerVbyte,
    feeRate,
    postage,
    paymentAddr,
    payment,
    dryRun,
  )
}

/**
 * Calls a smart contract function by creating an inscription with the provided input data and sending it to the OP_RETURN output. The function first compresses the input data, then creates an inscription with the compressed data and mints it. After minting, it sends the inscription to an OP_RETURN output with a specific format. The function also handles optional payment parameters and allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param smartContractContractAddr - The address of the smart contract to call, represented as a string. This address will be included in the inscription content to indicate which contract function is being called.
 * @param inputHex - The input data for the smart contract function call, represented as a hexadecimal string. This data will be compressed and included in the inscription.
 * @param estimatedGas - The estimated gas required for the smart contract function call, used to determine if padding is needed for the inscription content.
 * @param gasPerVbyte - The gas cost per virtual byte, used to calculate the total gas cost of the inscription content and determine if padding is needed.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the function call process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the function call process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function callSmartContract(
  smartContractContractAddr: string,
  inputHex: string,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof smartContractContractAddr != 'string')
    throw new Error('smart_contract_contract_addr must be a string')
  if (typeof inputHex != 'string')
    throw new Error('input_hex must be a string')
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('fee_rate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentAddr != null && typeof paymentAddr != 'string')
    throw new Error('payment_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer')
  if (typeof dryRun != 'boolean')
    throw new Error('dry_run must be a boolean')

  // Compress
  const inputB64 = await compressSmartContractData(inputHex)

  let content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${smartContractContractAddr}","b":"${inputB64}"}`,
  )
  if (content.length * gasPerVbyte < estimatedGas) {
    const gasDeficit = estimatedGas - content.length * gasPerVbyte
    const neededPadding = Math.ceil(gasDeficit / gasPerVbyte)
    const padding = '20'.repeat(neededPadding)
    content = content.append(padding)
  }

  const inscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const res = await mintAll(
    inscriptionDetails,
    feeRate,
    postage,
    paymentAddr,
    payment,
    true,
    signFn,
  )
  const inscriptionId = res.inscription_id
  const satpoint = `${inscriptionId.split('i')[0]}:0:0`
  let sendInscriptionTx = null
  try {
    saveExtraUtxos([res.signed_commit_tx_hex, res.signed_reveal_tx_hex], [inscriptionId, satpoint])

    const targetWallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    sendInscriptionTx = await sendInscriptionToOpReturnAll(
      inscriptionId,
      targetWallet,
      1,
      feeRate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }
  if (sendInscriptionTx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dryRun) {
    return {
      commitTxId: res.commit_txid,
      signedCommitTxHex: res.signed_commit_tx_hex,
      revealTxId: res.reveal_txid,
      signedRevealTxHex: res.signed_reveal_tx_hex,
      inscriptionId: res.inscription_id,
      postage: res.postage,
      secret: res.secret,
      sendToOpReturnTxId: sendInscriptionTx.txId,
      signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
    }
  }

  const txes = [res.signed_commit_tx_hex, res.signed_reveal_tx_hex, sendInscriptionTx.signedTxHex]
  await broadcastTxes(txes)
  return {
    commitTxId: res.commit_txid,
    signedCommitTxHex: res.signed_commit_tx_hex,
    revealTxId: res.reveal_txid,
    signedRevealTxHex: res.signed_reveal_tx_hex,
    inscriptionId: res.inscription_id,
    postage: res.postage,
    secret: res.secret,
    sendToOpReturnTxId: sendInscriptionTx.txId,
    signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
  }
}

/**
 * Calls a smart contract function by creating an inscription with the encoded function call data and sending it to the OP_RETURN output. The function takes the smart contract address, ABI, function name, and parameters, encodes the function call using the ABI, and then follows a similar process as `deploySmartContract` to create and send the inscription. It also handles optional payment parameters and allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param smartContractContractAddr - The address of the smart contract to call, represented as a string. This address will be included in the inscription content to indicate which contract function is being called.
 * @param abi - The ABI of the smart contract, used to encode the function call data along with the function name and parameters.
 * @param funcName - The name of the function to call on the smart contract, represented as a string. This will be used along with the ABI to encode the function call data.
 * @param params - An array of parameters to be passed to the contract function, which will be encoded using the ABI along with the function name.
 * @param estimatedGas - The estimated gas required for the smart contract function call, used to determine if padding is needed for the inscription content.
 * @param gasPerVbyte - The gas cost per virtual byte, used to calculate the total gas cost of the inscription content and determine if padding is needed.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the function call process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the function call process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function callSmartContractAbi(
  smartContractContractAddr: string,
  abi: any,
  funcName: string,
  params: any,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  if (typeof abi != 'object')
    throw new Error('abi must be an object')
  if (typeof funcName != 'string')
    throw new Error('func_name must be a string')
  if (!Array.isArray(params))
    throw new Error('params must be an array')

  const encodedFuncCall = evmEncodeFunctionCall(abi, funcName, params)
  return await callSmartContract(
    smartContractContractAddr,
    encodedFuncCall,
    estimatedGas,
    gasPerVbyte,
    feeRate,
    postage,
    paymentAddr,
    payment,
    dryRun,
  )
}

/**
 * Calls a smart contract function by creating an inscription with the provided input data and sending it to the OP_RETURN output. The function first compresses the input data, then creates an inscription with the compressed data and mints it. After minting, it sends the inscription to an OP_RETURN output with a specific format. The function also handles optional payment parameters and allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param smartContractContractAddr - The address of the smart contract to call, represented as a string. This address will be included in the inscription content to indicate which contract function is being called.
 * @param inputHex - The input data for the smart contract function call, represented as a hexadecimal string. This data will be compressed and included in the inscription.
 * @param estimatedGas - The estimated gas required for the smart contract function call, used to determine if padding is needed for the inscription content.
 * @param gasPerVbyte - The gas cost per virtual byte, used to calculate the total gas cost of the inscription content and determine if padding is needed.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the function call process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the function call process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 * @throws Will throw an error if the wallet is not connected, if the input parameters are of incorrect types, or if there is a failure in creating or sending the inscription.
 */
export async function callSmartContractFromPaymentWallet(
  smartContractContractAddr: string,
  inputHex: string,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof smartContractContractAddr != 'string')
    throw new Error('smart_contract_contract_addr must be a string')
  if (typeof inputHex != 'string')
    throw new Error('input_hex must be a string')
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('fee_rate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentAddr != null && typeof paymentAddr != 'string')
    throw new Error('payment_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer')
  if (typeof dryRun != 'boolean')
    throw new Error('dry_run must be a boolean')

  // Compress
  const inputB64 = await compressSmartContractData(inputHex)

  let content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${smartContractContractAddr}","b":"${inputB64}"}`,
  )
  if (content.length * gasPerVbyte < estimatedGas) {
    const gasDeficit = estimatedGas - content.length * gasPerVbyte
    const neededPadding = Math.ceil(gasDeficit / gasPerVbyte)
    const padding = '20'.repeat(neededPadding)
    content = content.append(padding)
  }

  const inscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mintResult = await mintAllPaymentWallet(
    inscriptionDetails,
    feeRate,
    postage,
    paymentAddr,
    payment,
    true,
    signFn,
  )
  const inscriptionId = mintResult.inscriptionId
  const satpoint = `${inscriptionId.split('i')[0]}:0:0`
  let sendInscriptionTx = null
  try {
    saveExtraUtxos(
      [mintResult.signedCommitTxHex, mintResult.signedRevealTxHex],
      [inscriptionId, satpoint],
    )

    const targetWallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    sendInscriptionTx = await sendInscriptionInPaymentWalletToOpReturnAll(
      inscriptionId,
      targetWallet,
      1,
      feeRate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }
  if (sendInscriptionTx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dryRun) {
    return {
      commitTxId: mintResult.commitTxId,
      signedCommitTxHex: mintResult.signedCommitTxHex,
      revealTxId: mintResult.revealTxId,
      signedRevealTxHex: mintResult.signedRevealTxHex,
      inscriptionId: mintResult.inscriptionId,
      postage: mintResult.postage,
      secret: mintResult.secret,
      sendToOpReturnTxId: sendInscriptionTx.txId,
      signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
    }
  }

  const txes = [
    mintResult.signedCommitTxHex,
    mintResult.signedRevealTxHex,
    sendInscriptionTx.signedTxHex,
  ]
  await broadcastTxes(txes)
  return {
    commitTxId: mintResult.commitTxId,
    signedCommitTxHex: mintResult.signedCommitTxHex,
    revealTxId: mintResult.revealTxId,
    signedRevealTxHex: mintResult.signedRevealTxHex,
    inscriptionId: mintResult.inscriptionId,
    postage: mintResult.postage,
    secret: mintResult.secret,
    sendToOpReturnTxId: sendInscriptionTx.txId,
    signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
  }
}

/**
 * Calls a smart contract function using the provided ABI and function name by encoding the function call data, creating an inscription with the encoded data, and sending it to the OP_RETURN output. The function takes the smart contract address, ABI, function name, and parameters, encodes the function call using the ABI, and then follows a similar process as `callSmartContract` to create and send the inscription. It also handles optional payment parameters and allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param smartContractContractAddr - The address of the smart contract to call, represented as a string. This address will be included in the inscription content to indicate which contract function is being called.
 * @param abi - The ABI of the smart contract, used to encode the function call data along with the function name and parameters.
 * @param funcName - The name of the function to call on the smart contract, represented as a string. This will be used along with the ABI to encode the function call data.
 * @param params - An array of parameters to be passed to the contract function, which will be encoded using the ABI along with the function name.
 * @param estimatedGas - The estimated gas required for the smart contract function call, used to determine if padding is needed for the inscription content.
 * @param gasPerVbyte - The gas cost per virtual byte, used to calculate the total gas cost of the inscription content and determine if padding is needed.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the function call process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the function call process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function callSmartContractAbiFromPaymentWallet(
  smartContractContractAddr: string,
  abi: any,
  funcName: string,
  params: any,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  if (typeof abi != 'object')
    throw new Error('abi must be an object')
  if (typeof funcName != 'string')
    throw new Error('func_name must be a string')
  if (!Array.isArray(params))
    throw new Error('params must be an array')

  const encodedFuncCall = evmEncodeFunctionCall(abi, funcName, params)
  return await callSmartContractFromPaymentWallet(
    smartContractContractAddr,
    encodedFuncCall,
    estimatedGas,
    gasPerVbyte,
    feeRate,
    postage,
    paymentAddr,
    payment,
    dryRun,
  )
}

/**
 * Deposits a BRC-20 token into the BRC2.0 programmable module by creating an inscription with the transfer operation and sending it to the OP_RETURN output. The function takes the token tick, amount, fee rate, and optional payment parameters, creates an inscription with the transfer operation, mints it, and then sends it to an OP_RETURN output with a specific format. It also allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param tick - The tick of the BRC-20 token to be deposited, represented as a string. This will be included in the inscription content to indicate which token is being transferred.
 * @param amount - The amount of the BRC-20 token to be deposited, represented as a string. This will be included in the inscription content to indicate how many tokens are being transferred.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the deposit process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the deposit process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function depositToBrc20Prog(
  tick: string,
  amount: string,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof tick != 'string')
    throw new Error('tick must be a string')
  if (typeof amount != 'string')
    throw new Error('amount must be a string')
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('fee_rate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentAddr != null && typeof paymentAddr != 'string')
    throw new Error('payment_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer')
  if (typeof dryRun != 'boolean')
    throw new Error('dry_run must be a boolean')

  const content = Buff.str(`{"p":"brc-20","op":"transfer","tick":"${tick}","amt":"${amount}"}`)
  const inscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mintResult = await mintAll(
    inscriptionDetails,
    feeRate,
    postage,
    paymentAddr,
    payment,
    true,
    signFn,
  )
  const inscriptionId = mintResult.inscription_id
  const satpoint = `${inscriptionId.split('i')[0]}:0:0`
  let sendInscriptionTx = null
  try {
    saveExtraUtxos(
      [mintResult.signed_commit_tx_hex, mintResult.signed_reveal_tx_hex],
      [inscriptionId, satpoint],
    )

    const targetWallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    sendInscriptionTx = await sendInscriptionToOpReturnAll(
      inscriptionId,
      targetWallet,
      1,
      feeRate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }
  if (sendInscriptionTx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dryRun) {
    return {
      commitTxId: mintResult.commit_txid,
      signedCommitTxHex: mintResult.signed_commit_tx_hex,
      revealTxId: mintResult.reveal_txid,
      signedRevealTxHex: mintResult.signed_reveal_tx_hex,
      inscriptionId: mintResult.inscription_id,
      postage: mintResult.postage,
      secret: mintResult.secret,
      sendToOpReturnTxId: sendInscriptionTx.txId,
      signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
    }
  }

  const txes = [
    mintResult.signed_commit_tx_hex,
    mintResult.signed_reveal_tx_hex,
    sendInscriptionTx.signedTxHex,
  ]
  await broadcastTxes(txes)
  return {
    commitTxId: mintResult.commit_txid,
    signedCommitTxHex: mintResult.signed_commit_tx_hex,
    revealTxId: mintResult.reveal_txid,
    signedRevealTxHex: mintResult.signed_reveal_tx_hex,
    inscriptionId: mintResult.inscription_id,
    postage: mintResult.postage,
    secret: mintResult.secret,
    sendToOpReturnTxId: sendInscriptionTx.txId,
    signedSendToOpReturnTxHex: sendInscriptionTx.signedTxHex,
  }
}

/**
 * Withdraws a BRC-20 token from the BRC2.0 programmable module by creating an inscription with the transfer operation and sending it to the target address. The function takes the token tick, amount, target address, fee rate, and optional payment parameters, creates an inscription with the transfer operation, mints it, and then sends it to the target address. It also allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param tick - The tick of the BRC-20 token to be withdrawn, represented as a string. This will be included in the inscription content to indicate which token is being transferred.
 * @param amount - The amount of the BRC-20 token to be withdrawn, represented as a string. This will be included in the inscription content to indicate how many tokens are being transferred.
 * @param targetAddr - The Bitcoin address to which the withdrawn BRC-20 tokens should be sent, represented as a string. This will be used as the destination for the inscription after minting.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the withdrawal process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param paymentAddr - An optional parameter representing the Bitcoin address to which payment should be sent for the minting transaction. If null, no payment will be made.
 * @param payment - An optional parameter representing the amount of payment to be sent for the minting transaction, specified in sats. If null or less than or equal to 0, no payment will be made.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 *
 * @returns An object containing details of the withdrawal process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function withdrawFromBrc20Prog(
  tick: string,
  amount: string,
  targetAddr: string,
  feeRate: number,
  postage: number | null,
  paymentAddr: string | null,
  payment: number | null,
  dryRun: boolean,
) {
  // Get connected wallet
  const walletInfo = getWalletInfo()
  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (typeof tick != 'string')
    throw new Error('tick must be a string')
  if (typeof amount != 'string')
    throw new Error('amount must be a string')
  if (typeof targetAddr != 'string')
    throw new Error('target_addr must be a string')
  if (typeof feeRate != 'number' || !Number.isInteger(feeRate))
    throw new Error('fee_rate must be an integer')
  if (postage != null && (typeof postage != 'number' || !Number.isInteger(postage)))
    throw new Error('postage must be an integer or null')
  if (paymentAddr != null && typeof paymentAddr != 'string')
    throw new Error('payment_addr must be a string')
  if (payment != null && (typeof payment != 'number' || !Number.isInteger(payment)))
    throw new Error('payment must be an integer')
  if (typeof dryRun != 'boolean')
    throw new Error('dry_run must be a boolean')

  const content = Buff.str(
    `{"p":"brc20-module","op":"withdraw","tick":"${tick}","amt":"${amount}","module":"BRC20PROG"}`,
  )
  const inscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    content,
  )

  // Sign function
  const signFn = getSignFn(walletInfo.provider)

  const mintResult = await mintAll(
    inscriptionDetails,
    feeRate,
    postage,
    paymentAddr,
    payment,
    true,
    signFn,
  )
  const inscriptionId = mintResult.inscription_id
  const satpoint = `${inscriptionId.split('i')[0]}:0:0`
  let sendInscriptionTx = null
  try {
    saveExtraUtxos(
      [mintResult.signed_commit_tx_hex, mintResult.signed_reveal_tx_hex],
      [inscriptionId, satpoint],
    )

    const targetWallet = new WalletInfo(false, null, targetAddr, null, null)
    sendInscriptionTx = await sendInscriptionAll(
      inscriptionId,
      targetWallet,
      null,
      feeRate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }
  if (sendInscriptionTx == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  if (dryRun) {
    return {
      commitTxId: mintResult.commit_txid,
      signedCommitTxHex: mintResult.signed_commit_tx_hex,
      revealTxId: mintResult.reveal_txid,
      signedRevealTxHex: mintResult.signed_reveal_tx_hex,
      inscriptionId: mintResult.inscription_id,
      postage: mintResult.postage,
      secret: mintResult.secret,
      transferTxId: sendInscriptionTx.txId,
      signedTransferTxHex: sendInscriptionTx.signedTxHex,
    }
  }

  const txes = [
    mintResult.signed_commit_tx_hex,
    mintResult.signed_reveal_tx_hex,
    sendInscriptionTx.signedTxHex,
  ]
  await broadcastTxes(txes)
  return {
    commitTxId: mintResult.commit_txid,
    signedCommitTxHex: mintResult.signed_commit_tx_hex,
    revealTxId: mintResult.reveal_txid,
    signedRevealTxHex: mintResult.signed_reveal_tx_hex,
    inscriptionId: mintResult.inscription_id,
    postage: mintResult.postage,
    secret: mintResult.secret,
    transferTxId: sendInscriptionTx.txId,
    signedTransferTxHex: sendInscriptionTx.signedTxHex,
  }
}
