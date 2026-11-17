import { Wallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vaultKeyProvider from "../storage/vaultKeyProvider";
import { InMemoryKeyStore } from "../storage/vaultKeyProvider";
import {
  clearStoredWallet,
  exportWalletPrivateKey,
  getOrCreatePersistentWallet,
  getStoredWallet,
  isValidPrivateKey,
  resetWalletStorageForTesting,
  WALLET_PRIVATE_KEY_STORAGE_KEY,
  WalletStorageError
} from "../storage/walletStorage";

describe("Milestone 1 R2: Persistent Embedded Wallet Storage", () => {
  beforeEach(() => {
    resetWalletStorageForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetWalletStorageForTesting();
  });

  describe("isValidPrivateKey", () => {
    it("validates 0x-prefixed 64-hex character private keys (case-insensitive)", () => {
      expect(isValidPrivateKey("0x" + "a1b2c3d4e5f60718293a4b5c6d7e8f90".repeat(2))).toBe(true);
      expect(isValidPrivateKey("0x" + "ABCDEF0123456789".repeat(4))).toBe(true);
    });

    it("rejects non-string, missing prefix, incorrect length, or non-hex characters", () => {
      expect(isValidPrivateKey(null)).toBe(false);
      expect(isValidPrivateKey(undefined)).toBe(false);
      expect(isValidPrivateKey(12345)).toBe(false);
      expect(isValidPrivateKey("0x1234")).toBe(false); // too short
      expect(isValidPrivateKey("a1".repeat(32))).toBe(false); // missing 0x
      expect(isValidPrivateKey("0x" + "g".repeat(64))).toBe(false); // non-hex
      expect(isValidPrivateKey("0x" + "a1".repeat(33))).toBe(false); // too long
    });
  });

  describe("getOrCreatePersistentWallet", () => {
    it("creates a new wallet and persists the private key on first launch", async () => {
      const store = new InMemoryKeyStore();
      const wallet = await getOrCreatePersistentWallet(store);

      expect(wallet).toBeInstanceOf(Wallet);
      expect(isValidPrivateKey(wallet.privateKey)).toBe(true);
      expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

      const persistedKey = await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY);
      expect(persistedKey).toBe(wallet.privateKey);
    });

    it("returns identical wallet address and private key across reloads / subsequent calls", async () => {
      const store = new InMemoryKeyStore();
      const firstWallet = await getOrCreatePersistentWallet(store);

      // Simulate a fresh session with same store
      resetWalletStorageForTesting();
      const reloadedWallet = await getOrCreatePersistentWallet(store);

      expect(reloadedWallet.address).toBe(firstWallet.address);
      expect(reloadedWallet.privateKey).toBe(firstWallet.privateKey);
    });

    it("fails closed when stored private key is malformed and NEVER overwrites it", async () => {
      const store = new InMemoryKeyStore();
      const corruptedKey = "0xcorrupted_truncated_key";
      await store.setItem(WALLET_PRIVATE_KEY_STORAGE_KEY, corruptedKey);

      await expect(getOrCreatePersistentWallet(store)).rejects.toThrow(WalletStorageError);
      await expect(getOrCreatePersistentWallet(store)).rejects.toThrow(/malformed/i);

      // Verify the corrupted key was NOT overwritten with a new wallet
      const stillInStore = await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY);
      expect(stillInStore).toBe(corruptedKey);
    });

    it("verifies persistence with read-back check, throwing if write fails", async () => {
      const failingStore = {
        async getItem(_key: string): Promise<string | null> {
          return null;
        },
        async setItem(_key: string, _val: string): Promise<void> {
          // No-op or failed write
        }
      };

      await expect(getOrCreatePersistentWallet(failingStore)).rejects.toThrow(WalletStorageError);
      await expect(getOrCreatePersistentWallet(failingStore)).rejects.toThrow(/could not be persisted/i);
    });

    it("throws WalletStorageError when read-back returns a mismatched non-null key", async () => {
      let readCount = 0;
      const mismatchedStore = {
        async getItem(_key: string): Promise<string | null> {
          readCount += 1;
          // First read returns null (fresh wallet); read-back verification returns wrong key
          return readCount === 1 ? null : "0x" + "11".repeat(32);
        },
        async setItem(_key: string, _val: string): Promise<void> {
          // Pretend write happened with stale value
        }
      };

      await expect(getOrCreatePersistentWallet(mismatchedStore)).rejects.toThrow(WalletStorageError);
      readCount = 0;
      await expect(getOrCreatePersistentWallet(mismatchedStore)).rejects.toThrow(/could not be persisted/i);
    });
  });

  describe("getStoredWallet & exportWalletPrivateKey", () => {
    it("returns null if no wallet has been initialized in storage", async () => {
      const store = new InMemoryKeyStore();
      const stored = await getStoredWallet(store);
      expect(stored).toBeNull();
    });

    it("throws WalletStorageError if stored key in getStoredWallet is malformed", async () => {
      const store = new InMemoryKeyStore();
      await store.setItem(WALLET_PRIVATE_KEY_STORAGE_KEY, "0xmalformed_key_data");

      await expect(getStoredWallet(store)).rejects.toThrow(WalletStorageError);
      await expect(getStoredWallet(store)).rejects.toThrow(/malformed/i);
    });

    it("returns the existing wallet if already initialized", async () => {
      const store = new InMemoryKeyStore();
      const created = await getOrCreatePersistentWallet(store);
      const retrieved = await getStoredWallet(store);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.address).toBe(created.address);
      expect(retrieved?.privateKey).toBe(created.privateKey);
    });

    it("exports the stored private key securely", async () => {
      const store = new InMemoryKeyStore();
      const created = await getOrCreatePersistentWallet(store);
      const exported = await exportWalletPrivateKey(store);

      expect(exported).toBe(created.privateKey);
    });

    it("deletes stored wallet key on clearStoredWallet so subsequent getStoredWallet returns null and a fresh wallet can be created", async () => {
      const store = new InMemoryKeyStore();
      const firstWallet = await getOrCreatePersistentWallet(store);
      expect(await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).not.toBeNull();

      await clearStoredWallet(store);
      expect(await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(await getStoredWallet(store)).toBeNull();

      const freshWallet = await getOrCreatePersistentWallet(store);
      expect(freshWallet).toBeInstanceOf(Wallet);
      expect(isValidPrivateKey(freshWallet.privateKey)).toBe(true);
      expect(freshWallet.address).not.toBe(firstWallet.address);
    });

    it("serializes concurrent first-boot getOrCreatePersistentWallet calls on an empty InMemoryKeyStore", async () => {
      const store = new InMemoryKeyStore();
      const setItemSpy = vi.spyOn(store, "setItem");

      const [walletA, walletB, walletC] = await Promise.all([
        getOrCreatePersistentWallet(store),
        getOrCreatePersistentWallet(store),
        getOrCreatePersistentWallet(store)
      ]);

      expect(walletA).toBeInstanceOf(Wallet);
      expect(walletB).toBe(walletA);
      expect(walletC).toBe(walletA);
      expect(walletB.address).toBe(walletA.address);
      expect(walletC.privateKey).toBe(walletA.privateKey);
      expect(setItemSpy).toHaveBeenCalledTimes(1);
      expect(await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(walletA.privateKey);
    });
  });

  describe("Platform Keystore Fail-Closed Check", () => {
    it("fails closed on React Native runtime when secure hardware store is unavailable", async () => {
      // Temporarily mock navigator to simulate React Native
      const originalNav = (globalThis as { navigator?: unknown }).navigator;
      Object.defineProperty(globalThis, "navigator", {
        value: { product: "ReactNative" },
        configurable: true,
        writable: true
      });

      try {
        await expect(getOrCreatePersistentWallet()).rejects.toThrow(WalletStorageError);
        await expect(getStoredWallet()).rejects.toThrow(WalletStorageError);
      } finally {
        Object.defineProperty(globalThis, "navigator", {
          value: originalNav,
          configurable: true,
          writable: true
        });
      }
    });

    it("caches default platform wallet on creation and reloads existing key from default store after cache reset", async () => {
      const platformStore = new InMemoryKeyStore();
      const spy = vi
        .spyOn(vaultKeyProvider, "createPlatformKeyStore")
        .mockResolvedValue(platformStore);

      const created = await getOrCreatePersistentWallet();
      expect(spy).toHaveBeenCalledTimes(1);

      // Second call hits in-memory cachedWallet without calling createPlatformKeyStore again
      const cached = await getOrCreatePersistentWallet();
      expect(cached.address).toBe(created.address);
      expect(cached.privateKey).toBe(created.privateKey);
      expect(spy).toHaveBeenCalledTimes(1);

      // Reset cache and reload existing key from default store (covers existing-key cache branch)
      resetWalletStorageForTesting();
      const reloaded = await getOrCreatePersistentWallet();
      expect(reloaded.address).toBe(created.address);
      expect(reloaded.privateKey).toBe(created.privateKey);
      expect(spy).toHaveBeenCalledTimes(2);

      // Subsequent call after reload hits cache again
      const cachedAfterReload = await getOrCreatePersistentWallet();
      expect(cachedAfterReload).toBe(reloaded);
      expect(spy).toHaveBeenCalledTimes(2);

      // getStoredWallet() without arguments also resolves default store
      const stored = await getStoredWallet();
      expect(stored?.address).toBe(created.address);
      expect(spy).toHaveBeenCalledTimes(3);

      // clearStoredWallet() without arguments resolves default store and deletes key
      await clearStoredWallet();
      expect(await platformStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(4);
    });

    it("serializes concurrent first-boot getOrCreatePersistentWallet calls on the default platform keystore", async () => {
      const platformStore = new InMemoryKeyStore();
      const createStoreSpy = vi
        .spyOn(vaultKeyProvider, "createPlatformKeyStore")
        .mockResolvedValue(platformStore);
      const setItemSpy = vi.spyOn(platformStore, "setItem");

      const [walletA, walletB, walletC] = await Promise.all([
        getOrCreatePersistentWallet(),
        getOrCreatePersistentWallet(),
        getOrCreatePersistentWallet()
      ]);

      expect(walletA).toBeInstanceOf(Wallet);
      expect(walletB).toBe(walletA);
      expect(walletC).toBe(walletA);
      expect(createStoreSpy).toHaveBeenCalledTimes(1);
      expect(setItemSpy).toHaveBeenCalledTimes(1);
      expect(await platformStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        walletA.privateKey
      );

      // Subsequent call uses cachedWallet
      const cached = await getOrCreatePersistentWallet();
      expect(cached).toBe(walletA);
      expect(createStoreSpy).toHaveBeenCalledTimes(1);
    });

    it("handles resetWalletStorageForTesting called while default platform wallet creation is in flight", async () => {
      const platformStore = new InMemoryKeyStore();
      let releaseStore!: (store: InMemoryKeyStore) => void;
      const deferredStore = new Promise<InMemoryKeyStore>((resolve) => {
        releaseStore = resolve;
      });
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockReturnValueOnce(
        deferredStore
      );

      const inflight = getOrCreatePersistentWallet();
      resetWalletStorageForTesting();
      releaseStore(platformStore);

      const wallet = await inflight;
      expect(wallet).toBeInstanceOf(Wallet);
    });

    it("re-throws unexpected non-VaultKeyUnavailableError errors from createPlatformKeyStore", async () => {
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockRejectedValueOnce(
        new Error("Unexpected I/O subsystem failure")
      );
      await expect(getOrCreatePersistentWallet()).rejects.toThrow(
        "Unexpected I/O subsystem failure"
      );

      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockRejectedValueOnce(
        new Error("Unexpected keystore read fault")
      );
      await expect(getStoredWallet()).rejects.toThrow(
        "Unexpected keystore read fault"
      );
    });

    it("handles clearStoredWallet safely when deleteItem is absent or throws", async () => {
      const storeWithoutDelete = {
        async getItem(_key: string): Promise<string | null> {
          return null;
        },
        async setItem(_key: string, _val: string): Promise<void> {
          // no-op
        }
      };
      await expect(clearStoredWallet(storeWithoutDelete)).resolves.toBeUndefined();

      const storeWithFailingDelete = {
        async getItem(_key: string): Promise<string | null> {
          return null;
        },
        async setItem(_key: string, _val: string): Promise<void> {
          // no-op
        },
        async deleteItem(_key: string): Promise<void> {
          throw new Error("Hardware enclave busy");
        }
      };
      await expect(clearStoredWallet(storeWithFailingDelete)).resolves.toBeUndefined();
    });
  });
});
