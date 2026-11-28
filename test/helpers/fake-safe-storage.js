'use strict';
// A stand-in for Electron's safeStorage. "Encryption" XORs the bytes behind
// a marker, so a key never appears as plain text in the file, and decrypting
// anything else fails the way Electron does.
//
//   available       isEncryptionAvailable()
//   backend         getSelectedStorageBackend() (Linux): 'gnome_libsecret',
//                   'kwallet5', 'basic_text', 'unknown', ...
//   failEncrypt     encryptString() throws
//   tamper          (plainText) => plainText, applied by decryptString()
const MARKER = Buffer.from('FAKESAFE1:');

function xor(buffer) {
  return Buffer.from(buffer.map((byte) => byte ^ 0x5a));
}

function createFakeSafeStorage(options = {}) {
  const state = {
    available: options.available !== undefined ? options.available : true,
    backend: options.backend || 'gnome_libsecret',
    failEncrypt: !!options.failEncrypt,
    tamper: options.tamper || null,
    encryptCalls: 0,
    decryptCalls: 0,
  };
  const safeStorage = {
    state,
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString(plainText) {
      state.encryptCalls++;
      if (!state.available) throw new Error('Encryption is not available.');
      if (state.failEncrypt) throw new Error('Error while encrypting the text provided to safeStorage.encryptString.');
      return Buffer.concat([MARKER, xor(Buffer.from(String(plainText), 'utf8'))]);
    },
    decryptString(encrypted) {
      state.decryptCalls++;
      if (!state.available) throw new Error('Decryption is not available.');
      const buffer = Buffer.from(encrypted);
      if (!buffer.subarray(0, MARKER.length).equals(MARKER)) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      }
      const text = xor(buffer.subarray(MARKER.length)).toString('utf8');
      return state.tamper ? state.tamper(text) : text;
    },
  };
  return safeStorage;
}

module.exports = { createFakeSafeStorage };
