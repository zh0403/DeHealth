import { DEFAULT_BASELINE_BIOMETRICS, UserProfile } from "@dehealth/shared";
import { beforeEach, describe, expect, it } from "vitest";
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
import {
  DEFAULT_GOVERNANCE_CONFIG,
  getGovernanceConfig,
  getGovernanceStorage,
  GOVERNANCE_STORAGE_KEY,
  GovernanceConfig,
  GovernanceConfigSchema,
  GovernanceStorage,
  initializeGovernanceStorage,
  purgeGovernanceStorageKey,
  resetGovernanceConfig,
  resetGovernanceStorage,
  saveGovernanceConfig,
  setGovernanceStorageAdapter
} from "../storage/governanceStorage";
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

  beforeEach(() => {
    resetGovernanceStorage();
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

      expect(
        GovernanceConfigSchema.parse({
          inactivityThresholdHours: 168,
          fatigueScalingMultiplier: 0.95,
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
          fatigueScalingMultiplier: 0.96
        })
      ).toThrow();
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
  });
});
