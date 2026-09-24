/** Minimal synchronous key/value storage (a subset of the Web Storage API). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** `localStorage` when available and writable, in-memory storage otherwise. */
export function defaultStorage(): KeyValueStorage {
  // Recent Node.js versions expose a warning-emitting localStorage global; only use it in browsers.
  if (typeof window === 'undefined') return memoryStorage();
  try {
    const storage = window.localStorage;
    const probe = '__catcard_probe__';
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return storage;
  } catch {
    return memoryStorage();
  }
}

export function readJSON<T>(storage: KeyValueStorage, key: string): T | undefined {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJSON(storage: KeyValueStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: accounts will need to be re-scanned next time.
  }
}
