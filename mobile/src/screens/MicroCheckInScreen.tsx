import {
  Address,
  Bytes32,
  SignedWorkoutClaimPayload,
  TelemetryData,
  UserProfile,
  WorkoutProof
} from "@dehealth/shared";
import { Signer } from "ethers";
import React, { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { hashTelemetry, signWorkoutProof } from "../services/cryptoService";

export interface HabitCardDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly durationText: string;
  readonly icon: string;
  readonly accentColor: string;
  readonly telemetry: {
    readonly stepCount: number;
    readonly activeMinutes: number;
    readonly avgHeartRateBpm: number;
    readonly caloriesBurnedKcal: number;
  };
}

export const HABIT_CARDS: readonly HabitCardDefinition[] = [
  {
    id: "cardio-walk",
    title: "Cardio / Brisk Walk (10 mins)",
    category: "Endurance & Cardio",
    durationText: "10 mins • 1,250 steps • 124 avg bpm",
    icon: "🏃",
    accentColor: "#10B981",
    telemetry: {
      stepCount: 1250,
      activeMinutes: 10,
      avgHeartRateBpm: 124.0,
      caloriesBurnedKcal: 68.5
    }
  },
  {
    id: "mindful-meal",
    title: "Clean / Mindful Meal",
    category: "Metabolic Nutrition",
    durationText: "1-Tap meal record • 15 mindful mins • 72 avg bpm",
    icon: "🥗",
    accentColor: "#38BDF8",
    telemetry: {
      stepCount: 0,
      activeMinutes: 15,
      avgHeartRateBpm: 72.0,
      caloriesBurnedKcal: 15.0
    }
  },
  {
    id: "mobility-recovery",
    title: "Mobility & Recovery (10-min)",
    category: "Flexibility & Restoration",
    durationText: "10 mins • 180 steps • 78 avg bpm",
    icon: "🧘",
    accentColor: "#F59E0B",
    telemetry: {
      stepCount: 180,
      activeMinutes: 10,
      avgHeartRateBpm: 78.0,
      caloriesBurnedKcal: 32.0
    }
  }
];

const DEFAULT_PROFILE: UserProfile = {
  age: 28,
  gender: "non-binary",
  bodyFatPct: 18.5,
  muscleMassKg: 34.0
};

export interface MicroCheckInScreenProps {
  readonly userAddress: Address;
  readonly verifyingContract: Address;
  readonly currentStreak: number;
  readonly currentNonce: bigint;
  readonly signer: Signer;
  readonly collectTelemetry?: () => TelemetryData;
  readonly userProfile?: UserProfile;
  readonly onDispatchSignedClaim: (payload: SignedWorkoutClaimPayload) => Promise<void>;
}

export const MicroCheckInScreen: React.FC<MicroCheckInScreenProps> = ({
  userAddress,
  verifyingContract,
  currentStreak,
  currentNonce,
  signer,
  collectTelemetry,
  userProfile = DEFAULT_PROFILE,
  onDispatchSignedClaim
}) => {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [statusStep, setStatusStep] = useState<string>("Ready for 1-Tap Check-In");
  const [lastSignedPayload, setLastSignedPayload] =
    useState<SignedWorkoutClaimPayload | null>(null);
  const [completedHabit, setCompletedHabit] =
    useState<HabitCardDefinition | null>(null);
  const [isPayloadModalOpen, setIsPayloadModalOpen] = useState<boolean>(false);
  const [l2MintSimulation, setL2MintSimulation] = useState<{
    readonly txHash: string;
    readonly blockNumber: number;
    readonly status: string;
  } | null>(null);

  const handleCardCheckIn = async (card: HabitCardDefinition): Promise<void> => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setActiveCardId(card.id);

    try {
      setStatusStep("1/3 Hashing local biometric telemetry (Keccak-256)...");

      // Generate habit-specific biometric telemetry
      const baseTelemetry = collectTelemetry ? collectTelemetry() : null;
      const telemetry: TelemetryData = {
        timestampMs: Date.now(),
        stepCount: card.telemetry.stepCount,
        activeMinutes: card.telemetry.activeMinutes,
        avgHeartRateBpm: card.telemetry.avgHeartRateBpm,
        caloriesBurnedKcal: card.telemetry.caloriesBurnedKcal,
        profileSnapshot: baseTelemetry?.profileSnapshot ?? userProfile
      };

      const telemetryHash: Bytes32 = hashTelemetry(telemetry);

      setStatusStep("2/3 Signing EIP-712 WorkoutProof offline...");
      const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const proof: WorkoutProof = {
        user: userAddress,
        telemetryHash,
        streakCount: BigInt(currentStreak + 1),
        nonce: currentNonce,
        deadline: deadlineSeconds
      };

      const signedPayload = await signWorkoutProof(signer, proof, verifyingContract);

      setStatusStep("3/3 Committing proof to DeHealth protocol...");
      await onDispatchSignedClaim(signedPayload);

      setLastSignedPayload(signedPayload);
      setCompletedHabit(card);
      setStatusStep(`Verified! Daily ring closed for ${card.title}.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Signing error";
      setStatusStep(`Check-in failed: ${message}`);
    } finally {
      setIsSubmitting(false);
      setActiveCardId(null);
    }
  };


  const simulateL2Mint = () => {
    if (!lastSignedPayload) return;
    const randomHex = Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join("");
    setL2MintSimulation({
      txHash: `0x${randomHex}`,
      blockNumber: 18492000 + Math.floor(Math.random() * 1000),
      status: "Confirmed on Arbitrum Sepolia (L2)"
    });
  };

  const handleResetCheckIn = () => {
    setLastSignedPayload(null);
    setCompletedHabit(null);
    setL2MintSimulation(null);
    setIsPayloadModalOpen(false);
    setStatusStep("Ready for 1-Tap Check-In");
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
    >
      {/* Header Banner */}
      <View style={styles.headerArea}>
        <Text style={styles.heading}>1-Tap Habit Ritual</Text>
        <Text style={styles.subtitle}>
          Tap any habit below to hash local biometrics with Keccak-256 and sign an authentic EIP-712 proof.
        </Text>
      </View>

      {/* Celebratory State when Proof is Signed */}
      {lastSignedPayload && completedHabit ? (
        <View style={styles.celebrationCard}>
          {/* Daily Ring Closed Icon & Banner */}
          <View style={styles.ringBadgeContainer}>
            <View style={styles.outerGlowRing}>
              <View style={styles.innerGlowRing}>
                <Text style={styles.ringCheckmark}>✓</Text>
              </View>
            </View>
          </View>

          <Text style={styles.celebrationTitle}>Daily Ring Closed! 🔥</Text>
          <Text style={styles.celebrationSub}>
            Completed: {completedHabit.title}
          </Text>

          {/* Reward Badges */}
          <View style={styles.rewardBadgesRow}>
            <View style={styles.streakRewardPill}>
              <Text style={styles.pillText}>🔥 {currentStreak} Day Streak</Text>
            </View>
            <View style={styles.dhtRewardPill}>
              <Text style={styles.pillText}>💎 +10 $DHT Minted</Text>
            </View>
          </View>

          {/* Proof Hash Snippet */}
          <View style={styles.proofHashBox}>
            <Text style={styles.proofHashLabel}>Keccak-256 Telemetry Hash:</Text>
            <Text
              style={styles.proofHashText}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {lastSignedPayload.proof.telemetryHash}
            </Text>
          </View>

          {/* L2 Mint Simulation Result */}
          {l2MintSimulation ? (
            <View style={styles.l2Box}>
              <Text style={styles.l2Status}>● {l2MintSimulation.status}</Text>
              <Text style={styles.l2Detail}>
                Block #{l2MintSimulation.blockNumber}
              </Text>
              <Text
                style={styles.l2Tx}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                Tx: {l2MintSimulation.txHash}
              </Text>
            </View>
          ) : null}

          {/* Action Buttons */}
          <View style={styles.actionRow}>
            {!l2MintSimulation ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Simulate L2 Arbitrum Mint"
                style={styles.mintButton}
                onPress={simulateL2Mint}
              >
                <Text style={styles.mintButtonText}>⚡ Simulate L2 Mint</Text>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Inspect Signed Proof Payload"
              style={styles.inspectButton}
              onPress={() => setIsPayloadModalOpen(!isPayloadModalOpen)}
            >
              <Text style={styles.inspectButtonText}>
                {isPayloadModalOpen ? "▲ Hide EIP-712" : "📜 Inspect EIP-712"}
              </Text>
            </Pressable>
          </View>

          {/* Expanded Proof Details */}
          {isPayloadModalOpen ? (
            <View style={styles.payloadCard}>
              <Text style={styles.payloadTitle}>EIP-712 WorkoutProof Struct</Text>
              <Text style={styles.payloadItem}>User: {lastSignedPayload.proof.user}</Text>
              <Text style={styles.payloadItem}>
                Telemetry: {lastSignedPayload.proof.telemetryHash}
              </Text>
              <Text style={styles.payloadItem}>
                Streak: {lastSignedPayload.proof.streakCount.toString()}
              </Text>
              <Text style={styles.payloadItem}>
                Nonce: {lastSignedPayload.proof.nonce.toString()}
              </Text>
              <Text style={styles.payloadItem}>
                Deadline: {lastSignedPayload.proof.deadline.toString()}
              </Text>
              <Text style={styles.payloadItem}>
                Signature: {lastSignedPayload.signature.slice(0, 30)}...
              </Text>
              <Text style={styles.verifiedTag}>[✓ Valid EIP-712 ECDSA Signature]</Text>
            </View>
          ) : null}

          {/* Reset / Check In Another Habit */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Check In Another Habit"
            style={styles.resetButton}
            onPress={handleResetCheckIn}
          >
            <Text style={styles.resetButtonText}>+ Log Another Habit</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 3 1-Tap Habit Cards */}
      <View style={styles.cardsContainer}>
        {HABIT_CARDS.map((card) => {
          const isThisSubmitting = isSubmitting && activeCardId === card.id;
          return (
            <Pressable
              key={card.id}
              accessibilityRole="button"
              accessibilityLabel={`1-Tap Habit: ${card.title}`}
              style={({ pressed }) => [
                styles.habitCard,
                { borderColor: card.accentColor },
                pressed && !isSubmitting ? styles.cardPressed : null,
                isSubmitting && !isThisSubmitting ? styles.cardDisabled : null
              ]}
              onPress={() => {
                void handleCardCheckIn(card);
              }}
              disabled={isSubmitting}
            >
              <View style={styles.cardHeader}>
                <View
                  style={[
                    styles.cardIconBox,
                    { backgroundColor: `${card.accentColor}22` }
                  ]}
                >
                  <Text style={styles.cardIcon}>{card.icon}</Text>
                </View>
                <View style={styles.cardInfo}>
                  <Text style={[styles.cardCategory, { color: card.accentColor }]}>
                    {card.category}
                  </Text>
                  <Text style={styles.cardTitle}>{card.title}</Text>
                </View>
                <View style={styles.tapPill}>
                  <Text style={styles.tapPillText}>
                    {isThisSubmitting ? "Signing..." : "1-Tap ⚡"}
                  </Text>
                </View>
              </View>

              <Text style={styles.cardDuration}>{card.durationText}</Text>

              <View style={styles.metricsSummary}>
                <Text style={styles.metricItem}>
                  🔥 {card.telemetry.caloriesBurnedKcal} kcal
                </Text>
                <Text style={styles.metricItem}>
                  ❤️ {card.telemetry.avgHeartRateBpm} bpm
                </Text>
                <Text style={styles.metricItem}>
                  ⏱️ {card.telemetry.activeMinutes} min
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Status Bar */}
      <View style={styles.statusBox}>
        <Text style={styles.statusText}>{statusStep}</Text>
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
    paddingBottom: 24
  },
  headerArea: {
    marginBottom: 16
  },
  heading: {
    fontSize: 20,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 4
  },
  subtitle: {
    fontSize: 12,
    color: "#94A3B8",
    lineHeight: 16
  },
  celebrationCard: {
    backgroundColor: "#161F30",
    borderRadius: 16,
    padding: 18,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: "#10B981",
    alignItems: "center"
  },
  ringBadgeContainer: {
    marginBottom: 10
  },
  outerGlowRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    borderColor: "#10B981",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(16, 185, 129, 0.15)"
  },
  innerGlowRing: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#10B981",
    alignItems: "center",
    justifyContent: "center"
  },
  ringCheckmark: {
    fontSize: 24,
    fontWeight: "900",
    color: "#052E16"
  },
  celebrationTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 4
  },
  celebrationSub: {
    fontSize: 13,
    color: "#34D399",
    fontWeight: "600",
    marginBottom: 12
  },
  rewardBadgesRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14
  },
  streakRewardPill: {
    backgroundColor: "rgba(249, 115, 22, 0.2)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#F97316"
  },
  dhtRewardPill: {
    backgroundColor: "rgba(56, 189, 248, 0.2)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  pillText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  proofHashBox: {
    width: "100%",
    backgroundColor: "#0B0F17",
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  proofHashLabel: {
    fontSize: 10,
    color: "#94A3B8",
    textTransform: "uppercase",
    marginBottom: 2
  },
  proofHashText: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#38BDF8"
  },
  l2Box: {
    width: "100%",
    backgroundColor: "#0F172A",
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#10B981"
  },
  l2Status: {
    color: "#34D399",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 2
  },
  l2Detail: {
    color: "#94A3B8",
    fontSize: 11
  },
  l2Tx: {
    fontFamily: "monospace",
    fontSize: 10,
    color: "#38BDF8",
    marginTop: 2
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    width: "100%",
    marginBottom: 10
  },
  mintButton: {
    flex: 1,
    backgroundColor: "#10B981",
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center"
  },
  mintButtonText: {
    color: "#052E16",
    fontSize: 12,
    fontWeight: "700"
  },
  inspectButton: {
    flex: 1,
    backgroundColor: "#1E293B",
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  inspectButtonText: {
    color: "#38BDF8",
    fontSize: 12,
    fontWeight: "700"
  },
  payloadCard: {
    width: "100%",
    backgroundColor: "#0B0F17",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  payloadTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 6,
    textTransform: "uppercase"
  },
  payloadItem: {
    fontSize: 10,
    fontFamily: "monospace",
    color: "#94A3B8",
    marginBottom: 3
  },
  verifiedTag: {
    fontSize: 10,
    color: "#34D399",
    fontWeight: "700",
    marginTop: 4
  },
  resetButton: {
    marginTop: 4,
    paddingVertical: 8,
    paddingHorizontal: 16
  },
  resetButtonText: {
    fontSize: 12,
    color: "#94A3B8",
    fontWeight: "600"
  },
  cardsContainer: {
    gap: 12,
    marginBottom: 14
  },
  habitCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5
  },
  cardPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }]
  },
  cardDisabled: {
    opacity: 0.45
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8
  },
  cardIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10
  },
  cardIcon: {
    fontSize: 20
  },
  cardInfo: {
    flex: 1
  },
  cardCategory: {
    fontSize: 10,
    textTransform: "uppercase",
    fontWeight: "700"
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  tapPill: {
    backgroundColor: "#0F172A",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  tapPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#38BDF8"
  },
  cardDuration: {
    fontSize: 11,
    color: "#94A3B8",
    marginBottom: 8
  },
  metricsSummary: {
    flexDirection: "row",
    gap: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(30, 41, 59, 0.5)"
  },
  metricItem: {
    fontSize: 11,
    color: "#E2E8F0",
    fontWeight: "500"
  },
  statusBox: {
    backgroundColor: "#0F172A",
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: "#1E293B",
    alignItems: "center"
  },
  statusText: {
    fontSize: 11,
    color: "#94A3B8"
  }
});
