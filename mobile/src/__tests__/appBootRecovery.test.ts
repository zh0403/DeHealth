import {
  Address,
  AuthSessionMetadata,
  DEFAULT_BASELINE_BIOMETRICS
} from "@dehealth/shared";
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
  deriveLiveMetricsFromVault,
  hydrateVaultData,
  resetVaultAndRecover,
  VaultBootGate,
  VaultHydrationDeps
} from "../../App";
import {
  AUTH_SESSION_STORAGE_KEY,
  AuthSessionStorage,
  copyTextToClipboard,
  DuplicateCheerError,
  ErrorNoticeModal,
  formatLocalCalendarDateKey,
  initializeAuthSessionStorage,
  InsufficientGasError,
  LoginScreen,
  normalizeSenderPseudonym,
  PlanPreviewModal,
  purgeDailyEphemeralLogBuffer,
  resetAuthSessionStorage,
  rolloverStaleDailyEphemeralLogBuffer,
  signInWithGoogle,
  signInWithMetaMask,
  signInWithWalletConnect,
  signOutSession,
  startLocalSession,
  toErrorNoticePayload
} from "../index";
import { generate14DayPlan } from "../services/adaptivePlanEngine";
import { makeDailyProofSignedKey } from "../storage/adaptiveStorage";
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
  const ensureAuthStorage = async (): Promise<AuthSessionStorage> =>
    initializeAuthSessionStorage(keyStore, backend);

  return {
    getUserBiometrics: async () => (await ensureStorage()).getUserBiometrics(),
    getActivePlanCycle: async () => (await ensureStorage()).getActivePlanCycle(),
    getWeightLogs: async () => (await ensureStorage()).getWeightLogs(),
    getOrCreatePersistentWallet: async () => getOrCreatePersistentWallet(keyStore),
    getDailyProofSignedMap: async () =>
      (await ensureStorage()).getDailyProofSignedMap(),
    getGovernanceConfig: async () =>
      (await ensureGovStorage()).getGovernanceConfig(),
    getPersistedAuthSession: async () =>
      (await ensureAuthStorage()).getPersistedAuthSession(),
    rolloverStaleDailyEphemeralLogBuffer: async (todayDateKey?: string) =>
      (await ensureStorage()).rolloverStaleDailyEphemeralLogBuffer(todayDateKey),
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
    },
    purgeAuthSessionStorageKey: async () => {
      await backend.removeItem(AUTH_SESSION_STORAGE_KEY);
      resetAuthSessionStorage();
    }
  };
}

describe("App boot hydration error surface and vault reset recovery", () => {
  beforeEach(() => {
    capturedPressables.length = 0;
    resetAdaptiveStorage();
    resetGovernanceStorage();
    resetAuthSessionStorage();
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

  describe("deriveLiveMetricsFromVault and barrel exports", () => {
    it("derives zero streak, 0.0 DHT balance, and null lastLogTimestampMs on a fresh cycle without mock defaults", () => {
      const startMs = Date.UTC(2026, 10, 10, 8, 0, 0);
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, startMs);

      const metrics = deriveLiveMetricsFromVault(cycle, {}, startMs);
      expect(metrics.streakCount).toBe(0);
      expect(metrics.fallbackBalanceDht).toBe("0.0");
      expect(metrics.lastLogTimestampMs).toBeNull();
    });

    it("derives live streak, DHT balance, and latest signed day timestamp from proofSignedMap", () => {
      const startMs = Date.UTC(2026, 10, 10, 8, 0, 0);
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, startMs);
      const day2NowMs = startMs + 2 * 24 * 60 * 60 * 1000;

      const signedMap: Record<string, boolean> = {
        [makeDailyProofSignedKey(cycle.id, 0)]: true,
        [makeDailyProofSignedKey(cycle.id, 1)]: true,
        [makeDailyProofSignedKey(cycle.id, 2)]: true
      };

      const metrics = deriveLiveMetricsFromVault(cycle, signedMap, day2NowMs);
      expect(metrics.streakCount).toBe(3);
      expect(metrics.fallbackBalanceDht).toBe("30.0");
      expect(metrics.lastLogTimestampMs).toBe(
        Date.parse(`${cycle.dailyPlans[2]!.date}T00:00:00.000Z`)
      );
    });

    it("exports ErrorNoticeModal, toErrorNoticePayload, and InsufficientGasError from mobile/src/index.ts", () => {
      expect(typeof ErrorNoticeModal).toBe("function");
      expect(typeof toErrorNoticePayload).toBe("function");
      expect(typeof InsufficientGasError).toBe("function");
    });

    it("exports the auth, clipboard and buffer modules from mobile/src/index.ts without collisions", () => {
      expect(typeof copyTextToClipboard).toBe("function");
      expect(typeof signInWithGoogle).toBe("function");
      expect(typeof startLocalSession).toBe("function");
      expect(typeof signInWithMetaMask).toBe("function");
      expect(typeof signInWithWalletConnect).toBe("function");
      expect(typeof signOutSession).toBe("function");
      expect(typeof LoginScreen).toBe("function");
      expect(typeof PlanPreviewModal).toBe("function");
      expect(typeof DuplicateCheerError).toBe("function");
      expect(typeof normalizeSenderPseudonym).toBe("function");
      expect(typeof rolloverStaleDailyEphemeralLogBuffer).toBe("function");
      expect(typeof purgeDailyEphemeralLogBuffer).toBe("function");
    });
  });

  describe("Auth session hydration & signOutSession vault preservation", () => {
    it("hydrates persisted AuthSessionMetadata cleanly and clears only session on signOutSession without touching biometrics", async () => {
      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryStorageBackend();
      const adaptiveStorage = await initializeAdaptiveStorage(keyStore, backend);
      const authStorage = await initializeAuthSessionStorage(keyStore, backend);

      const wallet = await getOrCreatePersistentWallet(keyStore);
      await adaptiveStorage.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);

      const session: AuthSessionMetadata = {
        authMethod: "local",
        accountId: `local:${wallet.address.toLowerCase()}`,
        displayLabel: `Local Session (${wallet.address.slice(0, 6)}\u2026${wallet.address.slice(-4)})`,
        walletAddress: wallet.address as Address,
        signedInAtMs: 1_700_000_000_000
      };
      await authStorage.savePersistedAuthSession(session);

      const deps = makeDeps(keyStore, backend);
      const hydrated = await hydrateVaultData(deps);
      expect(hydrated.storedAuthSession).toEqual(session);
      expect(hydrated.storedBio).toEqual(DEFAULT_BASELINE_BIOMETRICS);
      expect(hydrated.persistentWallet.address).toBe(wallet.address);

      await signOutSession({ storage: authStorage });
      expect(await authStorage.getPersistedAuthSession()).toBeNull();

      const afterSignOut = await hydrateVaultData(deps);
      expect(afterSignOut.storedAuthSession).toBeNull();
      expect(afterSignOut.storedBio).toEqual(DEFAULT_BASELINE_BIOMETRICS);
      expect(afterSignOut.persistentWallet.address).toBe(wallet.address);

      // Stale prior-day ephemeral buffer auto-purges on hydrateVaultData rollover
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, Date.now());
      await adaptiveStorage.appendEphemeralFoodLog({
        dateKey: "2020-01-01",
        cycleId: cycle.id,
        dayNumber: 1,
        entry: {
          id: "stale_meal_1",
          presetId: "preset_chicken_breast",
          name: "Chicken Breast",
          grams: 100,
          caloriesKcal: 165,
          proteinGrams: 31,
          carbsGrams: 0,
          fatGrams: 3.6,
          loggedAtMs: 1_577_836_800_000
        }
      });
      const afterRollover = await hydrateVaultData(deps);
      expect(afterRollover.activeEphemeralBuffer).toBeNull();
      expect(await adaptiveStorage.getDailyEphemeralLogBuffer()).toBeNull();
      expect(typeof formatLocalCalendarDateKey()).toBe("string");

      // Full resetVaultAndRecover wipes everything including auth session
      await authStorage.savePersistedAuthSession(session);
      const recovered = await resetVaultAndRecover(deps);
      expect(recovered.storedAuthSession).toBeNull();
      expect(recovered.storedBio).toBeNull();
    });
  });
});
