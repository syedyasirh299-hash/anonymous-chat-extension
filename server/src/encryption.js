const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 310000;

function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text || '');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export class EncryptionManager {
  constructor() {
    this.dataKey = null;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  hasActiveKey() {
    return Boolean(this.dataKey);
  }

  clearKeyFromMemory() {
    this.dataKey = null;
  }

  async generateDataKey() {
    this.dataKey = await crypto.subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 256
      },
      true,
      ['encrypt', 'decrypt']
    );
    return this.dataKey;
  }

  async importRawDataKey(rawKeyBytes) {
    this.dataKey = await crypto.subtle.importKey(
      'raw',
      rawKeyBytes,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt']
    );
    return this.dataKey;
  }

  async exportRawDataKey() {
    if (!this.dataKey) {
      throw new Error('No active data key');
    }
    const raw = await crypto.subtle.exportKey('raw', this.dataKey);
    return new Uint8Array(raw);
  }

  async encryptObject(payload) {
    if (!this.dataKey) {
      throw new Error('Vault is locked');
    }

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const plaintextBytes = this.encoder.encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv
      },
      this.dataKey,
      plaintextBytes
    );

    return {
      iv: iv.buffer,
      ciphertext
    };
  }

  async decryptObject(encryptedRecord) {
    if (!this.dataKey) {
      throw new Error('Vault is locked');
    }

    if (!encryptedRecord || !encryptedRecord.iv || !encryptedRecord.ciphertext) {
      throw new Error('Malformed encrypted record');
    }

    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: encryptedRecord.iv
      },
      this.dataKey,
      encryptedRecord.ciphertext
    );

    const json = this.decoder.decode(plaintext);
    return JSON.parse(json);
  }

  async deriveWrappingKey(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      this.encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations,
        hash: 'SHA-256'
      },
      baseKey,
      {
        name: 'AES-GCM',
        length: 256
      },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async wrapActiveKeyWithPassword(password) {
    if (!password || password.length < 4) {
      throw new Error('Password must be at least 4 characters');
    }

    if (!this.dataKey) {
      throw new Error('No active data key to wrap');
    }

    const rawDataKey = await this.exportRawDataKey();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const wrappingKey = await this.deriveWrappingKey(password, salt, PBKDF2_ITERATIONS);

    const wrapped = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv
      },
      wrappingKey,
      rawDataKey
    );

    return {
      version: 1,
      kdf: 'PBKDF2-SHA-256',
      iterations: PBKDF2_ITERATIONS,
      saltB64: toBase64(salt),
      ivB64: toBase64(iv),
      wrappedKeyB64: toBase64(new Uint8Array(wrapped))
    };
  }

  async unlockWithPassword(password, wrappedKeyRecord) {
    if (!password) {
      throw new Error('Password required');
    }

    if (!wrappedKeyRecord || !wrappedKeyRecord.wrappedKeyB64) {
      throw new Error('Missing wrapped key data');
    }

    const salt = fromBase64(wrappedKeyRecord.saltB64);
    const iv = fromBase64(wrappedKeyRecord.ivB64);
    const wrapped = fromBase64(wrappedKeyRecord.wrappedKeyB64);
    const iterations = Number(wrappedKeyRecord.iterations || PBKDF2_ITERATIONS);

    const wrappingKey = await this.deriveWrappingKey(password, salt, iterations);
    const raw = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv
      },
      wrappingKey,
      wrapped
    );

    return this.importRawDataKey(raw);
  }
}
