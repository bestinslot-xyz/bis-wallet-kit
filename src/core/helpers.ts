import { Buffer } from 'node:buffer'
import { Verifier } from 'bip322-js'
import * as varuint from 'varuint-bitcoin'
import { bitcoinjs, getBitcoinNetwork } from '../lib/bitcoin'
import { getNetwork } from '../main'

export const txHexByIdCache: { [txid: string]: any } = {}
let _current_extra_txhexes: string[] = []
let _current_extra_inscr: string[] | null = null // [inscr_id, satpoint]

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

export function createUnsecuredToken(payload: any) {
  const header = { typ: 'JWT', alg: 'none' }

  return `${createSigningInput(payload, header)}.`
}

export function base64ToHex(str: string) {
  const raw = atob(str)
  let result = ''
  for (let i = 0; i < raw.length; i++) {
    const hex = raw.charCodeAt(i).toString(16)
    result += (hex.length === 2 ? hex : `0${hex}`)
  }
  return result.toLowerCase()
}

export function hexToBase64(hexstring: string) {
  const matches = hexstring.match(/\w{2}/g)
  if (!matches) {
    throw new Error('Invalid hex string')
  }
  return btoa(matches.map((a) => {
    return String.fromCharCode(Number.parseInt(a, 16))
  }).join(''))
}

export function save_extra_utxos(tx_hexes: string[], inscription: string[] | null) {
  _current_extra_txhexes = []

  for (let i = 0; i < tx_hexes.length; i++) {
    _current_extra_txhexes.push(tx_hexes[i]!)
    const txid = bitcoinjs.Transaction.fromHex(tx_hexes[i]!).getId()
    txHexByIdCache[txid] = tx_hexes[i]
  }
  if (inscription != null) {
    _current_extra_inscr = inscription.slice()
  }
  else {
    _current_extra_inscr = null
  }
}

export function clear_extra_utxos() {
  _current_extra_txhexes = []
  _current_extra_inscr = null
}

function check_if_utxo_used_in_extras(txid: string, vout: number) {
  for (const txhex of _current_extra_txhexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)

    for (const vin of tx.ins) {
      const vin_txid = vin.hash.reverse().toString('hex')
      const vin_vout = vin.index

      if (vin_txid === txid && vin_vout === vout) {
        return true
      }
    }
  }
  return false
}

function check_if_utxo_is_extra_ordinal(txid: string, vout: number) {
  if (_current_extra_inscr == null)
    return false

  const inscr_txid = _current_extra_inscr[1]!.split(':')[0]
  const inscr_vout = Number.parseInt(_current_extra_inscr[1]!.split(':')[1]!)

  if (inscr_txid === txid && inscr_vout === vout) {
    return true
  }

  return false
}

function bitcoinjs_wallet_fromOutputScript(output: any, network: any) {
  network = network || bitcoinjs.networks.bitcoin

  try {
    return bitcoinjs.payments.p2pkh({ output, network })
  }
  // eslint-disable-next-line unused-imports/no-unused-vars
  catch (e) {}
  try {
    return bitcoinjs.payments.p2sh({ output, network })
  }
  // eslint-disable-next-line unused-imports/no-unused-vars
  catch (e) {}
  try {
    return bitcoinjs.payments.p2wpkh({ output, network })
  }
  // eslint-disable-next-line unused-imports/no-unused-vars
  catch (e) {}
  try {
    return bitcoinjs.payments.p2wsh({ output, network })
  }
  // eslint-disable-next-line unused-imports/no-unused-vars
  catch (e) {}
  try {
    return bitcoinjs.payments.p2tr({ output, network })
  }
  // eslint-disable-next-line unused-imports/no-unused-vars
  catch (e) {}

  throw new Error(`${bitcoinjs.script.toASM(output)} has no matching Address`)
}

export function utxo_output_type_from_outputScript(output: any, network: any): 'pubkeyhash' | 'scripthash' | 'witness_v0_keyhash' | 'witness_v0_scripthash' | 'witness_v1_taproot' | 'pubkey' | 'anchor' | 'witness_unknown' | 'nulldata' | 'multisig' | 'nonstandard' {
  const wallet = bitcoinjs_wallet_fromOutputScript(output, network)

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

function fix_cardinal_utxos(utxos: APIUtxoInfo[], addr: string): APIUtxoInfo[] {
  if (_current_extra_txhexes.length === 0)
    return utxos

  const network = getBitcoinNetwork()

  const new_utxos = []
  for (const utxo of utxos) {
    const utxo_ = utxo.utxo
    const txid = utxo_.split(':')[0]!
    const vout = Number.parseInt(utxo_.split(':')[1]!)
    if (check_if_utxo_used_in_extras(txid, vout))
      continue
    new_utxos.push(utxo)
  }
  for (const txhex of _current_extra_txhexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    const txid = tx.getId()
    for (let i = 0; i < tx.outs.length; i++) {
      const vout = tx.outs[i]!
      if (check_if_utxo_is_extra_ordinal(txid, i))
        continue
      if (check_if_utxo_used_in_extras(txid, i))
        continue

      try { // vout.script might be an OP_RETURN or a script without wallet address so this part may fail which is ok
        const vout_addr = bitcoinjs.address.fromOutputScript(vout.script, network)
        if (vout_addr === addr) {
          const utxo: APIUtxoInfo = {
            address: addr,
            amounts: null,
            block_height: null,
            inscription_ids: null,
            rune_ids: null,
            satpoints: null,
            script: tx.outs[i]!.script.toString('hex'),
            script_type: utxo_output_type_from_outputScript(vout.script, network),
            txfee: null,
            txid,
            utxo: `${txid}:${i}`,
            value: vout.value,
            vout: i,
            vsize: null,
          }
          new_utxos.push(utxo)
        }
      }
      catch (e) {
        console.error(`Error processing output script for txid ${txid}, vout ${i}`)
        console.error(e)
      }
    }
  }

  return new_utxos
}

function fix_ordinal_utxos(utxos: APIOrdinalUtxoInfo[], addr: string): APIOrdinalUtxoInfo[] {
  if (_current_extra_txhexes.length === 0)
    return utxos

  const network = getBitcoinNetwork()

  const new_utxos = []
  for (const utxo of utxos) {
    const utxo_ = utxo.utxo
    const txid = utxo_.split(':')[0]!
    const vout = Number.parseInt(utxo_.split(':')[1]!)
    if (check_if_utxo_used_in_extras(txid, vout))
      continue
    new_utxos.push(utxo)
  }
  for (const txhex of _current_extra_txhexes) {
    const tx = bitcoinjs.Transaction.fromHex(txhex)
    const txid = tx.getId()

    for (let i = 0; i < tx.outs.length; i++) {
      const vout = tx.outs[i]!
      if (!check_if_utxo_is_extra_ordinal(txid, i))
        continue
      if (check_if_utxo_used_in_extras(txid, i))
        continue

      const inscr_id = _current_extra_inscr ? _current_extra_inscr[0] : null
      const satpoint = _current_extra_inscr ? _current_extra_inscr[1] : null
      if (!inscr_id || !satpoint)
        continue

      try { // vout.script might be an OP_RETURN or a script without wallet address so this part may fail which is ok
        const vout_addr = bitcoinjs.address.fromOutputScript(vout.script, network)
        if (vout_addr === addr) {
          const utxo: APIOrdinalUtxoInfo = {
            address: addr,
            amounts: null,
            block_height: null,
            inscription_ids: [inscr_id],
            rune_ids: null,
            satpoints: [satpoint],
            script: tx.outs[i]!.script.toString('hex'),
            script_type: utxo_output_type_from_outputScript(vout.script, network),
            txfee: null,
            txid,
            utxo: `${txid}:${i}`,
            value: vout.value,
            vout: i,
            vsize: null,
          }

          new_utxos.push(utxo)
        }
      }
      catch (e) {
        console.error(`Error processing output script for txid ${txid}, vout ${i}`)
        console.error(e)
      }
    }
  }

  return new_utxos
}

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
  script_type: 'pubkeyhash' | 'scripthash' | 'witness_v0_keyhash' | 'witness_v0_scripthash' | 'witness_v1_taproot' | 'pubkey' | 'anchor' | 'witness_unknown' | 'nulldata' | 'multisig' | 'nonstandard'
  txfee: number | null
  txid: string
  utxo: string
  value: number
  vout: number
  vsize: number | null
}
export async function get_cardinal_utxos(addr: string): Promise<APIUtxoInfo[]> {
  const url = getBackendUrl(`cardinal_utxos/${addr}`)
  const response = await fetch(url)
  const json = await response.json()
  return fix_cardinal_utxos(json.data, addr)
}

// get_cardinal_balance
export async function getCardinalBalance(addr: string): Promise<number> {
  const url = getBackendUrl(`cardinal_utxos/${addr}`)
  const response = await fetch(url)
  const json = await response.json()
  json.data = fix_cardinal_utxos(json.data, addr)
  let total_balance = 0
  for (let i = 0; i < json.data.length; i++) {
    total_balance += json.data[i].value
  }
  return total_balance
}

export interface AllBalanceDetails {
  confirmed_balance: number
  mempool_balance: number
}
export async function getAllBalanceDetails(addr: string): Promise<AllBalanceDetails> {
  const url = getBackendUrl(`all_balance_details/${addr}`)
  const response = await fetch(url)
  const json = await response.json()
  return json
}

export interface APIOrdinalUtxoInfo {
  address: string
  amounts: number[] | null
  block_height: number | null
  inscription_ids: string[]
  rune_ids: string[] | null
  satpoints: string[]
  script: string
  script_type: 'pubkeyhash' | 'scripthash' | 'witness_v0_keyhash' | 'witness_v0_scripthash' | 'witness_v1_taproot' | 'pubkey' | 'anchor' | 'witness_unknown' | 'nulldata' | 'multisig' | 'nonstandard'
  txfee: number | null
  txid: string
  utxo: string
  value: number
  vout: number
  vsize: number | null
}
export async function get_ordinal_utxos(addr: string): Promise<APIOrdinalUtxoInfo[]> {
  const url = getBackendUrl(`ordinal_utxos/${addr}`)
  const response = await fetch(url)
  const json = await response.json()
  return fix_ordinal_utxos(json.data, addr)
}

export async function get_txhex(txid: string) {
  if (!txHexByIdCache[txid]) {
    const url = getBackendUrl(`gettxhex/${txid}`)
    txHexByIdCache[txid] = await fetch(url).then(response => response.json())
  }

  return txHexByIdCache[txid]
}

export async function check_txes(tx_hexes: string[]) {
  try {
    const url = getBackendUrl(`testmempoolaccept`)
    const response1 = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txhexes: _current_extra_txhexes.concat(tx_hexes) }),
    })
    return await response1.json()
  }
  catch {
    return null
  }
}

export async function broadcast_txes(tx_hexes: string[]) {
  if (_current_extra_txhexes.length > 0) {
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

export async function verify_signature(message: string, signature_hex: string, address: string): Promise<boolean> {
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
export function verify_signature_local(message: string, signature_hex: string, address: string): boolean {
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
