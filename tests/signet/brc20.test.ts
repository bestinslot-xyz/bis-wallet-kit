/* eslint-disable no-console */
import type { Brc20SendQuote } from '../../src/core/brc20-send.ts'
import { createRequire } from 'node:module'
import process from 'node:process'
import { ethers } from 'ethers'
import { assert, beforeAll, describe, it } from 'vitest'
import { brc20, getEvmAddressFromBitcoinAddress, wallet } from '../../src/node.ts'
import { env } from './_helpers.ts'

const solc = createRequire(import.meta.url)('solc') as { compile: (input: string) => string }

const HAS_WIF = Boolean(process.env.PRIVATE_KEY_WIF)

// The deposit/withdraw dry-runs build real transactions against the wallet's
// balance, so they need a ticker the wallet actually holds — skip unless set.
const KNOWN_TICKER = process.env.SIGNET_KNOWN_TICKER

describe('tests for BRC2.0 programmable module (signet)', () => {
  let walletAddress: string

  beforeAll(async () => {
    if (!process.env.PRIVATE_KEY_WIF) {
      throw new Error('PRIVATE_KEY_WIF environment variable is not set')
    }
    const localWallet = await wallet.connectLocalWallet(
      process.env.PRIVATE_KEY_WIF!,
      'signet',
      'p2tr',
      'unisat'
    )
    walletAddress = localWallet.address
    console.log('Connected, address:', walletAddress)
  })

  it.skipIf(!KNOWN_TICKER)('should dry-run deposit to BRC2.0 prog', async () => {
    const result = await brc20.depositToBrc20Prog(
      KNOWN_TICKER!,
      '1',
      2,
      null,
      true // dryRun
    )
    assert.ok(typeof result.commitTxId === 'string')
    assert.ok(typeof result.revealTxId === 'string')
    assert.ok(typeof result.signedCommitTxHex === 'string')
    assert.ok(typeof result.signedRevealTxHex === 'string')
    assert.ok(typeof result.sendToOpReturnTxId === 'string')
    console.log('Deposit dry-run commitTxId:', result.commitTxId)
  })

  it.skipIf(!KNOWN_TICKER)('should dry-run withdraw from BRC2.0 prog', async () => {
    const result = await brc20.withdrawFromBrc20Prog(
      KNOWN_TICKER!,
      '1',
      walletAddress,
      2,
      null,
      true // dryRun
    )
    assert.ok(typeof result.commitTxId === 'string')
    assert.ok(typeof result.revealTxId === 'string')
    assert.ok(typeof result.signedCommitTxHex === 'string')
    assert.ok(typeof result.signedRevealTxHex === 'string')
    assert.ok(typeof result.transferTxId === 'string')
    console.log('Withdraw dry-run commitTxId:', result.commitTxId)
  })

  // Needs a deployed contract address (SIGNET_CONTRACT_ADDRESS). Uses a generic
  // ERC-20-style balanceOf(address) read so it works against any token contract.
  it.skipIf(!process.env.SIGNET_CONTRACT_ADDRESS)(
    'should dry-run a smart-contract call via ABI',
    async () => {
      const abi = [
        {
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ]
      const evmAddress = getEvmAddressFromBitcoinAddress(walletAddress)
      const result = await brc20.callSmartContractAbi(
        process.env.SIGNET_CONTRACT_ADDRESS!,
        abi,
        'balanceOf',
        [evmAddress],
        100000, // estimatedGas
        2, // gasPerVbyte
        2, // feeRate
        null, // postage
        true // dryRun
      )
      assert.ok(typeof result.commitTxId === 'string')
      assert.ok(typeof result.revealTxId === 'string')
    }
  )

  // Signs a legacy tx on the BRC2.0 signet chain: frBTC.balanceOf(address(0)).
  async function signBalanceOfTx(): Promise<string> {
    const signer = ethers.Wallet.createRandom()
    const data = ethers.concat([
      ethers.id('balanceOf(address)').slice(0, 10),
      ethers.zeroPadValue(ethers.ZeroAddress, 32),
    ])
    return await signer.signTransaction({
      type: 0,
      chainId: 0x425243323073n,
      nonce: 0,
      gasPrice: 0n,
      gasLimit: 100_000n,
      to: brc20.getFrBtcAddress(),
      data,
    })
  }

  it.skipIf(!HAS_WIF)('should quote a transact of a signed legacy tx', async () => {
    const quote = (await brc20.transact({
      rawTx: await signBalanceOfTx(),
      feeRate: 2,
      dryRun: true,
    })) as Brc20SendQuote
    assert.equal(quote.steps[0].step, 'progTransact')
    assert.ok(quote.totalSats > 0)
  })

  it.skipIf(!HAS_WIF || !env.execute)('should broadcast a transact', async () => {
    const raw = await signBalanceOfTx()
    const result = (await brc20.transact({ rawTx: raw, feeRate: 2, dryRun: false })) as {
      txHash: string
      txIds: string[]
    }
    assert.equal(result.txIds.length, 3)
    assert.equal(result.txHash, ethers.keccak256(raw))
  })

  it.skipIf(!HAS_WIF)('should quote a contract deploy', async () => {
    const input = {
      language: 'Solidity',
      sources: { 'Empty.sol': { content: 'contract Empty {}' } },
      settings: { outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
    }
    const output = JSON.parse(solc.compile(JSON.stringify(input)))
    const bytecode: string = output.contracts['Empty.sol'].Empty.evm.bytecode.object
    assert.ok(bytecode.length > 0)
    const result = await brc20.deploySmartContract(bytecode, 100_000, 2, 2, null, true)
    assert.ok(typeof result.revealTxId === 'string')
  })
})
