import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Address,
  AuthSessionMetadata,
  DEFAULT_BASELINE_BIOMETRICS
} from "@dehealth/shared";
import { SupabaseClient } from "@supabase/supabase-js";
import { Wallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_SESSION_STORAGE_KEY,
  AuthError,
  AuthSessionStorage,
  clearPersistedAuthSession,
  continueWithWallet,
  formatShortAddress,
  getAuthSessionStorage,
  getPersistedAuthSession,
  initializeAuthSessionStorage,
  purgeAuthSessionStorageKey,
  resetAuthSessionStorage,
  savePersistedAuthSession,
  setAuthSessionStorage,
  signInWithGoogle,
  signOutSession
} from "../services/authService";
import {
  DataSovereigntyViolationError,
  setSupabaseClient
} from "../services/supabaseService";
import { AdaptiveStorage, ADAPTIVE_STORAGE_KEYS } from "../storage/adaptiveStorage";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../storage/encryptedStorageAdapter";
import {
  DEFAULT_GOVERNANCE_CONFIG,
  GOVERNANCE_STORAGE_KEY,
  GovernanceStorage
} from "../storage/governanceStorage";
import {
  InMemoryKeyStore,
  provisionVaultSecret,
  VAULT_SECRET_STORAGE_KEY,
  VaultKeyUnavailableError
} from "../storage/vaultKeyProvider";
import {
  getOrCreatePersistentWallet,
  getStoredWallet,
  resetWalletStorageForTesting,
  WALLET_PRIVATE_KEY_STORAGE_KEY,
  WalletStorageError
} from "../storage/walletStorage";

class MemoryBackend implements KeyValueStorageBackend {
  readonly items = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.items.delete(key);
  }
}

describe("Auth Service, Wallet Identity & Encrypted Session Storage", () => {
  const testSecret = "0x" + "cc".repeat(32);

  beforeEach(() => {
    vi.restoreAllMocks();
    setSupabaseClient(undefined);
    resetAuthSessionStorage();
    resetWalletStorageForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setSupabaseClient(undefined);
    resetAuthSessionStorage();
    resetWalletStorageForTesting();
  });

  describe("formatShortAddress", () => {
    it("formats addresses >= 10 chars with ellipsis and trims shorter strings", () => {
      expect(formatShortAddress("0x1234567890abcdef1234567890abcdef1234abcd")).toBe(
        "0x1234\u2026abcd"
      );
      expect(formatShortAddress("  0x12345678  ")).toBe("0x1234\u20265678");
      expect(formatShortAddress("  0x123  ")).toBe("0x123");
      expect(formatShortAddress("")).toBe("");
    });
  });

  describe("AuthSessionStorage persistence, Zod validation & zero-biometric guard", () => {
    it("throws VaultKeyUnavailableError when accessed uninitialized or constructed without secret", () => {
      expect(() => getAuthSessionStorage()).toThrow(VaultKeyUnavailableError);
      expect(
        () => new AuthSessionStorage(undefined as unknown as string)
      ).toThrow(VaultKeyUnavailableError);
    });

    it("encrypts, persists, reloads, clears, and purges AuthSessionMetadata cleanly", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);
      expect(getAuthSessionStorage()).toBe(storage);
      expect(await getPersistedAuthSession()).toBeNull();

      const wallet = await getOrCreatePersistentWallet(keyStore);
      const session: AuthSessionMetadata = {
        authMethod: "google",
        accountId: "user_google_123",
        displayLabel: "runner@dehealth.local",
        walletAddress: wallet.address as Address,
        signedInAtMs: 1_763_600_000_000
      };

      const saved = await savePersistedAuthSession(session);
      expect(saved).toEqual(session);

      // Verify raw persisted payload is encrypted (never plaintext)
      const rawEnvelope = backend.items.get(AUTH_SESSION_STORAGE_KEY);
      expect(rawEnvelope).toBeDefined();
      expect(rawEnvelope).not.toContain("runner@dehealth.local");

      const loaded = await getPersistedAuthSession();
      expect(loaded).toEqual(session);

      await clearPersistedAuthSession();
      expect(await getPersistedAuthSession()).toBeNull();
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);

      // Purge works without requiring vault secret
      await savePersistedAuthSession(session);
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(true);
      await purgeAuthSessionStorageKey(backend);
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
      expect(() => getAuthSessionStorage()).toThrow(VaultKeyUnavailableError);
    });

    it("enforces assertZeroRawBiometrics and Zod schema before encrypting", async () => {
      const backend = new MemoryBackend();
      const storage = new AuthSessionStorage(testSecret, backend);
      setAuthSessionStorage(storage);

      const wallet = Wallet.createRandom();
      const taintedSession = {
        authMethod: "wallet",
        accountId: `wallet:${wallet.address.toLowerCase()}`,
        displayLabel: formatShortAddress(wallet.address),
        walletAddress: wallet.address as Address,
        signedInAtMs: 1_763_600_000_000,
        weightKg: 74.2
      } as unknown as AuthSessionMetadata;

      await expect(savePersistedAuthSession(taintedSession, storage)).rejects.toThrow(
        DataSovereigntyViolationError
      );
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);

      const invalidSchemaSession: AuthSessionMetadata = {
        authMethod: "wallet",
        accountId: "wallet:bad",
        displayLabel: "Bad Wallet",
        walletAddress: "not-an-evm-address" as Address,
        signedInAtMs: 1_763_600_000_000
      };

      await expect(
        savePersistedAuthSession(invalidSchemaSession, storage)
      ).rejects.toThrow();
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    });

    it("returns null on schema-invalid stored payload while rethrowing MAC tampering errors", async () => {
      const backend = new MemoryBackend();
      const adapter = new EncryptedStorageAdapter(testSecret, backend);
      const storage = new AuthSessionStorage(adapter);

      await adapter.setEncryptedItem(AUTH_SESSION_STORAGE_KEY, {
        authMethod: "google",
        accountId: "",
        displayLabel: "invalid"
      });
      expect(await getPersistedAuthSession(storage)).toBeNull();

      const validWallet = Wallet.createRandom();
      await storage.savePersistedAuthSession({
        authMethod: "wallet",
        accountId: `wallet:${validWallet.address.toLowerCase()}`,
        displayLabel: formatShortAddress(validWallet.address),
        walletAddress: validWallet.address as Address,
        signedInAtMs: 1_763_600_000_000
      });

      const raw = backend.items.get(AUTH_SESSION_STORAGE_KEY)!;
      const parsed = JSON.parse(raw) as { ciphertext: string };
      parsed.ciphertext =
        parsed.ciphertext.slice(0, -2) +
        (parsed.ciphertext.endsWith("aa") ? "bb" : "aa");
      backend.items.set(AUTH_SESSION_STORAGE_KEY, JSON.stringify(parsed));

      await expect(getPersistedAuthSession(storage)).rejects.toThrow(/tampering/i);
    });

    it("purges AUTH_SESSION_STORAGE_KEY via AsyncStorage when backend is omitted", async () => {
      const removeSpy = vi
        .spyOn(AsyncStorage, "removeItem")
        .mockResolvedValueOnce(undefined);
      await purgeAuthSessionStorageKey();
      expect(removeSpy).toHaveBeenCalledWith(AUTH_SESSION_STORAGE_KEY);
    });

    it("deduplicates concurrent initializeAuthSessionStorage calls and recovers from failed initialization", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();

      const [s1, s2] = await Promise.all([
        initializeAuthSessionStorage(keyStore, backend),
        initializeAuthSessionStorage(keyStore, backend)
      ]);
      expect(s1).toBe(s2);
      expect(await initializeAuthSessionStorage(keyStore, backend)).toBe(s1);

      resetAuthSessionStorage();
      const failingKeyStore = {
        getItem: async () => {
          throw new Error("Keystore temporarily locked");
        },
        setItem: async () => undefined
      };
      await expect(
        initializeAuthSessionStorage(failingKeyStore, backend)
      ).rejects.toThrow("Keystore temporarily locked");

      const recovered = await initializeAuthSessionStorage(keyStore, backend);
      expect(recovered).toBeInstanceOf(AuthSessionStorage);
    });
  });

  describe("signInWithGoogle", () => {
    it("completes live Supabase OAuth, auto-provisions embedded wallet, and persists strictly non-biometric session", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const signInWithOAuthMock = vi.fn().mockResolvedValue({
        data: {
          provider: "google",
          url: "https://accounts.google.com/o/oauth2/v2/auth?mock=1"
        },
        error: null
      });
      const getUserMock = vi.fn().mockResolvedValue({
        data: {
          user: {
            id: "supa-user-uuid-99",
            email: "athlete@dehealth.xyz",
            user_metadata: { full_name: "DeHealth Athlete" }
          }
        },
        error: null
      });

      setSupabaseClient({
        auth: {
          signInWithOAuth: signInWithOAuthMock,
          getUser: getUserMock
        }
      } as unknown as SupabaseClient);

      const result = await signInWithGoogle({
        keyStore,
        storage,
        redirectTo: "dehealth://auth-callback",
        nowMs: 1_763_600_123_456
      });

      expect(signInWithOAuthMock).toHaveBeenCalledWith({
        provider: "google",
        options: { redirectTo: "dehealth://auth-callback" }
      });
      expect(result.mode).toBe("live");
      expect(result.oauthUrl).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth?mock=1"
      );
      expect(result.wallet).toBeInstanceOf(Wallet);
      expect(result.session).toEqual({
        authMethod: "google",
        accountId: "supa-user-uuid-99",
        displayLabel: "athlete@dehealth.xyz",
        walletAddress: result.wallet.address as Address,
        signedInAtMs: 1_763_600_123_456
      });

      // Embedded wallet persisted and persisted session matches
      expect((await getStoredWallet(keyStore))?.address).toBe(result.wallet.address);
      expect(await getPersistedAuthSession(storage)).toEqual(result.session);
    });

    it("falls back safely to user_metadata.full_name or deterministic wallet-based Google label when getUser is partial or throws", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      // Case 1: user_metadata.full_name without email
      setSupabaseClient({
        auth: {
          signInWithOAuth: vi.fn().mockResolvedValue({
            data: { provider: "google", url: "https://oauth.example/1" },
            error: null
          }),
          getUser: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: "supa-meta-user",
                user_metadata: { full_name: "  Alex Pulse  " }
              }
            },
            error: null
          })
        }
      } as unknown as SupabaseClient);

      const res1 = await signInWithGoogle({ keyStore, storage, nowMs: 1000 });
      expect(res1.session.displayLabel).toBe("Alex Pulse");
      expect(res1.session.accountId).toBe("supa-meta-user");

      // Case 2: getUser throws (redirect not completed yet) -> non-fatal deterministic fallback
      setSupabaseClient({
        auth: {
          signInWithOAuth: vi.fn().mockResolvedValue({
            data: { provider: "google", url: "https://oauth.example/2" },
            error: null
          }),
          getUser: vi.fn().mockRejectedValue(new Error("Auth session missing"))
        }
      } as unknown as SupabaseClient);

      const res2 = await signInWithGoogle({ keyStore, storage, nowMs: 2000 });
      expect(res2.wallet.address).toBe(res1.wallet.address);
      expect(res2.session.accountId).toBe(
        `google_${res2.wallet.address.slice(2, 10).toLowerCase()}`
      );
      expect(res2.session.displayLabel).toBe(
        `Google (${formatShortAddress(res2.wallet.address)})`
      );
    });

    it("throws AuthError when live Supabase OAuth returns an error without provisioning a wallet", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      setSupabaseClient({
        auth: {
          signInWithOAuth: vi.fn().mockResolvedValue({
            data: { provider: "google", url: null },
            error: { message: "OAuth provider disabled" }
          })
        }
      } as unknown as SupabaseClient);

      await expect(signInWithGoogle({ keyStore, storage })).rejects.toThrow(
        AuthError
      );
      await expect(signInWithGoogle({ keyStore, storage })).rejects.toThrow(
        "OAuth provider disabled"
      );
      expect(await getStoredWallet(keyStore)).toBeNull();
      expect(await getPersistedAuthSession(storage)).toBeNull();

      // Rejected OAuth call also surfaces AuthError
      setSupabaseClient({
        auth: {
          signInWithOAuth: vi
            .fn()
            .mockRejectedValue(new Error("OAuth transport failure"))
        }
      } as unknown as SupabaseClient);
      await expect(signInWithGoogle({ keyStore, storage })).rejects.toThrow(
        AuthError
      );
    });

    it("uses deterministic local Google fallback when Supabase is unconfigured", async () => {
      setSupabaseClient(null);
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const first = await signInWithGoogle({
        keyStore,
        storage,
        localGoogleHint: "  Local Google Demo  ",
        nowMs: 5000
      });

      expect(first.mode).toBe("local-fallback");
      expect(first.oauthUrl).toBeNull();
      expect(first.session).toEqual({
        authMethod: "google",
        accountId: `google_local_${first.wallet.address.slice(2, 10).toLowerCase()}`,
        displayLabel: "Local Google Demo",
        walletAddress: first.wallet.address as Address,
        signedInAtMs: 5000
      });

      // Default displayLabel when localGoogleHint omitted (and uses initialized singleton when storage omitted)
      const second = await signInWithGoogle({
        keyStore,
        nowMs: 6000
      });
      expect(second.wallet.address).toBe(first.wallet.address);
      expect(second.session.accountId).toBe(first.session.accountId);
      expect(second.session.displayLabel).toBe(
        `Google (${formatShortAddress(second.wallet.address)})`
      );
      expect(await getPersistedAuthSession()).toEqual(second.session);
    });
  });

  describe("continueWithWallet", () => {
    it("creates or reuses persistent embedded wallet and persists wallet session metadata", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const first = await continueWithWallet({
        keyStore,
        storage,
        nowMs: 10_000
      });
      expect(first.mode).toBe("local-fallback");
      expect(first.session).toEqual({
        authMethod: "wallet",
        accountId: `wallet:${first.wallet.address.toLowerCase()}`,
        displayLabel: formatShortAddress(first.wallet.address),
        walletAddress: first.wallet.address as Address,
        signedInAtMs: 10_000
      });

      // Second call reuses the exact same embedded wallet
      const second = await continueWithWallet({
        keyStore,
        storage,
        nowMs: 20_000
      });
      expect(second.wallet.address).toBe(first.wallet.address);
      expect(await getPersistedAuthSession(storage)).toEqual(second.session);
    });

    it("imports an explicit private key (with or without 0x) and rejects invalid keys without overwriting", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const target = Wallet.createRandom();
      const imported = await continueWithWallet({
        privateKey: `  ${target.privateKey.slice(2)}  `,
        keyStore,
        storage,
        nowMs: 30_000
      });

      expect(imported.wallet.address).toBe(target.address);
      expect(imported.wallet.privateKey).toBe(target.privateKey);
      expect(imported.session).toEqual({
        authMethod: "wallet",
        accountId: `wallet:${target.address.toLowerCase()}`,
        displayLabel: formatShortAddress(target.address),
        walletAddress: target.address as Address,
        signedInAtMs: 30_000
      });

      // Invalid private key fails closed without disturbing stored wallet or session
      await expect(
        continueWithWallet({
          privateKey: "0xinvalid_key",
          keyStore,
          storage
        })
      ).rejects.toThrow(WalletStorageError);

      expect((await getStoredWallet(keyStore))?.address).toBe(target.address);
      expect((await getPersistedAuthSession(storage))?.walletAddress).toBe(
        target.address
      );
    });
  });

  describe("signOutSession data preservation", () => {
    it("clears ONLY auth session while preserving wallet key, vault secret, biometrics, and governance config", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const secret = await provisionVaultSecret(keyStore);
      const storage = new AuthSessionStorage(secret, backend);
      setAuthSessionStorage(storage);

      const adaptive = new AdaptiveStorage(secret, backend);
      await adaptive.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);

      const governance = new GovernanceStorage(secret, backend);
      await governance.saveGovernanceConfig(DEFAULT_GOVERNANCE_CONFIG);

      const signOutMock = vi.fn().mockRejectedValue(new Error("Offline signout"));
      setSupabaseClient({
        auth: { signOut: signOutMock }
      } as unknown as SupabaseClient);

      const signedIn = await continueWithWallet({
        keyStore,
        storage,
        nowMs: 40_000
      });
      expect(await getPersistedAuthSession(storage)).toEqual(signedIn.session);

      await signOutSession({ storage });
      expect(signOutMock).toHaveBeenCalledTimes(1);

      // Session is cleared
      expect(await getPersistedAuthSession(storage)).toBeNull();
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);

      // Wallet, vault secret, biometrics, and governance config are completely preserved
      expect(await keyStore.getItem(VAULT_SECRET_STORAGE_KEY)).toBe(secret);
      expect(await keyStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        signedIn.wallet.privateKey
      );
      expect((await getStoredWallet(keyStore))?.address).toBe(
        signedIn.wallet.address
      );
      expect(backend.items.has(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS)).toBe(true);
      expect(await adaptive.getUserBiometrics()).toEqual(DEFAULT_BASELINE_BIOMETRICS);
      expect(backend.items.has(GOVERNANCE_STORAGE_KEY)).toBe(true);
      expect(await governance.getGovernanceConfig()).toEqual(
        DEFAULT_GOVERNANCE_CONFIG
      );
    });
  });
});
