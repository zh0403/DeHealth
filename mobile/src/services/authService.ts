import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Address,
  AddressSchema,
  AuthSessionMetadata,
  AuthSessionMetadataSchema
} from "@dehealth/shared";
import {
  AbstractSigner,
  hexlify,
  Provider,
  Signer,
  toUtf8Bytes,
  TransactionRequest,
  TypedDataDomain,
  TypedDataEncoder,
  TypedDataField,
  Wallet
} from "ethers";
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
import { getOrCreatePersistentWallet } from "../storage/walletStorage";
import { assertZeroRawBiometrics, getSupabaseClient } from "./supabaseService";

export const AUTH_SESSION_STORAGE_KEY = "@dehealth/auth_session";

const ZERO_ADDRESS_REGEX = /^0x0{40}$/i;
const GOOGLE_UNVERIFIED_MESSAGE =
  "Google sign-in was not verified. Complete Google authentication in the browser and try again.";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthServiceMode = "live" | "local-fallback";

export interface Eip1193RequestArgs {
  readonly method: string;
  readonly params?: readonly unknown[];
}

export interface Eip1193Provider {
  readonly isMetaMask?: boolean;
  request(args: Eip1193RequestArgs): Promise<unknown>;
}

export interface ExternalWalletConnection {
  readonly address: string;
  readonly provider?: Eip1193Provider;
}

export interface MetaMaskAdapter {
  connect(): Promise<ExternalWalletConnection>;
}

export interface WalletConnectAdapter {
  connect(projectId: string): Promise<ExternalWalletConnection>;
  disconnect?(): Promise<void>;
}

export interface AuthSignInResult {
  readonly session: AuthSessionMetadata;
  readonly wallet: Wallet | null;
  readonly signer: Signer | null;
  readonly walletAddress: Address;
  readonly mode: AuthServiceMode;
  readonly oauthUrl?: string | null;
}

export interface LocalSessionOptions {
  readonly keyStore?: SecureKeyStore;
  readonly storage?: AuthSessionStorage;
  readonly localDisplayLabel?: string;
  readonly nowMs?: number;
}

export interface GoogleSignInOptions {
  readonly keyStore?: SecureKeyStore;
  readonly storage?: AuthSessionStorage;
  readonly redirectTo?: string;
  readonly localGoogleHint?: string;
  readonly localDisplayLabel?: string;
  readonly verifyOAuthCallback?: () => Promise<void>;
  readonly nowMs?: number;
}

export interface MetaMaskSignInOptions {
  readonly adapter?: MetaMaskAdapter;
  readonly storage?: AuthSessionStorage;
  readonly nowMs?: number;
}

export interface WalletConnectSignInOptions {
  readonly projectId?: string;
  readonly adapter?: WalletConnectAdapter;
  readonly storage?: AuthSessionStorage;
  readonly nowMs?: number;
}

let customMetaMaskAdapter: MetaMaskAdapter | null = null;
let customWalletConnectAdapter: WalletConnectAdapter | null = null;

/**
 * Injects a custom MetaMask connection adapter for hermetic tests or native bridges.
 */
export function setMetaMaskAdapterForTesting(
  adapter: MetaMaskAdapter | null
): void {
  customMetaMaskAdapter = adapter;
}

/**
 * Resets any injected MetaMask connection adapter back to default global discovery.
 */
export function resetMetaMaskAdapterForTesting(): void {
  customMetaMaskAdapter = null;
}

/**
 * Injects a custom WalletConnect v2 adapter for hermetic tests or native bridges.
 */
export function setWalletConnectAdapterForTesting(
  adapter: WalletConnectAdapter | null
): void {
  customWalletConnectAdapter = adapter;
}

/**
 * Resets any injected WalletConnect v2 adapter back to unconfigured default.
 */
export function resetWalletConnectAdapterForTesting(): void {
  customWalletConnectAdapter = null;
}

/**
 * Resolves the configured WalletConnect v2 Project ID from
 * `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID`, returning `null` if blank or unset.
 */
export function getWalletConnectProjectId(): string | null {
  const raw =
    typeof process !== "undefined"
      ? process.env?.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim()
      : undefined;
  return raw && raw.length > 0 ? raw : null;
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

function toAuthErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim().length > 0) {
    return err.trim();
  }
  if (
    typeof err === "object" &&
    err !== null &&
    !Array.isArray(err) &&
    "message" in err &&
    typeof (err as { readonly message?: unknown }).message === "string"
  ) {
    const msg = (err as { readonly message: string }).message.trim();
    if (msg.length > 0) {
      return msg;
    }
  }
  return fallback;
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

function validateNonZeroEvmAddress(
  rawAddress: unknown,
  errorMessage: string
): Address {
  const candidate = typeof rawAddress === "string" ? rawAddress.trim() : rawAddress;
  const parsed = AddressSchema.safeParse(candidate);
  if (!parsed.success || ZERO_ADDRESS_REGEX.test(parsed.data)) {
    throw new AuthError(errorMessage);
  }
  return parsed.data;
}

function isEip1193Provider(candidate: unknown): candidate is Eip1193Provider {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const record = candidate as { readonly request?: unknown };
  return typeof record.request === "function";
}

function resolveGlobalEthereumProvider(): Eip1193Provider | null {
  const globalObj = globalThis as {
    readonly ethereum?: unknown;
    readonly window?: { readonly ethereum?: unknown };
  };
  if (isEip1193Provider(globalObj.ethereum)) {
    return globalObj.ethereum;
  }
  if (isEip1193Provider(globalObj.window?.ethereum)) {
    return globalObj.window.ethereum;
  }
  return null;
}

class Eip1193TypedDataSigner extends AbstractSigner {
  private readonly walletAddress: Address;
  private readonly eip1193Provider: Eip1193Provider;

  constructor(
    walletAddress: Address,
    eip1193Provider: Eip1193Provider,
    ethersProvider: null | Provider = null
  ) {
    super(ethersProvider);
    this.walletAddress = walletAddress;
    this.eip1193Provider = eip1193Provider;
  }

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  connect(provider: null | Provider): Signer {
    return new Eip1193TypedDataSigner(
      this.walletAddress,
      this.eip1193Provider,
      provider
    );
  }

  async signTransaction(_tx: TransactionRequest): Promise<string> {
    throw new AuthError(
      "External EIP-1193 wallets do not support raw offline signTransaction."
    );
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const encoded = hexlify(
      typeof message === "string" ? toUtf8Bytes(message) : message
    );
    let signature: unknown;
    try {
      signature = await this.eip1193Provider.request({
        method: "personal_sign",
        params: [encoded, this.walletAddress]
      });
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw new AuthError(
        toAuthErrorMessage(
          err,
          "External wallet message signature was rejected."
        )
      );
    }

    if (typeof signature !== "string" || signature.trim().length === 0) {
      throw new AuthError(
        "External wallet did not return a valid message signature."
      );
    }
    return signature.trim();
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, unknown>
  ): Promise<string> {
    const mutableTypes: Record<string, Array<TypedDataField>> = {};
    for (const [typeName, fields] of Object.entries(types)) {
      mutableTypes[typeName] = fields.map((field) => ({
        name: field.name,
        type: field.type
      }));
    }

    let signature: unknown;
    try {
      const payload: unknown = TypedDataEncoder.getPayload(
        domain,
        mutableTypes,
        value
      );
      const payloadJson =
        JSON.stringify(payload, (_key: string, item: unknown): unknown =>
          typeof item === "bigint" ? item.toString() : item
        ) ?? "{}";

      signature = await this.eip1193Provider.request({
        method: "eth_signTypedData_v4",
        params: [this.walletAddress, payloadJson]
      });
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw new AuthError(
        toAuthErrorMessage(
          err,
          "External wallet EIP-712 typed data signature was rejected."
        )
      );
    }

    if (typeof signature !== "string" || signature.trim().length === 0) {
      throw new AuthError(
        "External wallet did not return a valid EIP-712 signature."
      );
    }
    return signature.trim();
  }
}

/**
 * Wraps an EIP-1193 wallet provider into an ethers v6 `Signer` that dispatches
 * EIP-712 typed data signing via `eth_signTypedData_v4`.
 */
export function createEip1193Signer(
  address: Address,
  provider: Eip1193Provider
): Signer {
  const validatedAddress = validateNonZeroEvmAddress(
    address,
    "External wallet did not provide a valid EVM wallet address."
  );
  return new Eip1193TypedDataSigner(validatedAddress, provider);
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
 * Starts or resumes an on-device sovereign local session using the encrypted
 * embedded wallet without cloud identity claims.
 */
export async function startLocalSession(
  options?: LocalSessionOptions
): Promise<AuthSignInResult> {
  const wallet = await getOrCreatePersistentWallet(options?.keyStore);
  const walletAddress = wallet.address as Address;
  const trimmedLabel = options?.localDisplayLabel?.trim();
  const displayLabel = (
    trimmedLabel && trimmedLabel.length > 0
      ? trimmedLabel
      : `Local Session (${formatShortAddress(walletAddress)})`
  ).slice(0, 128);

  const sessionPayload: AuthSessionMetadata = {
    authMethod: "local",
    accountId: `local:${walletAddress.toLowerCase()}`,
    displayLabel,
    walletAddress,
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
    signer: wallet,
    walletAddress,
    mode: "local-fallback",
    oauthUrl: null
  };
}

/**
 * Signs in with Google via verified Supabase OAuth (`client.auth.getUser()`),
 * or delegates explicitly to `startLocalSession` (`authMethod: "local"`) when
 * Supabase is offline/unconfigured. Never provisions a wallet or persists a
 * `"google"` session unless `getUser()` returns a verified user ID.
 */
export async function signInWithGoogle(
  options?: GoogleSignInOptions
): Promise<AuthSignInResult> {
  const client = getSupabaseClient();

  if (client === null) {
    const fallbackLabel =
      options?.localDisplayLabel?.trim() || options?.localGoogleHint?.trim();
    return startLocalSession({
      keyStore: options?.keyStore,
      storage: options?.storage,
      ...(fallbackLabel ? { localDisplayLabel: fallbackLabel } : {}),
      nowMs: options?.nowMs
    });
  }

  const signedInAtMs = options?.nowMs ?? Date.now();
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
    throw new AuthError(toAuthErrorMessage(err, "Google sign-in failed."));
  }

  if (options?.verifyOAuthCallback) {
    try {
      await options.verifyOAuthCallback();
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw new AuthError(
        toAuthErrorMessage(err, "Google sign-in callback verification failed.")
      );
    }
  }

  if (typeof client.auth?.getUser !== "function") {
    throw new AuthError(GOOGLE_UNVERIFIED_MESSAGE);
  }

  let verifiedUserId: string;
  let email: string | null = null;
  let fullName: string | null = null;
  try {
    const userResult = await client.auth.getUser();
    if (userResult?.error) {
      throw new AuthError(GOOGLE_UNVERIFIED_MESSAGE);
    }
    const user = userResult?.data?.user ?? null;
    if (!user || typeof user.id !== "string" || user.id.trim().length === 0) {
      throw new AuthError(GOOGLE_UNVERIFIED_MESSAGE);
    }
    verifiedUserId = user.id.trim().slice(0, 128);
    email =
      typeof user.email === "string" && user.email.trim().length > 0
        ? user.email.trim()
        : null;
    fullName = extractStringProperty(
      user.user_metadata as unknown,
      "full_name"
    );
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw new AuthError(GOOGLE_UNVERIFIED_MESSAGE);
  }

  const wallet = await getOrCreatePersistentWallet(options?.keyStore);
  const walletAddress = wallet.address as Address;
  const displayLabel = (
    email ??
    fullName ??
    `Google (${formatShortAddress(walletAddress)})`
  ).slice(0, 128);

  const sessionPayload: AuthSessionMetadata = {
    authMethod: "google",
    accountId: verifiedUserId,
    displayLabel,
    walletAddress,
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
    signer: wallet,
    walletAddress,
    mode: "live",
    oauthUrl
  };
}

/**
 * Connects an external MetaMask / injected EIP-1193 wallet and persists a
 * strictly non-biometric `metamask` session backed by an EIP-1193 signer.
 */
export async function signInWithMetaMask(
  options?: MetaMaskSignInOptions
): Promise<AuthSignInResult> {
  const adapter = options?.adapter ?? customMetaMaskAdapter;
  let connection: ExternalWalletConnection;

  if (adapter) {
    try {
      connection = await adapter.connect();
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw new AuthError(
        toAuthErrorMessage(err, "MetaMask connection failed.")
      );
    }
  } else {
    const provider = resolveGlobalEthereumProvider();
    if (!provider) {
      throw new AuthError(
        "MetaMask provider is unavailable. Install MetaMask or open the app inside the MetaMask browser."
      );
    }

    let accountsResult: unknown;
    try {
      accountsResult = await provider.request({
        method: "eth_requestAccounts"
      });
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw new AuthError(
        toAuthErrorMessage(err, "MetaMask account connection was rejected.")
      );
    }

    const firstAccount = Array.isArray(accountsResult)
      ? accountsResult[0]
      : undefined;
    if (typeof firstAccount !== "string") {
      throw new AuthError(
        "MetaMask did not return a valid EVM wallet address."
      );
    }

    connection = {
      address: firstAccount,
      provider
    };
  }

  const validatedAddress = validateNonZeroEvmAddress(
    connection.address,
    "MetaMask did not return a valid EVM wallet address."
  );

  const sessionPayload: AuthSessionMetadata = {
    authMethod: "metamask",
    accountId: validatedAddress,
    displayLabel: `MetaMask (${formatShortAddress(validatedAddress)})`,
    walletAddress: validatedAddress,
    signedInAtMs: options?.nowMs ?? Date.now()
  };

  const targetStorage = await resolveAuthStorage(options?.storage);
  const session = await savePersistedAuthSession(sessionPayload, targetStorage);
  const signer = connection.provider
    ? createEip1193Signer(validatedAddress, connection.provider)
    : null;

  return {
    session,
    wallet: null,
    signer,
    walletAddress: validatedAddress,
    mode: "live",
    oauthUrl: null
  };
}

/**
 * Connects an external wallet over WalletConnect v2 using the configured or
 * explicitly provided Project ID and persists a `walletconnect` session.
 */
export async function signInWithWalletConnect(
  options?: WalletConnectSignInOptions
): Promise<AuthSignInResult> {
  const projectId = options?.projectId?.trim() || getWalletConnectProjectId();
  if (!projectId) {
    throw new AuthError(
      "WalletConnect Project ID is not configured. Set EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID to connect."
    );
  }

  const adapter = options?.adapter ?? customWalletConnectAdapter;
  if (!adapter) {
    throw new AuthError(
      "WalletConnect v2 provider is unavailable in this environment."
    );
  }

  let connection: ExternalWalletConnection;
  try {
    connection = await adapter.connect(projectId);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw new AuthError(
      toAuthErrorMessage(err, "WalletConnect connection failed.")
    );
  }

  const validatedAddress = validateNonZeroEvmAddress(
    connection.address,
    "WalletConnect did not return a valid EVM wallet address."
  );

  const sessionPayload: AuthSessionMetadata = {
    authMethod: "walletconnect",
    accountId: validatedAddress,
    displayLabel: `WalletConnect (${formatShortAddress(validatedAddress)})`,
    walletAddress: validatedAddress,
    signedInAtMs: options?.nowMs ?? Date.now()
  };

  const targetStorage = await resolveAuthStorage(options?.storage);
  const session = await savePersistedAuthSession(sessionPayload, targetStorage);
  const signer = connection.provider
    ? createEip1193Signer(validatedAddress, connection.provider)
    : null;

  return {
    session,
    wallet: null,
    signer,
    walletAddress: validatedAddress,
    mode: "live",
    oauthUrl: null
  };
}

/**
 * Signs out the active auth session while preserving the persistent wallet,
 * vault secret, biometrics, weight logs, plans, and governance config.
 */
export async function signOutSession(options?: {
  readonly storage?: AuthSessionStorage;
  readonly walletConnectAdapter?: WalletConnectAdapter | null;
}): Promise<void> {
  const wcAdapter = options?.walletConnectAdapter ?? customWalletConnectAdapter;
  if (wcAdapter && typeof wcAdapter.disconnect === "function") {
    try {
      await wcAdapter.disconnect();
    } catch {
      // Non-fatal if WalletConnect relay disconnect fails
    }
  }

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
