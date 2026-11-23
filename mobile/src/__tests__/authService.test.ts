import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Address,
  AUTH_METHODS,
  AuthSessionMetadata,
  Bytes32,
  createDeHealthDomain,
  DEFAULT_BASELINE_BIOMETRICS,
  WORKOUT_PROOF_EIP712_TYPES,
  WorkoutProof
} from "@dehealth/shared";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  BaseWallet,
  JsonRpcProvider,
  TypedDataEncoder,
  TypedDataField,
  Wallet
} from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_SESSION_STORAGE_KEY,
  AuthError,
  AuthSessionStorage,
  clearPersistedAuthSession,
  completeOAuthRedirectCallback,
  createEip1193Signer,
  Eip1193Provider,
  formatShortAddress,
  getAuthSessionStorage,
  getPersistedAuthSession,
  getWalletConnectProjectId,
  handleIncomingOAuthRedirectUrl,
  hasPendingGoogleOAuthAttempt,
  initializeAuthSessionStorage,
  purgeAuthSessionStorageKey,
  resetAuthSessionStorage,
  resetDeepLinkOpenerForTesting,
  resetMetaMaskAdapterForTesting,
  resetOAuthBrowserAdapterForTesting,
  resetUniversalProviderFactoryForTesting,
  resetWalletConnectAdapterForTesting,
  restoreExternalWalletSignerOnBoot,
  savePersistedAuthSession,
  setAuthSessionStorage,
  setDeepLinkOpenerForTesting,
  setMetaMaskAdapterForTesting,
  setOAuthBrowserAdapterForTesting,
  setPendingGoogleOAuthAttemptForTesting,
  setUniversalProviderFactoryForTesting,
  setWalletConnectAdapterForTesting,
  signInWithGoogle,
  signInWithMetaMask,
  signInWithWalletConnect,
  signOutSession,
  startLocalSession,
  UniversalProviderLike
} from "../services/authService";
import {
  signWorkoutProof,
  verifyWorkoutProofSignature
} from "../services/cryptoService";
import {
  DataSovereigntyViolationError,
  setSupabaseClient
} from "../services/supabaseService";
import {
  ADAPTIVE_STORAGE_KEYS,
  AdaptiveStorage
} from "../storage/adaptiveStorage";
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
  WALLET_PRIVATE_KEY_STORAGE_KEY
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

interface GlobalWithWalletMocks {
  ethereum?: unknown;
  window?: {
    ethereum?: unknown;
  };
}

function createWalletBackedEip1193Provider(
  backingWallet: BaseWallet,
  capturedPayloads: string[]
): Eip1193Provider {
  return {
    isMetaMask: true,
    async request({ method, params }): Promise<unknown> {
      if (method === "eth_requestAccounts") {
        return [backingWallet.address];
      }
      if (method === "personal_sign") {
        const hexMessage = params?.[0];
        if (typeof hexMessage !== "string") {
          throw new Error("Missing message hex");
        }
        return backingWallet.signMessage(hexMessage);
      }
      if (method === "eth_signTypedData_v4") {
        const signerAddr = params?.[0];
        const rawJson = params?.[1];
        if (
          typeof signerAddr !== "string" ||
          signerAddr.toLowerCase() !== backingWallet.address.toLowerCase() ||
          typeof rawJson !== "string"
        ) {
          throw new Error("Invalid eth_signTypedData_v4 parameters");
        }
        capturedPayloads.push(rawJson);
        const parsed = JSON.parse(rawJson) as {
          readonly domain: Record<string, unknown>;
          readonly types: Record<string, Array<TypedDataField>>;
          readonly message: Record<string, unknown>;
        };
        const typesWithoutDomain: Record<string, Array<TypedDataField>> = {};
        for (const [key, fields] of Object.entries(parsed.types)) {
          if (key !== "EIP712Domain") {
            typesWithoutDomain[key] = fields;
          }
        }
        return backingWallet.signTypedData(
          parsed.domain,
          typesWithoutDomain,
          parsed.message
        );
      }
      throw new Error(`Unsupported method: ${method}`);
    }
  };
}

describe("Auth Service, 3-Way Sign-In, EIP-1193 Signer & Encrypted Session Storage", () => {
  const testSecret = "0x" + "cc".repeat(32);
  const sampleContractAddress =
    "0x1111111111111111111111111111111111111111" as Address;
  const sampleTelemetryHash = ("0x" + "ab".repeat(32)) as Bytes32;

  let originalWcProjectId: string | undefined;
  let hadOwnEthereum = false;
  let originalEthereum: unknown;
  let hadOwnWindow = false;
  let originalWindow: unknown;

  beforeEach(() => {
    vi.restoreAllMocks();
    setSupabaseClient(undefined);
    resetAuthSessionStorage();
    resetWalletStorageForTesting();
    resetMetaMaskAdapterForTesting();
    resetWalletConnectAdapterForTesting();
    resetOAuthBrowserAdapterForTesting();
    resetUniversalProviderFactoryForTesting();
    resetDeepLinkOpenerForTesting();

    originalWcProjectId = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
    delete process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;

    const g = globalThis as GlobalWithWalletMocks;
    hadOwnEthereum = Object.prototype.hasOwnProperty.call(g, "ethereum");
    originalEthereum = g.ethereum;
    hadOwnWindow = Object.prototype.hasOwnProperty.call(g, "window");
    originalWindow = g.window;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setSupabaseClient(undefined);
    resetAuthSessionStorage();
    resetWalletStorageForTesting();
    resetMetaMaskAdapterForTesting();
    resetWalletConnectAdapterForTesting();
    resetOAuthBrowserAdapterForTesting();
    resetUniversalProviderFactoryForTesting();
    resetDeepLinkOpenerForTesting();

    if (originalWcProjectId === undefined) {
      delete process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
    } else {
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = originalWcProjectId;
    }

    const g = globalThis as GlobalWithWalletMocks;
    if (hadOwnEthereum) {
      g.ethereum = originalEthereum;
    } else {
      delete g.ethereum;
    }
    if (hadOwnWindow) {
      g.window = originalWindow as { ethereum?: unknown } | undefined;
    } else {
      delete g.window;
    }
  });

  describe("formatShortAddress & getWalletConnectProjectId", () => {
    it("formats addresses >= 10 chars with ellipsis and trims shorter strings", () => {
      expect(
        formatShortAddress("0x1234567890abcdef1234567890abcdef1234abcd")
      ).toBe("0x1234\u2026abcd");
      expect(formatShortAddress("  0x12345678  ")).toBe("0x1234\u20265678");
      expect(formatShortAddress("  0x123  ")).toBe("0x123");
      expect(formatShortAddress("")).toBe("");
    });

    it("resolves EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID cleanly and returns null when blank", () => {
      expect(getWalletConnectProjectId()).toBeNull();

      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "   ";
      expect(getWalletConnectProjectId()).toBeNull();

      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "  wc-proj-123  ";
      expect(getWalletConnectProjectId()).toBe("wc-proj-123");
    });
  });

  describe("AuthSessionStorage persistence, Zod validation & zero-biometric guard", () => {
    it("throws VaultKeyUnavailableError when accessed uninitialized or constructed without secret", () => {
      expect(() => getAuthSessionStorage()).toThrow(VaultKeyUnavailableError);
      expect(
        () => new AuthSessionStorage(undefined as unknown as string)
      ).toThrow(VaultKeyUnavailableError);
    });

    it("encrypts, persists, reloads, clears, and purges AuthSessionMetadata for all 4 AUTH_METHODS", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);
      expect(getAuthSessionStorage()).toBe(storage);
      expect(await getPersistedAuthSession()).toBeNull();

      const wallet = await getOrCreatePersistentWallet(keyStore);
      for (const method of AUTH_METHODS) {
        const session: AuthSessionMetadata = {
          authMethod: method,
          accountId: `${method}:user-123`,
          displayLabel: `${method} athlete`,
          walletAddress: wallet.address as Address,
          signedInAtMs: 1_763_600_000_000
        };
        const saved = await savePersistedAuthSession(session);
        expect(saved).toEqual(session);

        const rawEnvelope = backend.items.get(AUTH_SESSION_STORAGE_KEY);
        expect(rawEnvelope).toBeDefined();
        expect(rawEnvelope).not.toContain(`${method} athlete`);

        expect(await getPersistedAuthSession()).toEqual(session);
      }

      await clearPersistedAuthSession();
      expect(await getPersistedAuthSession()).toBeNull();
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);

      const finalSession: AuthSessionMetadata = {
        authMethod: "local",
        accountId: `local:${wallet.address.toLowerCase()}`,
        displayLabel: `Local Session (${formatShortAddress(wallet.address)})`,
        walletAddress: wallet.address as Address,
        signedInAtMs: 1_763_600_000_001
      };
      await savePersistedAuthSession(finalSession);
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
        authMethod: "local",
        accountId: `local:${wallet.address.toLowerCase()}`,
        displayLabel: formatShortAddress(wallet.address),
        walletAddress: wallet.address as Address,
        signedInAtMs: 1_763_600_000_000,
        weightKg: 74.2
      } as unknown as AuthSessionMetadata;

      await expect(
        savePersistedAuthSession(taintedSession, storage)
      ).rejects.toThrow(DataSovereigntyViolationError);
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);

      const invalidSchemaSession: AuthSessionMetadata = {
        authMethod: "local",
        accountId: "local:bad",
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
        authMethod: "local",
        accountId: `local:${validWallet.address.toLowerCase()}`,
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

  describe("startLocalSession", () => {
    it("creates/reuses embedded wallet, persists authMethod 'local', and provides working EIP-712 signer", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const first = await startLocalSession({
        keyStore,
        storage,
        nowMs: 10_000
      });

      expect(first.mode).toBe("local-fallback");
      expect(first.oauthUrl).toBeNull();
      expect(first.wallet).toBeInstanceOf(Wallet);
      expect(first.signer).toBe(first.wallet);
      expect(first.walletAddress).toBe(first.wallet!.address);
      expect(first.session).toEqual({
        authMethod: "local",
        accountId: `local:${first.walletAddress.toLowerCase()}`,
        displayLabel: `Local Session (${formatShortAddress(first.walletAddress)})`,
        walletAddress: first.walletAddress,
        signedInAtMs: 10_000
      });
      expect(await getPersistedAuthSession(storage)).toEqual(first.session);

      // Sign a real WorkoutProof with the returned local signer
      const proof: WorkoutProof = {
        user: first.walletAddress,
        telemetryHash: sampleTelemetryHash,
        streakCount: 3n,
        nonce: 0n,
        deadline: 1_900_000_000n
      };
      const signed = await signWorkoutProof(
        first.signer!,
        proof,
        sampleContractAddress
      );
      expect(verifyWorkoutProofSignature(signed, sampleContractAddress)).toBe(
        true
      );

      // Custom label trimmed & reusing identical wallet
      const second = await startLocalSession({
        keyStore,
        storage,
        localDisplayLabel: "  My Local Vault  ",
        nowMs: 20_000
      });
      expect(second.walletAddress).toBe(first.walletAddress);
      expect(second.session.displayLabel).toBe("My Local Vault");
    });
  });

  describe("signInWithGoogle (1A verified OAuth & explicit local delegation)", () => {
    it("completes verified live Supabase OAuth, invokes verifyOAuthCallback, provisions wallet, and persists 'google' session", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const callOrder: string[] = [];
      const signInWithOAuthMock = vi.fn().mockImplementation(async () => {
        callOrder.push("signInWithOAuth");
        return {
          data: {
            provider: "google",
            url: "https://accounts.google.com/o/oauth2/v2/auth?mock=1"
          },
          error: null
        };
      });
      const verifyOAuthCallbackMock = vi.fn().mockImplementation(async () => {
        callOrder.push("verifyOAuthCallback");
      });
      const getUserMock = vi.fn().mockImplementation(async () => {
        callOrder.push("getUser");
        return {
          data: {
            user: {
              id: "supa-user-uuid-99",
              email: "athlete@dehealth.xyz",
              user_metadata: { full_name: "DeHealth Athlete" }
            }
          },
          error: null
        };
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
        verifyOAuthCallback: verifyOAuthCallbackMock,
        nowMs: 1_763_600_123_456
      });

      expect(callOrder).toEqual([
        "signInWithOAuth",
        "verifyOAuthCallback",
        "getUser"
      ]);
      expect(signInWithOAuthMock).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo: "dehealth://auth-callback",
          skipBrowserRedirect: true
        }
      });
      expect(result.mode).toBe("live");
      expect(result.oauthUrl).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth?mock=1"
      );
      expect(result.wallet).toBeInstanceOf(Wallet);
      expect(result.signer).toBe(result.wallet);
      expect(result.walletAddress).toBe(result.wallet!.address);
      expect(result.session).toEqual({
        authMethod: "google",
        accountId: "supa-user-uuid-99",
        displayLabel: "athlete@dehealth.xyz",
        walletAddress: result.walletAddress,
        signedInAtMs: 1_763_600_123_456
      });

      expect((await getStoredWallet(keyStore))?.address).toBe(
        result.walletAddress
      );
      expect(await getPersistedAuthSession(storage)).toEqual(result.session);
    });

    it("falls back to user_metadata.full_name or Google short address ONLY when verified user.id is present", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      // Case 1: full_name without email
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
      expect(res1.session.authMethod).toBe("google");
      expect(res1.session.displayLabel).toBe("Alex Pulse");
      expect(res1.session.accountId).toBe("supa-meta-user");

      // Case 2: verified user.id without email or full_name
      setSupabaseClient({
        auth: {
          signInWithOAuth: vi.fn().mockResolvedValue({
            data: { provider: "google", url: "https://oauth.example/2" },
            error: null
          }),
          getUser: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: "supa-id-only",
                user_metadata: {}
              }
            },
            error: null
          })
        }
      } as unknown as SupabaseClient);

      const res2 = await signInWithGoogle({ keyStore, storage, nowMs: 2000 });
      expect(res2.walletAddress).toBe(res1.walletAddress);
      expect(res2.session.accountId).toBe("supa-id-only");
      expect(res2.session.displayLabel).toBe(
        `Google (${formatShortAddress(res2.walletAddress)})`
      );
    });

    it("fails closed when live Google OAuth is unverified (getUser missing/null/blank/error/throws) without creating wallet or session (1A)", async () => {
      const scenarios: Array<{
        readonly label: string;
        readonly auth: Record<string, unknown>;
        readonly verifyOAuthCallback?: () => Promise<void>;
        readonly expectedMessage?: RegExp;
      }> = [
        {
          label: "getUser method missing",
          auth: {
            signInWithOAuth: vi.fn().mockResolvedValue({
              data: { provider: "google", url: "https://oauth.example/a" },
              error: null
            })
          }
        },
        {
          label: "getUser returns null user",
          auth: {
            signInWithOAuth: vi.fn().mockResolvedValue({
              data: { provider: "google", url: "https://oauth.example/b" },
              error: null
            }),
            getUser: vi.fn().mockResolvedValue({
              data: { user: null },
              error: null
            })
          }
        },
        {
          label: "getUser returns blank user.id",
          auth: {
            signInWithOAuth: vi.fn().mockResolvedValue({
              data: { provider: "google", url: "https://oauth.example/c" },
              error: null
            }),
            getUser: vi.fn().mockResolvedValue({
              data: { user: { id: "   " } },
              error: null
            })
          }
        },
        {
          label: "getUser returns error object",
          auth: {
            signInWithOAuth: vi.fn().mockResolvedValue({
              data: { provider: "google", url: "https://oauth.example/d" },
              error: null
            }),
            getUser: vi.fn().mockResolvedValue({
              data: { user: { id: "supa-1" } },
              error: { message: "JWT expired" }
            })
          }
        },
        {
          label: "getUser throws",
          auth: {
            signInWithOAuth: vi.fn().mockResolvedValue({
              data: { provider: "google", url: "https://oauth.example/e" },
              error: null
            }),
            getUser: vi.fn().mockRejectedValue(new Error("Auth session missing"))
          }
        },
        {
          label: "verifyOAuthCallback throws",
          auth: {
            signInWithOAuth: vi.fn().mockResolvedValue({
              data: { provider: "google", url: "https://oauth.example/f" },
              error: null
            }),
            getUser: vi.fn()
          },
          verifyOAuthCallback: async () => {
            throw new Error("Browser popup dismissed");
          },
          expectedMessage: /Browser popup dismissed/
        }
      ];

      for (const scenario of scenarios) {
        const keyStore = new InMemoryKeyStore();
        const backend = new MemoryBackend();
        const storage = await initializeAuthSessionStorage(keyStore, backend);
        setSupabaseClient({ auth: scenario.auth } as unknown as SupabaseClient);

        const promise = signInWithGoogle({
          keyStore,
          storage,
          verifyOAuthCallback: scenario.verifyOAuthCallback
        });

        await expect(promise, scenario.label).rejects.toThrow(AuthError);
        if (scenario.expectedMessage) {
          await expect(
            signInWithGoogle({
              keyStore,
              storage,
              verifyOAuthCallback: scenario.verifyOAuthCallback
            })
          ).rejects.toThrow(scenario.expectedMessage);
        } else {
          await expect(
            signInWithGoogle({
              keyStore,
              storage,
              verifyOAuthCallback: scenario.verifyOAuthCallback
            })
          ).rejects.toThrow(/Google sign-in was not verified/);
        }
        expect(await getStoredWallet(keyStore), scenario.label).toBeNull();
        expect(await getPersistedAuthSession(storage), scenario.label).toBeNull();
        resetAuthSessionStorage();
      }
    });

    it("throws AuthError when live Supabase signInWithOAuth fails without provisioning a wallet", async () => {
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

    it("delegates to startLocalSession (authMethod 'local') when Supabase is unconfigured", async () => {
      setSupabaseClient(null);
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const first = await signInWithGoogle({
        keyStore,
        storage,
        localGoogleHint: "  Offline Sovereign Demo  ",
        nowMs: 5000
      });

      expect(first.mode).toBe("local-fallback");
      expect(first.oauthUrl).toBeNull();
      expect(first.wallet).toBeInstanceOf(Wallet);
      expect(first.signer).toBe(first.wallet);
      expect(first.session).toEqual({
        authMethod: "local",
        accountId: `local:${first.walletAddress.toLowerCase()}`,
        displayLabel: "Offline Sovereign Demo",
        walletAddress: first.walletAddress,
        signedInAtMs: 5000
      });

      const second = await signInWithGoogle({
        keyStore,
        nowMs: 6000
      });
      expect(second.walletAddress).toBe(first.walletAddress);
      expect(second.session.authMethod).toBe("local");
      expect(second.session.displayLabel).toBe(
        `Local Session (${formatShortAddress(second.walletAddress)})`
      );
      expect(await getPersistedAuthSession()).toEqual(second.session);
    });

    it("enforces PKCE code exchange, arms/clears pending OAuth attempt state, rejects unsolicited callbacks and implicit tokens (G1, S2)", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const exchangeCodeForSessionMock = vi.fn().mockResolvedValue({
        data: { session: { access_token: "pkce-at" } },
        error: null
      });
      const setSessionMock = vi.fn();
      const getUserMock = vi.fn().mockResolvedValue({
        data: {
          user: {
            id: "supa-pkce-user-1",
            email: "pkce@dehealth.xyz"
          }
        },
        error: null
      });

      setSupabaseClient({
        auth: {
          signInWithOAuth: vi.fn().mockResolvedValue({
            data: {
              provider: "google",
              url: "https://accounts.google.com/o/oauth2/v2/auth?pkce=1"
            },
            error: null
          }),
          exchangeCodeForSession: exchangeCodeForSessionMock,
          setSession: setSessionMock,
          getUser: getUserMock
        }
      } as unknown as SupabaseClient);

      // 1. Unsolicited dehealth://auth-callback URLs must reject before any OAuth flow starts
      expect(hasPendingGoogleOAuthAttempt()).toBe(false);
      await expect(
        handleIncomingOAuthRedirectUrl(
          "dehealth://auth-callback?code=unsolicited-code",
          { keyStore, storage }
        )
      ).rejects.toThrow(/Unsolicited Google OAuth callback rejected/);
      await expect(
        handleIncomingOAuthRedirectUrl(
          "dehealth://auth-callback#access_token=attacker_tok&refresh_token=r",
          { keyStore, storage }
        )
      ).rejects.toThrow(/Unsolicited Google OAuth callback rejected/);
      expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
      expect(setSessionMock).not.toHaveBeenCalled();

      let pendingDuringBrowserOpen = false;
      const openAuthSessionAsyncMock = vi.fn().mockImplementation(async () => {
        pendingDuringBrowserOpen = hasPendingGoogleOAuthAttempt();
        return {
          type: "success",
          url: "dehealth://auth-callback?code=pkce-code-777"
        };
      });
      setOAuthBrowserAdapterForTesting({
        openAuthSessionAsync: openAuthSessionAsyncMock
      });

      const res = await signInWithGoogle({
        keyStore,
        storage,
        nowMs: 70_000
      });

      expect(pendingDuringBrowserOpen).toBe(true);
      expect(hasPendingGoogleOAuthAttempt()).toBe(false);
      expect(openAuthSessionAsyncMock).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/v2/auth?pkce=1",
        "dehealth://auth-callback"
      );
      expect(exchangeCodeForSessionMock).toHaveBeenCalledWith("pkce-code-777");
      expect(res.session.authMethod).toBe("google");
      expect(res.session.accountId).toBe("supa-pkce-user-1");

      // Replay of completed code after flow finishes is rejected as unsolicited
      await expect(
        completeOAuthRedirectCallback(
          "dehealth://auth-callback?code=pkce-code-777"
        )
      ).rejects.toThrow(/Unsolicited Google OAuth callback rejected/);

      // While an OAuth attempt IS pending:
      //  a) Duplicate delivery of completed PKCE code deduplicates cleanly
      setPendingGoogleOAuthAttemptForTesting(true);
      expect(
        await completeOAuthRedirectCallback(
          "dehealth://auth-callback?code=pkce-code-777"
        )
      ).toBe(true);
      expect(exchangeCodeForSessionMock).toHaveBeenCalledTimes(1);

      //  b) Raw implicit URL access tokens are strictly rejected (PKCE required)
      await expect(
        handleIncomingOAuthRedirectUrl(
          "dehealth://auth-callback#access_token=tok_abc&refresh_token=ref_xyz",
          { keyStore, storage, nowMs: 71_000 }
        )
      ).rejects.toThrow(/requires a PKCE authorization code/);
      expect(setSessionMock).not.toHaveBeenCalled();
      expect(hasPendingGoogleOAuthAttempt()).toBe(false);

      //  c) Valid PKCE deep-link while attempt is armed exchanges code & clears pending flag
      setPendingGoogleOAuthAttemptForTesting(true);
      const incomingResult = await handleIncomingOAuthRedirectUrl(
        "dehealth://auth-callback?code=pkce-incoming-888",
        { keyStore, storage, nowMs: 72_000 }
      );
      expect(exchangeCodeForSessionMock).toHaveBeenCalledWith(
        "pkce-incoming-888"
      );
      expect(incomingResult?.session.authMethod).toBe("google");
      expect(incomingResult?.walletAddress).toBe(res.walletAddress);
      expect(hasPendingGoogleOAuthAttempt()).toBe(false);

      // Non-OAuth deep-link URLs are ignored cleanly without arming/rejecting
      expect(
        await handleIncomingOAuthRedirectUrl("dehealth://dashboard/checkin", {
          keyStore,
          storage
        })
      ).toBeNull();
    });

    it("fails closed when WebBrowser OAuth is cancelled/dismissed or returns OAuth error without saving session (G1, S2)", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      setSupabaseClient({
        auth: {
          signInWithOAuth: vi.fn().mockResolvedValue({
            data: {
              provider: "google",
              url: "https://accounts.google.com/o/oauth2/v2/auth?cancel=1"
            },
            error: null
          }),
          getUser: vi.fn()
        }
      } as unknown as SupabaseClient);

      setOAuthBrowserAdapterForTesting({
        openAuthSessionAsync: vi.fn().mockResolvedValue({ type: "cancel" })
      });
      await expect(signInWithGoogle({ keyStore, storage })).rejects.toThrow(
        /Google sign-in was cancelled/
      );
      expect(hasPendingGoogleOAuthAttempt()).toBe(false);

      setOAuthBrowserAdapterForTesting({
        openAuthSessionAsync: vi.fn().mockResolvedValue({
          type: "success",
          url: "dehealth://auth-callback?error=access_denied&error_description=User+denied+consent"
        })
      });
      await expect(signInWithGoogle({ keyStore, storage })).rejects.toThrow(
        /User denied consent/
      );
      expect(hasPendingGoogleOAuthAttempt()).toBe(false);

      expect(await getStoredWallet(keyStore)).toBeNull();
      expect(await getPersistedAuthSession(storage)).toBeNull();
    });
  });

  describe("createEip1193Signer", () => {
    it("rejects invalid or zero addresses", () => {
      const dummyProvider: Eip1193Provider = {
        request: vi.fn()
      };
      expect(() =>
        createEip1193Signer("not-an-address" as Address, dummyProvider)
      ).toThrow(AuthError);
      expect(() =>
        createEip1193Signer(
          "0x0000000000000000000000000000000000000000" as Address,
          dummyProvider
        )
      ).toThrow(AuthError);
    });

    it("implements getAddress, connect, signMessage, signTransaction, and bigint-safe EIP-712 signTypedData", async () => {
      const backingWallet = Wallet.createRandom();
      const capturedPayloads: string[] = [];
      const eipProvider = createWalletBackedEip1193Provider(
        backingWallet,
        capturedPayloads
      );
      const signer = createEip1193Signer(
        backingWallet.address as Address,
        eipProvider
      );

      expect(await signer.getAddress()).toBe(backingWallet.address);
      expect(signer.provider).toBeNull();

      const rpcProvider = new JsonRpcProvider("http://127.0.0.1:8545");
      const connectedSigner = signer.connect(rpcProvider);
      expect(connectedSigner.provider).toBe(rpcProvider);
      expect(await connectedSigner.getAddress()).toBe(backingWallet.address);

      await expect(signer.signTransaction({})).rejects.toThrow(AuthError);

      const textSig = await signer.signMessage("DeHealth check-in");
      expect(typeof textSig).toBe("string");
      const bytesSig = await signer.signMessage(new Uint8Array([1, 2, 3]));
      expect(typeof bytesSig).toBe("string");

      // Sign a WorkoutProof containing bigints and verify with verifyWorkoutProofSignature
      const proof: WorkoutProof = {
        user: backingWallet.address as Address,
        telemetryHash: sampleTelemetryHash,
        streakCount: 9n,
        nonce: 4n,
        deadline: 1_900_000_123n
      };
      const signedClaim = await signWorkoutProof(
        connectedSigner,
        proof,
        sampleContractAddress
      );
      expect(
        verifyWorkoutProofSignature(signedClaim, sampleContractAddress)
      ).toBe(true);
      expect(capturedPayloads).toHaveLength(1);

      const serializedPayload = JSON.parse(capturedPayloads[0]!) as {
        readonly primaryType: string;
        readonly message: Record<string, string>;
      };
      expect(serializedPayload.primaryType).toBe("WorkoutProof");
      expect(serializedPayload.message.streakCount).toBe("9");
      expect(serializedPayload.message.nonce).toBe("4");
      expect(serializedPayload.message.deadline).toBe("1900000123");

      // Explicitly verify bigint replacer when TypedDataEncoder.getPayload returns raw bigint fields
      const requestSpy = vi.fn().mockResolvedValue("0x" + "11".repeat(65));
      const bigintSigner = createEip1193Signer(
        backingWallet.address as Address,
        { request: requestSpy }
      );
      const payloadSpy = vi
        .spyOn(TypedDataEncoder, "getPayload")
        .mockReturnValueOnce({
          domain: { chainId: 421614n },
          message: { streakCount: 12n, nested: { deadline: 999n } }
        });
      const domain = createDeHealthDomain(sampleContractAddress);
      const mutableTypes: Record<string, Array<TypedDataField>> = {
        WorkoutProof: WORKOUT_PROOF_EIP712_TYPES.WorkoutProof.map((f) => ({
          ...f
        }))
      };
      await bigintSigner.signTypedData(
        domain,
        mutableTypes,
        proof as unknown as Record<string, unknown>
      );
      payloadSpy.mockRestore();

      expect(requestSpy).toHaveBeenCalledWith({
        method: "eth_signTypedData_v4",
        params: [
          backingWallet.address,
          JSON.stringify({
            domain: { chainId: "421614" },
            message: { streakCount: "12", nested: { deadline: "999" } }
          })
        ]
      });
    });

    it("wraps provider rejections and empty signatures into AuthError", async () => {
      const addr = Wallet.createRandom().address as Address;
      const rejectingProvider: Eip1193Provider = {
        async request() {
          throw { message: "User denied signature" };
        }
      };
      const rejectSigner = createEip1193Signer(addr, rejectingProvider);
      await expect(rejectSigner.signMessage("hello")).rejects.toThrow(
        /User denied signature/
      );
      await expect(
        rejectSigner.signTypedData(
          createDeHealthDomain(sampleContractAddress),
          {
            WorkoutProof: WORKOUT_PROOF_EIP712_TYPES.WorkoutProof.map((f) => ({
              ...f
            }))
          },
          {
            user: addr,
            telemetryHash: sampleTelemetryHash,
            streakCount: 1n,
            nonce: 0n,
            deadline: 1_900_000_000n
          }
        )
      ).rejects.toThrow(/User denied signature/);

      const emptyProvider: Eip1193Provider = {
        async request() {
          return "   ";
        }
      };
      const emptySigner = createEip1193Signer(addr, emptyProvider);
      await expect(emptySigner.signMessage("hello")).rejects.toThrow(AuthError);
      await expect(
        emptySigner.signTypedData(
          createDeHealthDomain(sampleContractAddress),
          {
            WorkoutProof: WORKOUT_PROOF_EIP712_TYPES.WorkoutProof.map((f) => ({
              ...f
            }))
          },
          {
            user: addr,
            telemetryHash: sampleTelemetryHash,
            streakCount: 1n,
            nonce: 0n,
            deadline: 1_900_000_000n
          }
        )
      ).rejects.toThrow(AuthError);
    });
  });

  describe("signInWithMetaMask", () => {
    it("connects via globalThis.ethereum, persists 'metamask' session, and signs EIP-712 typed data", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const storage = await initializeAuthSessionStorage(keyStore, backend);

      const metamaskWallet = Wallet.createRandom();
      const capturedPayloads: string[] = [];
      const provider = createWalletBackedEip1193Provider(
        metamaskWallet,
        capturedPayloads
      );
      (globalThis as GlobalWithWalletMocks).ethereum = provider;

      const result = await signInWithMetaMask({
        storage,
        nowMs: 30_000
      });

      expect(result.mode).toBe("live");
      expect(result.oauthUrl).toBeNull();
      expect(result.wallet).toBeNull();
      expect(result.walletAddress).toBe(metamaskWallet.address);
      expect(result.signer).not.toBeNull();
      expect(await result.signer!.getAddress()).toBe(metamaskWallet.address);
      expect(result.session).toEqual({
        authMethod: "metamask",
        accountId: metamaskWallet.address,
        displayLabel: `MetaMask (${formatShortAddress(metamaskWallet.address)})`,
        walletAddress: metamaskWallet.address as Address,
        signedInAtMs: 30_000
      });
      expect(await getPersistedAuthSession(storage)).toEqual(result.session);

      const proof: WorkoutProof = {
        user: result.walletAddress,
        telemetryHash: sampleTelemetryHash,
        streakCount: 5n,
        nonce: 2n,
        deadline: 1_950_000_000n
      };
      const signed = await signWorkoutProof(
        result.signer!,
        proof,
        sampleContractAddress
      );
      expect(verifyWorkoutProofSignature(signed, sampleContractAddress)).toBe(
        true
      );
      expect(capturedPayloads).toHaveLength(1);
    });

    it("supports window.ethereum fallback and injected MetaMaskAdapter (with or without provider)", async () => {
      const backend = new MemoryBackend();
      const storage = new AuthSessionStorage(testSecret, backend);

      // window.ethereum discovery when globalThis.ethereum is absent
      const winWallet = Wallet.createRandom();
      delete (globalThis as GlobalWithWalletMocks).ethereum;
      (globalThis as GlobalWithWalletMocks).window = {
        ethereum: createWalletBackedEip1193Provider(winWallet, [])
      };
      const winRes = await signInWithMetaMask({ storage, nowMs: 31_000 });
      expect(winRes.walletAddress).toBe(winWallet.address);
      expect(winRes.session.authMethod).toBe("metamask");

      // Injected testing adapter without provider returns signer: null
      const adapterAddr = Wallet.createRandom().address as Address;
      setMetaMaskAdapterForTesting({
        connect: vi.fn().mockResolvedValue({ address: adapterAddr })
      });
      const adapterRes = await signInWithMetaMask({ storage, nowMs: 32_000 });
      expect(adapterRes.walletAddress).toBe(adapterAddr);
      expect(adapterRes.signer).toBeNull();
      expect(adapterRes.session.authMethod).toBe("metamask");

      // Explicit options.adapter overrides testing adapter
      const overrideAddr = Wallet.createRandom().address as Address;
      const overrideRes = await signInWithMetaMask({
        storage,
        nowMs: 33_000,
        adapter: {
          connect: vi.fn().mockResolvedValue({ address: overrideAddr })
        }
      });
      expect(overrideRes.walletAddress).toBe(overrideAddr);
    });

    it("throws AuthError when MetaMask is unavailable, rejected, or returns invalid/zero address without saving session", async () => {
      const backend = new MemoryBackend();
      const storage = new AuthSessionStorage(testSecret, backend);

      delete (globalThis as GlobalWithWalletMocks).ethereum;
      delete (globalThis as GlobalWithWalletMocks).window;

      await expect(signInWithMetaMask({ storage })).rejects.toThrow(
        /MetaMask provider is unavailable/
      );

      // User rejects eth_requestAccounts
      (globalThis as GlobalWithWalletMocks).ethereum = {
        request: vi.fn().mockRejectedValue("User rejected the request")
      };
      await expect(signInWithMetaMask({ storage })).rejects.toThrow(
        /User rejected the request/
      );

      // Empty array / non-string / invalid address / zero address
      for (const accountsReturn of [
        [],
        ["not-an-evm-address"],
        ["0x0000000000000000000000000000000000000000"]
      ]) {
        (globalThis as GlobalWithWalletMocks).ethereum = {
          request: vi.fn().mockResolvedValue(accountsReturn)
        };
        await expect(signInWithMetaMask({ storage })).rejects.toThrow(
          /MetaMask did not return a valid EVM wallet address/
        );
      }

      // Adapter error & invalid address
      await expect(
        signInWithMetaMask({
          storage,
          adapter: {
            connect: vi.fn().mockRejectedValue(new Error("Bridge timeout"))
          }
        })
      ).rejects.toThrow(/Bridge timeout/);

      await expect(
        signInWithMetaMask({
          storage,
          adapter: {
            connect: vi.fn().mockResolvedValue({
              address: "0x0000000000000000000000000000000000000000"
            })
          }
        })
      ).rejects.toThrow(AuthError);

      expect(await getPersistedAuthSession(storage)).toBeNull();
    });
  });

  describe("signInWithWalletConnect", () => {
    it("connects when EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID is set + adapter succeeds, persists 'walletconnect' session, and signs EIP-712 typed data", async () => {
      const backend = new MemoryBackend();
      const storage = new AuthSessionStorage(testSecret, backend);
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "wc-project-999";

      const wcWallet = Wallet.createRandom();
      const capturedPayloads: string[] = [];
      const wcProvider = createWalletBackedEip1193Provider(
        wcWallet,
        capturedPayloads
      );
      const connectMock = vi.fn().mockResolvedValue({
        address: wcWallet.address,
        provider: wcProvider
      });
      setWalletConnectAdapterForTesting({
        connect: connectMock
      });

      const result = await signInWithWalletConnect({
        storage,
        nowMs: 40_000
      });

      expect(connectMock).toHaveBeenCalledWith("wc-project-999");
      expect(result.mode).toBe("live");
      expect(result.oauthUrl).toBeNull();
      expect(result.wallet).toBeNull();
      expect(result.walletAddress).toBe(wcWallet.address);
      expect(result.signer).not.toBeNull();
      expect(result.session).toEqual({
        authMethod: "walletconnect",
        accountId: wcWallet.address,
        displayLabel: `WalletConnect (${formatShortAddress(wcWallet.address)})`,
        walletAddress: wcWallet.address as Address,
        signedInAtMs: 40_000
      });
      expect(await getPersistedAuthSession(storage)).toEqual(result.session);

      const proof: WorkoutProof = {
        user: result.walletAddress,
        telemetryHash: sampleTelemetryHash,
        streakCount: 14n,
        nonce: 7n,
        deadline: 1_960_000_000n
      };
      const signed = await signWorkoutProof(
        result.signer!,
        proof,
        sampleContractAddress
      );
      expect(verifyWorkoutProofSignature(signed, sampleContractAddress)).toBe(
        true
      );
      expect(capturedPayloads).toHaveLength(1);

      // Adapter without EIP-1193 provider returns signer: null
      const noProviderAddr = Wallet.createRandom().address as Address;
      const noProviderRes = await signInWithWalletConnect({
        storage,
        projectId: "explicit-wc-id",
        adapter: {
          connect: vi.fn().mockResolvedValue({ address: noProviderAddr })
        }
      });
      expect(noProviderRes.walletAddress).toBe(noProviderAddr);
      expect(noProviderRes.signer).toBeNull();
    });

    it("throws AuthError when Project ID is unset, adapter unavailable, rejected, or returns invalid/zero address", async () => {
      const backend = new MemoryBackend();
      const storage = new AuthSessionStorage(testSecret, backend);

      // Unset project ID
      delete process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
      await expect(signInWithWalletConnect({ storage })).rejects.toThrow(
        /WalletConnect Project ID is not configured/
      );

      // Configured project ID but provider loader unavailable
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "wc-project-123";
      setWalletConnectAdapterForTesting(null);
      await expect(signInWithWalletConnect({ storage })).rejects.toThrow(
        /WalletConnect v2 provider is unavailable/
      );
      resetWalletConnectAdapterForTesting();

      // Adapter rejects with Error and AuthError
      await expect(
        signInWithWalletConnect({
          storage,
          adapter: {
            connect: vi.fn().mockRejectedValue(new Error("Relay declined"))
          }
        })
      ).rejects.toThrow(/Relay declined/);
      await expect(
        signInWithWalletConnect({
          storage,
          adapter: {
            connect: vi.fn().mockRejectedValue(new AuthError("QR expired"))
          }
        })
      ).rejects.toThrow(/QR expired/);

      // Invalid / zero address
      for (const badAddress of [
        "bad-address",
        "0x0000000000000000000000000000000000000000"
      ]) {
        await expect(
          signInWithWalletConnect({
            storage,
            projectId: "explicit-project-id",
            adapter: {
              connect: vi.fn().mockResolvedValue({ address: badAddress })
            }
          })
        ).rejects.toThrow(/WalletConnect did not return a valid EVM wallet address/);
      }

      expect(await getPersistedAuthSession(storage)).toBeNull();
    });

    it("uses native UniversalProvider + Linking deep link out-of-the-box for WalletConnect & MetaMask Mobile fallback, and supports silent boot restore (E1, E2)", async () => {
      const backend = new MemoryBackend();
      const storage = new AuthSessionStorage(testSecret, backend);
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "wc-native-proj-777";
      delete (globalThis as GlobalWithWalletMocks).ethereum;
      delete (globalThis as GlobalWithWalletMocks).window;

      const remoteWallet = Wallet.createRandom();
      const openedUrls: string[] = [];
      setDeepLinkOpenerForTesting(async (url: string) => {
        openedUrls.push(url);
      });

      const listeners = new Map<string, (payload: string) => void>();
      const disconnectMock = vi.fn().mockResolvedValue(undefined);
      const mockProvider: UniversalProviderLike = {
        session: undefined,
        on: (event, listener) => {
          listeners.set(event, listener);
        },
        off: (event) => {
          listeners.delete(event);
        },
        connect: vi.fn().mockImplementation(async () => {
          listeners.get("display_uri")?.("wc:abc123@2?relay-protocol=irn&symKey=xyz");
          (mockProvider as { session: UniversalProviderLike["session"] }).session = {
            namespaces: {
              eip155: {
                accounts: [`eip155:421614:${remoteWallet.address}`]
              }
            }
          };
          return mockProvider.session;
        }),
        request: async ({ method, params }) => {
          const eip1193 = createWalletBackedEip1193Provider(remoteWallet, []);
          return eip1193.request({
            method,
            params: Array.isArray(params) ? params : undefined
          });
        },
        disconnect: disconnectMock
      };

      setUniversalProviderFactoryForTesting(async () => mockProvider);

      // 1. Native MetaMask Mobile fallback when window.ethereum is absent
      const mmRes = await signInWithMetaMask({ storage, nowMs: 80_000 });
      expect(mmRes.session.authMethod).toBe("metamask");
      expect(mmRes.walletAddress).toBe(remoteWallet.address);
      expect(mmRes.signer).not.toBeNull();
      expect(openedUrls[0]).toBe(
        `https://metamask.app.link/wc?uri=${encodeURIComponent(
          "wc:abc123@2?relay-protocol=irn&symKey=xyz"
        )}`
      );

      // 2. Native WalletConnect v2 without injected test adapter triggers Linking.openURL with raw wc: URI
      resetUniversalProviderFactoryForTesting();
      setUniversalProviderFactoryForTesting(async () => mockProvider);
      const wcRes = await signInWithWalletConnect({ storage, nowMs: 81_000 });
      expect(wcRes.session.authMethod).toBe("walletconnect");
      expect(wcRes.walletAddress).toBe(remoteWallet.address);
      expect(openedUrls[1]).toBe("wc:abc123@2?relay-protocol=irn&symKey=xyz");

      const proof: WorkoutProof = {
        user: wcRes.walletAddress,
        telemetryHash: sampleTelemetryHash,
        streakCount: 3n,
        nonce: 1n,
        deadline: 1_970_000_000n
      };
      const signedClaim = await signWorkoutProof(
        wcRes.signer!,
        proof,
        sampleContractAddress
      );
      expect(
        verifyWorkoutProofSignature(signedClaim, sampleContractAddress)
      ).toBe(true);

      // 3. Silent boot restore succeeds while WC session is alive, and returns null if absent or mismatched
      const restoredWc = await restoreExternalWalletSignerOnBoot(wcRes.session);
      expect(restoredWc).not.toBeNull();
      expect(await restoredWc!.getAddress()).toBe(remoteWallet.address);

      // Disconnect on sign-out clears active UniversalProvider
      await signOutSession({ storage });
      expect(disconnectMock).toHaveBeenCalledTimes(1);

      // Boot restore after session gone returns null
      resetUniversalProviderFactoryForTesting();
      setUniversalProviderFactoryForTesting(async () => ({
        session: undefined,
        on: vi.fn(),
        connect: vi.fn(),
        request: vi.fn()
      }));
      expect(
        await restoreExternalWalletSignerOnBoot(wcRes.session)
      ).toBeNull();

      // Silent MetaMask restore via eth_accounts (matches expected address, skips mismatched)
      (globalThis as GlobalWithWalletMocks).ethereum = {
        request: vi.fn().mockResolvedValue([remoteWallet.address])
      };
      const restoredMm = await restoreExternalWalletSignerOnBoot(mmRes.session);
      expect(restoredMm).not.toBeNull();
      expect(await restoredMm!.getAddress()).toBe(remoteWallet.address);

      (globalThis as GlobalWithWalletMocks).ethereum = {
        request: vi.fn().mockResolvedValue([Wallet.createRandom().address])
      };
      expect(
        await restoreExternalWalletSignerOnBoot(mmRes.session)
      ).toBeNull();
    });
  });

  describe("signOutSession data preservation & WalletConnect disconnect", () => {
    it("disconnects WalletConnect & Supabase non-fatally and clears ONLY auth session while preserving wallet key, vault secret, biometrics, and governance config", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      const secret = await provisionVaultSecret(keyStore);
      const storage = new AuthSessionStorage(secret, backend);
      setAuthSessionStorage(storage);

      const adaptive = new AdaptiveStorage(secret, backend);
      await adaptive.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);

      const governance = new GovernanceStorage(secret, backend);
      await governance.saveGovernanceConfig(DEFAULT_GOVERNANCE_CONFIG);

      const disconnectMock = vi
        .fn()
        .mockRejectedValue(new Error("Relay already closed"));
      setWalletConnectAdapterForTesting({
        connect: vi.fn(),
        disconnect: disconnectMock
      });

      const signOutMock = vi
        .fn()
        .mockRejectedValue(new Error("Offline signout"));
      setSupabaseClient({
        auth: { signOut: signOutMock }
      } as unknown as SupabaseClient);

      const signedIn = await startLocalSession({
        keyStore,
        storage,
        nowMs: 50_000
      });
      expect(await getPersistedAuthSession(storage)).toEqual(signedIn.session);

      await signOutSession({ storage });
      expect(disconnectMock).toHaveBeenCalledTimes(1);
      expect(signOutMock).toHaveBeenCalledTimes(1);

      // Session is cleared
      expect(await getPersistedAuthSession(storage)).toBeNull();
      expect(backend.items.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);

      // Wallet, vault secret, biometrics, and governance config are completely preserved
      expect(await keyStore.getItem(VAULT_SECRET_STORAGE_KEY)).toBe(secret);
      expect(await keyStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        signedIn.wallet!.privateKey
      );
      expect((await getStoredWallet(keyStore))?.address).toBe(
        signedIn.walletAddress
      );
      expect(backend.items.has(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS)).toBe(
        true
      );
      expect(await adaptive.getUserBiometrics()).toEqual(
        DEFAULT_BASELINE_BIOMETRICS
      );
      expect(backend.items.has(GOVERNANCE_STORAGE_KEY)).toBe(true);
      expect(await governance.getGovernanceConfig()).toEqual(
        DEFAULT_GOVERNANCE_CONFIG
      );
    });
  });
});
