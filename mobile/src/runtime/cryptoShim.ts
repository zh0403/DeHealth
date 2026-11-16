/**
 * Secure-randomness shim for runtimes without Web Crypto (React Native / Hermes).
 *
 * ethers' `randomBytes` reads `globalThis.crypto.getRandomValues`, and that call
 * produces the wallet private key, the per-install vault secret, and every
 * per-claim telemetry salt. It must therefore be a CSPRNG.
 *
 * Order of preference:
 *  1. Native Web Crypto, when the runtime provides it (browsers, Node).
 *  2. `expo-crypto`, backed by the platform's secure random source.
 *  3. Nothing. There is deliberately NO `Math.random` fallback: if no secure
 *     source exists, key generation throws instead of silently producing
 *     predictable keys.
 */

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

type CryptoHost = typeof globalThis & {
  crypto?: Partial<CryptoLike>;
  msCrypto?: Partial<CryptoLike>;
};

export class SecureRandomUnavailableError extends Error {
  constructor() {
    super(
      "No secure random source is available (Web Crypto and expo-crypto are both missing); refusing to generate keys."
    );
    this.name = "SecureRandomUnavailableError";
  }
}

function hasGetRandomValues(candidate: Partial<CryptoLike> | undefined): boolean {
  return Boolean(candidate && typeof candidate.getRandomValues === "function");
}

function loadExpoGetRandomValues(): CryptoLike["getRandomValues"] | null {
  try {
    const mod = require("expo-crypto") as {
      getRandomValues?: CryptoLike["getRandomValues"];
    };
    return typeof mod.getRandomValues === "function" ? mod.getRandomValues : null;
  } catch {
    return null;
  }
}

function failClosed(): never {
  throw new SecureRandomUnavailableError();
}

/**
 * Installs a secure `getRandomValues` on `root` if one is not already present.
 * Exported for tests; invoked once at import time below.
 */
export function installCryptoShim(
  root: CryptoHost = globalThis as CryptoHost,
  loadExpo: () => CryptoLike["getRandomValues"] | null = loadExpoGetRandomValues
): "native" | "expo-crypto" | "fail-closed" {
  const nativeCrypto = root.crypto ?? root.msCrypto;
  if (hasGetRandomValues(nativeCrypto)) {
    if (!root.crypto) {
      Object.defineProperty(root, "crypto", {
        value: nativeCrypto,
        configurable: true,
        writable: true
      });
    }
    return "native";
  }

  const expoGetRandomValues = loadExpo();
  const getRandomValues = expoGetRandomValues ?? failClosed;
  const source: "expo-crypto" | "fail-closed" = expoGetRandomValues
    ? "expo-crypto"
    : "fail-closed";

  if (!root.crypto) {
    Object.defineProperty(root, "crypto", {
      value: { getRandomValues },
      configurable: true,
      writable: true
    });
  } else {
    root.crypto.getRandomValues = getRandomValues;
  }
  return source;
}
