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
  getActivePlanCycle,
  getDailyTelemetryCommitment,
  makeDailyProofSignedKey,
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

export const DUAL_TRACK_FOOD_PRESETS: readonly FoodPresetItem[] = Object.freeze([
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
  })
]);

export interface LoggedMealRecord {
  readonly id: string;
  readonly presetId: string;
  readonly name: string;
  readonly grams: number;
  readonly caloriesKcal: number;
  readonly proteinGrams: number;
  readonly carbsGrams: number;
  readonly fatGrams: number;
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

export interface MicroCheckInScreenProps {
  readonly userAddress: Address;
  readonly verifyingContract: Address;
  readonly currentStreak: number;
  readonly currentNonce: bigint;
  readonly signer: Signer;
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
  readonly onUpdateDailyPlan?: (updatedPlan: DailyPlan) => void;
  readonly onDispatchSignedClaim: (payload: SignedWorkoutClaimPayload) => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly lastTxHash?: string | null;
  readonly lastExplorerUrl?: string | null;
  readonly lastClaimMode?: L2ServiceMode | null;
}

const GRAM_QUICK_OPTIONS: readonly number[] = [50, 100, 150, 200, 250];

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
  onUpdateDailyPlan,
  onDispatchSignedClaim,
  onError,
  lastTxHash,
  lastExplorerUrl,
  lastClaimMode = null
}) => {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const fatigueOptions = useMemo(
    () => ({
      inactivityThresholdHours,
      fatigueScalingMultiplier
    }),
    [inactivityThresholdHours, fatigueScalingMultiplier]
  );

  const defaultInitialPlan = useMemo<DailyPlan>(() => {
    const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, Date.now());
    return cycle.dailyPlans[0]!;
  }, []);

  const [localPlan, setLocalPlan] = useState<DailyPlan>(() =>
    applyRuntimeFatigueScaling(
      externalDailyPlan ?? defaultInitialPlan,
      lastLogTimestampMs,
      Date.now(),
      fatigueOptions
    )
  );

  useEffect(() => {
    if (externalDailyPlan) {
      const resolved = applyRuntimeFatigueScaling(
        externalDailyPlan,
        lastLogTimestampMs,
        Date.now(),
        fatigueOptions
      );
      setLocalPlan(resolved);
      if (resolved !== externalDailyPlan && onUpdateDailyPlan) {
        onUpdateDailyPlan(resolved);
      }
    }
  }, [externalDailyPlan, lastLogTimestampMs, fatigueOptions]);

  const [pedometerAvailable, setPedometerAvailable] = useState<boolean>(
    initialPedometerAvailable ?? initialStepSource === "hardware"
  );
  const [todaySteps, setTodaySteps] = useState<number>(() =>
    typeof initialStepCount === "number" &&
    Number.isFinite(initialStepCount) &&
    initialStepCount >= 0
      ? Math.round(initialStepCount)
      : 0
  );
  const [stepSource, setStepSource] = useState<StepCountSource>(
    initialStepSource ??
      (initialPedometerAvailable ? "hardware" : "manual-fallback")
  );
  const [manualStepsInput, setManualStepsInput] = useState<string>(() =>
    String(
      typeof initialStepCount === "number" &&
        Number.isFinite(initialStepCount) &&
        initialStepCount >= 0
        ? Math.round(initialStepCount)
        : 0
    )
  );
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
        setTodaySteps(reading.steps);
        setStepSource(reading.source);
        setManualStepsInput(String(reading.steps));
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

  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    DUAL_TRACK_FOOD_PRESETS[0]!.id
  );
  const [portionGramsInput, setPortionGramsInput] = useState<string>("150");
  const [loggedMeals, setLoggedMeals] = useState<readonly LoggedMealRecord[]>([]);

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

  const selectedPreset = useMemo<FoodPresetItem>(() => {
    return (
      DUAL_TRACK_FOOD_PRESETS.find((item) => item.id === selectedPresetId) ??
      DUAL_TRACK_FOOD_PRESETS[0]!
    );
  }, [selectedPresetId]);

  const parsedGrams = useMemo<number>(() => {
    const val = Number(portionGramsInput.trim());
    return Number.isFinite(val) && val > 0 ? val : 0;
  }, [portionGramsInput]);

  const scaledPreview = useMemo<FoodPresetItem>(() => {
    return scaleFoodPresetPortion(selectedPreset, parsedGrams);
  }, [selectedPreset, parsedGrams]);

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

  const handleLogFoodPortion = async (): Promise<void> => {
    if (isUpdatingTaskRef.current || isUpdatingTask) {
      return;
    }
    if (parsedGrams <= 0) {
      setStatusStep("Please enter a valid portion weight in grams (> 0g).");
      return;
    }

    isUpdatingTaskRef.current = true;
    setIsUpdatingTask(true);
    try {
      const updatedPlan = addFoodPortionToDailyPlan(
        localPlan,
        selectedPreset,
        parsedGrams
      );
      applyPlanUpdate(updatedPlan);

      const newMeal: LoggedMealRecord = {
        id: `meal_${Date.now()}_${loggedMeals.length + 1}`,
        presetId: selectedPreset.id,
        name: selectedPreset.name,
        grams: parsedGrams,
        caloriesKcal: scaledPreview.caloriesKcal,
        proteinGrams: scaledPreview.proteinGrams,
        carbsGrams: scaledPreview.carbsGrams,
        fatGrams: scaledPreview.fatGrams
      };
      setLoggedMeals((prev) => [newMeal, ...prev]);
      setStatusStep(
        `Logged ${parsedGrams}g ${selectedPreset.name} (+${Math.round(scaledPreview.caloriesKcal)} kcal, +${scaledPreview.proteinGrams}g P)`
      );

      try {
        await saveDailyTaskCompletion(localPlan.dayNumber, "nutrition_logged", true);
      } catch {
        // Non-fatal in preview environments
      }
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
        setStatusStep(
          toggled.completed
            ? `Checked off ${toggled.name} (${workoutStats.completedCount + 1}/${workoutStats.totalCount})`
            : `Unchecked ${toggled.name}`
        );
        try {
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

  const handleApplyManualSteps = (): void => {
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
    setStatusStep(
      parsed >= dailyStepGoal
        ? `Manual step goal reached (${parsed} / ${dailyStepGoal} steps) — tracked for personal progress (log a meal or exercise to unlock Daily Proof).`
        : `Updated local step count: ${parsed} / ${dailyStepGoal} steps (on-device only).`
    );
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

      const signedPayload = await signWorkoutProof(signer, proof, verifyingContract);

      setStatusStep("3/3 Dispatching verified proof to DeHealthRewardGate...");
      await onDispatchSignedClaim(signedPayload);

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
                style={[
                  styles.presetChip,
                  isSelected ? styles.presetChipActive : null
                ]}
                onPress={() => {
                  setSelectedPresetId(preset.id);
                }}
              >
                <Text
                  style={[
                    styles.presetChipText,
                    isSelected ? styles.presetChipTextActive : null
                  ]}
                >
                  {preset.name}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Portion Gram Quick Buttons & Custom Input */}
        <Text style={styles.sectionSubLabel}>Portion Weight (Grams):</Text>
        <View style={styles.gramControlRow}>
          <View style={styles.gramQuickRow}>
            {GRAM_QUICK_OPTIONS.map((g) => {
              const isSelected = parsedGrams === g;
              return (
                <Pressable
                  key={g}
                  style={[
                    styles.gramQuickBtn,
                    isSelected ? styles.gramQuickBtnActive : null
                  ]}
                  onPress={() => {
                    setPortionGramsInput(String(g));
                  }}
                >
                  <Text
                    style={[
                      styles.gramQuickBtnText,
                      isSelected ? styles.gramQuickBtnTextActive : null
                    ]}
                  >
                    {g}g
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <TextInput
            style={styles.gramInput}
            value={portionGramsInput}
            onChangeText={setPortionGramsInput}
            keyboardType="numeric"
            placeholder="Grams"
            placeholderTextColor="#64748B"
            accessibilityLabel="Portion grams input"
          />
        </View>

        {/* Live Portion Math Preview & Log Action */}
        <View style={styles.portionPreviewRow}>
          <View style={styles.portionPreviewTextCol}>
            <Text style={styles.portionPreviewTitle}>
              {parsedGrams}g {selectedPreset.name}
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
                  {meal.name} ({meal.grams}g)
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

        {todaySteps >= dailyStepGoal ? (
          stepSource === "hardware" ? (
            <Text style={styles.stepGoalMetText}>
              ✓ Daily step goal reached ({dailyStepGoal.toLocaleString()}+ steps) — Daily Proof eligible
            </Text>
          ) : (
            <Text style={styles.stepGoalPersonalText}>
              ✓ Personal step goal reached ({dailyStepGoal.toLocaleString()}+ steps) — tracked on-device
            </Text>
          )
        ) : (
          <Text style={styles.stepSovereigntyHint}>
            Raw step counts stay strictly on-device and never leave to Supabase or L2.
          </Text>
        )}

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
                onPress={handleApplyManualSteps}
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
  }
});
