import {
  Address,
  DEFAULT_BASELINE_BIOMETRICS,
  TelemetryDataSchema,
  WorkoutProof
} from "@dehealth/shared";
import { Wallet } from "ethers";
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
  applyApprovedPlanReview,
  BI_WEEKLY_DURATION_MS,
  isBiWeeklyReviewDue,
  keepCurrentPlanOnReview
} from "../components/PlanReviewModal";
import { validateWeightLogInput } from "../screens/DashboardScreen";
import {
  addFoodPortionToDailyPlan,
  buildDailyPlanTelemetry,
  DUAL_TRACK_FOOD_PRESETS,
  getWorkoutCompletionStats,
  toggleExerciseInDailyPlan
} from "../screens/MicroCheckInScreen";
import {
  evaluateBiWeeklyReview,
  generate14DayPlan
} from "../services/adaptivePlanEngine";
import {
  hashTelemetry,
  signWorkoutProof,
  verifyWorkoutProofSignature
} from "../services/cryptoService";

describe("Phase 2.0 Dual-Track Check-In & Bi-Weekly Plan Review Suite", () => {
  describe("Track 1: Nutrition & Quick Food Portion Calculator", () => {
    it("provides at least 7 sports nutrition food presets including Chicken Breast, Rice, Oats, Eggs, Yogurt, Veggies, and Whey", () => {
      expect(DUAL_TRACK_FOOD_PRESETS.length).toBeGreaterThanOrEqual(7);
      const names = DUAL_TRACK_FOOD_PRESETS.map((p) => p.name.toLowerCase());
      expect(names.some((n) => n.includes("chicken"))).toBe(true);
      expect(names.some((n) => n.includes("rice"))).toBe(true);
      expect(names.some((n) => n.includes("oats"))).toBe(true);
      expect(names.some((n) => n.includes("egg"))).toBe(true);
      expect(names.some((n) => n.includes("yogurt"))).toBe(true);
      expect(names.some((n) => n.includes("veggies"))).toBe(true);
      expect(names.some((n) => n.includes("whey"))).toBe(true);
    });

    it("deterministically accumulates calories and macros when logging food portions", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
      const day1 = cycle.dailyPlans[0]!;
      const chicken = DUAL_TRACK_FOOD_PRESETS.find(
        (p) => p.id === "preset_chicken_breast"
      )!;

      // 200g of Chicken Breast (2x 100g serving: 330 kcal, 62g P, 0g C, 7.2g F)
      const afterChicken = addFoodPortionToDailyPlan(day1, chicken, 200);
      expect(afterChicken.loggedCaloriesKcal).toBe(330);
      expect(afterChicken.loggedProteinGrams).toBe(62);
      expect(afterChicken.loggedCarbsGrams).toBe(0);
      expect(afterChicken.loggedFatGrams).toBe(7.2);

      const whiteRice = DUAL_TRACK_FOOD_PRESETS.find(
        (p) => p.id === "preset_white_rice"
      )!;
      // 150g of Steamed White Rice (1.5x 100g serving: 195 kcal, 4.1g P, 42g C, 0.4g F)
      const afterRice = addFoodPortionToDailyPlan(afterChicken, whiteRice, 150);
      expect(afterRice.loggedCaloriesKcal).toBe(525);
      expect(afterRice.loggedProteinGrams).toBe(66.1);
      expect(afterRice.loggedCarbsGrams).toBe(42);
      expect(afterRice.loggedFatGrams).toBe(7.6);
    });

    it("rejects zero, negative, or non-finite gram portion weights", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
      const day1 = cycle.dailyPlans[0]!;
      const chicken = DUAL_TRACK_FOOD_PRESETS[0]!;

      expect(() => addFoodPortionToDailyPlan(day1, chicken, 0)).toThrow();
      expect(() => addFoodPortionToDailyPlan(day1, chicken, -50)).toThrow();
      expect(() => addFoodPortionToDailyPlan(day1, chicken, Number.NaN)).toThrow();
    });
  });

  describe("Track 2: Scheduled Workout Checklist & Cryptographic Proof Gate", () => {
    it("toggles individual exercise completion and computes accurate completion stats", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
      let plan = addFoodPortionToDailyPlan(
        cycle.dailyPlans[0]!,
        DUAL_TRACK_FOOD_PRESETS[0]!,
        100
      );

      const initialStats = getWorkoutCompletionStats(plan.exercises);
      expect(initialStats.completedCount).toBe(0);
      expect(initialStats.allCompleted).toBe(false);

      for (const ex of plan.exercises) {
        plan = toggleExerciseInDailyPlan(plan, ex.id);
      }

      const finalStats = getWorkoutCompletionStats(plan.exercises);
      expect(finalStats.completedCount).toBe(plan.exercises.length);
      expect(finalStats.completionPct).toBe(100);
      expect(finalStats.allCompleted).toBe(true);
      expect(plan.completed).toBe(true);
    });

    it("synthesizes valid TelemetryData from DailyPlan and signs verifiable EIP-712 proof", async () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
      let plan = addFoodPortionToDailyPlan(
        cycle.dailyPlans[0]!,
        DUAL_TRACK_FOOD_PRESETS[0]!,
        200
      );
      plan = toggleExerciseInDailyPlan(plan, plan.exercises[0]!.id);
      plan = toggleExerciseInDailyPlan(plan, plan.exercises[1]!.id);

      const telemetry = buildDailyPlanTelemetry(
        plan,
        {
          age: 28,
          gender: "male",
          bodyFatPct: 18.5,
          muscleMassKg: 35.0
        },
        1_700_000_500_000
      );

      expect(() => TelemetryDataSchema.parse(telemetry)).not.toThrow();
      const digest = hashTelemetry(telemetry);
      expect(digest).toMatch(/^0x[a-f0-9]{64}$/);

      const wallet = Wallet.createRandom();
      const verifyingContract =
        "0x1111111111111111111111111111111111111111" as Address;
      const proof: WorkoutProof = {
        user: wallet.address as Address,
        telemetryHash: digest,
        streakCount: 4n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      const signed = await signWorkoutProof(wallet, proof, verifyingContract);
      expect(verifyWorkoutProofSignature(signed, verifyingContract)).toBe(true);
    });
  });

  describe("Dashboard Weigh-In & Bi-Weekly Plan Review Flow", () => {
    it("validates weight log inputs and rejects out-of-range biometrics", () => {
      const valid = validateWeightLogInput("69.4", "17.8", "Morning check-in", 1_700_000_000_000);
      expect(valid.isValid).toBe(true);
      expect(valid.entry?.weightKg).toBe(69.4);
      expect(valid.entry?.bodyFatPct).toBe(17.8);

      const invalidWeight = validateWeightLogInput("15", "18.0");
      expect(invalidWeight.isValid).toBe(false);
      expect(invalidWeight.error).toContain("Weight");

      const invalidBf = validateWeightLogInput("70.0", "90.0");
      expect(invalidBf.isValid).toBe(false);
      expect(invalidBf.error).toContain("Body fat");
    });

    it("detects when 14-day bi-weekly check-in is due", () => {
      const startMs = 1_700_000_000_000;
      expect(
        isBiWeeklyReviewDue(startMs, startMs + 2 * 86_400_000, startMs + 13 * 86_400_000)
      ).toBe(false);

      expect(
        isBiWeeklyReviewDue(startMs, null, startMs + BI_WEEKLY_DURATION_MS)
      ).toBe(true);
    });

    it("applies approved bi-weekly review to create Cycle #2 and supports keeping current plan", () => {
      const startMs = 1_700_000_000_000;
      const cycle1 = generate14DayPlan(
        { ...DEFAULT_BASELINE_BIOMETRICS, goal: "fat_loss" },
        startMs
      );

      // Stalled weight loss over 14 days with 92% adherence -> proposes -100 kcal adjustment
      const weightLogs = [
        { id: "w1", timestampMs: startMs, weightKg: 70.0 },
        { id: "w2", timestampMs: startMs + 7 * 86_400_000, weightKg: 70.0 },
        { id: "w3", timestampMs: startMs + 14 * 86_400_000, weightKg: 69.95 }
      ];

      const review = evaluateBiWeeklyReview(
        cycle1,
        weightLogs,
        92,
        startMs + BI_WEEKLY_DURATION_MS
      );
      expect(review.proposedDailyCalories).toBe(cycle1.targetDailyCalories - 100);

      const { approvedReview, completedPreviousCycle, nextCycle } =
        applyApprovedPlanReview(cycle1, review, startMs + BI_WEEKLY_DURATION_MS);

      expect(approvedReview.status).toBe("approved");
      expect(completedPreviousCycle.status).toBe("reviewed");
      expect(nextCycle.cycleNumber).toBe(2);
      expect(nextCycle.targetDailyCalories).toBe(review.proposedDailyCalories);
      expect(nextCycle.dailyPlans).toHaveLength(14);

      const { rejectedReview, preservedCycle } = keepCurrentPlanOnReview(cycle1, review);
      expect(rejectedReview.status).toBe("rejected");
      expect(preservedCycle.targetDailyCalories).toBe(cycle1.targetDailyCalories);
    });
  });
});
