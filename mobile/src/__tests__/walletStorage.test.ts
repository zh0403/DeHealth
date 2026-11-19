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

      // Default store teardown when deleteItem throws or createPlatformKeyStore rejects
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockResolvedValueOnce(
        storeWithFailingDelete
      );
      await expect(clearStoredWallet()).resolves.toBeUndefined();
    });
  });

  describe("Concurrent clearStoredWallet Serialization (O-9)", () => {
    it("waits for in-flight getOrCreatePersistentWallet(store) before deleting key on custom store", async () => {
      const inner = new InMemoryKeyStore();
      const ops: string[] = [];
      let releaseSetItem!: () => void;
      const setItemGate = new Promise<void>((resolve) => {
        releaseSetItem = resolve;
      });
      let setItemStarted!: () => void;
      const onSetItemStarted = new Promise<void>((resolve) => {
        setItemStarted = resolve;
      });

      const store: vaultKeyProvider.SecureKeyStore = {
        async getItem(key: string): Promise<string | null> {
          ops.push("getItem");
          return inner.getItem(key);
        },
        async setItem(key: string, value: string): Promise<void> {
          ops.push("setItem");
          setItemStarted();
          await setItemGate;
          return inner.setItem(key, value);
        },
        async deleteItem(key: string): Promise<void> {
          ops.push("deleteItem");
          return inner.deleteItem(key);
        }
      };

      const createPromise = getOrCreatePersistentWallet(store);
      await onSetItemStarted;

      const clearPromise = clearStoredWallet(store);
      // Allow microtasks to flush; deleteItem must NOT run while createPromise is pending
      await Promise.resolve();
      await Promise.resolve();
      expect(ops).not.toContain("deleteItem");

      releaseSetItem();
      const [created] = await Promise.all([createPromise, clearPromise]);

      expect(created).toBeInstanceOf(Wallet);
      expect(ops).toEqual(["getItem", "setItem", "getItem", "deleteItem"]);
      expect(await inner.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(await getStoredWallet(store)).toBeNull();
    });

    it("waits for in-flight default-store creation, re-clears cachedWallet, and issues a fresh wallet afterward", async () => {
      const platformStore = new InMemoryKeyStore();
      let releaseStore!: (store: InMemoryKeyStore) => void;
      const deferredStore = new Promise<InMemoryKeyStore>((resolve) => {
        releaseStore = resolve;
      });

      const spy = vi.spyOn(vaultKeyProvider, "createPlatformKeyStore");
      spy
        .mockReturnValueOnce(deferredStore)
        .mockResolvedValue(platformStore);

      const createPromise = getOrCreatePersistentWallet();
      const clearPromise = clearStoredWallet();

      releaseStore(platformStore);
      const [created] = await Promise.all([createPromise, clearPromise]);

      expect(await platformStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(await getStoredWallet()).toBeNull();

      // Verify cachedWallet was not left populated with the deleted wallet
      const fresh = await getOrCreatePersistentWallet();
      expect(fresh.address).not.toBe(created.address);
      expect(await platformStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        fresh.privateKey
      );
    });

    it("serializes interleaved create1 -> clear -> create2 on both custom and default stores", async () => {
      // Custom store interleaving
      const inner = new InMemoryKeyStore();
      let releaseFirstSet!: () => void;
      const firstSetGate = new Promise<void>((resolve) => {
        releaseFirstSet = resolve;
      });
      let setCount = 0;

      const customStore: vaultKeyProvider.SecureKeyStore = {
        getItem: (key) => inner.getItem(key),
        setItem: async (key, value) => {
          setCount += 1;
          if (setCount === 1) {
            await firstSetGate;
          }
          return inner.setItem(key, value);
        },
        deleteItem: (key) => inner.deleteItem(key)
      };

      const c1 = getOrCreatePersistentWallet(customStore);
      await Promise.resolve();
      const clr = clearStoredWallet(customStore);
      const c2 = getOrCreatePersistentWallet(customStore);

      releaseFirstSet();
      const [w1, , w2] = await Promise.all([c1, clr, c2]);

      expect(w2.address).not.toBe(w1.address);
      expect(await inner.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        w2.privateKey
      );

      // Default store interleaving
      const defaultStore = new InMemoryKeyStore();
      let releaseDefaultFirstStore!: (store: InMemoryKeyStore) => void;
      const deferredDefaultFirst = new Promise<InMemoryKeyStore>((resolve) => {
        releaseDefaultFirstStore = resolve;
      });
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore")
        .mockReturnValueOnce(deferredDefaultFirst)
        .mockResolvedValue(defaultStore);

      const dc1 = getOrCreatePersistentWallet();
      const dclr = clearStoredWallet();
      const dc2 = getOrCreatePersistentWallet();

      releaseDefaultFirstStore(defaultStore);
      const [dw1, , dw2] = await Promise.all([dc1, dclr, dc2]);

      expect(dw2.address).not.toBe(dw1.address);
      expect(await defaultStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        dw2.privateKey
      );
    });

    it("still deletes key during clearStoredWallet when the awaited in-flight creation rejects", async () => {
      const inner = new InMemoryKeyStore();
      await inner.setItem(WALLET_PRIVATE_KEY_STORAGE_KEY, "0xcorrupted_key");

      let releaseGet!: () => void;
      const getGate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      const deleteSpy = vi.fn((key: string) => inner.deleteItem(key));

      const store: vaultKeyProvider.SecureKeyStore = {
        getItem: async (key: string) => {
          await getGate;
          return inner.getItem(key);
        },
        setItem: (key, value) => inner.setItem(key, value),
        deleteItem: deleteSpy
      };

      const createPromise = getOrCreatePersistentWallet(store);
      const clearPromise = clearStoredWallet(store);

      expect(deleteSpy).not.toHaveBeenCalled();
      releaseGet();

      await expect(createPromise).rejects.toThrow(WalletStorageError);
      await expect(clearPromise).resolves.toBeUndefined();
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(await getStoredWallet(store)).toBeNull();
    });

    it("serializes multiple concurrent clearStoredWallet calls cleanly on both custom and default stores", async () => {
      const inner = new InMemoryKeyStore();
      let releaseSet!: () => void;
      const setGate = new Promise<void>((resolve) => {
        releaseSet = resolve;
      });
      const deleteSpy = vi.fn((key: string) => inner.deleteItem(key));

      const store: vaultKeyProvider.SecureKeyStore = {
        getItem: (key) => inner.getItem(key),
        setItem: async (key, value) => {
          await setGate;
          return inner.setItem(key, value);
        },
        deleteItem: deleteSpy
      };

      const createPromise = getOrCreatePersistentWallet(store);
      await Promise.resolve();
      const clr1 = clearStoredWallet(store);
      const clr2 = clearStoredWallet(store);

      releaseSet();
      await Promise.all([createPromise, clr1, clr2]);
      expect(deleteSpy).toHaveBeenCalledTimes(2);
      expect(await getStoredWallet(store)).toBeNull();

      // Default store concurrent clears + resetWalletStorageForTesting while clear in flight
      const defaultStore = new InMemoryKeyStore();
      let releaseDefaultDelete!: () => void;
      const defaultDeleteGate = new Promise<void>((resolve) => {
        releaseDefaultDelete = resolve;
      });
      let firstDelete = true;
      const platformStoreWithSlowDelete: vaultKeyProvider.SecureKeyStore = {
        getItem: (key) => defaultStore.getItem(key),
        setItem: (key, value) => defaultStore.setItem(key, value),
        deleteItem: async (key) => {
          if (firstDelete) {
            firstDelete = false;
            await defaultDeleteGate;
          }
          return defaultStore.deleteItem(key);
        }
      };
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockResolvedValue(
        platformStoreWithSlowDelete
      );

      const dclr1 = clearStoredWallet();
      const dclr2 = clearStoredWallet();
      releaseDefaultDelete();
      await Promise.all([dclr1, dclr2]);

      // Reset while a default clear is in flight covers both queued and post-await paths
      let releaseResetCreate!: (store: InMemoryKeyStore) => void;
      const resetCreateGate = new Promise<InMemoryKeyStore>((resolve) => {
        releaseResetCreate = resolve;
      });
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockReturnValueOnce(
        resetCreateGate
      );
      const queuedCreate = getOrCreatePersistentWallet();
      const inflightClear = clearStoredWallet();
      resetWalletStorageForTesting();
      releaseResetCreate(defaultStore);
      await expect(queuedCreate).resolves.toBeInstanceOf(Wallet);
      await expect(inflightClear).resolves.toBeUndefined();
    });

    it("enforces strict FIFO order for clear1 -> create -> clear2 on custom SecureKeyStore (O-9)", async () => {
      const inner = new InMemoryKeyStore();
      const ops: string[] = [];
      let releaseFirstDelete!: () => void;
      const firstDeleteGate = new Promise<void>((resolve) => {
        releaseFirstDelete = resolve;
      });
      let firstDeleteStarted!: () => void;
      const onFirstDeleteStarted = new Promise<void>((resolve) => {
        firstDeleteStarted = resolve;
      });
      let deleteCount = 0;

      const store: vaultKeyProvider.SecureKeyStore = {
        async getItem(key: string): Promise<string | null> {
          ops.push("getItem");
          return inner.getItem(key);
        },
        async setItem(key: string, value: string): Promise<void> {
          ops.push("setItem");
          return inner.setItem(key, value);
        },
        async deleteItem(key: string): Promise<void> {
          deleteCount += 1;
          ops.push(`deleteItem#${deleteCount}`);
          if (deleteCount === 1) {
            firstDeleteStarted();
            await firstDeleteGate;
          }
          return inner.deleteItem(key);
        }
      };

      const clear1 = clearStoredWallet(store);
      await onFirstDeleteStarted;

      const create = getOrCreatePersistentWallet(store);
      const clear2 = clearStoredWallet(store);

      // Neither create nor clear2 may jump ahead while clear1 is still deleting
      await Promise.resolve();
      await Promise.resolve();
      expect(ops).toEqual(["deleteItem#1"]);

      releaseFirstDelete();
      const [, created] = await Promise.all([clear1, create, clear2]);

      expect(created).toBeInstanceOf(Wallet);
      expect(ops).toEqual([
        "deleteItem#1",
        "getItem",
        "setItem",
        "getItem",
        "deleteItem#2"
      ]);
      expect(await inner.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(await getStoredWallet(store)).toBeNull();
    });

    it("enforces strict FIFO order for clear1 -> create -> clear2 on default platform keystore and clears cachedWallet (O-9)", async () => {
      const platformStore = new InMemoryKeyStore();
      const ops: string[] = [];
      let releaseFirstDelete!: () => void;
      const firstDeleteGate = new Promise<void>((resolve) => {
        releaseFirstDelete = resolve;
      });
      let firstDeleteStarted!: () => void;
      const onFirstDeleteStarted = new Promise<void>((resolve) => {
        firstDeleteStarted = resolve;
      });
      let deleteCount = 0;

      const wrappedStore: vaultKeyProvider.SecureKeyStore = {
        async getItem(key: string): Promise<string | null> {
          ops.push("getItem");
          return platformStore.getItem(key);
        },
        async setItem(key: string, value: string): Promise<void> {
          ops.push("setItem");
          return platformStore.setItem(key, value);
        },
        async deleteItem(key: string): Promise<void> {
          deleteCount += 1;
          ops.push(`deleteItem#${deleteCount}`);
          if (deleteCount === 1) {
            firstDeleteStarted();
            await firstDeleteGate;
          }
          return platformStore.deleteItem(key);
        }
      };

      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockResolvedValue(
        wrappedStore
      );

      const clear1 = clearStoredWallet();
      await onFirstDeleteStarted;

      const create = getOrCreatePersistentWallet();
      const clear2 = clearStoredWallet();

      await Promise.resolve();
      await Promise.resolve();
      expect(ops).toEqual(["deleteItem#1"]);

      releaseFirstDelete();
      const [, created] = await Promise.all([clear1, create, clear2]);

      expect(ops).toEqual([
        "deleteItem#1",
        "getItem",
        "setItem",
        "getItem",
        "deleteItem#2"
      ]);
      expect(await platformStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(await getStoredWallet()).toBeNull();

      // cachedWallet must also be empty so a subsequent create generates a brand-new address
      const fresh = await getOrCreatePersistentWallet();
      expect(fresh.address).not.toBe(created.address);
      expect(await platformStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        fresh.privateKey
      );
    });

    it("enforces strict FIFO order for create1 -> clear1 -> create2 -> clear2 leaving store and cache empty (O-9)", async () => {
      // Custom store
      const customInner = new InMemoryKeyStore();
      let releaseCustomSet!: () => void;
      const customSetGate = new Promise<void>((resolve) => {
        releaseCustomSet = resolve;
      });
      let setCount = 0;

      const customStore: vaultKeyProvider.SecureKeyStore = {
        getItem: (key) => customInner.getItem(key),
        setItem: async (key, value) => {
          setCount += 1;
          if (setCount === 1) {
            await customSetGate;
          }
          return customInner.setItem(key, value);
        },
        deleteItem: (key) => customInner.deleteItem(key)
      };

      const c1 = getOrCreatePersistentWallet(customStore);
      await Promise.resolve();
      const clr1 = clearStoredWallet(customStore);
      const c2 = getOrCreatePersistentWallet(customStore);
      const clr2 = clearStoredWallet(customStore);

      releaseCustomSet();
      const [w1, , w2] = await Promise.all([c1, clr1, c2, clr2]);

      expect(w2.address).not.toBe(w1.address);
      expect(await customInner.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(await getStoredWallet(customStore)).toBeNull();

      // Default store (also verifies contiguous coalescing before clear2)
      const defaultInner = new InMemoryKeyStore();
      let releaseFirstStore!: (store: InMemoryKeyStore) => void;
      const firstStoreGate = new Promise<InMemoryKeyStore>((resolve) => {
        releaseFirstStore = resolve;
      });
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore")
        .mockReturnValueOnce(firstStoreGate)
        .mockResolvedValue(defaultInner);

      const dc1 = getOrCreatePersistentWallet();
      const dclr1 = clearStoredWallet();
      const dc2a = getOrCreatePersistentWallet();
      const dc2b = getOrCreatePersistentWallet();
      const dclr2 = clearStoredWallet();

      releaseFirstStore(defaultInner);
      const [dw1, , dw2a, dw2b] = await Promise.all([
        dc1,
        dclr1,
        dc2a,
        dc2b,
        dclr2
      ]);

      expect(dw2a.address).not.toBe(dw1.address);
      expect(dw2b).toBe(dw2a);
      expect(await defaultInner.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBeNull();
      expect(await getStoredWallet()).toBeNull();

      const dw3 = await getOrCreatePersistentWallet();
      expect(dw3.address).not.toBe(dw2a.address);
    });
  });
});
