import type { BISSession } from '../main'
import { browserStorage, memoryStorage } from './storage'

const LS_KEY = 'bis-cw-wallets'

const walletStorage = typeof window === 'undefined' ? memoryStorage() : browserStorage

/**
 *
 * @param data
 */
export function saveWalletInfo(data: BISSession) {
  walletStorage.set(LS_KEY, JSON.stringify(data))
}

/**
 *
 */
export function getWalletInfo(): BISSession | null {
  const data = walletStorage.get(LS_KEY)

  if (data) {
    const obj: BISSession = JSON.parse(data)

    return obj
  }

  return null
}

/**
 *
 */
export function clearWalletInfo() {
  walletStorage.remove(LS_KEY)
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
 *
 * @param data
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
 *
 * @param bitcoinAddressToRead
 */
export async function readSwapWalletInfo(
  bitcoinAddressToRead: string,
): Promise<SwapWalletInfo | null> {
  // SSR-SAFU
  if (typeof window === 'undefined') {
    return null
  }

  const swap_wallet = await loadWalletFromDB(bitcoinAddressToRead)
  if (!swap_wallet) {
    return null
  }

  const { ciphertext, iv, key, swapPubkey, bitcoinAddress } = swap_wallet
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
 *
 * @param bitcoinAddress
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
