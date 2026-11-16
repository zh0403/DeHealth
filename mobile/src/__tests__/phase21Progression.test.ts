import {
  AdaptivePlanCycle,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  WeightLogEntry
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
  applyApprovedPlanReview,
  isBiWeeklyReviewDue,
  keepCurrentPlanOnReview
} from "../components/PlanReviewModal";
import {
  appendCycleToHistory,
  calculateAdherencePct,
  CYCLE_LENGTH_DAYS,
  evaluateBiWeeklyReview,
  generate14DayPlan,
  getActiveDayIndex,
  MS_PER_DAY
} from "../services/adaptivePlanEngine";
import { AdaptiveStorage } from "../storage/adaptiveStorage";
import { KeyValueStorageBackend } from "../storage/encryptedStorageAdapter";

const START_MS = Date.UTC(2026, 10, 1, 8, 0, 0);

class MemoryBackend implements KeyValueStorageBackend {
  private readonly items = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.items.delete(key);
  }
}

function cycleWithCompletedDays(completedDayNumbers: readonly number[]): AdaptivePlanCycle {
  const base = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, START_MS);
  const plans: DailyPlan[] = base.dailyPlans.map((plan) => ({
    ...plan,
    completed: completedDayNumbers.includes(plan.dayNumber)
  }));
  return { ...base, dailyPlans: plans };
}

describe("Phase 2.1 progression, adherence and archiving", () => {
  describe("LOG-01: dynamic day index", () => {
    it("starts on day index 0 at cycle start", () => {
      expect(getActiveDayIndex(START_MS, START_MS)).toBe(0);
    });

    it("stays on index 0 until a full 24h has elapsed, then advances", () => {
      expect(getActiveDayIndex(START_MS, START_MS + MS_PER_DAY - 1)).toBe(0);
      expect(getActiveDayIndex(START_MS, START_MS + MS_PER_DAY)).toBe(1);
      expect(getActiveDayIndex(START_MS, START_MS + 5 * MS_PER_DAY + 3_600_000)).toBe(5);
    });

    it("clamps to the final day (13) once the cycle is over", () => {
      expect(getActiveDayIndex(START_MS, START_MS + 13 * MS_PER_DAY)).toBe(13);
      expect(getActiveDayIndex(START_MS, START_MS + 14 * MS_PER_DAY)).toBe(13);
      expect(getActiveDayIndex(START_MS, START_MS + 400 * MS_PER_DAY)).toBe(
        CYCLE_LENGTH_DAYS - 1
      );
    });

    it("clamps to 0 when the clock is before the start date", () => {
      expect(getActiveDayIndex(START_MS, START_MS - 3 * MS_PER_DAY)).toBe(0);
    });

    it("matches the specified formula for every elapsed-day count", () => {
      for (let hours = 0; hours <= 24 * 20; hours += 5) {
        const now = START_MS + hours * 3_600_000;
        const spec = Math.min(13, Math.max(0, Math.floor((now - START_MS) / 86_400_000)));
        expect(getActiveDayIndex(START_MS, now)).toBe(spec);
      }
    });

    it("selects the matching DailyPlan from the cycle", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, START_MS);
      const idx = getActiveDayIndex(cycle.startDateMs, START_MS + 6 * MS_PER_DAY + 1000);
      expect(cycle.dailyPlans[idx]!.dayNumber).toBe(7);
    });
  });

  describe("LOG-02: real adherence", () => {
    it("is 0% on day one with nothing completed (never a fabricated 88)", () => {
      const cycle = cycleWithCompletedDays([]);
      expect(calculateAdherencePct(cycle, START_MS)).toBe(0);
    });

    it("is 100% when every elapsed day (including today) is completed", () => {
      const cycle = cycleWithCompletedDays([1, 2, 3]);
      expect(calculateAdherencePct(cycle, START_MS + 2 * MS_PER_DAY)).toBe(100);
    });

    it("divides completed days by elapsed days", () => {
      const cycle = cycleWithCompletedDays([1, 2, 4]);
      // Elapsed through day 5 (index 4): 3 of 5 completed.
      expect(calculateAdherencePct(cycle, START_MS + 4 * MS_PER_DAY)).toBe(60);
    });

    it("ignores completed flags on days that have not happened yet", () => {
      const cycle = cycleWithCompletedDays([1, 9, 10, 11]);
      expect(calculateAdherencePct(cycle, START_MS + 1 * MS_PER_DAY)).toBe(50);
    });

    it("uses all 14 days once the cycle has finished, however stale", () => {
      const cycle = cycleWithCompletedDays([1, 2, 3, 4, 5, 6, 7]);
      expect(calculateAdherencePct(cycle, START_MS + 90 * MS_PER_DAY)).toBe(50);
    });

    it("rounds to one decimal place", () => {
      const cycle = cycleWithCompletedDays([1, 2]);
      // 2 of 3 elapsed.
      expect(calculateAdherencePct(cycle, START_MS + 2 * MS_PER_DAY)).toBe(66.7);
    });

    it("drives the review: low real adherence holds targets, high real adherence adjusts", () => {
      const goalCycle = (done: readonly number[]): AdaptivePlanCycle => ({
        ...cycleWithCompletedDays(done),
        goal: "cut"
      });
      const flat: WeightLogEntry[] = [
        { id: "a", timestampMs: START_MS, weightKg: 80 },
        { id: "b", timestampMs: START_MS + 13 * MS_PER_DAY, weightKg: 80 }
      ];
      const end = START_MS + 13 * MS_PER_DAY;

      const lowCycle = goalCycle([1, 2, 3]);
      const low = evaluateBiWeeklyReview(lowCycle, flat, calculateAdherencePct(lowCycle, end), end);
      expect(low.calorieAdjustment).toBe(0);
      expect(low.rationale).toContain("below the 80% threshold");

      const highCycle = goalCycle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
      const high = evaluateBiWeeklyReview(
        highCycle,
        flat,
        calculateAdherencePct(highCycle, end),
        end
      );
      expect(high.calorieAdjustment).toBe(-100);
    });
  });

  describe("INFO-01: plan history archiving", () => {
    it("appends a finished cycle", () => {
      const first = cycleWithCompletedDays([]);
      expect(appendCycleToHistory([], first)).toEqual([first]);
    });

    it("is idempotent: re-archiving the same cycle id replaces, never duplicates", () => {
      const first = cycleWithCompletedDays([]);
      const edited: AdaptivePlanCycle = { ...first, status: "reviewed" };
      const once = appendCycleToHistory([], first);
      const twice = appendCycleToHistory(once, edited);
      expect(twice).toHaveLength(1);
      expect(twice[0]!.status).toBe("reviewed");
    });

    it("does not mutate the input history", () => {
      const first = cycleWithCompletedDays([]);
      const history = [first];
      appendCycleToHistory(history, { ...first, id: "other" });
      expect(history).toHaveLength(1);
    });

    it("archives an approved cycle into encrypted storage and survives a reload", async () => {
      const backend = new MemoryBackend();
      const storage = new AdaptiveStorage("ArchiveTestSecret-0123456789", backend);

      const cycle1 = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, START_MS);
      const logs: WeightLogEntry[] = [
        { id: "a", timestampMs: START_MS, weightKg: 70 },
        { id: "b", timestampMs: START_MS + 13 * MS_PER_DAY, weightKg: 70 }
      ];
      const review = evaluateBiWeeklyReview(cycle1, logs, 90, START_MS + 14 * MS_PER_DAY);
      const { completedPreviousCycle, nextCycle } = applyApprovedPlanReview(
        cycle1,
        review,
        START_MS + 14 * MS_PER_DAY
      );

      await storage.savePlanHistory(
        appendCycleToHistory(await storage.getPlanHistory(), completedPreviousCycle)
      );
      // A repeated approval callback must not duplicate the archive entry.
      await storage.savePlanHistory(
        appendCycleToHistory(await storage.getPlanHistory(), completedPreviousCycle)
      );

      const reloaded = new AdaptiveStorage("ArchiveTestSecret-0123456789", backend);
      const history = await reloaded.getPlanHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.id).toBe(cycle1.id);
      expect(history[0]!.status).toBe("reviewed");
      expect(nextCycle.cycleNumber).toBe(2);
    });
  });

  describe("Keep Current Plan starts a fresh cycle with held targets", () => {
    const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, START_MS);
    const logs: WeightLogEntry[] = [
      { id: "a", timestampMs: START_MS, weightKg: 70 },
      { id: "b", timestampMs: START_MS + 13 * MS_PER_DAY, weightKg: 69.4 }
    ];
    const review = evaluateBiWeeklyReview(cycle, logs, 95, START_MS + 14 * MS_PER_DAY);
    const nextStart = START_MS + 14 * MS_PER_DAY;

    it("rejects the review and closes the old cycle as completed", () => {
      const result = keepCurrentPlanOnReview(cycle, review, nextStart);
      expect(result.rejectedReview.status).toBe("rejected");
      expect(result.completedPreviousCycle.status).toBe("completed");
      expect(result.completedPreviousCycle.id).toBe(cycle.id);
    });

    it("starts the next numbered cycle on the new start date", () => {
      const { preservedCycle } = keepCurrentPlanOnReview(cycle, review, nextStart);
      expect(preservedCycle.cycleNumber).toBe(cycle.cycleNumber + 1);
      expect(preservedCycle.startDateMs).toBe(nextStart);
      expect(preservedCycle.status).toBe("active");
      expect(preservedCycle.dailyPlans).toHaveLength(14);
      expect(preservedCycle.dailyPlans.every((p) => !p.completed)).toBe(true);
    });

    it("holds calorie and macro targets even when the review proposed a change", () => {
      const changing = { ...review, proposedDailyCalories: review.currentDailyCalories + 200 };
      const { preservedCycle } = keepCurrentPlanOnReview(cycle, changing, nextStart);
      expect(preservedCycle.targetDailyCalories).toBe(cycle.targetDailyCalories);
      expect(preservedCycle.targetDailyProteinGrams).toBe(cycle.targetDailyProteinGrams);
      expect(preservedCycle.targetDailyCarbsGrams).toBe(cycle.targetDailyCarbsGrams);
      expect(preservedCycle.targetDailyFatGrams).toBe(cycle.targetDailyFatGrams);
      for (const day of preservedCycle.dailyPlans) {
        expect(day.targetCaloriesKcal).toBe(cycle.targetDailyCalories);
      }
    });

    it("clears the review-due banner, which stayed on forever before this fix", () => {
      expect(isBiWeeklyReviewDue(cycle.startDateMs, null, nextStart)).toBe(true);
      const { preservedCycle } = keepCurrentPlanOnReview(cycle, review, nextStart);
      expect(isBiWeeklyReviewDue(preservedCycle.startDateMs, null, nextStart)).toBe(false);
      expect(isBiWeeklyReviewDue(preservedCycle.startDateMs, null, nextStart + 14 * MS_PER_DAY)).toBe(true);
    });
  });
});
