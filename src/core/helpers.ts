import type { Endpoints } from './store-network'
import { Buffer } from 'node:buffer'
import { Verifier } from 'bip322-js'
import * as bitcoinjs from 'bitcoinjs-lib'
import * as varuint from 'varuint-bitcoin'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { BackendError, backendErrorFromBody, backendErrorFromResponse } from './backend-error'
import { evmEncodeFunctionCall } from './brc20'
import { getEndpoints, getNetwork } from './store-network'

export const txHexByIdCache: { [txid: string]: any } = {}
let currentExtraTxHexes: string[] = []
let currentExtraInscriptions: string[] | null = null // [inscr_id, satpoint]

/**
 * Sequencer routes served by the `sequencerRead` endpoint: display reads that
 * tolerate a short lag. Every other sequencer route goes to `sequencer`.
 */
const SEQUENCER_READ_ROUTES = new Set([
  'get_tokens',
  'get_table_data',
  'volume',
  'klines',
  'tvl',
  'pair-activity',
  'recent-activity',
  'wallet-activity',
  'get_token_decimals',
])

/**
 * Returns the base URL configured for an endpoint on the selected network.
 *
 * @param key The endpoint to resolve.
 * @returns The base URL, without a trailing slash.
 * @throws {Error} If the selected network has no such endpoint configured.
 */
export function getEndpointBase(key: keyof Endpoints): string {
  const network = getNetwork()
  const base = getEndpoints(network)[key]
  if (!base) {
    throw new Error(`No '${key}' endpoint configured for ${network}; set one with setEndpoints()`)
  }
  return base.replace(/\/+$/, '')
}

/**
 * Picks the sequencer endpoint for a route: `sequencerRead` for display reads,
 * `sequencer` for writes and pre-sign reads.
 *
 * @param path The route path, optionally with a sub-path and query string.
 * @returns The endpoint key that serves the route.
 */
export function sequencerEndpointFor(path: string): 'sequencerRead' | 'sequencer' {
  const route = path.split(/[/?]/, 1)[0] ?? ''
  return SEQUENCER_READ_ROUTES.has(route) ? 'sequencerRead' : 'sequencer'
}

// `/v1/info` lookups, one per origin. A failed lookup is dropped so the next
// request retries it.
const serviceInfoByOrigin = new Map<string, Promise<{ network?: string }>>()

/**
 * Confirms that a `/v1` service reports the selected network. Fetches
 * `<origin>/v1/info` once per origin; bases whose path does not start with
 * `/v1` pass without a lookup.
 *
 * @param base The endpoint base URL.
 * @throws {Error} If the lookup fails or the service serves another network.
 */
async function assertServiceNetwork(base: string): Promise<void> {
  const url = new URL(base)
  if (!url.pathname.startsWith('/v1')) {
    return
  }
  let info = serviceInfoByOrigin.get(url.origin)
  if (!info) {
    info = fetchWithErrors<{ network?: string }>(new URL('/v1/info', url).toString(), {
      method: 'GET',
    })
    serviceInfoByOrigin.set(url.origin, info)
    info.catch(() => serviceInfoByOrigin.delete(url.origin))
  }
  let served: string | undefined
  try {
    served = (await info).network
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read ${url.origin}/v1/info: ${message}`)
  }
  const network = getNetwork()
  if (served !== network) {
    throw new Error(
      `Endpoint ${url.origin} serves '${served}', but the selected network is '${network}'`
    )
  }
}

/**
 * Builds the full URL for a route on a configured endpoint, after checking that
 * a `/v1` service serves the selected network.
 *
 * @param key The endpoint that serves the route.
 * @param path The route path, with any query string, relative to the endpoint base.
 * @returns The full URL.
 */
export async function getEndpointUrl(key: keyof Endpoints, path: string): Promise<string> {
  const base = getEndpointBase(key)
  await assertServiceNetwork(base)
  return `${base}/${path}`
}

/**
 * Builds the full URL for a swap sequencer route, routed to `sequencerRead` or
 * `sequencer` by {@link sequencerEndpointFor}.
 *
 * @param path The route path, with any query string.
 * @returns The full URL.
 */
export function getSwapBackendUrl(path: string): Promise<string> {
  return getEndpointUrl(sequencerEndpointFor(path), path)
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
  // Validate first: Buffer's hex parser silently drops invalid/odd input, so the
  // guard is what makes bad input throw rather than produce garbage.
  if (hexstring.length === 0 || hexstring.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hexstring)) {
    throw new Error('Invalid hex string')
  }
  return Buffer.from(hexstring, 'hex').toString('base64')
}

/**
 * Finalizes every input of a signed PSBT, skipping the given indexes. Throws if
 * an input cannot be finalized, so an incompletely-finalized (invalid) PSBT is
 * never extracted and broadcast.
 *
 * @param psbt The signed PSBT to finalize in place.
 * @param noSignIdxes Input indexes to skip (intentionally left unfinalized).
 */
export function finalizePsbtInputs(psbt: bitcoinjs.Psbt, noSignIdxes?: number[]): void {
  const skip = new Set(noSignIdxes)
  for (let i = 0; i < psbt.inputCount; i++) {
    if (skip.has(i)) {
      continue
    }
    // Already finalized upstream — skip it. Wallets that sign with
    // autoFinalized:true (unisat, okx) return finalized inputs, and the kit sets
    // finalScriptWitness directly on pre-signed script-path inputs. Re-finalizing
    // any of these throws ("No tapleaf script signature provided" on taproot),
    // because the partial-sig fields it would rebuild the witness from are gone.
    const input = psbt.data.inputs[i]
    if (input?.finalScriptWitness != null || input?.finalScriptSig != null) {
      continue
    }
    try {
      psbt.finalizeInput(i)
    } catch (e) {
      // Preserve the underlying reason in the message (Error `cause` needs a
      // newer TS lib target than this project uses).
      const reason = e instanceof Error ? e.message : String(e)
      throw new Error(`Failed to finalize PSBT input ${i}: ${reason}`)
    }
  }
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
  } else {
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
  if (currentExtraInscriptions == null) return false

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
  } catch {
    // continue
  }
  try {
    return bitcoinjs.payments.p2sh({ output, network })
  } catch {}
  try {
    return bitcoinjs.payments.p2wpkh({ output, network })
  } catch {}
  try {
    return bitcoinjs.payments.p2wsh({ output, network })
  } catch {}
  try {
    return bitcoinjs.payments.p2tr({ output, network })
  } catch {}

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
  network: any
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
  } else if (wallet.name === 'p2sh') {
    return 'scripthash'
  } else if (wallet.name === 'p2wpkh') {
    return 'witness_v0_keyhash'
  } else if (wallet.name === 'p2wsh') {
    return 'witness_v0_scripthash'
  } else if (wallet.name === 'p2tr') {
    return 'witness_v1_taproot'
  }

  throw new Error(`Unknown output type: ${wallet.name}`)
}

function fixCardinalUtxos(utxos: APIUtxoInfo[], addr: string): APIUtxoInfo[] {
  if (currentExtraTxHexes.length === 0) return utxos

  const network = getBitcoinNetwork()

  const newUtxos = []
  for (const utxo of utxos) {
    const utxoInner = utxo.utxo
    const txid = utxoInner.split(':')[0]!
    const vout = Number.parseInt(utxoInner.split(':')[1]!)
    if (checkIfUtxoUsedInExtras(txid, vout)) continue
    newUtxos.push(utxo)
  }
  for (const txhex of currentExtraTxHexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    const txid = tx.getId()
    for (let i = 0; i < tx.outs.length; i++) {
      const vout = tx.outs[i]!
      if (checkIfUtxoIsExtraOrdinal(txid, i)) continue
      if (checkIfUtxoUsedInExtras(txid, i)) continue

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
      } catch (e) {
        console.error(`Error processing output script for txid ${txid}, vout ${i}`)
        console.error(e)
      }
    }
  }

  return newUtxos
}

function fixOrdinalUtxos(utxos: APIOrdinalUtxoInfo[], addr: string): APIOrdinalUtxoInfo[] {
  if (currentExtraTxHexes.length === 0) return utxos

  const newUtxos = []
  for (const utxo of utxos) {
    const utxoInner = utxo.utxo
    const txid = utxoInner.split(':')[0]!
    const vout = Number.parseInt(utxoInner.split(':')[1]!)
    if (checkIfUtxoUsedInExtras(txid, vout)) continue
    newUtxos.push(utxo)
  }
  newUtxos.push(...getExtraOrdinalUtxos(addr))

  return newUtxos
}

/**
 * Returns the ordinal UTXOs that the saved extra transactions create for `addr`: the
 * output carrying the saved extra inscription, unless another extra transaction spends it.
 * These are the entries `getOrdinalUtxos` appends to the backend's list.
 *
 * @param addr The address the inscription output must pay to.
 * @returns The extra ordinal UTXOs for `addr`, empty when no extras are saved.
 */
export function getExtraOrdinalUtxos(addr: string): APIOrdinalUtxoInfo[] {
  if (currentExtraTxHexes.length === 0) return []

  const network = getBitcoinNetwork()

  const newUtxos = []
  for (const txhex of currentExtraTxHexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    const txid = tx.getId()

    for (let i = 0; i < tx.outs.length; i++) {
      const vout = tx.outs[i]!
      if (!checkIfUtxoIsExtraOrdinal(txid, i)) continue
      if (checkIfUtxoUsedInExtras(txid, i)) continue

      const inscriptionId = currentExtraInscriptions ? currentExtraInscriptions[0] : null
      const satpoint = currentExtraInscriptions ? currentExtraInscriptions[1] : null
      if (!inscriptionId || !satpoint) continue

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
      } catch (e) {
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
 * @param fetchedUtxos A response from `fetchCardinalUtxos(addr)` to use in place of a new fetch. Each call works on its own copy, since coin selection sorts and splices the list it is given.
 * @returns A promise that resolves to an array of UTXO information objects.
 */
export async function getCardinalUtxos(
  addr: string,
  fetchedUtxos?: APIUtxoInfo[]
): Promise<APIUtxoInfo[]> {
  const utxos = fetchedUtxos ? structuredClone(fetchedUtxos) : await fetchCardinalUtxos(addr)
  return fixCardinalUtxos(utxos, addr)
}

/**
 * Fetches the backend's cardinal UTXO list for an address as served, without the saved extra UTXOs applied. A dry run that prices several transactions fetches this once and passes it to each `getCardinalUtxos` call.
 *
 * @param addr The address for which to fetch the UTXOs.
 * @returns A promise that resolves to the backend's array of UTXO information objects.
 */
export async function fetchCardinalUtxos(addr: string): Promise<APIUtxoInfo[]> {
  const url = await getEndpointUrl('indexer', `cardinal_utxos/${addr}`)
  const json = await fetchWithErrors<{ data: APIUtxoInfo[] }>(url, { method: 'GET' })
  return json.data
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
  const url = await getEndpointUrl('indexer', `cardinal_utxos/${address}`)
  const json = await fetchWithErrors<{ data: APIUtxoInfo[] }>(url, { method: 'GET' })
  const utxos = fixCardinalUtxos(json.data, address)
  let totalBalance = 0
  for (const utxo of utxos) {
    totalBalance += utxo.value
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
  const url = await getEndpointUrl('indexer', `all_balance_details/${addr}`)
  return fetchWithErrors<AllBalanceDetails>(url, { method: 'GET' })
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
 * Fetches the ordinal UTXOs associated with a given address from the backend API and applies fixes to include any extra UTXOs that are currently in the process of being used in transactions but not yet confirmed on the blockchain.
 *
 * @param addr The address for which to fetch the ordinal UTXOs.
 *
 * @returns A promise that resolves to an array of ordinal UTXO information objects.
 */
export async function getOrdinalUtxos(addr: string): Promise<APIOrdinalUtxoInfo[]> {
  const url = await getEndpointUrl('indexer', `ordinal_utxos/${addr}`)
  const json = await fetchWithErrors<{ data: APIOrdinalUtxoInfo[] }>(url, { method: 'GET' })
  return fixOrdinalUtxos(json.data, addr)
}

/**
 * Fetches the raw transaction hex for a given transaction ID from the backend API. It caches the result to avoid redundant network requests.
 *
 * @param txid The transaction ID for which to fetch the raw transaction hex.
 * @returns A promise that resolves to the raw transaction hex string.
 */
export async function getTxhex(txid: string): Promise<string> {
  if (!txHexByIdCache[txid]) {
    const url = await getEndpointUrl('indexer', `gettxhex/${txid}`)
    txHexByIdCache[txid] = await fetchWithErrors<string>(url, { method: 'GET' })
  }

  return txHexByIdCache[txid]
}

/**
 * Validates a list of transaction hexes by sending them to the backend API for testing their acceptance into the mempool. The function combines the provided transaction hexes with any currently saved extra transaction hexes and sends them to the backend for validation.
 *
 * @param txHexes An array of transaction hex strings representing the transactions to be validated.
 * @returns A promise that resolves to the validation result returned by the backend API, or null if the validation request fails.
 */
export async function validateTxes(txHexes: string[]) {
  const url = await getEndpointUrl('tx', `testmempoolaccept`)
  try {
    const response1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txhexes: currentExtraTxHexes.concat(txHexes) }),
    })
    return await response1.json()
  } catch {
    return null
  }
}

/**
 * Broadcasts a list of transaction hexes to the network by sending them to the backend API. The function throws an error if there are any extra transaction hexes currently set, as broadcasting is not allowed in that state.
 *
 * @param txHexes An array of transaction hex strings representing the transactions to be broadcasted.
 * @returns A promise that resolves to the result of the broadcast request returned by the backend API, or null if the broadcast request fails.
 * @throws An error if there are extra transaction hexes currently set, as broadcasting is not allowed in that state.
 */
export async function broadcastTxes(txHexes: string[]) {
  if (currentExtraTxHexes.length > 0) {
    throw new Error('Cannot broadcast txes when extra txes are set')
  }

  const url = await getEndpointUrl('tx', `sendrawtransactions`)
  try {
    const response1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txhexes: txHexes }),
    })
    return await response1.json()
  } catch {
    return null
  }
}

/**
 * Verifies a signature for a given message, signature, and address by sending the verification request to the backend API. The function constructs the necessary parameters for the verification request, including converting the message to hexadecimal format and generating the pkscript from the provided address, and then sends the request to the backend for verification.
 *
 * @param message The message for which the signature needs to be verified.
 * @param signatureHex The signature in hexadecimal format that needs to be verified against the message and address.
 * @param address The Bitcoin address that is claimed to have produced the signature for the given message.
 * @returns A promise that resolves to a boolean indicating whether the signature is valid for the given message and address, or throws an error if the verification process fails.
 * @throws An error if the verification process fails, such as due to network issues or invalid input parameters.
 */
export async function verifySignature(
  message: string,
  signatureHex: string,
  address: string
): Promise<boolean> {
  const url = await getEndpointUrl('indexer', `brc20_verify_bip322`)
  try {
    const network = getBitcoinNetwork()
    const response1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message_hex: Buffer.from(message).toString('hex'),
        signature_hex: signatureHex,
        pkscript_hex: bitcoinjs.address.toOutputScript(address, network).toString('hex'),
      }),
    })
    const result = await response1.json()
    return result.verified
  } catch {
    throw new Error('Failed to verify signature.')
  }
}
/**
 * Locally verifies a signature for a given message, signature, and address using the bip322-js library. The function converts the signature from hexadecimal to base64 format and then uses the Verifier class from the bip322-js library to perform the verification against the provided message and address.
 *
 * @param message The message for which the signature needs to be verified.
 * @param signatureHex The signature in hexadecimal format that needs to be verified against the message and address.
 * @param address The Bitcoin address that is claimed to have produced the signature for the given message.
 * @returns A boolean indicating whether the signature is valid for the given message and address.
 * @throws An error if the verification process fails, such as due to invalid input parameters.
 */
export function verifySignatureLocal(
  message: string,
  signatureHex: string,
  address: string
): boolean {
  try {
    const validity = Verifier.verifySignature(
      address,
      message,
      Buffer.from(signatureHex, 'hex').toString('base64')
    )
    return validity
  } catch {
    throw new Error('Failed to verify signature.')
  }
}

/**
 * Fetches a backend JSON route.
 *
 * @param url The URL to fetch.
 * @param options The standard RequestInit options for the fetch call.
 * @returns A promise that resolves with the parsed JSON data of type T.
 * @throws {BackendError} When the request does not complete, the HTTP status is not ok, the body
 * is not JSON, or the body carries an `error` field. It holds the status and the backend's `code`.
 */
export async function fetchWithErrors<T>(url: string, options: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, options)
  } catch (error) {
    throw new BackendError(
      error instanceof Error ? error.message : String(error),
      undefined,
      undefined,
      url
    )
  }

  if (!response.ok) throw await backendErrorFromResponse(response, url)

  let data: any
  try {
    data = await response.json()
  } catch (error) {
    throw new BackendError(
      error instanceof Error ? error.message : String(error),
      response.status,
      undefined,
      url
    )
  }

  // An API-level error inside a 2xx response.
  if (data && data.error) throw backendErrorFromBody(data, response.status, url)

  return data as T
}

/**
 * Retrieves the BRC2.0 JSON-RPC URL configured as the `rpc` endpoint for the selected network.
 *
 * @returns The RPC URL.
 * @throws {Error} If the selected network has no RPC endpoint configured.
 */
export async function getPublicRpcUrl(): Promise<string> {
  const base = getEndpointBase('rpc')
  await assertServiceNetwork(base)
  return base
}

/**
 * Executes an eth_call on the BRC2.0 RPC configured for the selected network. The function constructs the JSON-RPC request payload with the provided data and sends it to the RPC URL for execution. It returns a promise that resolves to the result of the eth_call, or throws an error if the request fails.
 *
 * @param to The address of the contract to call.
 * @param abi The ABI of the contract to call.
 * @param functionName The name of the function to call on the contract.
 * @param params The parameters to pass to the function being called on the contract.
 * @returns A promise that resolves to the result of the eth_call as a string, or throws an error if the request fails.
 */
export async function ethCallOnPublicRpc(
  to: string,
  abi: any,
  functionName: string,
  params: any
): Promise<string> {
  const url = await getPublicRpcUrl()
  const data = evmEncodeFunctionCall(abi, functionName, params)

  return fetchWithErrors<{ result: string }>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.random().toString(16).slice(2),
      method: 'eth_call',
      params: [
        {
          to,
          data,
        },
        'latest',
      ],
    }),
  }).then(response => response.result)
}
