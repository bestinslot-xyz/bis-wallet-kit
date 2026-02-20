export interface KeyValueStore {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

/**
 *
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
