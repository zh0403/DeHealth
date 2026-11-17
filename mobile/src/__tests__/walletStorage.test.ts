import { Wallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  });

  describe("getStoredWallet & exportWalletPrivateKey", () => {
    it("returns null if no wallet has been initialized in storage", async () => {
      const store = new InMemoryKeyStore();
      const stored = await getStoredWallet(store);
      expect(stored).toBeNull();
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

    it("clears stored wallet on request", async () => {
      const store = new InMemoryKeyStore();
      await getOrCreatePersistentWallet(store);
      expect(await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).not.toBeNull();

      await clearStoredWallet(store);
      expect(await store.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe("");
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
  });
});
