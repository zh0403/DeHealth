import {
  Address,
  Bytes32,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  FoodPresetItem,
  SignedWorkoutClaimPayload,
  STANDARD_FOOD_PRESETS,
  TelemetryData,
  UserProfile,
  WorkoutExerciseItem,
  WorkoutProof
} from "@dehealth/shared";
import { Signer } from "ethers";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  applyRuntimeFatigueScaling,
  generate14DayPlan,
  scaleFoodPresetPortion
} from "../services/adaptivePlanEngine";
import {
  buildDailyCheckInCommitment,
  deriveDeterministicDailySalt,
  hashTelemetry,
  signWorkoutProof
} from "../services/cryptoService";
import { L2ServiceMode } from "../services/l2ContractService";
import {
  getTodayStepCount,
  isPedometerAvailable,
  StepCountSource
} from "../services/sensorService";
export type { StepCountSource } from "../services/sensorService";
import {
  appendEphemeralFoodLog,
  DailyEphemeralLogBuffer,
  EphemeralFoodLogEntry,
  formatLocalCalendarDateKey,
  getActivePlanCycle,
  getDailyTelemetryCommitment,
  makeDailyProofSignedKey,
  purgeDailyEphemeralLogBuffer,
  recordEphemeralExerciseTick,
  recordEphemeralStepLog,
  rolloverStaleDailyEphemeralLogBuffer,
  saveDailyProofSigned,
  saveDailyTaskCompletion,
  saveDailyTelemetryCommitment,
  saveTelemetrySalt
} from "../storage/adaptiveStorage";
import {
  DEFAULT_DAILY_STEP_GOAL,
  DEFAULT_FATIGUE_SCALING_MULTIPLIER,
  DEFAULT_INACTIVITY_THRESHOLD_HOURS
} from "../storage/governanceStorage";
import { getVaultSecret } from "../storage/vaultKeyProvider";

export interface HabitCardDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly durationText: string;
  readonly icon: string;
  readonly accentColor: string;
  readonly telemetry: {
    readonly stepCount: number;
    readonly activeMinutes: number;
    readonly avgHeartRateBpm: number;
    readonly caloriesBurnedKcal: number;
  };
}

export const HABIT_CARDS: readonly HabitCardDefinition[] = [
  {
    id: "cardio-walk",
    title: "Cardio / Brisk Walk (10 mins)",
    category: "Endurance & Cardio",
    durationText: "10 mins • 1,250 steps • 124 avg bpm",
    icon: "🏃",
    accentColor: "#10B981",
    telemetry: {
      stepCount: 1250,
      activeMinutes: 10,
      avgHeartRateBpm: 124.0,
      caloriesBurnedKcal: 68.5
    }
  },
  {
    id: "mindful-meal",
    title: "Clean / Mindful Meal",
    category: "Metabolic Nutrition",
    durationText: "1-Tap meal record • 15 mindful mins • 72 avg bpm",
    icon: "🥗",
    accentColor: "#38BDF8",
    telemetry: {
      stepCount: 0,
      activeMinutes: 15,
      avgHeartRateBpm: 72.0,
      caloriesBurnedKcal: 15.0
    }
  },
  {
    id: "mobility-recovery",
    title: "Mobility & Recovery (10-min)",
    category: "Flexibility & Restoration",
    durationText: "10 mins • 180 steps • 78 avg bpm",
    icon: "🧘",
    accentColor: "#F59E0B",
    telemetry: {
      stepCount: 180,
      activeMinutes: 10,
      avgHeartRateBpm: 78.0,
      caloriesBurnedKcal: 32.0
    }
  }
];

export type FoodMeasurementUnit = "g" | "ml" | "egg" | "serving" | "cup";

export interface FoodPresetUnitSpec {
  readonly unit: FoodMeasurementUnit;
  readonly singularLabel: string;
  readonly pluralLabel: string;
  readonly gramsPerUnit: number;
  readonly defaultQuantity: number;
  readonly quickQuantities: readonly number[];
}

export interface DetailedFoodPreset extends FoodPresetItem {
  readonly unitSpec: FoodPresetUnitSpec;
}

const FOOD_UNIT_SPEC_BY_ID: Readonly<Record<string, FoodPresetUnitSpec>> =
  Object.freeze({
    preset_chicken_breast: Object.freeze({
      unit: "g",
      singularLabel: "g",
      pluralLabel: "g",
      gramsPerUnit: 1,
      defaultQuantity: 150,
      quickQuantities: Object.freeze([100, 150, 200, 250])
    }),
    preset_brown_rice: Object.freeze({
      unit: "cup",
      singularLabel: "cup",
      pluralLabel: "cups",
      gramsPerUnit: 195,
      defaultQuantity: 1,
      quickQuantities: Object.freeze([0.5, 1, 1.5, 2])
    }),
    preset_whey_protein: Object.freeze({
      unit: "serving",
      singularLabel: "serving",
      pluralLabel: "servings",
      gramsPerUnit: 30,
      defaultQuantity: 1,
      quickQuantities: Object.freeze([1, 1.5, 2])
    }),
    preset_whole_egg: Object.freeze({
      unit: "egg",
      singularLabel: "egg",
      pluralLabel: "eggs",
      gramsPerUnit: 50,
      defaultQuantity: 2,
      quickQuantities: Object.freeze([1, 2, 3, 4])
    }),
    preset_rolled_oats: Object.freeze({
      unit: "cup",
      singularLabel: "cup",
      pluralLabel: "cups",
      gramsPerUnit: 80,
      defaultQuantity: 0.5,
      quickQuantities: Object.freeze([0.5, 1, 1.5])
    }),
    preset_greek_yogurt: Object.freeze({
      unit: "serving",
      singularLabel: "serving",
      pluralLabel: "servings",
      gramsPerUnit: 150,
      defaultQuantity: 1,
      quickQuantities: Object.freeze([0.5, 1, 1.5, 2])
    }),
    preset_white_rice: Object.freeze({
      unit: "cup",
      singularLabel: "cup",
      pluralLabel: "cups",
      gramsPerUnit: 158,
      defaultQuantity: 1,
      quickQuantities: Object.freeze([0.5, 1, 1.5, 2])
    }),
    preset_mixed_veggies: Object.freeze({
      unit: "g",
      singularLabel: "g",
      pluralLabel: "g",
      gramsPerUnit: 1,
      defaultQuantity: 150,
      quickQuantities: Object.freeze([50, 100, 150, 200])
    }),
    preset_milk_ml: Object.freeze({
      unit: "ml",
      singularLabel: "ml",
      pluralLabel: "ml",
      gramsPerUnit: 1,
      defaultQuantity: 250,
      quickQuantities: Object.freeze([100, 200, 250, 500])
    })
  });

const BASE_FOOD_PRESETS: readonly FoodPresetItem[] = [
  ...STANDARD_FOOD_PRESETS,
  Object.freeze({
    id: "preset_white_rice",
    name: "Steamed White Rice",
    servingSizeGrams: 100,
    caloriesKcal: 130,
    proteinGrams: 2.7,
    carbsGrams: 28,
    fatGrams: 0.3,
    category: "carbs"
  }),
  Object.freeze({
    id: "preset_mixed_veggies",
    name: "Mixed Steamed Veggies",
    servingSizeGrams: 100,
    caloriesKcal: 65,
    proteinGrams: 2.9,
    carbsGrams: 13,
    fatGrams: 0.4,
    category: "micronutrients"
  }),
  Object.freeze({
    id: "preset_milk_ml",
    name: "Low-Fat Milk",
    servingSizeGrams: 250,
    caloriesKcal: 125,
    proteinGrams: 8.5,
    carbsGrams: 12.5,
    fatGrams: 4.5,
    category: "dairy"
  })
];

export const DUAL_TRACK_FOOD_PRESETS: readonly DetailedFoodPreset[] = Object.freeze(
  BASE_FOOD_PRESETS.map((preset) =>
    Object.freeze({
      ...preset,
      unitSpec:
        FOOD_UNIT_SPEC_BY_ID[preset.id] ??
        Object.freeze({
          unit: "g" as const,
          singularLabel: "g",
          pluralLabel: "g",
          gramsPerUnit: 1,
          defaultQuantity: preset.servingSizeGrams > 0 ? preset.servingSizeGrams : 100,
          quickQuantities: Object.freeze([50, 100, 150, 200, 250])
        })
    })
  )
);

export type CheckInMode = "quick" | "detailed";

export interface LoggedMealRecord {
  readonly id: string;
  readonly presetId: string;
  readonly name: string;
  readonly grams: number;
  readonly quantityDisplay?: string;
  readonly caloriesKcal: number;
  readonly proteinGrams: number;
  readonly carbsGrams: number;
  readonly fatGrams: number;
}

function mapEphemeralFoodLogsToMeals(
  foodLogs: readonly EphemeralFoodLogEntry[]
): LoggedMealRecord[] {
  return [...foodLogs].reverse().map((entry) => ({
    id: entry.id,
    presetId: entry.presetId,
    name: entry.name,
    grams: entry.grams,
    caloriesKcal: entry.caloriesKcal,
    proteinGrams: entry.proteinGrams,
    carbsGrams: entry.carbsGrams,
    fatGrams: entry.fatGrams
  }));
}

function mergeEphemeralBufferIntoPlan(
  plan: DailyPlan,
  buffer: DailyEphemeralLogBuffer
): DailyPlan {
  const tickByExerciseId = new Map<string, boolean>();
  for (const tick of buffer.exerciseTicks) {
    tickByExerciseId.set(tick.exerciseId, tick.completed);
  }

  const nextExercises: WorkoutExerciseItem[] = plan.exercises.map((ex) =>
    tickByExerciseId.has(ex.id)
      ? { ...ex, completed: tickByExerciseId.get(ex.id)! }
      : ex
  );

  let foodCalories = 0;
  let foodProtein = 0;
  let foodCarbs = 0;
  let foodFat = 0;
  for (const meal of buffer.foodLogs) {
    foodCalories += meal.caloriesKcal;
    foodProtein += meal.proteinGrams;
    foodCarbs += meal.carbsGrams;
    foodFat += meal.fatGrams;
  }

  const nextCalories = Math.max(
    plan.loggedCaloriesKcal,
    Math.round(foodCalories)
  );
  const nextProtein = Math.max(
    plan.loggedProteinGrams,
    Number(foodProtein.toFixed(1))
  );
  const nextCarbs = Math.max(
    plan.loggedCarbsGrams,
    Number(foodCarbs.toFixed(1))
  );
  const nextFat = Math.max(plan.loggedFatGrams, Number(foodFat.toFixed(1)));
  const allExercisesDone =
    nextExercises.length > 0 && nextExercises.every((ex) => ex.completed);

  return {
    ...plan,
    loggedCaloriesKcal: nextCalories,
    loggedProteinGrams: nextProtein,
    loggedCarbsGrams: nextCarbs,
    loggedFatGrams: nextFat,
    exercises: nextExercises,
    completed: plan.completed || (allExercisesDone && nextCalories > 0)
  };
}

const DEFAULT_PROFILE: UserProfile = {
  age: 28,
  gender: "non-binary",
  bodyFatPct: 18.5,
  muscleMassKg: 34.0
};

/**
 * Deterministically scales a food preset to `grams` and returns updated `DailyPlan`
 * with accumulated calories and macronutrients.
 */
export function addFoodPortionToDailyPlan(
  plan: DailyPlan,
  preset: FoodPresetItem,
  grams: number
): DailyPlan {
  if (!Number.isFinite(grams) || grams <= 0) {
    throw new Error("Portion weight in grams must be a positive finite number");
  }
  const scaled = scaleFoodPresetPortion(preset, grams);
  const nextCalories = Math.round(plan.loggedCaloriesKcal + scaled.caloriesKcal);
  const nextProtein = Number((plan.loggedProteinGrams + scaled.proteinGrams).toFixed(1));
  const nextCarbs = Number((plan.loggedCarbsGrams + scaled.carbsGrams).toFixed(1));
  const nextFat = Number((plan.loggedFatGrams + scaled.fatGrams).toFixed(1));

  return {
    ...plan,
    loggedCaloriesKcal: nextCalories,
    loggedProteinGrams: nextProtein,
    loggedCarbsGrams: nextCarbs,
    loggedFatGrams: nextFat
  };
}

/**
 * Returns the measurement unit specification for a food preset, falling back
 * to gram-based scaling if no preset-specific unit is configured.
 */
export function getFoodPresetUnitSpec(preset: FoodPresetItem): FoodPresetUnitSpec {
  const maybeDetailed = preset as Partial<DetailedFoodPreset>;
  if (maybeDetailed.unitSpec) {
    return maybeDetailed.unitSpec;
  }
  const mapped = FOOD_UNIT_SPEC_BY_ID[preset.id];
  if (mapped) {
    return mapped;
  }
  return {
    unit: "g",
    singularLabel: "g",
    pluralLabel: "g",
    gramsPerUnit: 1,
    defaultQuantity: preset.servingSizeGrams > 0 ? preset.servingSizeGrams : 100,
    quickQuantities: [50, 100, 150, 200, 250]
  };
}

/**
 * Formats a food portion quantity with its unit (e.g. "150g", "250ml",
 * "1 egg", "2 eggs", "1.5 servings", "1 cup").
 */
export function formatFoodQuantityLabel(
  quantity: number,
  spec: FoodPresetUnitSpec
): string {
  const safeQty = Number.isFinite(quantity) && quantity >= 0 ? quantity : 0;
  const formattedQty = Number.isInteger(safeQty)
    ? String(safeQty)
    : String(Number(safeQty.toFixed(2)));
  if (spec.unit === "g" || spec.unit === "ml") {
    return `${formattedQty}${spec.unit}`;
  }
  const unitLabel = safeQty === 1 ? spec.singularLabel : spec.pluralLabel;
  return `${formattedQty} ${unitLabel}`;
}

/**
 * Converts a food preset quantity in its configured measurement unit to
 * equivalent grams for canonical macro scaling.
 */
export function convertFoodUnitsToGrams(
  preset: FoodPresetItem,
  quantity: number
): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Portion quantity must be a positive finite number");
  }
  const spec = getFoodPresetUnitSpec(preset);
  return Number((quantity * spec.gramsPerUnit).toFixed(2));
}

/**
 * Scales a food preset by a quantity in its measurement unit and returns the
 * equivalent grams, scaled macro breakdown, and formatted quantity label.
 */
export function scaleFoodPresetByUnits(
  preset: FoodPresetItem,
  quantity: number
): {
  readonly equivalentGrams: number;
  readonly scaled: FoodPresetItem;
  readonly quantityLabel: string;
} {
  const spec = getFoodPresetUnitSpec(preset);
  const equivalentGrams = convertFoodUnitsToGrams(preset, quantity);
  const scaled = scaleFoodPresetPortion(preset, equivalentGrams);
  const quantityLabel = formatFoodQuantityLabel(quantity, spec);
  return {
    equivalentGrams,
    scaled,
    quantityLabel
  };
}

/**
 * Deterministically scales a food preset by unit quantity and returns updated
 * `DailyPlan` with accumulated calories and macronutrients.
 */
export function addFoodUnitsToDailyPlan(
  plan: DailyPlan,
  preset: FoodPresetItem,
  quantity: number
): DailyPlan {
  const equivalentGrams = convertFoodUnitsToGrams(preset, quantity);
  return addFoodPortionToDailyPlan(plan, preset, equivalentGrams);
}

/**
 * Toggles the completion state of an exercise in `DailyPlan` by its ID.
 */
export function toggleExerciseInDailyPlan(
  plan: DailyPlan,
  exerciseId: string
): DailyPlan {
  const updatedExercises: WorkoutExerciseItem[] = plan.exercises.map((ex) =>
    ex.id === exerciseId ? { ...ex, completed: !ex.completed } : ex
  );
  const allExercisesDone =
    updatedExercises.length > 0 && updatedExercises.every((ex) => ex.completed);

  return {
    ...plan,
    exercises: updatedExercises,
    completed: allExercisesDone && plan.loggedCaloriesKcal > 0
  };
}

/**
 * Minimum completion gate: a Daily Proof may only be generated once the day has
 * at least one completed exercise, any logged nutrition intake, or a
 * hardware-verified step count meeting the configured dailyStepGoal (default
 * 5,000 steps). Manual step fallback entries are tracked for personal display
 * only and never unlock step-only Daily Proof signing.
 */
export function hasMinimumDailyProgress(
  plan: DailyPlan,
  stepCount: number = 0,
  dailyStepGoal: number = DEFAULT_DAILY_STEP_GOAL,
  stepSource: StepCountSource = "manual-fallback"
): boolean {
  const hasCompletedExercise = plan.exercises.some((ex) => ex.completed);
  const hasLoggedNutrition = plan.loggedCaloriesKcal > 0;
  const hasMetStepGoal =
    stepSource === "hardware" &&
    Number.isFinite(stepCount) &&
    Number.isFinite(dailyStepGoal) &&
    dailyStepGoal > 0 &&
    stepCount >= dailyStepGoal;
  return hasCompletedExercise || hasLoggedNutrition || hasMetStepGoal;
}

export const MINIMUM_PROGRESS_MESSAGE =
  "Complete at least 1 exercise or log a meal to unlock your Daily Proof.";

/**
 * Calculates workout checklist completion statistics.
 */
export function getWorkoutCompletionStats(
  exercises: readonly WorkoutExerciseItem[]
): {
  readonly completedCount: number;
  readonly totalCount: number;
  readonly completionPct: number;
  readonly allCompleted: boolean;
} {
  const totalCount = exercises.length;
  if (totalCount === 0) {
    return { completedCount: 0, totalCount: 0, completionPct: 100, allCompleted: true };
  }
  const completedCount = exercises.filter((ex) => ex.completed).length;
  const completionPct = Math.round((completedCount / totalCount) * 100);
  return {
    completedCount,
    totalCount,
    completionPct,
    allCompleted: completedCount === totalCount
  };
}

/**
 * Synthesizes a valid `TelemetryData` snapshot from today's dual-track `DailyPlan`
 * progress so it can be hashed locally via `hashTelemetry` (Keccak-256) without
 * any raw biometrics leaving the device.
 */
export function buildDailyPlanTelemetry(
  plan: DailyPlan,
  userProfile: UserProfile = DEFAULT_PROFILE,
  timestampMs: number = Date.now()
): TelemetryData {
  const parsedPlanDateMs = Date.parse(`${plan.date}T00:00:00.000Z`);
  const stableTimestampMs =
    Number.isFinite(parsedPlanDateMs) && parsedPlanDateMs > 0
      ? parsedPlanDateMs
      : timestampMs;

  const completedExercises = plan.exercises.filter((ex) => ex.completed);
  const totalDurationMinutes = completedExercises.reduce((acc, ex) => {
    if (ex.durationMinutes !== undefined) {
      return acc + ex.durationMinutes;
    }
    return acc + ex.sets * 3;
  }, 0);

  const activeMinutes = Math.min(1440, Math.max(10, totalDurationMinutes || 15));
  const estimatedSteps = Math.min(
    200_000,
    completedExercises.length * 1_400 + (plan.loggedCaloriesKcal > 0 ? 600 : 0)
  );
  const avgHeartRateBpm = completedExercises.length > 0 ? 128.5 : 76.0;
  const caloriesBurnedKcal = Math.min(
    25_000,
    Number((activeMinutes * 7.5 + completedExercises.length * 35).toFixed(2))
  );

  return {
    timestampMs: stableTimestampMs,
    stepCount: estimatedSteps,
    activeMinutes,
    avgHeartRateBpm,
    caloriesBurnedKcal,
    profileSnapshot: userProfile
  };
}

/**
 * Formats an EVM wallet address into a compact `0x1234…abcd` display pill.
 */
export function formatShortWalletAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length >= 10) {
    return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
  }
  return trimmed;
}

export interface MicroCheckInScreenProps {
  readonly userAddress: Address;
  readonly verifyingContract: Address;
  readonly currentStreak: number;
  readonly currentNonce: bigint;
  readonly signer?: Signer | null;
  readonly collectTelemetry?: () => TelemetryData;
  readonly userProfile?: UserProfile;
  readonly dailyPlan?: DailyPlan;
  readonly cycleId?: string;
  readonly vaultSecretHex?: string;
  readonly isProofSigned?: boolean;
  /** Timestamp of the last verified proof; drives runtime fatigue scaling. */
  readonly lastLogTimestampMs?: number | null;
  readonly dailyStepGoal?: number;
  readonly inactivityThresholdHours?: number;
  readonly fatigueScalingMultiplier?: number;
  readonly initialStepCount?: number;
  readonly initialStepSource?: StepCountSource;
  readonly initialPedometerAvailable?: boolean;
  readonly initialCheckInMode?: CheckInMode;
  readonly initialEphemeralBuffer?: DailyEphemeralLogBuffer | null;
  readonly currentDateKey?: string;
  readonly onUpdateDailyPlan?: (updatedPlan: DailyPlan) => void;
  readonly onDispatchSignedClaim: (payload: SignedWorkoutClaimPayload) => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly lastTxHash?: string | null;
  readonly lastExplorerUrl?: string | null;
  readonly lastClaimMode?: L2ServiceMode | null;
}

export const MicroCheckInScreen: React.FC<MicroCheckInScreenProps> = ({
  userAddress,
  verifyingContract,
  currentStreak,
  currentNonce,
  signer,
  collectTelemetry,
  userProfile = DEFAULT_PROFILE,
  dailyPlan: externalDailyPlan,
  cycleId,
  vaultSecretHex,
  isProofSigned: externalIsProofSigned = false,
  lastLogTimestampMs = null,
  dailyStepGoal = DEFAULT_DAILY_STEP_GOAL,
  inactivityThresholdHours = DEFAULT_INACTIVITY_THRESHOLD_HOURS,
  fatigueScalingMultiplier = DEFAULT_FATIGUE_SCALING_MULTIPLIER,
  initialStepCount,
  initialStepSource,
  initialPedometerAvailable,
  initialCheckInMode = "quick",
  initialEphemeralBuffer,
  currentDateKey,
  onUpdateDailyPlan,
  onDispatchSignedClaim,
  onError,
  lastTxHash,
  lastExplorerUrl,
  lastClaimMode = null
}) => {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const effectiveDateKey =
    currentDateKey && currentDateKey.trim().length > 0
      ? currentDateKey.trim()
      : formatLocalCalendarDateKey();

  const sameDayInitialBuffer =
    initialEphemeralBuffer &&
    initialEphemeralBuffer.dateKey === effectiveDateKey
      ? initialEphemeralBuffer
      : null;

  const [checkInMode, setCheckInMode] = useState<CheckInMode>(initialCheckInMode);
  const [ephemeralStepLogsCount, setEphemeralStepLogsCount] = useState<number>(
    () => sameDayInitialBuffer?.stepLogs.length ?? 0
  );

  const defaultInitialPlan = useMemo<DailyPlan>(() => {
    const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, Date.now());
    return cycle.dailyPlans[0]!;
  }, []);

  const [localPlan, setLocalPlan] = useState<DailyPlan>(() => {
    const scaled = applyRuntimeFatigueScaling(
      externalDailyPlan ?? defaultInitialPlan,
      lastLogTimestampMs,
      Date.now(),
      {
        inactivityThresholdHours,
        fatigueScalingMultiplier
      }
    );
    return sameDayInitialBuffer
      ? mergeEphemeralBufferIntoPlan(scaled, sameDayInitialBuffer)
      : scaled;
  });

  const isFirstPlanSyncRef = useRef<boolean>(true);
  useEffect(() => {
    if (!externalDailyPlan) {
      isFirstPlanSyncRef.current = false;
      return;
    }
    const scaled = applyRuntimeFatigueScaling(
      externalDailyPlan,
      lastLogTimestampMs,
      Date.now(),
      {
        inactivityThresholdHours,
        fatigueScalingMultiplier
      }
    );
    const resolved = sameDayInitialBuffer
      ? mergeEphemeralBufferIntoPlan(scaled, sameDayInitialBuffer)
      : scaled;
    if (isFirstPlanSyncRef.current) {
      isFirstPlanSyncRef.current = false;
      if (scaled !== externalDailyPlan && onUpdateDailyPlan) {
        onUpdateDailyPlan(resolved);
      }
      return;
    }
    setLocalPlan(resolved);
    if (scaled !== externalDailyPlan && onUpdateDailyPlan) {
      onUpdateDailyPlan(resolved);
    }
  }, [
    externalDailyPlan,
    lastLogTimestampMs,
    inactivityThresholdHours,
    fatigueScalingMultiplier,
    initialEphemeralBuffer,
    effectiveDateKey
  ]);

  const initialBufferedStep =
    initialStepCount === undefined &&
    sameDayInitialBuffer &&
    sameDayInitialBuffer.stepLogs.length > 0
      ? sameDayInitialBuffer.stepLogs[sameDayInitialBuffer.stepLogs.length - 1]!
      : null;

  const [pedometerAvailable, setPedometerAvailable] = useState<boolean>(
    initialPedometerAvailable ?? initialStepSource === "hardware"
  );
  const [todaySteps, setTodaySteps] = useState<number>(() => {
    if (
      typeof initialStepCount === "number" &&
      Number.isFinite(initialStepCount) &&
      initialStepCount >= 0
    ) {
      return Math.round(initialStepCount);
    }
    return initialBufferedStep ? initialBufferedStep.steps : 0;
  });
  const [stepSource, setStepSource] = useState<StepCountSource>(
    () =>
      initialStepSource ??
      initialBufferedStep?.source ??
      (initialPedometerAvailable ? "hardware" : "manual-fallback")
  );
  const [manualStepsInput, setManualStepsInput] = useState<string>(() => {
    if (
      typeof initialStepCount === "number" &&
      Number.isFinite(initialStepCount) &&
      initialStepCount >= 0
    ) {
      return String(Math.round(initialStepCount));
    }
    return String(initialBufferedStep ? initialBufferedStep.steps : 0);
  });
  const [stepInputError, setStepInputError] = useState<string | null>(null);
  const [isSyncingSteps, setIsSyncingSteps] = useState<boolean>(false);
  const [isUpdatingTask, setIsUpdatingTask] = useState<boolean>(false);
  const isUpdatingTaskRef = useRef<boolean>(false);

  useEffect(() => {
    if (
      initialPedometerAvailable !== undefined ||
      initialStepCount !== undefined
    ) {
      return;
    }
    let mounted = true;
    const syncSteps = async (): Promise<void> => {
      setIsSyncingSteps(true);
      try {
        const available = await isPedometerAvailable();
        const reading = await getTodayStepCount(0);
        if (!mounted) return;
        setPedometerAvailable(available);
        setTodaySteps((prev) =>
          reading.source === "hardware" || prev === 0 ? reading.steps : prev
        );
        setStepSource((prev) =>
          reading.source === "hardware" ? reading.source : prev
        );
        setManualStepsInput((prev) =>
          reading.source === "hardware" || prev === "0"
            ? String(reading.steps)
            : prev
        );
      } catch (err: unknown) {
        if (!mounted) return;
        setPedometerAvailable(false);
        setStepSource("manual-fallback");
        onErrorRef.current?.(err);
      } finally {
        setIsSyncingSteps(false);
      }
    };
    void syncSteps();
    return () => {
      mounted = false;
    };
  }, [initialPedometerAvailable, initialStepCount]);

  useEffect(() => {
    if (initialEphemeralBuffer !== undefined) {
      return;
    }
    let mounted = true;
    const hydrateAndRollover = async (): Promise<void> => {
      try {
        const res = await rolloverStaleDailyEphemeralLogBuffer(effectiveDateKey);
        if (!mounted) {
          return;
        }
        if (res.purged) {
          setLoggedMeals([]);
          setEphemeralStepLogsCount(0);
          return;
        }
        if (res.activeBuffer) {
          const activeBuffer = res.activeBuffer;
          setLoggedMeals(mapEphemeralFoodLogsToMeals(activeBuffer.foodLogs));
          setEphemeralStepLogsCount(activeBuffer.stepLogs.length);
          if (initialStepCount === undefined && activeBuffer.stepLogs.length > 0) {
            const latestStep =
              activeBuffer.stepLogs[activeBuffer.stepLogs.length - 1]!;
            setTodaySteps(latestStep.steps);
            setStepSource(latestStep.source);
            setManualStepsInput(String(latestStep.steps));
          }
          setLocalPlan((prev) =>
            mergeEphemeralBufferIntoPlan(prev, activeBuffer)
          );
        }
      } catch {
        // Non-fatal if vault or storage backend is uninitialized
      }
    };
    void hydrateAndRollover();
    return () => {
      mounted = false;
    };
  }, [effectiveDateKey, initialEphemeralBuffer, initialStepCount]);

  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    DUAL_TRACK_FOOD_PRESETS[0]!.id
  );
  const [portionQuantityInput, setPortionQuantityInput] = useState<string>(
    String(DUAL_TRACK_FOOD_PRESETS[0]!.unitSpec.defaultQuantity)
  );
  const [loggedMeals, setLoggedMeals] = useState<readonly LoggedMealRecord[]>(
    () =>
      sameDayInitialBuffer
        ? mapEphemeralFoodLogsToMeals(sameDayInitialBuffer.foodLogs)
        : []
  );

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const isSubmittingRef = useRef<boolean>(false);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [statusStep, setStatusStep] = useState<string>(
    "Track meals & tick off exercises to unlock your Daily Proof"
  );
  const [lastSignedPayload, setLastSignedPayload] =
    useState<SignedWorkoutClaimPayload | null>(null);
  const [completedHabit, setCompletedHabit] =
    useState<HabitCardDefinition | null>(null);
  const [isPayloadModalOpen, setIsPayloadModalOpen] = useState<boolean>(false);
  const [l2MintSimulation, setL2MintSimulation] = useState<{
    readonly txHash: string;
    readonly blockNumber: number;
    readonly status: string;
  } | null>(null);

  const selectedPreset = useMemo<DetailedFoodPreset>(() => {
    return (
      DUAL_TRACK_FOOD_PRESETS.find((item) => item.id === selectedPresetId) ??
      DUAL_TRACK_FOOD_PRESETS[0]!
    );
  }, [selectedPresetId]);

  const parsedQuantity = useMemo<number>(() => {
    const val = Number(portionQuantityInput.trim());
    return Number.isFinite(val) && val > 0 ? val : 0;
  }, [portionQuantityInput]);

  const equivalentGrams = useMemo<number>(() => {
    return parsedQuantity > 0
      ? convertFoodUnitsToGrams(selectedPreset, parsedQuantity)
      : 0;
  }, [selectedPreset, parsedQuantity]);

  const quantityLabel = useMemo<string>(() => {
    return formatFoodQuantityLabel(parsedQuantity, selectedPreset.unitSpec);
  }, [parsedQuantity, selectedPreset]);

  const scaledPreview = useMemo<FoodPresetItem>(() => {
    return scaleFoodPresetPortion(selectedPreset, equivalentGrams);
  }, [selectedPreset, equivalentGrams]);

  const workoutStats = useMemo(
    () => getWorkoutCompletionStats(localPlan.exercises),
    [localPlan.exercises]
  );

  const canSignProof = useMemo<boolean>(
    () =>
      hasMinimumDailyProgress(localPlan, todaySteps, dailyStepGoal, stepSource),
    [localPlan, todaySteps, dailyStepGoal, stepSource]
  );

  const stepGoalProgressPct = useMemo<number>(() => {
    if (dailyStepGoal <= 0) return 0;
    return Math.min(100, Math.round((todaySteps / dailyStepGoal) * 100));
  }, [todaySteps, dailyStepGoal]);

  const fatigueReductionPct = Math.round((1 - fatigueScalingMultiplier) * 100);

  const resolvedCycleId =
    cycleId && cycleId.trim().length > 0 ? cycleId.trim() : "default_cycle";
  const resolvedDayIndex = Math.max(0, localPlan.dayNumber - 1);
  const proofSignedKey = makeDailyProofSignedKey(resolvedCycleId, resolvedDayIndex);
  const [localProofSignedKeys, setLocalProofSignedKeys] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const isProofLocked = Boolean(
    externalIsProofSigned || localProofSignedKeys[proofSignedKey]
  );

  const calorieProgressPct = useMemo<number>(() => {
    if (localPlan.targetCaloriesKcal <= 0) return 0;
    return Math.min(
      100,
      Math.round((localPlan.loggedCaloriesKcal / localPlan.targetCaloriesKcal) * 100)
    );
  }, [localPlan.loggedCaloriesKcal, localPlan.targetCaloriesKcal]);

  const proteinProgressPct = useMemo<number>(() => {
    if (localPlan.targetProteinGrams <= 0) return 0;
    return Math.min(
      100,
      Math.round((localPlan.loggedProteinGrams / localPlan.targetProteinGrams) * 100)
    );
  }, [localPlan.loggedProteinGrams, localPlan.targetProteinGrams]);

  const applyPlanUpdate = (nextPlan: DailyPlan): void => {
    setLocalPlan(nextPlan);
    if (onUpdateDailyPlan) {
      onUpdateDailyPlan(nextPlan);
    }
  };

  const recordFoodPortion = async (
    preset: FoodPresetItem,
    grams: number,
    idPrefix: string,
    buildStatus: (scaled: FoodPresetItem) => string,
    quantityDisplay?: string
  ): Promise<void> => {
    const updatedPlan = addFoodPortionToDailyPlan(localPlan, preset, grams);
    applyPlanUpdate(updatedPlan);

    const nowMs = Date.now();
    const scaled = scaleFoodPresetPortion(preset, grams);
    const newMeal: LoggedMealRecord = {
      id: `${idPrefix}_${nowMs}_${loggedMeals.length + 1}`,
      presetId: preset.id,
      name: preset.name,
      grams,
      ...(quantityDisplay ? { quantityDisplay } : {}),
      caloriesKcal: scaled.caloriesKcal,
      proteinGrams: scaled.proteinGrams,
      carbsGrams: scaled.carbsGrams,
      fatGrams: scaled.fatGrams
    };
    setLoggedMeals((prev) => [newMeal, ...prev]);
    setStatusStep(buildStatus(scaled));

    try {
      await appendEphemeralFoodLog({
        dateKey: effectiveDateKey,
        cycleId: resolvedCycleId,
        dayNumber: localPlan.dayNumber,
        entry: {
          id: newMeal.id,
          presetId: newMeal.presetId,
          name: newMeal.name,
          grams: newMeal.grams,
          caloriesKcal: newMeal.caloriesKcal,
          proteinGrams: newMeal.proteinGrams,
          carbsGrams: newMeal.carbsGrams,
          fatGrams: newMeal.fatGrams,
          loggedAtMs: nowMs
        }
      });
      await saveDailyTaskCompletion(localPlan.dayNumber, "nutrition_logged", true);
    } catch {
      // Non-fatal in preview environments
    }
  };

  const handleLogFoodPortion = async (): Promise<void> => {
    if (isUpdatingTaskRef.current || isUpdatingTask) {
      return;
    }
    if (parsedQuantity <= 0 || equivalentGrams <= 0) {
      setStatusStep(
        `Please enter a valid portion amount in ${selectedPreset.unitSpec.pluralLabel} (> 0).`
      );
      return;
    }

    isUpdatingTaskRef.current = true;
    setIsUpdatingTask(true);
    try {
      await recordFoodPortion(
        selectedPreset,
        equivalentGrams,
        "meal",
        (scaled) =>
          `Logged ${quantityLabel} ${selectedPreset.name} (+${Math.round(scaled.caloriesKcal)} kcal, +${scaled.proteinGrams}g P)`,
        quantityLabel
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to log food portion";
      setStatusStep(`Meal log failed: ${message}`);
      onErrorRef.current?.(err);
    } finally {
      isUpdatingTaskRef.current = false;
      setIsUpdatingTask(false);
    }
  };

  const handleToggleExercise = async (exerciseId: string): Promise<void> => {
    if (isUpdatingTaskRef.current || isUpdatingTask) {
      return;
    }
    isUpdatingTaskRef.current = true;
    setIsUpdatingTask(true);
    try {
      const updatedPlan = toggleExerciseInDailyPlan(localPlan, exerciseId);
      applyPlanUpdate(updatedPlan);

      const toggled = updatedPlan.exercises.find((ex) => ex.id === exerciseId);
      if (toggled) {
        const nextStats = getWorkoutCompletionStats(updatedPlan.exercises);
        setStatusStep(
          toggled.completed
            ? `Checked off ${toggled.name} (${nextStats.completedCount}/${nextStats.totalCount})`
            : `Unchecked ${toggled.name}`
        );
        try {
          await recordEphemeralExerciseTick({
            dateKey: effectiveDateKey,
            cycleId: resolvedCycleId,
            dayNumber: localPlan.dayNumber,
            tick: {
              exerciseId: toggled.id,
              name: toggled.name,
              completed: toggled.completed,
              updatedAtMs: Date.now()
            }
          });
          await saveDailyTaskCompletion(
            localPlan.dayNumber,
            `exercise_${exerciseId}`,
            toggled.completed
          );
        } catch {
          // Non-fatal in preview environments
        }
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to update exercise";
      setStatusStep(`Exercise update failed: ${message}`);
      onErrorRef.current?.(err);
    } finally {
      isUpdatingTaskRef.current = false;
      setIsUpdatingTask(false);
    }
  };

  const handleQuickWorkoutDone = async (): Promise<void> => {
    if (isUpdatingTaskRef.current || isUpdatingTask) {
      return;
    }
    isUpdatingTaskRef.current = true;
    setIsUpdatingTask(true);
    try {
      const incomplete = localPlan.exercises.filter((ex) => !ex.completed);
      const nextExercises: WorkoutExerciseItem[] = localPlan.exercises.map(
        (ex) => ({
          ...ex,
          completed: true
        })
      );
      const allExercisesDone =
        nextExercises.length > 0 && nextExercises.every((ex) => ex.completed);
      const nextPlan: DailyPlan = {
        ...localPlan,
        exercises: nextExercises,
        completed: allExercisesDone && localPlan.loggedCaloriesKcal > 0
      };
      applyPlanUpdate(nextPlan);
      setStatusStep(
        `Express workout marked done (${nextExercises.length}/${nextExercises.length} exercises) — Daily Proof unlocked!`
      );

      const targetTicks = incomplete.length > 0 ? incomplete : nextExercises;
      const nowMs = Date.now();
      try {
        for (const ex of targetTicks) {
          await recordEphemeralExerciseTick({
            dateKey: effectiveDateKey,
            cycleId: resolvedCycleId,
            dayNumber: localPlan.dayNumber,
            tick: {
              exerciseId: ex.id,
              name: ex.name,
              completed: true,
              updatedAtMs: nowMs
            }
          });
          await saveDailyTaskCompletion(
            localPlan.dayNumber,
            `exercise_${ex.id}`,
            true
          );
        }
      } catch {
        // Non-fatal in preview environments
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to complete quick workout";
      setStatusStep(`Quick workout update failed: ${message}`);
      onErrorRef.current?.(err);
    } finally {
      isUpdatingTaskRef.current = false;
      setIsUpdatingTask(false);
    }
  };

  const handleQuickNutritionDone = async (): Promise<void> => {
    if (isUpdatingTaskRef.current || isUpdatingTask) {
      return;
    }
    isUpdatingTaskRef.current = true;
    setIsUpdatingTask(true);
    try {
      const basePreset = DUAL_TRACK_FOOD_PRESETS[0]!;
      const quickGrams =
        localPlan.loggedCaloriesKcal === 0
          ? Math.max(
              150,
              Math.round(
                (Math.max(330, Math.round(localPlan.targetCaloriesKcal * 0.25)) /
                  Math.max(1, basePreset.caloriesKcal)) *
                  basePreset.servingSizeGrams
              )
            )
          : 150;
      await recordFoodPortion(
        basePreset,
        quickGrams,
        "meal_quick",
        (scaled) =>
          `Express nutrition target met (+${Math.round(scaled.caloriesKcal)} kcal, +${scaled.proteinGrams}g P) — Daily Proof unlocked!`
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to log quick nutrition";
      setStatusStep(`Quick nutrition update failed: ${message}`);
      onErrorRef.current?.(err);
    } finally {
      isUpdatingTaskRef.current = false;
      setIsUpdatingTask(false);
    }
  };

  const handleApplyManualSteps = async (): Promise<void> => {
    const trimmed = manualStepsInput.trim();
    const parsed = Number(trimmed);
    if (
      trimmed === "" ||
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > 200_000
    ) {
      setStepInputError("Enter a valid step count between 0 and 200,000.");
      return;
    }
    setStepInputError(null);
    setTodaySteps(parsed);
    setStepSource("manual-fallback");
    setEphemeralStepLogsCount((prev) => prev + 1);
    setStatusStep(
      parsed >= dailyStepGoal
        ? `Manual step goal reached (${parsed} / ${dailyStepGoal} steps) — tracked for personal progress (log a meal or exercise to unlock Daily Proof).`
        : `Updated local step count: ${parsed} / ${dailyStepGoal} steps (on-device only).`
    );

    const nowMs = Date.now();
    try {
      await recordEphemeralStepLog({
        dateKey: effectiveDateKey,
        cycleId: resolvedCycleId,
        dayNumber: localPlan.dayNumber,
        entry: {
          id: `step_${nowMs}`,
          steps: parsed,
          source: "manual-fallback",
          recordedAtMs: nowMs
        }
      });
    } catch {
      // Non-fatal in preview environments
    }
  };

  const handleSignAndDispatchProof = async (
    cardOverride?: HabitCardDefinition
  ): Promise<void> => {
    if (isSubmittingRef.current || isSubmitting || isProofLocked) return;
    if (
      !hasMinimumDailyProgress(localPlan, todaySteps, dailyStepGoal, stepSource)
    ) {
      setStatusStep(MINIMUM_PROGRESS_MESSAGE);
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setActiveCardId(cardOverride?.id ?? "dual-track-proof");
    setL2MintSimulation(null);

    try {
      setStatusStep("1/3 Hashing local completion summary (Keccak-256)...");
      const telemetry: TelemetryData = collectTelemetry
        ? collectTelemetry()
        : cardOverride
          ? {
              timestampMs: Date.now(),
              stepCount: cardOverride.telemetry.stepCount,
              activeMinutes: cardOverride.telemetry.activeMinutes,
              avgHeartRateBpm: cardOverride.telemetry.avgHeartRateBpm,
              caloriesBurnedKcal: cardOverride.telemetry.caloriesBurnedKcal,
              profileSnapshot: userProfile
            }
          : buildDailyPlanTelemetry(localPlan, userProfile, Date.now());

      const resolvedVaultSecret = vaultSecretHex ?? (await getVaultSecret());
      const effectiveCycleId =
        cycleId && cycleId.trim().length > 0
          ? cycleId.trim()
          : (await getActivePlanCycle().catch(() => null))?.id ?? "default_cycle";
      const dayIndex = Math.max(0, localPlan.dayNumber - 1);

      const existingCommitment = await getDailyTelemetryCommitment(
        effectiveCycleId,
        dayIndex
      ).catch(() => null);

      const deterministicSalt = deriveDeterministicDailySalt(
        resolvedVaultSecret,
        effectiveCycleId,
        dayIndex
      );

      const freshCommitment = collectTelemetry
        ? hashTelemetry(telemetry, deterministicSalt)
        : buildDailyCheckInCommitment({
            vaultSecretHex: resolvedVaultSecret,
            cycleId: effectiveCycleId,
            dayIndex,
            planDate: localPlan.date,
            timestampMs: Date.now()
          });

      const telemetryHash: Bytes32 =
        existingCommitment ?? freshCommitment.telemetryHash;
      const salt: Bytes32 = freshCommitment.salt;

      try {
        await saveDailyTelemetryCommitment(effectiveCycleId, dayIndex, telemetryHash);
        // Salt stays in the encrypted local vault so the owner can later reveal
        // and verify the commitment. It is never part of the signed payload.
        await saveTelemetrySalt(telemetryHash, salt);
      } catch {
        // Non-fatal: the commitment is still valid, only later reveal is lost.
      }

      setStatusStep("2/3 Signing EIP-712 WorkoutProof on-device...");
      const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const proof: WorkoutProof = {
        user: userAddress,
        telemetryHash,
        streakCount: BigInt(currentStreak + 1),
        nonce: currentNonce,
        deadline: deadlineSeconds
      };

      if (!signer) {
        throw new Error(
          "Wallet signer is disconnected. Please sign in again before signing."
        );
      }
      const signedPayload = await signWorkoutProof(signer, proof, verifyingContract);

      setStatusStep("3/3 Dispatching verified proof to DeHealthRewardGate...");
      await onDispatchSignedClaim(signedPayload);

      try {
        await purgeDailyEphemeralLogBuffer();
      } catch {
        // Non-fatal in preview environments
      }
      setLoggedMeals([]);
      setEphemeralStepLogsCount(0);

      const signedKey = makeDailyProofSignedKey(effectiveCycleId, dayIndex);
      setLocalProofSignedKeys((prev) => ({
        ...prev,
        [proofSignedKey]: true,
        [signedKey]: true
      }));

      const completedPlan: DailyPlan = { ...localPlan, completed: true };
      applyPlanUpdate(completedPlan);
      try {
        await saveDailyProofSigned(effectiveCycleId, dayIndex, true);
      } catch {
        // Non-fatal
      }

      setLastSignedPayload(signedPayload);
      setCompletedHabit(
        cardOverride ?? {
          id: "dual-track-daily-plan",
          title: `Day ${localPlan.dayNumber} Adaptive Plan Complete`,
          category: "Dual-Track Nutrition & Training",
          durationText: `${localPlan.loggedCaloriesKcal} kcal logged • ${workoutStats.completedCount}/${workoutStats.totalCount} exercises`,
          icon: "⚡",
          accentColor: "#10B981",
          telemetry: {
            stepCount: telemetry.stepCount,
            activeMinutes: telemetry.activeMinutes,
            avgHeartRateBpm: telemetry.avgHeartRateBpm,
            caloriesBurnedKcal: telemetry.caloriesBurnedKcal
          }
        }
      );
      setStatusStep(
        `Verified! Proof ${telemetryHash.slice(0, 10)}... signed & dispatched.`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown signing error";
      setStatusStep(`Check-in failed: ${message}`);
      onErrorRef.current?.(err);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      setActiveCardId(null);
    }
  };

  const handleSimulateL2Mint = (): void => {
    if (!lastSignedPayload) return;
    const hashSuffix = lastSignedPayload.proof.telemetryHash.slice(2, 58);
    setL2MintSimulation({
      txHash: `0x99a4b7c2${hashSuffix}`,
      blockNumber: 4_819_204 + currentStreak,
      status: "Simulated Local Mint (Demo Mode — Configure L2 .env for Live Arbitrum)"
    });
  };

  const renderStepStatusBadge = (): React.ReactNode => (
    <View
      accessibilityLabel="Daily Step Counter Status"
      accessibilityState={{ busy: isSyncingSteps }}
      style={
        pedometerAvailable && stepSource === "hardware"
          ? styles.workoutProgressBadge
          : styles.manualStepBadge
      }
    >
      <Text
        style={
          pedometerAvailable && stepSource === "hardware"
            ? styles.workoutProgressBadgeText
            : styles.manualStepBadgeText
        }
      >
        {isSyncingSteps
          ? "Syncing steps..."
          : pedometerAvailable && stepSource === "hardware"
            ? "Hardware Pedometer"
            : "Manual Step Fallback"}
      </Text>
    </View>
  );

  const renderStepEligibilityNotice = (): React.ReactNode => {
    if (todaySteps >= dailyStepGoal) {
      return stepSource === "hardware" ? (
        <Text style={styles.stepGoalMetText}>
          ✓ Daily step goal reached ({dailyStepGoal.toLocaleString()}+ steps) — Daily Proof eligible
        </Text>
      ) : (
        <Text style={styles.stepGoalPersonalText}>
          ✓ Personal step goal reached ({dailyStepGoal.toLocaleString()}+ steps) — tracked on-device
        </Text>
      );
    }
    return (
      <Text style={styles.stepSovereigntyHint}>
        Raw step counts stay strictly on-device and never leave to Supabase or L2.
      </Text>
    );
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.heroHeader}>
        <View style={styles.heroBadgeRow}>
          <Text style={styles.dayBadge}>DAY {localPlan.dayNumber} OF 14</Text>
          {localPlan.isFatigueScaled ? (
            <Text style={styles.fatiguePill}>
              🛡️ Recovery Mode (-{fatigueReductionPct}% Volume)
            </Text>
          ) : (
            <Text style={styles.sovereigntyPill}>🔒 100% On-Device Biometrics</Text>
          )}
        </View>
        <Text style={styles.heading}>Daily Adaptive Check-In</Text>
        <Text style={styles.subtitle}>
          Log portions with deterministic macro math and tick off your scheduled
          workout sets. Only your 32-byte Keccak-256 digest leaves the phone.
        </Text>
      </View>

      {/* Segmented Mode Toggle */}
      <View style={styles.modeToggleRow}>
        <Pressable
          testID="checkin-mode-quick"
          accessibilityRole="tab"
          accessibilityLabel="Quick Check (<60s)"
          accessibilityState={{ selected: checkInMode === "quick" }}
          style={[
            styles.modeToggleTab,
            checkInMode === "quick" ? styles.modeToggleTabActive : null
          ]}
          onPress={() => {
            setCheckInMode("quick");
          }}
        >
          <Text
            style={[
              styles.modeToggleTabText,
              checkInMode === "quick" ? styles.modeToggleTabTextActive : null
            ]}
          >
            Quick Check (&lt;60s)
          </Text>
        </Pressable>

        <Pressable
          testID="checkin-mode-detailed"
          accessibilityRole="tab"
          accessibilityLabel="Detailed Log"
          accessibilityState={{ selected: checkInMode === "detailed" }}
          style={[
            styles.modeToggleTab,
            checkInMode === "detailed" ? styles.modeToggleTabActive : null
          ]}
          onPress={() => {
            setCheckInMode("detailed");
          }}
        >
          <Text
            style={[
              styles.modeToggleTabText,
              checkInMode === "detailed" ? styles.modeToggleTabTextActive : null
            ]}
          >
            Detailed Log
          </Text>
        </Pressable>
      </View>

      {/* Privacy & 11:59 PM Settlement Notice Banner */}
      <View testID="ephemeral-buffer-notice" style={styles.ephemeralNoticeBanner}>
        <Text style={styles.ephemeralNoticeCounts}>
          {loggedMeals.length} meals • {workoutStats.completedCount}/
          {workoutStats.totalCount} exercises • {todaySteps.toLocaleString()} steps
          {ephemeralStepLogsCount > 0
            ? ` (${ephemeralStepLogsCount} step updates)`
            : ""}
        </Text>
        <Text style={styles.ephemeralNoticeBody}>
          Encrypted local daily buffer • Auto-purges after proof signing • 11:59 PM
          daily settlement reminder (unsigned logs from prior days auto-purge at
          midnight rollover).
        </Text>
      </View>

      {/* Celebratory Completion Banner */}
      {lastSignedPayload && completedHabit ? (
        <View style={styles.celebrationCard}>
          <View style={styles.celebrationTopRow}>
            <View style={styles.ringClosedCircle}>
              <Text style={styles.ringClosedIcon}>🔥</Text>
            </View>
            <View style={styles.celebrationTextCol}>
              <Text style={styles.celebrationTitle}>
                Daily Ring Closed! +10 $DHT
              </Text>
              <Text style={styles.celebrationSubtitle}>
                {completedHabit.title} • Streak #{currentStreak}
              </Text>
            </View>
          </View>

          <View style={styles.proofSummaryBox}>
            <Text style={styles.proofSummaryLabel}>
              EIP-712 TELEMETRY DIGEST (KECCAK-256)
            </Text>
            <Text
              style={styles.proofHashMono}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {lastSignedPayload.proof.telemetryHash}
            </Text>
          </View>

          <View style={styles.celebrationActionsRow}>
            <Pressable
              style={styles.l2MintButton}
              onPress={handleSimulateL2Mint}
            >
              <Text style={styles.l2MintButtonText}>
                ⚡ Trigger L2 Reward Mint
              </Text>
            </Pressable>

            <Pressable
              style={styles.inspectProofButton}
              onPress={() => {
                setIsPayloadModalOpen(true);
              }}
            >
              <Text style={styles.inspectProofButtonText}>
                🔍 Inspect Proof
              </Text>
            </Pressable>
          </View>

          {l2MintSimulation || lastTxHash ? (
            <View style={styles.l2ReceiptBox}>
              <Text style={styles.l2ReceiptTitle}>
                ✓{" "}
                {l2MintSimulation
                  ? l2MintSimulation.status
                  : lastClaimMode === "live"
                    ? "Confirmed on Arbitrum Sepolia (10.0 $DHT Minted)"
                    : "Simulated Local Mint (Demo Mode — Configure L2 .env for Live Arbitrum)"}
              </Text>
              <Text
                style={styles.l2ReceiptMeta}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                Tx: {lastTxHash ?? l2MintSimulation?.txHash}
              </Text>
              {!l2MintSimulation && lastClaimMode === "live" && lastExplorerUrl ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="View transaction on Arbiscan Sepolia"
                  onPress={() => {
                    void Linking.openURL(lastExplorerUrl).catch(() => undefined);
                  }}
                  style={{ marginTop: 4 }}
                >
                  <Text style={styles.l2ExplorerLink}>
                    View on Arbiscan Sepolia ↗
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {checkInMode === "quick" ? (
        <View testID="quick-checkin-panel">
          <Pressable
            testID="quick-workout-done-btn"
            accessibilityRole="button"
            accessibilityLabel="Express Workout Done"
            accessibilityState={{ disabled: isUpdatingTask }}
            disabled={isUpdatingTask}
            style={[
              styles.quickActionCard,
              workoutStats.allCompleted ? styles.quickActionCardCompleted : null,
              isUpdatingTask ? styles.buttonDisabled : null
            ]}
            onPress={() => {
              void handleQuickWorkoutDone();
            }}
          >
            <View style={styles.quickActionTextCol}>
              <Text style={styles.trackTag}>QUICK WORKOUT • 1-TAP</Text>
              <Text style={styles.quickCardTitle}>🏋️ Express Workout Done</Text>
              <Text style={styles.quickCardSub}>
                {workoutStats.completedCount}/{workoutStats.totalCount} done
                {localPlan.isFatigueScaled
                  ? ` • -${fatigueReductionPct}% Fatigue Scaled`
                  : ""}
              </Text>
            </View>
            <Text style={styles.quickActionCta}>
              {workoutStats.allCompleted ? "Done ✓" : "Mark Done →"}
            </Text>
          </Pressable>

          <Pressable
            testID="quick-nutrition-done-btn"
            accessibilityRole="button"
            accessibilityLabel="Express Nutrition Target Met"
            accessibilityState={{ disabled: isUpdatingTask }}
            disabled={isUpdatingTask}
            style={[
              styles.quickActionCard,
              localPlan.loggedCaloriesKcal > 0
                ? styles.quickActionCardCompleted
                : null,
              isUpdatingTask ? styles.buttonDisabled : null
            ]}
            onPress={() => {
              void handleQuickNutritionDone();
            }}
          >
            <View style={styles.quickActionTextCol}>
              <Text style={styles.trackTag}>QUICK NUTRITION • 1-TAP</Text>
              <Text style={styles.quickCardTitle}>
                🥗 Express Nutrition Target Met
              </Text>
              <Text style={styles.quickCardSub}>
                {localPlan.loggedCaloriesKcal} / {localPlan.targetCaloriesKcal} kcal •{" "}
                {loggedMeals.length} meals
              </Text>
            </View>
            <Text style={styles.quickActionCta}>
              {localPlan.loggedCaloriesKcal > 0 ? "Logged ✓" : "Log Target →"}
            </Text>
          </Pressable>

          <View testID="quick-step-goal-card" style={styles.trackCard}>
            <View style={styles.trackHeaderRow}>
              <View>
                <Text style={styles.trackTag}>STEP VERIFICATION</Text>
                <Text style={styles.quickCardTitle}>
                  👟 Hardware Step Goal Reached
                </Text>
              </View>
              {renderStepStatusBadge()}
            </View>

            <View style={styles.stepSummaryRow}>
              <Text style={styles.stepCountText}>
                {todaySteps.toLocaleString()} / {dailyStepGoal.toLocaleString()} steps
              </Text>
              <Text style={styles.stepPctText}>{stepGoalProgressPct}%</Text>
            </View>

            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  { width: `${stepGoalProgressPct}%` }
                ]}
              />
            </View>

            {renderStepEligibilityNotice()}

            {!pedometerAvailable || stepSource === "manual-fallback" ? (
              <View style={styles.manualProgressBadge}>
                <Text style={styles.manualProgressBadgeText}>
                  Manual entry tracked for personal progress (hardware pedometer required for step-only proof unlock)
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : (
        <>
          {/* ===================================================================== */}
          {/* TRACK 1: NUTRITION & CALORIE TARGET CARD (QUICK FOOD & GRAM CALC)     */}
          {/* ===================================================================== */}
          <View style={styles.trackCard}>
        <View style={styles.trackHeaderRow}>
          <View>
            <Text style={styles.trackTag}>TRACK 1 • DETERMINISTIC NUTRITION</Text>
            <Text style={styles.trackTitle}>🥗 Calorie & Macro Calculator</Text>
          </View>
          <View style={styles.kcalBadge}>
            <Text style={styles.kcalBadgeText}>
              {localPlan.loggedCaloriesKcal} / {localPlan.targetCaloriesKcal} kcal
            </Text>
          </View>
        </View>

        {/* Calorie Progress Bar */}
        <View style={styles.progressBarBg}>
          <View
            style={[
              styles.progressBarFill,
              { width: `${calorieProgressPct}%` }
            ]}
          />
        </View>

        {/* Protein Progress Bar & Macro Summary Row */}
        <View style={styles.macroSummaryRow}>
          <View style={styles.macroPill}>
            <Text style={styles.macroPillLabel}>Protein ({proteinProgressPct}%)</Text>
            <Text style={styles.macroPillValue}>
              {localPlan.loggedProteinGrams}g / {localPlan.targetProteinGrams}g
            </Text>
          </View>
          <View style={styles.macroPill}>
            <Text style={styles.macroPillLabel}>Carbs</Text>
            <Text style={styles.macroPillValue}>
              {localPlan.loggedCarbsGrams}g / {localPlan.targetCarbsGrams}g
            </Text>
          </View>
          <View style={styles.macroPill}>
            <Text style={styles.macroPillLabel}>Fat</Text>
            <Text style={styles.macroPillValue}>
              {localPlan.loggedFatGrams}g / {localPlan.targetFatGrams}g
            </Text>
          </View>
        </View>

        {/* Food Preset Selector */}
        <Text style={styles.sectionSubLabel}>Select Food Preset:</Text>
        <View style={styles.presetChipGrid}>
          {DUAL_TRACK_FOOD_PRESETS.map((preset) => {
            const isSelected = preset.id === selectedPreset.id;
            return (
              <Pressable
                key={preset.id}
                testID={`food-preset-chip-${preset.id}`}
                style={[
                  styles.presetChip,
                  isSelected ? styles.presetChipActive : null
                ]}
                onPress={() => {
                  setSelectedPresetId(preset.id);
                  setPortionQuantityInput(String(preset.unitSpec.defaultQuantity));
                }}
              >
                <Text
                  style={[
                    styles.presetChipText,
                    isSelected ? styles.presetChipTextActive : null
                  ]}
                >
                  {preset.name} ({preset.unitSpec.unit})
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Portion Unit Quick Buttons & Custom Input */}
        <Text style={styles.sectionSubLabel}>
          Portion Amount ({selectedPreset.unitSpec.pluralLabel}):
        </Text>
        <View style={styles.gramControlRow}>
          <View style={styles.gramQuickRow}>
            {selectedPreset.unitSpec.quickQuantities.map((qty) => {
              const isSelected = parsedQuantity === qty;
              return (
                <Pressable
                  key={qty}
                  testID={`portion-quick-btn-${qty}`}
                  style={[
                    styles.gramQuickBtn,
                    isSelected ? styles.gramQuickBtnActive : null
                  ]}
                  onPress={() => {
                    setPortionQuantityInput(String(qty));
                  }}
                >
                  <Text
                    style={[
                      styles.gramQuickBtnText,
                      isSelected ? styles.gramQuickBtnTextActive : null
                    ]}
                  >
                    {formatFoodQuantityLabel(qty, selectedPreset.unitSpec)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <TextInput
            testID="portion-quantity-input"
            style={styles.gramInput}
            value={portionQuantityInput}
            onChangeText={setPortionQuantityInput}
            keyboardType="numeric"
            placeholder={selectedPreset.unitSpec.pluralLabel}
            placeholderTextColor="#64748B"
            accessibilityLabel="Portion grams input"
          />
        </View>

        {/* Live Portion Math Preview & Log Action */}
        <View style={styles.portionPreviewRow}>
          <View style={styles.portionPreviewTextCol}>
            <Text style={styles.portionPreviewTitle}>
              {quantityLabel} {selectedPreset.name}
            </Text>
            <Text style={styles.portionPreviewMacros}>
              {Math.round(scaledPreview.caloriesKcal)} kcal • {scaledPreview.proteinGrams}g P •{" "}
              {scaledPreview.carbsGrams}g C • {scaledPreview.fatGrams}g F
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log Food Portion"
            accessibilityState={{ disabled: isUpdatingTask }}
            disabled={isUpdatingTask}
            style={[
              styles.logFoodBtn,
              isUpdatingTask ? styles.buttonDisabled : null
            ]}
            onPress={() => {
              void handleLogFoodPortion();
            }}
          >
            <Text style={styles.logFoodBtnText}>+ Log Portion</Text>
          </Pressable>
        </View>

        {loggedMeals.length > 0 ? (
          <View style={styles.loggedMealsList}>
            <Text style={styles.loggedMealsHeader}>
              Today&apos;s Logged Portions ({loggedMeals.length})
            </Text>
            {loggedMeals.slice(0, 4).map((meal) => (
              <View key={meal.id} style={styles.loggedMealRow}>
                <Text style={styles.loggedMealName}>
                  {meal.name} ({meal.quantityDisplay ?? `${meal.grams}g`})
                </Text>
                <Text style={styles.loggedMealMacros}>
                  +{Math.round(meal.caloriesKcal)} kcal • {meal.proteinGrams}g P
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* ===================================================================== */}
      {/* TRACK 2: SCHEDULED WORKOUT CHECKLIST CARD                             */}
      {/* ===================================================================== */}
      <View style={styles.trackCard}>
        <View style={styles.trackHeaderRow}>
          <View>
            <Text style={styles.trackTag}>TRACK 2 • SCHEDULED TRAINING</Text>
            <Text style={styles.trackTitle}>🏋️ Workout Checklist</Text>
          </View>
          <View style={styles.workoutProgressBadge}>
            <Text style={styles.workoutProgressBadgeText}>
              {workoutStats.completedCount}/{workoutStats.totalCount} Done ({workoutStats.completionPct}%)
            </Text>
          </View>
        </View>

        {localPlan.exercises.map((exercise) => {
          const detailText =
            exercise.durationMinutes !== undefined
              ? `${exercise.sets} sets × ${exercise.durationMinutes} min`
              : `${exercise.sets} sets × ${exercise.reps ?? 10} reps`;

          return (
            <Pressable
              key={exercise.id}
              accessibilityRole="button"
              accessibilityLabel={`Toggle Exercise ${exercise.name}`}
              accessibilityState={{ disabled: isUpdatingTask }}
              disabled={isUpdatingTask}
              style={[
                styles.exerciseRow,
                exercise.completed ? styles.exerciseRowCompleted : null,
                isUpdatingTask ? styles.buttonDisabled : null
              ]}
              onPress={() => {
                void handleToggleExercise(exercise.id);
              }}
            >
              <View
                style={[
                  styles.checkbox,
                  exercise.completed ? styles.checkboxChecked : null
                ]}
              >
                <Text style={styles.checkboxMark}>
                  {exercise.completed ? "✓" : ""}
                </Text>
              </View>

              <View style={styles.exerciseInfoCol}>
                <Text
                  style={[
                    styles.exerciseName,
                    exercise.completed ? styles.exerciseNameCompleted : null
                  ]}
                >
                  {exercise.name}
                </Text>
                <Text style={styles.exerciseMeta}>
                  {exercise.category} • {detailText}
                  {exercise.scaledForFatigue
                    ? ` • -${fatigueReductionPct}% Fatigue Scaled`
                    : ""}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

          {/* ===================================================================== */}
          {/* TRACK 3: ON-DEVICE STEP COUNTER / MANUAL FALLBACK CARD                */}
          {/* ===================================================================== */}
          <View style={styles.trackCard}>
            <View style={styles.trackHeaderRow}>
              <View>
                <Text style={styles.trackTag}>TRACK 3 • ON-DEVICE TELEMETRY</Text>
                <Text style={styles.trackTitle}>👟 Daily Step Counter</Text>
              </View>
              {renderStepStatusBadge()}
            </View>

            <View style={styles.stepSummaryRow}>
              <Text style={styles.stepCountText}>
                {todaySteps.toLocaleString()} / {dailyStepGoal.toLocaleString()} steps
              </Text>
              <Text style={styles.stepPctText}>{stepGoalProgressPct}%</Text>
            </View>

            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  { width: `${stepGoalProgressPct}%` }
                ]}
              />
            </View>

            {renderStepEligibilityNotice()}

            {!pedometerAvailable || stepSource === "manual-fallback" ? (
              <View>
                <View style={styles.manualProgressBadge}>
                  <Text style={styles.manualProgressBadgeText}>
                    Manual entry tracked for personal progress (hardware pedometer required for step-only proof unlock)
                  </Text>
                </View>
                <View style={styles.manualStepRow}>
                  <TextInput
                    accessibilityLabel="Manual step count input"
                    style={styles.manualStepInput}
                    value={manualStepsInput}
                    onChangeText={setManualStepsInput}
                    keyboardType="numeric"
                    placeholder="Enter today's steps"
                    placeholderTextColor="#64748B"
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Apply Manual Steps"
                    style={styles.applyStepsBtn}
                    onPress={() => {
                      void handleApplyManualSteps();
                    }}
                  >
                    <Text style={styles.applyStepsBtnText}>Apply Steps</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {stepInputError ? (
              <Text style={styles.stepErrorText}>{stepInputError}</Text>
            ) : null}
          </View>
        </>
      )}

      {/* ===================================================================== */}
      {/* CRYPTOGRAPHIC PROOF GATE BUTTON                                       */}
      {/* ===================================================================== */}
      <View style={styles.proofGateCard}>
        <Text style={styles.proofGateTitle}>
          🔐 EIP-712 Cryptographic Proof Gate
        </Text>
        <Text style={styles.proofGateDesc}>
          Hashes today&apos;s nutrition & workout completion summary via Keccak-256 and
          signs an offline EIP-712 claim for Arbitrum Sepolia ($DHT).
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: isSubmitting || !canSignProof || isProofLocked }}
          style={[
            styles.signProofPrimaryBtn,
            isSubmitting || !canSignProof || isProofLocked ? styles.buttonDisabled : null
          ]}
          disabled={isSubmitting || !canSignProof || isProofLocked}
          onPress={() => {
            void handleSignAndDispatchProof();
          }}
        >
          <Text style={styles.signProofPrimaryBtnText}>
            {isProofLocked
              ? "Daily Proof Signed & Claimed ✓"
              : isSubmitting
                ? "Hashing & Signing EIP-712 Proof..."
                : !canSignProof
                  ? "Log a meal or finish 1 exercise to unlock"
                  : "Complete & Sign Daily Proof (+10 $DHT)"}
          </Text>
        </Pressable>

        <Text style={styles.statusText}>{statusStep}</Text>
      </View>

      {/* Quick 1-Tap Habit Rituals (Backward-compatible express check-in) */}
      <View style={styles.expressSection}>
        <Text style={styles.expressSectionTitle}>
          ⚡ Express 1-Tap Micro Habits
        </Text>
        {HABIT_CARDS.map((card) => {
          const isBusy = isSubmitting && activeCardId === card.id;
          return (
            <Pressable
              key={card.id}
              accessibilityRole="button"
              accessibilityState={{ disabled: isSubmitting || !canSignProof || isProofLocked }}
              style={[
                styles.expressCard,
                isSubmitting || !canSignProof || isProofLocked ? styles.buttonDisabled : null
              ]}
              disabled={isSubmitting || !canSignProof || isProofLocked}
              onPress={() => {
                void handleSignAndDispatchProof(card);
              }}
            >
              <Text style={styles.expressIcon}>{card.icon}</Text>
              <View style={styles.expressTextCol}>
                <Text style={styles.expressTitle}>{card.title}</Text>
                <Text style={styles.expressSub}>{card.durationText}</Text>
              </View>
              <Text style={[styles.expressCta, { color: isProofLocked ? "#94A3B8" : card.accentColor }]}>
                {isProofLocked ? "Claimed ✓" : isBusy ? "Signing..." : "1-Tap Sign →"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Proof Payload Inspector Modal */}
      <Modal
        visible={isPayloadModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setIsPayloadModalOpen(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Signed EIP-712 WorkoutProof</Text>
            {lastSignedPayload ? (
              <View style={styles.modalCodeBox}>
                <Text style={styles.modalCodeLine}>
                  User: {lastSignedPayload.proof.user}
                </Text>
                <Text style={styles.modalCodeLine}>
                  TelemetryHash: {lastSignedPayload.proof.telemetryHash}
                </Text>
                <Text style={styles.modalCodeLine}>
                  StreakCount: {String(lastSignedPayload.proof.streakCount)}
                </Text>
                <Text style={styles.modalCodeLine}>
                  Nonce: {String(lastSignedPayload.proof.nonce)}
                </Text>
                <Text style={styles.modalCodeLine}>
                  Deadline: {String(lastSignedPayload.proof.deadline)}
                </Text>
                <Text style={styles.modalCodeLine}>
                  Signature: {lastSignedPayload.signature}
                </Text>
              </View>
            ) : null}
            <Pressable
              style={styles.modalCloseBtn}
              onPress={() => {
                setIsPayloadModalOpen(false);
              }}
            >
              <Text style={styles.modalCloseBtnText}>Close Inspector</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F17"
  },
  scrollContent: {
    padding: 18,
    paddingBottom: 36
  },
  heroHeader: {
    marginBottom: 16
  },
  heroBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8
  },
  dayBadge: {
    fontSize: 11,
    fontWeight: "800",
    color: "#38BDF8",
    backgroundColor: "#0F172A",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  fatiguePill: {
    fontSize: 11,
    fontWeight: "700",
    color: "#FBBF24",
    backgroundColor: "#422006",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999
  },
  sovereigntyPill: {
    fontSize: 11,
    fontWeight: "600",
    color: "#10B981",
    backgroundColor: "#052E16",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999
  },
  heading: {
    fontSize: 22,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 4
  },
  subtitle: {
    fontSize: 13,
    color: "#94A3B8",
    lineHeight: 19
  },
  celebrationCard: {
    backgroundColor: "#052E16",
    borderWidth: 1,
    borderColor: "#10B981",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16
  },
  celebrationTopRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12
  },
  ringClosedCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#064E3B",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12
  },
  ringClosedIcon: {
    fontSize: 22
  },
  celebrationTextCol: {
    flex: 1
  },
  celebrationTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#ECFDF5"
  },
  celebrationSubtitle: {
    fontSize: 12,
    color: "#A7F3D0",
    marginTop: 2
  },
  proofSummaryBox: {
    backgroundColor: "#022C22",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12
  },
  proofSummaryLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#6EE7B7",
    marginBottom: 2
  },
  proofHashMono: {
    fontSize: 12,
    fontFamily: "monospace",
    color: "#D1FAE5"
  },
  celebrationActionsRow: {
    flexDirection: "row",
    gap: 8
  },
  l2MintButton: {
    flex: 1,
    backgroundColor: "#10B981",
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center"
  },
  l2MintButtonText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#052E16"
  },
  inspectProofButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#34D399",
    alignItems: "center"
  },
  inspectProofButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#A7F3D0"
  },
  l2ReceiptBox: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#065F46"
  },
  l2ReceiptTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#34D399"
  },
  l2ReceiptMeta: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#A7F3D0",
    marginTop: 2
  },
  l2ExplorerLink: {
    fontSize: 11,
    fontWeight: "700",
    color: "#38BDF8",
    textDecorationLine: "underline"
  },
  trackCard: {
    backgroundColor: "#161F30",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  trackHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12
  },
  trackTag: {
    fontSize: 10,
    fontWeight: "800",
    color: "#38BDF8",
    letterSpacing: 0.6,
    marginBottom: 2
  },
  trackTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  kcalBadge: {
    backgroundColor: "#0F172A",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155"
  },
  kcalBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8"
  },
  progressBarBg: {
    height: 10,
    backgroundColor: "#0F172A",
    borderRadius: 999,
    overflow: "hidden",
    marginBottom: 12
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#10B981",
    borderRadius: 999
  },
  macroSummaryRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 14
  },
  macroPill: {
    flex: 1,
    backgroundColor: "#0F172A",
    borderRadius: 10,
    padding: 8,
    alignItems: "center"
  },
  macroPillLabel: {
    fontSize: 10,
    color: "#94A3B8",
    marginBottom: 2
  },
  macroPillValue: {
    fontSize: 12,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  sectionSubLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#CBD5E1",
    marginBottom: 8
  },
  presetChipGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 12
  },
  presetChip: {
    backgroundColor: "#0F172A",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155"
  },
  presetChipActive: {
    backgroundColor: "#1E3A8A",
    borderColor: "#38BDF8"
  },
  presetChipText: {
    fontSize: 12,
    color: "#94A3B8",
    fontWeight: "600"
  },
  presetChipTextActive: {
    color: "#F8FAFC",
    fontWeight: "700"
  },
  gramControlRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 12
  },
  gramQuickRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    flex: 1
  },
  gramQuickBtn: {
    backgroundColor: "#0F172A",
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334155"
  },
  gramQuickBtnActive: {
    backgroundColor: "#065F46",
    borderColor: "#10B981"
  },
  gramQuickBtnText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#94A3B8"
  },
  gramQuickBtnTextActive: {
    color: "#ECFDF5",
    fontWeight: "700"
  },
  gramInput: {
    width: 72,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#38BDF8",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center"
  },
  portionPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#0F172A",
    borderRadius: 12,
    padding: 12
  },
  portionPreviewTextCol: {
    flex: 1,
    marginRight: 8
  },
  portionPreviewTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  portionPreviewMacros: {
    fontSize: 11,
    color: "#38BDF8",
    marginTop: 2
  },
  logFoodBtn: {
    backgroundColor: "#38BDF8",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10
  },
  logFoodBtnText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#082F49"
  },
  loggedMealsList: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#1E293B"
  },
  loggedMealsHeader: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94A3B8",
    marginBottom: 6
  },
  loggedMealRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3
  },
  loggedMealName: {
    fontSize: 12,
    color: "#E2E8F0"
  },
  loggedMealMacros: {
    fontSize: 12,
    fontWeight: "600",
    color: "#10B981"
  },
  workoutProgressBadge: {
    backgroundColor: "#0F172A",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155"
  },
  workoutProgressBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#10B981"
  },
  exerciseRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0F172A",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  exerciseRowCompleted: {
    borderColor: "#10B981",
    backgroundColor: "#052E16"
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#475569",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12
  },
  checkboxChecked: {
    backgroundColor: "#10B981",
    borderColor: "#10B981"
  },
  checkboxMark: {
    fontSize: 14,
    fontWeight: "800",
    color: "#052E16"
  },
  exerciseInfoCol: {
    flex: 1
  },
  exerciseName: {
    fontSize: 14,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  exerciseNameCompleted: {
    color: "#A7F3D0"
  },
  exerciseMeta: {
    fontSize: 12,
    color: "#94A3B8",
    marginTop: 2
  },
  proofGateCard: {
    backgroundColor: "#161F30",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#10B981"
  },
  proofGateTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 4
  },
  proofGateDesc: {
    fontSize: 12,
    color: "#94A3B8",
    marginBottom: 12,
    lineHeight: 18
  },
  signProofPrimaryBtn: {
    backgroundColor: "#10B981",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center"
  },
  signProofPrimaryBtnText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#052E16"
  },
  buttonDisabled: {
    opacity: 0.5
  },
  statusText: {
    marginTop: 10,
    fontSize: 12,
    color: "#E2E8F0",
    textAlign: "center"
  },
  expressSection: {
    marginTop: 4
  },
  expressSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#94A3B8",
    marginBottom: 8
  },
  expressCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#161F30",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8
  },
  expressIcon: {
    fontSize: 22,
    marginRight: 10
  },
  expressTextCol: {
    flex: 1
  },
  expressTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  expressSub: {
    fontSize: 11,
    color: "#94A3B8"
  },
  expressCta: {
    fontSize: 12,
    fontWeight: "700"
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.85)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#161F30",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#334155"
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 12
  },
  modalCodeBox: {
    backgroundColor: "#0B0F17",
    borderRadius: 10,
    padding: 12,
    marginBottom: 14
  },
  modalCodeLine: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#38BDF8",
    marginBottom: 4
  },
  modalCloseBtn: {
    backgroundColor: "#334155",
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center"
  },
  modalCloseBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  manualStepBadge: {
    backgroundColor: "#422006",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#F59E0B"
  },
  manualStepBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#FBBF24"
  },
  stepSummaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8
  },
  stepCountText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  stepPctText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8"
  },
  stepGoalMetText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#34D399",
    marginBottom: 8
  },
  stepGoalPersonalText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8",
    marginBottom: 8
  },
  manualProgressBadge: {
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 8
  },
  manualProgressBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#CBD5E1",
    lineHeight: 16
  },
  stepSovereigntyHint: {
    fontSize: 11,
    color: "#94A3B8",
    marginBottom: 8
  },
  manualStepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4
  },
  manualStepInput: {
    flex: 1,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "700"
  },
  applyStepsBtn: {
    backgroundColor: "#38BDF8",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10
  },
  applyStepsBtnText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#082F49"
  },
  stepErrorText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#F87171",
    marginTop: 6
  },
  modeToggleRow: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#0F172A",
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: "#1E293B",
    marginBottom: 12
  },
  modeToggleTab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center"
  },
  modeToggleTabActive: {
    backgroundColor: "#1E3A8A",
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  modeToggleTabText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#94A3B8"
  },
  modeToggleTabTextActive: {
    color: "#F8FAFC"
  },
  ephemeralNoticeBanner: {
    backgroundColor: "#0F172A",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1E293B",
    marginBottom: 16
  },
  ephemeralNoticeCounts: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8",
    marginBottom: 4
  },
  ephemeralNoticeBody: {
    fontSize: 11,
    color: "#94A3B8",
    lineHeight: 16
  },
  quickActionCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#161F30",
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  quickActionCardCompleted: {
    borderColor: "#10B981",
    backgroundColor: "#052E16"
  },
  quickActionTextCol: {
    flex: 1,
    marginRight: 12
  },
  quickCardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 2
  },
  quickCardSub: {
    fontSize: 12,
    color: "#94A3B8"
  },
  quickActionCta: {
    fontSize: 12,
    fontWeight: "800",
    color: "#38BDF8"
  }
});
