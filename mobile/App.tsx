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
  ActivityIndicator,
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
import {
  appendCycleToHistory,
  calculateAdherencePct,
  generate14DayPlan,
  getActiveDayIndex
} from "./src/services/adaptivePlanEngine";
import {
  claimStreakReward,
  DEMO_VERIFYING_CONTRACT,
  fetchOnChainNonce,
  fetchTokenBalance,
  getRewardGateAddress,
  L2ServiceMode
} from "./src/services/l2ContractService";
import {
  fetchAnonymizedFeed,
  publishProofMilestone,
  sendPeerCheer
} from "./src/services/supabaseService";
import { evaluateDailyTarget } from "./src/services/profileEngine";
import {
  getActivePlanCycle,
  getDailyProofSignedMap,
  getPlanHistory,
  getUserBiometrics,
  getWeightLogs,
  makeDailyProofSignedKey,
  purgeAdaptiveStorageKeys,
  saveActivePlanCycle,
  saveDailyProofSigned,
  savePlanHistory
} from "./src/storage/adaptiveStorage";
import { clearVaultSecret } from "./src/storage/vaultKeyProvider";
import {
  clearStoredWallet,
  exportWalletPrivateKey,
  getOrCreatePersistentWallet
} from "./src/storage/walletStorage";

type ActiveTab = "checkin" | "dashboard" | "feed";

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

export interface HydratedVaultState {
  readonly storedBio: UserBiometrics | null;
  readonly storedCycle: AdaptivePlanCycle | null;
  readonly storedLogs: readonly WeightLogEntry[];
  readonly persistentWallet: Wallet;
  readonly proofSignedMap: Readonly<Record<string, boolean>>;
}

export interface VaultHydrationDeps {
  readonly getUserBiometrics: () => Promise<UserBiometrics | null>;
  readonly getActivePlanCycle: () => Promise<AdaptivePlanCycle | null>;
  readonly getWeightLogs: () => Promise<WeightLogEntry[]>;
  readonly getOrCreatePersistentWallet: () => Promise<Wallet>;
  readonly getDailyProofSignedMap: () => Promise<Record<string, boolean>>;
  readonly clearStoredWallet: () => Promise<void>;
  readonly clearVaultSecret: () => Promise<void>;
  readonly purgeAdaptiveStorageKeys: () => Promise<void>;
}

const DEFAULT_VAULT_HYDRATION_DEPS: VaultHydrationDeps = {
  getUserBiometrics,
  getActivePlanCycle,
  getWeightLogs,
  getOrCreatePersistentWallet,
  getDailyProofSignedMap,
  clearStoredWallet,
  clearVaultSecret,
  purgeAdaptiveStorageKeys
};

export async function hydrateVaultData(
  deps: VaultHydrationDeps = DEFAULT_VAULT_HYDRATION_DEPS
): Promise<HydratedVaultState> {
  const [
    storedBio,
    storedCycle,
    storedLogs,
    persistentWallet,
    proofSignedMap
  ] = await Promise.all([
    deps.getUserBiometrics(),
    deps.getActivePlanCycle(),
    deps.getWeightLogs(),
    deps.getOrCreatePersistentWallet(),
    deps.getDailyProofSignedMap()
  ]);

  return {
    storedBio,
    storedCycle,
    storedLogs,
    persistentWallet,
    proofSignedMap
  };
}

export async function resetVaultAndRecover(
  deps: VaultHydrationDeps = DEFAULT_VAULT_HYDRATION_DEPS
): Promise<HydratedVaultState> {
  await deps.clearStoredWallet();
  await deps.clearVaultSecret();
  await deps.purgeAdaptiveStorageKeys();
  return hydrateVaultData(deps);
}

export interface VaultBootGateProps {
  readonly initError: string | null;
  readonly isResetting?: boolean;
  readonly onResetVaultAndRetry: () => void;
}

export const VaultBootGate: React.FC<VaultBootGateProps> = ({
  initError,
  isResetting = false,
  onResetVaultAndRetry
}) => {
  if (initError !== null) {
    return (
      <View
        style={[
          styles.phoneFrame,
          styles.bootErrorContainer
        ]}
      >
        <View style={styles.bootErrorBanner}>
          <Text style={styles.bootErrorTitle}>
            Cryptographic Enclave Error
          </Text>
          <Text style={styles.bootErrorText}>{initError}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset Vault / Retry"
            disabled={isResetting}
            style={({ pressed }) => [
              styles.bootRetryButton,
              isResetting ? styles.bootRetryButtonDisabled : null,
              pressed ? styles.tabButtonPressed : null
            ]}
            onPress={onResetVaultAndRetry}
          >
            <Text style={styles.bootRetryButtonText}>
              {isResetting ? "Resetting Vault..." : "Reset Vault / Retry"}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.phoneFrame,
        { justifyContent: "center", alignItems: "center" }
      ]}
    >
      <ActivityIndicator size="large" color="#10B981" />
      <Text
        style={{
          color: "#94A3B8",
          marginTop: 14,
          fontSize: 13,
          fontWeight: "600"
        }}
      >
        Securing Cryptographic Enclave...
      </Text>
    </View>
  );
};

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
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [lastExplorerUrl, setLastExplorerUrl] = useState<string | null>(null);
  const [lastClaimMode, setLastClaimMode] = useState<L2ServiceMode | null>(null);
  const [proofSignedMap, setProofSignedMap] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [lastLogTimestampMs, setLastLogTimestampMs] = useState<number>(
    () => Date.now() - 50 * 60 * 60 * 1000
  );
  const [feedItems, setFeedItems] =
    useState<readonly AnonymizedFeedRecord[]>(INITIAL_FEED_ITEMS);
  const [cheerCounts, setCheerCounts] =
    useState<Readonly<Record<string, number>>>(INITIAL_CHEERS);
  const [isPerksDrawerOpen, setIsPerksDrawerOpen] = useState<boolean>(false);
  // Wall clock for day-index and adherence; ticks each minute so the active day
  // rolls over at midnight even if the app stays open.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;
    void fetchAnonymizedFeed()
      .then((res) => {
        if (!mounted) return;
        if (res.items && res.items.length > 0) {
          setFeedItems(res.items);
          setCheerCounts(res.cheerCounts);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [isResettingVault, setIsResettingVault] = useState<boolean>(false);

  const applyHydratedState = (
    hydrated: HydratedVaultState,
    isMounted: () => boolean
  ): void => {
    if (!isMounted()) return;
    const {
      storedBio,
      storedCycle,
      storedLogs,
      persistentWallet,
      proofSignedMap: hydratedProofMap
    } = hydrated;
    setInitError(null);
    setWallet(persistentWallet);
    setProofSignedMap(hydratedProofMap);

    const addr = persistentWallet.address as Address;
    void fetchOnChainNonce(addr, 0n)
      .then((nonce) => {
        if (isMounted()) setCurrentNonce(nonce);
      })
      .catch(() => undefined);
    void fetchTokenBalance(addr, "30.0")
      .then((bal) => {
        if (isMounted()) setTokenBalanceDht(bal);
      })
      .catch(() => undefined);

    if (storedBio) {
      setUserBiometrics(storedBio);
      setHasCompletedOnboarding(true);
    } else {
      setUserBiometrics(DEFAULT_BASELINE_BIOMETRICS);
      setHasCompletedOnboarding(false);
    }
    if (storedCycle) {
      setActiveCycle(storedCycle);
    }
    if (storedLogs.length > 0) {
      setWeightLogs(storedLogs);
    }
  };

  useEffect(() => {
    let mounted = true;
    const hydrateFromVault = async (): Promise<void> => {
      try {
        const hydrated = await hydrateVaultData();
        applyHydratedState(hydrated, () => mounted);
      } catch (err: unknown) {
        if (!mounted) return;
        const message =
          err instanceof Error
            ? err.message
            : "Failed to initialize local cryptographic enclave.";
        setInitError(message);
      }
    };
    void hydrateFromVault();
    return () => {
      mounted = false;
    };
  }, []);

  const handleResetVaultAndRetry = async (): Promise<void> => {
    if (isResettingVault) return;
    setIsResettingVault(true);
    setInitError(null);
    try {
      const recovered = await resetVaultAndRecover();
      setLastProofHash(null);
      setLastTxHash(null);
      setLastExplorerUrl(null);
      setLastClaimMode(null);
      setActiveCycle(
        generate14DayPlan(
          DEFAULT_BASELINE_BIOMETRICS,
          Date.now() - 15 * 24 * 60 * 60 * 1000
        )
      );
      setWeightLogs([
        {
          id: "wlog_baseline",
          timestampMs: Date.now() - 14 * 24 * 60 * 60 * 1000,
          weightKg: 70.0,
          bodyFatPct: 18.5,
          note: "Initial onboarding weight"
        }
      ]);
      applyHydratedState(recovered, () => true);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Vault recovery failed. Please try again.";
      setInitError(message);
    } finally {
      setIsResettingVault(false);
    }
  };

  const userAddress = (wallet ? wallet.address : "0x0000000000000000000000000000000000000000") as Address;

  const userProfile = useMemo(
    () => biometricsToUserProfile(userBiometrics),
    [userBiometrics]
  );

  const targetAssessment = useMemo(
    () => evaluateDailyTarget(userProfile, lastLogTimestampMs, Date.now()),
    [userProfile, lastLogTimestampMs]
  );

  const activeDayIndex = useMemo<number>(
    () => getActiveDayIndex(activeCycle.startDateMs, nowMs),
    [activeCycle.startDateMs, nowMs]
  );

  const isTodayProofSigned = Boolean(
    proofSignedMap[makeDailyProofSignedKey(activeCycle.id, activeDayIndex)]
  );

  const todayPlan: DailyPlan = useMemo(() => {
    return (
      activeCycle.dailyPlans[activeDayIndex] ??
      generate14DayPlan(userBiometrics, nowMs).dailyPlans[0]!
    );
  }, [activeCycle, activeDayIndex, userBiometrics, nowMs]);

  const adherencePct = useMemo<number>(
    () => calculateAdherencePct(activeCycle, nowMs),
    [activeCycle, nowMs]
  );

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

  const handleApprovePlan = async (
    nextCycle: AdaptivePlanCycle,
    completedPreviousCycle?: AdaptivePlanCycle
  ): Promise<void> => {
    setActiveCycle(nextCycle);
    if (!completedPreviousCycle) {
      return;
    }
    // Archive the finished 14-day cycle so plan history survives approval.
    try {
      const history = await getPlanHistory();
      await savePlanHistory(appendCycleToHistory(history, completedPreviousCycle));
    } catch {
      // Non-fatal: the new cycle is already active and persisted by the dashboard.
    }
  };

  const handleDispatchSignedClaim = async (
    payload: SignedWorkoutClaimPayload
  ): Promise<void> => {
    // 1. Submit on-chain claim or fallback receipt
    const claimResult = await claimStreakReward(payload, wallet ?? undefined);
    setLastTxHash(claimResult.txHash);
    setLastExplorerUrl(claimResult.mode === "live" ? claimResult.explorerUrl : null);
    setLastClaimMode(claimResult.mode);

    const proofSignedKey = makeDailyProofSignedKey(activeCycle.id, activeDayIndex);
    setProofSignedMap((prev) => ({
      ...prev,
      [proofSignedKey]: true
    }));
    void saveDailyProofSigned(activeCycle.id, activeDayIndex, true).catch(
      () => undefined
    );

    const nextStreak = Number(payload.proof.streakCount);
    const expectedBalance = (Number.parseFloat(tokenBalanceDht) + 10).toFixed(1);

    // 2. Publish milestone to Supabase (strict data sovereignty: pseudonym, proof_hash, streak_count)
    const userPseudonym = `athlete_${userAddress.slice(2, 8).toLowerCase()}`;
    const milestoneResult = await publishProofMilestone({
      user_pseudonym: userPseudonym,
      proof_hash: payload.proof.telemetryHash,
      streak_count: nextStreak
    });

    setStreakCount(nextStreak);
    setLastProofHash(payload.proof.telemetryHash);
    setLastLogTimestampMs(Date.now());

    // Update feed items and cheer counts
    setFeedItems((prev) => [
      milestoneResult.data,
      ...prev.filter((i) => i.id !== milestoneResult.data.id)
    ]);
    setCheerCounts((prev) => ({
      ...prev,
      [milestoneResult.data.id]: 0
    }));

    // 3. Update nonce and DHT token balance from L2 service
    const updatedNonce = await fetchOnChainNonce(userAddress, currentNonce + 1n);
    setCurrentNonce(updatedNonce);

    const updatedBalance = await fetchTokenBalance(userAddress, expectedBalance);
    setTokenBalanceDht(updatedBalance);
  };

  const handleCheer = (feedId: string): void => {
    setCheerCounts((prev) => ({
      ...prev,
      [feedId]: (prev[feedId] ?? 0) + 1
    }));
    const senderPseudonym = `athlete_${userAddress.slice(2, 8).toLowerCase()}`;
    void sendPeerCheer(feedId, senderPseudonym).catch(() => undefined);
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

  if (!wallet || initError !== null) {
    return (
      <SafeAreaView style={styles.viewport}>
        <VaultBootGate
          initError={initError}
          isResetting={isResettingVault}
          onResetVaultAndRetry={() => {
            void handleResetVaultAndRetry();
          }}
        />
      </SafeAreaView>
    );
  }

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
                  verifyingContract={getRewardGateAddress() || DEMO_VERIFYING_CONTRACT}
                  currentStreak={streakCount}
                  currentNonce={currentNonce}
                  signer={wallet}
                  userProfile={userProfile}
                  dailyPlan={todayPlan}
                  cycleId={activeCycle.id}
                  isProofSigned={isTodayProofSigned}
                  lastLogTimestampMs={lastLogTimestampMs}
                  onUpdateDailyPlan={handleUpdateDailyPlan}
                  onDispatchSignedClaim={handleDispatchSignedClaim}
                  lastTxHash={lastTxHash}
                  lastExplorerUrl={lastExplorerUrl}
                  lastClaimMode={lastClaimMode}
                />
              ) : null}

              {activeTab === "dashboard" ? (
                <DashboardScreen
                  userAddress={userAddress}
                  onExportPrivateKey={exportWalletPrivateKey}
                  streakCount={streakCount}
                  tokenBalanceDht={tokenBalanceDht}
                  lastProofHash={lastProofHash}
                  lastTxHash={lastTxHash}
                  lastExplorerUrl={lastExplorerUrl}
                  lastClaimMode={lastClaimMode}
                  targetAssessment={targetAssessment}
                  activeCycle={activeCycle}
                  todayPlan={todayPlan}
                  weightLogs={weightLogs}
                  adherencePct={adherencePct}
                  currentTimestampMs={nowMs}
                  onLogWeightEntry={(entry) => {
                    setWeightLogs((prev) => [...prev, entry]);
                  }}
                  onUpdatePlanCycle={handleApprovePlan}
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
  },
  bootErrorContainer: {
    justifyContent: "center",
    alignItems: "center",
    padding: 24
  },
  bootErrorBanner: {
    width: "100%",
    backgroundColor: "#1F1215",
    borderWidth: 1,
    borderColor: "#EF4444",
    borderRadius: 16,
    padding: 18
  },
  bootErrorTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#FCA5A5",
    marginBottom: 8
  },
  bootErrorText: {
    fontSize: 13,
    color: "#FECACA",
    lineHeight: 19,
    marginBottom: 16
  },
  bootRetryButton: {
    backgroundColor: "#EF4444",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center"
  },
  bootRetryButtonDisabled: {
    opacity: 0.6
  },
  bootRetryButtonText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#FFFFFF"
  }
});
