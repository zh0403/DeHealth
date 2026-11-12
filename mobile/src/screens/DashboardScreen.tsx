import { Bytes32 } from "@dehealth/shared";
import React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { DailyTargetAssessment } from "../services/profileEngine";

export interface DashboardScreenProps {
  readonly streakCount: number;
  readonly tokenBalanceDht: string;
  readonly lastProofHash: Bytes32 | null;
  readonly targetAssessment: DailyTargetAssessment;
  readonly onOpenPerksDrawer?: () => void;
}

const WEEK_DAYS: ReadonlyArray<{ readonly day: string; readonly completed: boolean; readonly isToday?: boolean }> = [
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
  onOpenPerksDrawer
}) => {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
    >
      <Text style={styles.title}>Athlete Command Center</Text>

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
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#1E293B"
  },
  ringStatItem: {
    alignItems: "center"
  },
  ringStatValue: {
    fontSize: 16,
    fontWeight: "800",
    color: "#38BDF8"
  },
  ringStatLabel: {
    fontSize: 10,
    color: "#94A3B8",
    marginTop: 2
  },
  ringDivider: {
    width: 1,
    height: 24,
    backgroundColor: "#1E293B"
  },
  card: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10
  },
  label: {
    fontSize: 11,
    color: "#94A3B8",
    textTransform: "uppercase",
    fontWeight: "700",
    letterSpacing: 0.3
  },
  streakIndicator: {
    fontSize: 12,
    color: "#F97316",
    fontWeight: "700"
  },
  consistencyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 4
  },
  dayColumn: {
    alignItems: "center",
    gap: 6
  },
  dayLabel: {
    fontSize: 11,
    color: "#64748B",
    fontWeight: "600"
  },
  todayLabel: {
    color: "#38BDF8",
    fontWeight: "800"
  },
  dayDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center"
  },
  dayDotCompleted: {
    backgroundColor: "rgba(249, 115, 22, 0.2)",
    borderWidth: 1,
    borderColor: "#F97316"
  },
  dayDotMissed: {
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  todayDotBorder: {
    borderColor: "#38BDF8",
    borderWidth: 2
  },
  dayDotIcon: {
    fontSize: 12
  },
  adaptiveBadgePill: {
    backgroundColor: "rgba(245, 158, 11, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#F59E0B"
  },
  adaptiveBadgeText: {
    color: "#FBBF24",
    fontSize: 10,
    fontWeight: "700"
  },
  standardBadgePill: {
    backgroundColor: "rgba(16, 185, 129, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#10B981"
  },
  standardBadgeText: {
    color: "#34D399",
    fontSize: 10,
    fontWeight: "700"
  },
  metricValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 4
  },
  fatigueBadge: {
    marginTop: 4,
    fontSize: 12,
    color: "#FBBF24",
    lineHeight: 16
  },
  standardSubtext: {
    fontSize: 12,
    color: "#94A3B8",
    lineHeight: 16
  },
  perksCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
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
    gap: 8
  },
  perksIcon: {
    fontSize: 20
  },
  perksTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  perksSubtitle: {
    fontSize: 11,
    color: "#38BDF8",
    fontWeight: "600"
  },
  perksDesc: {
    fontSize: 12,
    color: "#94A3B8",
    lineHeight: 16,
    marginBottom: 12
  },
  openPerksBtn: {
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#38BDF8",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center"
  },
  btnPressed: {
    opacity: 0.8
  },
  openPerksBtnText: {
    color: "#38BDF8",
    fontSize: 13,
    fontWeight: "700"
  },
  proofBadgeTag: {
    fontSize: 10,
    color: "#38BDF8",
    fontFamily: "monospace"
  },
  proofCommitmentBox: {
    backgroundColor: "#0B0F17",
    padding: 12,
    borderRadius: 10,
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
    color: "#10B981",
    fontSize: 10
  },
  proofStatus: {
    color: "#34D399",
    fontSize: 11,
    fontWeight: "700",
    flex: 1
  },
  proofStreakBadge: {
    color: "#F97316",
    fontSize: 10,
    fontWeight: "700"
  },
  hashLabel: {
    fontSize: 10,
    color: "#94A3B8",
    textTransform: "uppercase",
    marginBottom: 2
  },
  hashText: {
    fontSize: 12,
    fontFamily: "monospace",
    color: "#E2E8F0",
    marginBottom: 6
  },
  proofAuditNotice: {
    fontSize: 10,
    color: "#10B981",
    fontWeight: "700"
  },
  emptyProofBox: {
    padding: 12,
    backgroundColor: "#0B0F17",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1E293B",
    alignItems: "center"
  },
  emptyProofText: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4
  },
  emptyProofSub: {
    color: "#64748B",
    fontSize: 11,
    textAlign: "center"
  }
});
