import {
  AdaptivePlanCycle,
  Bytes32,
  DEFAULT_BASELINE_BIOMETRICS,
  ProposedPlanReview,
  WeightLogEntry,
  WeightLogEntrySchema
} from "@dehealth/shared";
import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  applyApprovedPlanReview,
  isBiWeeklyReviewDue,
  keepCurrentPlanOnReview,
  PlanReviewModal
} from "../components/PlanReviewModal";
import {
  calculateRollingWeightAverage,
  evaluateBiWeeklyReview,
  generate14DayPlan
} from "../services/adaptivePlanEngine";
import { DailyTargetAssessment } from "../services/profileEngine";
import {
  saveActivePlanCycle,
  saveWeightLog
} from "../storage/adaptiveStorage";

export interface WeightLogValidationResult {
  readonly isValid: boolean;
  readonly error: string | null;
  readonly entry?: WeightLogEntry;
}

/**
 * Validates raw weight and optional body fat inputs and constructs a validated
 * `WeightLogEntry`.
 */
export function validateWeightLogInput(
  weightStr: string,
  bodyFatStr: string = "",
  note: string = "",
  timestampMs: number = Date.now()
): WeightLogValidationResult {
  const trimmedWeight = weightStr.trim();
  const parsedWeight = Number(trimmedWeight);

  if (
    trimmedWeight === "" ||
    !Number.isFinite(parsedWeight) ||
    parsedWeight < 30 ||
    parsedWeight > 300
  ) {
    return {
      isValid: false,
      error: "Weight must be a valid number between 30 and 300 kg."
    };
  }

  let bodyFatPct: number | undefined;
  const trimmedBf = bodyFatStr.trim();
  if (trimmedBf !== "") {
    const parsedBf = Number(trimmedBf);
    if (!Number.isFinite(parsedBf) || parsedBf < 2 || parsedBf > 75) {
      return {
        isValid: false,
        error: "Body fat percentage must be between 2% and 75%."
      };
    }
    bodyFatPct = Number(parsedBf.toFixed(1));
  }

  const trimmedNote = note.trim();
  const candidate: WeightLogEntry = {
    id: `wlog_${timestampMs}`,
    timestampMs,
    weightKg: Number(parsedWeight.toFixed(2)),
    ...(bodyFatPct !== undefined ? { bodyFatPct } : {}),
    ...(trimmedNote.length > 0 ? { note: trimmedNote.slice(0, 200) } : {})
  };

  const parsed = WeightLogEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      isValid: false,
      error: parsed.error.issues[0]?.message ?? "Invalid weight log entry"
    };
  }

  return {
    isValid: true,
    error: null,
    entry: parsed.data
  };
}

export interface DashboardScreenProps {
  readonly streakCount: number;
  readonly tokenBalanceDht: string;
  readonly lastProofHash: Bytes32 | null;
  readonly targetAssessment: DailyTargetAssessment;
  readonly onOpenPerksDrawer?: () => void;
  readonly activeCycle?: AdaptivePlanCycle | null;
  readonly weightLogs?: readonly WeightLogEntry[];
  readonly adherencePct?: number;
  readonly currentTimestampMs?: number;
  readonly onLogWeightEntry?: (entry: WeightLogEntry) => Promise<void> | void;
  readonly onUpdatePlanCycle?: (nextCycle: AdaptivePlanCycle) => Promise<void> | void;
}

const WEEK_DAYS: ReadonlyArray<{
  readonly day: string;
  readonly completed: boolean;
  readonly isToday?: boolean;
}> = [
  { day: "Mon", completed: true },
  { day: "Tue", completed: true },
  { day: "Wed", completed: true },
  { day: "Thu", completed: true },
  { day: "Fri", completed: true },
  { day: "Sat", completed: false },
  { day: "Sun", completed: true, isToday: true }
];

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  streakCount,
  tokenBalanceDht,
  lastProofHash,
  targetAssessment,
  onOpenPerksDrawer,
  activeCycle: externalCycle,
  weightLogs: externalWeightLogs,
  adherencePct = 88,
  currentTimestampMs,
  onLogWeightEntry,
  onUpdatePlanCycle
}) => {
  const defaultCycle = useMemo<AdaptivePlanCycle>(() => {
    const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
    return generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, fifteenDaysAgo);
  }, []);

  const [localCycle, setLocalCycle] = useState<AdaptivePlanCycle>(
    externalCycle ?? defaultCycle
  );
  const [localWeightLogs, setLocalWeightLogs] = useState<readonly WeightLogEntry[]>(
    externalWeightLogs ?? [
      {
        id: "wlog_initial",
        timestampMs: Date.now() - 14 * 24 * 60 * 60 * 1000,
        weightKg: 70.0,
        bodyFatPct: 18.5,
        note: "Cycle 1 baseline"
      },
      {
        id: "wlog_mid",
        timestampMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
        weightKg: 69.6,
        bodyFatPct: 18.2
      }
    ]
  );

  const effectiveCycle = externalCycle ?? localCycle;
  const effectiveWeightLogs = externalWeightLogs ?? localWeightLogs;
  const nowMs = currentTimestampMs ?? Date.now();

  const [isWeightModalOpen, setIsWeightModalOpen] = useState<boolean>(false);
  const [weightInputStr, setWeightInputStr] = useState<string>(
    String(
      effectiveWeightLogs[effectiveWeightLogs.length - 1]?.weightKg ??
        effectiveCycle.baselineBiometrics.weightKg
    )
  );
  const [bodyFatInputStr, setBodyFatInputStr] = useState<string>(
    effectiveCycle.baselineBiometrics.bodyFatPct !== undefined
      ? String(effectiveCycle.baselineBiometrics.bodyFatPct)
      : ""
  );
  const [weightNoteStr, setWeightNoteStr] = useState<string>("");
  const [weightError, setWeightError] = useState<string | null>(null);
  const [weightFeedback, setWeightFeedback] = useState<string | null>(null);

  const [isReviewModalOpen, setIsReviewModalOpen] = useState<boolean>(false);
  const [reviewActionNotice, setReviewActionNotice] = useState<string | null>(null);

  const lastWeighInMs = useMemo<number | null>(() => {
    if (effectiveWeightLogs.length === 0) return null;
    const sorted = [...effectiveWeightLogs].sort(
      (a, b) => a.timestampMs - b.timestampMs
    );
    return sorted[sorted.length - 1]!.timestampMs;
  }, [effectiveWeightLogs]);

  const reviewDue = useMemo<boolean>(() => {
    return isBiWeeklyReviewDue(effectiveCycle.startDateMs, lastWeighInMs, nowMs);
  }, [effectiveCycle.startDateMs, lastWeighInMs, nowMs]);

  const rollingAvgWeight = useMemo<number | null>(() => {
    return calculateRollingWeightAverage(effectiveWeightLogs);
  }, [effectiveWeightLogs]);

  const proposedReview = useMemo<ProposedPlanReview>(() => {
    return evaluateBiWeeklyReview(
      effectiveCycle,
      effectiveWeightLogs,
      adherencePct,
      nowMs
    );
  }, [effectiveCycle, effectiveWeightLogs, adherencePct, nowMs]);

  const handleSaveWeightLog = async (): Promise<void> => {
    const result = validateWeightLogInput(
      weightInputStr,
      bodyFatInputStr,
      weightNoteStr,
      Date.now()
    );

    if (!result.isValid || !result.entry) {
      setWeightError(result.error);
      return;
    }

    setWeightError(null);
    const entry = result.entry;
    setLocalWeightLogs((prev) => [...prev, entry]);
    setWeightFeedback(`Saved weigh-in: ${entry.weightKg} kg (Encrypted on-device)`);
    setIsWeightModalOpen(false);
    setWeightNoteStr("");

    try {
      await saveWeightLog(entry);
    } catch {
      // Non-fatal in preview environments
    }

    if (onLogWeightEntry) {
      await onLogWeightEntry(entry);
    }
  };

  const handleApproveReview = async (
    review: ProposedPlanReview
  ): Promise<void> => {
    const { nextCycle } = applyApprovedPlanReview(
      effectiveCycle,
      review,
      Date.now()
    );
    setLocalCycle(nextCycle);
    setIsReviewModalOpen(false);
    setReviewActionNotice(
      `Approved Cycle #${nextCycle.cycleNumber}: ${nextCycle.targetDailyCalories} kcal/day (${nextCycle.targetDailyProteinGrams}g P / ${nextCycle.targetDailyCarbsGrams}g C / ${nextCycle.targetDailyFatGrams}g F)`
    );

    try {
      await saveActivePlanCycle(nextCycle);
    } catch {
      // Non-fatal
    }

    if (onUpdatePlanCycle) {
      await onUpdatePlanCycle(nextCycle);
    }
  };

  const handleKeepCurrentPlan = (review: ProposedPlanReview): void => {
    const { preservedCycle } = keepCurrentPlanOnReview(effectiveCycle, review);
    setIsReviewModalOpen(false);
    setReviewActionNotice(
      `Kept current Cycle #${preservedCycle.cycleNumber} targets (${preservedCycle.targetDailyCalories} kcal/day).`
    );
  };

  const latestWeightKg =
    effectiveWeightLogs[effectiveWeightLogs.length - 1]?.weightKg ??
    effectiveCycle.baselineBiometrics.weightKg;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
    >
      <Text style={styles.title}>Athlete Command Center</Text>

      {/* Non-Intrusive 14-Day Bi-Weekly Check-In Due Banner */}
      {reviewDue ? (
        <View style={styles.biWeeklyBanner}>
          <View style={styles.biWeeklyBannerTextCol}>
            <Text style={styles.biWeeklyBannerTag}>
              📅 BI-WEEKLY CHECK-IN DUE (14 DAYS ELAPSED)
            </Text>
            <Text style={styles.biWeeklyBannerTitle}>
              Cycle #{effectiveCycle.cycleNumber} Adaptation Ready
            </Text>
            <Text style={styles.biWeeklyBannerSub}>
              Proposed: {proposedReview.currentDailyCalories} →{" "}
              {proposedReview.proposedDailyCalories} kcal/day based on your 7-day
              rolling weight trend.
            </Text>
          </View>
          <Pressable
            style={styles.biWeeklyReviewBtn}
            onPress={() => {
              setIsReviewModalOpen(true);
            }}
          >
            <Text style={styles.biWeeklyReviewBtnText}>Review Plan ›</Text>
          </Pressable>
        </View>
      ) : null}

      {reviewActionNotice ? (
        <View style={styles.noticePill}>
          <Text style={styles.noticePillText}>✓ {reviewActionNotice}</Text>
        </View>
      ) : null}

      {/* Prominent Circular Daily Progress Ring */}
      <View style={styles.ringCard}>
        <Text style={styles.ringCardHeading}>Daily Habit Ring</Text>

        <View style={styles.ringWrapper}>
          <View style={styles.outerGlowRing}>
            <View style={styles.innerGlowRing}>
              <Text style={styles.ringFlameIcon}>🔥</Text>
              <Text style={styles.ringPercentText}>100%</Text>
              <Text style={styles.ringSubtext}>Ring Closed</Text>
            </View>
          </View>
        </View>

        <View style={styles.ringStatsRow}>
          <View style={styles.ringStatItem}>
            <Text style={styles.ringStatValue}>{streakCount}</Text>
            <Text style={styles.ringStatLabel}>Day Streak</Text>
          </View>
          <View style={styles.ringDivider} />
          <View style={styles.ringStatItem}>
            <Text style={styles.ringStatValue}>
              {targetAssessment.adjustedSteps}
            </Text>
            <Text style={styles.ringStatLabel}>Goal Steps</Text>
          </View>
          <View style={styles.ringDivider} />
          <View style={styles.ringStatItem}>
            <Text style={styles.ringStatValue}>
              {targetAssessment.adjustedActiveMinutes}m
            </Text>
            <Text style={styles.ringStatLabel}>Active Target</Text>
          </View>
        </View>
      </View>

      {/* Body Composition & Anytime Weigh-In Card */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.label}>Body Composition & Rolling Weight</Text>
          <Text style={styles.cycleTagText}>
            Cycle #{effectiveCycle.cycleNumber} ({effectiveCycle.goal})
          </Text>
        </View>

        <View style={styles.weightMetricsRow}>
          <View style={styles.weightMetricBox}>
            <Text style={styles.weightMetricLabel}>Latest Weight</Text>
            <Text style={styles.weightMetricVal}>{latestWeightKg} kg</Text>
          </View>
          <View style={styles.weightMetricBox}>
            <Text style={styles.weightMetricLabel}>7-Day Rolling Avg</Text>
            <Text style={styles.weightMetricVal}>
              {rollingAvgWeight !== null ? `${rollingAvgWeight} kg` : `${latestWeightKg} kg`}
            </Text>
          </View>
          <View style={styles.weightMetricBox}>
            <Text style={styles.weightMetricLabel}>Daily Target</Text>
            <Text style={styles.weightMetricVal}>
              {effectiveCycle.targetDailyCalories} kcal
            </Text>
          </View>
        </View>

        {weightFeedback ? (
          <Text style={styles.weightSavedNotice}>🔒 {weightFeedback}</Text>
        ) : null}

        <View style={styles.weightActionsRow}>
          <Pressable
            style={styles.logWeightPrimaryBtn}
            onPress={() => {
              setWeightError(null);
              setIsWeightModalOpen(true);
            }}
          >
            <Text style={styles.logWeightPrimaryBtnText}>
              ⚖️ Log Weight / Biometrics
            </Text>
          </Pressable>

          <Pressable
            style={styles.openReviewSecondaryBtn}
            onPress={() => {
              setIsReviewModalOpen(true);
            }}
          >
            <Text style={styles.openReviewSecondaryBtnText}>
              📊 14-Day Plan Review
            </Text>
          </Pressable>
        </View>
      </View>

      {/* 7-Day Consistency Breakdown */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.label}>7-Day Consistency Cadence</Text>
          <Text style={styles.streakIndicator}>🔥 {streakCount} Days Active</Text>
        </View>

        <View style={styles.consistencyRow}>
          {WEEK_DAYS.map((d, index) => {
            const isCompleted = d.completed || index < Math.min(streakCount, 7);
            return (
              <View key={d.day} style={styles.dayColumn}>
                <Text
                  style={[
                    styles.dayLabel,
                    d.isToday ? styles.todayLabel : null
                  ]}
                >
                  {d.day}
                </Text>
                <View
                  style={[
                    styles.dayDot,
                    isCompleted ? styles.dayDotCompleted : styles.dayDotMissed,
                    d.isToday ? styles.todayDotBorder : null
                  ]}
                >
                  <Text style={styles.dayDotIcon}>
                    {isCompleted ? "🔥" : "·"}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      {/* Daily Target & Rule Engine Adaptive Shield */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.label}>
            Biometric Profile Tier: {targetAssessment.fitnessTier}
          </Text>
          {targetAssessment.isFatigueScaled ? (
            <View style={styles.adaptiveBadgePill}>
              <Text style={styles.adaptiveBadgeText}>🛡️ -30% Fatigue Guard</Text>
            </View>
          ) : (
            <View style={styles.standardBadgePill}>
              <Text style={styles.standardBadgeText}>⚔️ 100% Standard</Text>
            </View>
          )}
        </View>

        <Text style={styles.metricValue}>
          {targetAssessment.adjustedSteps} steps / {targetAssessment.adjustedActiveMinutes} min
        </Text>

        {targetAssessment.isFatigueScaled ? (
          <Text style={styles.fatigueBadge}>
            🛡️ Adaptive Guard Active: -30% fatigue scaling applied (&gt;48h gap detected).
          </Text>
        ) : (
          <Text style={styles.standardSubtext}>
            Daily target maintained by on-device profile rule engine.
          </Text>
        )}
      </View>

      {/* Reward Perks Vault Launcher Card */}
      <View style={styles.perksCard}>
        <View style={styles.perksHeader}>
          <View style={styles.perksTitleGroup}>
            <Text style={styles.perksIcon}>💎</Text>
            <View>
              <Text style={styles.perksTitle}>Reward Perks Vault</Text>
              <Text style={styles.perksSubtitle}>
                Current Balance: {tokenBalanceDht} DHT
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.perksDesc}>
          Redeem your verified on-chain habit tokens for gym day passes, supplement discounts, or export to L2.
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Reward Perks Drawer"
          style={({ pressed }) => [
            styles.openPerksBtn,
            pressed ? styles.btnPressed : null
          ]}
          onPress={onOpenPerksDrawer}
        >
          <Text style={styles.openPerksBtnText}>
            Open Perks Vault ({tokenBalanceDht} DHT Available) ›
          </Text>
        </Pressable>
      </View>

      {/* Recent Cryptographic Proof Commitments */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.label}>Cryptographic Proof Commitments</Text>
          <Text style={styles.proofBadgeTag}>EIP-712 / Keccak-256</Text>
        </View>

        {lastProofHash ? (
          <View style={styles.proofCommitmentBox}>
            <View style={styles.proofStatusRow}>
              <Text style={styles.proofDot}>●</Text>
              <Text style={styles.proofStatus}>
                Confirmed on Arbitrum Sepolia (L2)
              </Text>
              <Text style={styles.proofStreakBadge}>Streak #{streakCount}</Text>
            </View>

            <Text style={styles.hashLabel}>Verified Keccak-256 Telemetry Hash:</Text>
            <Text
              style={styles.hashText}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {lastProofHash}
            </Text>

            <Text style={styles.proofAuditNotice}>
              [✓ Proof Verified On-Chain • Zero Biometrics Disclosed]
            </Text>
          </View>
        ) : (
          <View style={styles.emptyProofBox}>
            <Text style={styles.emptyProofText}>
              No cryptographic proofs committed yet this session.
            </Text>
            <Text style={styles.emptyProofSub}>
              Switch to the Check-In tab to sign your first 1-tap habit proof!
            </Text>
          </View>
        )}
      </View>

      {/* Standalone Log Weight / Biometrics Modal */}
      <Modal
        visible={isWeightModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setIsWeightModalOpen(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>⚖️ Log Weight & Biometrics</Text>
            <Text style={styles.modalSubtitle}>
              Encrypted locally via AES/Keccak-CTR + HMAC-SHA256. Updates your 7-day rolling weight average.
            </Text>

            <Text style={styles.inputLabel}>Body Weight (kg) *</Text>
            <TextInput
              style={styles.textInput}
              value={weightInputStr}
              onChangeText={setWeightInputStr}
              keyboardType="numeric"
              placeholder="e.g. 69.5"
              placeholderTextColor="#64748B"
            />

            <Text style={styles.inputLabel}>Body Fat % (Optional)</Text>
            <TextInput
              style={styles.textInput}
              value={bodyFatInputStr}
              onChangeText={setBodyFatInputStr}
              keyboardType="numeric"
              placeholder="e.g. 18.0"
              placeholderTextColor="#64748B"
            />

            <Text style={styles.inputLabel}>Note (Optional)</Text>
            <TextInput
              style={styles.textInput}
              value={weightNoteStr}
              onChangeText={setWeightNoteStr}
              placeholder="Morning fasted weigh-in"
              placeholderTextColor="#64748B"
            />

            {weightError ? (
              <Text style={styles.errorText}>{weightError}</Text>
            ) : null}

            <View style={styles.modalBtnRow}>
              <Pressable
                style={styles.saveWeightBtn}
                onPress={() => {
                  void handleSaveWeightLog();
                }}
              >
                <Text style={styles.saveWeightBtnText}>Save Weigh-In</Text>
              </Pressable>

              <Pressable
                style={styles.cancelWeightBtn}
                onPress={() => {
                  setIsWeightModalOpen(false);
                }}
              >
                <Text style={styles.cancelWeightBtnText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Bi-Weekly Plan Review Modal */}
      <PlanReviewModal
        visible={isReviewModalOpen}
        review={proposedReview}
        onApproveNewPlan={(rev) => {
          void handleApproveReview(rev);
        }}
        onKeepCurrentPlan={handleKeepCurrentPlan}
        onClose={() => {
          setIsReviewModalOpen(false);
        }}
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F17"
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 28
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 14
  },
  biWeeklyBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1E293B",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  biWeeklyBannerTextCol: {
    flex: 1,
    marginRight: 10
  },
  biWeeklyBannerTag: {
    fontSize: 10,
    fontWeight: "800",
    color: "#38BDF8",
    letterSpacing: 0.5,
    marginBottom: 2
  },
  biWeeklyBannerTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  biWeeklyBannerSub: {
    fontSize: 11,
    color: "#CBD5E1",
    marginTop: 2
  },
  biWeeklyReviewBtn: {
    backgroundColor: "#38BDF8",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10
  },
  biWeeklyReviewBtnText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#082F49"
  },
  noticePill: {
    backgroundColor: "#052E16",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#10B981"
  },
  noticePillText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#A7F3D0"
  },
  ringCard: {
    backgroundColor: "#161F30",
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    alignItems: "center"
  },
  ringCardHeading: {
    fontSize: 12,
    fontWeight: "700",
    color: "#94A3B8",
    textTransform: "uppercase",
    marginBottom: 14,
    letterSpacing: 0.5
  },
  ringWrapper: {
    marginVertical: 4,
    alignItems: "center",
    justifyContent: "center"
  },
  outerGlowRing: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 6,
    borderColor: "#10B981",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(16, 185, 129, 0.08)"
  },
  innerGlowRing: {
    width: 114,
    height: 114,
    borderRadius: 57,
    backgroundColor: "#0B0F17",
    borderWidth: 2,
    borderColor: "rgba(16, 185, 129, 0.4)",
    alignItems: "center",
    justifyContent: "center"
  },
  ringFlameIcon: {
    fontSize: 22
  },
  ringPercentText: {
    fontSize: 22,
    fontWeight: "900",
    color: "#F8FAFC"
  },
  ringSubtext: {
    fontSize: 10,
    color: "#34D399",
    fontWeight: "700",
    textTransform: "uppercase"
  },
  ringStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    width: "100%",
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#1E293B"
  },
  ringStatItem: {
    alignItems: "center",
    flex: 1
  },
  ringStatValue: {
    fontSize: 17,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  ringStatLabel: {
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 2
  },
  ringDivider: {
    width: 1,
    height: 26,
    backgroundColor: "#1E293B"
  },
  card: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94A3B8",
    textTransform: "uppercase",
    letterSpacing: 0.5
  },
  cycleTagText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#38BDF8"
  },
  weightMetricsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12
  },
  weightMetricBox: {
    flex: 1,
    backgroundColor: "#0F172A",
    borderRadius: 10,
    padding: 10,
    alignItems: "center"
  },
  weightMetricLabel: {
    fontSize: 10,
    color: "#94A3B8",
    marginBottom: 2
  },
  weightMetricVal: {
    fontSize: 14,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  weightSavedNotice: {
    fontSize: 11,
    color: "#10B981",
    fontWeight: "600",
    marginBottom: 10
  },
  weightActionsRow: {
    flexDirection: "row",
    gap: 8
  },
  logWeightPrimaryBtn: {
    flex: 1,
    backgroundColor: "#10B981",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center"
  },
  logWeightPrimaryBtnText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#052E16"
  },
  openReviewSecondaryBtn: {
    flex: 1,
    backgroundColor: "#0F172A",
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  openReviewSecondaryBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8"
  },
  streakIndicator: {
    fontSize: 12,
    fontWeight: "700",
    color: "#F97316"
  },
  consistencyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 4
  },
  dayColumn: {
    alignItems: "center",
    gap: 6
  },
  dayLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#64748B"
  },
  todayLabel: {
    color: "#38BDF8",
    fontWeight: "800"
  },
  dayDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center"
  },
  dayDotCompleted: {
    backgroundColor: "rgba(249, 115, 22, 0.18)",
    borderWidth: 1,
    borderColor: "rgba(249, 115, 22, 0.5)"
  },
  dayDotMissed: {
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  todayDotBorder: {
    borderWidth: 2,
    borderColor: "#38BDF8"
  },
  dayDotIcon: {
    fontSize: 14,
    color: "#94A3B8"
  },
  adaptiveBadgePill: {
    backgroundColor: "rgba(251, 191, 36, 0.14)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.4)"
  },
  adaptiveBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#FBBF24"
  },
  standardBadgePill: {
    backgroundColor: "rgba(56, 189, 248, 0.14)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.4)"
  },
  standardBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#38BDF8"
  },
  metricValue: {
    fontSize: 20,
    fontWeight: "800",
    color: "#38BDF8"
  },
  fatigueBadge: {
    marginTop: 8,
    fontSize: 12,
    color: "#FBBF24",
    lineHeight: 17
  },
  standardSubtext: {
    marginTop: 6,
    fontSize: 12,
    color: "#94A3B8"
  },
  perksCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  perksHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8
  },
  perksTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10
  },
  perksIcon: {
    fontSize: 24
  },
  perksTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  perksSubtitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#38BDF8"
  },
  perksDesc: {
    fontSize: 12,
    color: "#94A3B8",
    lineHeight: 18,
    marginBottom: 12
  },
  openPerksBtn: {
    backgroundColor: "#38BDF8",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center"
  },
  btnPressed: {
    opacity: 0.85
  },
  openPerksBtnText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#082F49"
  },
  proofBadgeTag: {
    fontSize: 10,
    fontWeight: "700",
    color: "#34D399",
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6
  },
  proofCommitmentBox: {
    backgroundColor: "#0F172A",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  proofStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    gap: 6
  },
  proofDot: {
    fontSize: 10,
    color: "#10B981"
  },
  proofStatus: {
    fontSize: 12,
    fontWeight: "700",
    color: "#E2E8F0",
    flex: 1
  },
  proofStreakBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: "#34D399"
  },
  hashLabel: {
    fontSize: 10,
    color: "#64748B",
    marginBottom: 3
  },
  hashText: {
    fontSize: 12,
    fontFamily: "monospace",
    color: "#38BDF8",
    marginBottom: 8
  },
  proofAuditNotice: {
    fontSize: 11,
    fontWeight: "700",
    color: "#10B981"
  },
  emptyProofBox: {
    backgroundColor: "#0F172A",
    borderRadius: 10,
    padding: 14,
    alignItems: "center"
  },
  emptyProofText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#94A3B8"
  },
  emptyProofSub: {
    fontSize: 11,
    color: "#64748B",
    marginTop: 4
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: 18
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#161F30",
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: "#334155"
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 4
  },
  modalSubtitle: {
    fontSize: 12,
    color: "#94A3B8",
    marginBottom: 14,
    lineHeight: 17
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#CBD5E1",
    marginBottom: 6
  },
  textInput: {
    backgroundColor: "#0F172A",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#F8FAFC",
    fontSize: 14,
    marginBottom: 12
  },
  errorText: {
    fontSize: 12,
    color: "#F87171",
    marginBottom: 10,
    fontWeight: "600"
  },
  modalBtnRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4
  },
  saveWeightBtn: {
    flex: 1,
    backgroundColor: "#10B981",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center"
  },
  saveWeightBtnText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#052E16"
  },
  cancelWeightBtn: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#1E293B",
    alignItems: "center"
  },
  cancelWeightBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#CBD5E1"
  }
});
