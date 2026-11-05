/**
 * The demo hub's storage: the visitor's library as one document in IndexedDB (a demo library is small), the
 * files the visitor added (uploads, ProPresenter media) as blobs, and import jobs. The sample content's
 * files are not copied: they are served from the site (`demo/files/<hash>`).
 */
const DB_NAME = 'ordo-demo-hub';
const VERSION = 1;

let dbp: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    r.onsuccess = () => {
      const db = r.result;
      // "Reset demo" deletes the database from the page: let it.
      db.onversionchange = () => {
        db.close();
        dbp = undefined;
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function getDoc<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return (await req(db.transaction('docs').objectStore('docs').get(key))) as T | undefined;
}

export async function putDoc(key: string, value: unknown): Promise<void> {
  const db = await open();
  await req(db.transaction('docs', 'readwrite').objectStore('docs').put(value, key));
}

export async function getFile(hash: string): Promise<Blob | undefined> {
  const db = await open();
  return (await req(db.transaction('files').objectStore('files').get(hash))) as Blob | undefined;
}

export async function putFile(hash: string, blob: Blob): Promise<void> {
  const db = await open();
  await req(db.transaction('files', 'readwrite').objectStore('files').put(blob, hash));
}

export async function clearAll(): Promise<void> {
  const db = await open();
  const t = db.transaction(['docs', 'files'], 'readwrite');
  t.objectStore('docs').clear();
  t.objectStore('files').clear();
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
