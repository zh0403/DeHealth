import {
  UserBiometrics,
  FitnessGoal,
  AdaptivePlanCycle,
  DailyPlan,
  MacroSplit,
  WeightLogEntry,
  WorkoutExerciseItem,
  ProposedPlanReview,
  FoodPresetItem,
  UserBiometricsSchema,
  DailyPlanSchema,
  AdaptivePlanCycleSchema,
  ProposedPlanReviewSchema,
  MacroSplitSchema,
  WorkoutExerciseItemSchema
} from "@dehealth/shared";

import {
  FATIGUE_GAP_THRESHOLD_MS,
  FATIGUE_SCALING_MULTIPLIER,
  FatigueScalingOptions
} from "./profileEngine";
import { makeDailyProofSignedKey } from "../storage/adaptiveStorage";

export { FATIGUE_GAP_THRESHOLD_MS, FATIGUE_SCALING_MULTIPLIER, FatigueScalingOptions };

export const SAFE_CALORIE_FLOOR_KCAL = 1200;

export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  heavy: 1.725,
  very_active: 1.9
} as const;

export const GOAL_CALORIE_OFFSETS: Record<FitnessGoal, number> = {
  cut: -500,
  fat_loss: -500,
  maintain: 0,
  maintenance: 0,
  bulk: 350,
  muscle_gain: 350
};

export const MACRO_RATIOS: Record<
  FitnessGoal,
  { readonly protein: number; readonly carbs: number; readonly fat: number }
> = {
  cut: { protein: 0.35, carbs: 0.35, fat: 0.3 },
  fat_loss: { protein: 0.35, carbs: 0.35, fat: 0.3 },
  maintain: { protein: 0.3, carbs: 0.45, fat: 0.25 },
  maintenance: { protein: 0.3, carbs: 0.45, fat: 0.25 },
  bulk: { protein: 0.3, carbs: 0.5, fat: 0.2 },
  muscle_gain: { protein: 0.3, carbs: 0.5, fat: 0.2 }
};

export const DEFAULT_WORKOUT_TEMPLATES = [
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
] as const;

/**
 * Calculates Basal Metabolic Rate (BMR):
 * - Katch-McArdle formula when bodyFatPct is provided and > 0:
 *   LBM = weightKg * (1 - bodyFatPct / 100)
 *   BMR = 370 + 21.6 * LBM
 * - Fallback to Mifflin-St Jeor formula:
 *   Base = 10 * weightKg + 6.25 * heightCm - 5 * age
 *   s = +5 (male), -161 (female), -78 (other / non-binary midpoint)
 *   BMR = Base + s
 */
export function calculateBmr(biometrics: UserBiometrics): number {
  if (typeof biometrics.bodyFatPct === "number" && biometrics.bodyFatPct > 0) {
    const lbm = biometrics.weightKg * (1 - biometrics.bodyFatPct / 100);
    return Math.round(370 + 21.6 * lbm);
  }

  const base = 10 * biometrics.weightKg + 6.25 * biometrics.heightCm - 5 * biometrics.age;
  const s = biometrics.gender === "male" ? 5 : biometrics.gender === "female" ? -161 : -78;
  return Math.round(base + s);
}

/**
 * Calculates Total Daily Energy Expenditure (TDEE) from BMR and weekly frequency or activity level.
 */
export function calculateTdee(
  bmr: number,
  weeklyFrequency: number,
  activityLevel?: string
): number {
  let multiplier: number;
  if (activityLevel && activityLevel in ACTIVITY_MULTIPLIERS) {
    multiplier = ACTIVITY_MULTIPLIERS[activityLevel as keyof typeof ACTIVITY_MULTIPLIERS];
  } else {
    multiplier =
      weeklyFrequency <= 2
        ? 1.2
        : weeklyFrequency <= 4
          ? 1.55
          : weeklyFrequency <= 6
            ? 1.725
            : 1.9;
  }
  return Math.round(bmr * multiplier);
}

/**
 * Calculates daily target calories clamped to a safe lower floor (>= 1200 kcal/day).
 */
export function calculateTargetCalories(tdee: number, goal: FitnessGoal): number {
  const offset = GOAL_CALORIE_OFFSETS[goal] ?? 0;
  return Math.max(SAFE_CALORIE_FLOOR_KCAL, Math.round(tdee + offset));
}

/**
 * Allocates macronutrient split (protein, carbs, fat) from target calories and goal.
 */
export function calculateMacroSplit(targetCalories: number, goal: FitnessGoal): MacroSplit {
  const safeCalories = Math.max(SAFE_CALORIE_FLOOR_KCAL, targetCalories);
  const ratio = MACRO_RATIOS[goal] ?? MACRO_RATIOS.maintain;

  const proteinGrams = Math.round((safeCalories * ratio.protein) / 4);
  const carbsGrams = Math.round((safeCalories * ratio.carbs) / 4);
  const fatGrams = Math.round((safeCalories * ratio.fat) / 9);

  return MacroSplitSchema.parse({
    proteinGrams,
    carbsGrams,
    fatGrams
  });
}

function resolvePlanFatigueParams(options?: FatigueScalingOptions): {
  readonly thresholdMs: number;
  readonly multiplier: number;
} {
  const hours = options?.inactivityThresholdHours;
  const thresholdMs =
    typeof hours === "number" && Number.isFinite(hours) && hours > 0
      ? hours * 60 * 60 * 1000
      : FATIGUE_GAP_THRESHOLD_MS;

  const rawMult = options?.fatigueScalingMultiplier;
  const multiplier =
    typeof rawMult === "number" &&
    Number.isFinite(rawMult) &&
    rawMult > 0 &&
    rawMult <= 1
      ? rawMult
      : FATIGUE_SCALING_MULTIPLIER;

  return { thresholdMs, multiplier };
}

/**
 * Scales exercises down for fatigue (default 30% reduction in sets/duration).
 * Supports both:
 * 1. `scaleExercisesForFatigue(exercises, isFatigued, options?)` -> returns WorkoutExerciseItem[]
 * 2. `scaleExercisesForFatigue(exercises, lastLogTimestampMs, currentTimestampMs?, options?)` -> returns { exercises, isFatigueScaled }
 */
export function scaleExercisesForFatigue(
  exercises: readonly WorkoutExerciseItem[],
  isFatigued: boolean,
  options?: FatigueScalingOptions
): WorkoutExerciseItem[];
export function scaleExercisesForFatigue(
  exercises: readonly WorkoutExerciseItem[],
  lastLogTimestampMs: number | null,
  currentTimestampMs?: number,
  options?: FatigueScalingOptions
): { exercises: WorkoutExerciseItem[]; isFatigueScaled: boolean };
export function scaleExercisesForFatigue(
  exercises: readonly WorkoutExerciseItem[],
  arg2: boolean | number | null,
  arg3?: number | FatigueScalingOptions,
  arg4?: FatigueScalingOptions
): WorkoutExerciseItem[] | { exercises: WorkoutExerciseItem[]; isFatigueScaled: boolean } {
  if (typeof arg2 === "boolean") {
    const isFatigued = arg2;
    const opts = typeof arg3 === "object" && arg3 !== null ? arg3 : undefined;
    const { multiplier } = resolvePlanFatigueParams(opts);
    return exercises.map((ex) => {
      if (!isFatigued) {
        return { ...ex, scaledForFatigue: false };
      }
      return {
        ...ex,
        sets: Math.max(1, Math.round(ex.sets * multiplier)),
        durationMinutes:
          ex.durationMinutes !== undefined
            ? Math.max(1, Math.round(ex.durationMinutes * multiplier))
            : undefined,
        scaledForFatigue: true
      };
    });
  }

  const lastLogTimestampMs = arg2;
  const currentTimestampMs = typeof arg3 === "number" ? arg3 : Date.now();
  const opts = typeof arg3 === "object" && arg3 !== null ? arg3 : arg4;
  const { thresholdMs, multiplier } = resolvePlanFatigueParams(opts);
  const isFatigued =
    lastLogTimestampMs !== null &&
    currentTimestampMs - lastLogTimestampMs > thresholdMs;

  const scaled = exercises.map((ex) => {
    if (!isFatigued) {
      return { ...ex, scaledForFatigue: false };
    }
    return {
      ...ex,
      sets: Math.max(1, Math.round(ex.sets * multiplier)),
      durationMinutes:
        ex.durationMinutes !== undefined
          ? Math.max(1, Math.round(ex.durationMinutes * multiplier))
          : undefined,
      scaledForFatigue: true
    };
  });

  return { exercises: scaled, isFatigueScaled: isFatigued };
}

/**
 * Applies the configured inactivity fatigue rule (default 48h / 0.70x) to an
 * already-generated, in-progress DailyPlan at runtime, so a mid-cycle inactivity
 * gap takes effect immediately without regenerating the 14-day cycle.
 *
 * - Idempotent: exercises already flagged `scaledForFatigue` are never scaled twice.
 * - Completed exercises and already-completed plans are left untouched.
 * - Never un-scales; a plan scaled earlier stays scaled for the day.
 * - Returns the same plan reference when nothing changes.
 */
export function applyRuntimeFatigueScaling(
  plan: DailyPlan,
  lastLogTimestampMs: number | null,
  currentTimestampMs: number,
  options?: FatigueScalingOptions
): DailyPlan {
  const { thresholdMs, multiplier } = resolvePlanFatigueParams(options);
  const isFatigued =
    lastLogTimestampMs !== null &&
    currentTimestampMs - lastLogTimestampMs > thresholdMs;

  if (!isFatigued || plan.completed) {
    return plan;
  }

  let changed = false;
  const exercises = plan.exercises.map((ex) => {
    if (ex.completed || ex.scaledForFatigue === true) {
      return ex;
    }
    changed = true;
    return {
      ...ex,
      sets: Math.max(1, Math.round(ex.sets * multiplier)),
      durationMinutes:
        ex.durationMinutes !== undefined
          ? Math.max(1, Math.round(ex.durationMinutes * multiplier))
          : undefined,
      scaledForFatigue: true
    };
  });

  if (!changed && plan.isFatigueScaled) {
    return plan;
  }

  return { ...plan, exercises, isFatigueScaled: true };
}

/**
 * Creates default workout items for a given day in the 14-day schedule.
 */
export function createDefaultExercises(
  dayNumber: number,
  isFatigued: boolean
): WorkoutExerciseItem[] {
  const templateIndex = (dayNumber - 1) % DEFAULT_WORKOUT_TEMPLATES.length;
  const template = DEFAULT_WORKOUT_TEMPLATES[templateIndex]!;

  return template.map((item, idx) => {
    const sets = isFatigued
      ? Math.max(1, Math.round(item.sets * FATIGUE_SCALING_MULTIPLIER))
      : item.sets;
    const durationMinutes =
      "durationMinutes" in item && item.durationMinutes !== undefined
        ? isFatigued
          ? Math.max(1, Math.round(item.durationMinutes * FATIGUE_SCALING_MULTIPLIER))
          : item.durationMinutes
        : undefined;

    return WorkoutExerciseItemSchema.parse({
      id: `ex_${dayNumber}_${idx + 1}`,
      name: item.name,
      category: item.category,
      sets,
      reps: "reps" in item ? item.reps : undefined,
      durationMinutes,
      completed: false,
      scaledForFatigue: isFatigued
    });
  });
}

/**
 * Generates a full 14-day adaptive plan cycle with physiology targets and daily workout templates.
 * If inactivity gap exceeds 48 hours, Day 1 exercises are scaled down by 30% for fatigue.
 */
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

export const MS_PER_DAY = 86_400_000;
export const CYCLE_LENGTH_DAYS = 14;

/**
 * Index (0..13) of the active day within a 14-day cycle, derived from wall-clock
 * time. Clamped, so a stale cycle stays on its final day until it is reviewed and
 * a new cycle begins, and a start date in the future maps to day 0.
 */
export function getActiveDayIndex(startDateMs: number, nowMs: number): number {
  const elapsedDays = Math.floor((nowMs - startDateMs) / MS_PER_DAY);
  return Math.min(CYCLE_LENGTH_DAYS - 1, Math.max(0, elapsedDays));
}

/**
 * Real adherence for the cycle: completed days divided by elapsed days
 * (inclusive of today), as a percentage rounded to one decimal.
 * Never returns a fabricated figure; an unfinished today counts against it
 * until the day's proof is signed.
 */
export function calculateAdherencePct(cycle: AdaptivePlanCycle, nowMs: number): number {
  const elapsedDays = getActiveDayIndex(cycle.startDateMs, nowMs) + 1;
  const completedDays = cycle.dailyPlans
    .slice(0, elapsedDays)
    .filter((plan) => plan.completed).length;
  return Number(((completedDays / elapsedDays) * 100).toFixed(1));
}

/**
 * Returns `history` with `cycle` appended. Idempotent: a cycle whose id is
 * already archived replaces the earlier entry instead of duplicating it.
 */
export function appendCycleToHistory(
  history: readonly AdaptivePlanCycle[],
  cycle: AdaptivePlanCycle
): AdaptivePlanCycle[] {
  return [...history.filter((entry) => entry.id !== cycle.id), cycle];
}
/**
 * Calculates the rolling average of up to 7 trailing chronological weight logs.
 * Returns null if the weight log collection is empty.
 */
export function calculateRollingWeightAverage(
  weightLogs: readonly WeightLogEntry[]
): number | null {
  if (!weightLogs || weightLogs.length === 0) return null;
  const sorted = [...weightLogs].sort((a, b) => a.timestampMs - b.timestampMs);
  const recent7 = sorted.slice(-7);
  const sum = recent7.reduce((acc, entry) => acc + entry.weightKg, 0);
  return Number((sum / recent7.length).toFixed(2));
}

export type GoalTrack = "deficit" | "surplus" | "maintenance";

/**
 * Maps every FitnessGoal onto an explicit review track. The `never` check makes
 * the compiler reject any newly added FitnessGoal that lacks review handling,
 * instead of silently falling through to maintenance behavior.
 */
export function resolveGoalTrack(goal: FitnessGoal): GoalTrack {
  switch (goal) {
    case "cut":
    case "fat_loss":
      return "deficit";
    case "bulk":
    case "muscle_gain":
      return "surplus";
    case "maintain":
    case "maintenance":
      return "maintenance";
    default: {
      const unhandled: never = goal;
      throw new Error(`Unhandled FitnessGoal: ${String(unhandled)}`);
    }
  }
}

/**
 * Pure deterministic offline Bi-Weekly Review evaluation.
 * Evaluates weight logs and adherence over the 14-day cycle and generates a ProposedPlanReview.
 * Never calls external LLM APIs; enforces a strict 1200 kcal safe calorie floor.
 */
export function evaluateBiWeeklyReview(
  currentCycle: AdaptivePlanCycle,
  weightLogs: readonly WeightLogEntry[],
  adherencePct: number,
  reviewDateMs?: number
): ProposedPlanReview {
  const sortedLogs = [...weightLogs].sort((a, b) => a.timestampMs - b.timestampMs);

  const startingWeightKg =
    sortedLogs.length > 0
      ? sortedLogs[0]!.weightKg
      : currentCycle.baselineBiometrics.weightKg;

  const currentWeightKg =
    sortedLogs.length > 0
      ? sortedLogs[sortedLogs.length - 1]!.weightKg
      : currentCycle.baselineBiometrics.weightKg;

  const weightChangeKg = Number((currentWeightKg - startingWeightKg).toFixed(2));
  const rollingAverageWeightKg =
    calculateRollingWeightAverage(sortedLogs) ?? currentWeightKg;

  let nominalAdjustment = 0;
  let rationale = "";

  const goal = currentCycle.goal;
  const track = resolveGoalTrack(goal);

  if (adherencePct < 80) {
    nominalAdjustment = 0;
    rationale = `Adherence was ${adherencePct.toFixed(1)}% (below the 80% threshold). Targets held constant to establish consistency before altering energy balance.`;
  } else {
    if (track === "deficit") {
      if (weightChangeKg >= -0.2) {
        nominalAdjustment = -100;
        rationale = `Weight loss stalled over the 14-day cycle (weight change: ${weightChangeKg > 0 ? "+" : ""}${weightChangeKg.toFixed(2)} kg >= -0.2 kg) despite high adherence (${adherencePct}%). Decreasing daily target by 100 kcal to resume steady deficit.`;
      } else if (weightChangeKg >= -1.5) {
        nominalAdjustment = 0;
        rationale = `Healthy and steady fat loss progress detected (weight change: ${weightChangeKg.toFixed(2)} kg over 14 days). Caloric deficit maintained.`;
      } else {
        nominalAdjustment = 150;
        rationale = `Weight loss is too rapid (weight change: ${weightChangeKg.toFixed(2)} kg < -1.5 kg over 14 days). Increasing daily target by 150 kcal to preserve lean muscle mass.`;
      }
    } else if (track === "surplus") {
      if (weightChangeKg <= 0.2) {
        nominalAdjustment = 150;
        rationale = `Weight gain has stalled or is below target (weight change: ${weightChangeKg > 0 ? "+" : ""}${weightChangeKg.toFixed(2)} kg <= +0.2 kg) with high adherence (${adherencePct}%). Increasing daily surplus by 150 kcal to support hypertrophy.`;
      } else if (weightChangeKg <= 1.0) {
        nominalAdjustment = 0;
        rationale = `Lean muscle mass progression on track (weight change: +${weightChangeKg.toFixed(2)} kg over 14 days). Caloric surplus maintained.`;
      } else {
        nominalAdjustment = -100;
        rationale = `Weight gain is exceeding optimal rate (weight change: +${weightChangeKg.toFixed(2)} kg > +1.0 kg over 14 days). Decreasing surplus by 100 kcal to minimize excess fat accumulation.`;
      }
    } else {
      if (Math.abs(weightChangeKg) <= 0.5) {
        nominalAdjustment = 0;
        rationale = `Weight remained stable within ±0.5 kg (weight change: ${weightChangeKg > 0 ? "+" : ""}${weightChangeKg.toFixed(2)} kg). Maintenance caloric targets preserved.`;
      } else if (weightChangeKg > 0.5) {
        nominalAdjustment = -100;
        rationale = `Weight drifted upward during maintenance (weight change: +${weightChangeKg.toFixed(2)} kg > +0.5 kg). Decreasing daily target by 100 kcal.`;
      } else {
        nominalAdjustment = 100;
        rationale = `Weight drifted downward during maintenance (weight change: ${weightChangeKg.toFixed(2)} kg < -0.5 kg). Increasing daily target by 100 kcal.`;
      }
    }
  }

  const proposedDailyCalories = Math.max(
    SAFE_CALORIE_FLOOR_KCAL,
    currentCycle.targetDailyCalories + nominalAdjustment
  );

  if (
    proposedDailyCalories === SAFE_CALORIE_FLOOR_KCAL &&
    currentCycle.targetDailyCalories + nominalAdjustment < SAFE_CALORIE_FLOOR_KCAL
  ) {
    rationale += ` Proposed daily calories clamped to safe floor of ${SAFE_CALORIE_FLOOR_KCAL} kcal.`;
  }

  const actualCalorieAdjustment = proposedDailyCalories - currentCycle.targetDailyCalories;

  const currentMacroSplit: MacroSplit = {
    proteinGrams: currentCycle.targetDailyProteinGrams,
    carbsGrams: currentCycle.targetDailyCarbsGrams,
    fatGrams: currentCycle.targetDailyFatGrams
  };

  const proposedMacroSplit = calculateMacroSplit(proposedDailyCalories, goal);

  const review: ProposedPlanReview = {
    cycleId: currentCycle.id,
    reviewDateMs: reviewDateMs ?? Date.now(),
    adherencePct,
    startingWeightKg,
    currentWeightKg,
    weightChangeKg,
    rollingAverageWeightKg,
    currentDailyCalories: currentCycle.targetDailyCalories,
    proposedDailyCalories,
    calorieAdjustment: actualCalorieAdjustment,
    currentMacroSplit,
    proposedMacroSplit,
    rationale,
    status: "pending"
  };

  return ProposedPlanReviewSchema.parse(review);
}

/**
 * Linearly scales food preset portions to a given target weight in grams.
 */
export function scaleFoodPresetPortion(
  preset: FoodPresetItem,
  targetGrams: number
): FoodPresetItem {
  const safeGrams = Math.max(0, targetGrams);
  const factor = safeGrams / preset.servingSizeGrams;
  return {
    ...preset,
    servingSizeGrams: safeGrams,
    caloriesKcal: Number((preset.caloriesKcal * factor).toFixed(1)),
    proteinGrams: Number((preset.proteinGrams * factor).toFixed(1)),
    carbsGrams: Number((preset.carbsGrams * factor).toFixed(1)),
    fatGrams: Number((preset.fatGrams * factor).toFixed(1))
  };
}

export const ADAPTIVE_MAX_DEFICIT_KCAL = 500;
export const ADAPTIVE_MAX_SURPLUS_KCAL = 400;

/**
 * Computes the time-windowed rolling average weight (kg) across entries inside
 * `[refMs - windowDays * MS_PER_DAY, refMs]` (inclusive), rounded to 2 decimals.
 * Defaults `referenceTimestampMs` to the latest chronological entry when omitted.
 * Returns null if `weightLogs` is empty or no entries fall inside the window.
 */
export function computeRollingWeightAverage(
  weightLogs: readonly WeightLogEntry[],
  referenceTimestampMs?: number,
  windowDays: number = 7
): number | null {
  if (!weightLogs || weightLogs.length === 0) {
    return null;
  }
  const sorted = [...weightLogs].sort((a, b) => a.timestampMs - b.timestampMs);
  const latestEntry = sorted[sorted.length - 1];
  if (!latestEntry) {
    return null;
  }
  const refMs =
    typeof referenceTimestampMs === "number" && Number.isFinite(referenceTimestampMs)
      ? referenceTimestampMs
      : latestEntry.timestampMs;
  const safeWindowDays =
    Number.isFinite(windowDays) && windowDays >= 0 ? windowDays : 7;
  const windowStartMs = refMs - safeWindowDays * MS_PER_DAY;
  const inWindow = sorted.filter(
    (entry) => entry.timestampMs >= windowStartMs && entry.timestampMs <= refMs
  );
  if (inWindow.length === 0) {
    return null;
  }
  const sum = inWindow.reduce((acc, entry) => acc + entry.weightKg, 0);
  return Number((sum / inWindow.length).toFixed(2));
}

/**
 * Calculates baseline TDEE from user biometrics using BMR + activity frequency.
 */
export function calculateBaselineTdee(biometrics: UserBiometrics): number {
  const bmr = calculateBmr(biometrics);
  return calculateTdee(
    bmr,
    biometrics.weeklyWorkoutFrequency,
    biometrics.activityLevel
  );
}

/**
 * Clamps an adaptive daily calorie candidate strictly to realistic weekly rate bounds
 * `[-500, +400]` kcal relative to `baselineTdee` and never below `1200 kcal`.
 */
export function clampAdaptiveCalories(
  candidateCalories: number,
  baselineTdee: number
): number {
  const safeTdee = Number.isFinite(baselineTdee)
    ? baselineTdee
    : SAFE_CALORIE_FLOOR_KCAL;
  const lowerBound = Math.max(
    SAFE_CALORIE_FLOOR_KCAL,
    Math.round(safeTdee - ADAPTIVE_MAX_DEFICIT_KCAL)
  );
  const upperBound = Math.max(
    SAFE_CALORIE_FLOOR_KCAL,
    Math.round(safeTdee + ADAPTIVE_MAX_SURPLUS_KCAL)
  );
  const roundedCandidate = Number.isFinite(candidateCalories)
    ? Math.round(candidateCalories)
    : lowerBound;
  return Math.min(upperBound, Math.max(lowerBound, roundedCandidate));
}

/**
 * Pure cycle-level check determining whether at least 14 days have elapsed
 * since `cycle.startDateMs`.
 */
export function isCycleBiWeeklyReviewDue(
  cycle: AdaptivePlanCycle,
  nowMs: number
): boolean {
  return nowMs - cycle.startDateMs >= CYCLE_LENGTH_DAYS * MS_PER_DAY;
}

export interface WeighInAdaptationProjection {
  readonly baselineWeightKg: number;
  readonly baselineTdee: number;
  readonly latestWeightKg: number | null;
  readonly rollingAverageWeightKg: number | null;
  readonly rollingWeightDeltaKg: number;
  readonly windowLogCount: number;
  readonly currentDailyCalories: number;
  readonly projectedDailyCalories: number;
  readonly calorieDeltaFromCurrent: number;
  readonly projectedMacroSplit: MacroSplit;
  readonly isMidCycleHold: boolean;
  readonly summaryMessage: string;
}

/**
 * Pure, non-mutating weigh-in adaptation projection driven strictly by the 7-day
 * rolling weight delta relative to `cycle.baselineBiometrics.weightKg`, clamped
 * to `[-500, +400]` kcal of `baselineTdee` and `>= 1200 kcal`.
 * Never mutates `cycle` or active day targets/logged progress.
 */
export function evaluateWeighInAdaptation(
  cycle: AdaptivePlanCycle,
  weightLogs: readonly WeightLogEntry[],
  nowMs: number
): WeighInAdaptationProjection {
  const sortedLogs = [...weightLogs].sort((a, b) => a.timestampMs - b.timestampMs);
  const logsUpToNow = sortedLogs.filter((entry) => entry.timestampMs <= nowMs);
  const latestEntry =
    logsUpToNow.length > 0 ? logsUpToNow[logsUpToNow.length - 1] : undefined;
  const latestWeightKg = latestEntry ? latestEntry.weightKg : null;

  const windowStartMs = nowMs - 7 * MS_PER_DAY;
  const windowLogs = logsUpToNow.filter((entry) => entry.timestampMs >= windowStartMs);
  const windowLogCount = windowLogs.length;
  const rollingAverageWeightKg = computeRollingWeightAverage(logsUpToNow, nowMs, 7);

  const baselineWeightKg = cycle.baselineBiometrics.weightKg;
  const baselineTdee = calculateBaselineTdee(cycle.baselineBiometrics);
  const rollingWeightDeltaKg =
    rollingAverageWeightKg !== null
      ? Number((rollingAverageWeightKg - baselineWeightKg).toFixed(2))
      : 0;

  let nominalAdjustment = 0;
  if (
    rollingAverageWeightKg !== null &&
    !(windowLogCount === 1 && rollingWeightDeltaKg === 0)
  ) {
    const track = resolveGoalTrack(cycle.goal);
    if (track === "deficit") {
      if (rollingWeightDeltaKg >= -0.2) {
        nominalAdjustment = -100;
      } else if (rollingWeightDeltaKg >= -1.5) {
        nominalAdjustment = 0;
      } else {
        nominalAdjustment = 150;
      }
    } else if (track === "surplus") {
      if (rollingWeightDeltaKg <= 0.2) {
        nominalAdjustment = 150;
      } else if (rollingWeightDeltaKg <= 1.0) {
        nominalAdjustment = 0;
      } else {
        nominalAdjustment = -100;
      }
    } else {
      if (Math.abs(rollingWeightDeltaKg) <= 0.5) {
        nominalAdjustment = 0;
      } else if (rollingWeightDeltaKg > 0.5) {
        nominalAdjustment = -100;
      } else {
        nominalAdjustment = 100;
      }
    }
  }

  const candidateCalories = cycle.targetDailyCalories + nominalAdjustment;
  const projectedDailyCalories = clampAdaptiveCalories(candidateCalories, baselineTdee);
  const calorieDeltaFromCurrent = projectedDailyCalories - cycle.targetDailyCalories;
  const projectedMacroSplit = calculateMacroSplit(projectedDailyCalories, cycle.goal);
  const isMidCycleHold = !isCycleBiWeeklyReviewDue(cycle, nowMs);

  const deltaSign = rollingWeightDeltaKg > 0 ? "+" : "";
  const calDeltaSign = calorieDeltaFromCurrent > 0 ? "+" : "";

  let summaryMessage: string;
  if (rollingAverageWeightKg === null) {
    summaryMessage = `No weigh-ins in the 7-day rolling window. Daily targets (${cycle.targetDailyCalories} kcal/day) and active day progress remain unchanged.`;
  } else if (isMidCycleHold) {
    summaryMessage = `Mid-cycle guard active: 7-day rolling avg ${rollingAverageWeightKg.toFixed(2)} kg (${deltaSign}${rollingWeightDeltaKg.toFixed(2)} kg vs baseline). Active targets (${cycle.targetDailyCalories} kcal/day) and logged progress remain locked; next 14-day review projection: ${projectedDailyCalories} kcal/day.`;
  } else {
    summaryMessage = `14-day review ready: 7-day rolling avg ${rollingAverageWeightKg.toFixed(2)} kg (${deltaSign}${rollingWeightDeltaKg.toFixed(2)} kg vs baseline). Bounded projection: ${projectedDailyCalories} kcal/day (${calDeltaSign}${calorieDeltaFromCurrent} kcal vs current).`;
  }

  return {
    baselineWeightKg,
    baselineTdee,
    latestWeightKg,
    rollingAverageWeightKg,
    rollingWeightDeltaKg,
    windowLogCount,
    currentDailyCalories: cycle.targetDailyCalories,
    projectedDailyCalories,
    calorieDeltaFromCurrent,
    projectedMacroSplit,
    isMidCycleHold,
    summaryMessage
  };
}

export const CADENCE_WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat"
] as const;

export interface CadenceDayPill {
  readonly date: string;
  readonly dayNumber: number;
  readonly weekdayLabel: string;
  readonly isToday: boolean;
  readonly isCompleted: boolean;
}

/**
 * Builds the active 7-day cadence slice (Week 1: days 0..6 or Week 2: days 7..13)
 * with exact calendar weekday labels (`new Date(plan.date + "T00:00:00").getDay()`),
 * today highlight, and completion state from `plan.completed` or `proofSignedMap`.
 */
export function buildSevenDayCadence(
  cycle: AdaptivePlanCycle,
  nowMs: number,
  proofSignedMap?: Readonly<Record<string, boolean>>
): readonly CadenceDayPill[] {
  const activeDayIndex = getActiveDayIndex(cycle.startDateMs, nowMs);
  const weekStartIndex = activeDayIndex < 7 ? 0 : 7;
  const weekPlans = cycle.dailyPlans.slice(weekStartIndex, weekStartIndex + 7);

  return weekPlans.map((plan) => {
    const parsed = new Date(`${plan.date}T00:00:00`);
    const weekdayLabel = Number.isNaN(parsed.getTime())
      ? "Mon"
      : (CADENCE_WEEKDAY_LABELS[parsed.getDay()] ?? "Mon");
    const dayIndex = plan.dayNumber - 1;
    const isToday = plan.dayNumber === activeDayIndex + 1;
    const proofKey =
      dayIndex >= 0 && cycle.id.trim().length > 0
        ? makeDailyProofSignedKey(cycle.id, dayIndex)
        : "";
    const isCompleted =
      plan.completed ||
      (proofKey.length > 0 && proofSignedMap?.[proofKey] === true);

    return {
      date: plan.date,
      dayNumber: plan.dayNumber,
      weekdayLabel,
      isToday,
      isCompleted
    };
  });
}

/**
 * Computes live consecutive completed/signed days ending at today (or yesterday if
 * today is not yet signed). Returns 0 when `cycle` is null or `nowMs < cycle.startDateMs`.
 */
export function calculateLiveStreak(
  cycle: AdaptivePlanCycle | null,
  proofSignedMap: Readonly<Record<string, boolean>>,
  nowMs: number
): number {
  if (!cycle || cycle.dailyPlans.length === 0 || nowMs < cycle.startDateMs) {
    return 0;
  }
  const activeDayIndex = Math.min(
    cycle.dailyPlans.length - 1,
    getActiveDayIndex(cycle.startDateMs, nowMs)
  );
  const isDayDone = (idx: number): boolean => {
    const plan = cycle.dailyPlans[idx];
    if (!plan) {
      return false;
    }
    const key =
      cycle.id.trim().length > 0 ? makeDailyProofSignedKey(cycle.id, idx) : "";
    return plan.completed || (key.length > 0 && proofSignedMap[key] === true);
  };

  let cursor = isDayDone(activeDayIndex) ? activeDayIndex : activeDayIndex - 1;
  let streak = 0;
  while (cursor >= 0 && isDayDone(cursor)) {
    streak += 1;
    cursor -= 1;
  }
  return streak;
}
