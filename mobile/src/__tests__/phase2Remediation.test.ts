import {
  AdaptivePlanCycle,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  FITNESS_GOALS,
  FitnessGoal,
  UserBiometrics
} from "@dehealth/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles
  }
}));

import {
  addFoodPortionToDailyPlan,
  DUAL_TRACK_FOOD_PRESETS,
  hasMinimumDailyProgress,
  toggleExerciseInDailyPlan
} from "../screens/MicroCheckInScreen";
import {
  applyRuntimeFatigueScaling,
  evaluateBiWeeklyReview,
  FATIGUE_GAP_THRESHOLD_MS,
  generate14DayPlan,
  resolveGoalTrack
} from "../services/adaptivePlanEngine";

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 10, 1);

function cycleFor(goal: FitnessGoal): AdaptivePlanCycle {
  const bio: UserBiometrics = { ...DEFAULT_BASELINE_BIOMETRICS, goal };
  return generate14DayPlan(bio, START_MS);
}

function day1(): DailyPlan {
  return cycleFor("maintain").dailyPlans[0]!;
}

describe("Phase 2.0 remediation regression suite", () => {
  describe("Probe 1: FitnessGoal enum parity", () => {
    it("maps every member of FITNESS_GOALS onto an explicit review track", () => {
      for (const goal of FITNESS_GOALS) {
        expect(["deficit", "surplus", "maintenance"]).toContain(resolveGoalTrack(goal));
      }
    });

    it("rejects an unknown goal at runtime instead of falling through to maintenance", () => {
      expect(() => resolveGoalTrack("lean_recomp" as unknown as FitnessGoal)).toThrow(
        /Unhandled FitnessGoal/
      );
    });

    it("keeps aliases on identical tracks", () => {
      expect(resolveGoalTrack("cut")).toBe(resolveGoalTrack("fat_loss"));
      expect(resolveGoalTrack("bulk")).toBe(resolveGoalTrack("muscle_gain"));
      expect(resolveGoalTrack("maintain")).toBe(resolveGoalTrack("maintenance"));
    });

    it("generates a valid 14-day plan and a review for every goal without throwing", () => {
      for (const goal of FITNESS_GOALS) {
        const cycle = cycleFor(goal);
        expect(cycle.dailyPlans).toHaveLength(14);
        expect(cycle.targetDailyCalories).toBeGreaterThanOrEqual(1200);
        const review = evaluateBiWeeklyReview(cycle, [], 90, START_MS);
        expect(review.proposedDailyCalories).toBeGreaterThanOrEqual(1200);
      }
    });

    it("applies the same goal-specific review result to alias pairs", () => {
      const logs = [
        { id: "a", timestampMs: START_MS, weightKg: 70 },
        { id: "b", timestampMs: START_MS + 13 * 24 * HOUR_MS, weightKg: 70 }
      ];
      const pairs: ReadonlyArray<readonly [FitnessGoal, FitnessGoal]> = [
        ["cut", "fat_loss"],
        ["bulk", "muscle_gain"],
        ["maintain", "maintenance"]
      ];
      for (const [a, b] of pairs) {
        const ra = evaluateBiWeeklyReview(cycleFor(a), logs, 90, START_MS);
        const rb = evaluateBiWeeklyReview(cycleFor(b), logs, 90, START_MS);
        expect(ra.calorieAdjustment).toBe(rb.calorieAdjustment);
      }
    });

    it("moves calories in the direction each track requires on a stalled scale", () => {
      const flat = [
        { id: "a", timestampMs: START_MS, weightKg: 70 },
        { id: "b", timestampMs: START_MS + 13 * 24 * HOUR_MS, weightKg: 70 }
      ];
      expect(
        evaluateBiWeeklyReview(cycleFor("cut"), flat, 95, START_MS).calorieAdjustment
      ).toBeLessThan(0);
      expect(
        evaluateBiWeeklyReview(cycleFor("bulk"), flat, 95, START_MS).calorieAdjustment
      ).toBeGreaterThan(0);
      expect(
        evaluateBiWeeklyReview(cycleFor("maintain"), flat, 95, START_MS).calorieAdjustment
      ).toBe(0);
    });
  });

  describe("Probe 2: runtime 48h fatigue scaling on an active plan", () => {
    it("scales unfinished exercises by 30% when the gap exceeds 48h", () => {
      const plan = day1();
      const now = START_MS + 60 * HOUR_MS;
      const scaled = applyRuntimeFatigueScaling(plan, START_MS, now);

      expect(scaled.isFatigueScaled).toBe(true);
      scaled.exercises.forEach((ex, i) => {
        const original = plan.exercises[i]!;
        expect(ex.scaledForFatigue).toBe(true);
        expect(ex.sets).toBe(Math.max(1, Math.round(original.sets * 0.7)));
      });
    });

    it("does not scale at exactly 48h and does not scale for first-time users", () => {
      const plan = day1();
      expect(
        applyRuntimeFatigueScaling(plan, START_MS, START_MS + FATIGUE_GAP_THRESHOLD_MS)
      ).toBe(plan);
      expect(applyRuntimeFatigueScaling(plan, null, START_MS + 500 * HOUR_MS)).toBe(plan);
    });

    it("is idempotent and never scales twice", () => {
      const now = START_MS + 72 * HOUR_MS;
      const once = applyRuntimeFatigueScaling(day1(), START_MS, now);
      const twice = applyRuntimeFatigueScaling(once, START_MS, now);
      expect(twice).toBe(once);
    });

    it("leaves already-completed exercises and completed plans untouched", () => {
      const plan = day1();
      const firstId = plan.exercises[0]!.id;
      const progressed = toggleExerciseInDailyPlan(plan, firstId);
      const now = START_MS + 72 * HOUR_MS;
      const scaled = applyRuntimeFatigueScaling(progressed, START_MS, now);

      const done = scaled.exercises.find((e) => e.id === firstId)!;
      expect(done.sets).toBe(plan.exercises[0]!.sets);
      expect(done.scaledForFatigue).not.toBe(true);

      const finished: DailyPlan = { ...plan, completed: true };
      expect(applyRuntimeFatigueScaling(finished, START_MS, now)).toBe(finished);
    });

    it("never drops sets below 1", () => {
      const plan = day1();
      const tiny: DailyPlan = {
        ...plan,
        exercises: plan.exercises.map((e) => ({ ...e, sets: 1 }))
      };
      const scaled = applyRuntimeFatigueScaling(tiny, START_MS, START_MS + 72 * HOUR_MS);
      scaled.exercises.forEach((e) => expect(e.sets).toBeGreaterThanOrEqual(1));
    });
  });

  describe("Probe 3: minimum completion gate before proof signing", () => {
    it("blocks an empty day", () => {
      expect(hasMinimumDailyProgress(day1())).toBe(false);
    });

    it("unlocks after one completed exercise", () => {
      const plan = day1();
      const next = toggleExerciseInDailyPlan(plan, plan.exercises[0]!.id);
      expect(hasMinimumDailyProgress(next)).toBe(true);
    });

    it("unlocks after logging nutrition without any exercise", () => {
      const next = addFoodPortionToDailyPlan(day1(), DUAL_TRACK_FOOD_PRESETS[0]!, 100);
      expect(hasMinimumDailyProgress(next)).toBe(true);
    });

    it("re-locks if the only completed exercise is unchecked", () => {
      const plan = day1();
      const id = plan.exercises[0]!.id;
      const on = toggleExerciseInDailyPlan(plan, id);
      const off = toggleExerciseInDailyPlan(on, id);
      expect(hasMinimumDailyProgress(off)).toBe(false);
    });
  });
});
