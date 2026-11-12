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
  FATIGUE_SCALING_MULTIPLIER
} from "./profileEngine";

export { FATIGUE_GAP_THRESHOLD_MS, FATIGUE_SCALING_MULTIPLIER };

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

/**
 * Scales exercises down for fatigue (30% reduction in sets/duration).
 * Supports both:
 * 1. `scaleExercisesForFatigue(exercises, isFatigued)` -> returns WorkoutExerciseItem[]
 * 2. `scaleExercisesForFatigue(exercises, lastLogTimestampMs, currentTimestampMs)` -> returns { exercises, isFatigueScaled }
 */
export function scaleExercisesForFatigue(
  exercises: readonly WorkoutExerciseItem[],
  isFatigued: boolean
): WorkoutExerciseItem[];
export function scaleExercisesForFatigue(
  exercises: readonly WorkoutExerciseItem[],
  lastLogTimestampMs: number | null,
  currentTimestampMs: number
): { exercises: WorkoutExerciseItem[]; isFatigueScaled: boolean };
export function scaleExercisesForFatigue(
  exercises: readonly WorkoutExerciseItem[],
  arg2: boolean | number | null,
  arg3?: number
): WorkoutExerciseItem[] | { exercises: WorkoutExerciseItem[]; isFatigueScaled: boolean } {
  if (typeof arg2 === "boolean") {
    const isFatigued = arg2;
    return exercises.map((ex) => {
      if (!isFatigued) {
        return { ...ex, scaledForFatigue: false };
      }
      return {
        ...ex,
        sets: Math.max(1, Math.round(ex.sets * FATIGUE_SCALING_MULTIPLIER)),
        durationMinutes:
          ex.durationMinutes !== undefined
            ? Math.max(1, Math.round(ex.durationMinutes * FATIGUE_SCALING_MULTIPLIER))
            : undefined,
        scaledForFatigue: true
      };
    });
  }

  const lastLogTimestampMs = arg2;
  const currentTimestampMs = arg3 ?? Date.now();
  const isFatigued =
    lastLogTimestampMs !== null &&
    currentTimestampMs - lastLogTimestampMs > FATIGUE_GAP_THRESHOLD_MS;

  const scaled = exercises.map((ex) => {
    if (!isFatigued) {
      return { ...ex, scaledForFatigue: false };
    }
    return {
      ...ex,
      sets: Math.max(1, Math.round(ex.sets * FATIGUE_SCALING_MULTIPLIER)),
      durationMinutes:
        ex.durationMinutes !== undefined
          ? Math.max(1, Math.round(ex.durationMinutes * FATIGUE_SCALING_MULTIPLIER))
          : undefined,
      scaledForFatigue: true
    };
  });

  return { exercises: scaled, isFatigueScaled: isFatigued };
}

/**
 * Applies the 48h/-30% fatigue rule to an already-generated, in-progress DailyPlan
 * at runtime, so a mid-cycle inactivity gap takes effect immediately without
 * regenerating the 14-day cycle.
 *
 * - Idempotent: exercises already flagged `scaledForFatigue` are never scaled twice.
 * - Completed exercises and already-completed plans are left untouched.
 * - Never un-scales; a plan scaled earlier stays scaled for the day.
 * - Returns the same plan reference when nothing changes.
 */
export function applyRuntimeFatigueScaling(
  plan: DailyPlan,
  lastLogTimestampMs: number | null,
  currentTimestampMs: number
): DailyPlan {
  const isFatigued =
    lastLogTimestampMs !== null &&
    currentTimestampMs - lastLogTimestampMs > FATIGUE_GAP_THRESHOLD_MS;

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
      sets: Math.max(1, Math.round(ex.sets * FATIGUE_SCALING_MULTIPLIER)),
      durationMinutes:
        ex.durationMinutes !== undefined
          ? Math.max(1, Math.round(ex.durationMinutes * FATIGUE_SCALING_MULTIPLIER))
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
