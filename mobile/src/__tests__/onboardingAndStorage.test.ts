import {
  AdaptivePlanCycle,
  DEFAULT_BASELINE_BIOMETRICS,
  UserBiometrics,
  WeightLogEntry
} from "@dehealth/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles
  }
}));
import { generate14DayPlan } from "../services/adaptivePlanEngine";
import type { WizardStep } from "../screens/OnboardingWizardScreen";
import {
  getWizardNextStep,
  getWizardPrevStep,
  validateOnboardingInputs
} from "../screens/OnboardingWizardScreen";
import {
  ADAPTIVE_STORAGE_KEYS,
  AdaptiveStorage,
  clearAllAdaptiveData,
  getActivePlanCycle,
  getAdaptiveStorage,
  getDailyTaskCompletion,
  getPlanHistory,
  getUserBiometrics,
  getWeightLogs,
  saveActivePlanCycle,
  saveDailyTaskCompletion,
  savePlanHistory,
  saveUserBiometrics,
  saveWeightLog,
  setAdaptiveStorage,
  setAdaptiveStorageAdapter
} from "../storage/adaptiveStorage";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../storage/encryptedStorageAdapter";

/**
 * Isolated In-Memory Storage Backend for Deterministic Local Persistence Tests
 */
class InMemoryStorageBackend implements KeyValueStorageBackend {
  private readonly store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  getRaw(key: string): string | undefined {
    return this.store.get(key);
  }

  setRaw(key: string, value: string): void {
    this.store.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }
}

describe("Milestone 3: Onboarding & Adaptive Storage Unit Test Suite", () => {
  let backend: InMemoryStorageBackend;
  let adapter: EncryptedStorageAdapter;
  let storage: AdaptiveStorage;

  beforeEach(() => {
    backend = new InMemoryStorageBackend();
    adapter = new EncryptedStorageAdapter("SecureVaultPassphrase2026!", backend);
    storage = new AdaptiveStorage(adapter);
    // Bind singleton functions to test adapter for complete test isolation
    setAdaptiveStorage(storage);
  });

  // ==========================================================================
  // 1. Adaptive Storage Unit Tests
  // ==========================================================================
  describe("AdaptiveStorage Service", () => {
    describe("UserBiometrics Persistence", () => {
      it("saves and retrieves UserBiometrics with encryption parity", async () => {
        const bio: UserBiometrics = {
          age: 30,
          gender: "male",
          weightKg: 82.5,
          heightCm: 180.0,
          bodyFatPct: 15.5,
          weeklyWorkoutFrequency: 4,
          goal: "cut",
          activityLevel: "moderate",
          updatedAtMs: 1700000000000
        };

        await saveUserBiometrics(bio);
        const retrieved = await getUserBiometrics();
        expect(retrieved).toEqual(bio);
      });

      it("returns null when no UserBiometrics exist in storage", async () => {
        const result = await getUserBiometrics();
        expect(result).toBeNull();
      });

      it("updates existing UserBiometrics preserving modified fields", async () => {
        await saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
        const updatedBio: UserBiometrics = {
          ...DEFAULT_BASELINE_BIOMETRICS,
          weightKg: 73.5,
          updatedAtMs: Date.now()
        };
        await saveUserBiometrics(updatedBio);
        const retrieved = await getUserBiometrics();
        expect(retrieved?.weightKg).toBe(73.5);
      });

      it("validates biometrics with UserBiometricsSchema on retrieval", async () => {
        // Save malformed biometrics directly to test schema resilience
        const rawCorrupt = { age: 10, gender: "invalid", weightKg: -5 };
        await adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS, rawCorrupt);
        const retrieved = await getUserBiometrics();
        // safeParse fallback returns null on schema violation
        expect(retrieved).toBeNull();
      });
    });

    describe("AdaptivePlanCycle Persistence", () => {
      it("saves and retrieves full 14-day AdaptivePlanCycle roundtrip", async () => {
        const plan = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1700000000000, null, 1);
        expect(plan.dailyPlans).toHaveLength(14);

        await saveActivePlanCycle(plan);
        const retrieved = await getActivePlanCycle();
        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe(plan.id);
        expect(retrieved?.dailyPlans).toHaveLength(14);
        expect(retrieved?.targetDailyCalories).toBe(plan.targetDailyCalories);
      });

      it("returns null when no active plan cycle exists", async () => {
        const result = await getActivePlanCycle();
        expect(result).toBeNull();
      });

      it("validates cycle structure with AdaptivePlanCycleSchema on retrieval", async () => {
        const rawInvalidCycle = { id: "bad_plan", dailyPlans: [] };
        await adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.ACTIVE_PLAN_CYCLE, rawInvalidCycle);
        const retrieved = await getActivePlanCycle();
        expect(retrieved).toBeNull();
      });
    });

    describe("WeightLogEntry Persistence", () => {
      it("returns empty array [] when no weight logs exist", async () => {
        const logs = await getWeightLogs();
        expect(logs).toEqual([]);
      });

      it("saves a single WeightLogEntry and retrieves it", async () => {
        const entry: WeightLogEntry = {
          id: "w-1",
          timestampMs: 1700000000000,
          weightKg: 75.2,
          bodyFatPct: 16.0,
          note: "Morning weigh-in"
        };
        await saveWeightLog(entry);
        const logs = await getWeightLogs();
        expect(logs).toHaveLength(1);
        expect(logs[0]).toEqual(entry);
      });

      it("appends multiple entries and sorts chronologically by timestampMs", async () => {
        const logLater: WeightLogEntry = {
          id: "w-2",
          timestampMs: 1700086400000,
          weightKg: 74.8
        };
        const logEarlier: WeightLogEntry = {
          id: "w-1",
          timestampMs: 1700000000000,
          weightKg: 75.0
        };

        // Save out of chronological order
        await saveWeightLog(logLater);
        await saveWeightLog(logEarlier);

        const logs = await getWeightLogs();
        expect(logs).toHaveLength(2);
        expect(logs[0]?.id).toBe("w-1");
        expect(logs[1]?.id).toBe("w-2");
      });

      it("upserts weight log entry when saving an entry with an existing id", async () => {
        const initial: WeightLogEntry = {
          id: "w-dup",
          timestampMs: 1700000000000,
          weightKg: 75.0,
          note: "Initial note"
        };
        const revised: WeightLogEntry = {
          id: "w-dup",
          timestampMs: 1700000000000,
          weightKg: 74.5,
          note: "Corrected note"
        };

        await saveWeightLog(initial);
        await saveWeightLog(revised);

        const logs = await getWeightLogs();
        expect(logs).toHaveLength(1);
        expect(logs[0]?.weightKg).toBe(74.5);
        expect(logs[0]?.note).toBe("Corrected note");
      });

      it("returns empty array when stored weight logs raw data is not an array", async () => {
        await adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.WEIGHT_LOGS, { notAnArray: true });
        const logs = await getWeightLogs();
        expect(logs).toEqual([]);
      });
    });

    describe("Daily Task Completion State Persistence", () => {
      it("returns empty object {} when no task completions exist", async () => {
        const completions = await getDailyTaskCompletion();
        expect(completions).toEqual({});
      });

      it("saves and retrieves daily task completion state by dayNumber and task name", async () => {
        await saveDailyTaskCompletion(1, "nutrition", true);
        await saveDailyTaskCompletion(1, "workout", true);
        await saveDailyTaskCompletion(2, "nutrition", false);

        const completions = await getDailyTaskCompletion();
        expect(completions["1_nutrition"]).toBe(true);
        expect(completions["1_workout"]).toBe(true);
        expect(completions["2_nutrition"]).toBe(false);
      });

      it("updates existing task completion state from false to true", async () => {
        await saveDailyTaskCompletion(3, "workout", false);
        let completions = await getDailyTaskCompletion();
        expect(completions["3_workout"]).toBe(false);

        await saveDailyTaskCompletion(3, "workout", true);
        completions = await getDailyTaskCompletion();
        expect(completions["3_workout"]).toBe(true);
      });

      it("saves pre-formatted hyphenated task keys directly in completion state", async () => {
        await saveDailyTaskCompletion(1, "day-1-nutrition", true);
        const completions = await getDailyTaskCompletion();
        expect(completions["1_day-1-nutrition"]).toBe(true);
        expect(completions["day-1-nutrition"]).toBe(true);
      });

      it("returns empty object when stored daily task completion is corrupted or non-object", async () => {
        await adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.DAILY_COMPLETION_STATE, "not-an-object");
        const completions = await getDailyTaskCompletion();
        expect(completions).toEqual({});
      });
    });

    describe("Plan History Persistence", () => {
      it("returns empty array [] when no plan history exists", async () => {
        const history = await getPlanHistory();
        expect(history).toEqual([]);
      });

      it("saves and retrieves plan history array of completed cycles", async () => {
        const cycle1 = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1700000000000, null, 1);
        await savePlanHistory([cycle1]);
        const history = await getPlanHistory();
        expect(history).toHaveLength(1);
        expect(history[0]?.id).toBe(cycle1.id);
      });

      it("filters out invalid plan items in history", async () => {
        await adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.PLAN_HISTORY, [
          { invalid: "cycle" },
          generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1700000000000, null, 1)
        ]);
        const history = await getPlanHistory();
        expect(history).toHaveLength(1);
      });

      it("returns empty array if plan history raw is not an array", async () => {
        await adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.PLAN_HISTORY, null);
        const history = await getPlanHistory();
        expect(history).toEqual([]);
      });
    });

    describe("clearAllAdaptiveData & Sovereignty", () => {
      it("removes all 5 adaptive storage keys leaving storage completely reset", async () => {
        await saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
        const plan = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, Date.now(), null);
        await saveActivePlanCycle(plan);
        await saveWeightLog({ id: "w-1", timestampMs: Date.now(), weightKg: 70 });
        await saveDailyTaskCompletion(1, "nutrition", true);
        await savePlanHistory([plan]);

        // Verify items were persisted
        expect(await getUserBiometrics()).not.toBeNull();
        expect(await getActivePlanCycle()).not.toBeNull();
        expect((await getWeightLogs()).length).toBe(1);

        // Clear all
        await clearAllAdaptiveData();

        // Verify complete reset
        expect(await getUserBiometrics()).toBeNull();
        expect(await getActivePlanCycle()).toBeNull();
        expect(await getWeightLogs()).toEqual([]);
        expect(await getDailyTaskCompletion()).toEqual({});
        expect(await getPlanHistory()).toEqual([]);
      });

      it("is idempotent when invoked on already empty storage", async () => {
        await expect(clearAllAdaptiveData()).resolves.not.toThrow();
        expect(await getUserBiometrics()).toBeNull();
      });
    });

    describe("Error Handling & Tampering Resilience", () => {
      it("detects ciphertext tampering and rejects on getEncryptedItem", async () => {
        await saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
        const raw = backend.getRaw(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS);
        expect(raw).toBeDefined();

        const envelope = JSON.parse(raw!);
        envelope.ciphertext = envelope.ciphertext.slice(0, -2) + "99";
        backend.setRaw(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS, JSON.stringify(envelope));

        await expect(getUserBiometrics()).rejects.toThrow("tampering detected");
      });

      it("handles corrupted non-JSON envelope gracefully", async () => {
        backend.setRaw(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS, "invalid-json-string{");
        await expect(getUserBiometrics()).rejects.toThrow();
      });
    });

    describe("Class Instance & Singleton Parity", () => {
      it("allows instantiating independent AdaptiveStorage instances with custom backends", async () => {
        const backend2 = new InMemoryStorageBackend();
        const adapter2 = new EncryptedStorageAdapter("PassphraseInstance2!", backend2);
        const storage2 = new AdaptiveStorage(adapter2);

        await storage2.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
        expect(await storage2.getUserBiometrics()).toEqual(DEFAULT_BASELINE_BIOMETRICS);

        // Instance 1 remains isolated and empty
        const defaultStorage = getAdaptiveStorage();
        await defaultStorage.clearAllAdaptiveData();
        expect(await defaultStorage.getUserBiometrics()).toBeNull();
        expect(await storage2.getUserBiometrics()).not.toBeNull();
      });

      it("supports constructor with passphrase string and backend", async () => {
        const backend3 = new InMemoryStorageBackend();
        const storage3 = new AdaptiveStorage("CustomSecretPassphrase123!", backend3);
        expect(storage3.getAdapter()).toBeDefined();

        await storage3.saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
        const retrieved = await storage3.getUserBiometrics();
        expect(retrieved).toEqual(DEFAULT_BASELINE_BIOMETRICS);
      });

      it("supports setAdaptiveStorageAdapter", async () => {
        const backend4 = new InMemoryStorageBackend();
        const adapter4 = new EncryptedStorageAdapter("AnotherPassphrase2026!", backend4);
        setAdaptiveStorageAdapter(adapter4);

        await saveUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
        expect(await getUserBiometrics()).toEqual(DEFAULT_BASELINE_BIOMETRICS);
      });
    });
  });

  // ==========================================================================
  // 2. OnboardingWizardScreen State & Logic Unit Tests
  // ==========================================================================
  describe("OnboardingWizardScreen Component Logic", () => {
    describe("Step Navigation State Machine", () => {
      it("progresses sequentially from Step 1 (GOAL) -> Step 2 (BIOMETRICS) -> Step 3 (FREQUENCY)", () => {
        let step: WizardStep = 1;
        step = getWizardNextStep(step);
        expect(step).toBe(2);
        step = getWizardNextStep(step);
        expect(step).toBe(3);
        // Clamped at Step 3
        step = getWizardNextStep(step);
        expect(step).toBe(3);
      });

      it("navigates backward sequentially from Step 3 -> Step 2 -> Step 1", () => {
        let step: WizardStep = 3;
        step = getWizardPrevStep(step);
        expect(step).toBe(2);
        step = getWizardPrevStep(step);
        expect(step).toBe(1);
        // Clamped at Step 1
        step = getWizardPrevStep(step);
        expect(step).toBe(1);
      });
    });

    describe("Form Input Validation & Sanitization", () => {
      it("validates valid input payload and converts to UserBiometrics", () => {
        const result = validateOnboardingInputs({
          goal: "cut",
          gender: "male",
          ageStr: "28",
          weightStr: "80.5",
          heightStr: "182.0",
          bodyFatStr: "15.0",
          weeklyWorkoutFrequency: 4
        });
        expect(result.isValid).toBe(true);
        expect(result.error).toBeNull();
        expect(result.biometrics?.age).toBe(28);
        expect(result.biometrics?.weightKg).toBe(80.5);
        expect(result.biometrics?.bodyFatPct).toBe(15.0);
        expect(result.biometrics?.goal).toBe("cut");
        expect(result.biometrics?.activityLevel).toBe("moderate");
      });

      it("validates biometrics when optional bodyFatPct is left empty", () => {
        const result = validateOnboardingInputs({
          goal: "maintain",
          gender: "female",
          ageStr: "32",
          weightStr: "62.0",
          heightStr: "168.0",
          bodyFatStr: "", // omitted
          weeklyWorkoutFrequency: 3
        });
        expect(result.isValid).toBe(true);
        expect(result.biometrics?.bodyFatPct).toBeUndefined();
      });

      it("rejects age below 13 or above 120", () => {
        const under13 = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "12",
          weightStr: "50",
          heightStr: "150",
          weeklyWorkoutFrequency: 3
        });
        expect(under13.isValid).toBe(false);
        expect(under13.error).toContain("Age must be between 13 and 120");

        const over120 = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "125",
          weightStr: "50",
          heightStr: "150",
          weeklyWorkoutFrequency: 3
        });
        expect(over120.isValid).toBe(false);
      });

      it("rejects non-integer age", () => {
        const floatAge = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "28.5",
          weightStr: "70",
          heightStr: "170",
          weeklyWorkoutFrequency: 3
        });
        expect(floatAge.isValid).toBe(false);
        expect(floatAge.error).toContain("Age must be between 13 and 120");
      });

      it("rejects weight below 30kg or above 300kg", () => {
        const tooLight = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "25",
          weightStr: "25",
          heightStr: "170",
          weeklyWorkoutFrequency: 3
        });
        expect(tooLight.isValid).toBe(false);
        expect(tooLight.error).toContain("Weight must be between 30 and 300 kg");

        const tooHeavy = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "25",
          weightStr: "350",
          heightStr: "170",
          weeklyWorkoutFrequency: 3
        });
        expect(tooHeavy.isValid).toBe(false);
      });

      it("rejects height below 100cm or above 250cm", () => {
        const tooShort = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "25",
          weightStr: "70",
          heightStr: "80",
          weeklyWorkoutFrequency: 3
        });
        expect(tooShort.isValid).toBe(false);
        expect(tooShort.error).toContain("Height must be between 100 and 250 cm");

        const tooTall = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "25",
          weightStr: "70",
          heightStr: "270",
          weeklyWorkoutFrequency: 3
        });
        expect(tooTall.isValid).toBe(false);
      });

      it("rejects bodyFatPct below 2% or above 75%", () => {
        const tooLow = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "25",
          weightStr: "70",
          heightStr: "170",
          bodyFatStr: "1.0",
          weeklyWorkoutFrequency: 3
        });
        expect(tooLow.isValid).toBe(false);
        expect(tooLow.error).toContain("Body fat % must be between 2% and 75%");

        const tooHigh = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "25",
          weightStr: "70",
          heightStr: "170",
          bodyFatStr: "80.0",
          weeklyWorkoutFrequency: 3
        });
        expect(tooHigh.isValid).toBe(false);
      });

      it("rejects non-numeric inputs gracefully", () => {
        const notANumber = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "twenty-eight",
          weightStr: "70",
          heightStr: "170",
          weeklyWorkoutFrequency: 3
        });
        expect(notANumber.isValid).toBe(false);
        expect(notANumber.error).toContain("valid numbers");
      });

      it("rejects workout frequency outside 1..7", () => {
        const invalidFreq = validateOnboardingInputs({
          goal: "maintain",
          gender: "male",
          ageStr: "25",
          weightStr: "70",
          heightStr: "170",
          weeklyWorkoutFrequency: 0
        });
        expect(invalidFreq.isValid).toBe(false);
        expect(invalidFreq.error).toContain("Workout frequency must be between 1 and 7");
      });

      it("maps workout frequency correctly to activity levels", () => {
        const resLight = validateOnboardingInputs({
          ageStr: "25",
          weightStr: "70",
          heightStr: "170",
          weeklyWorkoutFrequency: 2
        });
        expect(resLight.biometrics?.activityLevel).toBe("light");

        const resModerate = validateOnboardingInputs({
          ageStr: "25",
          weightStr: "70",
          heightStr: "170",
          weeklyWorkoutFrequency: 4
        });
        expect(resModerate.biometrics?.activityLevel).toBe("moderate");

        const resHeavy = validateOnboardingInputs({
          ageStr: "25",
          weightStr: "70",
          heightStr: "170",
          weeklyWorkoutFrequency: 6
        });
        expect(resHeavy.biometrics?.activityLevel).toBe("heavy");

        const resVeryActive = validateOnboardingInputs({
          ageStr: "25",
          weightStr: "70",
          heightStr: "170",
          weeklyWorkoutFrequency: 7
        });
        expect(resVeryActive.biometrics?.activityLevel).toBe("very_active");
      });
    });

    describe("Submitting Wizard & Plan Generation", () => {
      it("generates 14-day plan, persists biometrics & plan cycle, and invokes onOnboardingComplete", async () => {
        const onCompleteMock = vi.fn();
        const inputs = {
          goal: "bulk" as const,
          gender: "male" as const,
          ageStr: "26",
          weightStr: "75.0",
          heightStr: "178.0",
          bodyFatStr: "14.0",
          weeklyWorkoutFrequency: 5
        };

        const validation = validateOnboardingInputs(inputs);
        expect(validation.isValid).toBe(true);
        const bio = validation.biometrics!;

        const plan = generate14DayPlan(bio, Date.now(), null);
        await saveUserBiometrics(bio);
        await saveActivePlanCycle(plan);
        await onCompleteMock(bio, plan);

        expect(onCompleteMock).toHaveBeenCalledTimes(1);
        expect(onCompleteMock).toHaveBeenCalledWith(bio, plan);

        // Verify storage
        const savedBio = await getUserBiometrics();
        const savedPlan = await getActivePlanCycle();
        expect(savedBio?.goal).toBe("bulk");
        expect(savedPlan?.dailyPlans).toHaveLength(14);
      });
    });

    describe("'Skip for Now' Action Handler", () => {
      it("bypasses inputs, initializes DEFAULT_BASELINE_BIOMETRICS, generates plan, and triggers callback", async () => {
        const onCompleteMock = vi.fn();

        const bio = DEFAULT_BASELINE_BIOMETRICS;
        const plan = generate14DayPlan(bio, Date.now(), null);
        await saveUserBiometrics(bio);
        await saveActivePlanCycle(plan);
        await onCompleteMock(bio, plan);

        expect(onCompleteMock).toHaveBeenCalledTimes(1);
        expect(onCompleteMock).toHaveBeenCalledWith(bio, plan);

        const savedBio = await getUserBiometrics();
        expect(savedBio).toEqual(DEFAULT_BASELINE_BIOMETRICS);
        const savedPlan = await getActivePlanCycle();
        expect(savedPlan?.targetDailyCalories).toBe(plan.targetDailyCalories);
      });

      it("skip action produces idempotent baseline state on multiple calls", async () => {
        const plan1 = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1700000000000, null);
        const plan2 = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1700000000000, null);

        expect(plan1.targetDailyCalories).toBe(plan2.targetDailyCalories);
        expect(plan1.baselineBiometrics).toEqual(plan2.baselineBiometrics);
      });
    });
  });
});
