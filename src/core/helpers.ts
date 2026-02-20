import { Buffer } from 'node:buffer'
import { Verifier } from 'bip322-js'
import * as bitcoinjs from 'bitcoinjs-lib'
import * as varuint from 'varuint-bitcoin'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { getNetwork } from './store-network'

export const txHexByIdCache: { [txid: string]: any } = {}
let currentExtraTxHexes: string[] = []
let currentExtraInscriptions: string[] | null = null // [inscr_id, satpoint]

function getBackendUrl(path: string) {
  return `https://ts-proxy.bestinslot.xyz/v3/${getNetwork()}/${path}`
}

function createSigningInput(payload: any, header: any) {
  const tokenParts = []
  let encodedHeader = btoa(JSON.stringify(header))
  encodedHeader = encodedHeader.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  tokenParts.push(encodedHeader)
  let encodedPayload = btoa(JSON.stringify(payload))
  encodedPayload = encodedPayload.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  tokenParts.push(encodedPayload)
  const signingInput = tokenParts.join('.')

  return signingInput
}

/**
 * Creates an unsecured JWT token with the given payload.
 *
 * @param payload - The payload to include in the token.
 * @returns The unsecured JWT token as a string.
 */
export function createUnsecuredToken(payload: any) {
  const header = { typ: 'JWT', alg: 'none' }

  return `${createSigningInput(payload, header)}.`
}

/**
 * Converts a base64-encoded string to a hexadecimal string.
 * @param str The base64-encoded string to convert.
 * @returns The hexadecimal representation of the input string.
 */
export function base64ToHex(str: string) {
  const raw = atob(str)
  let result = ''
  for (let i = 0; i < raw.length; i++) {
    const hex = raw.charCodeAt(i).toString(16)
    result += hex.length === 2 ? hex : `0${hex}`
  }
  return result.toLowerCase()
}

/**
 * Converts a hexadecimal string to a base64-encoded string.
 *
 * @param hexstring The hexadecimal string to convert.
 * @returns The base64-encoded representation of the input hexadecimal string.
 */
export function hexToBase64(hexstring: string) {
  const matches = hexstring.match(/\w{2}/g)
  if (!matches) {
    throw new Error('Invalid hex string')
  }
  return btoa(
    matches
      .map((a) => {
        return String.fromCharCode(Number.parseInt(a, 16))
      })
      .join(''),
  )
}

/**
 * Saves extra UTXOs that are currently being used in transactions but not yet confirmed on the blockchain.
 *
 * @param txHexes An array of transaction hex strings representing the transactions that are currently being processed.
 * @param inscription An optional array containing inscription details, where the first element is the inscription ID and the second element is the satpoint.
 */
export function saveExtraUtxos(txHexes: string[], inscription: string[] | null) {
  currentExtraTxHexes = []

  for (let i = 0; i < txHexes.length; i++) {
    currentExtraTxHexes.push(txHexes[i]!)
    const txid = bitcoinjs.Transaction.fromHex(txHexes[i]!).getId()
    txHexByIdCache[txid] = txHexes[i]
  }
  if (inscription != null) {
    currentExtraInscriptions = inscription.slice()
  }
  else {
    currentExtraInscriptions = null
  }
}

/**
 * Retrieves the currently saved extra UTXOs that are being used in transactions but not yet confirmed on the blockchain.
 */
export function clearExtraUtxos() {
  currentExtraTxHexes = []
  currentExtraInscriptions = null
}

function checkIfUtxoUsedInExtras(txid: string, vout: number) {
  for (const txhex of currentExtraTxHexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)

    for (const vin of tx.ins) {
      const vinTxId = vin.hash.reverse().toString('hex')
      const vinVout = vin.index

      if (vinTxId === txid && vinVout === vout) {
        return true
      }
    }
  }
  return false
}

function checkIfUtxoIsExtraOrdinal(txid: string, vout: number) {
  if (currentExtraInscriptions == null)
    return false

  const inscriptionTxId = currentExtraInscriptions[1]!.split(':')[0]
  const inscriptionVout = Number.parseInt(currentExtraInscriptions[1]!.split(':')[1]!)

  if (inscriptionTxId === txid && inscriptionVout === vout) {
    return true
  }

  return false
}

function bitcoinjsWalletFromOutputScript(output: any, network: any) {
  network = network || bitcoinjs.networks.bitcoin

  try {
    return bitcoinjs.payments.p2pkh({ output, network })
  }
  catch {
    // continue
  }
  try {
    return bitcoinjs.payments.p2sh({ output, network })
  }
  catch {}
  try {
    return bitcoinjs.payments.p2wpkh({ output, network })
  }
  catch {}
  try {
    return bitcoinjs.payments.p2wsh({ output, network })
  }
  catch {}
  try {
    return bitcoinjs.payments.p2tr({ output, network })
  }
  catch {}

  throw new Error(`${bitcoinjs.script.toASM(output)} has no matching Address`)
}

/**
 * Determines the type of a UTXO output based on its output script and the Bitcoin network parameters.
 *
 * @param output The output script of the UTXO to analyze.
 * @param network The Bitcoin network parameters to use for interpreting the output script (e.g., mainnet, testnet).
 * @returns A string representing the type of the UTXO output, such as 'pubkeyhash', 'scripthash', 'witness_v0_keyhash', 'witness_v0_scripthash', 'witness_v1_taproot', 'pubkey', 'anchor', 'witness_unknown', 'nulldata', 'multisig', or 'nonstandard'.
 */
export function utxoOutputTypeFromOutputScript(
  output: any,
  network: any,
):
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
  | 'nonstandard' {
  const wallet = bitcoinjsWalletFromOutputScript(output, network)

  if (wallet.name === 'p2pkh') {
    return 'pubkeyhash'
  }
  else if (wallet.name === 'p2sh') {
    return 'scripthash'
  }
  else if (wallet.name === 'p2wpkh') {
    return 'witness_v0_keyhash'
  }
  else if (wallet.name === 'p2wsh') {
    return 'witness_v0_scripthash'
  }
  else if (wallet.name === 'p2tr') {
    return 'witness_v1_taproot'
  }

  throw new Error(`Unknown output type: ${wallet.name}`)
}

function fixCardinalUtxos(utxos: APIUtxoInfo[], addr: string): APIUtxoInfo[] {
  if (currentExtraTxHexes.length === 0)
    return utxos

  const network = getBitcoinNetwork()

  const newUtxos = []
  for (const utxo of utxos) {
    const utxoInner = utxo.utxo
    const txid = utxoInner.split(':')[0]!
    const vout = Number.parseInt(utxoInner.split(':')[1]!)
    if (checkIfUtxoUsedInExtras(txid, vout))
      continue
    newUtxos.push(utxo)
  }
  for (const txhex of currentExtraTxHexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    const txid = tx.getId()
    for (let i = 0; i < tx.outs.length; i++) {
      const vout = tx.outs[i]!
      if (checkIfUtxoIsExtraOrdinal(txid, i))
        continue
      if (checkIfUtxoUsedInExtras(txid, i))
        continue

      try {
        // vout.script might be an OP_RETURN or a script without wallet address so this part may fail which is ok
        const voutAddress = bitcoinjs.address.fromOutputScript(vout.script, network)
        if (voutAddress === addr) {
          const utxo: APIUtxoInfo = {
            address: addr,
            amounts: null,
            block_height: null,
            inscription_ids: null,
            rune_ids: null,
            satpoints: null,
            script: tx.outs[i]!.script.toString('hex'),
            script_type: utxoOutputTypeFromOutputScript(vout.script, network),
            txfee: null,
            txid,
            utxo: `${txid}:${i}`,
            value: vout.value,
            vout: i,
            vsize: null,
          }
          newUtxos.push(utxo)
        }
      }
      catch (e) {
        console.error(`Error processing output script for txid ${txid}, vout ${i}`)
        console.error(e)
      }
    }
  }

  return newUtxos
}

function fixOrdinalUtxos(utxos: APIOrdinalUtxoInfo[], addr: string): APIOrdinalUtxoInfo[] {
  if (currentExtraTxHexes.length === 0)
    return utxos

  const network = getBitcoinNetwork()

  const newUtxos = []
  for (const utxo of utxos) {
    const utxoInner = utxo.utxo
    const txid = utxoInner.split(':')[0]!
    const vout = Number.parseInt(utxoInner.split(':')[1]!)
    if (checkIfUtxoUsedInExtras(txid, vout))
      continue
    newUtxos.push(utxo)
  }
  for (const txhex of currentExtraTxHexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    const txid = tx.getId()

    for (let i = 0; i < tx.outs.length; i++) {
      const vout = tx.outs[i]!
      if (!checkIfUtxoIsExtraOrdinal(txid, i))
        continue
      if (checkIfUtxoUsedInExtras(txid, i))
        continue

      const inscriptionId = currentExtraInscriptions ? currentExtraInscriptions[0] : null
      const satpoint = currentExtraInscriptions ? currentExtraInscriptions[1] : null
      if (!inscriptionId || !satpoint)
        continue

      try {
        // vout.script might be an OP_RETURN or a script without wallet address so this part may fail which is ok
        const voutAddress = bitcoinjs.address.fromOutputScript(vout.script, network)
        if (voutAddress === addr) {
          const utxo: APIOrdinalUtxoInfo = {
            address: addr,
            amounts: null,
            block_height: null,
            inscription_ids: [inscriptionId],
            rune_ids: null,
            satpoints: [satpoint],
            script: tx.outs[i]!.script.toString('hex'),
            script_type: utxoOutputTypeFromOutputScript(vout.script, network),
            txfee: null,
            txid,
            utxo: `${txid}:${i}`,
            value: vout.value,
            vout: i,
            vsize: null,
          }

          newUtxos.push(utxo)
        }
      }
      catch (e) {
        console.error(`Error processing output script for txid ${txid}, vout ${i}`)
        console.error(e)
      }
    }
  }

  return newUtxos
}

/**
 * Converts a witness stack to a script witness format that can be used in Bitcoin transactions.
 * @param witness An array representing the witness stack, where each element is a buffer or a string that can be converted to a buffer.
 * @returns A buffer containing the script witness data that can be included in a Bitcoin transaction input.
 */
export function witnessStackToScriptWitness(witness: any[]): any {
  let buffer = new Uint8Array(0)
  function writeSlice(slice: any) {
    buffer = Buffer.concat([buffer, slice])
  }
  function writeVarInt(i: number) {
    const currentLen = buffer.length
    const varintLen = varuint.encodingLength(i)
    buffer = Buffer.concat([buffer, new Uint8Array(varintLen)])
    varuint.encode(i, buffer, currentLen)
  }
  function writeVarSlice(slice: any) {
    writeVarInt(slice.length)
    writeSlice(slice)
  }
  function writeVector(vector: any[]) {
    writeVarInt(vector.length)
    vector.forEach(writeVarSlice)
  }
  writeVector(witness)
  return buffer
}

export interface APIUtxoInfo {
  address: string
  amounts: number[] | null
  block_height: number | null
  inscription_ids: string[] | null
  rune_ids: string[] | null
  satpoints: string[] | null
  script: string
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
  txfee: number | null
  txid: string
  utxo: string
  value: number
  vout: number
  vsize: number | null
}

/**
 * Fetches the UTXOs associated with a given address from the backend API and applies fixes to include any extra UTXOs that are currently in the process of being used in transactions but not yet confirmed on the blockchain.
 *
 * @param addr The address for which to fetch the UTXOs.
 * @returns A promise that resolves to an array of UTXO information objects.
 */
export async function getCardinalUtxos(addr: string): Promise<APIUtxoInfo[]> {
  const url = getBackendUrl(`cardinal_utxos/${addr}`)
  const response = await fetch(url)
  const json = await response.json()
  return fixCardinalUtxos(json.data, addr)
}

/**
 * This function gets the balance of a given address by fetching its UTXOs from the backend and summing
 * their values. It also applies fixes to include any extra UTXOs that are currently in the process of
 * being used in transactions but not yet confirmed on the blockchain.
 *
 * @param address The address for which to fetch the balance.
 * @returns The total balance of the address in satoshis.
 */
export async function getCardinalBalance(address: string): Promise<number> {
  const url = getBackendUrl(`cardinal_utxos/${address}`)
  const response = await fetch(url)
  const json = await response.json()
  json.data = fixCardinalUtxos(json.data, address)
  let totalBalance = 0
  for (let i = 0; i < json.data.length; i++) {
    totalBalance += json.data[i].value
  }
  return totalBalance
}

export interface AllBalanceDetails {
  confirmed_balance: number
  mempool_balance: number
}

/**
 * Fetches the balance details of a given address from the backend API, including both confirmed and mempool balances. It also applies fixes to include any extra UTXOs that are currently in the process of being used in transactions but not yet confirmed on the blockchain.
 *
 * @param addr The address for which to fetch the balance details.
 * @returns A promise that resolves to an object containing the confirmed balance and mempool balance of the address in satoshis.
 */
export async function getAllBalanceDetails(addr: string): Promise<AllBalanceDetails> {
  const url = getBackendUrl(`all_balance_details/${addr}`)
  const response = await fetch(url)
  const json = await response.json()
  return json
}

/**
 * Represents the structure of UTXO information returned by the backend API for ordinal UTXOs. It includes details such as the address, amounts, block height, inscription IDs, rune IDs, satpoints, script, script type, transaction fee, transaction ID, UTXO identifier, value, vout index, and virtual size of the UTXO.
 */
export interface APIOrdinalUtxoInfo {
  address: string
  amounts: number[] | null
  block_height: number | null
  inscription_ids: string[]
  rune_ids: string[] | null
  satpoints: string[]
  script: string
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
  txfee: number | null
  txid: string
  utxo: string
  value: number
  vout: number
  vsize: number | null
}
/**
 *
 * @param addr
 */
export async function get_ordinal_utxos(addr: string): Promise<APIOrdinalUtxoInfo[]> {
  const url = getBackendUrl(`ordinal_utxos/${addr}`)
  const response = await fetch(url)
  const json = await response.json()
  return fixOrdinalUtxos(json.data, addr)
}

/**
 *
 * @param txid
 */
export async function get_txhex(txid: string) {
  if (!txHexByIdCache[txid]) {
    const url = getBackendUrl(`gettxhex/${txid}`)
    txHexByIdCache[txid] = await fetch(url).then(response => response.json())
  }

  return txHexByIdCache[txid]
}

/**
 *
 * @param tx_hexes
 */
export async function validateTxes(tx_hexes: string[]) {
  try {
    const url = getBackendUrl(`testmempoolaccept`)
    const response1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txhexes: currentExtraTxHexes.concat(tx_hexes) }),
    })
    return await response1.json()
  }
  catch {
    return null
  }
}

/**
 *
 * @param tx_hexes
 */
export async function broadcast_txes(tx_hexes: string[]) {
  if (currentExtraTxHexes.length > 0) {
    throw new Error('Cannot broadcast txes when extra txes are set')
  }

  try {
    const url = getBackendUrl(`sendrawtransactions`)
    const response1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txhexes: tx_hexes }),
    })
    return await response1.json()
  }
  catch {
    return null
  }
}

/**
 *
 * @param message
 * @param signature_hex
 * @param address
 */
export async function verify_signature(
  message: string,
  signature_hex: string,
  address: string,
): Promise<boolean> {
  try {
    const url = getBackendUrl(`brc20_verify_bip322`)
    const network = getBitcoinNetwork()
    const response1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message_hex: Buffer.from(message).toString('hex'),
        signature_hex,
        pkscript_hex: bitcoinjs.address.toOutputScript(address, network).toString('hex'),
      }),
    })
    const result = await response1.json()
    return result.verified
  }
  catch {
    throw new Error('Failed to verify signature.')
  }
}
/**
 *
 * @param message
 * @param signature_hex
 * @param address
 */
export function verify_signature_local(
  message: string,
  signature_hex: string,
  address: string,
): boolean {
  try {
    const validity = Verifier.verifySignature(
      address,
      message,
      Buffer.from(signature_hex, 'hex').toString('base64'),
    )
    return validity
  }
  catch {
    throw new Error('Failed to verify signature.')
  }
}

/**
 *
 */
export async function get_chain_tip(): Promise<number> {
  try {
    const url = getBackendUrl(`get_chain_tip`)
    const response1 = await fetch(url)
    const result = await response1.json()
    return result
  }
  catch {
    throw new Error('Failed to get chain tip.')
  }
}
