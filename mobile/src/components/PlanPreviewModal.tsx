import { AdaptivePlanCycle, UserBiometrics } from "@dehealth/shared";
import React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";

export interface WeeklySplitDaySummary {
  readonly dayNumber: number;
  readonly dayLabel: string;
  readonly date: string;
  readonly focusTitle: string;
  readonly exerciseCount: number;
  readonly exerciseSummary: string;
}

/**
 * Builds a concise 7-day workout split overview from the first week of a
 * generated 14-day `AdaptivePlanCycle`.
 */
export function buildWeeklyWorkoutSplit(
  plan: AdaptivePlanCycle
): readonly WeeklySplitDaySummary[] {
  return plan.dailyPlans.slice(0, 7).map((day) => {
    const seenCategories = new Set<string>();
    const exerciseNames: string[] = [];

    for (const exercise of day.exercises) {
      const category = exercise.category.trim();
      if (category.length > 0) {
        seenCategories.add(category);
      }
      const name = exercise.name.trim();
      if (name.length > 0) {
        exerciseNames.push(name);
      }
    }

    const focusTitle =
      seenCategories.size > 0
        ? Array.from(seenCategories).join(", ")
        : "Rest & Recovery";

    let exerciseSummary = "Active recovery & mobility";
    if (exerciseNames.length > 0 && exerciseNames.length <= 2) {
      exerciseSummary = exerciseNames.join(", ");
    } else if (exerciseNames.length > 2) {
      exerciseSummary = `${exerciseNames.slice(0, 2).join(", ")} (+${exerciseNames.length - 2} more)`;
    }

    return {
      dayNumber: day.dayNumber,
      dayLabel: `Day ${day.dayNumber}`,
      date: day.date,
      focusTitle,
      exerciseCount: day.exercises.length,
      exerciseSummary
    };
  });
}

export interface PlanPreviewModalProps {
  readonly visible: boolean;
  readonly biometrics: UserBiometrics | null;
  readonly plan: AdaptivePlanCycle | null;
  readonly isApproving?: boolean;
  readonly errorMessage?: string | null;
  readonly onApproveAndStart: (
    biometrics: UserBiometrics,
    plan: AdaptivePlanCycle
  ) => void | Promise<void>;
  readonly onAdjustGoals: () => void;
}

export const PlanPreviewModal: React.FC<PlanPreviewModalProps> = ({
  visible,
  biometrics,
  plan,
  isApproving = false,
  errorMessage = null,
  onApproveAndStart,
  onAdjustGoals
}) => {
  if (!visible || !biometrics || !plan) {
    return null;
  }

  const weeklySplit = buildWeeklyWorkoutSplit(plan);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onAdjustGoals}
    >
      <View style={styles.backdrop}>
        <View style={styles.modalContainer}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Text style={styles.badgeText}>
              INITIAL 14-DAY BLUEPRINT PREVIEW
            </Text>
            <Text style={styles.title}>Your Adaptive Plan Preview</Text>

            <View style={styles.biometricsPill}>
              <Text style={styles.biometricsPillText}>
                Goal: {biometrics.goal} • {biometrics.age} yrs •{" "}
                {biometrics.weightKg} kg • {biometrics.weeklyWorkoutFrequency}{" "}
                d/wk
              </Text>
            </View>

            {/* Calculated Daily Calorie Target */}
            <View style={styles.calorieCard}>
              <Text style={styles.sectionLabel}>Daily Calorie Target</Text>
              <Text style={styles.calorieValue}>
                {plan.targetDailyCalories} kcal/day
              </Text>
            </View>

            {/* Calculated Daily Macronutrient Targets */}
            <View style={styles.macrosCard}>
              <Text style={styles.sectionLabel}>
                Daily Macronutrient Targets
              </Text>
              <View style={styles.macrosRow}>
                <View style={styles.macroBox}>
                  <Text style={styles.macroLabel}>Protein</Text>
                  <Text style={styles.macroValue}>
                    {plan.targetDailyProteinGrams}g
                  </Text>
                </View>
                <View style={styles.macroBox}>
                  <Text style={styles.macroLabel}>Carbs</Text>
                  <Text style={styles.macroValue}>
                    {plan.targetDailyCarbsGrams}g
                  </Text>
                </View>
                <View style={styles.macroBox}>
                  <Text style={styles.macroLabel}>Fat</Text>
                  <Text style={styles.macroValue}>
                    {plan.targetDailyFatGrams}g
                  </Text>
                </View>
              </View>
            </View>

            {/* Weekly Workout Split (Days 1-7) */}
            <View style={styles.splitSection}>
              <Text style={styles.sectionLabel}>
                Weekly Workout Split (Days 1–7)
              </Text>
              {weeklySplit.map((day) => (
                <View key={day.dayNumber} style={styles.splitRow}>
                  <View style={styles.splitTopLine}>
                    <Text style={styles.splitDayLabel}>{day.dayLabel}</Text>
                    <Text style={styles.splitFocusTitle}>{day.focusTitle}</Text>
                    <Text style={styles.splitCountBadge}>
                      {day.exerciseCount}{" "}
                      {day.exerciseCount === 1 ? "exercise" : "exercises"}
                    </Text>
                  </View>
                  <Text style={styles.splitExercises}>
                    {day.exerciseSummary}
                  </Text>
                </View>
              ))}
            </View>

            {errorMessage ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            ) : null}

            {/* Explicit Approval Actions */}
            <View style={styles.actionRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Approve & Start Plan"
                accessibilityState={{ disabled: isApproving }}
                testID="approve-start-plan-button"
                disabled={isApproving}
                style={({ pressed }) => [
                  styles.approveButton,
                  isApproving ? styles.buttonDisabled : null,
                  pressed ? styles.buttonPressed : null
                ]}
                onPress={() => {
                  void onApproveAndStart(biometrics, plan);
                }}
              >
                <Text style={styles.approveButtonText}>
                  {isApproving ? "Starting Plan..." : "Approve & Start Plan"}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Adjust Goals"
                accessibilityState={{ disabled: isApproving }}
                testID="adjust-goals-button"
                disabled={isApproving}
                style={({ pressed }) => [
                  styles.adjustButton,
                  isApproving ? styles.buttonDisabled : null,
                  pressed ? styles.buttonPressed : null
                ]}
                onPress={onAdjustGoals}
              >
                <Text style={styles.adjustButtonText}>Adjust Goals</Text>
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
    maxWidth: 420,
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
  badgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#38BDF8",
    letterSpacing: 0.8,
    marginBottom: 4
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 10
  },
  biometricsPill: {
    backgroundColor: "rgba(56, 189, 248, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.35)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 14,
    alignSelf: "flex-start"
  },
  biometricsPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8"
  },
  calorieCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#94A3B8",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 6
  },
  calorieValue: {
    fontSize: 22,
    fontWeight: "800",
    color: "#38BDF8"
  },
  macrosCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  macrosRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4
  },
  macroBox: {
    flex: 1,
    backgroundColor: "#0F172A",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  macroLabel: {
    fontSize: 11,
    color: "#94A3B8",
    marginBottom: 2
  },
  macroValue: {
    fontSize: 15,
    fontWeight: "800",
    color: "#10B981"
  },
  splitSection: {
    marginBottom: 16
  },
  splitRow: {
    backgroundColor: "#161F30",
    borderRadius: 12,
    padding: 11,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  splitTopLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 4
  },
  splitDayLabel: {
    fontSize: 12,
    fontWeight: "800",
    color: "#38BDF8"
  },
  splitFocusTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  splitCountBadge: {
    fontSize: 10,
    fontWeight: "700",
    color: "#94A3B8"
  },
  splitExercises: {
    fontSize: 11,
    color: "#CBD5E1"
  },
  errorBanner: {
    backgroundColor: "rgba(244, 63, 94, 0.15)",
    borderColor: "#F43F5E",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12
  },
  errorText: {
    color: "#F87171",
    fontSize: 12,
    fontWeight: "600"
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
  adjustButton: {
    backgroundColor: "#1E293B",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#334155"
  },
  adjustButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#CBD5E1"
  },
  buttonDisabled: {
    opacity: 0.55
  },
  buttonPressed: {
    opacity: 0.78
  }
});
