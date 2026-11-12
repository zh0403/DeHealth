import { describe, it, expect } from "vitest";
import {
  UserBiometrics,
  WeightLogEntry,
  WorkoutExerciseItem,
  STANDARD_FOOD_PRESETS,
  DEFAULT_BASELINE_BIOMETRICS,
  ProposedPlanReviewSchema,
  AdaptivePlanCycleSchema,
  MacroSplitSchema
} from "@dehealth/shared";

import {
  SAFE_CALORIE_FLOOR_KCAL,
  ACTIVITY_MULTIPLIERS,
  GOAL_CALORIE_OFFSETS,
  MACRO_RATIOS,
  FATIGUE_GAP_THRESHOLD_MS,
  FATIGUE_SCALING_MULTIPLIER,
  calculateBmr,
  calculateTdee,
  calculateTargetCalories,
  calculateMacroSplit,
  scaleExercisesForFatigue,
  createDefaultExercises,
  generate14DayPlan,
  calculateRollingWeightAverage,
  evaluateBiWeeklyReview,
  scaleFoodPresetPortion
} from "../services/adaptivePlanEngine";

describe("AdaptivePlanEngine Service Suite", () => {
  // ==========================================================================
  // Suite 1: calculateBmr (Katch-McArdle & Mifflin-St Jeor)
  // ==========================================================================
  describe("Suite 1: calculateBmr", () => {
    it("calculates BMR using Katch-McArdle when bodyFatPct is provided (> 0)", () => {
      const bio: UserBiometrics = {
        age: 28,
        gender: "male",
        weightKg: 70,
        heightCm: 175,
        bodyFatPct: 20, // LBM = 70 * (1 - 0.20) = 56 kg -> 370 + 21.6 * 56 = 1579.6 -> 1580
        weeklyWorkoutFrequency: 4,
        goal: "maintain"
      };
      expect(calculateBmr(bio)).toBe(1580);
    });

    it("calculates BMR using Katch-McArdle at minimum bodyFatPct boundary (2%)", () => {
      const bio: UserBiometrics = {
        age: 28,
        gender: "male",
        weightKg: 70,
        heightCm: 175,
        bodyFatPct: 2.0, // LBM = 70 * (1 - 0.02) = 68.6 kg -> 370 + 21.6 * 68.6 = 1851.76 -> 1852
        weeklyWorkoutFrequency: 4,
        goal: "cut"
      };
      expect(calculateBmr(bio)).toBe(1852);
    });

    it("calculates BMR using Katch-McArdle at maximum bodyFatPct boundary (75%)", () => {
      const bio: UserBiometrics = {
        age: 40,
        gender: "female",
        weightKg: 100,
        heightCm: 160,
        bodyFatPct: 75.0, // LBM = 100 * (1 - 0.75) = 25 kg -> 370 + 21.6 * 25 = 910
        weeklyWorkoutFrequency: 3,
        goal: "fat_loss"
      };
      expect(calculateBmr(bio)).toBe(910);
    });

    it("falls back to Mifflin-St Jeor for male (s = +5) when bodyFatPct is undefined", () => {
      const bio: UserBiometrics = {
        age: 28,
        gender: "male",
        weightKg: 70,
        heightCm: 175,
        weeklyWorkoutFrequency: 3,
        goal: "maintain"
      };
      // Base = 10*70 + 6.25*175 - 5*28 = 700 + 1093.75 - 140 = 1653.75
      // s = +5 -> 1658.75 -> round = 1659
      expect(calculateBmr(bio)).toBe(1659);
    });

    it("falls back to Mifflin-St Jeor for female (s = -161) when bodyFatPct is undefined", () => {
      const bio: UserBiometrics = {
        age: 25,
        gender: "female",
        weightKg: 60,
        heightCm: 165,
        weeklyWorkoutFrequency: 3,
        goal: "maintain"
      };
      // Base = 10*60 + 6.25*165 - 5*25 = 600 + 1031.25 - 125 = 1506.25
      // s = -161 -> 1345.25 -> round = 1345
      expect(calculateBmr(bio)).toBe(1345);
    });

    it("falls back to Mifflin-St Jeor for other (s = -78 midpoint) when bodyFatPct is undefined", () => {
      const bio: UserBiometrics = {
        age: 28,
        gender: "other",
        weightKg: 70,
        heightCm: 175,
        weeklyWorkoutFrequency: 3,
        goal: "maintain"
      };
      // Base = 1653.75
      // s = -78 -> 1575.75 -> round = 1576
      expect(calculateBmr(bio)).toBe(1576);
    });

    it("falls back to Mifflin-St Jeor if bodyFatPct is 0 or negative", () => {
      const bio: UserBiometrics = {
        age: 28,
        gender: "male",
        weightKg: 70,
        heightCm: 175,
        bodyFatPct: 0,
        weeklyWorkoutFrequency: 3,
        goal: "maintain"
      };
      expect(calculateBmr(bio)).toBe(1659);
    });
  });

  // ==========================================================================
  // Suite 2: calculateTdee (Activity Multipliers & Frequency)
  // ==========================================================================
  describe("Suite 2: calculateTdee", () => {
    const bmr = 1500;

    it("applies activityLevel multipliers correctly", () => {
      expect(calculateTdee(bmr, 3, "sedentary")).toBe(Math.round(1500 * ACTIVITY_MULTIPLIERS.sedentary)); // 1800
      expect(calculateTdee(bmr, 3, "light")).toBe(Math.round(1500 * ACTIVITY_MULTIPLIERS.light)); // 2063
      expect(calculateTdee(bmr, 3, "moderate")).toBe(Math.round(1500 * ACTIVITY_MULTIPLIERS.moderate)); // 2325
      expect(calculateTdee(bmr, 3, "heavy")).toBe(Math.round(1500 * ACTIVITY_MULTIPLIERS.heavy)); // 2588
      expect(calculateTdee(bmr, 3, "very_active")).toBe(Math.round(1500 * ACTIVITY_MULTIPLIERS.very_active)); // 2850
    });

    it("falls back to weekly frequency ranges when activityLevel is not provided or invalid", () => {
      // <= 2: 1.2
      expect(calculateTdee(bmr, 1)).toBe(Math.round(1500 * 1.2)); // 1800
      expect(calculateTdee(bmr, 2)).toBe(Math.round(1500 * 1.2)); // 1800
      // 3 - 4: 1.55
      expect(calculateTdee(bmr, 3)).toBe(Math.round(1500 * 1.55)); // 2325
      expect(calculateTdee(bmr, 4)).toBe(Math.round(1500 * 1.55)); // 2325
      // 5 - 6: 1.725
      expect(calculateTdee(bmr, 5)).toBe(Math.round(1500 * 1.725)); // 2588
      expect(calculateTdee(bmr, 6)).toBe(Math.round(1500 * 1.725)); // 2588
      // >= 7: 1.9
      expect(calculateTdee(bmr, 7)).toBe(Math.round(1500 * 1.9)); // 2850
      // invalid activityLevel string
      expect(calculateTdee(bmr, 4, "unknown_level")).toBe(Math.round(1500 * 1.55));
    });
  });

  // ==========================================================================
  // Suite 3: calculateTargetCalories (Safe Floor & Goal Offsets)
  // ==========================================================================
  describe("Suite 3: calculateTargetCalories", () => {
    it("applies deficit for cut and fat_loss (-500 kcal)", () => {
      expect(calculateTargetCalories(2500, "cut")).toBe(2000);
      expect(calculateTargetCalories(2500, "fat_loss")).toBe(2000);
    });

    it("applies zero offset for maintain and maintenance (0 kcal)", () => {
      expect(calculateTargetCalories(2200, "maintain")).toBe(2200);
      expect(calculateTargetCalories(2200, "maintenance")).toBe(2200);
    });

    it("applies surplus for bulk and muscle_gain (+350 kcal)", () => {
      expect(calculateTargetCalories(2000, "bulk")).toBe(2350);
      expect(calculateTargetCalories(2000, "muscle_gain")).toBe(2350);
    });

    it("enforces SAFE_CALORIE_FLOOR_KCAL (1200 kcal) when deficit drops below floor", () => {
      // 1400 - 500 = 900 -> clamped to 1200
      expect(calculateTargetCalories(1400, "cut")).toBe(SAFE_CALORIE_FLOOR_KCAL);
      // 1200 - 500 = 700 -> clamped to 1200
      expect(calculateTargetCalories(1200, "fat_loss")).toBe(SAFE_CALORIE_FLOOR_KCAL);
      // Exactly 1700 - 500 = 1200
      expect(calculateTargetCalories(1700, "cut")).toBe(1200);
    });

    it("defaults to 0 offset for unknown goal", () => {
      // @ts-expect-error Testing fallback for unknown goal
      expect(calculateTargetCalories(2000, "unknown_goal")).toBe(2000);
    });
  });

  // ==========================================================================
  // Suite 4: calculateMacroSplit (Macronutrient Allocations)
  // ==========================================================================
  describe("Suite 4: calculateMacroSplit", () => {
    it("calculates cut / fat_loss macro split (35% P, 35% C, 30% F)", () => {
      const split = calculateMacroSplit(2000, "cut");
      // 2000 * 0.35 / 4 = 175g P
      // 2000 * 0.35 / 4 = 175g C
      // 2000 * 0.30 / 9 = 66.67 -> 67g F
      expect(split).toEqual({ proteinGrams: 175, carbsGrams: 175, fatGrams: 67 });
      expect(calculateMacroSplit(2000, "fat_loss")).toEqual(split);
      expect(() => MacroSplitSchema.parse(split)).not.toThrow();
    });

    it("calculates maintain / maintenance macro split (30% P, 45% C, 25% F)", () => {
      const split = calculateMacroSplit(2000, "maintain");
      // 2000 * 0.30 / 4 = 150g P
      // 2000 * 0.45 / 4 = 225g C
      // 2000 * 0.25 / 9 = 55.56 -> 56g F
      expect(split).toEqual({ proteinGrams: 150, carbsGrams: 225, fatGrams: 56 });
      expect(calculateMacroSplit(2000, "maintenance")).toEqual(split);
    });

    it("calculates bulk / muscle_gain macro split (30% P, 50% C, 20% F)", () => {
      const split = calculateMacroSplit(2400, "bulk");
      // 2400 * 0.30 / 4 = 180g P
      // 2400 * 0.50 / 4 = 300g C
      // 2400 * 0.20 / 9 = 53.33 -> 53g F
      expect(split).toEqual({ proteinGrams: 180, carbsGrams: 300, fatGrams: 53 });
      expect(calculateMacroSplit(2400, "muscle_gain")).toEqual(split);
    });

    it("clamps input target calories below 1200 kcal to SAFE_CALORIE_FLOOR_KCAL", () => {
      const splitLow = calculateMacroSplit(800, "cut");
      const splitFloor = calculateMacroSplit(1200, "cut");
      expect(splitLow).toEqual(splitFloor);
    });

    it("falls back to maintain ratio for unknown goal", () => {
      // @ts-expect-error Testing fallback for unknown goal
      const split = calculateMacroSplit(2000, "other_goal");
      expect(split).toEqual(calculateMacroSplit(2000, "maintain"));
    });
  });

  // ==========================================================================
  // Suite 5: calculateRollingWeightAverage
  // ==========================================================================
  describe("Suite 5: calculateRollingWeightAverage", () => {
    it("returns null for empty log array", () => {
      expect(calculateRollingWeightAverage([])).toBeNull();
    });

    it("returns exact weight for a single log", () => {
      const logs: WeightLogEntry[] = [
        { id: "w1", timestampMs: 1000, weightKg: 75.4 }
      ];
      expect(calculateRollingWeightAverage(logs)).toBe(75.4);
    });

    it("calculates arithmetic mean for logs within 7-day window", () => {
      const logs: WeightLogEntry[] = [
        { id: "w1", timestampMs: 1000, weightKg: 70.0 },
        { id: "w2", timestampMs: 2000, weightKg: 70.2 },
        { id: "w3", timestampMs: 3000, weightKg: 69.8 }
      ];
      // (70.0 + 70.2 + 69.8) / 3 = 210.0 / 3 = 70.0
      expect(calculateRollingWeightAverage(logs)).toBe(70.0);
    });

    it("sorts out-of-order logs chronologically before averaging", () => {
      const logs: WeightLogEntry[] = [
        { id: "w3", timestampMs: 3000, weightKg: 68.0 },
        { id: "w1", timestampMs: 1000, weightKg: 70.0 },
        { id: "w2", timestampMs: 2000, weightKg: 69.0 }
      ];
      expect(calculateRollingWeightAverage(logs)).toBe(69.0);
    });

    it("averages only the trailing 7 logs when more than 7 logs exist", () => {
      const logs: WeightLogEntry[] = [
        { id: "old1", timestampMs: 100, weightKg: 100.0 },
        { id: "old2", timestampMs: 200, weightKg: 100.0 },
        { id: "w1", timestampMs: 1000, weightKg: 70.0 },
        { id: "w2", timestampMs: 2000, weightKg: 70.0 },
        { id: "w3", timestampMs: 3000, weightKg: 70.0 },
        { id: "w4", timestampMs: 4000, weightKg: 70.0 },
        { id: "w5", timestampMs: 5000, weightKg: 70.0 },
        { id: "w6", timestampMs: 6000, weightKg: 70.0 },
        { id: "w7", timestampMs: 7000, weightKg: 70.0 }
      ];
      // 9 logs total; oldest two (100.0) dropped; trailing 7 are all 70.0 -> average = 70.0
      expect(calculateRollingWeightAverage(logs)).toBe(70.0);
    });

    it("handles duplicate timestamps deterministically", () => {
      const logs: WeightLogEntry[] = [
        { id: "w1", timestampMs: 1000, weightKg: 70.0 },
        { id: "w2", timestampMs: 1000, weightKg: 72.0 },
        { id: "w3", timestampMs: 2000, weightKg: 71.0 }
      ];
      expect(calculateRollingWeightAverage(logs)).toBe(71.0);
    });
  });

  // ==========================================================================
  // Suite 6: scaleExercisesForFatigue, createDefaultExercises, & generate14DayPlan
  // ==========================================================================
  describe("Suite 6: Exercise Scaling & 14-Day Plan Generator", () => {
    const sampleExercises: WorkoutExerciseItem[] = [
      { id: "e1", name: "Push-ups", category: "Chest", sets: 4, reps: 15, completed: false },
      { id: "e2", name: "Plank Hold", category: "Core", sets: 3, durationMinutes: 2, completed: false },
      { id: "e3", name: "Single Set", category: "Test", sets: 1, durationMinutes: 1, completed: false }
    ];

    it("scales exercises down by 30% when isFatigued is true (boolean signature)", () => {
      const scaled = scaleExercisesForFatigue(sampleExercises, true);
      expect(scaled[0]!.sets).toBe(Math.round(4 * FATIGUE_SCALING_MULTIPLIER)); // 3
      expect(scaled[0]!.scaledForFatigue).toBe(true);
      expect(scaled[1]!.durationMinutes).toBe(Math.max(1, Math.round(2 * FATIGUE_SCALING_MULTIPLIER))); // 1
      expect(scaled[2]!.sets).toBe(1); // Math.max(1, round(0.7)) = 1
      expect(scaled[2]!.durationMinutes).toBe(1);
    });

    it("keeps exercises unscaled when isFatigued is false (boolean signature)", () => {
      const unscaled = scaleExercisesForFatigue(sampleExercises, false);
      expect(unscaled[0]!.sets).toBe(4);
      expect(unscaled[0]!.scaledForFatigue).toBe(false);
      expect(unscaled[1]!.durationMinutes).toBe(2);
    });

    it("scales exercises with timestamp overload when inactivity gap > 48 hours", () => {
      const baseTime = 1_000_000_000;
      const after72h = baseTime + 72 * 60 * 60 * 1000;
      const result = scaleExercisesForFatigue(sampleExercises, baseTime, after72h);
      expect(result.isFatigueScaled).toBe(true);
      expect(result.exercises[0]!.sets).toBe(3);
      expect(result.exercises[0]!.scaledForFatigue).toBe(true);
    });

    it("keeps exercises unscaled with timestamp overload when gap <= 48 hours", () => {
      const baseTime = 1_000_000_000;
      const after24h = baseTime + 24 * 60 * 60 * 1000;
      const result = scaleExercisesForFatigue(sampleExercises, baseTime, after24h);
      expect(result.isFatigueScaled).toBe(false);
      expect(result.exercises[0]!.sets).toBe(4);
      expect(result.exercises[0]!.scaledForFatigue).toBe(false);
    });

    it("keeps exercises unscaled with timestamp overload when lastLogTimestampMs is null", () => {
      const result = scaleExercisesForFatigue(sampleExercises, null, Date.now());
      expect(result.isFatigueScaled).toBe(false);
      expect(result.exercises[0]!.scaledForFatigue).toBe(false);
    });

    it("defaults currentTimestampMs to Date.now() when arg3 is omitted", () => {
      const longAgo = Date.now() - 72 * 60 * 60 * 1000;
      const result = scaleExercisesForFatigue(sampleExercises, longAgo);
      expect(result.isFatigueScaled).toBe(true);
      expect(result.exercises[0]!.sets).toBe(3);
    });

    it("creates default exercises across rotating templates", () => {
      const day1 = createDefaultExercises(1, false);
      const day2 = createDefaultExercises(2, false);
      const day3 = createDefaultExercises(3, false);
      const day4 = createDefaultExercises(4, false); // should match day 1 template

      expect(day1[0]!.name).toBe("Push-ups");
      expect(day2[0]!.name).toBe("Bodyweight Squats");
      expect(day3[0]!.name).toBe("Brisk Jogging / Running");
      expect(day4[0]!.name).toBe("Push-ups");
    });

    it("generates a full 14-day cycle adhering to AdaptivePlanCycleSchema", () => {
      const startDate = 1_700_000_000_000;
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, startDate, null, 1);

      expect(cycle.id).toBe(`cycle_1_${startDate}`);
      expect(cycle.dailyPlans).toHaveLength(14);
      expect(cycle.status).toBe("active");
      expect(cycle.targetDailyCalories).toBeGreaterThanOrEqual(SAFE_CALORIE_FLOOR_KCAL);
      expect(() => AdaptivePlanCycleSchema.parse(cycle)).not.toThrow();

      // Check dates are sequential
      expect(cycle.dailyPlans[0]!.dayNumber).toBe(1);
      expect(cycle.dailyPlans[13]!.dayNumber).toBe(14);
      expect(cycle.dailyPlans[0]!.isFatigueScaled).toBe(false);
    });

    it("applies fatigue scaling to Day 1 only when inactivity gap > 48h", () => {
      const lastLog = 1_700_000_000_000;
      const startDate = lastLog + 72 * 60 * 60 * 1000; // 72 hours gap (>48h)
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, startDate, lastLog, 1);

      // Day 1 must be scaled
      expect(cycle.dailyPlans[0]!.isFatigueScaled).toBe(true);
      expect(cycle.dailyPlans[0]!.exercises[0]!.scaledForFatigue).toBe(true);
      expect(cycle.dailyPlans[0]!.exercises[0]!.sets).toBe(3); // 4 * 0.7 = 2.8 -> 3

      // Day 2 must NOT be scaled
      expect(cycle.dailyPlans[1]!.isFatigueScaled).toBe(false);
      expect(cycle.dailyPlans[1]!.exercises[0]!.scaledForFatigue).toBe(false);
    });
  });

  // ==========================================================================
  // Suite 7: evaluateBiWeeklyReview (Pure Deterministic Review Engine)
  // ==========================================================================
  describe("Suite 7: evaluateBiWeeklyReview", () => {
    const baseDate = 1_700_000_000_000;
    const makeCycle = (goal: UserBiometrics["goal"], calories: number): ReturnType<typeof generate14DayPlan> => {
      const bio: UserBiometrics = {
        ...DEFAULT_BASELINE_BIOMETRICS,
        goal,
        weightKg: 80.0
      };
      const cycle = generate14DayPlan(bio, baseDate, null, 1);
      return {
        ...cycle,
        targetDailyCalories: calories
      };
    };

    // --- Sub-suite 7.1: Adherence < 80% ---
    it("holds targets constant when adherence is below 80%", () => {
      const cycle = makeCycle("cut", 2000);
      const logs: WeightLogEntry[] = [
        { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
        { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 81.0 }
      ];
      const review = evaluateBiWeeklyReview(cycle, logs, 79.9, baseDate + 14 * 86400000);

      expect(review.proposedDailyCalories).toBe(2000);
      expect(review.calorieAdjustment).toBe(0);
      expect(review.rationale).toContain("below the 80% threshold");
      expect(() => ProposedPlanReviewSchema.parse(review)).not.toThrow();
    });

    it("holds targets constant when adherence is 0%", () => {
      const cycle = makeCycle("maintain", 2200);
      const review = evaluateBiWeeklyReview(cycle, [], 0, baseDate + 14 * 86400000);

      expect(review.proposedDailyCalories).toBe(2200);
      expect(review.calorieAdjustment).toBe(0);
      expect(review.startingWeightKg).toBe(80.0);
      expect(review.currentWeightKg).toBe(80.0);
    });

    // --- Sub-suite 7.2: Goal: fat_loss / cut with high adherence (>= 80%) ---
    describe("Cut / Fat Loss Decision Matrix", () => {
      it("decreases by 100 kcal when weight loss stalled (delta >= -0.2 kg)", () => {
        const cycle = makeCycle("cut", 2000);
        // delta = -0.2 kg (exact boundary)
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 79.8 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(1900);
        expect(review.calorieAdjustment).toBe(-100);
        expect(review.rationale).toContain("Weight loss stalled");
      });

      it("decreases by 100 kcal when weight increased on a cut (delta > 0)", () => {
        const cycle = makeCycle("fat_loss", 2000);
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 80.5 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 90, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(1900);
        expect(review.calorieAdjustment).toBe(-100);
      });

      it("maintains targets when weight loss is steady (-1.5 kg <= delta < -0.2 kg)", () => {
        const cycle = makeCycle("cut", 2000);
        // delta = -0.8 kg
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 79.2 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2000);
        expect(review.calorieAdjustment).toBe(0);
        expect(review.rationale).toContain("Healthy and steady fat loss progress");
      });

      it("maintains targets at steady lower boundary (-1.5 kg)", () => {
        const cycle = makeCycle("cut", 2000);
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 78.5 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 80, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2000);
        expect(review.calorieAdjustment).toBe(0);
      });

      it("increases by 150 kcal when weight loss is too rapid (delta < -1.5 kg)", () => {
        const cycle = makeCycle("cut", 2000);
        // delta = -2.0 kg
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 78.0 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2150);
        expect(review.calorieAdjustment).toBe(150);
        expect(review.rationale).toContain("too rapid");
      });
    });

    // --- Sub-suite 7.3: Goal: muscle_gain / bulk with high adherence (>= 80%) ---
    describe("Bulk / Muscle Gain Decision Matrix", () => {
      it("increases by 150 kcal when weight gain stalled (delta <= 0.2 kg)", () => {
        const cycle = makeCycle("bulk", 2500);
        // delta = +0.1 kg
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 80.1 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2650);
        expect(review.calorieAdjustment).toBe(150);
        expect(review.rationale).toContain("Weight gain has stalled");
      });

      it("increases by 150 kcal when weight decreased on a bulk (delta < 0)", () => {
        const cycle = makeCycle("bulk", 2500);
        // delta = -0.5 kg
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 79.5 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2650);
        expect(review.calorieAdjustment).toBe(150);
        expect(review.rationale).toContain("Weight gain has stalled");
      });

      it("maintains surplus when lean gain is on track (0.2 < delta <= 1.0 kg)", () => {
        const cycle = makeCycle("muscle_gain", 2500);
        // delta = +0.6 kg
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 80.6 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 90, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2500);
        expect(review.calorieAdjustment).toBe(0);
        expect(review.rationale).toContain("Lean muscle mass progression on track");
      });

      it("decreases surplus by 100 kcal when weight gain is too rapid (delta > 1.0 kg)", () => {
        const cycle = makeCycle("bulk", 2500);
        // delta = +1.5 kg
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 81.5 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2400);
        expect(review.calorieAdjustment).toBe(-100);
        expect(review.rationale).toContain("exceeding optimal rate");
      });
    });

    // --- Sub-suite 7.4: Goal: maintain / maintenance with high adherence (>= 80%) ---
    describe("Maintenance Decision Matrix", () => {
      it("preserves targets when weight is stable (|delta| <= 0.5 kg)", () => {
        const cycle = makeCycle("maintain", 2200);
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 80.3 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2200);
        expect(review.calorieAdjustment).toBe(0);
        expect(review.rationale).toContain("stable within ±0.5 kg");
      });

      it("decreases by 100 kcal when weight drifted upward (delta > 0.5 kg)", () => {
        const cycle = makeCycle("maintenance", 2200);
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 80.8 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2100);
        expect(review.calorieAdjustment).toBe(-100);
        expect(review.rationale).toContain("drifted upward");
      });

      it("increases by 100 kcal when weight drifted downward (delta < -0.5 kg)", () => {
        const cycle = makeCycle("maintain", 2200);
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 79.2 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(2300);
        expect(review.calorieAdjustment).toBe(100);
        expect(review.rationale).toContain("drifted downward");
      });
    });

    // --- Sub-suite 7.5: Safe Floor Clamping & Boundaries ---
    describe("Safe Floor Clamping in Bi-Weekly Review", () => {
      it("clamps proposed calories to 1200 kcal floor and updates actual calorieAdjustment", () => {
        // Current cycle calories = 1250. Stalled cut would normally decrement by 100 kcal to 1150.
        // Clamping sets proposed to 1200 kcal, so actual adjustment is -50 kcal.
        const cycle = makeCycle("cut", 1250);
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 80.0 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(SAFE_CALORIE_FLOOR_KCAL);
        expect(review.calorieAdjustment).toBe(-50);
        expect(review.rationale).toContain("clamped to safe floor of 1200 kcal");
        expect(() => ProposedPlanReviewSchema.parse(review)).not.toThrow();
      });

      it("clamps to 1200 kcal floor when starting exactly at 1200 kcal", () => {
        const cycle = makeCycle("cut", 1200);
        const logs: WeightLogEntry[] = [
          { id: "w1", timestampMs: baseDate, weightKg: 80.0 },
          { id: "w2", timestampMs: baseDate + 14 * 86400000, weightKg: 80.2 }
        ];
        const review = evaluateBiWeeklyReview(cycle, logs, 85, baseDate + 14 * 86400000);

        expect(review.proposedDailyCalories).toBe(SAFE_CALORIE_FLOOR_KCAL);
        expect(review.calorieAdjustment).toBe(0);
        expect(review.rationale).toContain("clamped to safe floor of 1200 kcal");
      });
    });

    // --- Sub-suite 7.6: Default reviewDateMs ---
    it("defaults reviewDateMs to Date.now() when omitted", () => {
      const cycle = makeCycle("maintain", 2000);
      const before = Date.now();
      const review = evaluateBiWeeklyReview(cycle, [], 85);
      const after = Date.now();

      expect(review.reviewDateMs).toBeGreaterThanOrEqual(before);
      expect(review.reviewDateMs).toBeLessThanOrEqual(after);
    });
  });

  // ==========================================================================
  // Suite 8: scaleFoodPresetPortion
  // ==========================================================================
  describe("Suite 8: scaleFoodPresetPortion", () => {
    it("scales chicken breast linearly for 150g portion", () => {
      const chicken = STANDARD_FOOD_PRESETS[0]!; // 100g: 165 kcal, 31g P, 0g C, 3.6g F
      const scaled = scaleFoodPresetPortion(chicken, 150);

      expect(scaled.servingSizeGrams).toBe(150);
      expect(scaled.caloriesKcal).toBe(247.5);
      expect(scaled.proteinGrams).toBe(46.5);
      expect(scaled.carbsGrams).toBe(0);
      expect(scaled.fatGrams).toBe(5.4);
    });

    it("returns 0 nutrients for 0g portion", () => {
      const chicken = STANDARD_FOOD_PRESETS[0]!;
      const scaled = scaleFoodPresetPortion(chicken, 0);

      expect(scaled.servingSizeGrams).toBe(0);
      expect(scaled.caloriesKcal).toBe(0);
      expect(scaled.proteinGrams).toBe(0);
      expect(scaled.carbsGrams).toBe(0);
      expect(scaled.fatGrams).toBe(0);
    });

    it("calculates precise fractional macros for 33.3g whey protein portion", () => {
      const whey = STANDARD_FOOD_PRESETS[2]!; // 30g serving, 120 kcal, 24g P
      const scaled = scaleFoodPresetPortion(whey, 33.3);

      expect(scaled.caloriesKcal).toBe(133.2);
      expect(scaled.proteinGrams).toBe(26.6);
    });

    it("clamps negative portion grams to 0", () => {
      const chicken = STANDARD_FOOD_PRESETS[0]!;
      const scaled = scaleFoodPresetPortion(chicken, -50);

      expect(scaled.servingSizeGrams).toBe(0);
      expect(scaled.caloriesKcal).toBe(0);
    });
  });
});
