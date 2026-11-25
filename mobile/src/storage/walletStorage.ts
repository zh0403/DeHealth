import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  createPlatformKeyStore,
  SecureKeyStore,
  VaultKeyUnavailableError
} from "./vaultKeyProvider";

export const WALLET_PRIVATE_KEY_STORAGE_KEY = "dehealth.wallet.private_key.v1";
export const DEFAULT_LOCAL_WALLET_ACCOUNT_ID = "local";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SAFE_STORAGE_SUFFIX_PATTERN = /^[a-z0-9._-]{1,64}$/;

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

/**
 * Resolves a SecureStore-compatible key namespaced per authenticated account ID.
 * Local sessions (`undefined` or `"local"`) map to `WALLET_PRIVATE_KEY_STORAGE_KEY`.
 */
export function getWalletStorageKeyForAccount(accountId?: string): string {
  const trimmed =
    typeof accountId === "string" ? accountId.trim().toLowerCase() : "";
  if (!trimmed || trimmed === DEFAULT_LOCAL_WALLET_ACCOUNT_ID) {
    return WALLET_PRIVATE_KEY_STORAGE_KEY;
  }
  if (SAFE_STORAGE_SUFFIX_PATTERN.test(trimmed)) {
    return `${WALLET_PRIVATE_KEY_STORAGE_KEY}.${trimmed}`;
  }
  const digest = keccak256(toUtf8Bytes(trimmed)).slice(2, 34);
  return `${WALLET_PRIVATE_KEY_STORAGE_KEY}.${digest}`;
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

const cachedWalletsByKey = new Map<string, Wallet>();
const defaultQueueByKey = new Map<string, StoreQueueState>();
const queueByStoreAndKey = new WeakMap<
  SecureKeyStore,
  Map<string, StoreQueueState>
>();

function getStoreQueueState(
  store: SecureKeyStore,
  storageKey: string
): StoreQueueState {
  let byKey = queueByStoreAndKey.get(store);
  if (!byKey) {
    byKey = new Map<string, StoreQueueState>();
    queueByStoreAndKey.set(store, byKey);
  }
  let state = byKey.get(storageKey);
  if (!state) {
    state = createQueueState();
    byKey.set(storageKey, state);
  }
  return state;
}

function getDefaultQueueState(storageKey: string): StoreQueueState {
  let state = defaultQueueByKey.get(storageKey);
  if (!state) {
    state = createQueueState();
    defaultQueueByKey.set(storageKey, state);
  }
  return state;
}

/**
 * Resets in-memory cached wallet references and default in-flight queue state.
 * Used primarily across isolated test runs.
 */
export function resetWalletStorageForTesting(): void {
  cachedWalletsByKey.clear();
  defaultQueueByKey.clear();
}

async function resolveWalletFromStore(
  store: SecureKeyStore,
  storageKey: string
): Promise<Wallet> {
  const existing = await store.getItem(storageKey);

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
  await store.setItem(storageKey, newWallet.privateKey);

  const readBack = await store.getItem(storageKey);
  if (readBack !== newWallet.privateKey) {
    throw new WalletStorageError(
      "Wallet private key could not be persisted to secure storage; refusing to initialize wallet."
    );
  }

  return newWallet;
}

async function persistImportedWallet(
  store: SecureKeyStore,
  normalizedPrivateKey: string,
  storageKey: string
): Promise<Wallet> {
  let wallet: Wallet;
  try {
    wallet = new Wallet(normalizedPrivateKey);
  } catch (err) {
    throw new WalletStorageError(
      err instanceof Error
        ? `Invalid private key: ${err.message}`
        : "Invalid private key."
    );
  }

  await store.setItem(storageKey, wallet.privateKey);

  const readBack = await store.getItem(storageKey);
  if (readBack !== wallet.privateKey) {
    throw new WalletStorageError(
      "Wallet private key could not be persisted to secure storage; refusing to import wallet."
    );
  }

  return wallet;
}

/**
 * Validates, normalizes, and imports an Ethereum private key into persistent
 * secure storage, replacing any previously stored key for `accountId` on the target store.
 *
 * Serializes through the per-store, per-account FIFO queue and verifies persistence with a
 * read-back check before returning the resulting Wallet.
 */
export async function importPersistentWallet(
  privateKey: string,
  keyStore?: SecureKeyStore,
  accountId?: string
): Promise<Wallet> {
  const trimmed = typeof privateKey === "string" ? privateKey.trim() : "";
  const normalized = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? `0x${trimmed}`
    : trimmed;

  if (!isValidPrivateKey(normalized)) {
    throw new WalletStorageError(
      "Invalid private key format. Expected a 64-character hex Ethereum private key."
    );
  }

  const storageKey = getWalletStorageKeyForAccount(accountId);

  if (keyStore) {
    const state = getStoreQueueState(keyStore, storageKey);
    state.activeBatch = null;

    const previousTail = state.tail;
    const work = (async (): Promise<Wallet> => {
      await previousTail;
      try {
        return await persistImportedWallet(keyStore, normalized, storageKey);
      } catch (err) {
        if (err instanceof VaultKeyUnavailableError) {
          throw new WalletStorageError(err.message);
        }
        throw err;
      }
    })();

    state.tail = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  }

  const state = getDefaultQueueState(storageKey);
  cachedWalletsByKey.delete(storageKey);
  state.activeBatch = null;

  const previousTail = state.tail;
  let tailMarker!: Promise<void>;
  const work = (async (): Promise<Wallet> => {
    await previousTail;
    if (defaultQueueByKey.get(storageKey) === state) {
      cachedWalletsByKey.delete(storageKey);
    }
    try {
      const store = await createPlatformKeyStore();
      const wallet = await persistImportedWallet(store, normalized, storageKey);
      if (
        defaultQueueByKey.get(storageKey) === state &&
        state.tail === tailMarker
      ) {
        cachedWalletsByKey.set(storageKey, wallet);
      }
      return wallet;
    } catch (err) {
      if (err instanceof VaultKeyUnavailableError) {
        throw new WalletStorageError(err.message);
      }
      throw err;
    }
  })();

  tailMarker = work.then(
    () => undefined,
    () => undefined
  );
  state.tail = tailMarker;
  return work;
}

/**
 * Returns the persisted embedded wallet for `accountId`, generating and persisting a new one
 * on first launch via platform-secure storage (expo-secure-store on native,
 * WebLocalStorage on web, InMemoryKeyStore in Vitest / Node).
 *
 * Concurrent calls sharing the same `keyStore` (or the default platform keystore) and `accountId`
 * are serialized so first-boot generation never triggers read-back collisions.
 */
export async function getOrCreatePersistentWallet(
  keyStore?: SecureKeyStore,
  accountId?: string
): Promise<Wallet> {
  const storageKey = getWalletStorageKeyForAccount(accountId);

  if (keyStore) {
    const state = getStoreQueueState(keyStore, storageKey);
    if (state.activeBatch) {
      return state.activeBatch;
    }

    const previousTail = state.tail;
    let batch!: Promise<Wallet>;
    batch = (async (): Promise<Wallet> => {
      try {
        await previousTail;
        return await resolveWalletFromStore(keyStore, storageKey);
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

  const cached = cachedWalletsByKey.get(storageKey);
  if (cached) {
    return cached;
  }

  const state = getDefaultQueueState(storageKey);
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

      const wallet = await resolveWalletFromStore(store, storageKey);
      if (
        defaultQueueByKey.get(storageKey) === state &&
        state.activeBatch === batch
      ) {
        cachedWalletsByKey.set(storageKey, wallet);
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
 * Retrieves the currently stored wallet for `accountId` without creating a new one if missing.
 * Returns null if no wallet key has been stored yet.
 * Throws WalletStorageError if the stored key is malformed.
 */
export async function getStoredWallet(
  keyStore?: SecureKeyStore,
  accountId?: string
): Promise<Wallet | null> {
  const storageKey = getWalletStorageKeyForAccount(accountId);
  let store: SecureKeyStore;
  try {
    store = keyStore ?? (await createPlatformKeyStore());
  } catch (err) {
    if (err instanceof VaultKeyUnavailableError) {
      throw new WalletStorageError(err.message);
    }
    throw err;
  }

  const existing = await store.getItem(storageKey);
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
 * Safely exports the user's persistent private key for `accountId` from secure storage.
 */
export async function exportWalletPrivateKey(
  keyStore?: SecureKeyStore,
  accountId?: string
): Promise<string> {
  const wallet = await getOrCreatePersistentWallet(keyStore, accountId);
  return wallet.privateKey;
}

/**
 * Removes the stored private key for `accountId` from the backing store and clears its cache.
 */
export async function clearStoredWallet(
  keyStore?: SecureKeyStore,
  accountId?: string
): Promise<void> {
  const storageKey = getWalletStorageKeyForAccount(accountId);

  if (keyStore) {
    const state = getStoreQueueState(keyStore, storageKey);
    state.activeBatch = null;

    const previousTail = state.tail;
    const clearWork = (async (): Promise<void> => {
      await previousTail;
      try {
        if (typeof keyStore.deleteItem === "function") {
          await keyStore.deleteItem(storageKey);
        }
      } catch {
        // Non-fatal if keystore unavailable during teardown
      }
    })();

    state.tail = clearWork;
    await clearWork;
    return;
  }

  const state = getDefaultQueueState(storageKey);
  cachedWalletsByKey.delete(storageKey);
  state.activeBatch = null;

  const previousTail = state.tail;
  const clearWork = (async (): Promise<void> => {
    await previousTail;
    if (defaultQueueByKey.get(storageKey) === state) {
      cachedWalletsByKey.delete(storageKey);
    }
    try {
      const store = await createPlatformKeyStore();
      if (typeof store.deleteItem === "function") {
        await store.deleteItem(storageKey);
      }
    } catch {
      // Non-fatal if keystore unavailable during teardown
    }
  })();

  state.tail = clearWork;
  await clearWork;
}
