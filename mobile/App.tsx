import {
  Address,
  AnonymizedFeedRecord,
  Bytes32,
  SignedWorkoutClaimPayload,
  TelemetryData,
  UserProfile
} from "@dehealth/shared";
import { Wallet } from "ethers";
import React, { useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { RewardPerksDrawer } from "./src/components/RewardPerksDrawer";
import { StreakFlameHeader } from "./src/components/StreakFlameHeader";
import { AnonymizedFeedScreen } from "./src/screens/AnonymizedFeedScreen";
import { DashboardScreen } from "./src/screens/DashboardScreen";
import { MicroCheckInScreen } from "./src/screens/MicroCheckInScreen";
import { verifyWorkoutProofSignature } from "./src/services/cryptoService";
import { evaluateDailyTarget } from "./src/services/profileEngine";

type ActiveTab = "checkin" | "dashboard" | "feed";

const DEMO_VERIFYING_CONTRACT: Address =
  "0x1111111111111111111111111111111111111111" as Address;

const DEMO_PROFILE: UserProfile = {
  age: 28,
  gender: "non-binary",
  bodyFatPct: 18.5,
  muscleMassKg: 34.0
};

const INITIAL_FEED_ITEMS: readonly AnonymizedFeedRecord[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    user_pseudonym: "zephyr_runner",
    proof_hash:
      "0x8a3f2b1c9d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcd",
    streak_count: 14,
    created_at: "2026-11-11T08:15:00Z"
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    user_pseudonym: "iron_pulse_42",
    proof_hash:
      "0x4c9e1d2a7b8f03456789abcdef0123456789abcdef0123456789abcdef012345",
    streak_count: 7,
    created_at: "2026-11-11T06:40:00Z"
  }
];

const INITIAL_CHEERS: Readonly<Record<string, number>> = {
  "00000000-0000-4000-8000-000000000001": 12,
  "00000000-0000-4000-8000-000000000002": 5
};

const TAB_ITEMS: ReadonlyArray<{
  readonly id: ActiveTab;
  readonly label: string;
  readonly icon: string;
}> = [
  { id: "checkin", label: "Check-In", icon: "⚡" },
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "feed", label: "Feed", icon: "👥" }
];

export default function App(): React.ReactElement {
  // Default home/landing screen configured to Check-In (R1)
  const [activeTab, setActiveTab] = useState<ActiveTab>("checkin");
  const [streakCount, setStreakCount] = useState<number>(3);
  const [tokenBalanceDht, setTokenBalanceDht] = useState<string>("30.0");
  const [currentNonce, setCurrentNonce] = useState<bigint>(0n);
  const [lastProofHash, setLastProofHash] = useState<Bytes32 | null>(null);
  const [lastLogTimestampMs, setLastLogTimestampMs] = useState<number>(
    () => Date.now() - 50 * 60 * 60 * 1000
  );
  const [feedItems, setFeedItems] =
    useState<readonly AnonymizedFeedRecord[]>(INITIAL_FEED_ITEMS);
  const [cheerCounts, setCheerCounts] =
    useState<Readonly<Record<string, number>>>(INITIAL_CHEERS);
  const [isPerksDrawerOpen, setIsPerksDrawerOpen] = useState<boolean>(false);

  const wallet = useMemo(() => Wallet.createRandom(), []);
  const userAddress = wallet.address as Address;

  const targetAssessment = useMemo(
    () => evaluateDailyTarget(DEMO_PROFILE, lastLogTimestampMs, Date.now()),
    [lastLogTimestampMs]
  );

  const collectTelemetry = (): TelemetryData => ({
    timestampMs: Date.now(),
    stepCount: 8_420,
    activeMinutes: 42,
    avgHeartRateBpm: 132.5,
    caloriesBurnedKcal: 410.0,
    profileSnapshot: DEMO_PROFILE
  });

  const handleDispatchSignedClaim = async (
    payload: SignedWorkoutClaimPayload
  ): Promise<void> => {
    const isValid = verifyWorkoutProofSignature(payload, DEMO_VERIFYING_CONTRACT);
    if (!isValid) {
      throw new Error("Local EIP-712 signature verification failed");
    }

    const nextStreak = Number(payload.proof.streakCount);
    const nextBalance = (Number.parseFloat(tokenBalanceDht) + 10).toFixed(1);
    const newFeedId = `00000000-0000-4000-8000-${String(feedItems.length + 1).padStart(12, "0")}`;

    setStreakCount(nextStreak);
    setTokenBalanceDht(nextBalance);
    setCurrentNonce((prev) => prev + 1n);
    setLastProofHash(payload.proof.telemetryHash);
    setLastLogTimestampMs(Date.now());
    setFeedItems((prev) => [
      {
        id: newFeedId,
        user_pseudonym: `athlete_${userAddress.slice(2, 8).toLowerCase()}`,
        proof_hash: payload.proof.telemetryHash,
        streak_count: nextStreak,
        created_at: new Date().toISOString()
      },
      ...prev
    ]);
    setCheerCounts((prev) => ({
      ...prev,
      [newFeedId]: 0
    }));
  };

  const handleCheer = (feedId: string): void => {
    setCheerCounts((prev) => ({
      ...prev,
      [feedId]: (prev[feedId] ?? 0) + 1
    }));
  };

  const handleRedeemPerk = (costDht: number, _perkTitle: string): boolean => {
    const currentBalance = Number.parseFloat(tokenBalanceDht);
    if (currentBalance < costDht) {
      return false;
    }
    const nextBalance = (currentBalance - costDht).toFixed(1);
    setTokenBalanceDht(nextBalance);
    return true;
  };

  return (
    <SafeAreaView style={styles.viewport}>
      <View style={styles.phoneFrame}>
        {/* Persistent Gamification Top Header (R2) */}
        <StreakFlameHeader
          userAddress={userAddress}
          streakCount={streakCount}
          tokenBalanceDht={tokenBalanceDht}
          isFatigueScaled={targetAssessment.isFatigueScaled}
          fitnessTier={targetAssessment.fitnessTier}
          onOpenPerksDrawer={() => setIsPerksDrawerOpen(true)}
        />

        {/* Screen Area with Smooth Tab Switching */}
        <View style={styles.screenArea}>
          {activeTab === "checkin" ? (
            <MicroCheckInScreen
              userAddress={userAddress}
              verifyingContract={DEMO_VERIFYING_CONTRACT}
              currentStreak={streakCount}
              currentNonce={currentNonce}
              signer={wallet}
              userProfile={DEMO_PROFILE}
              collectTelemetry={collectTelemetry}
              onDispatchSignedClaim={handleDispatchSignedClaim}
            />
          ) : null}

          {activeTab === "dashboard" ? (
            <DashboardScreen
              streakCount={streakCount}
              tokenBalanceDht={tokenBalanceDht}
              lastProofHash={lastProofHash}
              targetAssessment={targetAssessment}
              onOpenPerksDrawer={() => setIsPerksDrawerOpen(true)}
            />
          ) : null}

          {activeTab === "feed" ? (
            <AnonymizedFeedScreen
              items={feedItems}
              cheerCountsByFeedId={cheerCounts}
              onCheer={handleCheer}
            />
          ) : null}
        </View>

        {/* Modern Gamified Bottom Navigation Bar (R1) */}
        <View style={styles.tabBar}>
          {TAB_ITEMS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <Pressable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityLabel={`${tab.label} Tab`}
                accessibilityState={{ selected: isActive }}
                style={({ pressed }) => [
                  styles.tabButton,
                  isActive ? styles.tabButtonActive : null,
                  pressed ? styles.tabButtonPressed : null
                ]}
                onPress={() => {
                  setActiveTab(tab.id);
                }}
              >
                <Text style={styles.tabIcon}>{tab.icon}</Text>
                <Text
                  style={[
                    styles.tabLabel,
                    isActive ? styles.tabLabelActive : null
                  ]}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Reward Perks Drawer / Modal (R4) */}
        <RewardPerksDrawer
          visible={isPerksDrawerOpen}
          tokenBalanceDht={tokenBalanceDht}
          onClose={() => setIsPerksDrawerOpen(false)}
          onRedeemPerk={handleRedeemPerk}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  viewport: {
    flex: 1,
    width: "100%",
    backgroundColor: "#020617",
    alignItems: "center",
    justifyContent: Platform.OS === "web" ? "center" : "flex-start",
    paddingVertical: Platform.OS === "web" ? 16 : 0,
    paddingHorizontal: Platform.OS === "web" ? 12 : 0
  },
  phoneFrame: {
    flex: 1,
    width: "100%",
    maxWidth: 420,
    maxHeight: Platform.OS === "web" ? 844 : undefined,
    backgroundColor: "#0B0F17",
    borderRadius: Platform.OS === "web" ? 28 : 0,
    borderWidth: Platform.OS === "web" ? 1 : 0,
    borderColor: "#1E293B",
    overflow: "hidden"
  },
  screenArea: {
    flex: 1,
    backgroundColor: "#0B0F17"
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#0F172A",
    borderTopWidth: 1,
    borderTopColor: "#1E293B",
    paddingVertical: 6,
    paddingHorizontal: 8,
    gap: 6
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent"
  },
  tabButtonActive: {
    backgroundColor: "#161F30",
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.3)"
  },
  tabButtonPressed: {
    opacity: 0.8
  },
  tabIcon: {
    fontSize: 16,
    marginBottom: 2
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#64748B"
  },
  tabLabelActive: {
    color: "#38BDF8",
    fontWeight: "700"
  }
});
