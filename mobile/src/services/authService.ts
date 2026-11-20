import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Address,
  AuthSessionMetadata,
  AuthSessionMetadataSchema
} from "@dehealth/shared";
import { Wallet } from "ethers";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../storage/encryptedStorageAdapter";
import {
  createPlatformKeyStore,
  provisionVaultSecret,
  SecureKeyStore,
  VaultKeyUnavailableError
} from "../storage/vaultKeyProvider";
import {
  getOrCreatePersistentWallet,
  importPersistentWallet
} from "../storage/walletStorage";
import { assertZeroRawBiometrics, getSupabaseClient } from "./supabaseService";

export const AUTH_SESSION_STORAGE_KEY = "@dehealth/auth_session";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthServiceMode = "live" | "local-fallback";

export interface AuthSignInResult {
  readonly session: AuthSessionMetadata;
  readonly wallet: Wallet;
  readonly mode: AuthServiceMode;
  readonly oauthUrl?: string | null;
}

export interface GoogleSignInOptions {
  readonly keyStore?: SecureKeyStore;
  readonly storage?: AuthSessionStorage;
  readonly redirectTo?: string;
  readonly localGoogleHint?: string;
  readonly nowMs?: number;
}

export interface WalletSignInOptions {
  readonly privateKey?: string;
  readonly keyStore?: SecureKeyStore;
  readonly storage?: AuthSessionStorage;
  readonly nowMs?: number;
}

/**
 * Formats an EVM address into a compact display label (e.g. `0x1234…abcd`).
 * Returns the trimmed input unchanged when shorter than 10 characters.
 */
export function formatShortAddress(address: string): string {
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (trimmed.length < 10) {
    return trimmed;
  }
  return `${trimmed.slice(0, 6)}\u2026${trimmed.slice(-4)}`;
}

function extractStringProperty(obj: unknown, key: string): string | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return null;
  }
  const record = obj as Record<string, unknown>;
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * AuthSessionStorage provides encrypted, schema-validated, zero-biometric
 * persistence for active session metadata using the device vault secret.
 */
export class AuthSessionStorage {
  private readonly adapter: EncryptedStorageAdapter;

  constructor(
    adapterOrPassphrase: EncryptedStorageAdapter | string,
    backend?: KeyValueStorageBackend
  ) {
    if (adapterOrPassphrase instanceof EncryptedStorageAdapter) {
      this.adapter = adapterOrPassphrase;
    } else if (typeof adapterOrPassphrase === "string") {
      this.adapter = new EncryptedStorageAdapter(adapterOrPassphrase, backend);
    } else {
      throw new VaultKeyUnavailableError(
        "AuthSessionStorage requires a provisioned vault secret."
      );
    }
  }

  getAdapter(): EncryptedStorageAdapter {
    return this.adapter;
  }

  /**
   * Retrieves the persisted AuthSessionMetadata. Returns `null` when absent or
   * when payload fails Zod schema validation; MAC tampering errors propagate.
   */
  async getPersistedAuthSession(): Promise<AuthSessionMetadata | null> {
    const raw = await this.adapter.getEncryptedItem<unknown>(
      AUTH_SESSION_STORAGE_KEY
    );
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = AuthSessionMetadataSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Enforces zero raw biometric leakage and Zod schema validation before
   * encrypting and persisting AuthSessionMetadata on-device.
   */
  async savePersistedAuthSession(
    session: AuthSessionMetadata
  ): Promise<AuthSessionMetadata> {
    assertZeroRawBiometrics(session);
    const validated = AuthSessionMetadataSchema.parse(session);
    await this.adapter.setEncryptedItem(AUTH_SESSION_STORAGE_KEY, validated);
    return validated;
  }

  /**
   * Removes the encrypted auth session key without affecting wallet or biometric data.
   */
  async clearPersistedAuthSession(): Promise<void> {
    await this.adapter.removeEncryptedItem(AUTH_SESSION_STORAGE_KEY);
  }
}

let defaultAuthStorage: AuthSessionStorage | null = null;
let authInitPromise: Promise<AuthSessionStorage> | null = null;

/**
 * Initializes the process-wide AuthSessionStorage using the device's vault secret.
 */
export function initializeAuthSessionStorage(
  keyStore?: SecureKeyStore,
  backend?: KeyValueStorageBackend
): Promise<AuthSessionStorage> {
  if (defaultAuthStorage) {
    return Promise.resolve(defaultAuthStorage);
  }
  if (authInitPromise) {
    return authInitPromise;
  }

  let pending!: Promise<AuthSessionStorage>;
  pending = (async (): Promise<AuthSessionStorage> => {
    const store = keyStore ?? (await createPlatformKeyStore());
    const secret = await provisionVaultSecret(store);
    const storage = new AuthSessionStorage(secret, backend);
    if (authInitPromise === pending) {
      defaultAuthStorage = storage;
    }
    return storage;
  })();

  authInitPromise = pending;
  pending.catch(() => {
    if (authInitPromise === pending) {
      authInitPromise = null;
    }
  });
  return pending;
}

export function getAuthSessionStorage(): AuthSessionStorage {
  if (!defaultAuthStorage) {
    throw new VaultKeyUnavailableError(
      "AuthSessionStorage is not initialized; call initializeAuthSessionStorage() first."
    );
  }
  return defaultAuthStorage;
}

export function setAuthSessionStorage(storage: AuthSessionStorage): void {
  defaultAuthStorage = storage;
  authInitPromise = null;
}

export function resetAuthSessionStorage(): void {
  defaultAuthStorage = null;
  authInitPromise = null;
}

async function resolveAuthStorage(
  storage?: AuthSessionStorage,
  keyStore?: SecureKeyStore
): Promise<AuthSessionStorage> {
  if (storage) {
    return storage;
  }
  return defaultAuthStorage ?? initializeAuthSessionStorage(keyStore);
}

export async function getPersistedAuthSession(
  storage?: AuthSessionStorage
): Promise<AuthSessionMetadata | null> {
  return (await resolveAuthStorage(storage)).getPersistedAuthSession();
}

export async function savePersistedAuthSession(
  session: AuthSessionMetadata,
  storage?: AuthSessionStorage
): Promise<AuthSessionMetadata> {
  return (await resolveAuthStorage(storage)).savePersistedAuthSession(session);
}

export async function clearPersistedAuthSession(
  storage?: AuthSessionStorage
): Promise<void> {
  return (await resolveAuthStorage(storage)).clearPersistedAuthSession();
}

/**
 * Removes the raw auth session storage key from the underlying backend without
 * requiring a valid vault key (used during vault reset recovery).
 */
export async function purgeAuthSessionStorageKey(
  backend?: KeyValueStorageBackend
): Promise<void> {
  const targetBackend =
    backend ?? (AsyncStorage as unknown as KeyValueStorageBackend);
  await targetBackend.removeItem(AUTH_SESSION_STORAGE_KEY);
  resetAuthSessionStorage();
}

/**
 * Signs in with Google via Supabase OAuth when configured, or falls back to
 * a deterministic local Google identity when offline/unconfigured. Automatically
 * provisions or loads the persistent encrypted embedded wallet and persists
 * non-biometric session metadata.
 */
export async function signInWithGoogle(
  options?: GoogleSignInOptions
): Promise<AuthSignInResult> {
  const client = getSupabaseClient();
  const signedInAtMs = options?.nowMs ?? Date.now();

  if (client) {
    let oauthUrl: string | null = null;
    try {
      const oauthResponse = await client.auth.signInWithOAuth({
        provider: "google",
        ...(options?.redirectTo
          ? { options: { redirectTo: options.redirectTo } }
          : {})
      });
      if (oauthResponse.error) {
        throw new AuthError(
          oauthResponse.error.message || "Google sign-in failed."
        );
      }
      oauthUrl = oauthResponse.data?.url ?? null;
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw new AuthError(
        err instanceof Error && err.message
          ? err.message
          : "Google sign-in failed."
      );
    }

    const wallet = await getOrCreatePersistentWallet(options?.keyStore);

    let remoteUserId: string | null = null;
    let remoteDisplayLabel: string | null = null;
    try {
      if (typeof client.auth?.getUser === "function") {
        const userResult = await client.auth.getUser();
        const user = userResult?.data?.user ?? null;
        if (user) {
          if (typeof user.id === "string" && user.id.trim().length > 0) {
            remoteUserId = user.id.trim().slice(0, 128);
          }
          const email =
            typeof user.email === "string" && user.email.trim().length > 0
              ? user.email.trim()
              : null;
          const fullName = extractStringProperty(
            user.user_metadata as unknown,
            "full_name"
          );
          const candidateLabel = email ?? fullName;
          if (candidateLabel) {
            remoteDisplayLabel = candidateLabel.slice(0, 128);
          }
        }
      }
    } catch {
      // Non-fatal: OAuth redirect/session user lookup may be unavailable until callback completes
    }

    const shortAddress = formatShortAddress(wallet.address);
    const accountId =
      remoteUserId ?? `google_${wallet.address.slice(2, 10).toLowerCase()}`;
    const displayLabel = remoteDisplayLabel ?? `Google (${shortAddress})`;

    const sessionPayload: AuthSessionMetadata = {
      authMethod: "google",
      accountId,
      displayLabel,
      walletAddress: wallet.address as Address,
      signedInAtMs
    };

    const targetStorage = await resolveAuthStorage(
      options?.storage,
      options?.keyStore
    );
    const session = await savePersistedAuthSession(sessionPayload, targetStorage);
    return {
      session,
      wallet,
      mode: "live",
      oauthUrl
    };
  }

  const wallet = await getOrCreatePersistentWallet(options?.keyStore);
  const shortAddress = formatShortAddress(wallet.address);
  const hint = options?.localGoogleHint?.trim();
  const displayLabel =
    hint && hint.length > 0
      ? hint.slice(0, 128)
      : `Google (${shortAddress})`;

  const sessionPayload: AuthSessionMetadata = {
    authMethod: "google",
    accountId: `google_local_${wallet.address.slice(2, 10).toLowerCase()}`,
    displayLabel,
    walletAddress: wallet.address as Address,
    signedInAtMs
  };

  const targetStorage = await resolveAuthStorage(
    options?.storage,
    options?.keyStore
  );
  const session = await savePersistedAuthSession(sessionPayload, targetStorage);
  return {
    session,
    wallet,
    mode: "local-fallback",
    oauthUrl: null
  };
}

/**
 * Signs in directly using an existing embedded wallet or by importing a
 * provided private key, then persists encrypted wallet session metadata.
 */
export async function continueWithWallet(
  options?: WalletSignInOptions
): Promise<AuthSignInResult> {
  const wallet =
    options?.privateKey && options.privateKey.trim().length > 0
      ? await importPersistentWallet(options.privateKey.trim(), options?.keyStore)
      : await getOrCreatePersistentWallet(options?.keyStore);

  const sessionPayload: AuthSessionMetadata = {
    authMethod: "wallet",
    accountId: `wallet:${wallet.address.toLowerCase()}`,
    displayLabel: formatShortAddress(wallet.address),
    walletAddress: wallet.address as Address,
    signedInAtMs: options?.nowMs ?? Date.now()
  };

  const targetStorage = await resolveAuthStorage(
    options?.storage,
    options?.keyStore
  );
  const session = await savePersistedAuthSession(sessionPayload, targetStorage);
  return {
    session,
    wallet,
    mode: "local-fallback"
  };
}

/**
 * Signs out the active auth session while preserving the persistent wallet,
 * vault secret, biometrics, weight logs, plans, and governance config.
 */
export async function signOutSession(options?: {
  readonly storage?: AuthSessionStorage;
}): Promise<void> {
  const client = getSupabaseClient();
  if (client) {
    try {
      if (typeof client.auth?.signOut === "function") {
        await client.auth.signOut();
      }
    } catch {
      // Non-fatal if remote Supabase sign-out fails or device is offline
    }
  }
  await clearPersistedAuthSession(options?.storage);
}
