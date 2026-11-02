import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { ethers } from 'ethers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getBrc20ProgChainId,
  MAX_TRANSACT_CONTENT_BYTES,
  parseLegacyRawTx,
  transactInscription,
} from '../../src/core/brc20-transact.ts'
import { compressSmartContractData } from '../../src/core/brc20.ts'
import { brc20, wallet } from '../../src/node.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const PAYER = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const payerScript = bitcoin.address.toOutputScript(PAYER, bitcoin.networks.testnet)
const opReturnScript = bitcoin.script.compile([
  bitcoin.opcodes.OP_RETURN!,
  Buffer.from('BRC20PROG'),
])

function prevTxHex(value: number) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 9), 0)
  tx.addOutput(payerScript, value)
  return tx.toHex()
}

function fakeCardinalUtxo(txid: string, value: number) {
  return {
    utxo: `${txid}:0`,
    txid,
    vout: 0,
    value,
    script_type: 'witness_v0_keyhash',
    script: payerScript.toString('hex'),
    address: PAYER,
    amounts: null,
    block_height: 1,
    inscription_ids: null,
    rune_ids: null,
    satpoints: null,
    txfee: null,
    vsize: null,
  }
}

const broadcastBodies: string[][] = []
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

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

describe('brc20.transact', () => {
  beforeEach(async () => {
    const txid = 'aa'.repeat(32)
    const utxos = [fakeCardinalUtxo(txid, 200000)]
    const prevHexByTxid: Record<string, string> = { [txid]: prevTxHex(200000) }
    broadcastBodies.length = 0

    fetchMock = vi.fn(async (url: string | URL, opts?: any) => {
      const u = String(url)
      if (u.includes('/cardinal_utxos/')) return jsonResponse({ data: utxos })
      if (u.includes('/gettxhex/'))
        return jsonResponse(prevHexByTxid[u.split('/gettxhex/')[1]!] ?? '')
      if (u.includes('/testmempoolaccept')) {
        const n = JSON.parse(opts.body).txhexes?.length ?? 1
        return jsonResponse(Array.from({ length: n }, () => ({ allowed: true })))
      }
      if (u.includes('/sendrawtransactions')) {
        const txhexes: string[] = JSON.parse(opts.body).txhexes
        broadcastBodies.push(txhexes)
        return jsonResponse(txhexes.map(hex => bitcoin.Transaction.fromHex(hex).getId()))
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await wallet.connectLocalWallet(WIF, 'signet', 'p2wpkh', 'unisat')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('transact dryRun quotes one progTransact step without broadcasting', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom())
    const quote = await brc20.transact({ rawTx: raw, feeRate: 2, dryRun: true })
    expect(quote.steps.length).toBe(1)
    expect(quote.steps[0]!.step).toBe('progTransact')
    expect(quote.walletPrompts).toBe(2)
    expect(quote.postageSats).toBe(1)
    expect(quote.paymentSats).toBe(0)
    expect(broadcastBodies.length).toBe(0)
  })

  it('transact broadcasts commit, reveal and send, and returns the BRC2.0 hash', async () => {
    const raw = await signedTx(ethers.Wallet.createRandom())
    const res = await brc20.transact({ rawTx: raw, feeRate: 2, dryRun: false })
    const txes = broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h))
    expect(txes.length).toBe(3)
    expect(txes[2]!.outs[0]!.script.equals(opReturnScript)).toBe(true)
    expect(res.txHash).toBe(ethers.keccak256(raw))
    expect(res.txIds.length).toBe(3)
    expect(res.transact.sendTxId).toBe(txes[2]!.getId())
  })

  it('transact rejects bad input before any network call', async () => {
    const type2 = await signedTx(ethers.Wallet.createRandom(), {
      type: 2,
      gasPrice: undefined,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    const legacy = await signedTx(ethers.Wallet.createRandom())
    await expect(brc20.transact({ rawTx: type2, feeRate: 2, dryRun: true })).rejects.toThrow(
      /legacy \(type 0\)/
    )
    await expect(brc20.transact({ rawTx: legacy, feeRate: 0, dryRun: true })).rejects.toThrow()
    await expect(
      brc20.transact({ rawTx: legacy, feeRate: 2, dryRun: 'yes' as unknown as boolean })
    ).rejects.toThrow(/dryRun/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
