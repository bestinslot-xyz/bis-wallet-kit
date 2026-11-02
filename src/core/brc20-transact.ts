import type { InscriptionDetails } from '../types/inscription'
import type { Brc20SendPart, Brc20SendQuote } from './brc20-send'
import type { SignProgressOptions } from './sign-progress'
import { ethers } from 'ethers'
import { textInscription } from '../types/inscription'
import { compressSmartContractData } from './brc20'
import { assertFeeRate, GAS_PER_BYTE, opReturnTarget, runChain } from './brc20-send'
import { getBrc20RpcProvider } from './chain-providers'
import { getNetwork } from './store-network'

/** Largest inscription content, in bytes, a transact inscription may be padded to. */
export const MAX_TRANSACT_CONTENT_BYTES = 350_000

/** The BRC2.0 module keeps a transaction whose nonce is below account nonce + this value. */
const MAX_FUTURE_NONCES = 10

const MAINNET_CHAIN_ID = 0x4252433230n
const TEST_CHAIN_ID = 0x425243323073n

/** The BRC2.0 EVM chain ID of the current network (signet and testnet share one). */
export function getBrc20ProgChainId(): bigint {
  return getNetwork() === 'mainnet' ? MAINNET_CHAIN_ID : TEST_CHAIN_ID
}

/** Lowercase hex without a `0x`/`0X` prefix. */
function normalizeHex(rawTx: string): string {
  return (rawTx.startsWith('0x') || rawTx.startsWith('0X') ? rawTx.slice(2) : rawTx).toLowerCase()
}

export interface ParsedLegacyTx {
  /** `keccak256(rawTx)`, lowercase with `0x`. This is the BRC2.0 transaction hash. */
  hash: string
  /** Recovered signer, lowercase with `0x`. */
  from: string
  nonce: number
  /** Recipient, or null for a contract creation. */
  to: string | null
  gasLimit: bigint
  chainId: bigint
}

/**
 * Parses a signed legacy (type 0) EVM transaction carrying the EIP-155 chain ID of the current
 * network's BRC2.0 chain.
 *
 * @param rawTx Hex of the signed transaction, with or without `0x`, any case.
 * @throws If the input is not valid hex, is unsigned, is not legacy, or targets another chain.
 */
export function parseLegacyRawTx(rawTx: string): ParsedLegacyTx {
  const hex = normalizeHex(rawTx)
  let tx: ethers.Transaction
  try {
    tx = ethers.Transaction.from(`0x${hex}`)
  } catch (error) {
    throw new Error(`Invalid raw transaction: ${error instanceof Error ? error.message : error}`)
  }
  if (tx.type !== 0) throw new Error('Raw transaction must be a legacy (type 0) transaction')
  if (tx.from == null || tx.signature == null) throw new Error('Raw transaction must be signed')
  const expected = getBrc20ProgChainId()
  if (tx.chainId !== expected) {
    throw new Error(
      `Raw transaction chain id ${tx.chainId} does not match BRC2.0 chain id ${expected}`
    )
  }
  return {
    hash: ethers.keccak256(`0x${hex}`),
    from: tx.from.toLowerCase(),
    nonce: tx.nonce,
    to: tx.to == null ? null : tx.to.toLowerCase(),
    gasLimit: tx.gasLimit,
    chainId: tx.chainId,
  }
}

/**
 * Builds a `brc20-prog` transact inscription for a signed legacy raw transaction. BRC2.0 grants
 * `content bytes × GAS_PER_BYTE` gas, so the content is padded with spaces until it covers the
 * transaction's gas limit.
 */
export async function transactInscription(rawTx: string): Promise<InscriptionDetails> {
  const { gasLimit } = parseLegacyRawTx(rawTx)
  const neededBytes = (gasLimit + BigInt(GAS_PER_BYTE) - 1n) / BigInt(GAS_PER_BYTE)
  if (neededBytes > BigInt(MAX_TRANSACT_CONTENT_BYTES)) {
    throw new Error(
      `Transaction gas limit ${gasLimit} needs ${neededBytes} bytes of inscription content, above the ${MAX_TRANSACT_CONTENT_BYTES} byte maximum`
    )
  }
  let content = `{"p":"brc20-prog","op":"t","b":"${await compressSmartContractData(normalizeHex(rawTx))}"}`
  const length = new TextEncoder().encode(content).length
  if (BigInt(length) < neededBytes) content += ' '.repeat(Number(neededBytes) - length)
  return textInscription(content)
}

export interface TransactArgs extends SignProgressOptions {
  /** Signed legacy (type 0) EVM transaction, hex with or without 0x. */
  rawTx: string
  feeRate: number
  dryRun: boolean
}

export interface TransactResult {
  /** The transact inscription's commit, reveal and send transactions. */
  transact: Brc20SendPart
  /** BRC2.0 tx hash, keccak256(rawTx). */
  txHash: string
  /** Every broadcast transaction id, in chain order. */
  txIds: string[]
}

/**
 * Refuses a nonce the BRC2.0 module drops: one below the signer's account nonce, or
 * {@link MAX_FUTURE_NONCES} or more above it. A nonce inside the window executes at once when it
 * equals the account nonce; a higher one waits up to 10 blocks for the gap to fill.
 */
async function assertNonceInWindow(from: string, nonce: number): Promise<void> {
  const count = Number(
    BigInt(
      (await getBrc20RpcProvider().request('eth_getTransactionCount', [from, 'latest'])) as string
    )
  )
  if (nonce < count) throw new Error(`nonce ${nonce} is already used; account nonce is ${count}`)
  if (nonce >= count + MAX_FUTURE_NONCES) {
    throw new Error(
      `nonce ${nonce} is more than ${MAX_FUTURE_NONCES - 1} ahead of account nonce ${count}`
    )
  }
}

/**
 * Inscribes a pre-signed legacy EVM transaction as a BRC2.0 `transact` op. The send transaction
 * moves the inscription to `OP_RETURN "BRC20PROG"`, where the module executes the embedded
 * transaction.
 */
export async function transact(args: TransactArgs): Promise<Brc20SendQuote | TransactResult> {
  const { rawTx, feeRate, dryRun } = args
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean')
  assertFeeRate(feeRate)
  const { hash, from, nonce } = parseLegacyRawTx(rawTx)
  await assertNonceInWindow(from, nonce)

  const res = await runChain(
    [
      {
        name: 'progTransact',
        inscription: await transactInscription(rawTx),
        target: opReturnTarget(),
      },
    ],
    feeRate,
    dryRun,
    args
  )
  if (!('parts' in res)) return res
  return { transact: res.parts.progTransact!, txHash: hash, txIds: res.txIds }
}
