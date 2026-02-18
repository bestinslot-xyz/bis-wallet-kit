import { Buffer } from 'node:buffer'
import process from 'node:process'
import { Buff, getPaymentWallet, inscribe, InscriptionDetails, signMessage, signMessageLocalVerify, signMessageLocalVerifyDeterministic, useLocalWallet } from '@bestinslot/wallet-kit'
import dotenv from 'dotenv'

dotenv.config()

const private_key = process.env.PRIVATE_KEY_WIF

async function main() {
  await useLocalWallet(private_key, 'signet', 'p2tr', 'unisat')
  const message = 'yolo'

  const wallet = await getPaymentWallet()
  console.log('Address:', wallet.address)
  console.log('Message:', message)

  try {
    const signature = await signMessageLocalVerify(message)
    console.log('Signature (bip322-simple):', Buffer.from(signature, 'hex').toString('base64'))
  }
  catch (error) {
    console.error('Error signing message with bip322-simple:', error)
    const signature = await signMessage(message)
    console.log('Signature (bip322-simple, non-verified):', Buffer.from(signature, 'hex').toString('base64'))
  }
  try {
    const deterministicSignature = await signMessageLocalVerifyDeterministic(message)
    console.log('Deterministic Signature (ecdsa):', Buffer.from(deterministicSignature, 'hex').toString('base64'))
  }
  catch (error) {
    console.error('Error signing message with ecdsa:', error)
  }

  await inscribe(new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    Buff.str('utf8'),
    null,
    Buff.str('Hello, world!'),
  ), 2, null, null, 0, false)
}

main().catch((error) => {
  console.error('Error connecting to wallet:', error)
})
