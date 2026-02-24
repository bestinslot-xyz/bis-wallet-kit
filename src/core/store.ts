import type { BISSession } from '../main'
import { browserStorage, memoryStorage } from './storage'

const LS_KEY = 'bis-cw-wallets'

const WALLET_STORAGE = typeof window === 'undefined' ? memoryStorage() : browserStorage

/**
 * Saves the wallet information to local storage. The saveWalletInfo function takes a BISSession object as an argument and stores it in local storage under a specific key (LS_KEY). The data is serialized to a JSON string before being stored. This allows the application to persist wallet information across sessions, enabling users to retain their wallet data even after closing and reopening the application.
 * @param data The BISSession object containing the wallet information to be saved. This object typically includes details about the connected wallet, such as the provider, accounts, and other relevant session data. The function serializes this object to a JSON string and stores it in local storage under the key defined by LS_KEY, allowing for easy retrieval and management of wallet information in the application.
 */
export function saveWalletInfo(data: BISSession) {
  WALLET_STORAGE.set(LS_KEY, JSON.stringify(data))
}

/**
 * Retrieves the wallet information from local storage. The getWalletInfo function reads the data stored under the LS_KEY in local storage, parses it from a JSON string back into a BISSession object, and returns it. If no data is found, it returns null. This function allows the application to access the persisted wallet information, enabling features like session restoration and wallet management.
 * @returns The BISSession object containing the wallet information, or null if no data is found. This object typically includes details about the connected wallet, such as the provider, accounts, and other relevant session data.
 */
export function getWalletInfo(): BISSession | null {
  const data = WALLET_STORAGE.get(LS_KEY)

  if (data) {
    const obj: BISSession = JSON.parse(data)

    return obj
  }

  return null
}

/**
 * Clears the wallet information from local storage. The clearWalletInfo function removes the data stored under the LS_KEY in local storage, effectively clearing any persisted wallet information. This can be used when a user wants to disconnect their wallet or reset their session, ensuring that no wallet data remains stored in the browser after the operation is performed.
 */
export function clearWalletInfo() {
  WALLET_STORAGE.remove(LS_KEY)
}

const DB_NAME = 'wallet-db'
const DB_VERSION = 2
const STORE_NAME = 'wallet'
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      if (!event.target) {
        return
      }
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error)
    }
  })
}
async function saveWalletToDB(
  ciphertext: ArrayBuffer,
  iv: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  swapPubkey: string,
  bitcoinAddress: string,
): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)

    const record = {
      id: bitcoinAddress,
      ciphertext,
      iv,
      key,
      swapPubkey,
      bitcoinAddress,
      updatedAt: new Date().toISOString(),
    }

    const request = store.put(record)

    request.onsuccess = () => {
      resolve()
    }

    request.onerror = () => {
      reject(request.error)
    }
  })
}
async function loadWalletFromDB(bitcoinAddressToRead: string): Promise<{
  ciphertext: ArrayBuffer
  iv: Uint8Array<ArrayBuffer>
  key: CryptoKey
  swapPubkey: string
  bitcoinAddress: string
} | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(bitcoinAddressToRead)

    request.onsuccess = () => {
      const record = request.result
      if (!record) {
        resolve(null)
        return
      }

      // iv will come back as Uint8Array, ciphertext as ArrayBuffer, kek as CryptoKey
      resolve({
        ciphertext: record.ciphertext,
        iv: record.iv,
        key: record.key,
        swapPubkey: record.swapPubkey,
        bitcoinAddress: record.bitcoinAddress,
      })
    }

    request.onerror = () => {
      reject(request.error)
    }
  })
}

export interface SwapWalletInfo {
  swapPubkey: string
  swapPrivkey: string
  bitcoinAddress: string
}
/**
 * Saves the swap wallet information securely in IndexedDB. The saveSwapWalletInfo function takes a SwapWalletInfo object containing the swap public key, private key, and associated Bitcoin address. It generates a random encryption key and initialization vector (IV) to encrypt the private key using AES-GCM encryption. The encrypted private key, along with the IV, encryption key, swap public key, and Bitcoin address, are then stored in IndexedDB for secure retrieval later. This approach ensures that sensitive wallet information is protected while still allowing for necessary access when needed.
 *
 * @param data The SwapWalletInfo object containing the swap public key, private key, and associated Bitcoin address. The function encrypts the private key using AES-GCM encryption with a randomly generated key and IV, and then stores the encrypted data along with the necessary information for decryption in IndexedDB. This allows for secure storage of sensitive wallet information while still enabling retrieval when needed.
 */
export async function saveSwapWalletInfo(data: SwapWalletInfo) {
  // SSR-SAFU
  if (typeof window === 'undefined') {
    return
  }

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    /* extractable: */ false,
    ['encrypt', 'decrypt'],
  )

  function bufFromHex(hex: string): Uint8Array<ArrayBuffer> {
    hex = hex.startsWith('0x') ? hex.slice(2) : hex
    const bytes = hex.match(/../g)
    if (!bytes) {
      throw new Error('Invalid hex string')
    }
    const arr = bytes.map(b => Number.parseInt(b, 16))
    return new Uint8Array(arr)
  }
  const privKeyBytes = bufFromHex(data.swapPrivkey)

  const iv = crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, privKeyBytes)

  await saveWalletToDB(ciphertext, iv, key, data.swapPubkey, data.bitcoinAddress)
}

/**
 * Reads the swap wallet information from IndexedDB. The readSwapWalletInfo function takes a Bitcoin address as an argument and retrieves the corresponding encrypted wallet information from IndexedDB. It then decrypts the private key using the stored encryption key and IV, returning the swap public key, decrypted private key, and associated Bitcoin address as a SwapWalletInfo object. If no matching record is found or if decryption fails, it returns null. This function allows for secure retrieval of wallet information while ensuring that sensitive data remains protected.
 *
 * @param bitcoinAddressToRead The Bitcoin address for which to read the swap wallet information. The function looks up the encrypted wallet information associated with this Bitcoin address in IndexedDB, decrypts the private key using the stored encryption key and IV, and returns the swap public key, decrypted private key, and Bitcoin address as a SwapWalletInfo object. If no matching record is found or if decryption fails, it returns null, ensuring that sensitive wallet information is handled securely.
 * @returns A promise that resolves to a SwapWalletInfo object containing the swap public key, decrypted private key, and associated Bitcoin address if the information is successfully retrieved and decrypted, or null if no matching record is found or if decryption fails. This allows for secure access to wallet information while maintaining the confidentiality of sensitive data.
 */
export async function readSwapWalletInfo(
  bitcoinAddressToRead: string,
): Promise<SwapWalletInfo | null> {
  // SSR-SAFU
  if (typeof window === 'undefined') {
    return null
  }

  const swapWallet = await loadWalletFromDB(bitcoinAddressToRead)
  if (!swapWallet) {
    return null
  }

  const { ciphertext, iv, key, swapPubkey, bitcoinAddress } = swapWallet
  if (bitcoinAddressToRead !== bitcoinAddress) {
    return null
  }

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)

  const privKeyHex = `0x${Array.from(new Uint8Array(decrypted))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`

  return {
    swapPubkey,
    swapPrivkey: privKeyHex,
    bitcoinAddress,
  }
}

/**
 * Deletes the swap wallet information associated with the given Bitcoin address from IndexedDB. The deleteSwapWalletInfo function takes a Bitcoin address as an argument and removes the corresponding record from IndexedDB, effectively deleting the stored swap wallet information. This can be used when a user wants to remove their wallet data or when it is no longer needed, ensuring that sensitive information is properly cleaned up from storage.
 *
 * @param bitcoinAddress The Bitcoin address for which to delete the swap wallet information. The function looks up the record associated with this Bitcoin address in IndexedDB and deletes it, effectively removing the stored swap wallet information. This allows for proper cleanup of sensitive data when it is no longer needed or when a user wants to remove their wallet information from storage.
 */
export async function deleteSwapWalletInfo(bitcoinAddress: string): Promise<void> {
  // SSR-SAFU
  if (typeof window === 'undefined') {
    return
  }

  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.delete(bitcoinAddress)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}
