import {
  ACTIVITY_LEVELS,
  ActivityLevel,
  AdaptivePlanCycle,
  AdaptivePlanCycleSchema,
  Address,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32,
  DailyPlan,
  DailyPlanSchema,
  DEFAULT_BASELINE_BIOMETRICS,
  FITNESS_GOALS,
  FitnessGoal,
  FoodPresetItem,
  FoodPresetItemSchema,
  GENDER_TYPES,
  GenderType,
  MacroSplit,
  MacroSplitSchema,
  PLAN_CYCLE_STATUSES,
  PLAN_REVIEW_STATUSES,
  PlanCycleStatus,
  PlanReviewStatus,
  ProposedPlanReview,
  ProposedPlanReviewSchema,
  SignedWorkoutClaimPayload,
  STANDARD_FOOD_PRESETS,
  TelemetryData,
  TelemetryDataSchema,
  UserBiometrics,
  UserBiometricsSchema,
  UserProfile,
  WeightLogEntry,
  WeightLogEntrySchema,
  WorkoutExerciseItem,
  WorkoutExerciseItemSchema,
  WorkoutProof
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
  FATIGUE_GAP_THRESHOLD_MS,
  FATIGUE_SCALING_MULTIPLIER,
  scaleTargetForInactivityGap
} from "../../services/profileEngine";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../../storage/encryptedStorageAdapter";

// ============================================================================
// In-Memory Storage Backend for Deterministic Testing
// ============================================================================

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

// Storage key constants from PROJECT.md
export const STORAGE_KEYS = {
  USER_BIOMETRICS: "@dehealth/user_biometrics",
  WEIGHT_LOGS: "@dehealth/weight_logs",
  ACTIVE_PLAN_CYCLE: "@dehealth/active_plan_cycle",
  PLAN_HISTORY: "@dehealth/plan_history",
  DAILY_COMPLETION_STATE: "@dehealth/daily_completion_state"
} as const;

// ============================================================================
// Deterministic Physiology & Plan Engine Contract Helpers
// (Matches exact specifications in ORIGINAL_REQUEST.md & PROJECT.md)
// ============================================================================

export function calculateBmr(biometrics: UserBiometrics): number {
  const validated = UserBiometricsSchema.parse(biometrics);
  if (validated.bodyFatPct !== undefined && validated.bodyFatPct !== null) {
    // Katch-McArdle Formula: BMR = 370 + (21.6 * LBM)
    const lbm = validated.weightKg * (1 - validated.bodyFatPct / 100);
    return Math.round(370 + 21.6 * lbm);
  } else {
    // Mifflin-St Jeor Formula
    const base = 10 * validated.weightKg + 6.25 * validated.heightCm - 5 * validated.age;
    if (validated.gender === "male") {
      return Math.round(base + 5);
    } else if (validated.gender === "female") {
      return Math.round(base - 161);
    } else {
      return Math.round(base - 78);
    }
  }
}

export function calculateTdee(
  bmr: number,
  weeklyFrequency: number,
  activityLevel?: ActivityLevel
): number {
  let multiplier = 1.2;
  if (activityLevel) {
    switch (activityLevel) {
      case "sedentary":
        multiplier = 1.2;
        break;
      case "light":
        multiplier = 1.375;
        break;
      case "moderate":
        multiplier = 1.55;
        break;
      case "heavy":
        multiplier = 1.725;
        break;
      case "very_active":
        multiplier = 1.9;
        break;
    }
  } else {
    if (weeklyFrequency <= 1) multiplier = 1.2;
    else if (weeklyFrequency <= 2) multiplier = 1.375;
    else if (weeklyFrequency <= 4) multiplier = 1.55;
    else if (weeklyFrequency <= 6) multiplier = 1.725;
    else multiplier = 1.9;
  }
  return Math.round(bmr * multiplier);
}

export function calculateTargetCalories(tdee: number, goal: FitnessGoal): number {
  let target = tdee;
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
  // Safe calorie floor: never below 1200 kcal/day
  return Math.max(1200, Math.round(target));
}

export function calculateMacroSplit(targetCalories: number, goal: FitnessGoal): MacroSplit {
  const safeCalories = Math.max(1200, targetCalories);
  let pRatio = 0.3;
  let cRatio = 0.45;
  let fRatio = 0.25;

  switch (goal) {
    case "cut":
    case "fat_loss":
      pRatio = 0.4;
      cRatio = 0.35;
      fRatio = 0.25;
      break;
    case "bulk":
    case "muscle_gain":
      pRatio = 0.3;
      cRatio = 0.5;
      fRatio = 0.2;
      break;
    case "maintain":
    case "maintenance":
    default:
      pRatio = 0.3;
      cRatio = 0.45;
      fRatio = 0.25;
      break;
  }

  const proteinGrams = Math.round((safeCalories * pRatio) / 4);
  const carbsGrams = Math.round((safeCalories * cRatio) / 4);
  const fatGrams = Math.round((safeCalories * fRatio) / 9);

  return MacroSplitSchema.parse({
    proteinGrams,
    carbsGrams,
    fatGrams
  });
}

export function createDefaultExercises(
  dayNumber: number,
  isFatigued: boolean
): WorkoutExerciseItem[] {
  const baseTemplates: Array<
    Array<{
      name: string;
      category: string;
      sets: number;
      reps?: number;
      durationMinutes?: number;
    }>
  > = [
    // Day 1/4/7/10/13: Upper Body Push & Pull
    [
      { name: "Push-ups", category: "Chest", sets: 4, reps: 15 },
      { name: "Dumbbell Rows", category: "Back", sets: 4, reps: 12 },
      { name: "Overhead Shoulder Press", category: "Shoulders", sets: 3, reps: 10 },
      { name: "Plank Hold", category: "Core", sets: 3, durationMinutes: 2 }
    ],
    // Day 2/5/8/11/14: Lower Body
    [
      { name: "Bodyweight Squats", category: "Quads", sets: 4, reps: 20 },
      { name: "Romanian Deadlifts", category: "Hamstrings", sets: 4, reps: 12 },
      { name: "Walking Lunges", category: "Glutes", sets: 3, reps: 15 },
      { name: "Calf Raises", category: "Calves", sets: 3, reps: 20 }
    ],
    // Day 3/6/9/12: Cardio & Core
    [
      { name: "Brisk Jogging / Running", category: "Cardio", sets: 1, durationMinutes: 30 },
      { name: "Burpees", category: "Full Body", sets: 3, reps: 10 },
      { name: "Mountain Climbers", category: "Core", sets: 3, durationMinutes: 2 }
    ]
  ];

  const templateIndex = (dayNumber - 1) % baseTemplates.length;
  const template = baseTemplates[templateIndex]!;

  return template.map((item, idx) => {
    const sets = isFatigued ? Math.max(1, Math.round(item.sets * FATIGUE_SCALING_MULTIPLIER)) : item.sets;
    const durationMinutes = item.durationMinutes
      ? isFatigued
        ? Math.max(1, Math.round(item.durationMinutes * FATIGUE_SCALING_MULTIPLIER))
        : item.durationMinutes
      : undefined;

    return WorkoutExerciseItemSchema.parse({
      id: `ex_${dayNumber}_${idx + 1}`,
      name: item.name,
      category: item.category,
      sets,
      reps: item.reps,
      durationMinutes,
      completed: false,
      scaledForFatigue: isFatigued
    });
  });
}

export function generate14DayPlan(
  biometrics: UserBiometrics,
  startDateMs: number,
  lastLogTimestampMs: number | null = null,
  cycleNumber: number = 1
): AdaptivePlanCycle {
  const validatedBio = UserBiometricsSchema.parse(biometrics);
  const bmr = calculateBmr(validatedBio);
  const tdee = calculateTdee(
    bmr,
    validatedBio.weeklyWorkoutFrequency,
    validatedBio.activityLevel
  );
  const targetCalories = calculateTargetCalories(tdee, validatedBio.goal);
  const macroSplit = calculateMacroSplit(targetCalories, validatedBio.goal);

  const oneDayMs = 24 * 60 * 60 * 1000;
  const dailyPlans: DailyPlan[] = [];

  for (let day = 1; day <= 14; day++) {
    const dayDateMs = startDateMs + (day - 1) * oneDayMs;
    const dateStr = new Date(dayDateMs).toISOString().split("T")[0]!;

    const isFatigued =
      day === 1 && lastLogTimestampMs !== null
        ? startDateMs - lastLogTimestampMs > FATIGUE_GAP_THRESHOLD_MS
        : false;

    const exercises = createDefaultExercises(day, isFatigued);

    dailyPlans.push(
      DailyPlanSchema.parse({
        dayNumber: day,
        date: dateStr,
        targetCaloriesKcal: targetCalories,
        targetProteinGrams: macroSplit.proteinGrams,
        targetCarbsGrams: macroSplit.carbsGrams,
        targetFatGrams: macroSplit.fatGrams,
        loggedCaloriesKcal: 0,
        loggedProteinGrams: 0,
        loggedCarbsGrams: 0,
        loggedFatGrams: 0,
        exercises,
        isFatigueScaled: isFatigued,
        completed: false
      })
    );
  }

  const cycle: AdaptivePlanCycle = {
    id: `cycle_${cycleNumber}_${startDateMs}`,
    cycleNumber,
    startDateMs,
    endDateMs: startDateMs + 14 * oneDayMs,
    goal: validatedBio.goal,
    baselineBiometrics: validatedBio,
    targetDailyCalories: targetCalories,
    targetDailyProteinGrams: macroSplit.proteinGrams,
    targetDailyCarbsGrams: macroSplit.carbsGrams,
    targetDailyFatGrams: macroSplit.fatGrams,
    dailyPlans,
    status: "active"
  };

  return AdaptivePlanCycleSchema.parse(cycle);
}

export function calculateRollingWeightAverage(
  weightLogs: readonly WeightLogEntry[]
): number | null {
  if (weightLogs.length === 0) {
    return null;
  }

  const sorted = [...weightLogs].sort((a, b) => a.timestampMs - b.timestampMs);
  const recent = sorted.slice(-7);
  const sum = recent.reduce((acc, entry) => acc + entry.weightKg, 0);
  return Number((sum / recent.length).toFixed(2));
}

export function evaluateBiWeeklyReview(
  currentCycle: AdaptivePlanCycle,
  weightLogs: readonly WeightLogEntry[],
  adherencePct: number
): ProposedPlanReview {
  const cycle = AdaptivePlanCycleSchema.parse(currentCycle);
  const sortedLogs = [...weightLogs].sort((a, b) => a.timestampMs - b.timestampMs);

  const startingWeightKg =
    sortedLogs.length > 0
      ? sortedLogs[0]!.weightKg
      : cycle.baselineBiometrics.weightKg;

  const currentWeightKg =
    sortedLogs.length > 0
      ? sortedLogs[sortedLogs.length - 1]!.weightKg
      : cycle.baselineBiometrics.weightKg;

  const rollingAverageWeightKg =
    calculateRollingWeightAverage(sortedLogs) ?? currentWeightKg;
  const weightChangeKg = Number((currentWeightKg - startingWeightKg).toFixed(2));

  let calorieAdjustment = 0;
  let rationale = "";

  const goal = cycle.goal;

  if (goal === "cut" || goal === "fat_loss") {
    if (weightChangeKg <= -0.5) {
      calorieAdjustment = 0;
      rationale = `Great progress! Weight decreased by ${Math.abs(weightChangeKg)}kg. Maintain current deficit.`;
    } else if (adherencePct >= 80) {
      calorieAdjustment = -150;
      rationale = `Weight loss stalled (change: ${weightChangeKg > 0 ? "+" : ""}${weightChangeKg}kg) despite high adherence (${adherencePct}%). Decreasing daily target by 150 kcal.`;
    } else {
      calorieAdjustment = 0;
      rationale = `Adherence was ${adherencePct}%. Recommend focusing on consistency before adjusting calories.`;
    }
  } else if (goal === "bulk" || goal === "muscle_gain") {
    if (weightChangeKg >= 0.5) {
      calorieAdjustment = 0;
      rationale = `On track! Gained ${weightChangeKg}kg. Maintain current surplus.`;
    } else if (adherencePct >= 80) {
      calorieAdjustment = 150;
      rationale = `Weight gain below target (+${weightChangeKg}kg) with high adherence (${adherencePct}%). Increasing daily target by 150 kcal.`;
    } else {
      calorieAdjustment = 0;
      rationale = `Adherence was ${adherencePct}%. Focus on hitting daily targets before adjusting.`;
    }
  } else {
    // maintain / maintenance
    if (Math.abs(weightChangeKg) <= 0.5) {
      calorieAdjustment = 0;
      rationale = `Weight stable within ±0.5kg (change: ${weightChangeKg}kg). Maintain current target.`;
    } else if (weightChangeKg > 0.5) {
      calorieAdjustment = -100;
      rationale = `Weight increased by ${weightChangeKg}kg during maintenance. Adjusting target by -100 kcal.`;
    } else {
      calorieAdjustment = 100;
      rationale = `Weight dropped by ${Math.abs(weightChangeKg)}kg during maintenance. Adjusting target by +100 kcal.`;
    }
  }

  const proposedDailyCalories = Math.max(
    1200,
    cycle.targetDailyCalories + calorieAdjustment
  );
  const actualAdjustment = proposedDailyCalories - cycle.targetDailyCalories;
  const proposedMacroSplit = calculateMacroSplit(proposedDailyCalories, goal);

  const review: ProposedPlanReview = {
    cycleId: cycle.id,
    reviewDateMs: Date.now(),
    adherencePct,
    startingWeightKg,
    currentWeightKg,
    weightChangeKg,
    rollingAverageWeightKg,
    currentDailyCalories: cycle.targetDailyCalories,
    proposedDailyCalories,
    calorieAdjustment: actualAdjustment,
    currentMacroSplit: {
      proteinGrams: cycle.targetDailyProteinGrams,
      carbsGrams: cycle.targetDailyCarbsGrams,
      fatGrams: cycle.targetDailyFatGrams
    },
    proposedMacroSplit,
    rationale,
    status: "pending"
  };

  return ProposedPlanReviewSchema.parse(review);
}

export function advancePlanCycle(
  currentCycle: AdaptivePlanCycle,
  review: ProposedPlanReview,
  approved: boolean,
  startDateMs: number
): { updatedCurrentCycle: AdaptivePlanCycle; newCycle: AdaptivePlanCycle } {
  const updatedCurrentCycle: AdaptivePlanCycle = {
    ...currentCycle,
    status: approved ? "reviewed" : "completed"
  };

  const newBaselineBio: UserBiometrics = {
    ...currentCycle.baselineBiometrics,
    weightKg: review.currentWeightKg,
    updatedAtMs: startDateMs
  };

  let targetCalories = currentCycle.targetDailyCalories;
  let macroSplit: MacroSplit = {
    proteinGrams: currentCycle.targetDailyProteinGrams,
    carbsGrams: currentCycle.targetDailyCarbsGrams,
    fatGrams: currentCycle.targetDailyFatGrams
  };

  if (approved) {
    targetCalories = review.proposedDailyCalories;
    macroSplit = review.proposedMacroSplit;
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const dailyPlans: DailyPlan[] = [];

  for (let day = 1; day <= 14; day++) {
    const dayDateMs = startDateMs + (day - 1) * oneDayMs;
    const dateStr = new Date(dayDateMs).toISOString().split("T")[0]!;
    const exercises = createDefaultExercises(day, false);

    dailyPlans.push(
      DailyPlanSchema.parse({
        dayNumber: day,
        date: dateStr,
        targetCaloriesKcal: targetCalories,
        targetProteinGrams: macroSplit.proteinGrams,
        targetCarbsGrams: macroSplit.carbsGrams,
        targetFatGrams: macroSplit.fatGrams,
        loggedCaloriesKcal: 0,
        loggedProteinGrams: 0,
        loggedCarbsGrams: 0,
        loggedFatGrams: 0,
        exercises,
        isFatigueScaled: false,
        completed: false
      })
    );
  }

  const newCycle: AdaptivePlanCycle = {
    id: `cycle_${currentCycle.cycleNumber + 1}_${startDateMs}`,
    cycleNumber: currentCycle.cycleNumber + 1,
    startDateMs,
    endDateMs: startDateMs + 14 * oneDayMs,
    goal: currentCycle.goal,
    baselineBiometrics: newBaselineBio,
    targetDailyCalories: targetCalories,
    targetDailyProteinGrams: macroSplit.proteinGrams,
    targetDailyCarbsGrams: macroSplit.carbsGrams,
    targetDailyFatGrams: macroSplit.fatGrams,
    dailyPlans,
    status: "active"
  };

  return {
    updatedCurrentCycle: AdaptivePlanCycleSchema.parse(updatedCurrentCycle),
    newCycle: AdaptivePlanCycleSchema.parse(newCycle)
  };
}

export function calculateFoodPortion(
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

// ============================================================================
// Phase 2.0 E2E Tier 3 & Tier 4 Test Suite
// ============================================================================

describe("Phase 2.0 E2E Tier 3 & Tier 4 Test Suite", () => {
  const TEST_PASSPHRASE = "Phase2_E2E_Secure_Passphrase_2026!";
  const DUMMY_GATEWAY_CONTRACT =
    "0x1111111111111111111111111111111111111111" as Address;
  const BASE_TIME_MS = 1731320000000; // Reference epoch

  let backend: InMemoryStorageBackend;
  let adapter: EncryptedStorageAdapter;

  beforeEach(() => {
    backend = new InMemoryStorageBackend();
    adapter = new EncryptedStorageAdapter(TEST_PASSPHRASE, backend);
  });

  // ==========================================================================
  // Tier 3: Pairwise Cross-Feature Combinations (13 tests: T3-1 to T3-13)
  // ==========================================================================
  describe("Tier 3: Pairwise Cross-Feature Combinations (T3-1 to T3-13)", () => {
    it("T3-1: Onboarding Biometrics (F8) -> Deterministic 14-Day Plan Generation (F2, F4) -> Local Encrypted Storage Persistence (F9)", async () => {
      // Step 1: User completes Onboarding Wizard with personalized biometrics
      const userBiometrics: UserBiometrics = {
        age: 28,
        gender: "male",
        weightKg: 75.0,
        heightCm: 180.0,
        bodyFatPct: 15.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate",
        updatedAtMs: BASE_TIME_MS
      };
      const validatedBio = UserBiometricsSchema.parse(userBiometrics);
      await adapter.setEncryptedItem(STORAGE_KEYS.USER_BIOMETRICS, validatedBio);

      // Step 2: Deterministic Plan Generation using Katch-McArdle formula
      // LBM = 75 * (1 - 0.15) = 63.75 kg -> BMR = 370 + 21.6 * 63.75 = 1747 kcal
      const bmr = calculateBmr(validatedBio);
      expect(bmr).toBe(1747);

      // TDEE = round(1747 * 1.55) = 2708 kcal
      const tdee = calculateTdee(bmr, validatedBio.weeklyWorkoutFrequency, validatedBio.activityLevel);
      expect(tdee).toBe(2708);

      // Goal Cut = 2708 - 500 = 2208 kcal
      const targetCalories = calculateTargetCalories(tdee, validatedBio.goal);
      expect(targetCalories).toBe(2208);

      const cycle = generate14DayPlan(validatedBio, BASE_TIME_MS);
      expect(cycle.dailyPlans).toHaveLength(14);
      expect(cycle.targetDailyCalories).toBe(2208);
      expect(cycle.status).toBe("active");

      // Step 3: Persist generated plan cycle to encrypted local storage
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, cycle);

      // Step 4: Verification of 100% data sovereignty decryption
      const retrievedBio = await adapter.getEncryptedItem<UserBiometrics>(
        STORAGE_KEYS.USER_BIOMETRICS
      );
      expect(retrievedBio).toEqual(validatedBio);

      const retrievedCycle = await adapter.getEncryptedItem<AdaptivePlanCycle>(
        STORAGE_KEYS.ACTIVE_PLAN_CYCLE
      );
      expect(retrievedCycle).toBeDefined();
      expect(retrievedCycle?.dailyPlans).toHaveLength(14);
      expect(retrievedCycle?.targetDailyCalories).toBe(2208);
      expect(retrievedCycle?.targetDailyProteinGrams).toBe(cycle.targetDailyProteinGrams);
    });

    it("T3-2: Inactivity Gap (>48h) (F5) -> Fatigue Scaling (-30% sets/duration) (F5) -> Dual-Track Check-In Workout Card (F10)", async () => {
      const biometrics: UserBiometrics = {
        age: 30,
        gender: "female",
        weightKg: 62.0,
        heightCm: 168.0,
        weeklyWorkoutFrequency: 3,
        goal: "maintain",
        activityLevel: "moderate"
      };

      // Gap of 72 hours (>48h threshold) since last log
      const lastLogTimestampMs = BASE_TIME_MS;
      const currentSessionTimestampMs = BASE_TIME_MS + 72 * 60 * 60 * 1000;

      const cycle = generate14DayPlan(
        biometrics,
        currentSessionTimestampMs,
        lastLogTimestampMs
      );

      // Day 1 must have fatigue scaling activated
      const day1 = cycle.dailyPlans[0]!;
      expect(day1.isFatigueScaled).toBe(true);

      // Dual-track workout card displays itemized exercises scaled by 30%
      expect(day1.exercises.length).toBeGreaterThan(0);
      for (const ex of day1.exercises) {
        expect(ex.scaledForFatigue).toBe(true);
      }

      // Check specific reduction: Push-ups base 4 sets -> 4 * 0.7 = 2.8 -> round(2.8) = 3 sets
      const pushUps = day1.exercises.find((e) => e.name === "Push-ups");
      expect(pushUps).toBeDefined();
      expect(pushUps?.sets).toBe(3);

      // Plank hold base 2 min duration -> 2 * 0.7 = 1.4 -> round(1.4) = 1 min
      const plank = day1.exercises.find((e) => e.name === "Plank Hold");
      expect(plank).toBeDefined();
      expect(plank?.durationMinutes).toBe(1);
    });

    it("T3-3: Dual-Track Check-In Completion (F10) -> Keccak-256 Telemetry Hash (F11) -> EIP-712 Signing (F11) -> On-Chain Verification", async () => {
      const wallet = Wallet.createRandom();

      // Check-in telemetry payload after completing nutrition & workout checklist
      const telemetry: TelemetryData = {
        timestampMs: BASE_TIME_MS,
        stepCount: 8850,
        activeMinutes: 45,
        avgHeartRateBpm: 138.5,
        caloriesBurnedKcal: 480.0,
        profileSnapshot: {
          age: 28,
          gender: "male",
          bodyFatPct: 15.0,
          muscleMassKg: 63.75
        }
      };

      // Keccak-256 telemetry hash
      const telemetryHash = hashTelemetry(telemetry);
      expect(telemetryHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // EIP-712 WorkoutProof struct
      const proof: WorkoutProof = {
        user: wallet.address as Address,
        telemetryHash,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(BASE_TIME_MS / 1000) + 86400)
      };

      // Sign with user's wallet
      const signedPayload = await signWorkoutProof(
        wallet,
        proof,
        DUMMY_GATEWAY_CONTRACT,
        ARBITRUM_SEPOLIA_CHAIN_ID
      );
      expect(signedPayload.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);

      // Verify signature recovery
      const isValid = verifyWorkoutProofSignature(
        signedPayload,
        DUMMY_GATEWAY_CONTRACT,
        ARBITRUM_SEPOLIA_CHAIN_ID
      );
      expect(isValid).toBe(true);

      // Negative check: wrong signer fails
      const attackerWallet = Wallet.createRandom();
      const fraudulentPayload = await signWorkoutProof(
        attackerWallet,
        proof,
        DUMMY_GATEWAY_CONTRACT,
        ARBITRUM_SEPOLIA_CHAIN_ID
      );
      const isFraudulentValid = verifyWorkoutProofSignature(
        fraudulentPayload,
        DUMMY_GATEWAY_CONTRACT,
        ARBITRUM_SEPOLIA_CHAIN_ID
      );
      expect(isFraudulentValid).toBe(false);
    });

    it("T3-4: 14 Consecutive Daily Check-Ins (F10) + Chronological Weight Logs (F12) -> Rolling 7-Day Weight Average (F6)", async () => {
      const oneDayMs = 24 * 60 * 60 * 1000;
      const weightLogs: WeightLogEntry[] = [];
      const weights = [
        80.0, 79.8, 79.7, 79.5, 79.4, 79.2, 79.0, // Days 1 to 7
        78.9, 78.7, 78.6, 78.4, 78.3, 78.1, 78.0  // Days 8 to 14
      ];

      for (let i = 0; i < weights.length; i++) {
        weightLogs.push(
          WeightLogEntrySchema.parse({
            id: `weight_day_${i + 1}`,
            timestampMs: BASE_TIME_MS + i * oneDayMs,
            weightKg: weights[i]!,
            bodyFatPct: 18.0 - i * 0.1
          })
        );
      }

      // Check rolling average at Day 7 (mean of days 1-7: sum = 556.6, 556.6 / 7 = 79.51)
      const day7Average = calculateRollingWeightAverage(weightLogs.slice(0, 7));
      expect(day7Average).toBe(79.51);

      // Check rolling average at Day 14 (mean of days 8-14: sum = 549.0, 549.0 / 7 = 78.43)
      const day14Average = calculateRollingWeightAverage(weightLogs);
      expect(day14Average).toBe(78.43);
    });

    it("T3-5: Rolling 7-Day Weight Average (F6) + 14-Day Cycle Elapsed (F13) -> Offline Bi-Weekly Review Engine (F7)", async () => {
      const biometrics: UserBiometrics = {
        age: 26,
        gender: "male",
        weightKg: 80.0,
        heightCm: 178.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate"
      };

      const cycle = generate14DayPlan(biometrics, BASE_TIME_MS);
      const oneDayMs = 24 * 60 * 60 * 1000;
      const weightLogs: WeightLogEntry[] = [];
      const weights = [
        80.0, 79.8, 79.7, 79.5, 79.4, 79.2, 79.0,
        78.9, 78.7, 78.6, 78.4, 78.3, 78.1, 78.0
      ];

      for (let i = 0; i < weights.length; i++) {
        weightLogs.push({
          id: `log_${i + 1}`,
          timestampMs: BASE_TIME_MS + i * oneDayMs,
          weightKg: weights[i]!
        });
      }

      // 14-day adherence: 13 out of 14 days completed (92.8%)
      const adherencePct = 93;
      const review = evaluateBiWeeklyReview(cycle, weightLogs, adherencePct);

      expect(review.cycleId).toBe(cycle.id);
      expect(review.startingWeightKg).toBe(80.0);
      expect(review.currentWeightKg).toBe(78.0);
      expect(review.weightChangeKg).toBe(-2.0);
      expect(review.rollingAverageWeightKg).toBe(78.43);
      // Under Cut goal, losing >= 0.5kg is on track, maintain deficit
      expect(review.calorieAdjustment).toBe(0);
      expect(review.proposedDailyCalories).toBe(cycle.targetDailyCalories);
      expect(review.rationale).toContain("Maintain current deficit");
      expect(review.status).toBe("pending");
    });

    it("T3-6: Bi-Weekly Plan Review Approval (F13) -> Encrypted Storage Commit (F9) -> Cycle 2 Advancement (F1)", async () => {
      const biometrics: UserBiometrics = {
        age: 32,
        gender: "male",
        weightKg: 85.0,
        heightCm: 180.0,
        weeklyWorkoutFrequency: 4,
        goal: "fat_loss",
        activityLevel: "moderate"
      };

      const cycle1 = generate14DayPlan(biometrics, BASE_TIME_MS, null, 1);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, cycle1);

      // Stalled cut despite 95% adherence -> review proposes -150 kcal adjustment
      const weightLogs: WeightLogEntry[] = [
        { id: "w1", timestampMs: BASE_TIME_MS, weightKg: 85.0 },
        { id: "w2", timestampMs: BASE_TIME_MS + 13 * 24 * 3600 * 1000, weightKg: 84.8 }
      ];
      const review = evaluateBiWeeklyReview(cycle1, weightLogs, 95);
      expect(review.calorieAdjustment).toBe(-150);

      // User approves proposed new plan
      const cycle2StartTimeMs = BASE_TIME_MS + 14 * 24 * 3600 * 1000;
      const { updatedCurrentCycle, newCycle } = advancePlanCycle(
        cycle1,
        review,
        true,
        cycle2StartTimeMs
      );

      expect(updatedCurrentCycle.status).toBe("reviewed");
      expect(newCycle.cycleNumber).toBe(2);
      expect(newCycle.targetDailyCalories).toBe(cycle1.targetDailyCalories - 150);
      expect(newCycle.baselineBiometrics.weightKg).toBe(84.8);

      // Commit to encrypted storage
      await adapter.setEncryptedItem(STORAGE_KEYS.PLAN_HISTORY, [updatedCurrentCycle]);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, newCycle);

      // Verify active cycle is now Cycle 2
      const activeCycle = await adapter.getEncryptedItem<AdaptivePlanCycle>(
        STORAGE_KEYS.ACTIVE_PLAN_CYCLE
      );
      expect(activeCycle?.cycleNumber).toBe(2);
      expect(activeCycle?.targetDailyCalories).toBe(review.proposedDailyCalories);

      const history = await adapter.getEncryptedItem<AdaptivePlanCycle[]>(
        STORAGE_KEYS.PLAN_HISTORY
      );
      expect(history).toHaveLength(1);
      expect(history![0]!.status).toBe("reviewed");
    });

    it("T3-7: 'Skip for Now' Onboarding Fallback (F8) -> Default Baseline Biometrics -> Anytime Weigh-In (F12) -> Custom Plan Regeneration (F2)", async () => {
      // Step 1: User skips onboarding -> DEFAULT_BASELINE_BIOMETRICS committed
      await adapter.setEncryptedItem(
        STORAGE_KEYS.USER_BIOMETRICS,
        DEFAULT_BASELINE_BIOMETRICS
      );
      const baselineCycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_TIME_MS);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, baselineCycle);

      expect(baselineCycle.baselineBiometrics.weightKg).toBe(70.0);
      expect(baselineCycle.goal).toBe("maintain");

      // Step 2: Later, user logs actual biometrics via Dashboard Anytime Weigh-In modal
      const customBiometrics: UserBiometrics = {
        age: 35,
        gender: "male",
        weightKg: 88.0,
        heightCm: 182.0,
        bodyFatPct: 22.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate",
        updatedAtMs: BASE_TIME_MS + 2 * 24 * 3600 * 1000
      };
      await adapter.setEncryptedItem(STORAGE_KEYS.USER_BIOMETRICS, customBiometrics);

      // Step 3: Regenerate custom plan from updated biometrics
      const customCycle = generate14DayPlan(
        customBiometrics,
        customBiometrics.updatedAtMs!
      );
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, customCycle);

      expect(customCycle.baselineBiometrics.weightKg).toBe(88.0);
      expect(customCycle.goal).toBe("cut");
      // Katch-McArdle LBM = 88 * (1 - 0.22) = 68.64 kg -> BMR = 370 + 21.6 * 68.64 = 1853 kcal
      // TDEE = 1853 * 1.55 = 2872 kcal -> Cut = 2372 kcal
      expect(customCycle.targetDailyCalories).toBe(2372);
      expect(customCycle.targetDailyCalories).not.toBe(baselineCycle.targetDailyCalories);
    });

    it("T3-8: Severe Cut Goal (F2) -> Safe Calorie Floor Clamping (F3) -> Macro Split Allocation (F4) -> Daily Plan Generation (F1)", async () => {
      // Petite female user with very low BMR
      const petiteProfile: UserBiometrics = {
        age: 48,
        gender: "female",
        weightKg: 44.0,
        heightCm: 150.0,
        weeklyWorkoutFrequency: 1,
        goal: "cut",
        activityLevel: "sedentary"
      };

      // Mifflin-St Jeor: 10 * 44 + 6.25 * 150 - 5 * 48 - 161 = 440 + 937.5 - 240 - 161 = 976.5 -> 977 kcal
      const bmr = calculateBmr(petiteProfile);
      expect(bmr).toBe(977);

      // TDEE: round(977 * 1.2) = 1172 kcal
      const tdee = calculateTdee(bmr, petiteProfile.weeklyWorkoutFrequency, petiteProfile.activityLevel);
      expect(tdee).toBe(1172);

      // Unclamped cut target would be 1172 - 500 = 672 kcal.
      // Safe Calorie Floor strictly clamps to 1200 kcal!
      const targetCalories = calculateTargetCalories(tdee, petiteProfile.goal);
      expect(targetCalories).toBe(1200);

      // Macro allocation for safe 1200 kcal floor (Cut: 40% P, 35% C, 25% F)
      const macros = calculateMacroSplit(targetCalories, petiteProfile.goal);
      expect(macros.proteinGrams).toBe(120); // 1200 * 0.40 / 4
      expect(macros.carbsGrams).toBe(105);   // 1200 * 0.35 / 4
      expect(macros.fatGrams).toBe(33);      // 1200 * 0.25 / 9

      const cycle = generate14DayPlan(petiteProfile, BASE_TIME_MS);
      for (const day of cycle.dailyPlans) {
        expect(day.targetCaloriesKcal).toBe(1200);
        expect(day.targetProteinGrams).toBe(120);
        expect(day.targetCarbsGrams).toBe(105);
        expect(day.targetFatGrams).toBe(33);
      }
    });

    it("T3-9: Food Preset Portion Math (F10) -> Daily Plan Calories Update (F1) -> Telemetry Proof TelemetryData Generation (F11)", async () => {
      const chickenBreast = STANDARD_FOOD_PRESETS.find(
        (p) => p.id === "preset_chicken_breast"
      )!;
      const brownRice = STANDARD_FOOD_PRESETS.find(
        (p) => p.id === "preset_brown_rice"
      )!;

      // Portion 1: 200g of Chicken Breast (serving is 100g -> factor 2.0)
      const portion1 = calculateFoodPortion(chickenBreast, 200);
      expect(portion1.caloriesKcal).toBe(330);
      expect(portion1.proteinGrams).toBe(62);

      // Portion 2: 150g of Brown Rice (serving is 100g -> factor 1.5)
      const portion2 = calculateFoodPortion(brownRice, 150);
      expect(portion2.caloriesKcal).toBe(168);
      expect(portion2.carbsGrams).toBe(36);

      // Total logged nutrients
      const totalLoggedCalories = portion1.caloriesKcal + portion2.caloriesKcal; // 498
      const totalLoggedProtein = Math.round(portion1.proteinGrams + portion2.proteinGrams); // 66
      const totalLoggedCarbs = Math.round(portion1.carbsGrams + portion2.carbsGrams); // 36
      const totalLoggedFat = Math.round(portion1.fatGrams + portion2.fatGrams); // 9

      const dayPlan: DailyPlan = {
        dayNumber: 1,
        date: "2026-11-12",
        targetCaloriesKcal: 2000,
        targetProteinGrams: 150,
        targetCarbsGrams: 200,
        targetFatGrams: 60,
        loggedCaloriesKcal: totalLoggedCalories,
        loggedProteinGrams: totalLoggedProtein,
        loggedCarbsGrams: totalLoggedCarbs,
        loggedFatGrams: totalLoggedFat,
        exercises: [],
        isFatigueScaled: false,
        completed: true
      };
      DailyPlanSchema.parse(dayPlan);

      // Generate TelemetryData upon check-in completion
      const telemetry: TelemetryData = {
        timestampMs: BASE_TIME_MS,
        stepCount: 10200,
        activeMinutes: 50,
        avgHeartRateBpm: 140.0,
        caloriesBurnedKcal: 510.0,
        profileSnapshot: {
          age: 28,
          gender: "male",
          bodyFatPct: 15.0,
          muscleMassKg: 64.0
        }
      };
      const hash = hashTelemetry(telemetry);
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("T3-10: Inactivity Fatigue Recovery (F5): Day 1 scaled (-30%) -> Day 2 check-in completed -> Day 3 unscaled normal volume (F10)", async () => {
      const biometrics: UserBiometrics = {
        age: 29,
        gender: "male",
        weightKg: 78.0,
        heightCm: 175.0,
        weeklyWorkoutFrequency: 4,
        goal: "maintain"
      };

      const oneDayMs = 24 * 60 * 60 * 1000;
      // User inactive for 72 hours before starting Day 1
      const lastCheckInTime = BASE_TIME_MS - 72 * 60 * 60 * 1000;
      const cycle = generate14DayPlan(biometrics, BASE_TIME_MS, lastCheckInTime);

      // Day 1 has fatigue scaling
      expect(cycle.dailyPlans[0]!.isFatigueScaled).toBe(true);
      expect(cycle.dailyPlans[0]!.exercises[0]!.scaledForFatigue).toBe(true);

      // User completes Day 1 check-in at BASE_TIME_MS
      // Day 2 check-in occurs 24 hours later (gap = 24h < 48h)
      const day2Timestamp = BASE_TIME_MS + oneDayMs;
      const fatigueAssessmentDay2 = scaleTargetForInactivityGap(
        100,
        BASE_TIME_MS,
        day2Timestamp
      );
      expect(fatigueAssessmentDay2.isFatigueScaled).toBe(false);

      // Day 3 occurs 24 hours after Day 2 (gap = 24h < 48h) -> Unscaled normal volume restored
      const day3Timestamp = BASE_TIME_MS + 2 * oneDayMs;
      const fatigueAssessmentDay3 = scaleTargetForInactivityGap(
        100,
        day2Timestamp,
        day3Timestamp
      );
      expect(fatigueAssessmentDay3.isFatigueScaled).toBe(false);

      const day3Exercises = createDefaultExercises(3, false);
      for (const ex of day3Exercises) {
        expect(ex.scaledForFatigue).toBe(false);
      }
    });

    it("T3-11: Anytime Weigh-In (F12) -> Weight Logs Serialization (F9) -> Encrypted Storage MAC Verification (F9)", async () => {
      const logs: WeightLogEntry[] = [
        { id: "w_1", timestampMs: BASE_TIME_MS, weightKg: 82.5, bodyFatPct: 19.0 },
        { id: "w_2", timestampMs: BASE_TIME_MS + 86400000, weightKg: 82.3, bodyFatPct: 18.9 },
        { id: "w_3", timestampMs: BASE_TIME_MS + 172800000, weightKg: 82.0, bodyFatPct: 18.8 }
      ];

      // Save to encrypted storage
      await adapter.setEncryptedItem(STORAGE_KEYS.WEIGHT_LOGS, logs);

      // Decryption works flawlessly with genuine envelope
      const decrypted = await adapter.getEncryptedItem<WeightLogEntry[]>(
        STORAGE_KEYS.WEIGHT_LOGS
      );
      expect(decrypted).toHaveLength(3);
      expect(decrypted![2]!.weightKg).toBe(82.0);

      // Corrupt ciphertext in backend storage to simulate tampering
      const rawEnvelope = backend.getRaw(STORAGE_KEYS.WEIGHT_LOGS);
      expect(rawEnvelope).toBeDefined();
      const parsedEnvelope = JSON.parse(rawEnvelope!);
      parsedEnvelope.ciphertext =
        parsedEnvelope.ciphertext.slice(0, -2) + "aa";
      backend.setRaw(STORAGE_KEYS.WEIGHT_LOGS, JSON.stringify(parsedEnvelope));

      // Adapter must reject with tampering detection error
      await expect(
        adapter.getEncryptedItem(STORAGE_KEYS.WEIGHT_LOGS)
      ).rejects.toThrow("tampering detected");
    });

    it("T3-12: Bi-Weekly Plan Review Rejection ('Keep Current Plan') (F13) -> Existing Targets Preserved in Cycle 2 (F1)", async () => {
      const biometrics: UserBiometrics = {
        age: 30,
        gender: "male",
        weightKg: 78.0,
        heightCm: 175.0,
        weeklyWorkoutFrequency: 4,
        goal: "fat_loss"
      };

      const cycle1 = generate14DayPlan(biometrics, BASE_TIME_MS, null, 1);
      const originalCalories = cycle1.targetDailyCalories;
      const originalProtein = cycle1.targetDailyProteinGrams;

      // Review suggests reducing calories by 150 kcal
      const weightLogs: WeightLogEntry[] = [
        { id: "log1", timestampMs: BASE_TIME_MS, weightKg: 78.0 },
        { id: "log2", timestampMs: BASE_TIME_MS + 13 * 86400000, weightKg: 77.9 }
      ];
      const review = evaluateBiWeeklyReview(cycle1, weightLogs, 85);
      expect(review.calorieAdjustment).toBe(-150);

      // User rejects proposed changes ("Keep Current Plan")
      const { updatedCurrentCycle, newCycle } = advancePlanCycle(
        cycle1,
        review,
        false, // rejected
        BASE_TIME_MS + 14 * 86400000
      );

      expect(updatedCurrentCycle.status).toBe("completed");
      expect(newCycle.cycleNumber).toBe(2);
      // Existing targets strictly preserved
      expect(newCycle.targetDailyCalories).toBe(originalCalories);
      expect(newCycle.targetDailyProteinGrams).toBe(originalProtein);
      expect(newCycle.targetDailyCarbsGrams).toBe(cycle1.targetDailyCarbsGrams);
      expect(newCycle.targetDailyFatGrams).toBe(cycle1.targetDailyFatGrams);
    });

    it("T3-13: Full-Stack Verification: Onboarding -> 14-Day Plan -> Dual Check-In -> Crypto Proof -> Weigh-In -> Review Approval -> Cycle 2", async () => {
      const wallet = Wallet.createRandom();

      // 1. Onboarding
      const biometrics: UserBiometrics = {
        age: 27,
        gender: "female",
        weightKg: 65.0,
        heightCm: 170.0,
        bodyFatPct: 22.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate"
      };
      await adapter.setEncryptedItem(STORAGE_KEYS.USER_BIOMETRICS, biometrics);

      // 2. 14-Day Plan
      const cycle1 = generate14DayPlan(biometrics, BASE_TIME_MS);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, cycle1);
      expect(cycle1.dailyPlans).toHaveLength(14);

      // 3. Day 1 Dual-Track Check-In
      const day1 = cycle1.dailyPlans[0]!;
      const portion = calculateFoodPortion(STANDARD_FOOD_PRESETS[0]!, 150);
      const updatedDay1: DailyPlan = {
        ...day1,
        loggedCaloriesKcal: portion.caloriesKcal,
        loggedProteinGrams: Math.round(portion.proteinGrams),
        exercises: day1.exercises.map((e) => ({ ...e, completed: true })),
        completed: true
      };
      expect(updatedDay1.completed).toBe(true);

      // 4. Crypto Telemetry Proof
      const telemetry: TelemetryData = {
        timestampMs: BASE_TIME_MS,
        stepCount: 9500,
        activeMinutes: 45,
        avgHeartRateBpm: 136.0,
        caloriesBurnedKcal: 490.0,
        profileSnapshot: {
          age: 27,
          gender: "female",
          bodyFatPct: 22.0,
          muscleMassKg: 50.7
        }
      };
      const proof: WorkoutProof = {
        user: wallet.address as Address,
        telemetryHash: hashTelemetry(telemetry),
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(BASE_TIME_MS / 1000) + 86400)
      };
      const signed = await signWorkoutProof(
        wallet,
        proof,
        DUMMY_GATEWAY_CONTRACT,
        ARBITRUM_SEPOLIA_CHAIN_ID
      );
      expect(verifyWorkoutProofSignature(signed, DUMMY_GATEWAY_CONTRACT, ARBITRUM_SEPOLIA_CHAIN_ID)).toBe(true);

      // 5. Weight tracking across 14 days
      const weightLogs: WeightLogEntry[] = [
        { id: "w_start", timestampMs: BASE_TIME_MS, weightKg: 65.0 },
        { id: "w_end", timestampMs: BASE_TIME_MS + 13 * 86400000, weightKg: 63.8 }
      ];
      await adapter.setEncryptedItem(STORAGE_KEYS.WEIGHT_LOGS, weightLogs);

      // 6. Review & Approval
      const review = evaluateBiWeeklyReview(cycle1, weightLogs, 100);
      expect(review.weightChangeKg).toBe(-1.2);
      const { newCycle } = advancePlanCycle(
        cycle1,
        review,
        true,
        BASE_TIME_MS + 14 * 86400000
      );

      // 7. Cycle 2 Active in Encrypted Storage
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, newCycle);
      const retrieved = await adapter.getEncryptedItem<AdaptivePlanCycle>(
        STORAGE_KEYS.ACTIVE_PLAN_CYCLE
      );
      expect(retrieved?.cycleNumber).toBe(2);
      expect(retrieved?.baselineBiometrics.weightKg).toBe(63.8);
    });
  });

  // ==========================================================================
  // Tier 4: Real-World Application Scenarios (7 tests: Scenario T4-1 to T4-7)
  // ==========================================================================
  describe("Tier 4: Real-World Application Scenarios (Scenario T4-1 to T4-7)", () => {
    it("Scenario T4-1: New User First-Launch Onboarding & Day 1 Plan Generation Journey", async () => {
      // 1. Initial Launch: Storage is empty
      const existingBio = await adapter.getEncryptedItem<UserBiometrics>(
        STORAGE_KEYS.USER_BIOMETRICS
      );
      expect(existingBio).toBeNull();

      // 2. User completes multi-step wizard: Male, 30yo, 82kg, 185cm, 16% BF, Cut, 5x/week
      const newBiometrics: UserBiometrics = {
        age: 30,
        gender: "male",
        weightKg: 82.0,
        heightCm: 185.0,
        bodyFatPct: 16.0,
        weeklyWorkoutFrequency: 5,
        goal: "cut",
        activityLevel: "heavy",
        updatedAtMs: BASE_TIME_MS
      };
      await adapter.setEncryptedItem(STORAGE_KEYS.USER_BIOMETRICS, newBiometrics);

      // 3. Generate 14-Day Plan
      // Katch-McArdle LBM = 82 * (1 - 0.16) = 68.88 kg -> BMR = 370 + 21.6 * 68.88 = 1858 kcal
      // TDEE = round(1858 * 1.725) = 3205 kcal -> Cut = 2705 kcal
      const planCycle = generate14DayPlan(newBiometrics, BASE_TIME_MS);
      expect(planCycle.targetDailyCalories).toBe(2705);
      expect(planCycle.dailyPlans).toHaveLength(14);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, planCycle);

      // 4. Day 1 Screen loads from storage
      const loadedCycle = await adapter.getEncryptedItem<AdaptivePlanCycle>(
        STORAGE_KEYS.ACTIVE_PLAN_CYCLE
      );
      expect(loadedCycle).toBeDefined();
      const day1 = loadedCycle!.dailyPlans[0]!;
      expect(day1.targetCaloriesKcal).toBe(2705);
      expect(day1.exercises.length).toBeGreaterThanOrEqual(3);
      expect(day1.completed).toBe(false);
    });

    it("Scenario T4-2: 'Skip for Now' Onboarding Fallback & Later Anytime Weigh-In Journey", async () => {
      // 1. User skips onboarding -> Baseline defaults applied
      await adapter.setEncryptedItem(
        STORAGE_KEYS.USER_BIOMETRICS,
        DEFAULT_BASELINE_BIOMETRICS
      );
      const baselineCycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_TIME_MS);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, baselineCycle);

      expect(baselineCycle.baselineBiometrics).toEqual(DEFAULT_BASELINE_BIOMETRICS);

      // 2. User trains for 3 days under baseline
      // On Day 4, user opens Dashboard "Log Weight / Biometrics" modal
      const updatedBiometrics: UserBiometrics = {
        age: 25,
        gender: "male",
        weightKg: 78.0,
        heightCm: 180.0,
        weeklyWorkoutFrequency: 4,
        goal: "bulk",
        activityLevel: "moderate",
        updatedAtMs: BASE_TIME_MS + 3 * 86400000
      };
      await adapter.setEncryptedItem(STORAGE_KEYS.USER_BIOMETRICS, updatedBiometrics);

      // 3. Plan regenerates with Bulk goal (+300 kcal surplus)
      const newPlan = generate14DayPlan(
        updatedBiometrics,
        updatedBiometrics.updatedAtMs!
      );
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, newPlan);

      expect(newPlan.goal).toBe("bulk");
      expect(newPlan.baselineBiometrics.weightKg).toBe(78.0);
      // Mifflin-St Jeor: 10 * 78 + 6.25 * 180 - 5 * 25 + 5 = 780 + 1125 - 125 + 5 = 1785 kcal
      // TDEE = 1785 * 1.55 = 2767 kcal -> Bulk = 3067 kcal
      expect(newPlan.targetDailyCalories).toBe(3067);
    });

    it("Scenario T4-3: Inactivity Gap (>48h) Fatigue Scaling & Consecutive Day Recovery Lifecycle", async () => {
      const biometrics: UserBiometrics = {
        age: 32,
        gender: "female",
        weightKg: 60.0,
        heightCm: 165.0,
        weeklyWorkoutFrequency: 3,
        goal: "maintain",
        activityLevel: "moderate"
      };

      // Day 1: normal workout
      const day1Cycle = generate14DayPlan(biometrics, BASE_TIME_MS);
      expect(day1Cycle.dailyPlans[0]!.isFatigueScaled).toBe(false);

      // User experiences 60h inactivity gap (travel / sickness)
      const day2StartTimeMs = BASE_TIME_MS + 60 * 3600 * 1000;
      const day2Cycle = generate14DayPlan(
        biometrics,
        day2StartTimeMs,
        BASE_TIME_MS
      );

      // Day 2 automatically scales down by 30% to ease user back in
      const day2 = day2Cycle.dailyPlans[0]!;
      expect(day2.isFatigueScaled).toBe(true);
      const pushUpsScaled = day2.exercises.find((e) => e.name === "Push-ups")!;
      expect(pushUpsScaled.sets).toBe(3); // 4 * 0.7 = 2.8 -> 3

      // User successfully finishes scaled Day 2 workout
      const day2FinishTimeMs = day2StartTimeMs + 3600 * 1000;

      // Day 3 session scheduled 20h later (<48h gap) -> Fatigue cleared, full intensity restored!
      const day3StartTimeMs = day2FinishTimeMs + 20 * 3600 * 1000;
      const day3Cycle = generate14DayPlan(
        biometrics,
        day3StartTimeMs,
        day2FinishTimeMs
      );
      const day3 = day3Cycle.dailyPlans[0]!;
      expect(day3.isFatigueScaled).toBe(false);
      const pushUpsUnscaled = day3.exercises.find((e) => e.name === "Push-ups")!;
      expect(pushUpsUnscaled.sets).toBe(4);
    });

    it("Scenario T4-4: Dual-Track Daily Check-In, Food Preset Logging & Telemetry Proof Gating", async () => {
      const wallet = Wallet.createRandom();
      const biometrics: UserBiometrics = {
        age: 29,
        gender: "male",
        weightKg: 76.0,
        heightCm: 178.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate"
      };

      const cycle = generate14DayPlan(biometrics, BASE_TIME_MS);
      const day1 = cycle.dailyPlans[0]!;

      // Track 1: Nutrition preset logging
      const oats = STANDARD_FOOD_PRESETS.find((p) => p.id === "preset_rolled_oats")!;
      const whey = STANDARD_FOOD_PRESETS.find((p) => p.id === "preset_whey_protein")!;

      const meal1 = calculateFoodPortion(oats, 100); // 100g oats = 2x serving -> 380 kcal
      const meal2 = calculateFoodPortion(whey, 30);  // 1 scoop whey = 120 kcal

      const loggedCalories = meal1.caloriesKcal + meal2.caloriesKcal;
      const loggedProtein = Math.round(meal1.proteinGrams + meal2.proteinGrams);
      const loggedCarbs = Math.round(meal1.carbsGrams + meal2.carbsGrams);
      const loggedFat = Math.round(meal1.fatGrams + meal2.fatGrams);

      expect(loggedCalories).toBe(500);

      // Track 2: Workout checklist ticking
      const completedExercises = day1.exercises.map((e) => ({
        ...e,
        completed: true
      }));

      const day1Completed: DailyPlan = {
        ...day1,
        loggedCaloriesKcal: loggedCalories,
        loggedProteinGrams: loggedProtein,
        loggedCarbsGrams: loggedCarbs,
        loggedFatGrams: loggedFat,
        exercises: completedExercises,
        completed: true
      };

      // Both tracks completed -> unlock cryptographic telemetry proof
      const telemetry: TelemetryData = {
        timestampMs: BASE_TIME_MS,
        stepCount: 11000,
        activeMinutes: 60,
        avgHeartRateBpm: 142.0,
        caloriesBurnedKcal: 560.0,
        profileSnapshot: {
          age: 29,
          gender: "male",
          bodyFatPct: 17.0,
          muscleMassKg: 62.0
        }
      };

      const telemetryHash = hashTelemetry(telemetry);
      const proof: WorkoutProof = {
        user: wallet.address as Address,
        telemetryHash,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(BASE_TIME_MS / 1000) + 86400)
      };

      const signedProof = await signWorkoutProof(
        wallet,
        proof,
        DUMMY_GATEWAY_CONTRACT,
        ARBITRUM_SEPOLIA_CHAIN_ID
      );
      expect(
        verifyWorkoutProofSignature(
          signedProof,
          DUMMY_GATEWAY_CONTRACT,
          ARBITRUM_SEPOLIA_CHAIN_ID
        )
      ).toBe(true);

      // Persist daily completion state
      await adapter.setEncryptedItem(STORAGE_KEYS.DAILY_COMPLETION_STATE, {
        [day1.date]: true
      });
      const completionState = await adapter.getEncryptedItem<Record<string, boolean>>(
        STORAGE_KEYS.DAILY_COMPLETION_STATE
      );
      expect(completionState?.[day1.date]).toBe(true);
    });

    it("Scenario T4-5: Full 14-Day Cycle Daily Check-In & 7-Day Weight Tracking Lifecycle", async () => {
      const biometrics: UserBiometrics = {
        age: 31,
        gender: "male",
        weightKg: 85.0,
        heightCm: 182.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate"
      };

      const cycle = generate14DayPlan(biometrics, BASE_TIME_MS);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, cycle);

      const oneDayMs = 24 * 60 * 60 * 1000;
      const weightLogs: WeightLogEntry[] = [];
      const completionMap: Record<string, boolean> = {};

      // 14 days of sequential check-ins and weight measurements
      for (let day = 1; day <= 14; day++) {
        const timestamp = BASE_TIME_MS + (day - 1) * oneDayMs;
        const currentWeight = Number((85.0 - (day - 1) * 0.15).toFixed(2));

        const entry: WeightLogEntry = {
          id: `w_day_${day}`,
          timestampMs: timestamp,
          weightKg: currentWeight
        };
        weightLogs.push(entry);

        const dateStr = new Date(timestamp).toISOString().split("T")[0]!;
        completionMap[dateStr] = true;
      }

      await adapter.setEncryptedItem(STORAGE_KEYS.WEIGHT_LOGS, weightLogs);
      await adapter.setEncryptedItem(
        STORAGE_KEYS.DAILY_COMPLETION_STATE,
        completionMap
      );

      // Verify rolling average at Day 7: (85.00 + 84.85 + 84.70 + 84.55 + 84.40 + 84.25 + 84.10) / 7 = 84.55
      const rollingAvgDay7 = calculateRollingWeightAverage(weightLogs.slice(0, 7));
      expect(rollingAvgDay7).toBe(84.55);

      // Verify rolling average at Day 14: mean of days 8-14: (83.95 + 83.80 + 83.65 + 83.50 + 83.35 + 83.20 + 83.05) / 7 = 83.5
      const rollingAvgDay14 = calculateRollingWeightAverage(weightLogs);
      expect(rollingAvgDay14).toBe(83.5);

      // Verify 100% completion in storage
      const savedCompletion = await adapter.getEncryptedItem<Record<string, boolean>>(
        STORAGE_KEYS.DAILY_COMPLETION_STATE
      );
      expect(Object.keys(savedCompletion!)).toHaveLength(14);
    });

    it("Scenario T4-6: 14-Day Elapsed Banner Trigger, Plan Review & Approval Workflow", async () => {
      const biometrics: UserBiometrics = {
        age: 28,
        gender: "male",
        weightKg: 85.0,
        heightCm: 180.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate"
      };

      const cycle = generate14DayPlan(biometrics, BASE_TIME_MS);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, cycle);

      // Simulation: 14 days elapse, Dashboard checks if review is due
      const elapsedTimestampMs = BASE_TIME_MS + 14 * 24 * 3600 * 1000;
      const isReviewDue = elapsedTimestampMs >= cycle.endDateMs;
      expect(isReviewDue).toBe(true);

      // Clicking banner opens PlanReviewModal; evaluate review
      const weightLogs: WeightLogEntry[] = [
        { id: "w_start", timestampMs: BASE_TIME_MS, weightKg: 85.0 },
        { id: "w_mid", timestampMs: BASE_TIME_MS + 7 * 86400000, weightKg: 84.0 },
        { id: "w_end", timestampMs: elapsedTimestampMs, weightKg: 83.2 }
      ];

      const review = evaluateBiWeeklyReview(cycle, weightLogs, 100);
      expect(review.weightChangeKg).toBe(-1.8);
      expect(review.status).toBe("pending");

      // User inspects side-by-side comparison in PlanReviewModal and clicks "Approve New Plan"
      const { updatedCurrentCycle, newCycle } = advancePlanCycle(
        cycle,
        review,
        true,
        elapsedTimestampMs
      );

      expect(updatedCurrentCycle.status).toBe("reviewed");
      expect(newCycle.cycleNumber).toBe(2);
      expect(newCycle.status).toBe("active");
      expect(newCycle.baselineBiometrics.weightKg).toBe(83.2);

      // Commit to storage
      await adapter.setEncryptedItem(STORAGE_KEYS.PLAN_HISTORY, [updatedCurrentCycle]);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, newCycle);

      // Subsequent dashboard check: Cycle 2 is active, banner disappears
      const currentActive = await adapter.getEncryptedItem<AdaptivePlanCycle>(
        STORAGE_KEYS.ACTIVE_PLAN_CYCLE
      );
      expect(currentActive?.cycleNumber).toBe(2);
      expect(elapsedTimestampMs < currentActive!.endDateMs).toBe(true);
    });

    it("Scenario T4-7: Bi-Weekly Plan Review Rejection ('Keep Current Plan') Workflow", async () => {
      const biometrics: UserBiometrics = {
        age: 26,
        gender: "female",
        weightKg: 68.0,
        heightCm: 168.0,
        weeklyWorkoutFrequency: 4,
        goal: "cut",
        activityLevel: "moderate"
      };

      const cycle = generate14DayPlan(biometrics, BASE_TIME_MS);
      const initialDailyCalories = cycle.targetDailyCalories;
      const initialProtein = cycle.targetDailyProteinGrams;

      // Stalled progress prompts recommendation of -150 kcal
      const weightLogs: WeightLogEntry[] = [
        { id: "w1", timestampMs: BASE_TIME_MS, weightKg: 68.0 },
        { id: "w2", timestampMs: BASE_TIME_MS + 14 * 86400000, weightKg: 68.1 }
      ];
      const review = evaluateBiWeeklyReview(cycle, weightLogs, 85);
      expect(review.calorieAdjustment).toBe(-150);

      // User elects to maintain current calories and clicks "Keep Current Plan"
      const { updatedCurrentCycle, newCycle } = advancePlanCycle(
        cycle,
        review,
        false, // rejected
        BASE_TIME_MS + 14 * 86400000
      );

      expect(updatedCurrentCycle.status).toBe("completed");
      expect(newCycle.cycleNumber).toBe(2);
      // Existing target calories and macros remain unchanged
      expect(newCycle.targetDailyCalories).toBe(initialDailyCalories);
      expect(newCycle.targetDailyProteinGrams).toBe(initialProtein);

      // Persist to encrypted storage
      await adapter.setEncryptedItem(STORAGE_KEYS.PLAN_HISTORY, [updatedCurrentCycle]);
      await adapter.setEncryptedItem(STORAGE_KEYS.ACTIVE_PLAN_CYCLE, newCycle);

      const activeCycle = await adapter.getEncryptedItem<AdaptivePlanCycle>(
        STORAGE_KEYS.ACTIVE_PLAN_CYCLE
      );
      expect(activeCycle?.cycleNumber).toBe(2);
      expect(activeCycle?.targetDailyCalories).toBe(initialDailyCalories);
    });
  });
});
