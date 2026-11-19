import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_BASELINE_BIOMETRICS, UserProfile } from "@dehealth/shared";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve as resolvePath } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRuntimeFatigueScaling,
  generate14DayPlan,
  scaleExercisesForFatigue
} from "../services/adaptivePlanEngine";
import {
  evaluateDailyTarget,
  scaleTargetForInactivityGap
} from "../services/profileEngine";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../storage/encryptedStorageAdapter";
import * as governanceStorageModule from "../storage/governanceStorage";
import {
  clearGovernancePin,
  DEFAULT_GOVERNANCE_CONFIG,
  getEnvGovernancePin,
  getGovernanceConfig,
  getGovernancePin,
  getGovernanceStorage,
  GOVERNANCE_PIN_PATTERN,
  GOVERNANCE_PIN_STORAGE_KEY,
  GOVERNANCE_STORAGE_KEY,
  GovernanceConfig,
  GovernanceConfigSchema,
  GovernancePinError,
  GovernanceStorage,
  initializeGovernanceStorage,
  isValidUserGovernancePin,
  MAX_FATIGUE_SCALING_MULTIPLIER,
  purgeGovernanceStorageKey,
  resetGovernanceConfig,
  resetGovernanceStorage,
  resolveGovernancePinMode,
  saveGovernanceConfig,
  setGovernancePin,
  setGovernanceStorageAdapter,
  verifyGovernancePin
} from "../storage/governanceStorage";
import * as vaultKeyProvider from "../storage/vaultKeyProvider";
import { InMemoryKeyStore, VaultKeyUnavailableError } from "../storage/vaultKeyProvider";

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

describe("Encrypted Governance Storage & Adaptive Threshold Wiring", () => {
  const testSecret = "0x" + "aa".repeat(32);
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.EXPO_PUBLIC_GOVERNANCE_PIN;
    resetGovernanceStorage();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("GovernanceConfigSchema & Defaults", () => {
    it("exports frozen DEFAULT_GOVERNANCE_CONFIG matching the documented defaults", () => {
      expect(DEFAULT_GOVERNANCE_CONFIG).toEqual({
        inactivityThresholdHours: 48,
        fatigueScalingMultiplier: 0.7,
        dailyStepGoal: 5000
      });
      expect(Object.isFrozen(DEFAULT_GOVERNANCE_CONFIG)).toBe(true);
    });

    it("accepts boundary values and rejects out-of-range or non-integer values", () => {
      expect(
        GovernanceConfigSchema.parse({
          inactivityThresholdHours: 24,
          fatigueScalingMultiplier: 0.5,
          dailyStepGoal: 1000
        })
      ).toBeDefined();

      expect(MAX_FATIGUE_SCALING_MULTIPLIER).toBe(0.85);

      expect(
        GovernanceConfigSchema.parse({
          inactivityThresholdHours: 168,
          fatigueScalingMultiplier: 0.85,
          dailyStepGoal: 30_000
        })
      ).toBeDefined();

      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          inactivityThresholdHours: 23
        })
      ).toThrow();
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          inactivityThresholdHours: 169
        })
      ).toThrow();
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          inactivityThresholdHours: 48.5
        })
      ).toThrow();
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          fatigueScalingMultiplier: 0.49
        })
      ).toThrow();
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          fatigueScalingMultiplier: 0.86
        })
      ).toThrow("Fatigue scaling multiplier cannot exceed 0.85.");
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          fatigueScalingMultiplier: 0.95
        })
      ).toThrow("Fatigue scaling multiplier cannot exceed 0.85.");
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          fatigueScalingMultiplier: Number.POSITIVE_INFINITY
        })
      ).toThrow();
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          dailyStepGoal: 999
        })
      ).toThrow();
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          dailyStepGoal: 30_001
        })
      ).toThrow();
      expect(() =>
        GovernanceConfigSchema.parse({
          ...DEFAULT_GOVERNANCE_CONFIG,
          dailyStepGoal: 5000.5
        })
      ).toThrow();
    });
  });

  describe("GovernanceStorage Encrypted Persistence", () => {
    it("persists and reloads GovernanceConfig encrypted on-device and resets to defaults", async () => {
      const backend = new MemoryBackend();
      const storage = new GovernanceStorage(testSecret, backend);

      expect(await storage.getGovernanceConfig()).toEqual(DEFAULT_GOVERNANCE_CONFIG);

      const custom: GovernanceConfig = {
        inactivityThresholdHours: 72,
        fatigueScalingMultiplier: 0.85,
        dailyStepGoal: 12_000
      };
      await storage.saveGovernanceConfig(custom);

      // Verify raw persisted payload is encrypted (does not leak raw JSON values)
      const rawEnvelope = backend.items.get(GOVERNANCE_STORAGE_KEY);
      expect(rawEnvelope).toBeDefined();
      expect(rawEnvelope).not.toContain("12000");

      expect(await storage.getGovernanceConfig()).toEqual(custom);

      const reset = await storage.resetGovernanceConfig();
      expect(reset).toEqual(DEFAULT_GOVERNANCE_CONFIG);
      expect(await storage.getGovernanceConfig()).toEqual(DEFAULT_GOVERNANCE_CONFIG);
    });

    it("detects MAC tampering in encrypted governance storage and rejects invalid writes", async () => {
      const backend = new MemoryBackend();
      const storage = new GovernanceStorage(testSecret, backend);
      await storage.saveGovernanceConfig({
        inactivityThresholdHours: 36,
        fatigueScalingMultiplier: 0.6,
        dailyStepGoal: 7500
      });

      const raw = backend.items.get(GOVERNANCE_STORAGE_KEY)!;
      const parsed = JSON.parse(raw) as { ciphertext: string };
      parsed.ciphertext =
        parsed.ciphertext.slice(0, -2) +
        (parsed.ciphertext.endsWith("aa") ? "bb" : "aa");
      backend.items.set(GOVERNANCE_STORAGE_KEY, JSON.stringify(parsed));

      await expect(storage.getGovernanceConfig()).rejects.toThrow(/tampering/i);
    });

    it("supports singleton initialization, adapter injection, and vault purge", async () => {
      expect(() => getGovernanceStorage()).toThrow(VaultKeyUnavailableError);

      const keyStore = new InMemoryKeyStore();
      const backend = new MemoryBackend();
      await initializeGovernanceStorage(keyStore, backend);

      await saveGovernanceConfig({
        inactivityThresholdHours: 96,
        fatigueScalingMultiplier: 0.8,
        dailyStepGoal: 8000
      });
      expect(await getGovernanceConfig()).toEqual({
        inactivityThresholdHours: 96,
        fatigueScalingMultiplier: 0.8,
        dailyStepGoal: 8000
      });

      await resetGovernanceConfig();
      expect(await getGovernanceConfig()).toEqual(DEFAULT_GOVERNANCE_CONFIG);

      await saveGovernanceConfig({
        inactivityThresholdHours: 24,
        fatigueScalingMultiplier: 0.55,
        dailyStepGoal: 4000
      });
      await purgeGovernanceStorageKey(backend);
      expect(backend.items.has(GOVERNANCE_STORAGE_KEY)).toBe(false);

      const adapter = new EncryptedStorageAdapter(testSecret, backend);
      setGovernanceStorageAdapter(adapter);
      expect(getGovernanceStorage().getAdapter()).toBe(adapter);
    });

    it("falls back to defaults on invalid stored schema, rejects missing secret in constructor, and handles concurrent initialization", async () => {
      expect(
        () => new GovernanceStorage(undefined as unknown as string)
      ).toThrow(VaultKeyUnavailableError);

      const backend = new MemoryBackend();
      const adapter = new EncryptedStorageAdapter(testSecret, backend);
      await adapter.setEncryptedItem(GOVERNANCE_STORAGE_KEY, {
        inactivityThresholdHours: 9999, // invalid bound
        fatigueScalingMultiplier: 0.7,
        dailyStepGoal: 5000
      });
      const storage = new GovernanceStorage(adapter);
      expect(await storage.getGovernanceConfig()).toEqual(
        DEFAULT_GOVERNANCE_CONFIG
      );

      // Concurrent initialization shares promise and idempotently returns same instance
      const keyStore = new InMemoryKeyStore();
      const [s1, s2] = await Promise.all([
        initializeGovernanceStorage(keyStore, backend),
        initializeGovernanceStorage(keyStore, backend)
      ]);
      expect(s1).toBe(s2);
      expect(await initializeGovernanceStorage(keyStore, backend)).toBe(s1);
    });

    it("auto-initializes via default platform keystore when uninitialized and resets init promise on failure", async () => {
      // Uninitialized getGovernanceConfig resolves default platform keystore
      vi.spyOn(AsyncStorage, "getItem").mockResolvedValueOnce(null);
      const config = await getGovernanceConfig();
      expect(config).toEqual(DEFAULT_GOVERNANCE_CONFIG);

      // Calling initializeGovernanceStorage with no keyStore uses createPlatformKeyStore
      resetGovernanceStorage();
      const autoStorage = await initializeGovernanceStorage(
        undefined,
        new MemoryBackend()
      );
      expect(autoStorage).toBeInstanceOf(GovernanceStorage);

      // Failed initialization clears governanceInitPromise so retry can succeed
      resetGovernanceStorage();
      const failingKeyStore = {
        getItem: async () => {
          throw new Error("Keystore offline");
        },
        setItem: async () => undefined
      };
      await expect(
        initializeGovernanceStorage(failingKeyStore, new MemoryBackend())
      ).rejects.toThrow("Keystore offline");

      // If resetGovernanceStorage() is called before rejection settles, guard skips clearing newer state
      let rejectGet!: (err: Error) => void;
      const deferredRejectStore = {
        getItem: () =>
          new Promise<string | null>((_resolve, reject) => {
            rejectGet = reject;
          }),
        setItem: async () => undefined
      };
      const pendingInit = initializeGovernanceStorage(
        deferredRejectStore,
        new MemoryBackend()
      );
      resetGovernanceStorage();
      rejectGet(new Error("Deferred keystore offline"));
      await expect(pendingInit).rejects.toThrow("Deferred keystore offline");

      // purgeGovernanceStorageKey with default AsyncStorage backend
      const removeSpy = vi
        .spyOn(AsyncStorage, "removeItem")
        .mockResolvedValueOnce(undefined);
      await purgeGovernanceStorageKey();
      expect(removeSpy).toHaveBeenCalledWith(GOVERNANCE_STORAGE_KEY);
    });
  });

  describe("Governance Threshold Wiring into profileEngine & adaptivePlanEngine", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const START_MS = Date.UTC(2026, 10, 1);

    it("applies custom inactivityThresholdHours and fatigueScalingMultiplier in scaleTargetForInactivityGap and evaluateDailyTarget", () => {
      const profile: UserProfile = {
        age: 30,
        gender: "male",
        bodyFatPct: 16,
        muscleMassKg: 35
      };

      // At 30h gap: default 48h does NOT scale, custom 24h DOES scale by 0.50
      const at30hDefault = scaleTargetForInactivityGap(
        8000,
        START_MS,
        START_MS + 30 * HOUR_MS
      );
      expect(at30hDefault.isFatigueScaled).toBe(false);
      expect(at30hDefault.adjustedTarget).toBe(8000);

      const at30hCustom = evaluateDailyTarget(
        profile,
        START_MS,
        START_MS + 30 * HOUR_MS,
        { inactivityThresholdHours: 24, fatigueScalingMultiplier: 0.5 }
      );
      expect(at30hCustom.isFatigueScaled).toBe(true);
      expect(at30hCustom.scalingFactorApplied).toBe(0.5);
      expect(at30hCustom.adjustedSteps).toBe(
        Math.round(at30hCustom.baselineSteps * 0.5)
      );

      // At 60h gap: custom 72h threshold keeps 100% standard target
      const at60h72Threshold = evaluateDailyTarget(
        profile,
        START_MS,
        START_MS + 60 * HOUR_MS,
        { inactivityThresholdHours: 72, fatigueScalingMultiplier: 0.85 }
      );
      expect(at60h72Threshold.isFatigueScaled).toBe(false);
      expect(at60h72Threshold.adjustedSteps).toBe(at60h72Threshold.baselineSteps);
    });

    it("applies custom governance thresholds in applyRuntimeFatigueScaling and scaleExercisesForFatigue", () => {
      const plan = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, START_MS)
        .dailyPlans[0]!;

      // 30h gap with 24h threshold and 0.50x multiplier scales unfinished exercises
      const scaled = applyRuntimeFatigueScaling(
        plan,
        START_MS,
        START_MS + 30 * HOUR_MS,
        { inactivityThresholdHours: 24, fatigueScalingMultiplier: 0.5 }
      );
      expect(scaled.isFatigueScaled).toBe(true);
      scaled.exercises.forEach((ex, idx) => {
        const orig = plan.exercises[idx]!;
        expect(ex.sets).toBe(Math.max(1, Math.round(orig.sets * 0.5)));
      });

      // 60h gap with 72h threshold does NOT scale
      const unscaled = applyRuntimeFatigueScaling(
        plan,
        START_MS,
        START_MS + 60 * HOUR_MS,
        { inactivityThresholdHours: 72, fatigueScalingMultiplier: 0.85 }
      );
      expect(unscaled).toBe(plan);

      const directScaled = scaleExercisesForFatigue(
        plan.exercises,
        true,
        { fatigueScalingMultiplier: 0.5 }
      );
      expect(directScaled[0]!.sets).toBe(
        Math.max(1, Math.round(plan.exercises[0]!.sets * 0.5))
      );
    });

    it("produces an actual integer set reduction for 4-set workouts and daily targets at max 0.85 multiplier (O-7)", () => {
      const plan = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, START_MS)
        .dailyPlans[0]!;
      expect(plan.exercises[0]!.sets).toBe(4);

      const scaledAtMax = applyRuntimeFatigueScaling(
        plan,
        START_MS,
        START_MS + 49 * HOUR_MS,
        {
          inactivityThresholdHours: 48,
          fatigueScalingMultiplier: MAX_FATIGUE_SCALING_MULTIPLIER
        }
      );
      expect(scaledAtMax.isFatigueScaled).toBe(true);
      expect(scaledAtMax.exercises[0]!.sets).toBe(3);
      expect(scaledAtMax.exercises[0]!.sets).toBeLessThan(
        plan.exercises[0]!.sets
      );

      const profile: UserProfile = {
        age: 30,
        gender: "male",
        bodyFatPct: 16,
        muscleMassKg: 35
      };
      const targetAtMax = evaluateDailyTarget(
        profile,
        START_MS,
        START_MS + 49 * HOUR_MS,
        {
          inactivityThresholdHours: 48,
          fatigueScalingMultiplier: MAX_FATIGUE_SCALING_MULTIPLIER
        }
      );
      expect(targetAtMax.isFatigueScaled).toBe(true);
      expect(targetAtMax.adjustedSteps).toBeLessThan(targetAtMax.baselineSteps);
      expect(targetAtMax.adjustedActiveMinutes).toBeLessThan(
        targetAtMax.baselineActiveMinutes
      );
    });
  });

  describe("Governance PIN Resolution, SecureStore Persistence & Env Override (R4)", () => {
    const legacyHardcodedPin = "2026" + "04";
    const legacyConstantName = "DEFAULT_GOVERNANCE_" + "PIN";

    it("removes the legacy hardcoded PIN constant from governanceStorage and all mobile source files", () => {
      expect(legacyConstantName in governanceStorageModule).toBe(false);

      const mobileRoot = resolvePath(__dirname, "../..");
      const srcRoot = resolvePath(mobileRoot, "src");
      const filesToScan: string[] = [resolvePath(mobileRoot, "App.tsx")];

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = resolvePath(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
            filesToScan.push(full);
          }
        }
      };
      walk(srcRoot);

      const offenders: string[] = [];
      for (const filePath of filesToScan) {
        const content = readFileSync(filePath, "utf8");
        if (
          content.includes(legacyHardcodedPin) ||
          content.includes(legacyConstantName)
        ) {
          offenders.push(filePath);
        }
      }

      expect(offenders).toEqual([]);
    });

    it("resolves EXPO_PUBLIC_GOVERNANCE_PIN override cleanly and treats unset or blank values as null", () => {
      expect(getEnvGovernancePin()).toBeNull();

      process.env.EXPO_PUBLIC_GOVERNANCE_PIN = "";
      expect(getEnvGovernancePin()).toBeNull();

      process.env.EXPO_PUBLIC_GOVERNANCE_PIN = "   ";
      expect(getEnvGovernancePin()).toBeNull();

      process.env.EXPO_PUBLIC_GOVERNANCE_PIN = "  739152  ";
      expect(getEnvGovernancePin()).toBe("739152");
    });

    it("validates user-created governance PINs strictly as 4 to 8 digits", () => {
      expect(GOVERNANCE_PIN_PATTERN.test("1234")).toBe(true);
      expect(GOVERNANCE_PIN_PATTERN.test("12345678")).toBe(true);

      expect(isValidUserGovernancePin("1234")).toBe(true);
      expect(isValidUserGovernancePin("482910")).toBe(true);
      expect(isValidUserGovernancePin("12345678")).toBe(true);

      expect(isValidUserGovernancePin("")).toBe(false);
      expect(isValidUserGovernancePin("123")).toBe(false);
      expect(isValidUserGovernancePin("123456789")).toBe(false);
      expect(isValidUserGovernancePin("12ab")).toBe(false);
      expect(isValidUserGovernancePin(" 1234 ")).toBe(false);
      expect(isValidUserGovernancePin(null as unknown as string)).toBe(false);
    });

    it("reports unset mode and rejects any candidate PIN when neither .env nor SecureStore has a PIN", async () => {
      const keyStore = new InMemoryKeyStore();

      expect(await resolveGovernancePinMode(keyStore)).toBe("unset");
      expect(await getGovernancePin(keyStore)).toBeNull();
      expect(await verifyGovernancePin(legacyHardcodedPin, keyStore)).toBe(false);
      expect(await verifyGovernancePin("", keyStore)).toBe(false);
      expect(await verifyGovernancePin("   ", keyStore)).toBe(false);
      expect(await verifyGovernancePin(null as unknown as string, keyStore)).toBe(
        false
      );
      expect(await verifyGovernancePin("000000", keyStore)).toBe(false);
    });

    it("persists a user-created 4-8 digit PIN in SecureKeyStore with read-back verification and clears it on teardown", async () => {
      const keyStore = new InMemoryKeyStore();

      const saved = await setGovernancePin(" 849201 ", keyStore);
      expect(saved).toBe("849201");
      expect(await keyStore.getItem(GOVERNANCE_PIN_STORAGE_KEY)).toBe("849201");
      expect(await resolveGovernancePinMode(keyStore)).toBe("secure-store");
      expect(await getGovernancePin(keyStore)).toBe("849201");

      expect(await verifyGovernancePin("849201", keyStore)).toBe(true);
      expect(await verifyGovernancePin(" 849201 ", keyStore)).toBe(true);
      expect(await verifyGovernancePin(legacyHardcodedPin, keyStore)).toBe(false);
      expect(await verifyGovernancePin("000000", keyStore)).toBe(false);

      await clearGovernancePin(keyStore);
      expect(await keyStore.getItem(GOVERNANCE_PIN_STORAGE_KEY)).toBeNull();
      expect(await resolveGovernancePinMode(keyStore)).toBe("unset");
      expect(await getGovernancePin(keyStore)).toBeNull();
    });

    it("stores the PIN under the documented SecureKeyStore key", async () => {
      expect(GOVERNANCE_PIN_STORAGE_KEY).toBe("dehealth.governance.pin.v1");
      const keyStore = new InMemoryKeyStore();
      await setGovernancePin("135790", keyStore);
      expect(await keyStore.getItem("dehealth.governance.pin.v1")).toBe("135790");
    });

    it("rejects invalid PIN formats and failed read-back persistence without mutating SecureKeyStore", async () => {
      const keyStore = new InMemoryKeyStore();

      await expect(setGovernancePin("123", keyStore)).rejects.toThrow(
        GovernancePinError
      );
      await expect(setGovernancePin("123456789", keyStore)).rejects.toThrow(
        GovernancePinError
      );
      await expect(setGovernancePin("abcd", keyStore)).rejects.toThrow(
        GovernancePinError
      );
      await expect(
        setGovernancePin(1234 as unknown as string, keyStore)
      ).rejects.toThrow(GovernancePinError);
      expect(await keyStore.getItem(GOVERNANCE_PIN_STORAGE_KEY)).toBeNull();

      const brokenWriteStore = {
        getItem: async () => "9999",
        setItem: async () => undefined
      };
      await expect(setGovernancePin("482910", brokenWriteStore)).rejects.toThrow(
        GovernancePinError
      );
    });

    it("fails closed when SecureKeyStore contains a malformed PIN and never falls back to unset", async () => {
      const keyStore = new InMemoryKeyStore();
      await keyStore.setItem(GOVERNANCE_PIN_STORAGE_KEY, "bad-pin");

      await expect(resolveGovernancePinMode(keyStore)).rejects.toThrow(
        GovernancePinError
      );
      await expect(getGovernancePin(keyStore)).rejects.toThrow(
        GovernancePinError
      );
      await expect(verifyGovernancePin("1234", keyStore)).rejects.toThrow(
        GovernancePinError
      );
    });

    it("honours EXPO_PUBLIC_GOVERNANCE_PIN override over SecureKeyStore and falls back when blank", async () => {
      const keyStore = new InMemoryKeyStore();
      await setGovernancePin("482910", keyStore);

      process.env.EXPO_PUBLIC_GOVERNANCE_PIN = " 739152 ";
      expect(await resolveGovernancePinMode(keyStore)).toBe("env");
      expect(await getGovernancePin(keyStore)).toBe("739152");
      expect(await verifyGovernancePin("739152", keyStore)).toBe(true);
      expect(await verifyGovernancePin("482910", keyStore)).toBe(false);
      expect(await verifyGovernancePin(legacyHardcodedPin, keyStore)).toBe(false);

      // Blank .env falls back to SecureKeyStore
      process.env.EXPO_PUBLIC_GOVERNANCE_PIN = "   ";
      expect(await resolveGovernancePinMode(keyStore)).toBe("secure-store");
      expect(await getGovernancePin(keyStore)).toBe("482910");
      expect(await verifyGovernancePin("482910", keyStore)).toBe(true);
    });

    it("wraps VaultKeyUnavailableError into GovernancePinError, propagates unexpected keystore errors, and clears safely when deleteItem is absent or fails", async () => {
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockRejectedValueOnce(
        new VaultKeyUnavailableError("Secure keystore offline")
      );
      await expect(resolveGovernancePinMode()).rejects.toThrow(
        GovernancePinError
      );

      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockRejectedValueOnce(
        new Error("Unexpected hardware fault")
      );
      await expect(getGovernancePin()).rejects.toThrow(
        "Unexpected hardware fault"
      );

      // Default platform keystore resolution when keyStore is omitted
      const defaultStore = new InMemoryKeyStore();
      vi.spyOn(vaultKeyProvider, "createPlatformKeyStore").mockResolvedValue(
        defaultStore
      );
      expect(await resolveGovernancePinMode()).toBe("unset");
      await setGovernancePin("5566");
      expect(await verifyGovernancePin("5566")).toBe(true);
      await clearGovernancePin();
      expect(await resolveGovernancePinMode()).toBe("unset");

      // clearGovernancePin handles stores without deleteItem and throwing deleteItem gracefully
      await clearGovernancePin({
        getItem: async () => null,
        setItem: async () => undefined
      });
      await clearGovernancePin({
        getItem: async () => null,
        setItem: async () => undefined,
        deleteItem: async () => {
          throw new Error("Teardown error");
        }
      });
    });
  });
});
