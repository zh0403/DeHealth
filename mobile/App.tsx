import {
  AdaptivePlanCycle,
  Address,
  AnonymizedFeedRecord,
  Bytes32,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  SignedWorkoutClaimPayload,
  UserBiometrics,
  UserProfile,
  WeightLogEntry
} from "@dehealth/shared";
import { Wallet } from "ethers";
import React, { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { RewardPerksDrawer } from "./src/components/RewardPerksDrawer";
import { StreakFlameHeader } from "./src/components/StreakFlameHeader";
import { AnonymizedFeedScreen } from "./src/screens/AnonymizedFeedScreen";
import { DashboardScreen } from "./src/screens/DashboardScreen";
import { MicroCheckInScreen } from "./src/screens/MicroCheckInScreen";
import { OnboardingWizardScreen } from "./src/screens/OnboardingWizardScreen";
import { generate14DayPlan } from "./src/services/adaptivePlanEngine";
import { verifyWorkoutProofSignature } from "./src/services/cryptoService";
import { evaluateDailyTarget } from "./src/services/profileEngine";
import {
  getActivePlanCycle,
  getUserBiometrics,
  getWeightLogs,
  saveActivePlanCycle
} from "./src/storage/adaptiveStorage";

type ActiveTab = "checkin" | "dashboard" | "feed";

const DEMO_VERIFYING_CONTRACT: Address =
  "0x1111111111111111111111111111111111111111" as Address;

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

function biometricsToUserProfile(bio: UserBiometrics): UserProfile {
  const bodyFatPct = bio.bodyFatPct ?? 18.5;
  const estimatedLbm = Number(
    (bio.weightKg * (1 - bodyFatPct / 100) * 0.55).toFixed(1)
  );
  return {
    age: bio.age,
    gender: bio.gender,
    bodyFatPct,
    muscleMassKg: Math.min(150, Math.max(10, estimatedLbm))
  };
}

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ActiveTab>("checkin");
  const [hasCompletedOnboarding, setHasCompletedOnboarding] =
    useState<boolean>(false);
  const [userBiometrics, setUserBiometrics] = useState<UserBiometrics>(
    DEFAULT_BASELINE_BIOMETRICS
  );
  const [activeCycle, setActiveCycle] = useState<AdaptivePlanCycle>(() =>
    generate14DayPlan(
      DEFAULT_BASELINE_BIOMETRICS,
      Date.now() - 15 * 24 * 60 * 60 * 1000
    )
  );
  const [weightLogs, setWeightLogs] = useState<readonly WeightLogEntry[]>([
    {
      id: "wlog_baseline",
      timestampMs: Date.now() - 14 * 24 * 60 * 60 * 1000,
      weightKg: 70.0,
      bodyFatPct: 18.5,
      note: "Initial onboarding weight"
    }
  ]);

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

  useEffect(() => {
    let mounted = true;
    const hydrateFromVault = async (): Promise<void> => {
      try {
        const [storedBio, storedCycle, storedLogs] = await Promise.all([
          getUserBiometrics(),
          getActivePlanCycle(),
          getWeightLogs()
        ]);
        if (!mounted) return;
        if (storedBio) {
          setUserBiometrics(storedBio);
          setHasCompletedOnboarding(true);
        }
        if (storedCycle) {
          setActiveCycle(storedCycle);
        }
        if (storedLogs.length > 0) {
          setWeightLogs(storedLogs);
        }
      } catch {
        // Non-fatal in preview environments
      }
    };
    void hydrateFromVault();
    return () => {
      mounted = false;
    };
  }, []);

  const wallet = useMemo(() => Wallet.createRandom(), []);
  const userAddress = wallet.address as Address;

  const userProfile = useMemo(
    () => biometricsToUserProfile(userBiometrics),
    [userBiometrics]
  );

  const targetAssessment = useMemo(
    () => evaluateDailyTarget(userProfile, lastLogTimestampMs, Date.now()),
    [userProfile, lastLogTimestampMs]
  );

  const todayPlan: DailyPlan = useMemo(() => {
    return (
      activeCycle.dailyPlans[0] ??
      generate14DayPlan(userBiometrics, Date.now()).dailyPlans[0]!
    );
  }, [activeCycle, userBiometrics]);

  const handleOnboardingComplete = (
    bio: UserBiometrics,
    plan: AdaptivePlanCycle
  ): void => {
    setUserBiometrics(bio);
    setActiveCycle(plan);
    setWeightLogs([
      {
        id: `wlog_${Date.now()}`,
        timestampMs: Date.now(),
        weightKg: bio.weightKg,
        ...(bio.bodyFatPct !== undefined ? { bodyFatPct: bio.bodyFatPct } : {}),
        note: "Onboarding baseline"
      }
    ]);
    setHasCompletedOnboarding(true);
    setActiveTab("checkin");
  };

  const handleUpdateDailyPlan = (updatedPlan: DailyPlan): void => {
    const nextPlans = activeCycle.dailyPlans.map((p) =>
      p.dayNumber === updatedPlan.dayNumber ? updatedPlan : p
    );
    const nextCycle: AdaptivePlanCycle = {
      ...activeCycle,
      dailyPlans: nextPlans
    };
    setActiveCycle(nextCycle);
    void saveActivePlanCycle(nextCycle).catch(() => undefined);
  };

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
        {!hasCompletedOnboarding ? (
          <OnboardingWizardScreen
            initialBiometrics={userBiometrics}
            onOnboardingComplete={handleOnboardingComplete}
          />
        ) : (
          <>
            {/* Persistent Gamification Top Header */}
            <StreakFlameHeader
              userAddress={userAddress}
              streakCount={streakCount}
              tokenBalanceDht={tokenBalanceDht}
              isFatigueScaled={targetAssessment.isFatigueScaled}
              fitnessTier={targetAssessment.fitnessTier}
              onOpenPerksDrawer={() => setIsPerksDrawerOpen(true)}
            />

            {/* Screen Area */}
            <View style={styles.screenArea}>
              {activeTab === "checkin" ? (
                <MicroCheckInScreen
                  userAddress={userAddress}
                  verifyingContract={DEMO_VERIFYING_CONTRACT}
                  currentStreak={streakCount}
                  currentNonce={currentNonce}
                  signer={wallet}
                  userProfile={userProfile}
                  dailyPlan={todayPlan}
                  lastLogTimestampMs={lastLogTimestampMs}
                  onUpdateDailyPlan={handleUpdateDailyPlan}
                  onDispatchSignedClaim={handleDispatchSignedClaim}
                />
              ) : null}

              {activeTab === "dashboard" ? (
                <DashboardScreen
                  streakCount={streakCount}
                  tokenBalanceDht={tokenBalanceDht}
                  lastProofHash={lastProofHash}
                  targetAssessment={targetAssessment}
                  activeCycle={activeCycle}
                  weightLogs={weightLogs}
                  onLogWeightEntry={(entry) => {
                    setWeightLogs((prev) => [...prev, entry]);
                  }}
                  onUpdatePlanCycle={(nextCycle) => {
                    setActiveCycle(nextCycle);
                  }}
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

            {/* Bottom Navigation Bar */}
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

            {/* Reward Perks Drawer / Modal */}
            <RewardPerksDrawer
              visible={isPerksDrawerOpen}
              tokenBalanceDht={tokenBalanceDht}
              onClose={() => setIsPerksDrawerOpen(false)}
              onRedeemPerk={handleRedeemPerk}
            />
          </>
        )}
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
