/** Minimal IndexedDB key-value store with a localStorage fallback. */
const DB = 'quillloom';
const OS = 'kv';
let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

export async function kvGet<T = any>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) {
    const v = localStorage.getItem('qlkv:' + key);
    return v ? JSON.parse(v) : undefined;
  }
  return new Promise((resolve) => {
    const r = db.transaction(OS).objectStore(OS).get(key);
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => resolve(undefined);
  });
}

export async function kvSet(key: string, value: any): Promise<void> {
  const db = await open();
  if (!db) { try { localStorage.setItem('qlkv:' + key, JSON.stringify(value)); } catch { /* */ } return; }
  return new Promise((resolve) => {
    const tx = db.transaction(OS, 'readwrite');
    tx.objectStore(OS).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function kvDel(key: string): Promise<void> {
  const db = await open();
  if (!db) { localStorage.removeItem('qlkv:' + key); return; }
  return new Promise((resolve) => {
    const tx = db.transaction(OS, 'readwrite');
    tx.objectStore(OS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function kvKeys(prefix = ''): Promise<string[]> {
  const db = await open();
  if (!db) {
    return Object.keys(localStorage).filter((k) => k.startsWith('qlkv:' + prefix)).map((k) => k.slice(5));
  }
  return new Promise((resolve) => {
    const r = db.transaction(OS).objectStore(OS).getAllKeys();
    r.onsuccess = () => resolve((r.result as string[]).filter((k) => String(k).startsWith(prefix)));
    r.onerror = () => resolve([]);
  });
}
