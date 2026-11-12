import {
  AdaptivePlanCycle,
  AdaptivePlanCycleSchema,
  DailyPlan,
  DailyPlanSchema,
  ProposedPlanReview,
  ProposedPlanReviewSchema
} from "@dehealth/shared";
import React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { createDefaultExercises } from "../services/adaptivePlanEngine";

export const BI_WEEKLY_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days in ms

/**
 * Determines whether a 14-day bi-weekly check-in / plan review is due.
 * Returns true if >= 14 days have elapsed since `cycleStartDateMs` OR
 * since `lastWeighInTimestampMs` (when provided).
 */
export function isBiWeeklyReviewDue(
  cycleStartDateMs: number,
  lastWeighInTimestampMs: number | null = null,
  currentTimestampMs: number = Date.now()
): boolean {
  if (currentTimestampMs - cycleStartDateMs >= BI_WEEKLY_DURATION_MS) {
    return true;
  }
  if (
    lastWeighInTimestampMs !== null &&
    currentTimestampMs - lastWeighInTimestampMs >= BI_WEEKLY_DURATION_MS
  ) {
    return true;
  }
  return false;
}

/**
 * Applies an approved `ProposedPlanReview` to generate the next 14-day `AdaptivePlanCycle`
 * with updated daily calorie and macronutrient targets.
 */
export function applyApprovedPlanReview(
  currentCycle: AdaptivePlanCycle,
  review: ProposedPlanReview,
  nextStartDateMs: number = Date.now()
): {
  readonly approvedReview: ProposedPlanReview;
  readonly completedPreviousCycle: AdaptivePlanCycle;
  readonly nextCycle: AdaptivePlanCycle;
} {
  const validatedReview = ProposedPlanReviewSchema.parse({
    ...review,
    status: "approved"
  });

  const completedPreviousCycle = AdaptivePlanCycleSchema.parse({
    ...currentCycle,
    status: "reviewed"
  });

  const nextCycleNumber = currentCycle.cycleNumber + 1;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const updatedBiometrics = {
    ...currentCycle.baselineBiometrics,
    weightKg: validatedReview.currentWeightKg,
    updatedAtMs: nextStartDateMs
  };

  const dailyPlans: DailyPlan[] = [];
  for (let day = 1; day <= 14; day += 1) {
    const dayDateMs = nextStartDateMs + (day - 1) * oneDayMs;
    const dateStr = new Date(dayDateMs).toISOString().split("T")[0]!;
    const exercises = createDefaultExercises(day, false);

    dailyPlans.push(
      DailyPlanSchema.parse({
        dayNumber: day,
        date: dateStr,
        targetCaloriesKcal: validatedReview.proposedDailyCalories,
        targetProteinGrams: validatedReview.proposedMacroSplit.proteinGrams,
        targetCarbsGrams: validatedReview.proposedMacroSplit.carbsGrams,
        targetFatGrams: validatedReview.proposedMacroSplit.fatGrams,
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

  const nextCycle = AdaptivePlanCycleSchema.parse({
    id: `cycle_${nextCycleNumber}_${nextStartDateMs}`,
    cycleNumber: nextCycleNumber,
    startDateMs: nextStartDateMs,
    endDateMs: nextStartDateMs + BI_WEEKLY_DURATION_MS,
    goal: currentCycle.goal,
    baselineBiometrics: updatedBiometrics,
    targetDailyCalories: validatedReview.proposedDailyCalories,
    targetDailyProteinGrams: validatedReview.proposedMacroSplit.proteinGrams,
    targetDailyCarbsGrams: validatedReview.proposedMacroSplit.carbsGrams,
    targetDailyFatGrams: validatedReview.proposedMacroSplit.fatGrams,
    dailyPlans,
    status: "active"
  });

  return {
    approvedReview: validatedReview,
    completedPreviousCycle,
    nextCycle
  };
}

/**
 * Marks a `ProposedPlanReview` as rejected ("Keep Current Plan") and starts a fresh
 * 14-day cycle preserving the current calorie and macronutrient targets.
 */
export function keepCurrentPlanOnReview(
  currentCycle: AdaptivePlanCycle,
  review: ProposedPlanReview
): {
  readonly rejectedReview: ProposedPlanReview;
  readonly preservedCycle: AdaptivePlanCycle;
} {
  const rejectedReview = ProposedPlanReviewSchema.parse({
    ...review,
    status: "rejected"
  });

  return {
    rejectedReview,
    preservedCycle: currentCycle
  };
}

export interface PlanReviewModalProps {
  readonly visible: boolean;
  readonly review: ProposedPlanReview | null;
  readonly onApproveNewPlan: (review: ProposedPlanReview) => void;
  readonly onKeepCurrentPlan: (review: ProposedPlanReview) => void;
  readonly onClose: () => void;
}

export const PlanReviewModal: React.FC<PlanReviewModalProps> = ({
  visible,
  review,
  onApproveNewPlan,
  onKeepCurrentPlan,
  onClose
}) => {
  if (!review) {
    return null;
  }

  const deltaSign = review.weightChangeKg > 0 ? "+" : "";
  const calSign = review.calorieAdjustment > 0 ? "+" : "";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.modalContainer}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.headerRow}>
              <View>
                <Text style={styles.badgeText}>14-DAY PHYSIOLOGY AUDIT</Text>
                <Text style={styles.title}>Bi-Weekly Plan Review</Text>
              </View>
              <Pressable style={styles.closeIconBtn} onPress={onClose}>
                <Text style={styles.closeIconText}>✕</Text>
              </Pressable>
            </View>

            {/* Telemetry & Weight Trend Summary */}
            <View style={styles.summaryRow}>
              <View style={styles.summaryStatBox}>
                <Text style={styles.summaryStatLabel}>Weight Delta</Text>
                <Text style={styles.summaryStatValue}>
                  {deltaSign}
                  {review.weightChangeKg.toFixed(2)} kg
                </Text>
                <Text style={styles.summaryStatSub}>
                  {review.startingWeightKg} → {review.currentWeightKg} kg
                </Text>
              </View>

              <View style={styles.summaryStatBox}>
                <Text style={styles.summaryStatLabel}>7d Rolling Avg</Text>
                <Text style={styles.summaryStatValue}>
                  {review.rollingAverageWeightKg.toFixed(1)} kg
                </Text>
                <Text style={styles.summaryStatSub}>Smoothed Trend</Text>
              </View>

              <View style={styles.summaryStatBox}>
                <Text style={styles.summaryStatLabel}>Adherence</Text>
                <Text style={styles.summaryStatValue}>
                  {Math.round(review.adherencePct)}%
                </Text>
                <Text style={styles.summaryStatSub}>14-Day Cycle</Text>
              </View>
            </View>

            {/* Side-by-Side Comparison: Current vs Proposed */}
            <Text style={styles.sectionLabel}>
              SIDE-BY-SIDE TARGET COMPARISON
            </Text>
            <View style={styles.comparisonGrid}>
              {/* Current Plan Column */}
              <View style={styles.comparisonColumn}>
                <Text style={styles.columnHeader}>Current Plan</Text>
                <Text style={styles.calorieBig}>
                  {review.currentDailyCalories} kcal
                </Text>
                <View style={styles.macroLine}>
                  <Text style={styles.macroName}>Protein</Text>
                  <Text style={styles.macroVal}>
                    {review.currentMacroSplit.proteinGrams}g
                  </Text>
                </View>
                <View style={styles.macroLine}>
                  <Text style={styles.macroName}>Carbs</Text>
                  <Text style={styles.macroVal}>
                    {review.currentMacroSplit.carbsGrams}g
                  </Text>
                </View>
                <View style={styles.macroLine}>
                  <Text style={styles.macroName}>Fat</Text>
                  <Text style={styles.macroVal}>
                    {review.currentMacroSplit.fatGrams}g
                  </Text>
                </View>
              </View>

              {/* Proposed Plan Column */}
              <View
                style={[styles.comparisonColumn, styles.comparisonColumnProposed]}
              >
                <Text style={styles.columnHeaderProposed}>
                  Proposed ({calSign}
                  {review.calorieAdjustment} kcal)
                </Text>
                <Text style={styles.calorieBigProposed}>
                  {review.proposedDailyCalories} kcal
                </Text>
                <View style={styles.macroLine}>
                  <Text style={styles.macroName}>Protein</Text>
                  <Text style={styles.macroValProposed}>
                    {review.proposedMacroSplit.proteinGrams}g
                  </Text>
                </View>
                <View style={styles.macroLine}>
                  <Text style={styles.macroName}>Carbs</Text>
                  <Text style={styles.macroValProposed}>
                    {review.proposedMacroSplit.carbsGrams}g
                  </Text>
                </View>
                <View style={styles.macroLine}>
                  <Text style={styles.macroName}>Fat</Text>
                  <Text style={styles.macroValProposed}>
                    {review.proposedMacroSplit.fatGrams}g
                  </Text>
                </View>
              </View>
            </View>

            {/* Deterministic Rationale Box */}
            <View style={styles.rationaleBox}>
              <Text style={styles.rationaleTitle}>
                ⚡ Deterministic Engine Rationale
              </Text>
              <Text style={styles.rationaleBody}>{review.rationale}</Text>
            </View>

            {/* User Approval Actions */}
            <View style={styles.actionRow}>
              <Pressable
                style={styles.approveButton}
                onPress={() => {
                  onApproveNewPlan(review);
                }}
              >
                <Text style={styles.approveButtonText}>
                  ✓ Approve New Plan
                </Text>
              </Pressable>

              <Pressable
                style={styles.keepButton}
                onPress={() => {
                  onKeepCurrentPlan(review);
                }}
              >
                <Text style={styles.keepButtonText}>Keep Current Plan</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.88)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16
  },
  modalContainer: {
    width: "100%",
    maxWidth: 400,
    maxHeight: "90%",
    backgroundColor: "#0F172A",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#334155",
    overflow: "hidden"
  },
  scrollContent: {
    padding: 18
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#38BDF8",
    letterSpacing: 0.8,
    marginBottom: 2
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  closeIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#1E293B",
    alignItems: "center",
    justifyContent: "center"
  },
  closeIconText: {
    fontSize: 14,
    color: "#94A3B8",
    fontWeight: "700"
  },
  summaryRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16
  },
  summaryStatBox: {
    flex: 1,
    backgroundColor: "#161F30",
    borderRadius: 12,
    padding: 10,
    alignItems: "center"
  },
  summaryStatLabel: {
    fontSize: 10,
    color: "#94A3B8",
    marginBottom: 2
  },
  summaryStatValue: {
    fontSize: 15,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  summaryStatSub: {
    fontSize: 10,
    color: "#64748B",
    marginTop: 2
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#94A3B8",
    letterSpacing: 0.5,
    marginBottom: 8
  },
  comparisonGrid: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14
  },
  comparisonColumn: {
    flex: 1,
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  comparisonColumnProposed: {
    borderColor: "#10B981",
    backgroundColor: "#052E16"
  },
  columnHeader: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94A3B8",
    marginBottom: 4
  },
  columnHeaderProposed: {
    fontSize: 11,
    fontWeight: "800",
    color: "#34D399",
    marginBottom: 4
  },
  calorieBig: {
    fontSize: 18,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 10
  },
  calorieBigProposed: {
    fontSize: 18,
    fontWeight: "800",
    color: "#10B981",
    marginBottom: 10
  },
  macroLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3
  },
  macroName: {
    fontSize: 12,
    color: "#94A3B8"
  },
  macroVal: {
    fontSize: 12,
    fontWeight: "700",
    color: "#E2E8F0"
  },
  macroValProposed: {
    fontSize: 12,
    fontWeight: "800",
    color: "#A7F3D0"
  },
  rationaleBox: {
    backgroundColor: "#161F30",
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: "#38BDF8"
  },
  rationaleTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: "#38BDF8",
    marginBottom: 4
  },
  rationaleBody: {
    fontSize: 12,
    color: "#E2E8F0",
    lineHeight: 18
  },
  actionRow: {
    gap: 8
  },
  approveButton: {
    backgroundColor: "#10B981",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center"
  },
  approveButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#052E16"
  },
  keepButton: {
    backgroundColor: "#1E293B",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#334155"
  },
  keepButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#CBD5E1"
  }
});

