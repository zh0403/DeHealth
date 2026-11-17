import { hexlify, randomBytes } from "ethers";

/**
 * Per-install vault key provisioning (SOV-01).
 *
 * The vault secret is a cryptographically random 32-byte value generated on
 * first launch and held in the platform keystore. It is never derived from, or
 * defaulted to, any value in source code.
 *
 * Backing stores, in order of preference:
 *  1. `expo-secure-store` (iOS Keychain / Android Keystore) on native.
 *  2. `localStorage` on web (weaker: same origin storage as the data it protects).
 *  3. In-memory store for Node / Vitest only. Never used on React Native.
 */

export const VAULT_SECRET_STORAGE_KEY = "dehealth.vault.secret.v1";

const VAULT_SECRET_PATTERN = /^0x[0-9a-f]{64}$/;

export class VaultKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyUnavailableError";
  }
}

export interface SecureKeyStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem?(key: string): Promise<void>;
}

export function isValidVaultSecret(value: unknown): value is string {
  return typeof value === "string" && VAULT_SECRET_PATTERN.test(value);
}

export function generateVaultSecret(): string {
  return hexlify(randomBytes(32));
}

export class InMemoryKeyStore implements SecureKeyStore {
  private readonly items = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.items.delete(key);
  }
}

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export class WebLocalStorageKeyStore implements SecureKeyStore {
  constructor(private readonly storage: WebStorageLike) {}

  async getItem(key: string): Promise<string | null> {
    return this.storage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.storage.removeItem?.(key);
  }
}

interface ExpoSecureStoreModule {
  isAvailableAsync(): Promise<boolean>;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync?(key: string): Promise<void>;
}

function isReactNativeRuntime(): boolean {
  const nav = (globalThis as { navigator?: { product?: string } }).navigator;
  return nav?.product === "ReactNative";
}

function getWebLocalStorage(): WebStorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: WebStorageLike }).localStorage;
    return candidate ?? null;
  } catch {
    // Access to localStorage can throw (e.g. blocked third-party context).
    return null;
  }
}

async function loadSecureStore(): Promise<ExpoSecureStoreModule | null> {
  try {
    const mod = (await import("expo-secure-store")) as unknown as ExpoSecureStoreModule;
    return (await mod.isAvailableAsync()) ? mod : null;
  } catch {
    return null;
  }
}

/**
 * Selects the strongest available keystore for the current runtime.
 * On React Native it refuses to fall back to a non-persistent store, because
 * regenerating the key on every launch would silently orphan encrypted data.
 */
export async function createPlatformKeyStore(): Promise<SecureKeyStore> {
  const secureStore = await loadSecureStore();
  if (secureStore) {
    return {
      getItem: (key) => secureStore.getItemAsync(key),
      setItem: (key, value) => secureStore.setItemAsync(key, value),
      deleteItem: (key) =>
        secureStore.deleteItemAsync
          ? secureStore.deleteItemAsync(key)
          : Promise.resolve()
    };
  }

  if (isReactNativeRuntime()) {
    throw new VaultKeyUnavailableError(
      "Secure keystore is unavailable on this device; refusing to open the local vault."
    );
  }

  const web = getWebLocalStorage();
  if (web) {
    return new WebLocalStorageKeyStore(web);
  }

  return new InMemoryKeyStore();
}

/**
 * Returns the persisted vault secret, generating and storing a new one on first
 * launch. An existing but malformed value is treated as corruption and refused,
 * never silently replaced, so previously encrypted data is not orphaned.
 */
export async function provisionVaultSecret(store: SecureKeyStore): Promise<string> {
  const existing = await store.getItem(VAULT_SECRET_STORAGE_KEY);

  if (existing !== null) {
    if (!isValidVaultSecret(existing)) {
      throw new VaultKeyUnavailableError(
        "Stored vault secret is malformed; refusing to open the local vault."
      );
    }
    return existing;
  }

  const created = generateVaultSecret();
  await store.setItem(VAULT_SECRET_STORAGE_KEY, created);

  const readBack = await store.getItem(VAULT_SECRET_STORAGE_KEY);
  if (readBack !== created) {
    throw new VaultKeyUnavailableError(
      "Vault secret could not be persisted; refusing to open the local vault."
    );
  }
  return created;
}

/**
 * Convenience helper to obtain the device's vault secret.
 * Resolves the platform keystore if no store is explicitly passed,
 * then provisions (or retrieves) the 32-byte vault secret.
 */
export async function getVaultSecret(keyStore?: SecureKeyStore): Promise<string> {
  const store = keyStore ?? (await createPlatformKeyStore());
  return provisionVaultSecret(store);
}

/**
 * Deletes the persisted vault secret from the platform keystore (used during
 * explicit user-initiated vault reset recovery).
 */
export async function clearVaultSecret(keyStore?: SecureKeyStore): Promise<void> {
  try {
    const store = keyStore ?? (await createPlatformKeyStore());
    if (typeof store.deleteItem === "function") {
      await store.deleteItem(VAULT_SECRET_STORAGE_KEY);
    }
  } catch {
    // Non-fatal if keystore unavailable during recovery teardown
  }
}
