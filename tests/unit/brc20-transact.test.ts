import { ethers } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getBrc20ProgChainId,
  MAX_TRANSACT_CONTENT_BYTES,
  parseLegacyRawTx,
  transactInscription,
} from '../../src/core/brc20-transact.ts'
import { compressSmartContractData } from '../../src/core/brc20.ts'
import { wallet } from '../../src/node.ts'

const SIGNET_CHAIN_ID = 72921082114163n
const MAINNET_CHAIN_ID = 284847977008n
const TO = '0x1111111111111111111111111111111111111111'

async function signedTx(
  w: ethers.HDNodeWallet,
  overrides: Partial<ethers.TransactionRequest> = {}
): Promise<string> {
  return w.signTransaction({
    type: 0,
    chainId: SIGNET_CHAIN_ID,
    nonce: 0,
    gasPrice: 0n,
    gasLimit: 100_000n,
    to: TO,
    data: '0xdeadbeef',
    value: 0n,
    ...overrides,
  })
}

function contentText(inscription: Awaited<ReturnType<typeof transactInscription>>): string {
  return new TextDecoder().decode(inscription.data!.to_bytes())
}

describe('brc20-transact', () => {
  beforeEach(async () => {
    await wallet.setNetwork('signet')
  })

  it('getBrc20ProgChainId follows the network', async () => {
    await wallet.setNetwork('mainnet')
    expect(getBrc20ProgChainId()).toBe(MAINNET_CHAIN_ID)
    await wallet.setNetwork('signet')
    expect(getBrc20ProgChainId()).toBe(SIGNET_CHAIN_ID)
  })

  it('parseLegacyRawTx returns hash = keccak256(raw), recovered from, nonce, to, gasLimit, chainId', async () => {
    const w = ethers.Wallet.createRandom()
    const raw = await signedTx(w, { nonce: 7, gasLimit: 123_456n })
    const parsed = parseLegacyRawTx(raw)
    expect(parsed.hash).toBe(ethers.keccak256(raw))
    expect(parsed.from).toBe(w.address.toLowerCase())
    expect(parsed.nonce).toBe(7)
    expect(parsed.to).toBe(TO)
    expect(parsed.gasLimit).toBe(123_456n)
    expect(parsed.chainId).toBe(SIGNET_CHAIN_ID)
  })

  it('parseLegacyRawTx accepts bare and 0x-prefixed, any case', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom())
    const bare = raw.slice(2)
    const a = parseLegacyRawTx(raw)
    expect(parseLegacyRawTx(bare)).toEqual(a)
    expect(parseLegacyRawTx(`0x${bare.toUpperCase()}`)).toEqual(a)
  })

  it('parseLegacyRawTx rejects a type-2 tx', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom(), {
      type: 2,
      gasPrice: undefined,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    expect(() => parseLegacyRawTx(raw)).toThrow(/legacy \(type 0\)/)
  })

  it('parseLegacyRawTx rejects a tx for another chain', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom(), { chainId: MAINNET_CHAIN_ID })
    expect(() => parseLegacyRawTx(raw)).toThrow(/chain id/i)
  })

  it('parseLegacyRawTx rejects an unsigned tx', () => {
    const unsigned = ethers.Transaction.from({
      type: 0,
      chainId: SIGNET_CHAIN_ID,
      nonce: 0,
      gasPrice: 0n,
      gasLimit: 100_000n,
      to: TO,
      data: '0x',
      value: 0n,
    }).unsignedSerialized
    expect(() => parseLegacyRawTx(unsigned)).toThrow(/signed/)
  })

  it('parseLegacyRawTx rejects non-hex', () => {
    expect(() => parseLegacyRawTx('0xzz')).toThrow(/invalid raw transaction/i)
  })

  it('transactInscription content is the t op with the compressed raw tx', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom())
    const inscription = await transactInscription(raw)
    expect(contentText(inscription).trimEnd()).toBe(
      `{"p":"brc20-prog","op":"t","b":"${await compressSmartContractData(raw)}"}`
    )
    expect(new TextDecoder().decode(inscription.mimeType!.to_bytes())).toBe('text/plain')
  })

  it('transactInscription yields identical content for 0x, bare, 0X and uppercase input', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom())
    const bare = raw.slice(2)
    const expected = contentText(await transactInscription(raw))
    for (const variant of [bare, `0X${bare}`, `0x${bare.toUpperCase()}`, bare.toUpperCase()]) {
      expect(contentText(await transactInscription(variant))).toBe(expected)
    }
  })

  it('transactInscription pads to the tx gas limit', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom(), { gasLimit: 5_000_000n })
    const inscription = await transactInscription(raw)
    const len = inscription.data!.length
    expect(len * 12000).toBeGreaterThanOrEqual(5_000_000)
    expect((len - 1) * 12000).toBeLessThan(5_000_000)
  })

  it('transactInscription does not pad when gasLimit is 0', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom(), { gasLimit: 0n })
    const text = contentText(await transactInscription(raw))
    expect(text.endsWith(' ')).toBe(false)
  })

  it('transactInscription refuses a gas limit needing more than MAX_TRANSACT_CONTENT_BYTES', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom(), { gasLimit: 30_000_000_000n })
    expect(30_000_000_000n / 12000n).toBeGreaterThan(BigInt(MAX_TRANSACT_CONTENT_BYTES))
    await expect(transactInscription(raw)).rejects.toThrow(/gas limit/)
  })
})
