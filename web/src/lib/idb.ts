// Minimal IndexedDB key-value store used for offline POS data (catalog cache, sale queue).
const DB = 'its-pos';
const STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;
function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}
export const idb = {
  get: <T = any>(k: string) => run<T | undefined>('readonly', (s) => s.get(k)),
  set: (k: string, v: any) => run('readwrite', (s) => s.put(v, k)),
  del: (k: string) => run('readwrite', (s) => s.delete(k)),
};
