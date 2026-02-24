export interface KeyValueStore {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

/**
 * Creates an in-memory key-value store that can be used for storing data during the session. The memoryStorage function returns an object that implements the KeyValueStore interface, allowing you to get, set, and remove key-value pairs using a Map object internally. This is useful for scenarios where you want to store data temporarily without persisting it across sessions, such as during testing or when localStorage is not available.
 *
 * The returned KeyValueStore object provides three methods:
 * - get(key: string): Retrieves the value associated with the specified key. If the key does not exist, it returns null.
 * - set(key: string, value: string): Stores a key-value pair in the memory storage. If the key already exists, it will overwrite the existing value.
 * - remove(key: string): Removes the key-value pair associated with the specified key from the memory storage. If the key does not exist, it does nothing.
 *
 * This in-memory storage is useful for scenarios where you want to store data temporarily during the runtime of an application without needing to persist it across sessions or reloads. It can be particularly helpful for testing purposes or when working in environments where localStorage is not available (e.g., server-side rendering).
 *
 * @returns An object that implements the KeyValueStore interface, providing methods to get, set, and remove key-value pairs in memory.
 */
export function memoryStorage(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    get: k => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: k => void map.delete(k),
  }
}

export const browserStorage: KeyValueStore = {
  get: key => localStorage.getItem(key),
  set: (key, val) => localStorage.setItem(key, val),
  remove: key => localStorage.removeItem(key),
}
