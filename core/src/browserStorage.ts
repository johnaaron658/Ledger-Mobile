// Browser `Storage` implementation (§5.3) — backs the Phase 4 frontend swap
// and, later, gets superseded by Capacitor's own implementation in Phase 5.
// IndexedDB rather than OPFS: OPFS's synchronous write-access-handle API
// (the fast path) is only available inside a Worker, and its async
// `createWritable()` path has patchier Safari support than a plain
// `IDBObjectStore.put`. A single-key put inside a readwrite transaction is
// already atomic per the IndexedDB spec (the transaction commits wholesale or
// not at all), which is what "atomic" means for this interface — see
// nodeStorage.ts's temp->fsync->rename for the same guarantee on Node's fs.

import type { ConfigFile, Storage } from "./store.js";

const DB_NAME = "ledger-mobile";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const JOURNAL_KEY = "journal";

function configKey(name: ConfigFile): string {
  return `config:${name}`;
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked by another open connection"));
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB delete aborted"));
  });
}

function stateKey(key: string): string {
  return `state:${key}`;
}

export class BrowserStorage implements Storage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /** @param dbName override for tests — each test gets its own database so
   * fake-indexeddb's shared global registry doesn't leak state across specs. */
  constructor(private dbName: string = DB_NAME) {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb(this.dbName);
    return this.dbPromise;
  }

  async readJournal(): Promise<string | null> {
    const value = await idbGet<string>(await this.db(), JOURNAL_KEY);
    return value ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async writeJournal(text: string, _message?: string): Promise<void> {
    await idbPut(await this.db(), JOURNAL_KEY, text);
  }

  async readConfig(name: ConfigFile): Promise<unknown | null> {
    const value = await idbGet(await this.db(), configKey(name));
    return value ?? null;
  }

  async writeConfig(name: ConfigFile, value: unknown): Promise<void> {
    await idbPut(await this.db(), configKey(name), value);
  }

  async readState(key: string): Promise<unknown | null> {
    const value = await idbGet(await this.db(), stateKey(key));
    return value ?? null;
  }

  async writeState(key: string, value: unknown | null): Promise<void> {
    const db = await this.db();
    if (value === null) await idbDelete(db, stateKey(key));
    else await idbPut(db, stateKey(key), value);
  }
}
