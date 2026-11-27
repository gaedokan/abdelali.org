// Minimal IndexedDB wrapper: one object store for entities, one for metadata.
import { Entity } from './models';

const DB_NAME = 'envelope';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function loadAll(): Promise<Entity[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction('items').objectStore('items').getAll();
    req.onsuccess = () => resolve(req.result as Entity[]);
    req.onerror = () => reject(req.error);
  });
}

export async function saveItems(items: Entity[]): Promise<void> {
  if (!items.length) return;
  const db = await open();
  const tx = db.transaction('items', 'readwrite');
  const st = tx.objectStore('items');
  for (const it of items) st.put(it);
  await done(tx);
}

export async function clearAll(): Promise<void> {
  const db = await open();
  const tx = db.transaction(['items', 'meta'], 'readwrite');
  tx.objectStore('items').clear();
  tx.objectStore('meta').clear();
  await done(tx);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta').objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
}
