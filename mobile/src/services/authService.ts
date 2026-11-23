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
  restoreSession?(expectedAddress: Address): Promise<ExternalWalletConnection | null>;
}

export interface WalletConnectAdapter {
  connect(projectId: string): Promise<ExternalWalletConnection>;
  restoreSession?(
    projectId: string,
    expectedAddress: Address
  ): Promise<ExternalWalletConnection | null>;
  disconnect?(): Promise<void>;
}

export interface OAuthBrowserSessionResult {
  readonly type: string;
  readonly url?: string;
}

export interface OAuthBrowserAdapter {
  openAuthSessionAsync(
    url: string,
    redirectUrl?: string | null
  ): Promise<OAuthBrowserSessionResult>;
  maybeCompleteAuthSession?: () => unknown;
}

export interface UniversalProviderInitOptions {
  readonly projectId: string;
  readonly metadata: {
    readonly name: string;
    readonly description: string;
    readonly url: string;
    readonly icons: string[];
  };
}

export interface UniversalProviderLike {
  readonly session?: {
    readonly namespaces?: Readonly<
      Record<
        string,
        | {
            readonly accounts?: readonly string[];
          }
        | undefined
      >
    >;
  };
  on(event: string, listener: (payload: string) => void): void;
  off?(event: string, listener: (payload: string) => void): void;
  removeListener?(event: string, listener: (payload: string) => void): void;
  connect(params: {
    readonly optionalNamespaces: {
      readonly eip155: {
        readonly methods: string[];
        readonly chains: string[];
        readonly events: string[];
      };
    };
  }): Promise<unknown>;
  request(args: {
    readonly method: string;
    readonly params?: unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
  enable?(): Promise<readonly string[]>;
  disconnect?(): Promise<void>;
  abortPairingAttempt?(): void;
}

export type UniversalProviderFactory = (
  options: UniversalProviderInitOptions
) => Promise<UniversalProviderLike>;

export type DeepLinkOpener = (url: string) => Promise<void>;

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
  readonly browserAdapter?: OAuthBrowserAdapter | null;
  readonly nowMs?: number;
}

export interface MetaMaskSignInOptions {
  readonly adapter?: MetaMaskAdapter;
  readonly projectId?: string;
  readonly storage?: AuthSessionStorage;
  readonly nowMs?: number;
}

export interface WalletConnectSignInOptions {
  readonly projectId?: string;
  readonly adapter?: WalletConnectAdapter;
  readonly storage?: AuthSessionStorage;
  readonly nowMs?: number;
}

let customMetaMaskAdapter: MetaMaskAdapter | null | undefined = undefined;
let customWalletConnectAdapter: WalletConnectAdapter | null | undefined =
  undefined;
let customOAuthBrowserAdapter: OAuthBrowserAdapter | null | undefined = undefined;
let customUniversalProviderFactory: UniversalProviderFactory | null | undefined =
  undefined;
let customDeepLinkOpener: DeepLinkOpener | undefined = undefined;
let activeUniversalProvider: UniversalProviderLike | null = null;
let activeUniversalProviderProjectId: string | null = null;

/**
 * Injects a custom MetaMask connection adapter for hermetic tests or native bridges.
 * Pass `null` to disable native WalletConnect fallback in unavailable-provider tests.
 */
export function setMetaMaskAdapterForTesting(
  adapter: MetaMaskAdapter | null | undefined
): void {
  customMetaMaskAdapter = adapter;
}

/**
 * Resets any injected MetaMask connection adapter back to default discovery.
 */
export function resetMetaMaskAdapterForTesting(): void {
  customMetaMaskAdapter = undefined;
}

/**
 * Injects a custom WalletConnect v2 adapter for hermetic tests or native bridges.
 * Pass `null` to simulate an unavailable WalletConnect v2 provider.
 */
export function setWalletConnectAdapterForTesting(
  adapter: WalletConnectAdapter | null | undefined
): void {
  customWalletConnectAdapter = adapter;
}

/**
 * Resets any injected WalletConnect v2 adapter back to default native UniversalProvider discovery.
 */
export function resetWalletConnectAdapterForTesting(): void {
  customWalletConnectAdapter = undefined;
  activeUniversalProvider = null;
  activeUniversalProviderProjectId = null;
}

/**
 * Injects a custom Expo WebBrowser adapter for deterministic OAuth browser redirect tests.
 */
export function setOAuthBrowserAdapterForTesting(
  adapter: OAuthBrowserAdapter | null | undefined
): void {
  customOAuthBrowserAdapter = adapter;
}

/**
 * Restores dynamic `expo-web-browser` resolution for OAuth browser sessions.
 */
export function resetOAuthBrowserAdapterForTesting(): void {
  customOAuthBrowserAdapter = undefined;
  pendingGoogleOAuthAttempt = false;
  activeGoogleSignInCalls = 0;
  inFlightOAuthExchanges.clear();
  completedOAuthExchanges.clear();
}

/**
 * Injects a custom `@walletconnect/universal-provider` initializer for tests.
 */
export function setUniversalProviderFactoryForTesting(
  factory: UniversalProviderFactory | null | undefined
): void {
  customUniversalProviderFactory = factory;
  activeUniversalProvider = null;
  activeUniversalProviderProjectId = null;
}

/**
 * Restores dynamic `@walletconnect/universal-provider` initialization.
 */
export function resetUniversalProviderFactoryForTesting(): void {
  customUniversalProviderFactory = undefined;
  activeUniversalProvider = null;
  activeUniversalProviderProjectId = null;
}

/**
 * Injects a custom URL opener (replaces `Linking.openURL`) for deterministic deep-link tests.
 */
export function setDeepLinkOpenerForTesting(
  opener: DeepLinkOpener | undefined
): void {
  customDeepLinkOpener = opener;
}

/**
 * Restores default `react-native` `Linking.openURL` deep-link dispatch.
 */
export function resetDeepLinkOpenerForTesting(): void {
  customDeepLinkOpener = undefined;
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
  pendingGoogleOAuthAttempt = false;
  activeGoogleSignInCalls = 0;
  inFlightOAuthExchanges.clear();
  completedOAuthExchanges.clear();
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

const DEFAULT_OAUTH_REDIRECT_URI = "dehealth://auth-callback";
const ARBITRUM_SEPOLIA_CAIP2 = "eip155:421614";
const BOOT_RESTORE_TIMEOUT_MS = 2_500;
const DEHEALTH_WALLETCONNECT_METADATA = {
  name: "DeHealth Protocol",
  description: "Zero-Egress Biometric Sovereignty & Arbitrum Sepolia Habit Proofs",
  url: "https://dehealth.app",
  icons: [] as string[]
};

function isReactNativeRuntime(): boolean {
  return (
    typeof navigator !== "undefined" && navigator.product === "ReactNative"
  );
}

function isOAuthBrowserAdapterLike(
  candidate: unknown
): candidate is OAuthBrowserAdapter {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const record = candidate as { readonly openAuthSessionAsync?: unknown };
  return typeof record.openAuthSessionAsync === "function";
}

async function resolveOAuthBrowserAdapter(
  explicitAdapter?: OAuthBrowserAdapter | null
): Promise<OAuthBrowserAdapter | null> {
  if (explicitAdapter !== undefined) {
    return explicitAdapter;
  }
  if (customOAuthBrowserAdapter !== undefined) {
    return customOAuthBrowserAdapter;
  }
  try {
    const mod: unknown = await import("expo-web-browser");
    return isOAuthBrowserAdapterLike(mod) ? mod : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the platform OAuth redirect URI using `expo-auth-session` with custom
 * scheme `"dehealth"` (`dehealth://auth-callback` on native fallback).
 */
export async function resolveGoogleOAuthRedirectUri(): Promise<string> {
  try {
    const authSessionMod = (await import("expo-auth-session")) as {
      makeRedirectUri?: (options?: {
        readonly scheme?: string;
        readonly path?: string;
      }) => string;
    };
    if (typeof authSessionMod.makeRedirectUri === "function") {
      const uri = authSessionMod.makeRedirectUri({
        scheme: "dehealth",
        path: "auth-callback"
      });
      if (typeof uri === "string" && uri.trim().length > 0) {
        return uri.trim();
      }
    }
  } catch {
    // Fallback cleanly in Node / headless test environments
  }
  return DEFAULT_OAUTH_REDIRECT_URI;
}

interface ParsedOAuthCallbackParams {
  readonly code: string | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly error: string | null;
  readonly errorDescription: string | null;
}

function parseOAuthCallbackParams(
  callbackUrl: string
): ParsedOAuthCallbackParams {
  const empty: ParsedOAuthCallbackParams = {
    code: null,
    accessToken: null,
    refreshToken: null,
    error: null,
    errorDescription: null
  };
  if (typeof callbackUrl !== "string" || callbackUrl.trim().length === 0) {
    return empty;
  }

  const trimmed = callbackUrl.trim();
  const hashIndex = trimmed.indexOf("#");
  const beforeHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const rawHash = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";
  const queryIndex = beforeHash.indexOf("?");
  const rawQuery = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : "";

  const queryParams = new URLSearchParams(rawQuery);
  const hashParams = new URLSearchParams(rawHash);
  const readParam = (name: string): string | null => {
    const val = queryParams.get(name) ?? hashParams.get(name);
    if (val === null) {
      return null;
    }
    const clean = val.trim();
    return clean.length > 0 ? clean : null;
  };

  return {
    code: readParam("code"),
    accessToken: readParam("access_token"),
    refreshToken: readParam("refresh_token"),
    error: readParam("error"),
    errorDescription: readParam("error_description")
  };
}

const inFlightOAuthExchanges = new Map<string, Promise<boolean>>();
const completedOAuthExchanges = new Set<string>();
let pendingGoogleOAuthAttempt = false;
let activeGoogleSignInCalls = 0;

/**
 * Returns true while a user-initiated Google OAuth flow is awaiting redirect
 * verification, preventing unsolicited `dehealth://auth-callback` deep links.
 */
export function hasPendingGoogleOAuthAttempt(): boolean {
  return pendingGoogleOAuthAttempt;
}

/**
 * Arms or clears the pending Google OAuth attempt flag for deterministic tests.
 */
export function setPendingGoogleOAuthAttemptForTesting(
  pending: boolean
): void {
  pendingGoogleOAuthAttempt = pending;
}

function isAuthCallbackRedirectUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return (
    normalized.startsWith("dehealth://auth-callback") ||
    normalized.includes("/auth-callback")
  );
}

/**
 * Extracts Supabase PKCE authorization `code` from a redirect callback URL and
 * exchanges it via `client.auth.exchangeCodeForSession`. Rejects unsolicited
 * OAuth callbacks when `hasPendingGoogleOAuthAttempt()` is false and rejects raw
 * implicit URL tokens (`access_token` / `refresh_token`) in favor of strict PKCE.
 */
export async function completeOAuthRedirectCallback(
  callbackUrl: string,
  supabaseClient?: ReturnType<typeof getSupabaseClient>
): Promise<boolean> {
  const params = parseOAuthCallbackParams(callbackUrl);
  const hasOAuthCredentialOrError = Boolean(
    params.code ||
      params.accessToken ||
      params.error ||
      params.errorDescription
  );

  // The OS can deliver a redirect through the link listener after the active
  // sign-in already consumed it (for example Android Custom Tabs). Treat a
  // repeat of a completed authorization code as a quiet no-op. Anything else
  // that arrives with no sign-in pending is still rejected below.
  if (
    !pendingGoogleOAuthAttempt &&
    params.code &&
    !params.accessToken &&
    !params.error &&
    !params.errorDescription &&
    completedOAuthExchanges.has(`code:${params.code}`)
  ) {
    return false;
  }

  if (
    !pendingGoogleOAuthAttempt &&
    (hasOAuthCredentialOrError || isAuthCallbackRedirectUrl(callbackUrl))
  ) {
    throw new AuthError(
      "Unsolicited Google OAuth callback rejected: no sign-in flow is active."
    );
  }

  if (params.errorDescription || params.error) {
    throw new AuthError(
      params.errorDescription ?? params.error ?? "Google sign-in failed."
    );
  }

  if (params.accessToken && !params.code) {
    throw new AuthError(
      "Google sign-in requires a PKCE authorization code; implicit URL tokens are rejected."
    );
  }

  if (!params.code) {
    return false;
  }

  const client =
    supabaseClient !== undefined ? supabaseClient : getSupabaseClient();
  if (!client) {
    return false;
  }

  const dedupKey = `code:${params.code}`;
  if (completedOAuthExchanges.has(dedupKey)) {
    return true;
  }
  const existingFlight = inFlightOAuthExchanges.get(dedupKey);
  if (existingFlight) {
    return existingFlight;
  }

  const runExchange = (async (): Promise<boolean> => {
    if (typeof client.auth?.exchangeCodeForSession !== "function") {
      throw new AuthError(GOOGLE_UNVERIFIED_MESSAGE);
    }
    const exchangeResult = await client.auth.exchangeCodeForSession(
      params.code!
    );
    if (exchangeResult?.error) {
      throw new AuthError(
        exchangeResult.error.message || "Google OAuth code exchange failed."
      );
    }
    completedOAuthExchanges.add(dedupKey);
    return true;
  })();

  inFlightOAuthExchanges.set(dedupKey, runExchange);
  try {
    return await runExchange;
  } finally {
    inFlightOAuthExchanges.delete(dedupKey);
  }
}

/**
 * Verifies an active Supabase user (`client.auth.getUser()`), provisions the
 * persistent embedded wallet, and encrypts/saves the `"google"` auth session.
 */
export async function hydrateVerifiedGoogleSession(
  options?: Pick<GoogleSignInOptions, "keyStore" | "storage" | "nowMs"> & {
    readonly oauthUrl?: string | null;
    readonly supabaseClient?: ReturnType<typeof getSupabaseClient>;
  }
): Promise<AuthSignInResult> {
  const client =
    options?.supabaseClient !== undefined
      ? options.supabaseClient
      : getSupabaseClient();
  if (!client || typeof client.auth?.getUser !== "function") {
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
    mode: "live",
    oauthUrl: options?.oauthUrl ?? null
  };
}

/**
 * Handles an incoming cold or warm OAuth redirect URL (via `Linking`), completing
 * PKCE code exchange and hydrating the verified `"google"` session ONLY when a
 * Google OAuth attempt is active. Returns `null` for non-OAuth URLs.
 */
export async function handleIncomingOAuthRedirectUrl(
  callbackUrl: string,
  options?: Pick<GoogleSignInOptions, "keyStore" | "storage" | "nowMs">
): Promise<AuthSignInResult | null> {
  try {
    const handled = await completeOAuthRedirectCallback(callbackUrl);
    if (!handled) {
      return null;
    }
    return await hydrateVerifiedGoogleSession(options);
  } finally {
    if (activeGoogleSignInCalls === 0) {
      pendingGoogleOAuthAttempt = false;
    }
  }
}

/**
 * Signs in with Google via verified Supabase OAuth (`client.auth.getUser()`),
 * opening the system browser via `expo-web-browser` when an OAuth URL is returned
 * and exchanging PKCE authorization codes, or delegates explicitly to `startLocalSession`
 * (`authMethod: "local"`) when Supabase is offline/unconfigured. Never provisions a
 * wallet or persists a `"google"` session unless `getUser()` returns a verified user ID.
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
  const redirectTo =
    options?.redirectTo?.trim() || (await resolveGoogleOAuthRedirectUri());

  activeGoogleSignInCalls += 1;
  pendingGoogleOAuthAttempt = true;
  try {
    let oauthUrl: string | null = null;
    try {
      const oauthResponse = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          skipBrowserRedirect: true
        }
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
          toAuthErrorMessage(
            err,
            "Google sign-in callback verification failed."
          )
        );
      }
    } else if (oauthUrl && oauthUrl.trim().length > 0) {
      const browserAdapter = await resolveOAuthBrowserAdapter(
        options?.browserAdapter
      );
      if (browserAdapter) {
        let browserResult: OAuthBrowserSessionResult;
        try {
          browserResult = await browserAdapter.openAuthSessionAsync(
            oauthUrl,
            redirectTo
          );
        } catch (err) {
          if (err instanceof AuthError) {
            throw err;
          }
          throw new AuthError(
            toAuthErrorMessage(
              err,
              "Unable to open browser for Google authentication."
            )
          );
        }

        if (
          browserResult.type === "cancel" ||
          browserResult.type === "dismiss"
        ) {
          throw new AuthError("Google sign-in was cancelled.");
        }

        if (
          browserResult.type !== "success" &&
          browserResult.type !== "opened"
        ) {
          throw new AuthError(GOOGLE_UNVERIFIED_MESSAGE);
        }

        if (
          browserResult.type === "success" &&
          typeof browserResult.url === "string" &&
          browserResult.url.trim().length > 0
        ) {
          await completeOAuthRedirectCallback(browserResult.url, client);
        }
      }
    }

    return await hydrateVerifiedGoogleSession({
      keyStore: options?.keyStore,
      storage: options?.storage,
      nowMs: signedInAtMs,
      oauthUrl,
      supabaseClient: client
    });
  } finally {
    activeGoogleSignInCalls = Math.max(0, activeGoogleSignInCalls - 1);
    if (activeGoogleSignInCalls === 0) {
      pendingGoogleOAuthAttempt = false;
    }
  }
}

async function openDeepLinkUrl(url: string): Promise<void> {
  if (customDeepLinkOpener) {
    await customDeepLinkOpener(url);
    return;
  }
  const rn = (await import("react-native")) as {
    readonly Linking?: {
      readonly openURL?: (targetUrl: string) => Promise<unknown>;
    };
  };
  if (typeof rn.Linking?.openURL !== "function") {
    throw new AuthError(
      "React Native Linking.openURL is unavailable to launch external wallet."
    );
  }
  await rn.Linking.openURL(url);
}

/**
 * Builds the official MetaMask Mobile universal deep link for a WalletConnect v2 URI.
 */
export function buildMetaMaskWalletConnectDeepLink(wcUri: string): string {
  return `https://metamask.app.link/wc?uri=${encodeURIComponent(wcUri)}`;
}

async function createOrReuseUniversalProvider(
  projectId: string
): Promise<UniversalProviderLike | null> {
  if (customUniversalProviderFactory !== undefined) {
    if (customUniversalProviderFactory === null) {
      return null;
    }
    const created = await customUniversalProviderFactory({
      projectId,
      metadata: DEHEALTH_WALLETCONNECT_METADATA
    });
    activeUniversalProvider = created;
    activeUniversalProviderProjectId = projectId;
    return created;
  }

  if (
    activeUniversalProvider &&
    activeUniversalProviderProjectId === projectId
  ) {
    return activeUniversalProvider;
  }

  if (isReactNativeRuntime()) {
    try {
      await import("@walletconnect/react-native-compat");
    } catch {
      // Non-fatal if shims already installed via polyfills
    }
  }

  try {
    const mod = (await import("@walletconnect/universal-provider")) as {
      readonly default?: {
        readonly init?: (
          opts: UniversalProviderInitOptions
        ) => Promise<UniversalProviderLike>;
      };
      readonly UniversalProvider?: {
        readonly init?: (
          opts: UniversalProviderInitOptions
        ) => Promise<UniversalProviderLike>;
      };
    };
    const initFn = mod.UniversalProvider?.init ?? mod.default?.init;
    if (typeof initFn !== "function") {
      return null;
    }
    const instance = await initFn({
      projectId,
      metadata: DEHEALTH_WALLETCONNECT_METADATA
    });
    activeUniversalProvider = instance;
    activeUniversalProviderProjectId = projectId;
    return instance;
  } catch {
    return null;
  }
}

function wrapUniversalProviderAsEip1193(
  wcProvider: UniversalProviderLike
): Eip1193Provider {
  return {
    async request(args: Eip1193RequestArgs): Promise<unknown> {
      return wcProvider.request({
        method: args.method,
        ...(args.params !== undefined
          ? { params: [...args.params] }
          : {})
      });
    }
  };
}

function extractCaip10EvmAddress(
  wcProvider: UniversalProviderLike
): string | null {
  const eip155Accounts = wcProvider.session?.namespaces?.eip155?.accounts;
  if (!Array.isArray(eip155Accounts) || eip155Accounts.length === 0) {
    return null;
  }
  const first = eip155Accounts[0];
  if (typeof first !== "string" || first.trim().length === 0) {
    return null;
  }
  const parts = first.trim().split(":");
  const candidate = parts[parts.length - 1] ?? "";
  return candidate.length > 0 ? candidate : null;
}

async function resolveUniversalProviderAddress(
  wcProvider: UniversalProviderLike
): Promise<string | null> {
  const sessionAccount = extractCaip10EvmAddress(wcProvider);
  if (sessionAccount) {
    return sessionAccount;
  }
  try {
    const accountsRes = await wcProvider.request({ method: "eth_accounts" });
    if (
      Array.isArray(accountsRes) &&
      typeof accountsRes[0] === "string" &&
      accountsRes[0].trim().length > 0
    ) {
      return accountsRes[0].trim();
    }
  } catch {
    // Fall through to enable()
  }
  if (typeof wcProvider.enable === "function") {
    try {
      const enabled = await wcProvider.enable();
      if (
        Array.isArray(enabled) &&
        typeof enabled[0] === "string" &&
        enabled[0].trim().length > 0
      ) {
        return enabled[0].trim();
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function connectViaNativeUniversalProvider(
  projectId: string,
  buildLaunchUri: (wcUri: string) => string,
  providerName: "MetaMask" | "WalletConnect"
): Promise<ExternalWalletConnection> {
  const wcProvider = await createOrReuseUniversalProvider(projectId);
  if (!wcProvider) {
    throw new AuthError(
      providerName === "WalletConnect"
        ? "WalletConnect v2 provider is unavailable in this environment."
        : "MetaMask provider is unavailable. Install MetaMask or open the app inside the MetaMask browser."
    );
  }

  let deepLinkError: Error | null = null;
  let rejectLinkPromise!: (err: Error) => void;
  const linkFailurePromise = new Promise<never>((_resolve, reject) => {
    rejectLinkPromise = reject;
  });

  const handleDisplayUri = (rawUri: string): void => {
    if (typeof rawUri !== "string" || rawUri.trim().length === 0) {
      return;
    }
    const targetUri = buildLaunchUri(rawUri.trim());
    void openDeepLinkUrl(targetUri).catch((err: unknown) => {
      const authErr = new AuthError(
        toAuthErrorMessage(
          err,
          `Unable to launch ${providerName} via deep link.`
        )
      );
      deepLinkError = authErr;
      try {
        wcProvider.abortPairingAttempt?.();
      } catch {
        // Non-fatal
      }
      rejectLinkPromise(authErr);
    });
  };

  wcProvider.on("display_uri", handleDisplayUri);
  try {
    const connectPromise = wcProvider.connect({
      optionalNamespaces: {
        eip155: {
          methods: [
            "eth_sendTransaction",
            "personal_sign",
            "eth_signTypedData_v4"
          ],
          chains: [ARBITRUM_SEPOLIA_CAIP2],
          events: ["chainChanged", "accountsChanged"]
        }
      }
    });

    await Promise.race([connectPromise, linkFailurePromise]);
    if (deepLinkError) {
      throw deepLinkError;
    }
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw new AuthError(
      toAuthErrorMessage(err, `${providerName} connection failed.`)
    );
  } finally {
    if (typeof wcProvider.off === "function") {
      wcProvider.off("display_uri", handleDisplayUri);
    } else if (typeof wcProvider.removeListener === "function") {
      wcProvider.removeListener("display_uri", handleDisplayUri);
    }
  }

  const rawAddress = await resolveUniversalProviderAddress(wcProvider);
  if (!rawAddress) {
    throw new AuthError(
      `${providerName} did not return a valid EVM wallet address.`
    );
  }

  return {
    address: rawAddress,
    provider: wrapUniversalProviderAsEip1193(wcProvider)
  };
}

/**
 * Connects an external MetaMask / injected EIP-1193 wallet and persists a
 * strictly non-biometric `metamask` session backed by an EIP-1193 signer.
 * On native mobile runtimes where `window.ethereum` is absent, falls back to
 * launching MetaMask Mobile via WalletConnect v2 deep-linking when configured.
 */
export async function signInWithMetaMask(
  options?: MetaMaskSignInOptions
): Promise<AuthSignInResult> {
  const adapter =
    options?.adapter !== undefined ? options.adapter : customMetaMaskAdapter;
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
    if (provider) {
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
    } else if (customMetaMaskAdapter === null) {
      throw new AuthError(
        "MetaMask provider is unavailable. Install MetaMask or open the app inside the MetaMask browser."
      );
    } else {
      const projectId =
        options?.projectId?.trim() || getWalletConnectProjectId();
      if (!projectId) {
        throw new AuthError(
          "MetaMask provider is unavailable. Install MetaMask, open the app inside the MetaMask browser, or configure EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID for MetaMask Mobile."
        );
      }
      connection = await connectViaNativeUniversalProvider(
        projectId,
        buildMetaMaskWalletConnectDeepLink,
        "MetaMask"
      );
    }
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

  const adapter =
    options?.adapter !== undefined
      ? options.adapter
      : customWalletConnectAdapter;
  if (adapter === null) {
    throw new AuthError(
      "WalletConnect v2 provider is unavailable in this environment."
    );
  }

  let connection: ExternalWalletConnection;
  if (adapter !== undefined) {
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
  } else {
    connection = await connectViaNativeUniversalProvider(
      projectId,
      (uri) => uri,
      "WalletConnect"
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
 * Silently attempts to restore a live external EIP-1193 `Signer` on cold-start
 * boot without opening interactive wallet prompts or deep links.
 * Returns `null` if no matching live account session is available so callers
 * can cleanly drop stale external sessions back to the login screen.
 */
export async function restoreExternalWalletSignerOnBoot(
  session: AuthSessionMetadata,
  options?: {
    readonly metaMaskAdapter?: MetaMaskAdapter | null;
    readonly walletConnectAdapter?: WalletConnectAdapter | null;
    readonly projectId?: string;
    readonly timeoutMs?: number;
  }
): Promise<Signer | null> {
  if (
    session.authMethod !== "metamask" &&
    session.authMethod !== "walletconnect"
  ) {
    return null;
  }

  const expectedAddress = session.walletAddress;
  const expectedLower = expectedAddress.toLowerCase();

  if (session.authMethod === "metamask") {
    const mmAdapter =
      options?.metaMaskAdapter !== undefined
        ? options.metaMaskAdapter
        : customMetaMaskAdapter;
    if (mmAdapter === null) {
      return null;
    }
    if (mmAdapter && typeof mmAdapter.restoreSession === "function") {
      try {
        const restored = await mmAdapter.restoreSession(expectedAddress);
        if (
          restored?.provider &&
          restored.address.trim().toLowerCase() === expectedLower
        ) {
          return createEip1193Signer(expectedAddress, restored.provider);
        }
      } catch {
        return null;
      }
      return null;
    }

    const injected = resolveGlobalEthereumProvider();
    if (injected) {
      try {
        const silentAccounts = await injected.request({
          method: "eth_accounts"
        });
        if (
          Array.isArray(silentAccounts) &&
          silentAccounts.some(
            (addr) =>
              typeof addr === "string" &&
              addr.trim().toLowerCase() === expectedLower
          )
        ) {
          return createEip1193Signer(expectedAddress, injected);
        }
      } catch {
        // Fall through to check persisted WalletConnect session
      }
    }
  }

  if (session.authMethod === "walletconnect") {
    const wcAdapter =
      options?.walletConnectAdapter !== undefined
        ? options.walletConnectAdapter
        : customWalletConnectAdapter;
    if (wcAdapter === null) {
      return null;
    }
    if (wcAdapter && typeof wcAdapter.restoreSession === "function") {
      const projectId = options?.projectId?.trim() || getWalletConnectProjectId();
      if (!projectId) {
        return null;
      }
      try {
        const restored = await wcAdapter.restoreSession(
          projectId,
          expectedAddress
        );
        if (
          restored?.provider &&
          restored.address.trim().toLowerCase() === expectedLower
        ) {
          return createEip1193Signer(expectedAddress, restored.provider);
        }
      } catch {
        return null;
      }
      return null;
    }
  }

  const projectId = options?.projectId?.trim() || getWalletConnectProjectId();
  if (!projectId) {
    return null;
  }

  const timeoutMs = options?.timeoutMs ?? BOOT_RESTORE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wcProvider = await Promise.race<UniversalProviderLike | null>([
      createOrReuseUniversalProvider(projectId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
    if (!wcProvider || !wcProvider.session) {
      return null;
    }
    const restoredAddr = extractCaip10EvmAddress(wcProvider);
    if (!restoredAddr || restoredAddr.toLowerCase() !== expectedLower) {
      return null;
    }
    return createEip1193Signer(
      expectedAddress,
      wrapUniversalProviderAsEip1193(wcProvider)
    );
  } catch {
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

  if (activeUniversalProvider) {
    const providerToDisconnect = activeUniversalProvider;
    activeUniversalProvider = null;
    activeUniversalProviderProjectId = null;
    if (typeof providerToDisconnect.disconnect === "function") {
      try {
        await providerToDisconnect.disconnect();
      } catch {
        // Non-fatal if WalletConnect relay disconnect fails
      }
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

  pendingGoogleOAuthAttempt = false;
  activeGoogleSignInCalls = 0;
  inFlightOAuthExchanges.clear();
  completedOAuthExchanges.clear();
  await clearPersistedAuthSession(options?.storage);
}
