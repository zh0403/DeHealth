import { DEFAULT_BASELINE_BIOMETRICS } from "@dehealth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secureStoreMock = vi.hoisted(() => ({
  available: false,
  items: new Map<string, string>(),
  isAvailableAsync: async (): Promise<boolean> => secureStoreMock.available,
  getItemAsync: async (key: string): Promise<string | null> =>
    secureStoreMock.items.get(key) ?? null,
  setItemAsync: async (key: string, value: string): Promise<void> => {
    secureStoreMock.items.set(key, value);
  }
}));

vi.mock("expo-secure-store", () => ({
  isAvailableAsync: secureStoreMock.isAvailableAsync,
  getItemAsync: secureStoreMock.getItemAsync,
  setItemAsync: secureStoreMock.setItemAsync
}));

vi.mock("@react-native-async-storage/async-storage", () => {
  const items = new Map<string, string>();
  return {
    default: {
      getItem: async (key: string): Promise<string | null> => items.get(key) ?? null,
      setItem: async (key: string, value: string): Promise<void> => {
        items.set(key, value);
      },
      removeItem: async (key: string): Promise<void> => {
        items.delete(key);
      }
    }
  };
});

import {
  AdaptiveStorage,
  getAdaptiveStorage,
  getUserBiometrics,
  initializeAdaptiveStorage,
  resetAdaptiveStorage,
  saveUserBiometrics
} from "../storage/adaptiveStorage";
import { KeyValueStorageBackend } from "../storage/encryptedStorageAdapter";
import {
  createPlatformKeyStore,
  generateVaultSecret,
  InMemoryKeyStore,
  isValidVaultSecret,
  provisionVaultSecret,
  SecureKeyStore,
  VAULT_SECRET_STORAGE_KEY,
  VaultKeyUnavailableError,
  WebLocalStorageKeyStore
} from "../storage/vaultKeyProvider";

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

/** The literal that previously shipped in source. It must never open the vault again. */
const FORMER_HARDCODED_PASSPHRASE = "DeHealthLocalVaultSecretKey2026!";

describe("SOV-01: per-install vault key provisioning", () => {
  beforeEach(() => {
    resetAdaptiveStorage();
    secureStoreMock.available = false;
    secureStoreMock.items.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAdaptiveStorage();
  });

  describe("secret generation and validation", () => {
    it("generates 32 random bytes as lowercase 0x hex", () => {
      const secret = generateVaultSecret();
      expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
      expect(isValidVaultSecret(secret)).toBe(true);
    });

    it("never repeats across generations", () => {
      const secrets = new Set(Array.from({ length: 50 }, () => generateVaultSecret()));
      expect(secrets.size).toBe(50);
    });

    it("rejects malformed secrets", () => {
      const bad: unknown[] = [
        null,
        undefined,
        42,
        "",
        "0x",
        "0x1234",
        `0x${"g".repeat(64)}`,
        `0x${"A".repeat(64)}`,
        "a".repeat(64),
        `0x${"a".repeat(65)}`,
        DEFAULT_BASELINE_BIOMETRICS
      ];
      for (const value of bad) {
        expect(isValidVaultSecret(value)).toBe(false);
      }
    });
  });

  describe("provisionVaultSecret", () => {
    it("creates and persists a secret on first launch, then reuses it", async () => {
      const store = new InMemoryKeyStore();
      expect(await store.getItem(VAULT_SECRET_STORAGE_KEY)).toBeNull();

      const first = await provisionVaultSecret(store);
      const second = await provisionVaultSecret(store);

      expect(isValidVaultSecret(first)).toBe(true);
      expect(second).toBe(first);
      expect(await store.getItem(VAULT_SECRET_STORAGE_KEY)).toBe(first);
    });

    it("gives two independent installs different secrets", async () => {
      const a = await provisionVaultSecret(new InMemoryKeyStore());
      const b = await provisionVaultSecret(new InMemoryKeyStore());
      expect(a).not.toBe(b);
    });

    it("refuses, and does not overwrite, a malformed stored secret", async () => {
      const store = new InMemoryKeyStore();
      await store.setItem(VAULT_SECRET_STORAGE_KEY, "corrupted");

      await expect(provisionVaultSecret(store)).rejects.toBeInstanceOf(
        VaultKeyUnavailableError
      );
      expect(await store.getItem(VAULT_SECRET_STORAGE_KEY)).toBe("corrupted");
    });

    it("refuses when the secret cannot be read back after writing", async () => {
      const lossyStore: SecureKeyStore = {
        getItem: async () => null,
        setItem: async () => undefined
      };
      await expect(provisionVaultSecret(lossyStore)).rejects.toBeInstanceOf(
        VaultKeyUnavailableError
      );
    });

    it("propagates a failing keystore instead of falling back to a default", async () => {
      const brokenStore: SecureKeyStore = {
        getItem: async () => {
          throw new Error("keystore locked");
        },
        setItem: async () => undefined
      };
      await expect(provisionVaultSecret(brokenStore)).rejects.toThrow("keystore locked");
    });
  });

  describe("platform keystore selection", () => {
    it("prefers expo-secure-store when it is available", async () => {
      secureStoreMock.available = true;
      const store = await createPlatformKeyStore();
      await store.setItem("k", "v");
      expect(secureStoreMock.items.get("k")).toBe("v");
      expect(await store.getItem("k")).toBe("v");
    });

    it("uses localStorage on web when secure store is unavailable", async () => {
      const data = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => {
          data.set(k, v);
        }
      });
      const store = await createPlatformKeyStore();
      expect(store).toBeInstanceOf(WebLocalStorageKeyStore);
      await store.setItem("k", "v");
      expect(data.get("k")).toBe("v");
    });

    it("falls back to memory only in a non-native, non-web runtime", async () => {
      vi.stubGlobal("localStorage", undefined);
      vi.stubGlobal("navigator", { product: "Gecko" });
      expect(await createPlatformKeyStore()).toBeInstanceOf(InMemoryKeyStore);
    });

    it("refuses on React Native when the secure keystore is unavailable", async () => {
      vi.stubGlobal("navigator", { product: "ReactNative" });
      await expect(createPlatformKeyStore()).rejects.toBeInstanceOf(
        VaultKeyUnavailableError
      );
    });

    it("survives a localStorage that throws on access", async () => {
      vi.stubGlobal("navigator", { product: "Gecko" });
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get: () => {
          throw new Error("SecurityError");
        }
      });
      try {
        expect(await createPlatformKeyStore()).toBeInstanceOf(InMemoryKeyStore);
      } finally {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    });
  });

  describe("AdaptiveStorage refuses to run without a provisioned secret", () => {
    it("has no default instance before initialization", () => {
      expect(() => getAdaptiveStorage()).toThrow(VaultKeyUnavailableError);
    });

    it("cannot be constructed without a secret", () => {
      expect(
        () => new AdaptiveStorage(undefined as unknown as string)
      ).toThrow(VaultKeyUnavailableError);
    });

    it("still enforces a minimum passphrase length", () => {
      expect(() => new AdaptiveStorage("short")).toThrow();
    });

    it("provisions on first use and encrypts under the per-install secret", async () => {
      const backend = new MemoryBackend();
      const keyStore = new InMemoryKeyStore();
      const storage = await initializeAdaptiveStorage(keyStore, backend);

      await storage.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
      const secret = await keyStore.getItem(VAULT_SECRET_STORAGE_KEY);
      expect(isValidVaultSecret(secret)).toBe(true);

      const sameSecret = new AdaptiveStorage(secret as string, backend);
      expect(await sameSecret.getUserBiometrics()).toEqual(DEFAULT_BASELINE_BIOMETRICS);
    });

    it("cannot be opened with the former hardcoded passphrase", async () => {
      const backend = new MemoryBackend();
      const storage = await initializeAdaptiveStorage(new InMemoryKeyStore(), backend);
      await storage.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);

      const attacker = new AdaptiveStorage(FORMER_HARDCODED_PASSPHRASE, backend);
      await expect(attacker.getUserBiometrics()).rejects.toThrow(/MAC verification failed/);
    });

    it("keeps one instance across repeated and concurrent initialization", async () => {
      const backend = new MemoryBackend();
      const keyStore = new InMemoryKeyStore();
      const [a, b] = await Promise.all([
        initializeAdaptiveStorage(keyStore, backend),
        initializeAdaptiveStorage(keyStore, backend)
      ]);
      const c = await initializeAdaptiveStorage(keyStore, backend);

      expect(a).toBe(b);
      expect(a).toBe(c);
      expect(getAdaptiveStorage()).toBe(a);
    });

    it("stays uninitialized and rejects reads when the secret is unusable", async () => {
      const badStore = new InMemoryKeyStore();
      await badStore.setItem(VAULT_SECRET_STORAGE_KEY, "corrupted");

      await expect(initializeAdaptiveStorage(badStore)).rejects.toBeInstanceOf(
        VaultKeyUnavailableError
      );
      expect(() => getAdaptiveStorage()).toThrow(VaultKeyUnavailableError);
    });

    it("allows a retry after a failed initialization", async () => {
      const badStore = new InMemoryKeyStore();
      await badStore.setItem(VAULT_SECRET_STORAGE_KEY, "corrupted");
      await expect(initializeAdaptiveStorage(badStore)).rejects.toBeDefined();

      const storage = await initializeAdaptiveStorage(new InMemoryKeyStore(), new MemoryBackend());
      expect(getAdaptiveStorage()).toBe(storage);
    });

    it("convenience functions provision lazily via the platform keystore", async () => {
      secureStoreMock.available = true;
      expect(await getUserBiometrics()).toBeNull();
      expect(isValidVaultSecret(secureStoreMock.items.get(VAULT_SECRET_STORAGE_KEY))).toBe(
        true
      );

      await saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
      expect(await getUserBiometrics()).toEqual(DEFAULT_BASELINE_BIOMETRICS);
    });
  });
});
