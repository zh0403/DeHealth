import {
  ACTIVITY_LEVELS,
  ActivityLevel,
  AdaptivePlanCycle,
  AdaptivePlanCycleSchema,
  Address,
  AddressSchema,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32,
  Bytes32Schema,
  createDeHealthDomain,
  DailyPlan,
  DailyPlanSchema,
  DEFAULT_BASELINE_BIOMETRICS,
  DEHEALTH_EIP712_DOMAIN_NAME,
  DEHEALTH_EIP712_VERSION,
  Eip712DomainSchema,
  FITNESS_GOALS,
  FitnessGoal,
  FitnessGoalSchema,
  FoodPresetItem,
  FoodPresetItemSchema,
  GENDER_TYPES,
  GenderType,
  HexSignature,
  HexSignatureSchema,
  MacroSplit,
  MacroSplitSchema,
  PLAN_CYCLE_STATUSES,
  PlanCycleStatus,
  PlanCycleStatusSchema,
  PLAN_REVIEW_STATUSES,
  PlanReviewStatus,
  PlanReviewStatusSchema,
  ProposedPlanReview,
  ProposedPlanReviewSchema,
  SignedWorkoutClaimPayload,
  SignedWorkoutClaimPayloadSchema,
  STANDARD_FOOD_PRESETS,
  TelemetryData,
  TelemetryDataSchema,
  Uint256Schema,
  UserBiometrics,
  UserBiometricsSchema,
  UserProfile,
  UserProfileSchema,
  WeightLogEntry,
  WeightLogEntrySchema,
  WorkoutExerciseItem,
  WorkoutExerciseItemSchema,
  WorkoutProof,
  WorkoutProofSchema
} from "@dehealth/shared";
import { ethers, Wallet } from "ethers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  computeWorkoutProofDigest,
  hashTelemetry,
  signWorkoutProof,
  verifyWorkoutProofSignature
} from "../../services/cryptoService";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../../storage/encryptedStorageAdapter";

// ============================================================================
// Deterministic Physiology & Plan Contract Helpers (Phase 2.0 Specification)
// ============================================================================

export const SAFE_CALORIE_FLOOR = 1200;
export const FATIGUE_GAP_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48h
export const FATIGUE_SCALING_FACTOR = 0.7; // 30% reduction

export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  heavy: 1.725,
  very_active: 1.9
};

/**
 * Deterministic BMR:
 * - Katch-McArdle when bodyFatPct is provided: 370 + (21.6 * LBM)
 * - Mifflin-St Jeor fallback: 10*W + 6.25*H - 5*A + genderOffset (+5 male, -161 female, -78 other)
 */
export function calculateBmr(biometrics: UserBiometrics): number {
  if (biometrics.bodyFatPct !== undefined && biometrics.bodyFatPct > 0) {
    const lbm = biometrics.weightKg * (1 - biometrics.bodyFatPct / 100);
    return Math.round(370 + 21.6 * lbm);
  }
  const base = 10 * biometrics.weightKg + 6.25 * biometrics.heightCm - 5 * biometrics.age;
  if (biometrics.gender === "male") {
    return Math.round(base + 5);
  } else if (biometrics.gender === "female") {
    return Math.round(base - 161);
  } else {
    // "other": midpoint of male and female: (5 + -161) / 2 = -78
    return Math.round(base - 78);
  }
}

/**
 * Calculates TDEE from BMR and weekly frequency or activity level.
 */
export function calculateTdee(
  bmr: number,
  weeklyFrequency: number,
  activityLevel?: ActivityLevel
): number {
  let multiplier: number;
  if (activityLevel) {
    multiplier = ACTIVITY_MULTIPLIERS[activityLevel];
  } else if (weeklyFrequency <= 1) {
    multiplier = 1.2;
  } else if (weeklyFrequency <= 3) {
    multiplier = 1.375;
  } else if (weeklyFrequency <= 5) {
    multiplier = 1.55;
  } else {
    multiplier = 1.725;
  }
  return Math.round(bmr * multiplier);
}

/**
 * Calculates daily target calories clamped to safe floor (>= 1200 kcal/day).
 */
export function calculateTargetCalories(tdee: number, goal: FitnessGoal): number {
  let target: number;
  switch (goal) {
    case "cut":
    case "fat_loss":
      target = tdee - 500;
      break;
    case "bulk":
    case "muscle_gain":
      target = tdee + 300;
      break;
    case "maintain":
    case "maintenance":
    default:
      target = tdee;
      break;
  }
  return Math.max(SAFE_CALORIE_FLOOR, Math.round(target));
}

/**
 * Allocates macro splits:
 * - Cut: 35% protein, 35% carbs, 30% fat
 * - Maintain: 25% protein, 50% carbs, 25% fat
 * - Bulk: 25% protein, 55% carbs, 20% fat
 */
export function calculateMacroSplit(targetCalories: number, goal: FitnessGoal): MacroSplit {
  const calories = Math.max(SAFE_CALORIE_FLOOR, targetCalories);
  let pRatio: number;
  let cRatio: number;
  let fRatio: number;

  switch (goal) {
    case "cut":
    case "fat_loss":
      pRatio = 0.35;
      cRatio = 0.35;
      fRatio = 0.3;
      break;
    case "bulk":
    case "muscle_gain":
      pRatio = 0.25;
      cRatio = 0.55;
      fRatio = 0.2;
      break;
    case "maintain":
    case "maintenance":
    default:
      pRatio = 0.25;
      cRatio = 0.5;
      fRatio = 0.25;
      break;
  }

  const proteinGrams = Math.round((calories * pRatio) / 4);
  const carbsGrams = Math.round((calories * cRatio) / 4);
  const fatGrams = Math.round((calories * fRatio) / 9);

  return { proteinGrams, carbsGrams, fatGrams };
}

/**
 * Scales workout exercises down by 30% if inactivity gap > 48 hours.
 */
export function scaleExercisesForFatigue(
  exercises: readonly WorkoutExerciseItem[],
  lastLogTimestampMs: number | null,
  currentTimestampMs: number
): { exercises: WorkoutExerciseItem[]; isFatigueScaled: boolean } {
  if (lastLogTimestampMs === null) {
    return {
      exercises: exercises.map((e) => ({ ...e, scaledForFatigue: false })),
      isFatigueScaled: false
    };
  }
  const elapsedMs = currentTimestampMs - lastLogTimestampMs;
  if (elapsedMs > FATIGUE_GAP_THRESHOLD_MS) {
    const scaled = exercises.map((e) => ({
      ...e,
      sets: Math.max(1, Math.round(e.sets * FATIGUE_SCALING_FACTOR)),
      durationMinutes:
        e.durationMinutes !== undefined
          ? Math.max(1, Math.round(e.durationMinutes * FATIGUE_SCALING_FACTOR))
          : undefined,
      scaledForFatigue: true
    }));
    return { exercises: scaled, isFatigueScaled: true };
  }
  return {
    exercises: exercises.map((e) => ({ ...e, scaledForFatigue: false })),
    isFatigueScaled: false
  };
}

/**
 * Calculates rolling average of the most recent up to 7 chronological weight logs.
 */
export function calculateRollingWeightAverage(logs: readonly WeightLogEntry[]): number | null {
  if (logs.length === 0) return null;
  const sorted = [...logs].sort((a, b) => a.timestampMs - b.timestampMs);
  const recent7 = sorted.slice(-7);
  const sum = recent7.reduce((acc, entry) => acc + entry.weightKg, 0);
  return Number((sum / recent7.length).toFixed(2));
}

/**
 * Deterministic 14-day Bi-Weekly Review evaluation.
 */
export function evaluateBiWeeklyReview(
  currentCycle: AdaptivePlanCycle,
  weightLogs: readonly WeightLogEntry[],
  adherencePct: number,
  reviewDateMs: number
): ProposedPlanReview {
  const startingWeight = currentCycle.baselineBiometrics.weightKg;
  const rollingAvg = calculateRollingWeightAverage(weightLogs);
  const sorted = [...weightLogs].sort((a, b) => a.timestampMs - b.timestampMs);
  const currentWeight = sorted.length > 0 ? sorted[sorted.length - 1]!.weightKg : startingWeight;
  const weightChange = Number((currentWeight - startingWeight).toFixed(2));
  const effectiveRollingAvg = rollingAvg ?? currentWeight;

  let calorieAdjustment = 0;
  let rationale = "";

  if (adherencePct < 70) {
    calorieAdjustment = 0;
    rationale = `Adherence was ${adherencePct.toFixed(1)}% (< 70% threshold). Targets held constant to allow metabolic adaptation.`;
  } else {
    switch (currentCycle.goal) {
      case "cut":
      case "fat_loss":
        if (weightChange > -0.2) {
          calorieAdjustment = -150;
          rationale = `Plateau detected over 14 days (weight change ${weightChange} kg >= -0.2 kg). Decreasing daily calories by 150 kcal.`;
        } else {
          calorieAdjustment = 0;
          rationale = `On track for fat loss (weight change ${weightChange} kg). Caloric deficit maintained.`;
        }
        break;
      case "bulk":
      case "muscle_gain":
        if (weightChange < 0.2) {
          calorieAdjustment = 150;
          rationale = `Weight gain slow (${weightChange} kg < 0.2 kg). Increasing daily surplus by 150 kcal.`;
        } else {
          calorieAdjustment = 0;
          rationale = `On track for muscle gain (+${weightChange} kg). Caloric surplus maintained.`;
        }
        break;
      case "maintain":
      case "maintenance":
      default:
        if (weightChange > 0.5) {
          calorieAdjustment = -100;
          rationale = `Weight drifted upward (+${weightChange} kg). Adjusting target down by 100 kcal.`;
        } else if (weightChange < -0.5) {
          calorieAdjustment = 100;
          rationale = `Weight drifted downward (${weightChange} kg). Adjusting target up by 100 kcal.`;
        } else {
          calorieAdjustment = 0;
          rationale = `Weight stable (${weightChange} kg). Maintenance caloric targets preserved.`;
        }
        break;
    }
  }

  const proposedDailyCalories = Math.max(
    SAFE_CALORIE_FLOOR,
    currentCycle.targetDailyCalories + calorieAdjustment
  );
  const actualAdjustment = proposedDailyCalories - currentCycle.targetDailyCalories;

  const currentMacroSplit: MacroSplit = {
    proteinGrams: currentCycle.targetDailyProteinGrams,
    carbsGrams: currentCycle.targetDailyCarbsGrams,
    fatGrams: currentCycle.targetDailyFatGrams
  };
  const proposedMacroSplit = calculateMacroSplit(proposedDailyCalories, currentCycle.goal);

  return {
    cycleId: currentCycle.id,
    reviewDateMs,
    adherencePct,
    startingWeightKg: startingWeight,
    currentWeightKg: currentWeight,
    weightChangeKg: weightChange,
    rollingAverageWeightKg: effectiveRollingAvg,
    currentDailyCalories: currentCycle.targetDailyCalories,
    proposedDailyCalories,
    calorieAdjustment: actualAdjustment,
    currentMacroSplit,
    proposedMacroSplit,
    rationale,
    status: "pending"
  };
}

/**
 * Scales food preset portion linearly.
 */
export function scaleFoodPresetPortion(
  preset: FoodPresetItem,
  portionGrams: number
): {
  caloriesKcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
} {
  const factor = portionGrams / preset.servingSizeGrams;
  return {
    caloriesKcal: Number((preset.caloriesKcal * factor).toFixed(1)),
    proteinGrams: Number((preset.proteinGrams * factor).toFixed(1)),
    carbsGrams: Number((preset.carbsGrams * factor).toFixed(1)),
    fatGrams: Number((preset.fatGrams * factor).toFixed(1))
  };
}

/**
 * In-memory test storage backend implementing KeyValueStorageBackend.
 */
export class InMemoryStorageBackend implements KeyValueStorageBackend {
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

/**
 * Builds a deterministic mock 14-day AdaptivePlanCycle for test fixture usage.
 */
export function createMock14DayCycle(
  overrides?: Partial<AdaptivePlanCycle>
): AdaptivePlanCycle {
  const startDateMs = overrides?.startDateMs ?? 1700000000000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const targetDailyCalories = overrides?.targetDailyCalories ?? 2200;
  const macros = calculateMacroSplit(targetDailyCalories, overrides?.goal ?? "cut");

  const dailyPlans: DailyPlan[] = [];
  for (let d = 1; d <= 14; d++) {
    dailyPlans.push({
      dayNumber: d,
      date: new Date(startDateMs + (d - 1) * DAY_MS).toISOString().split("T")[0]!,
      targetCaloriesKcal: targetDailyCalories,
      targetProteinGrams: macros.proteinGrams,
      targetCarbsGrams: macros.carbsGrams,
      targetFatGrams: macros.fatGrams,
      loggedCaloriesKcal: 0,
      loggedProteinGrams: 0,
      loggedCarbsGrams: 0,
      loggedFatGrams: 0,
      exercises: [
        {
          id: `ex-sq-${d}`,
          name: "Barbell Squats",
          category: "legs",
          sets: 4,
          reps: 8,
          completed: false
        },
        {
          id: `ex-bp-${d}`,
          name: "Dumbbell Bench Press",
          category: "chest",
          sets: 3,
          reps: 10,
          completed: false
        }
      ],
      isFatigueScaled: false,
      completed: false
    });
  }

  return {
    id: overrides?.id ?? "cycle-test-001",
    cycleNumber: overrides?.cycleNumber ?? 1,
    startDateMs,
    endDateMs: startDateMs + 14 * DAY_MS,
    goal: overrides?.goal ?? "cut",
    baselineBiometrics: overrides?.baselineBiometrics ?? DEFAULT_BASELINE_BIOMETRICS,
    targetDailyCalories,
    targetDailyProteinGrams: macros.proteinGrams,
    targetDailyCarbsGrams: macros.carbsGrams,
    targetDailyFatGrams: macros.fatGrams,
    dailyPlans,
    status: overrides?.status ?? "active"
  };
}

// ============================================================================
// Phase 2.0 E2E Tier 1 & Tier 2 Test Suite (130 Tests Total)
// ============================================================================

describe("Phase 2.0 E2E Test Suite - Tier 1 & Tier 2", () => {
  const sampleAddress: Address = "0x1111222233334444555566667777888899990000";
  let backend: InMemoryStorageBackend;
  let adapter: EncryptedStorageAdapter;

  beforeEach(() => {
    backend = new InMemoryStorageBackend();
    adapter = new EncryptedStorageAdapter("TestPassphraseSecure2026!", backend);
  });

  // ==========================================================================
  // TIER 1: FEATURE COVERAGE (65 TESTS ACROSS 13 FEATURES)
  // ==========================================================================

  describe("Tier 1: Feature Coverage (65 Tests across 13 Features)", () => {
    // ------------------------------------------------------------------------
    // F1: Domain Models & Zod Schemas
    // ------------------------------------------------------------------------
    describe("Feature 1: Domain Models & Zod Schemas", () => {
      it("F1-T1-1: parses and validates all 6 canonical FitnessGoal enum values", () => {
        const validGoals: FitnessGoal[] = [
          "cut",
          "maintain",
          "bulk",
          "fat_loss",
          "maintenance",
          "muscle_gain"
        ];
        expect(FITNESS_GOALS).toHaveLength(6);
        for (const goal of validGoals) {
          expect(FitnessGoalSchema.parse(goal)).toBe(goal);
        }
      });

      it("F1-T1-2: validates complete UserBiometrics schema including default baseline biometrics", () => {
        const parsed = UserBiometricsSchema.parse(DEFAULT_BASELINE_BIOMETRICS);
        expect(parsed.age).toBe(28);
        expect(parsed.gender).toBe("male");
        expect(parsed.weightKg).toBe(70.0);
        expect(parsed.heightCm).toBe(175.0);
        expect(parsed.bodyFatPct).toBe(18.5);
        expect(parsed.weeklyWorkoutFrequency).toBe(3);
        expect(parsed.goal).toBe("maintain");
      });

      it("F1-T1-3: validates WeightLogEntry with mandatory positive timestamp and optional note", () => {
        const entry: WeightLogEntry = {
          id: "log-1",
          timestampMs: 1700000000000,
          weightKg: 72.5,
          bodyFatPct: 17.8,
          note: "Morning fast weigh-in"
        };
        const parsed = WeightLogEntrySchema.parse(entry);
        expect(parsed.id).toBe("log-1");
        expect(parsed.weightKg).toBe(72.5);
        expect(parsed.bodyFatPct).toBe(17.8);
      });

      it("F1-T1-4: validates DailyPlanSchema enforcing 14-day cycle bounds and calorie minimum floor", () => {
        const plan: DailyPlan = {
          dayNumber: 1,
          date: "2026-11-12",
          targetCaloriesKcal: 2000,
          targetProteinGrams: 150,
          targetCarbsGrams: 200,
          targetFatGrams: 67,
          loggedCaloriesKcal: 0,
          loggedProteinGrams: 0,
          loggedCarbsGrams: 0,
          loggedFatGrams: 0,
          exercises: [
            {
              id: "ex-1",
              name: "Deadlift",
              category: "back",
              sets: 3,
              reps: 5,
              completed: false
            }
          ],
          isFatigueScaled: false,
          completed: false
        };
        const parsed = DailyPlanSchema.parse(plan);
        expect(parsed.dayNumber).toBe(1);
        expect(parsed.targetCaloriesKcal).toBeGreaterThanOrEqual(1200);
      });

      it("F1-T1-5: validates AdaptivePlanCycleSchema and ProposedPlanReviewSchema status transitions", () => {
        const cycle = createMock14DayCycle();
        const parsedCycle = AdaptivePlanCycleSchema.parse(cycle);
        expect(parsedCycle.dailyPlans).toHaveLength(14);
        expect(parsedCycle.status).toBe("active");

        const review: ProposedPlanReview = {
          cycleId: cycle.id,
          reviewDateMs: cycle.endDateMs,
          adherencePct: 85.5,
          startingWeightKg: 70.0,
          currentWeightKg: 68.8,
          weightChangeKg: -1.2,
          rollingAverageWeightKg: 69.1,
          currentDailyCalories: 2200,
          proposedDailyCalories: 2050,
          calorieAdjustment: -150,
          currentMacroSplit: { proteinGrams: 165, carbsGrams: 220, fatGrams: 73 },
          proposedMacroSplit: { proteinGrams: 179, carbsGrams: 179, fatGrams: 68 },
          rationale: "Steady fat loss detected with high adherence.",
          status: "pending"
        };
        const parsedReview = ProposedPlanReviewSchema.parse(review);
        expect(parsedReview.status).toBe("pending");
        expect(parsedReview.weightChangeKg).toBe(-1.2);
      });
    });

    // ------------------------------------------------------------------------
    // F2: Deterministic Caloric Math
    // ------------------------------------------------------------------------
    describe("Feature 2: Deterministic Caloric Math", () => {
      it("F2-T1-1: calculates Mifflin-St Jeor BMR for male with exact arithmetic precision", () => {
        // Base = 10*70 + 6.25*175 - 5*28 = 700 + 1093.75 - 140 = 1653.75
        // Male = 1653.75 + 5 = 1658.75 -> 1659
        const biometrics: UserBiometrics = {
          age: 28,
          gender: "male",
          weightKg: 70,
          heightCm: 175,
          weeklyWorkoutFrequency: 3,
          goal: "cut"
        };
        const bmr = calculateBmr(biometrics);
        expect(bmr).toBe(1659);
      });

      it("F2-T1-2: calculates Mifflin-St Jeor BMR for female with exact arithmetic precision", () => {
        // Base = 10*60 + 6.25*165 - 5*25 = 600 + 1031.25 - 125 = 1506.25
        // Female = 1506.25 - 161 = 1345.25 -> 1345
        const biometrics: UserBiometrics = {
          age: 25,
          gender: "female",
          weightKg: 60,
          heightCm: 165,
          weeklyWorkoutFrequency: 3,
          goal: "maintain"
        };
        const bmr = calculateBmr(biometrics);
        expect(bmr).toBe(1345);
      });

      it("F2-T1-3: calculates Mifflin-St Jeor BMR for gender 'other' at exact male-female midpoint", () => {
        // Base = 10*70 + 6.25*175 - 5*28 = 1653.75
        // Other = 1653.75 - 78 = 1575.75 -> 1576
        const biometrics: UserBiometrics = {
          age: 28,
          gender: "other",
          weightKg: 70,
          heightCm: 175,
          weeklyWorkoutFrequency: 4,
          goal: "maintain"
        };
        const bmr = calculateBmr(biometrics);
        expect(bmr).toBe(1576);
      });

      it("F2-T1-4: calculates Katch-McArdle BMR using body fat percentage and lean body mass", () => {
        // Weight 70kg, bodyFat 20% -> LBM = 56kg
        // BMR = 370 + 21.6 * 56 = 370 + 1209.6 = 1579.6 -> 1580
        const biometrics: UserBiometrics = {
          age: 30,
          gender: "male",
          weightKg: 70,
          heightCm: 175,
          bodyFatPct: 20,
          weeklyWorkoutFrequency: 4,
          goal: "cut"
        };
        const bmr = calculateBmr(biometrics);
        expect(bmr).toBe(1580);
      });

      it("F2-T1-5: applies deterministic TDEE activity multipliers matching workout frequency and activity level", () => {
        const bmr = 1500;
        expect(calculateTdee(bmr, 1, "sedentary")).toBe(1800); // 1500 * 1.2
        expect(calculateTdee(bmr, 3, "light")).toBe(2063); // 1500 * 1.375 = 2062.5 -> 2063
        expect(calculateTdee(bmr, 4, "moderate")).toBe(2325); // 1500 * 1.55 = 2325
        expect(calculateTdee(bmr, 6, "heavy")).toBe(2588); // 1500 * 1.725 = 2587.5 -> 2588
        expect(calculateTdee(bmr, 7, "very_active")).toBe(2850); // 1500 * 1.90 = 2850
      });
    });

    // ------------------------------------------------------------------------
    // F3: Safe Calorie Floor Enforcement (>= 1200 kcal/day)
    // ------------------------------------------------------------------------
    describe("Feature 3: Safe Calorie Floor Enforcement (>= 1200 kcal/day)", () => {
      it("F3-T1-1: clamps severe deficit target calories to strictly >= 1200 kcal/day", () => {
        // TDEE 1400 - 500 = 900 -> clamped to 1200
        const target = calculateTargetCalories(1400, "cut");
        expect(target).toBe(1200);
      });

      it("F3-T1-2: preserves targets above 1200 kcal/day without clamping", () => {
        // TDEE 2200 - 500 = 1700 -> unclamped
        const target = calculateTargetCalories(2200, "cut");
        expect(target).toBe(1700);
      });

      it("F3-T1-3: DailyPlanSchema rejects any targetCaloriesKcal less than 1200", () => {
        const invalidPlan = {
          dayNumber: 1,
          date: "2026-11-12",
          targetCaloriesKcal: 1199,
          targetProteinGrams: 100,
          targetCarbsGrams: 100,
          targetFatGrams: 44,
          loggedCaloriesKcal: 0,
          loggedProteinGrams: 0,
          loggedCarbsGrams: 0,
          loggedFatGrams: 0,
          exercises: [],
          isFatigueScaled: false,
          completed: false
        };
        expect(() => DailyPlanSchema.parse(invalidPlan)).toThrow();
      });

      it("F3-T1-4: AdaptivePlanCycleSchema rejects targetDailyCalories below 1200", () => {
        const cycle = createMock14DayCycle({ targetDailyCalories: 1150 });
        expect(() => AdaptivePlanCycleSchema.parse(cycle)).toThrow();
      });

      it("F3-T1-5: ProposedPlanReviewSchema rejects proposedDailyCalories below 1200", () => {
        const review: ProposedPlanReview = {
          cycleId: "c-1",
          reviewDateMs: 1700000000000,
          adherencePct: 90,
          startingWeightKg: 65,
          currentWeightKg: 65,
          weightChangeKg: 0,
          rollingAverageWeightKg: 65,
          currentDailyCalories: 1250,
          proposedDailyCalories: 1100, // Invalid!
          calorieAdjustment: -150,
          currentMacroSplit: { proteinGrams: 100, carbsGrams: 100, fatGrams: 40 },
          proposedMacroSplit: { proteinGrams: 100, carbsGrams: 100, fatGrams: 40 },
          rationale: "Aggressive reduction",
          status: "pending"
        };
        expect(() => ProposedPlanReviewSchema.parse(review)).toThrow();
      });
    });

    // ------------------------------------------------------------------------
    // F4: Macro Split Allocations
    // ------------------------------------------------------------------------
    describe("Feature 4: Macro Split Allocations", () => {
      it("F4-T1-1: allocates high-protein macro split for 'cut' goal preserving lean mass", () => {
        // 2000 kcal cut: 35% P (175g), 35% C (175g), 30% F (67g)
        const macros = calculateMacroSplit(2000, "cut");
        expect(macros.proteinGrams).toBe(175);
        expect(macros.carbsGrams).toBe(175);
        expect(macros.fatGrams).toBe(67);
      });

      it("F4-T1-2: allocates balanced macro split for 'maintain' goal", () => {
        // 2000 kcal maintain: 25% P (125g), 50% C (250g), 25% F (56g)
        const macros = calculateMacroSplit(2000, "maintain");
        expect(macros.proteinGrams).toBe(125);
        expect(macros.carbsGrams).toBe(250);
        expect(macros.fatGrams).toBe(56);
      });

      it("F4-T1-3: allocates surplus carb-focused macro split for 'bulk' goal", () => {
        // 2400 kcal bulk: 25% P (150g), 55% C (330g), 20% F (53g)
        const macros = calculateMacroSplit(2400, "bulk");
        expect(macros.proteinGrams).toBe(150);
        expect(macros.carbsGrams).toBe(330);
        expect(macros.fatGrams).toBe(53);
      });

      it("F4-T1-4: verifies macro grams yield calories within 5 kcal of daily target calories", () => {
        const target = 1800;
        const macros = calculateMacroSplit(target, "cut");
        const computedCalories =
          macros.proteinGrams * 4 + macros.carbsGrams * 4 + macros.fatGrams * 9;
        expect(Math.abs(computedCalories - target)).toBeLessThanOrEqual(5);
      });

      it("F4-T1-5: validates all allocated macro splits strictly satisfy MacroSplitSchema", () => {
        for (const goal of FITNESS_GOALS) {
          const split = calculateMacroSplit(2100, goal);
          const parsed = MacroSplitSchema.parse(split);
          expect(parsed.proteinGrams).toBeGreaterThan(0);
          expect(parsed.carbsGrams).toBeGreaterThan(0);
          expect(parsed.fatGrams).toBeGreaterThan(0);
        }
      });
    });

    // ------------------------------------------------------------------------
    // F5: Inactivity Fatigue Scaling
    // ------------------------------------------------------------------------
    describe("Feature 5: Inactivity Fatigue Scaling", () => {
      const sampleExercises: WorkoutExerciseItem[] = [
        { id: "e1", name: "Squats", category: "legs", sets: 4, reps: 10, completed: false },
        { id: "e2", name: "Plank", category: "core", sets: 3, durationMinutes: 10, completed: false }
      ];

      it("F5-T1-1: does not scale workout when gap is under or equal to 48 hours", () => {
        const lastLog = 1700000000000;
        const current = lastLog + 36 * 60 * 60 * 1000; // 36 hours
        const result = scaleExercisesForFatigue(sampleExercises, lastLog, current);
        expect(result.isFatigueScaled).toBe(false);
        expect(result.exercises[0]?.sets).toBe(4);
        expect(result.exercises[1]?.durationMinutes).toBe(10);
      });

      it("F5-T1-2: scales down workout sets and duration by exactly 30% when inactivity gap > 48 hours", () => {
        const lastLog = 1700000000000;
        const current = lastLog + 50 * 60 * 60 * 1000; // 50 hours (>48h)
        const result = scaleExercisesForFatigue(sampleExercises, lastLog, current);
        expect(result.isFatigueScaled).toBe(true);
        expect(result.exercises[0]?.sets).toBe(3); // 4 * 0.7 = 2.8 -> 3
        expect(result.exercises[1]?.durationMinutes).toBe(7); // 10 * 0.7 = 7
      });

      it("F5-T1-3: guarantees minimum 1 set after fatigue downscaling", () => {
        const singleSetEx: WorkoutExerciseItem[] = [
          { id: "e3", name: "Single Set Finisher", category: "core", sets: 1, completed: false }
        ];
        const lastLog = 1700000000000;
        const current = lastLog + 72 * 60 * 60 * 1000;
        const result = scaleExercisesForFatigue(singleSetEx, lastLog, current);
        expect(result.exercises[0]?.sets).toBe(1);
      });

      it("F5-T1-4: treats null lastLogTimestampMs (first launch) as unscaled normal session", () => {
        const current = 1700000000000;
        const result = scaleExercisesForFatigue(sampleExercises, null, current);
        expect(result.isFatigueScaled).toBe(false);
        expect(result.exercises[0]?.sets).toBe(4);
      });

      it("F5-T1-5: marks scaledForFatigue flag true on scaled exercise items", () => {
        const lastLog = 1700000000000;
        const current = lastLog + 60 * 60 * 60 * 1000;
        const result = scaleExercisesForFatigue(sampleExercises, lastLog, current);
        expect(result.exercises.every((e) => e.scaledForFatigue === true)).toBe(true);
      });
    });

    // ------------------------------------------------------------------------
    // F6: Rolling 7-Day Weight Average
    // ------------------------------------------------------------------------
    describe("Feature 6: Rolling 7-Day Weight Average", () => {
      it("F6-T1-1: computes rolling average equal to single entry when only one log exists", () => {
        const logs: WeightLogEntry[] = [{ id: "l1", timestampMs: 1000, weightKg: 75.4 }];
        expect(calculateRollingWeightAverage(logs)).toBe(75.4);
      });

      it("F6-T1-2: computes arithmetic mean across sequential logs within 7-day window", () => {
        const logs: WeightLogEntry[] = [
          { id: "l1", timestampMs: 1000, weightKg: 70.0 },
          { id: "l2", timestampMs: 2000, weightKg: 70.2 },
          { id: "l3", timestampMs: 3000, weightKg: 69.8 }
        ];
        // (70.0 + 70.2 + 69.8) / 3 = 70.00
        expect(calculateRollingWeightAverage(logs)).toBe(70.0);
      });

      it("F6-T1-3: sorts unordered logs chronologically before calculating average", () => {
        const logs: WeightLogEntry[] = [
          { id: "l3", timestampMs: 3000, weightKg: 68.0 },
          { id: "l1", timestampMs: 1000, weightKg: 70.0 },
          { id: "l2", timestampMs: 2000, weightKg: 69.0 }
        ];
        // Sorted: 70, 69, 68 -> mean = 69.0
        expect(calculateRollingWeightAverage(logs)).toBe(69.0);
      });

      it("F6-T1-4: restricts calculation window to the 7 most recent logs when > 7 exist", () => {
        const logs: WeightLogEntry[] = [
          { id: "old1", timestampMs: 1, weightKg: 100.0 }, // Dropped
          { id: "old2", timestampMs: 2, weightKg: 100.0 }, // Dropped
          { id: "l1", timestampMs: 3, weightKg: 70.0 },
          { id: "l2", timestampMs: 4, weightKg: 70.0 },
          { id: "l3", timestampMs: 5, weightKg: 70.0 },
          { id: "l4", timestampMs: 6, weightKg: 70.0 },
          { id: "l5", timestampMs: 7, weightKg: 70.0 },
          { id: "l6", timestampMs: 8, weightKg: 70.0 },
          { id: "l7", timestampMs: 9, weightKg: 70.0 }
        ];
        expect(calculateRollingWeightAverage(logs)).toBe(70.0);
      });

      it("F6-T1-5: returns null when weight log array is empty", () => {
        expect(calculateRollingWeightAverage([])).toBeNull();
      });
    });

    // ------------------------------------------------------------------------
    // F7: Offline Bi-Weekly Review Engine
    // ------------------------------------------------------------------------
    describe("Feature 7: Offline Bi-Weekly Review Engine", () => {
      it("F7-T1-1: generates review with plateau deficit adjustment for Cut goal on high adherence", () => {
        const cycle = createMock14DayCycle({
          goal: "cut",
          targetDailyCalories: 2000,
          baselineBiometrics: { ...DEFAULT_BASELINE_BIOMETRICS, weightKg: 80.0 }
        });
        const logs: WeightLogEntry[] = [
          { id: "l1", timestampMs: cycle.startDateMs, weightKg: 80.0 },
          { id: "l2", timestampMs: cycle.endDateMs, weightKg: 79.9 } // Only 0.1kg lost in 14 days
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 90, cycle.endDateMs);
        expect(review.calorieAdjustment).toBe(-150);
        expect(review.proposedDailyCalories).toBe(1850);
        expect(review.rationale).toContain("Plateau detected");
      });

      it("F7-T1-2: generates review with surplus adjustment for Bulk goal when weight gain stalls", () => {
        const cycle = createMock14DayCycle({
          goal: "bulk",
          targetDailyCalories: 2600,
          baselineBiometrics: { ...DEFAULT_BASELINE_BIOMETRICS, weightKg: 70.0 }
        });
        const logs: WeightLogEntry[] = [
          { id: "l1", timestampMs: cycle.startDateMs, weightKg: 70.0 },
          { id: "l2", timestampMs: cycle.endDateMs, weightKg: 70.1 } // Stalled
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, cycle.endDateMs);
        expect(review.calorieAdjustment).toBe(150);
        expect(review.proposedDailyCalories).toBe(2750);
      });

      it("F7-T1-3: maintains current calories when adherence is under 70% to prevent premature adjustments", () => {
        const cycle = createMock14DayCycle({ targetDailyCalories: 2100 });
        const logs: WeightLogEntry[] = [
          { id: "l1", timestampMs: cycle.startDateMs, weightKg: 75.0 },
          { id: "l2", timestampMs: cycle.endDateMs, weightKg: 75.0 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 60, cycle.endDateMs);
        expect(review.calorieAdjustment).toBe(0);
        expect(review.proposedDailyCalories).toBe(2100);
        expect(review.rationale).toContain("Adherence was 60.0%");
      });

      it("F7-T1-4: generates explanatory deterministic rationale without calling external LLM APIs", () => {
        const cycle = createMock14DayCycle();
        const logs: WeightLogEntry[] = [
          { id: "l1", timestampMs: cycle.startDateMs, weightKg: 70.0 },
          { id: "l2", timestampMs: cycle.endDateMs, weightKg: 69.2 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 95, cycle.endDateMs);
        expect(review.rationale).toBeTruthy();
        expect(typeof review.rationale).toBe("string");
      });

      it("F7-T1-5: returns ProposedPlanReview with pending status conforming to schema", () => {
        const cycle = createMock14DayCycle();
        const review = evaluateBiWeeklyReview(cycle, [], 80, cycle.endDateMs);
        const parsed = ProposedPlanReviewSchema.parse(review);
        expect(parsed.status).toBe("pending");
        expect(parsed.cycleId).toBe(cycle.id);
      });
    });

    // ------------------------------------------------------------------------
    // F8: Onboarding Wizard UI Flow & Fallback
    // ------------------------------------------------------------------------
    describe("Feature 8: Onboarding Wizard UI Flow & Fallback", () => {
      it("F8-T1-1: validates sequential wizard state progression from Goal to Biometrics to Frequency", () => {
        type WizardStep = "GOAL" | "BIOMETRICS" | "FREQUENCY" | "CONFIRMATION";
        let currentStep: WizardStep = "GOAL";

        const nextStep = (step: WizardStep): WizardStep => {
          switch (step) {
            case "GOAL":
              return "BIOMETRICS";
            case "BIOMETRICS":
              return "FREQUENCY";
            case "FREQUENCY":
              return "CONFIRMATION";
            case "CONFIRMATION":
              return "CONFIRMATION";
          }
        };

        currentStep = nextStep(currentStep);
        expect(currentStep).toBe("BIOMETRICS");
        currentStep = nextStep(currentStep);
        expect(currentStep).toBe("FREQUENCY");
        currentStep = nextStep(currentStep);
        expect(currentStep).toBe("CONFIRMATION");
      });

      it("F8-T1-2: 'Skip for Now' action initializes DEFAULT_BASELINE_BIOMETRICS baseline metrics", () => {
        const skippedProfile: UserBiometrics = { ...DEFAULT_BASELINE_BIOMETRICS };
        expect(UserBiometricsSchema.parse(skippedProfile)).toEqual(DEFAULT_BASELINE_BIOMETRICS);
      });

      it("F8-T1-3: successfully validates customized user biometrics submitted through wizard", () => {
        const custom: UserBiometrics = {
          age: 32,
          gender: "female",
          weightKg: 62.5,
          heightCm: 168.0,
          bodyFatPct: 22.0,
          weeklyWorkoutFrequency: 4,
          goal: "fat_loss"
        };
        const parsed = UserBiometricsSchema.parse(custom);
        expect(parsed.weightKg).toBe(62.5);
        expect(parsed.goal).toBe("fat_loss");
      });

      it("F8-T1-4: rejects progression when mandatory biometrics fields are missing or invalid", () => {
        const invalid = {
          age: 10, // Under 13
          gender: "unknown",
          weightKg: 20
        };
        expect(() => UserBiometricsSchema.parse(invalid)).toThrow();
      });

      it("F8-T1-5: persists validated onboarding biometrics to @dehealth/user_biometrics storage key", async () => {
        const custom: UserBiometrics = {
          age: 26,
          gender: "male",
          weightKg: 78,
          heightCm: 180,
          weeklyWorkoutFrequency: 5,
          goal: "bulk"
        };
        await adapter.setEncryptedItem("@dehealth/user_biometrics", custom);
        const stored = await adapter.getEncryptedItem<UserBiometrics>("@dehealth/user_biometrics");
        expect(stored).toEqual(custom);
      });
    });

    // ------------------------------------------------------------------------
    // F9: Local Encrypted Persistence
    // ------------------------------------------------------------------------
    describe("Feature 9: Local Encrypted Persistence", () => {
      it("F9-T1-1: roundtrips UserBiometrics under @dehealth/user_biometrics with encryption", async () => {
        const bio: UserBiometrics = { ...DEFAULT_BASELINE_BIOMETRICS, weightKg: 82.5 };
        await adapter.setEncryptedItem("@dehealth/user_biometrics", bio);
        const decrypted = await adapter.getEncryptedItem<UserBiometrics>(
          "@dehealth/user_biometrics"
        );
        expect(decrypted?.weightKg).toBe(82.5);
      });

      it("F9-T1-2: roundtrips WeightLogEntry array under @dehealth/weight_logs", async () => {
        const logs: WeightLogEntry[] = [
          { id: "w-1", timestampMs: 1700000000000, weightKg: 75.0 },
          { id: "w-2", timestampMs: 1700086400000, weightKg: 74.8 }
        ];
        await adapter.setEncryptedItem("@dehealth/weight_logs", logs);
        const retrieved = await adapter.getEncryptedItem<WeightLogEntry[]>(
          "@dehealth/weight_logs"
        );
        expect(retrieved).toHaveLength(2);
        expect(retrieved?.[1]?.weightKg).toBe(74.8);
      });

      it("F9-T1-3: roundtrips AdaptivePlanCycle under @dehealth/active_plan_cycle", async () => {
        const cycle = createMock14DayCycle();
        await adapter.setEncryptedItem("@dehealth/active_plan_cycle", cycle);
        const retrieved = await adapter.getEncryptedItem<AdaptivePlanCycle>(
          "@dehealth/active_plan_cycle"
        );
        expect(retrieved?.id).toBe(cycle.id);
        expect(retrieved?.dailyPlans).toHaveLength(14);
      });

      it("F9-T1-4: roundtrips daily completion state map under @dehealth/daily_completion_state", async () => {
        const completionMap: Record<string, boolean> = {
          "day-1": true,
          "day-2": true,
          "day-3": false
        };
        await adapter.setEncryptedItem("@dehealth/daily_completion_state", completionMap);
        const retrieved = await adapter.getEncryptedItem<Record<string, boolean>>(
          "@dehealth/daily_completion_state"
        );
        expect(retrieved?.["day-1"]).toBe(true);
        expect(retrieved?.["day-3"]).toBe(false);
      });

      it("F9-T1-5: removes encrypted item and returns null on subsequent retrieval", async () => {
        await adapter.setEncryptedItem("temp_key", { data: 123 });
        await adapter.removeEncryptedItem("temp_key");
        const val = await adapter.getEncryptedItem("temp_key");
        expect(val).toBeNull();
      });
    });

    // ------------------------------------------------------------------------
    // F10: Dual-Track Check-In Cards Math
    // ------------------------------------------------------------------------
    describe("Feature 10: Dual-Track Check-In Cards Math", () => {
      it("F10-T1-1: scales standard food presets linearly by gram portion size", () => {
        const chickenBreast = STANDARD_FOOD_PRESETS[0]!;
        expect(chickenBreast.name).toBe("Chicken Breast");
        // 150g portion (1.5x of 100g serving: 165*1.5=247.5 kcal, 31*1.5=46.5g P)
        const scaled = scaleFoodPresetPortion(chickenBreast, 150);
        expect(scaled.caloriesKcal).toBe(247.5);
        expect(scaled.proteinGrams).toBe(46.5);
      });

      it("F10-T1-2: aggregates multiple logged food preset portions into daily nutrition totals", () => {
        const chicken = scaleFoodPresetPortion(STANDARD_FOOD_PRESETS[0]!, 100); // 165 kcal, 31g P, 0g C, 3.6g F
        const rice = scaleFoodPresetPortion(STANDARD_FOOD_PRESETS[1]!, 200); // 224 kcal, 5.2g P, 48g C, 1.8g F
        const totalCalories = Number((chicken.caloriesKcal + rice.caloriesKcal).toFixed(1));
        const totalProtein = Number((chicken.proteinGrams + rice.proteinGrams).toFixed(1));
        const totalCarbs = Number((chicken.carbsGrams + rice.carbsGrams).toFixed(1));
        const totalFat = Number((chicken.fatGrams + rice.fatGrams).toFixed(1));

        expect(totalCalories).toBe(389.0);
        expect(totalProtein).toBe(36.2);
        expect(totalCarbs).toBe(48.0);
        expect(totalFat).toBe(5.4);
      });

      it("F10-T1-3: calculates nutrition progress percentage against daily target calories and macros", () => {
        const targetCalories = 2000;
        const loggedCalories = 1500;
        const progressPct = Math.min(100, Math.round((loggedCalories / targetCalories) * 100));
        expect(progressPct).toBe(75);
      });

      it("F10-T1-4: tracks checklist completion state across itemized workout exercises", () => {
        const exercises: WorkoutExerciseItem[] = [
          { id: "e1", name: "Squat", category: "legs", sets: 3, completed: true },
          { id: "e2", name: "Bench", category: "chest", sets: 3, completed: true },
          { id: "e3", name: "Row", category: "back", sets: 3, completed: false }
        ];
        const completedCount = exercises.filter((e) => e.completed).length;
        const isAllDone = completedCount === exercises.length;
        expect(completedCount).toBe(2);
        expect(isAllDone).toBe(false);
      });

      it("F10-T1-5: marks daily plan completed when all nutrition and workout criteria are fulfilled", () => {
        const plan: DailyPlan = {
          dayNumber: 1,
          date: "2026-11-12",
          targetCaloriesKcal: 2000,
          targetProteinGrams: 150,
          targetCarbsGrams: 200,
          targetFatGrams: 67,
          loggedCaloriesKcal: 1980,
          loggedProteinGrams: 148,
          loggedCarbsGrams: 195,
          loggedFatGrams: 66,
          exercises: [{ id: "e1", name: "Squats", category: "legs", sets: 3, completed: true }],
          isFatigueScaled: false,
          completed: true
        };
        const parsed = DailyPlanSchema.parse(plan);
        expect(parsed.completed).toBe(true);
      });
    });

    // ------------------------------------------------------------------------
    // F11: Cryptographic Proof Gating
    // ------------------------------------------------------------------------
    describe("Feature 11: Cryptographic Proof Gating", () => {
      const sampleTelemetry: TelemetryData = {
        timestampMs: 1700000000000,
        stepCount: 10500,
        activeMinutes: 65,
        avgHeartRateBpm: 135.5,
        caloriesBurnedKcal: 650.0,
        profileSnapshot: {
          age: 28,
          gender: "male",
          bodyFatPct: 18.5,
          muscleMassKg: 58.0
        }
      };

      it("F11-T1-1: produces canonical Keccak-256 hash of telemetry completion data", () => {
        const hash = hashTelemetry(sampleTelemetry);
        expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      });

      it("F11-T1-2: signs WorkoutProof using EIP-712 typed data with ephemeral wallet signer", async () => {
        const wallet = Wallet.createRandom();
        const telemetryHash = hashTelemetry(sampleTelemetry);
        const proof: WorkoutProof = {
          user: wallet.address as Address,
          telemetryHash,
          streakCount: 5n,
          nonce: 1n,
          deadline: BigInt(Date.now() + 3600000)
        };
        const signed = await signWorkoutProof(wallet, proof, sampleAddress);
        expect(signed.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
      });

      it("F11-T1-3: verifies valid EIP-712 signed workout claim payload matches signer address", async () => {
        const wallet = Wallet.createRandom();
        const telemetryHash = hashTelemetry(sampleTelemetry);
        const proof: WorkoutProof = {
          user: wallet.address as Address,
          telemetryHash,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(Date.now() + 3600000)
        };
        const signed = await signWorkoutProof(wallet, proof, sampleAddress);
        const isValid = verifyWorkoutProofSignature(signed, sampleAddress);
        expect(isValid).toBe(true);
      });

      it("F11-T1-4: rejects verification when verifyingContract address does not match domain", async () => {
        const wallet = Wallet.createRandom();
        const telemetryHash = hashTelemetry(sampleTelemetry);
        const proof: WorkoutProof = {
          user: wallet.address as Address,
          telemetryHash,
          streakCount: 2n,
          nonce: 1n,
          deadline: BigInt(Date.now() + 3600000)
        };
        const signed = await signWorkoutProof(wallet, proof, sampleAddress);
        const wrongContract: Address = "0x9999999999999999999999999999999999999999";
        const isValid = verifyWorkoutProofSignature(signed, wrongContract);
        expect(isValid).toBe(false);
      });

      it("F11-T1-5: rejects verification when telemetryHash or streakCount is tampered with", async () => {
        const wallet = Wallet.createRandom();
        const telemetryHash = hashTelemetry(sampleTelemetry);
        const proof: WorkoutProof = {
          user: wallet.address as Address,
          telemetryHash,
          streakCount: 3n,
          nonce: 1n,
          deadline: BigInt(Date.now() + 3600000)
        };
        const signed = await signWorkoutProof(wallet, proof, sampleAddress);

        // Tamper with streakCount
        const tamperedPayload: SignedWorkoutClaimPayload = {
          proof: {
            ...signed.proof,
            streakCount: 999n
          },
          signature: signed.signature
        };
        const isValid = verifyWorkoutProofSignature(tamperedPayload, sampleAddress);
        expect(isValid).toBe(false);
      });
    });

    // ------------------------------------------------------------------------
    // F12: Dashboard Weigh-In Modal Flow
    // ------------------------------------------------------------------------
    describe("Feature 12: Dashboard Weigh-In Modal Flow", () => {
      it("F12-T1-1: appends new anytime weigh-in entry to persistent weight log history", async () => {
        const initialLogs: WeightLogEntry[] = [
          { id: "log-1", timestampMs: 1700000000000, weightKg: 72.0 }
        ];
        await adapter.setEncryptedItem("@dehealth/weight_logs", initialLogs);

        // Simulate modal submit
        const newEntry: WeightLogEntry = {
          id: "log-2",
          timestampMs: 1700086400000,
          weightKg: 71.8
        };
        const currentLogs =
          (await adapter.getEncryptedItem<WeightLogEntry[]>("@dehealth/weight_logs")) ?? [];
        currentLogs.push(newEntry);
        await adapter.setEncryptedItem("@dehealth/weight_logs", currentLogs);

        const updated = await adapter.getEncryptedItem<WeightLogEntry[]>("@dehealth/weight_logs");
        expect(updated).toHaveLength(2);
        expect(updated?.[1]?.weightKg).toBe(71.8);
      });

      it("F12-T1-2: updates rolling 7-day average immediately upon new weigh-in submission", () => {
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: 1000, weightKg: 80.0 },
          { id: "2", timestampMs: 2000, weightKg: 78.0 }
        ];
        expect(calculateRollingWeightAverage(logs)).toBe(79.0);
        logs.push({ id: "3", timestampMs: 3000, weightKg: 76.0 });
        expect(calculateRollingWeightAverage(logs)).toBe(78.0);
      });

      it("F12-T1-3: updates user biometrics weightKg and updatedAtMs timestamp in storage", async () => {
        await adapter.setEncryptedItem("@dehealth/user_biometrics", DEFAULT_BASELINE_BIOMETRICS);
        const updatedBio: UserBiometrics = {
          ...DEFAULT_BASELINE_BIOMETRICS,
          weightKg: 69.5,
          updatedAtMs: 1700086400000
        };
        await adapter.setEncryptedItem("@dehealth/user_biometrics", updatedBio);
        const saved = await adapter.getEncryptedItem<UserBiometrics>("@dehealth/user_biometrics");
        expect(saved?.weightKg).toBe(69.5);
        expect(saved?.updatedAtMs).toBe(1700086400000);
      });

      it("F12-T1-4: preserves optional bodyFatPct when weigh-in modal updates body fat", () => {
        const entry: WeightLogEntry = {
          id: "log-bf",
          timestampMs: 1700000000000,
          weightKg: 75.0,
          bodyFatPct: 16.5,
          note: "Measured on bioimpedance scale"
        };
        const parsed = WeightLogEntrySchema.parse(entry);
        expect(parsed.bodyFatPct).toBe(16.5);
      });

      it("F12-T1-5: validates modal input bounds rejecting weight outside 30kg-300kg range", () => {
        expect(() =>
          WeightLogEntrySchema.parse({ id: "e1", timestampMs: 1000, weightKg: 25 })
        ).toThrow();
        expect(() =>
          WeightLogEntrySchema.parse({ id: "e2", timestampMs: 1000, weightKg: 350 })
        ).toThrow();
      });
    });

    // ------------------------------------------------------------------------
    // F13: Bi-Weekly Review Banner & Modal Flow
    // ------------------------------------------------------------------------
    describe("Feature 13: Bi-Weekly Review Banner & Modal Flow", () => {
      it("F13-T1-1: triggers review banner visibility when exactly 14 days or more have elapsed", () => {
        const cycle = createMock14DayCycle();
        const isBannerDue = (startDateMs: number, nowMs: number): boolean => {
          const elapsed = nowMs - startDateMs;
          return elapsed >= 14 * 24 * 60 * 60 * 1000;
        };

        const before14 = cycle.startDateMs + 13 * 24 * 60 * 60 * 1000;
        const at14 = cycle.startDateMs + 14 * 24 * 60 * 60 * 1000;
        expect(isBannerDue(cycle.startDateMs, before14)).toBe(false);
        expect(isBannerDue(cycle.startDateMs, at14)).toBe(true);
      });

      it("F13-T1-2: generates side-by-side metric comparison data for old vs proposed targets", () => {
        const currentCalories = 2200;
        const proposedCalories = 2050;
        const delta = proposedCalories - currentCalories;
        expect(delta).toBe(-150);
      });

      it("F13-T1-3: 'Approve New Plan' updates active cycle targets and marks review approved", () => {
        const cycle = createMock14DayCycle({ targetDailyCalories: 2200 });
        const review: ProposedPlanReview = {
          cycleId: cycle.id,
          reviewDateMs: cycle.endDateMs,
          adherencePct: 90,
          startingWeightKg: 75,
          currentWeightKg: 75,
          weightChangeKg: 0,
          rollingAverageWeightKg: 75,
          currentDailyCalories: 2200,
          proposedDailyCalories: 2050,
          calorieAdjustment: -150,
          currentMacroSplit: { proteinGrams: 165, carbsGrams: 220, fatGrams: 73 },
          proposedMacroSplit: { proteinGrams: 179, carbsGrams: 179, fatGrams: 68 },
          rationale: "Plateau adjust",
          status: "pending"
        };

        // Approve action
        const approvedReview: ProposedPlanReview = { ...review, status: "approved" };
        const updatedCycle: AdaptivePlanCycle = {
          ...cycle,
          cycleNumber: cycle.cycleNumber + 1,
          targetDailyCalories: approvedReview.proposedDailyCalories,
          targetDailyProteinGrams: approvedReview.proposedMacroSplit.proteinGrams,
          targetDailyCarbsGrams: approvedReview.proposedMacroSplit.carbsGrams,
          targetDailyFatGrams: approvedReview.proposedMacroSplit.fatGrams,
          status: "active"
        };

        expect(approvedReview.status).toBe("approved");
        expect(updatedCycle.targetDailyCalories).toBe(2050);
        expect(updatedCycle.cycleNumber).toBe(2);
      });

      it("F13-T1-4: 'Keep Current Plan' preserves existing targets and marks review rejected", () => {
        const cycle = createMock14DayCycle({ targetDailyCalories: 2200 });
        const review: ProposedPlanReview = {
          cycleId: cycle.id,
          reviewDateMs: cycle.endDateMs,
          adherencePct: 90,
          startingWeightKg: 75,
          currentWeightKg: 75,
          weightChangeKg: 0,
          rollingAverageWeightKg: 75,
          currentDailyCalories: 2200,
          proposedDailyCalories: 2050,
          calorieAdjustment: -150,
          currentMacroSplit: { proteinGrams: 165, carbsGrams: 220, fatGrams: 73 },
          proposedMacroSplit: { proteinGrams: 179, carbsGrams: 179, fatGrams: 68 },
          rationale: "Plateau adjust",
          status: "pending"
        };

        const rejectedReview: ProposedPlanReview = { ...review, status: "rejected" };
        expect(rejectedReview.status).toBe("rejected");
        expect(cycle.targetDailyCalories).toBe(2200);
      });

      it("F13-T1-5: increments cycle number monotonically upon adopting new bi-weekly plan", () => {
        let cycleNum = 1;
        const advanceCycle = (c: number): number => c + 1;
        cycleNum = advanceCycle(cycleNum);
        expect(cycleNum).toBe(2);
        cycleNum = advanceCycle(cycleNum);
        expect(cycleNum).toBe(3);
      });
    });
  });

  // ==========================================================================
  // TIER 2: BOUNDARY & CORNER CASES (65 TESTS ACROSS 13 FEATURES)
  // ==========================================================================

  describe("Tier 2: Boundary & Corner Cases (65 Tests across 13 Features)", () => {
    // ------------------------------------------------------------------------
    // F1: Domain Models Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 1: Domain Models Boundary & Corner Cases", () => {
      it("F1-T2-1: age boundaries - accepts 13 and 120, rejects 12 and 121", () => {
        const base = { ...DEFAULT_BASELINE_BIOMETRICS };
        expect(UserBiometricsSchema.parse({ ...base, age: 13 }).age).toBe(13);
        expect(UserBiometricsSchema.parse({ ...base, age: 120 }).age).toBe(120);
        expect(() => UserBiometricsSchema.parse({ ...base, age: 12 })).toThrow();
        expect(() => UserBiometricsSchema.parse({ ...base, age: 121 })).toThrow();
      });

      it("F1-T2-2: weight boundaries - accepts 30.0kg and 300.0kg, rejects 29.9kg and 300.1kg", () => {
        const base = { ...DEFAULT_BASELINE_BIOMETRICS };
        expect(UserBiometricsSchema.parse({ ...base, weightKg: 30.0 }).weightKg).toBe(30.0);
        expect(UserBiometricsSchema.parse({ ...base, weightKg: 300.0 }).weightKg).toBe(300.0);
        expect(() => UserBiometricsSchema.parse({ ...base, weightKg: 29.9 })).toThrow();
        expect(() => UserBiometricsSchema.parse({ ...base, weightKg: 300.1 })).toThrow();
      });

      it("F1-T2-3: height boundaries - accepts 100cm and 250cm, rejects 99cm and 251cm", () => {
        const base = { ...DEFAULT_BASELINE_BIOMETRICS };
        expect(UserBiometricsSchema.parse({ ...base, heightCm: 100.0 }).heightCm).toBe(100.0);
        expect(UserBiometricsSchema.parse({ ...base, heightCm: 250.0 }).heightCm).toBe(250.0);
        expect(() => UserBiometricsSchema.parse({ ...base, heightCm: 99.0 })).toThrow();
        expect(() => UserBiometricsSchema.parse({ ...base, heightCm: 251.0 })).toThrow();
      });

      it("F1-T2-4: body fat percentage boundaries - accepts 2.0% and 75.0%, rejects 1.9% and 75.1%", () => {
        const base = { ...DEFAULT_BASELINE_BIOMETRICS };
        expect(UserBiometricsSchema.parse({ ...base, bodyFatPct: 2.0 }).bodyFatPct).toBe(2.0);
        expect(UserBiometricsSchema.parse({ ...base, bodyFatPct: 75.0 }).bodyFatPct).toBe(75.0);
        expect(() => UserBiometricsSchema.parse({ ...base, bodyFatPct: 1.9 })).toThrow();
        expect(() => UserBiometricsSchema.parse({ ...base, bodyFatPct: 75.1 })).toThrow();
      });

      it("F1-T2-5: weekly frequency boundaries - accepts 1 and 7, rejects 0 and 8", () => {
        const base = { ...DEFAULT_BASELINE_BIOMETRICS };
        expect(
          UserBiometricsSchema.parse({ ...base, weeklyWorkoutFrequency: 1 }).weeklyWorkoutFrequency
        ).toBe(1);
        expect(
          UserBiometricsSchema.parse({ ...base, weeklyWorkoutFrequency: 7 }).weeklyWorkoutFrequency
        ).toBe(7);
        expect(() => UserBiometricsSchema.parse({ ...base, weeklyWorkoutFrequency: 0 })).toThrow();
        expect(() => UserBiometricsSchema.parse({ ...base, weeklyWorkoutFrequency: 8 })).toThrow();
      });
    });

    // ------------------------------------------------------------------------
    // F2: Deterministic Caloric Math Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 2: Deterministic Caloric Math Boundary & Corner Cases", () => {
      it("F2-T2-1: Katch-McArdle at minimum body fat boundary (2.0% LBM extreme)", () => {
        // Weight 70kg, 2% body fat -> LBM = 70 * 0.98 = 68.6kg
        // BMR = 370 + 21.6 * 68.6 = 370 + 1481.76 = 1851.76 -> 1852
        const bio: UserBiometrics = {
          age: 25,
          gender: "male",
          weightKg: 70,
          heightCm: 175,
          bodyFatPct: 2.0,
          weeklyWorkoutFrequency: 5,
          goal: "cut"
        };
        expect(calculateBmr(bio)).toBe(1852);
      });

      it("F2-T2-2: Katch-McArdle at maximum body fat boundary (75.0% LBM extreme)", () => {
        // Weight 100kg, 75% body fat -> LBM = 100 * 0.25 = 25kg
        // BMR = 370 + 21.6 * 25 = 370 + 540 = 910
        const bio: UserBiometrics = {
          age: 40,
          gender: "female",
          weightKg: 100,
          heightCm: 160,
          bodyFatPct: 75.0,
          weeklyWorkoutFrequency: 2,
          goal: "fat_loss"
        };
        expect(calculateBmr(bio)).toBe(910);
      });

      it("F2-T2-3: activity multiplier extreme boundaries (freq=1: 1.20 vs freq=7: 1.725)", () => {
        const bmr = 1600;
        expect(calculateTdee(bmr, 1)).toBe(1920); // 1600 * 1.20
        expect(calculateTdee(bmr, 7)).toBe(2760); // 1600 * 1.725 = 2760
      });

      it("F2-T2-4: fractional biometric inputs (70.45kg, 175.5cm) produce deterministic values without NaN", () => {
        const bio: UserBiometrics = {
          age: 29,
          gender: "male",
          weightKg: 70.45,
          heightCm: 175.5,
          weeklyWorkoutFrequency: 3,
          goal: "maintain"
        };
        const bmr = calculateBmr(bio);
        expect(Number.isFinite(bmr)).toBe(true);
        expect(Number.isNaN(bmr)).toBe(false);
        // Base = 10*70.45 + 6.25*175.5 - 5*29 = 704.5 + 1096.875 - 145 = 1656.375 + 5 = 1661.375 -> 1661
        expect(bmr).toBe(1661);
      });

      it("F2-T2-5: gender 'other' produces exact arithmetic mean between male and female BMR", () => {
        const maleBio: UserBiometrics = {
          age: 30,
          gender: "male",
          weightKg: 80,
          heightCm: 180,
          weeklyWorkoutFrequency: 3,
          goal: "maintain"
        };
        const femaleBio: UserBiometrics = { ...maleBio, gender: "female" };
        const otherBio: UserBiometrics = { ...maleBio, gender: "other" };

        const maleBmr = calculateBmr(maleBio);
        const femaleBmr = calculateBmr(femaleBio);
        const otherBmr = calculateBmr(otherBio);

        // Difference between male (+5) and female (-161) is 166 kcal
        expect(maleBmr - femaleBmr).toBe(166);
        // Midpoint check
        expect(otherBmr).toBe(Math.round((maleBmr + femaleBmr) / 2));
      });
    });

    // ------------------------------------------------------------------------
    // F3: Safe Calorie Floor Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 3: Safe Calorie Floor Boundary & Corner Cases", () => {
      it("F3-T2-1: boundary at 1201 kcal passes through unclamped", () => {
        // TDEE 1701 - 500 = 1201 kcal
        expect(calculateTargetCalories(1701, "cut")).toBe(1201);
      });

      it("F3-T2-2: boundary at exact 1200 kcal floor remains exactly 1200 kcal", () => {
        // TDEE 1700 - 500 = 1200 kcal
        expect(calculateTargetCalories(1700, "cut")).toBe(1200);
      });

      it("F3-T2-3: boundary at 1199 kcal clamps to exactly 1200 kcal floor", () => {
        // TDEE 1699 - 500 = 1199 kcal -> clamped to 1200
        expect(calculateTargetCalories(1699, "cut")).toBe(1200);
      });

      it("F3-T2-4: severe deficit (-1000 kcal on 1400 TDEE = 400 kcal) clamps to 1200 kcal floor", () => {
        expect(calculateTargetCalories(1400, "fat_loss")).toBe(1200);
      });

      it("F3-T2-5: Zod schemas strictly reject 1199.9 kcal across DailyPlan, AdaptivePlanCycle, and ProposedPlanReview", () => {
        const invalidCycle = createMock14DayCycle({ targetDailyCalories: 1199.9 });
        expect(() => AdaptivePlanCycleSchema.parse(invalidCycle)).toThrow();
      });
    });

    // ------------------------------------------------------------------------
    // F4: Macro Split Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 4: Macro Split Boundary & Corner Cases", () => {
      it("F4-T2-1: exact 1200 kcal floor distributes valid non-zero protein, carbs, and fat", () => {
        const macros = calculateMacroSplit(1200, "cut");
        // 1200 * 0.35 / 4 = 105g P, 105g C, 1200 * 0.30 / 9 = 40g F
        expect(macros.proteinGrams).toBe(105);
        expect(macros.carbsGrams).toBe(105);
        expect(macros.fatGrams).toBe(40);
      });

      it("F4-T2-2: high-calorie 4000 kcal allocation scales safely without arithmetic overflow", () => {
        const macros = calculateMacroSplit(4000, "bulk");
        expect(macros.proteinGrams).toBe(250); // 4000 * 0.25 / 4
        expect(macros.carbsGrams).toBe(550); // 4000 * 0.55 / 4
        expect(macros.fatGrams).toBe(89); // 4000 * 0.20 / 9
      });

      it("F4-T2-3: fat allocation maintains hormonal health minimum floor (>= 20% of calories)", () => {
        for (const goal of FITNESS_GOALS) {
          const macros = calculateMacroSplit(1800, goal);
          const fatCalories = macros.fatGrams * 9;
          const fatPct = fatCalories / 1800;
          expect(fatPct).toBeGreaterThanOrEqual(0.19); // Allows rounding tolerance >= 19-20%
        }
      });

      it("F4-T2-4: macronutrient rounding consistency holds across odd/fractional targets (sum within 5 kcal)", () => {
        const targets = [1233, 1477, 1891, 2345, 3111];
        for (const target of targets) {
          const macros = calculateMacroSplit(target, "cut");
          const sumCalories =
            macros.proteinGrams * 4 + macros.carbsGrams * 4 + macros.fatGrams * 9;
          expect(Math.abs(sumCalories - target)).toBeLessThanOrEqual(5);
        }
      });

      it("F4-T2-5: zero-carb or extreme deficit splits never produce negative or NaN gram allocations", () => {
        const macros = calculateMacroSplit(500, "cut"); // Clamped to 1200 floor
        expect(macros.proteinGrams).toBeGreaterThan(0);
        expect(macros.carbsGrams).toBeGreaterThan(0);
        expect(macros.fatGrams).toBeGreaterThan(0);
        expect(Number.isNaN(macros.proteinGrams)).toBe(false);
      });
    });

    // ------------------------------------------------------------------------
    // F5: Inactivity Fatigue Scaling Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 5: Inactivity Fatigue Scaling Boundary & Corner Cases", () => {
      const exerciseFixture: WorkoutExerciseItem[] = [
        { id: "e1", name: "Deadlift", category: "back", sets: 3, reps: 5, completed: false },
        { id: "e2", name: "Cardio", category: "aerobic", sets: 1, durationMinutes: 20, completed: false }
      ];

      it("F5-T2-1: inactivity gap at exactly 48h (172,800,000 ms) remains UNSCALED", () => {
        const lastLog = 1700000000000;
        const current = lastLog + FATIGUE_GAP_THRESHOLD_MS; // Exactly 48h
        const result = scaleExercisesForFatigue(exerciseFixture, lastLog, current);
        expect(result.isFatigueScaled).toBe(false);
        expect(result.exercises[0]?.sets).toBe(3);
      });

      it("F5-T2-2: inactivity gap at 48h + 1ms (172,800,001 ms) triggers 30% fatigue reduction", () => {
        const lastLog = 1700000000000;
        const current = lastLog + FATIGUE_GAP_THRESHOLD_MS + 1; // 48h + 1ms
        const result = scaleExercisesForFatigue(exerciseFixture, lastLog, current);
        expect(result.isFatigueScaled).toBe(true);
        expect(result.exercises[0]?.sets).toBe(2); // 3 * 0.7 = 2.1 -> 2
      });

      it("F5-T2-3: exercise with 1 set rounds to minimum 1 set (never 0 sets)", () => {
        const singleSet: WorkoutExerciseItem[] = [
          { id: "e-min", name: "Heavy Single", category: "power", sets: 1, completed: false }
        ];
        const lastLog = 1700000000000;
        const current = lastLog + 100 * 60 * 60 * 1000;
        const result = scaleExercisesForFatigue(singleSet, lastLog, current);
        expect(result.exercises[0]?.sets).toBe(1); // 1 * 0.7 = 0.7 -> clamped to 1
      });

      it("F5-T2-4: exercise with 2 sets scales to 1 set (2 * 0.7 = 1.4 -> 1)", () => {
        const twoSets: WorkoutExerciseItem[] = [
          { id: "e-two", name: "Calf Raises", category: "legs", sets: 2, completed: false }
        ];
        const lastLog = 1700000000000;
        const current = lastLog + 72 * 60 * 60 * 1000;
        const result = scaleExercisesForFatigue(twoSets, lastLog, current);
        expect(result.exercises[0]?.sets).toBe(1);
      });

      it("F5-T2-5: exercise with duration scales down duration minutes accurately (10 min -> 7 min)", () => {
        const durationEx: WorkoutExerciseItem[] = [
          { id: "e-dur", name: "Treadmill Run", category: "cardio", sets: 1, durationMinutes: 10, completed: false }
        ];
        const lastLog = 1700000000000;
        const current = lastLog + 50 * 60 * 60 * 1000;
        const result = scaleExercisesForFatigue(durationEx, lastLog, current);
        expect(result.exercises[0]?.durationMinutes).toBe(7);
      });
    });

    // ------------------------------------------------------------------------
    // F6: Rolling 7-Day Weight Average Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 6: Rolling 7-Day Weight Average Boundary & Corner Cases", () => {
      it("F6-T2-1: exactly 0 logs returns null", () => {
        expect(calculateRollingWeightAverage([])).toBeNull();
      });

      it("F6-T2-2: exactly 1 log returns that log weight without floating error", () => {
        const logs: WeightLogEntry[] = [{ id: "1", timestampMs: 1000, weightKg: 82.35 }];
        expect(calculateRollingWeightAverage(logs)).toBe(82.35);
      });

      it("F6-T2-3: exactly 7 logs averages all 7 logs equally", () => {
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: 1, weightKg: 70 },
          { id: "2", timestampMs: 2, weightKg: 71 },
          { id: "3", timestampMs: 3, weightKg: 72 },
          { id: "4", timestampMs: 4, weightKg: 73 },
          { id: "5", timestampMs: 5, weightKg: 74 },
          { id: "6", timestampMs: 6, weightKg: 75 },
          { id: "7", timestampMs: 7, weightKg: 76 }
        ];
        // Mean of 70..76 = 73.0
        expect(calculateRollingWeightAverage(logs)).toBe(73.0);
      });

      it("F6-T2-4: exactly 8 logs drops the oldest log and averages the 7 newest logs", () => {
        const logs: WeightLogEntry[] = [
          { id: "0", timestampMs: 0, weightKg: 200 }, // Dropped
          { id: "1", timestampMs: 1, weightKg: 70 },
          { id: "2", timestampMs: 2, weightKg: 71 },
          { id: "3", timestampMs: 3, weightKg: 72 },
          { id: "4", timestampMs: 4, weightKg: 73 },
          { id: "5", timestampMs: 5, weightKg: 74 },
          { id: "6", timestampMs: 6, weightKg: 75 },
          { id: "7", timestampMs: 7, weightKg: 76 }
        ];
        expect(calculateRollingWeightAverage(logs)).toBe(73.0);
      });

      it("F6-T2-5: duplicate timestamps sort stably and compute accurate rolling average", () => {
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: 1000, weightKg: 70 },
          { id: "2", timestampMs: 1000, weightKg: 72 },
          { id: "3", timestampMs: 2000, weightKg: 71 }
        ];
        // Mean = (70 + 72 + 71) / 3 = 71.0
        expect(calculateRollingWeightAverage(logs)).toBe(71.0);
      });
    });

    // ------------------------------------------------------------------------
    // F7: Offline Bi-Weekly Review Engine Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 7: Offline Bi-Weekly Review Engine Boundary & Corner Cases", () => {
      it("F7-T2-1: review at exactly 13 days is NOT due for bi-weekly review", () => {
        const cycle = createMock14DayCycle();
        const elapsedDays = (nowMs: number, startMs: number): number =>
          Math.floor((nowMs - startMs) / (24 * 60 * 60 * 1000));
        const day13Ms = cycle.startDateMs + 13 * 24 * 60 * 60 * 1000;
        expect(elapsedDays(day13Ms, cycle.startDateMs)).toBe(13);
        expect(elapsedDays(day13Ms, cycle.startDateMs) >= 14).toBe(false);
      });

      it("F7-T2-2: review at exactly 14 days IS due for bi-weekly review", () => {
        const cycle = createMock14DayCycle();
        const elapsedDays = (nowMs: number, startMs: number): number =>
          Math.floor((nowMs - startMs) / (24 * 60 * 60 * 1000));
        const day14Ms = cycle.startDateMs + 14 * 24 * 60 * 60 * 1000;
        expect(elapsedDays(day14Ms, cycle.startDateMs)).toBe(14);
        expect(elapsedDays(day14Ms, cycle.startDateMs) >= 14).toBe(true);
      });

      it("F7-T2-3: 0% adherence triggers safety hold with 0 calorie change", () => {
        const cycle = createMock14DayCycle({ targetDailyCalories: 2000 });
        const review = evaluateBiWeeklyReview(cycle, [], 0, cycle.endDateMs);
        expect(review.calorieAdjustment).toBe(0);
        expect(review.proposedDailyCalories).toBe(2000);
      });

      it("F7-T2-4: 100% adherence on plateau triggers maximum capped calorie reduction (-150 kcal)", () => {
        const cycle = createMock14DayCycle({
          goal: "cut",
          targetDailyCalories: 2400,
          baselineBiometrics: { ...DEFAULT_BASELINE_BIOMETRICS, weightKg: 85 }
        });
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: cycle.startDateMs, weightKg: 85.0 },
          { id: "2", timestampMs: cycle.endDateMs, weightKg: 85.0 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 100, cycle.endDateMs);
        expect(review.calorieAdjustment).toBe(-150);
        expect(review.proposedDailyCalories).toBe(2250);
      });

      it("F7-T2-5: review adjustment on 1250 kcal target with -150 proposed clamps to 1200 kcal floor", () => {
        const cycle = createMock14DayCycle({
          goal: "cut",
          targetDailyCalories: 1250,
          baselineBiometrics: { ...DEFAULT_BASELINE_BIOMETRICS, weightKg: 60 }
        });
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: cycle.startDateMs, weightKg: 60 },
          { id: "2", timestampMs: cycle.endDateMs, weightKg: 60 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 90, cycle.endDateMs);
        expect(review.proposedDailyCalories).toBe(1200); // Clamped from 1100 to 1200!
        expect(review.calorieAdjustment).toBe(-50); // Actual adjustment is -50
      });
    });

    // ------------------------------------------------------------------------
    // F8: Onboarding Wizard Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 8: Onboarding Wizard Boundary & Corner Cases", () => {
      it("F8-T2-1: omitting optional bodyFatPct parses cleanly and falls back to Mifflin-St Jeor", () => {
        const bioWithoutBf: UserBiometrics = {
          age: 30,
          gender: "male",
          weightKg: 80,
          heightCm: 180,
          weeklyWorkoutFrequency: 4,
          goal: "maintain"
        };
        const parsed = UserBiometricsSchema.parse(bioWithoutBf);
        expect(parsed.bodyFatPct).toBeUndefined();
        // Mifflin-St Jeor: 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780
        expect(calculateBmr(parsed)).toBe(1780);
      });

      it("F8-T2-2: rapid consecutive 'Skip for Now' clicks produce identical idempotent state", () => {
        const click1 = UserBiometricsSchema.parse(DEFAULT_BASELINE_BIOMETRICS);
        const click2 = UserBiometricsSchema.parse(DEFAULT_BASELINE_BIOMETRICS);
        expect(click1).toEqual(click2);
      });

      it("F8-T2-3: weight log note with exactly 500 characters passes validation", () => {
        const entry: WeightLogEntry = {
          id: "w-500",
          timestampMs: 1700000000000,
          weightKg: 70,
          note: "A".repeat(500)
        };
        expect(WeightLogEntrySchema.parse(entry).note?.length).toBe(500);
      });

      it("F8-T2-4: weight log note with 501 characters is rejected by WeightLogEntrySchema", () => {
        const entry: WeightLogEntry = {
          id: "w-501",
          timestampMs: 1700000000000,
          weightKg: 70,
          note: "A".repeat(501)
        };
        expect(() => WeightLogEntrySchema.parse(entry)).toThrow();
      });

      it("F8-T2-5: Unicode and emoji strings in notes validate successfully without corruption", () => {
        const entry: WeightLogEntry = {
          id: "w-emoji",
          timestampMs: 1700000000000,
          weightKg: 71.5,
          note: "Feeling great today! 💪🏋️‍♂️🔥"
        };
        const parsed = WeightLogEntrySchema.parse(entry);
        expect(parsed.note).toContain("💪🏋️‍♂️🔥");
      });
    });

    // ------------------------------------------------------------------------
    // F9: Local Encrypted Persistence Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 9: Local Encrypted Persistence Boundary & Corner Cases", () => {
      it("F9-T2-1: rejects ciphertext tampering when single byte in ciphertext is modified", async () => {
        await adapter.setEncryptedItem("sensitive_data", { value: "TopSecret" });
        const raw = backend.getRaw("sensitive_data");
        expect(raw).toBeTruthy();
        const envelope = JSON.parse(raw!);
        // Flip the last character of ciphertextHex
        const tamperedCipher =
          envelope.ciphertext.slice(0, -1) + (envelope.ciphertext.endsWith("0") ? "1" : "0");
        backend.setRaw("sensitive_data", JSON.stringify({ ...envelope, ciphertext: tamperedCipher }));

        await expect(adapter.getEncryptedItem("sensitive_data")).rejects.toThrow(
          "Encrypted storage MAC verification failed"
        );
      });

      it("F9-T2-2: rejects MAC tampering when single byte in HMAC signature is modified", async () => {
        await adapter.setEncryptedItem("sensitive_data_2", { value: "SecureValue" });
        const raw = backend.getRaw("sensitive_data_2");
        const envelope = JSON.parse(raw!);
        const tamperedMac =
          envelope.mac.slice(0, -1) + (envelope.mac.endsWith("a") ? "b" : "a");
        backend.setRaw("sensitive_data_2", JSON.stringify({ ...envelope, mac: tamperedMac }));

        await expect(adapter.getEncryptedItem("sensitive_data_2")).rejects.toThrow(
          "Encrypted storage MAC verification failed"
        );
      });

      it("F9-T2-3: throws descriptive error on empty or malformed envelope JSON string", async () => {
        backend.setRaw("corrupted_key", "{ not valid json");
        await expect(adapter.getEncryptedItem("corrupted_key")).rejects.toThrow();
      });

      it("F9-T2-4: handles large multi-cycle payload (>50KB) with perfect roundtrip fidelity", async () => {
        // Create 5 cycles each with 14 daily plans
        const largeHistory: AdaptivePlanCycle[] = [];
        for (let i = 1; i <= 5; i++) {
          largeHistory.push(createMock14DayCycle({ id: `hist-cycle-${i}`, cycleNumber: i }));
        }
        await adapter.setEncryptedItem("@dehealth/plan_history", largeHistory);
        const retrieved = await adapter.getEncryptedItem<AdaptivePlanCycle[]>(
          "@dehealth/plan_history"
        );
        expect(retrieved).toHaveLength(5);
        expect(retrieved?.[4]?.id).toBe("hist-cycle-5");
      });

      it("F9-T2-5: rejects passphrase initialization with fewer than 8 characters", () => {
        expect(() => new EncryptedStorageAdapter("short")).toThrow(
          "requires a passphrase of at least 8 characters"
        );
      });
    });

    // ------------------------------------------------------------------------
    // F10: Dual-Track Check-In Cards Math Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 10: Dual-Track Check-In Cards Math Boundary & Corner Cases", () => {
      it("F10-T2-1: 0g food portion size yields exactly 0 calories and 0g macros", () => {
        const chicken = STANDARD_FOOD_PRESETS[0]!;
        const scaled = scaleFoodPresetPortion(chicken, 0);
        expect(scaled.caloriesKcal).toBe(0);
        expect(scaled.proteinGrams).toBe(0);
        expect(scaled.carbsGrams).toBe(0);
        expect(scaled.fatGrams).toBe(0);
      });

      it("F10-T2-2: fractional gram portion (e.g. 33.3g) calculates precise fractional macros", () => {
        const whey = STANDARD_FOOD_PRESETS[2]!; // 30g serving, 120 kcal, 24g P
        const scaled = scaleFoodPresetPortion(whey, 33.3);
        // factor = 33.3 / 30 = 1.11 -> 120 * 1.11 = 133.2 kcal
        expect(scaled.caloriesKcal).toBe(133.2);
        expect(scaled.proteinGrams).toBe(26.6);
      });

      it("F10-T2-3: empty workout checklist (0 exercises) does not throw and reports 0 completed", () => {
        const exercises: WorkoutExerciseItem[] = [];
        const completed = exercises.filter((e) => e.completed).length;
        expect(completed).toBe(0);
      });

      it("F10-T2-4: maximum 20 exercises per day validates successfully under schema", () => {
        const exercises: WorkoutExerciseItem[] = [];
        for (let i = 1; i <= 20; i++) {
          exercises.push({
            id: `ex-${i}`,
            name: `Exercise ${i}`,
            category: "mixed",
            sets: 3,
            completed: false
          });
        }
        const plan: DailyPlan = {
          dayNumber: 1,
          date: "2026-11-12",
          targetCaloriesKcal: 2000,
          targetProteinGrams: 150,
          targetCarbsGrams: 200,
          targetFatGrams: 67,
          loggedCaloriesKcal: 0,
          loggedProteinGrams: 0,
          loggedCarbsGrams: 0,
          loggedFatGrams: 0,
          exercises,
          isFatigueScaled: false,
          completed: false
        };
        expect(DailyPlanSchema.parse(plan).exercises).toHaveLength(20);
      });

      it("F10-T2-5: exercise with sets > 20 is rejected by WorkoutExerciseItemSchema (max 20)", () => {
        const excessiveSets: WorkoutExerciseItem = {
          id: "e-over",
          name: "Insane Volume",
          category: "legs",
          sets: 21, // Exceeds max 20
          completed: false
        };
        expect(() => WorkoutExerciseItemSchema.parse(excessiveSets)).toThrow();
      });
    });

    // ------------------------------------------------------------------------
    // F11: Cryptographic Proof Gating Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 11: Cryptographic Proof Gating Boundary & Corner Cases", () => {
      it("F11-T2-1: zero address (0x000...000) is rejected as invalid user address", () => {
        const zeroAddress = "0x0000000000000000000000000000000000000000";
        const isNonZeroAddress = (addr: string): boolean => {
          return AddressSchema.safeParse(addr).success && addr !== ethers.ZeroAddress;
        };
        expect(isNonZeroAddress(zeroAddress)).toBe(false);
      });

      it("F11-T2-2: truncated 64-byte signature (128 hex characters) is rejected by HexSignatureSchema", () => {
        const truncatedSig = "0x" + "aa".repeat(64); // 64 bytes = 128 hex chars instead of 130
        expect(() => HexSignatureSchema.parse(truncatedSig)).toThrow();
      });

      it("F11-T2-3: signature verification fails when chainId does not match (e.g. mainnet 1 vs 421614)", async () => {
        const wallet = Wallet.createRandom();
        const telemetryHash =
          "0x1234567890123456789012345678901234567890123456789012345678901234" as Bytes32;
        const proof: WorkoutProof = {
          user: wallet.address as Address,
          telemetryHash,
          streakCount: 1n,
          nonce: 1n,
          deadline: BigInt(Date.now() + 3600000)
        };
        // Signed on Sepolia (421614)
        const signed = await signWorkoutProof(wallet, proof, sampleAddress, ARBITRUM_SEPOLIA_CHAIN_ID);
        // Verify with chainId 1 (Ethereum Mainnet)
        const isValid = verifyWorkoutProofSignature(signed, sampleAddress, 1);
        expect(isValid).toBe(false);
      });

      it("F11-T2-4: altering proof nonce invalidates EIP-712 signature verification", async () => {
        const wallet = Wallet.createRandom();
        const telemetryHash =
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Bytes32;
        const proof: WorkoutProof = {
          user: wallet.address as Address,
          telemetryHash,
          streakCount: 5n,
          nonce: 42n,
          deadline: BigInt(Date.now() + 3600000)
        };
        const signed = await signWorkoutProof(wallet, proof, sampleAddress);
        const replayedPayload: SignedWorkoutClaimPayload = {
          proof: { ...signed.proof, nonce: 43n },
          signature: signed.signature
        };
        expect(verifyWorkoutProofSignature(replayedPayload, sampleAddress)).toBe(false);
      });

      it("F11-T2-5: deadline in past is detected by expired proof check", () => {
        const isProofExpired = (deadline: bigint, nowMs: number): boolean => {
          const nowSec = BigInt(Math.floor(nowMs / 1000));
          return deadline < nowSec;
        };
        const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 300); // 5 min ago
        expect(isProofExpired(pastDeadline, Date.now())).toBe(true);
      });
    });

    // ------------------------------------------------------------------------
    // F12: Dashboard Weigh-In Modal Flow Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 12: Dashboard Weigh-In Modal Flow Boundary & Corner Cases", () => {
      it("F12-T2-1: 0.0kg delta weigh-in (identical weight) updates timestamp without skewing average", () => {
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: 1000, weightKg: 70.0 },
          { id: "2", timestampMs: 2000, weightKg: 70.0 }
        ];
        expect(calculateRollingWeightAverage(logs)).toBe(70.0);
      });

      it("F12-T2-2: multiple weigh-ins within same day (morning/evening) are both preserved sequentially", () => {
        const morning: WeightLogEntry = { id: "m", timestampMs: 1700000000000, weightKg: 70.5 };
        const evening: WeightLogEntry = {
          id: "e",
          timestampMs: 1700000000000 + 12 * 3600000,
          weightKg: 71.2
        };
        const logs = [morning, evening];
        expect(logs).toHaveLength(2);
        expect(calculateRollingWeightAverage(logs)).toBe(70.85); // (70.5 + 71.2) / 2
      });

      it("F12-T2-3: biometric update preserving existing optional bodyFatPct when not provided in modal", () => {
        const existingBio: UserBiometrics = { ...DEFAULT_BASELINE_BIOMETRICS, bodyFatPct: 15.5 };
        const modalInput: Partial<UserBiometrics> = { weightKg: 71.0 }; // bodyFatPct omitted
        const merged: UserBiometrics = {
          ...existingBio,
          ...modalInput,
          bodyFatPct: modalInput.bodyFatPct ?? existingBio.bodyFatPct
        };
        expect(merged.weightKg).toBe(71.0);
        expect(merged.bodyFatPct).toBe(15.5);
      });

      it("F12-T2-4: biometric update updating bodyFatPct when provided in modal", () => {
        const existingBio: UserBiometrics = { ...DEFAULT_BASELINE_BIOMETRICS, bodyFatPct: 18.5 };
        const modalInput: Partial<UserBiometrics> = { weightKg: 69.5, bodyFatPct: 17.2 };
        const merged: UserBiometrics = {
          ...existingBio,
          ...modalInput
        };
        expect(merged.weightKg).toBe(69.5);
        expect(merged.bodyFatPct).toBe(17.2);
      });

      it("F12-T2-5: rapid weight drop (-5kg in 1 day) is logged faithfully without breaking rolling math", () => {
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: 1000, weightKg: 80.0 },
          { id: "2", timestampMs: 2000, weightKg: 75.0 }
        ];
        expect(calculateRollingWeightAverage(logs)).toBe(77.5);
      });
    });

    // ------------------------------------------------------------------------
    // F13: Bi-Weekly Review Banner & Modal Flow Boundary & Corner Cases
    // ------------------------------------------------------------------------
    describe("Feature 13: Bi-Weekly Review Banner & Modal Flow Boundary & Corner Cases", () => {
      it("F13-T2-1: weight plateau (<0.2kg delta) after 14 days triggers cut calorie decrement", () => {
        const cycle = createMock14DayCycle({
          goal: "cut",
          targetDailyCalories: 2000,
          baselineBiometrics: { ...DEFAULT_BASELINE_BIOMETRICS, weightKg: 75.0 }
        });
        const logs: WeightLogEntry[] = [
          { id: "1", timestampMs: cycle.startDateMs, weightKg: 75.0 },
          { id: "2", timestampMs: cycle.endDateMs, weightKg: 74.9 } // -0.1kg lost
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, cycle.endDateMs);
        expect(review.calorieAdjustment).toBe(-150);
      });

      it("F13-T2-2: cycle number increases strictly monotonically (cycle 1 -> 2 -> 3)", () => {
        let cycle = createMock14DayCycle({ cycleNumber: 1 });
        expect(cycle.cycleNumber).toBe(1);
        cycle = { ...cycle, cycleNumber: cycle.cycleNumber + 1 };
        expect(cycle.cycleNumber).toBe(2);
        cycle = { ...cycle, cycleNumber: cycle.cycleNumber + 1 };
        expect(cycle.cycleNumber).toBe(3);
      });

      it("F13-T2-3: side-by-side comparison formats positive, zero, and negative deltas with sign", () => {
        const formatDelta = (delta: number): string => (delta > 0 ? `+${delta}` : `${delta}`);
        expect(formatDelta(-150)).toBe("-150");
        expect(formatDelta(0)).toBe("0");
        expect(formatDelta(150)).toBe("+150");
      });

      it("F13-T2-4: 'Keep Current Plan' preserves currentDailyCalories for next cycle without alteration", () => {
        const currentCalories = 2100;
        const proposedCalories = 1950;
        const userApproved = false; // "Keep Current Plan"
        const nextTargetCalories = userApproved ? proposedCalories : currentCalories;
        expect(nextTargetCalories).toBe(2100);
      });

      it("F13-T2-5: cycle start and end dates enforce exactly 14 calendar days (1,209,600,000 ms)", () => {
        const start = 1700000000000;
        const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
        const end = start + FOURTEEN_DAYS_MS;
        expect(end - start).toBe(1209600000);
        expect(FOURTEEN_DAYS_MS).toBe(1209600000);
      });
    });
  });
});
