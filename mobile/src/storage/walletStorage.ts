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

interface StoreQueueState {
  tail: Promise<void>;
  activeBatch: Promise<Wallet> | null;
}

function createQueueState(): StoreQueueState {
  return {
    tail: Promise.resolve(),
    activeBatch: null
  };
}

let cachedWallet: Wallet | null = null;
const queueByStore = new WeakMap<SecureKeyStore, StoreQueueState>();
let defaultQueueState: StoreQueueState = createQueueState();

function getStoreQueueState(store: SecureKeyStore): StoreQueueState {
  let state = queueByStore.get(store);
  if (!state) {
    state = createQueueState();
    queueByStore.set(store, state);
  }
  return state;
}

/**
 * Resets in-memory cached wallet reference and default in-flight queue state.
 * Used primarily across isolated test runs.
 */
export function resetWalletStorageForTesting(): void {
  cachedWallet = null;
  defaultQueueState = createQueueState();
}

async function resolveWalletFromStore(store: SecureKeyStore): Promise<Wallet> {
  const existing = await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY);

  if (existing !== null) {
    if (!isValidPrivateKey(existing)) {
      throw new WalletStorageError(
        "Stored wallet private key is malformed; refusing to open wallet to prevent fund loss."
      );
    }
    return new Wallet(existing);
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

  return newWallet;
}

/**
 * Returns the persisted embedded wallet, generating and persisting a new one
 * on first launch via platform-secure storage (expo-secure-store on native,
 * WebLocalStorage on web, InMemoryKeyStore in Vitest / Node).
 *
 * Concurrent calls sharing the same `keyStore` (or the default platform keystore)
 * are serialized so first-boot generation never triggers read-back collisions.
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
  if (keyStore) {
    const state = getStoreQueueState(keyStore);
    if (state.activeBatch) {
      return state.activeBatch;
    }

    const previousTail = state.tail;
    let batch!: Promise<Wallet>;
    batch = (async (): Promise<Wallet> => {
      try {
        await previousTail;
        return await resolveWalletFromStore(keyStore);
      } finally {
        if (state.activeBatch === batch) {
          state.activeBatch = null;
        }
      }
    })();

    state.activeBatch = batch;
    state.tail = batch.then(
      () => undefined,
      () => undefined
    );
    return batch;
  }

  if (cachedWallet) {
    return cachedWallet;
  }

  const state = defaultQueueState;
  if (state.activeBatch) {
    return state.activeBatch;
  }

  const previousTail = state.tail;
  let batch!: Promise<Wallet>;
  batch = (async (): Promise<Wallet> => {
    try {
      await previousTail;

      let store: SecureKeyStore;
      try {
        store = await createPlatformKeyStore();
      } catch (err) {
        if (err instanceof VaultKeyUnavailableError) {
          throw new WalletStorageError(err.message);
        }
        throw err;
      }

      const wallet = await resolveWalletFromStore(store);
      if (state === defaultQueueState && state.activeBatch === batch) {
        cachedWallet = wallet;
      }
      return wallet;
    } finally {
      if (state.activeBatch === batch) {
        state.activeBatch = null;
      }
    }
  })();

  state.activeBatch = batch;
  state.tail = batch.then(
    () => undefined,
    () => undefined
  );
  return batch;
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
 * Serialized against any active in-flight wallet creation for the same store so
 * a concurrent create/clear race cannot leave a stale cache or delete a newly
 * returned wallet's key out from under it.
 */
export async function clearStoredWallet(
  keyStore?: SecureKeyStore
): Promise<void> {
  if (keyStore) {
    const state = getStoreQueueState(keyStore);
    state.activeBatch = null;

    const previousTail = state.tail;
    const clearWork = (async (): Promise<void> => {
      await previousTail;
      try {
        if (typeof keyStore.deleteItem === "function") {
          await keyStore.deleteItem(WALLET_PRIVATE_KEY_STORAGE_KEY);
        }
      } catch {
        // Non-fatal if keystore unavailable during teardown
      }
    })();

    state.tail = clearWork;
    await clearWork;
    return;
  }

  const state = defaultQueueState;
  cachedWallet = null;
  state.activeBatch = null;

  const previousTail = state.tail;
  const clearWork = (async (): Promise<void> => {
    await previousTail;
    if (state === defaultQueueState) {
      cachedWallet = null;
    }
    try {
      const store = await createPlatformKeyStore();
      if (typeof store.deleteItem === "function") {
        await store.deleteItem(WALLET_PRIVATE_KEY_STORAGE_KEY);
      }
    } catch {
      // Non-fatal if keystore unavailable during teardown
    }
  })();

  state.tail = clearWork;
  await clearWork;
}
