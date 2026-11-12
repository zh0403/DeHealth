/**
 * Browser and React Native runtime shims for cryptographic primitives.
 * Preserves native Web Crypto (`crypto.getRandomValues`) when present and
 * provides a safe fallback only if `crypto.getRandomValues` is unavailable
 * (e.g., non-HTTPS local LAN web preview or un-polyfilled Hermes runtimes).
 */

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function installCryptoShim(): void {
  const root = globalThis as typeof globalThis & {
    crypto?: Partial<CryptoLike>;
    msCrypto?: Partial<CryptoLike>;
  };

  const nativeCrypto = root.crypto ?? root.msCrypto;
  if (nativeCrypto && typeof nativeCrypto.getRandomValues === "function") {
    if (!root.crypto) {
      Object.defineProperty(globalThis, "crypto", {
        value: nativeCrypto,
        configurable: true,
        writable: true
      });
    }
    return;
  }

  const fallbackGetRandomValues = <T extends ArrayBufferView>(array: T): T => {
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < view.length; i += 1) {
      view[i] = Math.floor(Math.random() * 256);
    }
    return array;
  };

  if (!root.crypto) {
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: fallbackGetRandomValues },
      configurable: true,
      writable: true
    });
  } else {
    root.crypto.getRandomValues = fallbackGetRandomValues;
  }
}

installCryptoShim();
