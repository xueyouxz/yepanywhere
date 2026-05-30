/**
 * Thin promisified IndexedDB helpers for the client log collector.
 */

type OnUpgrade = (db: IDBDatabase, tx: IDBTransaction) => void;

function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function wrapTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

export function openDatabase(
  name: string,
  version: number,
  onUpgrade: OnUpgrade,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const tx = request.transaction;
      if (!tx) {
        throw new Error("IndexedDB upgrade transaction unavailable");
      }
      onUpgrade(request.result, tx);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putEntry(
  db: IDBDatabase,
  store: string,
  entry: unknown,
): Promise<number> {
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  const key = objectStore.add(entry);
  await wrapTransaction(tx);
  return key.result as number;
}

export async function putEntryWithKey<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
  entry: T,
): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  objectStore.put(entry, key);
  await wrapTransaction(tx);
}

export async function getEntry<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<T | null> {
  const tx = db.transaction(store, "readonly");
  const objectStore = tx.objectStore(store);
  const request = objectStore.get(key);
  const result = await wrapRequest(request);
  return (result ?? null) as T | null;
}

export async function deleteEntry(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  objectStore.delete(key);
  await wrapTransaction(tx);
}

export async function getAllEntries<T>(
  db: IDBDatabase,
  store: string,
  count?: number,
): Promise<T[]> {
  const tx = db.transaction(store, "readonly");
  const objectStore = tx.objectStore(store);
  const request = count
    ? objectStore.getAll(null, count)
    : objectStore.getAll();
  return wrapRequest(request) as Promise<T[]>;
}

export async function deleteEntries(
  db: IDBDatabase,
  store: string,
  keys: number[],
): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  for (const key of keys) {
    objectStore.delete(key);
  }
  await wrapTransaction(tx);
}

export async function countEntries(
  db: IDBDatabase,
  store: string,
): Promise<number> {
  const tx = db.transaction(store, "readonly");
  const objectStore = tx.objectStore(store);
  return wrapRequest(objectStore.count());
}
