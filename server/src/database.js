const DB_NAME = 'ciphertalk-secure-db';
const DB_VERSION = 1;
const MESSAGE_STORE = 'messages';
const META_STORE = 'meta';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export class SecureDatabase {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;

    const openRequest = indexedDB.open(DB_NAME, DB_VERSION);

    openRequest.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        db.createObjectStore(MESSAGE_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
    };

    this.db = await requestToPromise(openRequest);
    return this.db;
  }

  async addEncryptedMessage(payload) {
    await this.init();

    if (!payload || !payload.iv || !payload.ciphertext) {
      throw new Error('Encrypted payload must include iv and ciphertext');
    }

    const tx = this.db.transaction(MESSAGE_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE);

    const record = {
      payload: {
        iv: payload.iv,
        ciphertext: payload.ciphertext
      }
    };

    const id = await requestToPromise(store.add(record));
    await transactionDone(tx);
    return id;
  }

  async getAllEncryptedMessages() {
    await this.init();

    const tx = this.db.transaction(MESSAGE_STORE, 'readonly');
    const store = tx.objectStore(MESSAGE_STORE);
    const rows = await requestToPromise(store.getAll());
    await transactionDone(tx);
    return Array.isArray(rows) ? rows : [];
  }

  async overwriteEncryptedMessage(id, payload) {
    await this.init();

    const tx = this.db.transaction(MESSAGE_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE);
    await requestToPromise(store.put({ id, payload }));
    await transactionDone(tx);
  }

  async secureDeleteMessage(id) {
    await this.init();

    const readTx = this.db.transaction(MESSAGE_STORE, 'readonly');
    const readStore = readTx.objectStore(MESSAGE_STORE);
    const existing = await requestToPromise(readStore.get(id));
    await transactionDone(readTx);

    if (!existing || !existing.payload) {
      return false;
    }

    const cipherByteLength = existing.payload.ciphertext
      ? existing.payload.ciphertext.byteLength || 64
      : 64;

    const overwriteCipher = crypto.getRandomValues(new Uint8Array(Math.max(32, cipherByteLength)));
    const overwriteIv = crypto.getRandomValues(new Uint8Array(12));

    const overwriteTx = this.db.transaction(MESSAGE_STORE, 'readwrite');
    const overwriteStore = overwriteTx.objectStore(MESSAGE_STORE);
    await requestToPromise(overwriteStore.put({
      id,
      payload: {
        iv: overwriteIv.buffer,
        ciphertext: overwriteCipher.buffer
      }
    }));
    await transactionDone(overwriteTx);

    const deleteTx = this.db.transaction(MESSAGE_STORE, 'readwrite');
    const deleteStore = deleteTx.objectStore(MESSAGE_STORE);
    await requestToPromise(deleteStore.delete(id));
    await transactionDone(deleteTx);
    return true;
  }

  async setMeta(id, value) {
    await this.init();
    const tx = this.db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    await requestToPromise(store.put({ id, value }));
    await transactionDone(tx);
  }

  async getMeta(id) {
    await this.init();
    const tx = this.db.transaction(META_STORE, 'readonly');
    const store = tx.objectStore(META_STORE);
    const row = await requestToPromise(store.get(id));
    await transactionDone(tx);
    return row ? row.value : null;
  }

  async deleteMeta(id) {
    await this.init();
    const tx = this.db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    await requestToPromise(store.delete(id));
    await transactionDone(tx);
  }
}
