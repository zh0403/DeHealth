import { Bytes32 } from "./eip712";

export interface UserProfile {
  readonly age: number;
  readonly gender: string;
  readonly bodyFatPct: number;
  readonly muscleMassKg: number;
}

export interface TelemetryData {
  readonly timestampMs: number;
  readonly stepCount: number;
  readonly activeMinutes: number;
  readonly avgHeartRateBpm: number;
  readonly caloriesBurnedKcal: number;
  readonly profileSnapshot: UserProfile;
}

export interface AnonymizedFeedRecord {
  readonly id: string;
  readonly user_pseudonym: string;
  readonly proof_hash: Bytes32;
  readonly streak_count: number;
  readonly created_at: string;
}

export interface PeerCheerRecord {
  readonly id: string;
  readonly feed_id: string;
  readonly sender_pseudonym: string;
  readonly created_at: string;
}

// ============================================================================
// Phase 2.0 Adaptive Fitness & Nutrition Domain Models
// ============================================================================

export const FITNESS_GOALS = [
  "cut",
  "maintain",
  "bulk",
  "fat_loss",
  "maintenance",
  "muscle_gain"
] as const;

export type FitnessGoal = (typeof FITNESS_GOALS)[number];

export const GENDER_TYPES = ["male", "female", "other"] as const;

export type GenderType = (typeof GENDER_TYPES)[number];

export const ACTIVITY_LEVELS = [
  "sedentary",
  "light",
  "moderate",
  "heavy",
  "very_active"
] as const;

export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

export interface UserBiometrics {
  readonly age: number;
  readonly gender: GenderType;
  readonly weightKg: number;
  readonly heightCm: number;
  readonly bodyFatPct?: number | undefined;
  readonly weeklyWorkoutFrequency: number;
  readonly goal: FitnessGoal;
  readonly activityLevel?: ActivityLevel | undefined;
  readonly updatedAtMs?: number | undefined;
}

export const DEFAULT_BASELINE_BIOMETRICS: UserBiometrics = Object.freeze({
  age: 28,
  gender: "male",
  weightKg: 70.0,
  heightCm: 175.0,
  bodyFatPct: 18.5,
  weeklyWorkoutFrequency: 3,
  goal: "maintain",
  activityLevel: "moderate"
});

export interface WeightLogEntry {
  readonly id: string;
  readonly timestampMs: number;
  readonly weightKg: number;
  readonly bodyFatPct?: number | undefined;
  readonly note?: string | undefined;
}

export interface WorkoutExerciseItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly sets: number;
  readonly reps?: number | undefined;
  readonly durationMinutes?: number | undefined;
  readonly completed: boolean;
  readonly scaledForFatigue?: boolean | undefined;
}

export interface FoodPresetItem {
  readonly id: string;
  readonly name: string;
  readonly servingSizeGrams: number;
  readonly caloriesKcal: number;
  readonly proteinGrams: number;
  readonly carbsGrams: number;
  readonly fatGrams: number;
  readonly category?: string | undefined;
}

export const STANDARD_FOOD_PRESETS: readonly FoodPresetItem[] = Object.freeze([
  Object.freeze({
    id: "preset_chicken_breast",
    name: "Chicken Breast",
    servingSizeGrams: 100,
    caloriesKcal: 165,
    proteinGrams: 31,
    carbsGrams: 0,
    fatGrams: 3.6,
    category: "protein"
  }),
  Object.freeze({
    id: "preset_brown_rice",
    name: "Brown Rice",
    servingSizeGrams: 100,
    caloriesKcal: 112,
    proteinGrams: 2.6,
    carbsGrams: 24,
    fatGrams: 0.9,
    category: "carbs"
  }),
  Object.freeze({
    id: "preset_whey_protein",
    name: "Whey Protein Scoop",
    servingSizeGrams: 30,
    caloriesKcal: 120,
    proteinGrams: 24,
    carbsGrams: 2,
    fatGrams: 1.5,
    category: "protein"
  }),
  Object.freeze({
    id: "preset_whole_egg",
    name: "Whole Egg",
    servingSizeGrams: 50,
    caloriesKcal: 72,
    proteinGrams: 6.3,
    carbsGrams: 0.4,
    fatGrams: 4.8,
    category: "protein"
  }),
  Object.freeze({
    id: "preset_rolled_oats",
    name: "Rolled Oats",
    servingSizeGrams: 50,
    caloriesKcal: 190,
    proteinGrams: 6.5,
    carbsGrams: 34,
    fatGrams: 3.5,
    category: "carbs"
  }),
  Object.freeze({
    id: "preset_greek_yogurt",
    name: "Greek Yogurt",
    servingSizeGrams: 150,
    caloriesKcal: 100,
    proteinGrams: 17,
    carbsGrams: 6,
    fatGrams: 0.7,
    category: "dairy"
  })
]);

export interface DailyPlan {
  readonly dayNumber: number;
  readonly date: string;
  readonly targetCaloriesKcal: number;
  readonly targetProteinGrams: number;
  readonly targetCarbsGrams: number;
  readonly targetFatGrams: number;
  readonly loggedCaloriesKcal: number;
  readonly loggedProteinGrams: number;
  readonly loggedCarbsGrams: number;
  readonly loggedFatGrams: number;
  readonly exercises: readonly WorkoutExerciseItem[];
  readonly isFatigueScaled: boolean;
  readonly completed: boolean;
}

export const PLAN_CYCLE_STATUSES = ["active", "completed", "reviewed"] as const;

export type PlanCycleStatus = (typeof PLAN_CYCLE_STATUSES)[number];

export interface AdaptivePlanCycle {
  readonly id: string;
  readonly cycleNumber: number;
  readonly startDateMs: number;
  readonly endDateMs: number;
  readonly goal: FitnessGoal;
  readonly baselineBiometrics: UserBiometrics;
  readonly targetDailyCalories: number;
  readonly targetDailyProteinGrams: number;
  readonly targetDailyCarbsGrams: number;
  readonly targetDailyFatGrams: number;
  readonly dailyPlans: readonly DailyPlan[];
  readonly status: PlanCycleStatus;
}

export interface MacroSplit {
  readonly proteinGrams: number;
  readonly carbsGrams: number;
  readonly fatGrams: number;
}

export const PLAN_REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;

export type PlanReviewStatus = (typeof PLAN_REVIEW_STATUSES)[number];

export interface ProposedPlanReview {
  readonly cycleId: string;
  readonly reviewDateMs: number;
  readonly adherencePct: number;
  readonly startingWeightKg: number;
  readonly currentWeightKg: number;
  readonly weightChangeKg: number;
  readonly rollingAverageWeightKg: number;
  readonly currentDailyCalories: number;
  readonly proposedDailyCalories: number;
  readonly calorieAdjustment: number;
  readonly currentMacroSplit: MacroSplit;
  readonly proposedMacroSplit: MacroSplit;
  readonly rationale: string;
  readonly status: PlanReviewStatus;
}
