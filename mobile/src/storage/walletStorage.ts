import { Wallet } from "ethers";
import {
  createPlatformKeyStore,
  SecureKeyStore,
  VaultKeyUnavailableError
} from "./vaultKeyProvider";

export const WALLET_PRIVATE_KEY_STORAGE_KEY = "dehealth.wallet.private_key.v1";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export class WalletStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletStorageError";
  }
}

/**
 * Validates that candidate is a valid 32-byte hex Ethereum private key.
 */
export function isValidPrivateKey(value: unknown): value is string {
  return typeof value === "string" && PRIVATE_KEY_PATTERN.test(value);
}

let cachedWallet: Wallet | null = null;

/**
 * Resets in-memory cached wallet reference. Used primarily across isolated test runs.
 */
export function resetWalletStorageForTesting(): void {
  cachedWallet = null;
}

/**
 * Returns the persisted embedded wallet, generating and persisting a new one
 * on first launch via platform-secure storage (expo-secure-store on native,
 * WebLocalStorage on web, InMemoryKeyStore in Vitest / Node).
 *
 * Adheres strictly to fail-closed security rules:
 *  - Existing malformed or corrupted keys are refused with WalletStorageError
 *    and NEVER overwritten, preventing accidental fund destruction.
 *  - On React Native, if a hardware-backed secure store is missing, it refuses
 *    to boot (fails closed).
 *  - Zero Math.random usage (relies exclusively on Web Crypto / expo-crypto).
 */
export async function getOrCreatePersistentWallet(
  keyStore?: SecureKeyStore
): Promise<Wallet> {
  if (cachedWallet && !keyStore) {
    return cachedWallet;
  }

  let store: SecureKeyStore;
  try {
    store = keyStore ?? (await createPlatformKeyStore());
  } catch (err) {
    if (err instanceof VaultKeyUnavailableError) {
      throw new WalletStorageError(err.message);
    }
    throw err;
  }

  const existing = await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY);

  if (existing !== null) {
    if (!isValidPrivateKey(existing)) {
      throw new WalletStorageError(
        "Stored wallet private key is malformed; refusing to open wallet to prevent fund loss."
      );
    }
    const wallet = new Wallet(existing);
    if (!keyStore) {
      cachedWallet = wallet;
    }
    return wallet;
  }

  const randomWallet = Wallet.createRandom();
  const newWallet = new Wallet(randomWallet.privateKey);
  await store.setItem(WALLET_PRIVATE_KEY_STORAGE_KEY, newWallet.privateKey);

  const readBack = await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY);
  if (readBack !== newWallet.privateKey) {
    throw new WalletStorageError(
      "Wallet private key could not be persisted to secure storage; refusing to initialize wallet."
    );
  }

  if (!keyStore) {
    cachedWallet = newWallet;
  }
  return newWallet;
}

/**
 * Retrieves the currently stored wallet without creating a new one if missing.
 * Returns null if no wallet key has been stored yet.
 * Throws WalletStorageError if the stored key is malformed.
 */
export async function getStoredWallet(
  keyStore?: SecureKeyStore
): Promise<Wallet | null> {
  let store: SecureKeyStore;
  try {
    store = keyStore ?? (await createPlatformKeyStore());
  } catch (err) {
    if (err instanceof VaultKeyUnavailableError) {
      throw new WalletStorageError(err.message);
    }
    throw err;
  }

  const existing = await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY);
  if (existing === null) {
    return null;
  }

  if (!isValidPrivateKey(existing)) {
    throw new WalletStorageError(
      "Stored wallet private key is malformed; refusing to open wallet to prevent fund loss."
    );
  }

  return new Wallet(existing);
}

/**
 * Safely exports the user's persistent private key from secure storage.
 */
export async function exportWalletPrivateKey(
  keyStore?: SecureKeyStore
): Promise<string> {
  const wallet = await getOrCreatePersistentWallet(keyStore);
  return wallet.privateKey;
}

/**
 * Removes the stored private key from the backing store and clears the cache.
 */
export async function clearStoredWallet(
  keyStore?: SecureKeyStore
): Promise<void> {
  cachedWallet = null;
  try {
    const store = keyStore ?? (await createPlatformKeyStore());
    await store.setItem(WALLET_PRIVATE_KEY_STORAGE_KEY, "");
  } catch {
    // Non-fatal if keystore unavailable during teardown
  }
}
