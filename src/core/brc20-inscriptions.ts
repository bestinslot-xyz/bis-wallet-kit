import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { InscriptionDetails } from '../types/inscription'

// Pure builders for base BRC-20 inscription payloads (deploy / mint / transfer,
// and the 6-byte namespace predeploy → deploy pair). These only *generate* the
// inscription content; the caller inscribes them with the existing `inscribe` /
// `inscribeWithParent` helpers and drives any block-waiting itself.
//
// Ticker sizing rules (see the 6-byte namespace proposal):
//   - 4 bytes  → standard, free to mint for all (no `self_mint`)
//   - 5 bytes  → self-issuance token (`self_mint: "true"` is mandatory)
//   - 6 bytes  → namespaced, requires a predeploy/reveal with a salted hash;
//                the ticker must match /^[A-Za-z0-9-]{6}$/
//
// The BRC-20 content type follows this repo's existing convention (`text/plain`).

const MIME_TYPE = 'text/plain'
const SIX_BYTE_TICKER_RE = /^[a-z0-9-]{6}$/i
const HEX_RE = /^(?:[0-9a-f]{2})+$/i

/**
 * Options shared by the deploy builders.
 *
 * @property tick - The BRC-20 ticker. 4 or 5 bytes for {@link deployBrc20Inscription}; 6 bytes for {@link predeployInscriptions}.
 * @property max - Maximum supply, as a string (BRC-20 amounts are strings).
 * @property lim - Optional per-mint limit, as a string.
 * @property dec - Optional decimals, as a string or number (serialised as a string).
 * @property selfMint - Optional override for the `self_mint` field. 5-byte tickers force `true`; 4-byte tickers default to omitting it unless set to `true`.
 */
export interface Brc20DeployOptions {
  tick: string
  max: string
  lim?: string
  dec?: string | number
  selfMint?: boolean
}

/**
 * Options for {@link mintBrc20Inscription} and {@link transferBrc20Inscription}.
 *
 * @property tick - The BRC-20 ticker (4-6 bytes).
 * @property amt - The amount, as a string (BRC-20 amounts are strings).
 */
export interface Brc20AmountOptions {
  tick: string
  amt: string
}

/**
 * Options for {@link predeployInscriptions}.
 *
 * @property tick - The 6-byte namespaced ticker (must match /^[A-Za-z0-9-]{6}$/).
 * @property address - The deployer's Bitcoin address. Its output script (pkscript) is derived on the current network and bound into the commitment hash, so this must be the address that will receive the deploy reveal.
 * @property salt - Optional hex salt. Generated automatically when omitted.
 * @property max - Maximum supply, as a string.
 * @property lim - Optional per-mint limit, as a string.
 * @property dec - Optional decimals, as a string or number.
 */
export interface Brc20PredeployOptions {
  tick: string
  address: string
  salt?: string
  max: string
  lim?: string
  dec?: string | number
}

/**
 * Result of {@link predeployInscriptions}: the salt/hash used and both ready-to-inscribe payloads.
 *
 * @property salt - The hex salt used (echo of the input, or the auto-generated value). Keep it: the deploy reveal must reuse the same salt.
 * @property hash - The `double_sha256(tick + salt + pkscript)` hex committed to by the predeploy.
 * @property predeploy - The predeploy inscription (inscribe first).
 * @property deploy - The matching deploy inscription (inscribe as a child of the predeploy after the required block delay).
 */
export interface Brc20PredeployResult {
  salt: string
  hash: string
  predeploy: InscriptionDetails
  deploy: InscriptionDetails
}

function tickByteLength(tick: string): number {
  if (typeof tick !== 'string' || tick.length === 0)
    throw new Error('tick must be a non-empty string')
  return Buff.str(tick).length
}

function assertHex(value: string, label: string): void {
  if (typeof value !== 'string' || !HEX_RE.test(value))
    throw new Error(`${label} must be a non-empty hex string`)
}

function assertAmountString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string`)
}

function toInscription(payload: Record<string, string>): InscriptionDetails {
  return new InscriptionDetails(
    Buff.str(MIME_TYPE),
    null,
    null,
    null,
    null,
    Buff.str(JSON.stringify(payload)),
  )
}

function buildDeployPayload(
  opts: Brc20DeployOptions,
  byteLen: number,
  salt: string | null,
): Record<string, string> {
  assertAmountString(opts.max, 'max')
  if (opts.lim != null)
    assertAmountString(opts.lim, 'lim')

  // 5-byte tickers are self-issuance and must carry self_mint. A 6-byte ticker
  // (identified by a salt) is likewise self-mintable per the namespace proposal.
  const requiresSelfMint = byteLen === 5 || salt != null
  if (requiresSelfMint && opts.selfMint === false)
    throw new Error(`${byteLen}-byte tickers are self-issuance tokens; self_mint cannot be disabled`)
  const selfMint = requiresSelfMint || opts.selfMint === true

  const payload: Record<string, string> = { p: 'brc-20', op: 'deploy', tick: opts.tick }
  if (salt != null)
    payload.salt = salt
  payload.max = opts.max
  if (opts.lim != null)
    payload.lim = opts.lim
  if (opts.dec != null)
    payload.dec = String(opts.dec)
  if (selfMint)
    payload.self_mint = 'true'

  return payload
}

/**
 * Build a BRC-20 `deploy` inscription for a 4- or 5-byte ticker.
 *
 * 4-byte tickers are free to mint (no `self_mint`); 5-byte tickers are
 * self-issuance and always carry `self_mint: "true"`. For 6-byte namespaced
 * tickers use {@link predeployInscriptions} instead.
 *
 * @param opts - See {@link Brc20DeployOptions}.
 * @returns An {@link InscriptionDetails} ready to pass to `inscribe`.
 * @throws If the ticker is not 4 or 5 bytes, if a 6-byte ticker is supplied, or if `self_mint` is disabled for a 5-byte ticker.
 */
export function deployBrc20Inscription(opts: Brc20DeployOptions): InscriptionDetails {
  const byteLen = tickByteLength(opts.tick)
  if (byteLen === 6)
    throw new Error('6-byte tickers require a predeploy; use predeployInscriptions()')
  if (byteLen !== 4 && byteLen !== 5)
    throw new Error(`deploy ticker must be 4 or 5 bytes, got ${byteLen}`)
  return toInscription(buildDeployPayload(opts, byteLen, null))
}

/**
 * Build a BRC-20 `mint` inscription.
 *
 * @param opts - See {@link Brc20AmountOptions}.
 * @returns An {@link InscriptionDetails} ready to pass to `inscribe`.
 * @throws If the ticker is not 4-6 bytes or the amount is not a non-empty string.
 */
export function mintBrc20Inscription(opts: Brc20AmountOptions): InscriptionDetails {
  const byteLen = tickByteLength(opts.tick)
  if (byteLen < 4 || byteLen > 6)
    throw new Error(`ticker must be 4-6 bytes, got ${byteLen}`)
  assertAmountString(opts.amt, 'amt')
  return toInscription({ p: 'brc-20', op: 'mint', tick: opts.tick, amt: opts.amt })
}

/**
 * Build a BRC-20 `transfer` inscription.
 *
 * @param opts - See {@link Brc20AmountOptions}.
 * @returns An {@link InscriptionDetails} ready to pass to `inscribe`.
 * @throws If the ticker is not 4-6 bytes or the amount is not a non-empty string.
 */
export function transferBrc20Inscription(opts: Brc20AmountOptions): InscriptionDetails {
  const byteLen = tickByteLength(opts.tick)
  if (byteLen < 4 || byteLen > 6)
    throw new Error(`ticker must be 4-6 bytes, got ${byteLen}`)
  assertAmountString(opts.amt, 'amt')
  return toInscription({ p: 'brc-20', op: 'transfer', tick: opts.tick, amt: opts.amt })
}

/**
 * Generate a random hex salt for a 6-byte namespace predeploy.
 *
 * @param byteLength - Number of random bytes (default 16). The returned hex string is twice this length.
 * @returns A lowercase hex string.
 */
export function generateBrc20Salt(byteLength = 16): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0)
    throw new Error('byteLength must be a positive integer')
  return Buff.random(byteLength).hex
}

/**
 * Derive an address's output script (pkscript) on the current network.
 *
 * @param address - The Bitcoin address to convert.
 * @returns The output script as a lowercase hex string.
 */
function addressToPkscript(address: string): string {
  if (typeof address !== 'string' || address.length === 0)
    throw new Error('address must be a non-empty string')
  return bitcoinjs.address.toOutputScript(address, getBitcoinNetwork()).toString('hex')
}

/**
 * Compute the predeploy commitment hash for a 6-byte namespace ticker.
 *
 * The preimage is `utf8(tick) ++ hexDecode(salt) ++ hexDecode(pkscript)`, and
 * the hash is `sha256(sha256(preimage))`. The pkscript binds the commitment to
 * the deployer, preventing cross-wallet replay.
 *
 * @param tick - The 6-byte namespaced ticker (must match /^[A-Za-z0-9-]{6}$/).
 * @param salt - The salt, as a hex string.
 * @param pkscript - The deployer's output script, as a hex string.
 * @returns The commitment hash, as a lowercase hex string.
 * @throws If the ticker is not a valid 6-byte namespaced ticker, or the salt/pkscript is not valid hex.
 */
export function computeBrc20PredeployHash(tick: string, salt: string, pkscript: string): string {
  if (typeof tick !== 'string' || !SIX_BYTE_TICKER_RE.test(tick))
    throw new Error('6-byte ticker must match /^[A-Za-z0-9-]{6}$/')
  assertHex(salt, 'salt')
  assertHex(pkscript, 'pkscript')
  const preimage = Buffer.concat([
    Buffer.from(tick, 'utf8'),
    Buffer.from(salt, 'hex'),
    Buffer.from(pkscript, 'hex'),
  ])
  return bitcoinjs.crypto.hash256(preimage).toString('hex')
}

/**
 * Build the predeploy + deploy inscription pair for a 6-byte namespace ticker.
 *
 * Inscribe the returned `predeploy` first, wait the required number of blocks,
 * then inscribe `deploy` as a child of the predeploy inscription (e.g. via
 * `inscribeWithParent(result.deploy, predeployInscriptionId, …)`). The salt is
 * generated automatically unless supplied, and is echoed back so the pair stays
 * consistent.
 *
 * @param opts - See {@link Brc20PredeployOptions}.
 * @returns The salt, commitment hash, and both {@link InscriptionDetails} payloads.
 * @throws If the ticker is not a valid 6-byte namespaced ticker, the address is invalid, or the salt is not valid hex.
 */
export function predeployInscriptions(opts: Brc20PredeployOptions): Brc20PredeployResult {
  if (typeof opts.tick !== 'string' || !SIX_BYTE_TICKER_RE.test(opts.tick))
    throw new Error('6-byte ticker must match /^[A-Za-z0-9-]{6}$/')

  const pkscript = addressToPkscript(opts.address)

  const salt = opts.salt ?? generateBrc20Salt()
  assertHex(salt, 'salt')

  const hash = computeBrc20PredeployHash(opts.tick, salt, pkscript)

  const deployPayload = buildDeployPayload(
    { tick: opts.tick, max: opts.max, lim: opts.lim, dec: opts.dec },
    6,
    salt,
  )

  return {
    salt,
    hash,
    predeploy: toInscription({ p: 'brc-20', op: 'predeploy', hash }),
    deploy: toInscription(deployPayload),
  }
}
