import { encode as nadaEncode } from '@bestinslot/nada'
import { init as initZstd, compress as zstdCompress } from '@bokuweb/zstd-wasm'
import { Buff } from '@cmdcode/buff-utils'
import { encode as base64Encode } from 'base64-arraybuffer'

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
