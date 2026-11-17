import { DEFAULT_BASELINE_BIOMETRICS } from "@dehealth/shared";
import { Wallet } from "ethers";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedPressable {
  readonly text: string;
  readonly disabled: boolean;
  readonly onPress?: () => void;
}

const capturedPressables: CapturedPressable[] = [];

function extractText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props.children);
  }
  return "";
}

function cleanProps(props: Record<string, unknown>): Record<string, unknown> {
  const domProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (
      key.startsWith("accessibility") ||
      key === "style" ||
      key === "size" ||
      key === "color"
    ) {
      continue;
    }
    domProps[key] = value;
  }
  return domProps;
}

vi.mock("react-native", () => ({
  ActivityIndicator: (props: Record<string, unknown>) =>
    React.createElement("div", { ...cleanProps(props), "data-spinner": "true" }),
  SafeAreaView: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  View: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  Text: (props: Record<string, unknown>) =>
    React.createElement("span", cleanProps(props), props.children as React.ReactNode),
  Modal: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  Pressable: (props: Record<string, unknown>) => {
    const resolvedChildren =
      typeof props.children === "function"
        ? (props.children as (state: { pressed: boolean }) => React.ReactNode)({
            pressed: false
          })
        : (props.children as React.ReactNode);
    capturedPressables.push({
      text: extractText(resolvedChildren),
      disabled: Boolean(props.disabled),
      onPress: props.onPress as (() => void) | undefined
    });
    return React.createElement("button", cleanProps(props), resolvedChildren);
  },
  ScrollView: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  TextInput: (props: Record<string, unknown>) =>
    React.createElement("input", cleanProps(props)),
  Linking: {
    openURL: vi.fn().mockResolvedValue(true)
  },
  Platform: {
    OS: "web"
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles
  }
}));

import {
  hydrateVaultData,
  resetVaultAndRecover,
  VaultBootGate,
  VaultHydrationDeps
} from "../../App";
import {
  ADAPTIVE_STORAGE_KEYS,
  AdaptiveStorage,
  initializeAdaptiveStorage,
  resetAdaptiveStorage
} from "../storage/adaptiveStorage";
import {
  DEFAULT_GOVERNANCE_CONFIG,
  GOVERNANCE_STORAGE_KEY,
  GovernanceStorage,
  initializeGovernanceStorage,
  resetGovernanceStorage
} from "../storage/governanceStorage";
import { KeyValueStorageBackend } from "../storage/encryptedStorageAdapter";
import {
  clearVaultSecret,
  InMemoryKeyStore,
  VAULT_SECRET_STORAGE_KEY,
  VaultKeyUnavailableError
} from "../storage/vaultKeyProvider";
import {
  clearStoredWallet,
  getOrCreatePersistentWallet,
  resetWalletStorageForTesting,
  WALLET_PRIVATE_KEY_STORAGE_KEY,
  WalletStorageError
} from "../storage/walletStorage";

class MemoryStorageBackend implements KeyValueStorageBackend {
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

function makeDeps(
  keyStore: InMemoryKeyStore,
  backend: MemoryStorageBackend
): VaultHydrationDeps {
  const ensureStorage = async (): Promise<AdaptiveStorage> =>
    initializeAdaptiveStorage(keyStore, backend);
  const ensureGovStorage = async (): Promise<GovernanceStorage> =>
    initializeGovernanceStorage(keyStore, backend);

  return {
    getUserBiometrics: async () => (await ensureStorage()).getUserBiometrics(),
    getActivePlanCycle: async () => (await ensureStorage()).getActivePlanCycle(),
    getWeightLogs: async () => (await ensureStorage()).getWeightLogs(),
    getOrCreatePersistentWallet: async () => getOrCreatePersistentWallet(keyStore),
    getDailyProofSignedMap: async () =>
      (await ensureStorage()).getDailyProofSignedMap(),
    getGovernanceConfig: async () =>
      (await ensureGovStorage()).getGovernanceConfig(),
    clearStoredWallet: async () => clearStoredWallet(keyStore),
    clearVaultSecret: async () => clearVaultSecret(keyStore),
    purgeAdaptiveStorageKeys: async () => {
      for (const key of Object.values(ADAPTIVE_STORAGE_KEYS)) {
        await backend.removeItem(key);
      }
      resetAdaptiveStorage();
    },
    purgeGovernanceStorageKey: async () => {
      await backend.removeItem(GOVERNANCE_STORAGE_KEY);
      resetGovernanceStorage();
    }
  };
}

describe("App boot hydration error surface and vault reset recovery", () => {
  beforeEach(() => {
    capturedPressables.length = 0;
    resetAdaptiveStorage();
    resetGovernanceStorage();
    resetWalletStorageForTesting();
  });

  describe("VaultBootGate UI (non-destructive retry + confirmed reset)", () => {
    it("renders loading spinner and Securing Cryptographic Enclave... when initError is null", () => {
      const markup = renderToStaticMarkup(
        React.createElement(VaultBootGate, {
          initError: null,
          onRetry: vi.fn(),
          onResetVault: vi.fn()
        })
      );

      expect(markup).toContain("Securing Cryptographic Enclave...");
      expect(markup).not.toContain("Reset Vault (Erases Wallet)");
    });

    it("renders primary Retry button (non-destructive) and secondary Reset Vault (Erases Wallet) button without triggering reset immediately", () => {
      const onRetry = vi.fn();
      const onReset = vi.fn();
      const errorMessage =
        "Stored wallet private key is malformed; refusing to open wallet to prevent fund loss.";

      const markup = renderToStaticMarkup(
        React.createElement(VaultBootGate, {
          initError: errorMessage,
          onRetry,
          onResetVault: onReset
        })
      );

      expect(markup).toContain("Cryptographic Enclave Error");
      expect(markup).toContain(errorMessage);
      expect(markup).toContain("Retry");
      expect(markup).toContain("Reset Vault (Erases Wallet)");
      expect(markup).not.toContain("Confirm Reset Vault");
      expect(markup).not.toContain("Securing Cryptographic Enclave...");

      const retryBtn = capturedPressables.find((p) => p.text === "Retry");
      expect(retryBtn).toBeDefined();
      expect(retryBtn?.disabled).toBe(false);
      retryBtn?.onPress?.();
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onReset).not.toHaveBeenCalled();

      // Clicking "Reset Vault (Erases Wallet)" does NOT call onReset immediately; it enters confirmReset
      const resetGateBtn = capturedPressables.find((p) =>
        p.text.includes("Reset Vault (Erases Wallet)")
      );
      expect(resetGateBtn).toBeDefined();
      expect(resetGateBtn?.disabled).toBe(false);
      resetGateBtn?.onPress?.();
      expect(onReset).not.toHaveBeenCalled();
    });

    it("renders explicit private-key erasure warning with Confirm Reset Vault & Cancel when confirmReset is active", () => {
      const onRetry = vi.fn();
      const onReset = vi.fn();

      const markup = renderToStaticMarkup(
        React.createElement(VaultBootGate, {
          initError: "Keystore temporarily locked",
          onRetry,
          onResetVault: onReset,
          initialConfirmReset: true
        })
      );

      expect(markup).toContain("permanently erases any unbacked-up private key");
      expect(markup).toContain("Confirm Reset Vault");
      expect(markup).toContain("Cancel");

      const confirmBtn = capturedPressables.find((p) =>
        p.text.includes("Confirm Reset Vault")
      );
      expect(confirmBtn).toBeDefined();
      expect(confirmBtn?.disabled).toBe(false);
      confirmBtn?.onPress?.();
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it("disables actions while retrying or resetting is in progress", () => {
      const retryingMarkup = renderToStaticMarkup(
        React.createElement(VaultBootGate, {
          initError: "Transient lock",
          isRetrying: true,
          onRetry: vi.fn(),
          onResetVault: vi.fn()
        })
      );
      expect(retryingMarkup).toContain("Retrying...");
      const retryingBtn = capturedPressables.find((p) => p.text === "Retrying...");
      expect(retryingBtn?.disabled).toBe(true);

      capturedPressables.length = 0;
      const resettingMarkup = renderToStaticMarkup(
        React.createElement(VaultBootGate, {
          initError: "Vault MAC check failed",
          isResetting: true,
          initialConfirmReset: true,
          onRetry: vi.fn(),
          onResetVault: vi.fn()
        })
      );

      expect(resettingMarkup).toContain("Resetting Vault...");
      const confirmBtn = capturedPressables.find((p) =>
        p.text.includes("Resetting Vault...")
      );
      expect(confirmBtn?.disabled).toBe(true);
    });
  });

  describe("hydrateVaultData & resetVaultAndRecover", () => {
    it("surfaces WalletStorageError on malformed wallet key and recovers cleanly via resetVaultAndRecover", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryStorageBackend();
      await keyStore.setItem(WALLET_PRIVATE_KEY_STORAGE_KEY, "corrupted_wallet_key");

      const deps = makeDeps(keyStore, backend);

      await expect(hydrateVaultData(deps)).rejects.toThrow(WalletStorageError);
      // Fail-closed: corrupt key was not silently overwritten
      expect(await keyStore.getItem(WALLET_PRIVATE_KEY_STORAGE_KEY)).toBe(
        "corrupted_wallet_key"
      );

      const recovered = await resetVaultAndRecover(deps);
      expect(recovered.persistentWallet).toBeInstanceOf(Wallet);
      expect(recovered.storedBio).toBeNull();
      expect(recovered.proofSignedMap).toEqual({});
    });

    it("surfaces VaultKeyUnavailableError on malformed vault secret and recovers cleanly via resetVaultAndRecover", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryStorageBackend();
      await keyStore.setItem(VAULT_SECRET_STORAGE_KEY, "not-a-valid-32-byte-secret");

      const deps = makeDeps(keyStore, backend);

      await expect(hydrateVaultData(deps)).rejects.toThrow(
        VaultKeyUnavailableError
      );

      const recovered = await resetVaultAndRecover(deps);
      expect(recovered.persistentWallet).toBeInstanceOf(Wallet);
      expect(await keyStore.getItem(VAULT_SECRET_STORAGE_KEY)).toMatch(
        /^0x[0-9a-f]{64}$/
      );
    });

    it("surfaces tampered encrypted storage MAC error and purges adaptive keys on resetVaultAndRecover", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryStorageBackend();
      const storage = await initializeAdaptiveStorage(keyStore, backend);
      await storage.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);

      const raw = backend.items.get(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS)!;
      const envelope = JSON.parse(raw) as { ciphertext: string };
      const lastTwo = envelope.ciphertext.slice(-2);
      envelope.ciphertext =
        envelope.ciphertext.slice(0, -2) + (lastTwo === "99" ? "88" : "99");
      backend.items.set(
        ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS,
        JSON.stringify(envelope)
      );
      resetAdaptiveStorage();

      const deps = makeDeps(keyStore, backend);

      await expect(hydrateVaultData(deps)).rejects.toThrow(/tampering detected/i);

      const recovered = await resetVaultAndRecover(deps);
      expect(recovered.persistentWallet).toBeInstanceOf(Wallet);
      expect(recovered.storedBio).toBeNull();
      expect(recovered.governanceConfig).toEqual(DEFAULT_GOVERNANCE_CONFIG);
    });
  });
});
