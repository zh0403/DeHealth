import {
  AdaptivePlanCycle,
  Address,
  AnonymizedFeedRecord,
  AuthSessionMetadata,
  Bytes32,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  SignedWorkoutClaimPayload,
  UserBiometrics,
  UserProfile,
  WeightLogEntry
} from "@dehealth/shared";
import { Signer, Wallet } from "ethers";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  ErrorNoticeModal,
  ErrorNoticePayload,
  toErrorNoticePayload
} from "./src/components/ErrorNoticeModal";
import { RewardPerksDrawer } from "./src/components/RewardPerksDrawer";
import { StreakFlameHeader } from "./src/components/StreakFlameHeader";
import { AnonymizedFeedScreen } from "./src/screens/AnonymizedFeedScreen";
import { DashboardScreen } from "./src/screens/DashboardScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { MicroCheckInScreen } from "./src/screens/MicroCheckInScreen";
import { OnboardingWizardScreen } from "./src/screens/OnboardingWizardScreen";
import {
  appendCycleToHistory,
  calculateAdherencePct,
  calculateLiveStreak,
  generate14DayPlan,
  getActiveDayIndex
} from "./src/services/adaptivePlanEngine";
import {
  AuthError,
  AuthSignInResult,
  clearPersistedAuthSession,
  getPersistedAuthSession,
  getWalletConnectProjectId,
  handleIncomingOAuthRedirectUrl,
  purgeAuthSessionStorageKey,
  restoreExternalWalletSignerOnBoot,
  signInWithGoogle,
  signInWithMetaMask,
  signInWithWalletConnect,
  signOutSession,
  startLocalSession
} from "./src/services/authService";
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
  fetchCheeredFeedIdsForUser,
  isDuplicateCheerError,
  isSupabaseConfigured,
  publishProofMilestone,
  sendPeerCheer
} from "./src/services/supabaseService";
import { evaluateDailyTarget } from "./src/services/profileEngine";
import {
  DailyEphemeralLogBuffer,
  EphemeralBufferRolloverResult,
  formatLocalCalendarDateKey,
  getActivePlanCycle,
  getDailyProofSignedMap,
  getPlanHistory,
  getUserBiometrics,
  getWeightLogs,
  makeDailyProofSignedKey,
  purgeAdaptiveStorageKeys,
  purgeDailyEphemeralLogBuffer,
  rolloverStaleDailyEphemeralLogBuffer,
  saveActivePlanCycle,
  saveDailyProofSigned,
  savePlanHistory,
  saveWeightLog
} from "./src/storage/adaptiveStorage";
import {
  DEFAULT_GOVERNANCE_CONFIG,
  getGovernanceConfig,
  GovernanceConfig,
  purgeGovernanceStorageKey
} from "./src/storage/governanceStorage";
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

/**
 * Selects the signer for an on-chain claim. External wallet sessions must use
 * their connected external signer and never fall back to the local embedded
 * wallet, which would sign for an address it does not control.
 */
export function resolveClaimSigner(
  session: AuthSessionMetadata | null,
  externalSigner: Signer | null,
  localWallet: Signer | null
): Signer | undefined {
  const isExternalSession =
    session?.authMethod === "metamask" ||
    session?.authMethod === "walletconnect";
  if (isExternalSession) {
    if (!externalSigner) {
      throw new AuthError(
        "External wallet signer is disconnected. Please sign in again before signing."
      );
    }
    return externalSigner;
  }
  return localWallet ?? undefined;
}

export interface DerivedVaultMetrics {
  readonly streakCount: number;
  readonly fallbackBalanceDht: string;
  readonly lastLogTimestampMs: number | null;
}

export function deriveLiveMetricsFromVault(
  cycle: AdaptivePlanCycle,
  proofSignedMap: Readonly<Record<string, boolean>>,
  nowMs: number = Date.now()
): DerivedVaultMetrics {
  const streakCount = calculateLiveStreak(cycle, proofSignedMap, nowMs);
  const signedDaysCount = cycle.dailyPlans.reduce((count, plan, idx) => {
    const key =
      cycle.id.trim().length > 0
        ? makeDailyProofSignedKey(cycle.id, idx)
        : "";
    const isSigned =
      plan.completed || (key.length > 0 && proofSignedMap[key] === true);
    return isSigned ? count + 1 : count;
  }, 0);
  const fallbackBalanceDht = (
    Math.max(streakCount, signedDaysCount) * 10
  ).toFixed(1);

  let latestLogMs: number | null = null;
  for (let idx = 0; idx < cycle.dailyPlans.length; idx += 1) {
    const plan = cycle.dailyPlans[idx];
    if (!plan) continue;
    const key =
      cycle.id.trim().length > 0
        ? makeDailyProofSignedKey(cycle.id, idx)
        : "";
    const isSigned =
      plan.completed || (key.length > 0 && proofSignedMap[key] === true);
    if (!isSigned) continue;
    const parsedMs = Date.parse(`${plan.date}T00:00:00.000Z`);
    const dayMs = Number.isFinite(parsedMs)
      ? parsedMs
      : cycle.startDateMs + idx * 24 * 60 * 60 * 1000;
    if (latestLogMs === null || dayMs > latestLogMs) {
      latestLogMs = dayMs;
    }
  }

  return {
    streakCount,
    fallbackBalanceDht,
    lastLogTimestampMs: latestLogMs
  };
}

export interface HydratedVaultState {
  readonly storedBio: UserBiometrics | null;
  readonly storedCycle: AdaptivePlanCycle | null;
  readonly storedLogs: readonly WeightLogEntry[];
  readonly persistentWallet: Wallet;
  readonly proofSignedMap: Readonly<Record<string, boolean>>;
  readonly governanceConfig: GovernanceConfig;
  readonly storedAuthSession: AuthSessionMetadata | null;
  readonly externalSigner?: Signer | null;
  readonly activeEphemeralBuffer?: DailyEphemeralLogBuffer | null;
}

export interface VaultHydrationDeps {
  readonly getUserBiometrics: () => Promise<UserBiometrics | null>;
  readonly getActivePlanCycle: () => Promise<AdaptivePlanCycle | null>;
  readonly getWeightLogs: () => Promise<WeightLogEntry[]>;
  readonly getOrCreatePersistentWallet: () => Promise<Wallet>;
  readonly getDailyProofSignedMap: () => Promise<Record<string, boolean>>;
  readonly getGovernanceConfig?: () => Promise<GovernanceConfig>;
  readonly getPersistedAuthSession?: () => Promise<AuthSessionMetadata | null>;
  readonly restoreExternalSigner?: (
    session: AuthSessionMetadata
  ) => Promise<Signer | null>;
  readonly clearPersistedAuthSession?: () => Promise<void>;
  readonly rolloverStaleDailyEphemeralLogBuffer?: (
    todayDateKey?: string
  ) => Promise<EphemeralBufferRolloverResult>;
  readonly clearStoredWallet: () => Promise<void>;
  readonly clearVaultSecret: () => Promise<void>;
  readonly purgeAdaptiveStorageKeys: () => Promise<void>;
  readonly purgeGovernanceStorageKey?: () => Promise<void>;
  readonly purgeAuthSessionStorageKey?: () => Promise<void>;
}

const DEFAULT_VAULT_HYDRATION_DEPS: VaultHydrationDeps = {
  getUserBiometrics,
  getActivePlanCycle,
  getWeightLogs,
  getOrCreatePersistentWallet,
  getDailyProofSignedMap,
  getGovernanceConfig,
  getPersistedAuthSession,
  restoreExternalSigner: restoreExternalWalletSignerOnBoot,
  clearPersistedAuthSession,
  rolloverStaleDailyEphemeralLogBuffer,
  clearStoredWallet,
  clearVaultSecret,
  purgeAdaptiveStorageKeys,
  purgeGovernanceStorageKey,
  purgeAuthSessionStorageKey
};

export async function hydrateVaultData(
  deps: VaultHydrationDeps = DEFAULT_VAULT_HYDRATION_DEPS
): Promise<HydratedVaultState> {
  const resolveGov = deps.getGovernanceConfig ?? getGovernanceConfig;
  const resolveAuth = deps.getPersistedAuthSession ?? getPersistedAuthSession;
  const resolveRestoreSigner =
    deps.restoreExternalSigner ?? restoreExternalWalletSignerOnBoot;
  const resolveClearAuth =
    deps.clearPersistedAuthSession ?? clearPersistedAuthSession;
  const resolveRollover =
    deps.rolloverStaleDailyEphemeralLogBuffer ??
    rolloverStaleDailyEphemeralLogBuffer;
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

  // Hydrate governance, auth session, and daily rollover after primary vault
  // provisioning completes so independent keystore handles never race on boot.
  const governanceConfig = await resolveGov();
  const storedAuthSession = await resolveAuth();
  let effectiveAuthSession: AuthSessionMetadata | null = storedAuthSession;
  let externalSigner: Signer | null = null;

  if (
    storedAuthSession &&
    (storedAuthSession.authMethod === "metamask" ||
      storedAuthSession.authMethod === "walletconnect")
  ) {
    try {
      externalSigner = await resolveRestoreSigner(storedAuthSession);
    } catch {
      externalSigner = null;
    }
    if (!externalSigner) {
      await resolveClearAuth();
      effectiveAuthSession = null;
    }
  }

  const rolloverResult = await resolveRollover(formatLocalCalendarDateKey());

  return {
    storedBio,
    storedCycle,
    storedLogs,
    persistentWallet,
    proofSignedMap,
    governanceConfig,
    storedAuthSession: effectiveAuthSession,
    externalSigner,
    activeEphemeralBuffer: rolloverResult.activeBuffer
  };
}

export async function resetVaultAndRecover(
  deps: VaultHydrationDeps = DEFAULT_VAULT_HYDRATION_DEPS
): Promise<HydratedVaultState> {
  await deps.clearStoredWallet();
  await deps.clearVaultSecret();
  await deps.purgeAdaptiveStorageKeys();
  const purgeGov = deps.purgeGovernanceStorageKey ?? purgeGovernanceStorageKey;
  await purgeGov();
  const purgeAuth = deps.purgeAuthSessionStorageKey ?? purgeAuthSessionStorageKey;
  await purgeAuth();
  return hydrateVaultData(deps);
}

export interface VaultBootGateProps {
  readonly initError: string | null;
  readonly isRetrying?: boolean;
  readonly isResetting?: boolean;
  readonly onRetry: () => void;
  readonly onResetVault: () => void;
  readonly initialConfirmReset?: boolean;
}

export const VaultBootGate: React.FC<VaultBootGateProps> = ({
  initError,
  isRetrying = false,
  isResetting = false,
  onRetry,
  onResetVault,
  initialConfirmReset = false
}) => {
  const [confirmReset, setConfirmReset] = useState<boolean>(initialConfirmReset);

  useEffect(() => {
    setConfirmReset(initialConfirmReset);
  }, [initError, initialConfirmReset]);

  const isBusy = isRetrying || isResetting;

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
            accessibilityLabel="Retry"
            disabled={isBusy}
            style={({ pressed }) => [
              styles.bootRetryPrimaryButton,
              isBusy ? styles.bootRetryButtonDisabled : null,
              pressed ? styles.tabButtonPressed : null
            ]}
            onPress={onRetry}
          >
            <Text style={styles.bootRetryPrimaryButtonText}>
              {isRetrying ? "Retrying..." : "Retry"}
            </Text>
          </Pressable>

          {!confirmReset ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reset Vault (Erases Wallet)"
              disabled={isBusy}
              style={({ pressed }) => [
                styles.bootResetSecondaryButton,
                isBusy ? styles.bootRetryButtonDisabled : null,
                pressed ? styles.tabButtonPressed : null
              ]}
              onPress={() => {
                setConfirmReset(true);
              }}
            >
              <Text style={styles.bootResetSecondaryButtonText}>
                Reset Vault (Erases Wallet)
              </Text>
            </Pressable>
          ) : (
            <View style={styles.bootConfirmBox}>
              <Text style={styles.bootConfirmWarningText}>
                Warning: Resetting the vault permanently erases any unbacked-up
                private key and all locally encrypted biometric, plan, and
                governance records.
              </Text>
              <View style={styles.bootConfirmBtnRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Confirm Reset Vault"
                  disabled={isBusy}
                  style={({ pressed }) => [
                    styles.bootConfirmResetButton,
                    isBusy ? styles.bootRetryButtonDisabled : null,
                    pressed ? styles.tabButtonPressed : null
                  ]}
                  onPress={onResetVault}
                >
                  <Text style={styles.bootRetryButtonText}>
                    {isResetting ? "Resetting Vault..." : "Confirm Reset Vault"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  disabled={isBusy}
                  style={({ pressed }) => [
                    styles.bootCancelResetButton,
                    isBusy ? styles.bootRetryButtonDisabled : null,
                    pressed ? styles.tabButtonPressed : null
                  ]}
                  onPress={() => {
                    setConfirmReset(false);
                  }}
                >
                  <Text style={styles.bootCancelResetButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}
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
    generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, Date.now())
  );
  const [weightLogs, setWeightLogs] = useState<readonly WeightLogEntry[]>([]);

  const [streakCount, setStreakCount] = useState<number>(0);
  const [tokenBalanceDht, setTokenBalanceDht] = useState<string>("0.0");
  const [currentNonce, setCurrentNonce] = useState<bigint>(0n);
  const [lastProofHash, setLastProofHash] = useState<Bytes32 | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [lastExplorerUrl, setLastExplorerUrl] = useState<string | null>(null);
  const [lastClaimMode, setLastClaimMode] = useState<L2ServiceMode | null>(null);
  const [proofSignedMap, setProofSignedMap] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [lastLogTimestampMs, setLastLogTimestampMs] = useState<number | null>(
    null
  );
  const [feedItems, setFeedItems] =
    useState<readonly AnonymizedFeedRecord[]>(INITIAL_FEED_ITEMS);
  const [cheerCounts, setCheerCounts] =
    useState<Readonly<Record<string, number>>>(INITIAL_CHEERS);
  const [isPerksDrawerOpen, setIsPerksDrawerOpen] = useState<boolean>(false);
  const [errorNotice, setErrorNotice] = useState<ErrorNoticePayload | null>(
    null
  );
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
  const [externalSigner, setExternalSigner] = useState<Signer | null>(null);
  const [authSession, setAuthSession] = useState<AuthSessionMetadata | null>(
    null
  );
  const [cheeredFeedIds, setCheeredFeedIds] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [initError, setInitError] = useState<string | null>(null);
  const [isRetryingVault, setIsRetryingVault] = useState<boolean>(false);
  const [isResettingVault, setIsResettingVault] = useState<boolean>(false);
  const [governanceConfig, setGovernanceConfig] = useState<GovernanceConfig>(
    DEFAULT_GOVERNANCE_CONFIG
  );

  const activeDateKey = useMemo<string>(
    () => formatLocalCalendarDateKey(nowMs),
    [nowMs]
  );

  const activeWalletAddress = (
    authSession?.walletAddress ??
    (wallet ? wallet.address : "0x0000000000000000000000000000000000000000")
  ) as Address;

  useEffect(() => {
    if (!wallet) {
      return;
    }
    let mounted = true;
    const senderPseudonym = `athlete_${activeWalletAddress.slice(2, 8).toLowerCase()}`;
    void fetchCheeredFeedIdsForUser(senderPseudonym)
      .then((cheeredMap) => {
        if (mounted) {
          setCheeredFeedIds(cheeredMap);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [wallet, authSession, activeWalletAddress]);

  useEffect(() => {
    if (!wallet) {
      return;
    }
    void rolloverStaleDailyEphemeralLogBuffer(activeDateKey).catch(
      () => undefined
    );
  }, [wallet, activeDateKey]);

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
      proofSignedMap: hydratedProofMap,
      governanceConfig: hydratedGovernance,
      storedAuthSession
    } = hydrated;
    const currentNowMs = Date.now();
    const effectiveHydratedCycle =
      storedCycle ??
      generate14DayPlan(
        storedBio ?? DEFAULT_BASELINE_BIOMETRICS,
        currentNowMs
      );
    const derived = deriveLiveMetricsFromVault(
      effectiveHydratedCycle,
      hydratedProofMap,
      currentNowMs
    );

    setInitError(null);
    setWallet(persistentWallet);
    setExternalSigner(hydrated.externalSigner ?? null);
    setAuthSession(storedAuthSession);
    setProofSignedMap(hydratedProofMap);
    setGovernanceConfig(hydratedGovernance);
    setActiveCycle(effectiveHydratedCycle);
    setWeightLogs(storedLogs);
    setStreakCount(derived.streakCount);
    setTokenBalanceDht(derived.fallbackBalanceDht);
    setLastLogTimestampMs(derived.lastLogTimestampMs);

    const addr = (storedAuthSession?.walletAddress ??
      persistentWallet.address) as Address;
    void fetchOnChainNonce(addr, 0n)
      .then((nonce) => {
        if (isMounted()) setCurrentNonce(nonce);
      })
      .catch(() => undefined);
    void fetchTokenBalance(addr, derived.fallbackBalanceDht)
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

  const handleRetryVaultBoot = async (): Promise<void> => {
    if (isRetryingVault || isResettingVault) return;
    setIsRetryingVault(true);
    try {
      const hydrated = await hydrateVaultData();
      applyHydratedState(hydrated, () => true);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to initialize local cryptographic enclave.";
      setInitError(message);
    } finally {
      setIsRetryingVault(false);
    }
  };

  const handleResetVaultAndRetry = async (): Promise<void> => {
    if (isResettingVault || isRetryingVault) return;
    setIsResettingVault(true);
    try {
      const recovered = await resetVaultAndRecover();
      setAuthSession(null);
      setExternalSigner(null);
      setCheeredFeedIds({});
      setLastProofHash(null);
      setLastTxHash(null);
      setLastExplorerUrl(null);
      setLastClaimMode(null);
      setErrorNotice(null);
      setCurrentNonce(0n);
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

  const embeddedWalletAddress = (
    wallet
      ? wallet.address
      : "0x0000000000000000000000000000000000000000"
  ) as Address;

  const showErrorNotice = (err: unknown, fallbackTitle: string): void => {
    setErrorNotice(toErrorNoticePayload(err, fallbackTitle, activeWalletAddress));
  };

  const clearErrorNotice = (): void => {
    setErrorNotice(null);
  };

  const userProfile = useMemo(
    () => biometricsToUserProfile(userBiometrics),
    [userBiometrics]
  );

  const targetAssessment = useMemo(
    () =>
      evaluateDailyTarget(userProfile, lastLogTimestampMs, Date.now(), {
        inactivityThresholdHours: governanceConfig.inactivityThresholdHours,
        fatigueScalingMultiplier: governanceConfig.fatigueScalingMultiplier
      }),
    [userProfile, lastLogTimestampMs, governanceConfig]
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
    const onboardingNowMs = Date.now();
    const initialWeightLog: WeightLogEntry = {
      id: `wlog_${onboardingNowMs}`,
      timestampMs: onboardingNowMs,
      weightKg: bio.weightKg,
      ...(bio.bodyFatPct !== undefined ? { bodyFatPct: bio.bodyFatPct } : {}),
      note: "Onboarding baseline"
    };
    setUserBiometrics(bio);
    setActiveCycle(plan);
    setWeightLogs([initialWeightLog]);
    void saveWeightLog(initialWeightLog).catch(() => undefined);
    setStreakCount(calculateLiveStreak(plan, proofSignedMap, onboardingNowMs));
    setLastLogTimestampMs(null);
    setHasCompletedOnboarding(true);
    setActiveTab("dashboard");
  };

  const applyAuthenticatedResult = (authResult: AuthSignInResult): void => {
    const previousAddress = activeWalletAddress.toLowerCase();
    const nextAddress = authResult.walletAddress.toLowerCase();
    if (authResult.wallet) {
      setWallet(authResult.wallet);
    }
    setExternalSigner(
      authResult.session.authMethod === "metamask" ||
        authResult.session.authMethod === "walletconnect"
        ? authResult.signer
        : null
    );
    setAuthSession(authResult.session);

    if (previousAddress !== nextAddress) {
      const nextAddr = authResult.walletAddress;
      const derived = deriveLiveMetricsFromVault(
        activeCycle,
        proofSignedMap,
        Date.now()
      );
      setStreakCount(derived.streakCount);
      setTokenBalanceDht(derived.fallbackBalanceDht);
      setLastLogTimestampMs(derived.lastLogTimestampMs);
      void fetchOnChainNonce(nextAddr, 0n)
        .then((nonce) => setCurrentNonce(nonce))
        .catch(() => undefined);
      void fetchTokenBalance(nextAddr, derived.fallbackBalanceDht)
        .then((bal) => setTokenBalanceDht(bal))
        .catch(() => undefined);
    }
  };

  const applyAuthenticatedResultRef = useRef<
    (authResult: AuthSignInResult) => void
  >(() => undefined);
  applyAuthenticatedResultRef.current = applyAuthenticatedResult;

  const showErrorNoticeRef = useRef<
    (err: unknown, fallbackTitle: string) => void
  >(() => undefined);
  showErrorNoticeRef.current = showErrorNotice;

  useEffect(() => {
    let mounted = true;
    const handledUrls = new Set<string>();

    void import("expo-web-browser")
      .then((wb) => {
        if (typeof wb.maybeCompleteAuthSession === "function") {
          wb.maybeCompleteAuthSession();
        }
      })
      .catch(() => undefined);

    const processIncomingOAuthUrl = async (
      url: string | null | undefined
    ): Promise<void> => {
      if (typeof url !== "string" || url.trim().length === 0) {
        return;
      }
      const trimmed = url.trim();
      if (handledUrls.has(trimmed)) {
        return;
      }
      handledUrls.add(trimmed);
      try {
        const result = await handleIncomingOAuthRedirectUrl(trimmed);
        if (mounted && result) {
          applyAuthenticatedResultRef.current(result);
        }
      } catch (err: unknown) {
        if (mounted) {
          showErrorNoticeRef.current(err, "Google Authentication Failed");
        }
      }
    };

    if (typeof Linking?.getInitialURL === "function") {
      void Linking.getInitialURL()
        .then((initialUrl) => processIncomingOAuthUrl(initialUrl))
        .catch(() => undefined);
    }

    const subscription =
      typeof Linking?.addEventListener === "function"
        ? Linking.addEventListener("url", (event: { readonly url: string }) => {
            void processIncomingOAuthUrl(event?.url);
          })
        : null;

    return () => {
      mounted = false;
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove();
      }
    };
  }, []);

  const handleSignInWithGoogle = async (): Promise<void> => {
    const authResult = isSupabaseConfigured()
      ? await signInWithGoogle()
      : await startLocalSession();
    applyAuthenticatedResult(authResult);
  };

  const handleSignInWithMetaMask = async (): Promise<void> => {
    const authResult = await signInWithMetaMask();
    applyAuthenticatedResult(authResult);
  };

  const handleSignInWithWalletConnect = async (): Promise<void> => {
    const authResult = await signInWithWalletConnect();
    applyAuthenticatedResult(authResult);
  };

  const handleSignOut = async (): Promise<void> => {
    await signOutSession();
    setAuthSession(null);
    setExternalSigner(null);
  };

  const handleLogWeightEntry = (entry: WeightLogEntry): void => {
    setWeightLogs((prev) =>
      [...prev.filter((item) => item.id !== entry.id), entry].sort(
        (a, b) => a.timestampMs - b.timestampMs
      )
    );
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
    void saveActivePlanCycle(nextCycle).catch((err: unknown) => {
      showErrorNotice(err, "Plan Persistence Failed");
    });
  };

  const handleApprovePlan = async (
    nextCycle: AdaptivePlanCycle,
    completedPreviousCycle?: AdaptivePlanCycle
  ): Promise<void> => {
    try {
      setActiveCycle(nextCycle);
      if (!completedPreviousCycle) {
        return;
      }
      // Archive the finished 14-day cycle so plan history survives approval.
      const history = await getPlanHistory();
      await savePlanHistory(
        appendCycleToHistory(history, completedPreviousCycle)
      );
    } catch (err: unknown) {
      showErrorNotice(err, "Plan Approval Failed");
    }
  };

  const handleDispatchSignedClaim = async (
    payload: SignedWorkoutClaimPayload
  ): Promise<void> => {
    try {
      // 1. Submit on-chain claim or fallback receipt (runs L2 gas pre-check first)
      const signingWallet = resolveClaimSigner(
        authSession,
        externalSigner,
        wallet
      );
      const claimResult = await claimStreakReward(payload, signingWallet);
      setLastTxHash(claimResult.txHash);
      setLastExplorerUrl(
        claimResult.mode === "live" ? claimResult.explorerUrl : null
      );
      setLastClaimMode(claimResult.mode);

      const proofSignedKey = makeDailyProofSignedKey(
        activeCycle.id,
        activeDayIndex
      );
      setProofSignedMap((prev) => ({
        ...prev,
        [proofSignedKey]: true
      }));
      void saveDailyProofSigned(activeCycle.id, activeDayIndex, true).catch(
        () => undefined
      );
      await purgeDailyEphemeralLogBuffer().catch(() => undefined);

      const nextStreak = Number(payload.proof.streakCount);
      const expectedBalance = (Number.parseFloat(tokenBalanceDht) + 10).toFixed(
        1
      );

      // 2. Publish milestone to Supabase (strict data sovereignty + EIP-712 proof gate)
      const userPseudonym = `athlete_${activeWalletAddress.slice(2, 8).toLowerCase()}`;
      const verifyingContract = getRewardGateAddress() || DEMO_VERIFYING_CONTRACT;
      const milestoneResult = await publishProofMilestone(
        {
          user_pseudonym: userPseudonym,
          proof_hash: payload.proof.telemetryHash,
          streak_count: nextStreak
        },
        payload,
        verifyingContract
      );

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
      const updatedNonce = await fetchOnChainNonce(
        activeWalletAddress,
        currentNonce + 1n
      );
      setCurrentNonce(updatedNonce);

      const updatedBalance = await fetchTokenBalance(
        activeWalletAddress,
        expectedBalance
      );
      setTokenBalanceDht(updatedBalance);
    } catch (err: unknown) {
      showErrorNotice(err, "Check-In Proof Failed");
      throw err;
    }
  };

  const handleCheer = async (feedId: string): Promise<void> => {
    if (cheeredFeedIds[feedId]) {
      return;
    }
    setCheerCounts((prev) => ({
      ...prev,
      [feedId]: (prev[feedId] ?? 0) + 1
    }));
    const senderPseudonym = `athlete_${activeWalletAddress.slice(2, 8).toLowerCase()}`;
    try {
      await sendPeerCheer(feedId, senderPseudonym);
      setCheeredFeedIds((prev) => ({
        ...prev,
        [feedId]: true
      }));
    } catch (err: unknown) {
      setCheerCounts((prev) => ({
        ...prev,
        [feedId]: Math.max(0, (prev[feedId] ?? 1) - 1)
      }));
      if (isDuplicateCheerError(err)) {
        setCheeredFeedIds((prev) => ({
          ...prev,
          [feedId]: true
        }));
        showErrorNotice(err, "Already Cheered");
      } else {
        showErrorNotice(err, "Peer Cheer Failed");
      }
      throw err;
    }
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
          isRetrying={isRetryingVault}
          isResetting={isResettingVault}
          onRetry={() => {
            void handleRetryVaultBoot();
          }}
          onResetVault={() => {
            void handleResetVaultAndRetry();
          }}
        />
      </SafeAreaView>
    );
  }

  const activeSigner: Signer = externalSigner ?? wallet;

  return (
    <SafeAreaView style={styles.viewport}>
      <View style={styles.phoneFrame}>
        {!authSession ? (
          <LoginScreen
            onSignInWithGoogle={handleSignInWithGoogle}
            onSignInWithMetaMask={handleSignInWithMetaMask}
            onSignInWithWalletConnect={handleSignInWithWalletConnect}
            isSupabaseConfigured={isSupabaseConfigured()}
            isWalletConnectConfigured={getWalletConnectProjectId() !== null}
            existingWalletAddress={embeddedWalletAddress}
            onError={(err) => {
              showErrorNotice(err, "Authentication Failed");
            }}
          />
        ) : !hasCompletedOnboarding ? (
          <OnboardingWizardScreen
            initialBiometrics={userBiometrics}
            onOnboardingComplete={handleOnboardingComplete}
            onError={(err) => {
              showErrorNotice(err, "Onboarding Failed");
            }}
          />
        ) : (
          <>
            {/* Persistent Gamification Top Header */}
            <StreakFlameHeader
              userAddress={activeWalletAddress}
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
                  userAddress={activeWalletAddress}
                  verifyingContract={getRewardGateAddress() || DEMO_VERIFYING_CONTRACT}
                  currentStreak={streakCount}
                  currentNonce={currentNonce}
                  signer={activeSigner}
                  userProfile={userProfile}
                  dailyPlan={todayPlan}
                  cycleId={activeCycle.id}
                  isProofSigned={isTodayProofSigned}
                  lastLogTimestampMs={lastLogTimestampMs}
                  dailyStepGoal={governanceConfig.dailyStepGoal}
                  inactivityThresholdHours={governanceConfig.inactivityThresholdHours}
                  fatigueScalingMultiplier={governanceConfig.fatigueScalingMultiplier}
                  currentDateKey={activeDateKey}
                  onUpdateDailyPlan={handleUpdateDailyPlan}
                  onDispatchSignedClaim={handleDispatchSignedClaim}
                  onError={(err) => {
                    showErrorNotice(err, "Check-In Proof Failed");
                  }}
                  lastTxHash={lastTxHash}
                  lastExplorerUrl={lastExplorerUrl}
                  lastClaimMode={lastClaimMode}
                />
              ) : null}

              {activeTab === "dashboard" ? (
                <DashboardScreen
                  userAddress={activeWalletAddress}
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
                  proofSignedMap={proofSignedMap}
                  governanceConfig={governanceConfig}
                  authSession={authSession}
                  onSignOut={handleSignOut}
                  onUpdateGovernanceConfig={setGovernanceConfig}
                  onLogWeightEntry={handleLogWeightEntry}
                  onUpdatePlanCycle={handleApprovePlan}
                  onOpenPerksDrawer={() => setIsPerksDrawerOpen(true)}
                  onError={(err) => {
                    showErrorNotice(err, "Dashboard Action Failed");
                  }}
                />
              ) : null}

              {activeTab === "feed" ? (
                <AnonymizedFeedScreen
                  items={feedItems}
                  cheerCountsByFeedId={cheerCounts}
                  cheeredFeedIds={cheeredFeedIds}
                  onCheer={handleCheer}
                  onError={(err) => {
                    showErrorNotice(err, "Peer Cheer Failed");
                  }}
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

        {/* Global Error Pop-Up Modal */}
        <ErrorNoticeModal
          visible={errorNotice !== null}
          notice={errorNotice}
          onDismiss={clearErrorNotice}
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
  bootRetryPrimaryButton: {
    backgroundColor: "#10B981",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    marginBottom: 10
  },
  bootRetryPrimaryButtonText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#052E16"
  },
  bootResetSecondaryButton: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#EF4444",
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: "center"
  },
  bootResetSecondaryButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FCA5A5"
  },
  bootConfirmBox: {
    backgroundColor: "#2A1215",
    borderWidth: 1,
    borderColor: "#F87171",
    borderRadius: 12,
    padding: 12,
    marginTop: 4
  },
  bootConfirmWarningText: {
    fontSize: 12,
    color: "#FECACA",
    lineHeight: 17,
    marginBottom: 10
  },
  bootConfirmBtnRow: {
    flexDirection: "row",
    gap: 8
  },
  bootConfirmResetButton: {
    flex: 1,
    backgroundColor: "#EF4444",
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    alignItems: "center"
  },
  bootCancelResetButton: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "#1E293B",
    alignItems: "center"
  },
  bootCancelResetButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#E2E8F0"
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
