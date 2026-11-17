import { Address } from "@dehealth/shared";
import React, { useEffect, useState } from "react";
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  fetchLiveL2InspectorStatus,
  getArbiscanAddressUrl,
  getRewardGateAddress,
  getTokenAddress,
  isL2Configured,
  L2InspectorStatus
} from "../services/l2ContractService";
import {
  DEFAULT_GOVERNANCE_CONFIG,
  GovernanceConfig,
  GovernanceConfigSchema,
  MAX_DAILY_STEP_GOAL,
  MAX_FATIGUE_SCALING_MULTIPLIER,
  MAX_INACTIVITY_THRESHOLD_HOURS,
  MIN_DAILY_STEP_GOAL,
  MIN_FATIGUE_SCALING_MULTIPLIER,
  MIN_INACTIVITY_THRESHOLD_HOURS
} from "../storage/governanceStorage";

export interface GovernanceValidationResult {
  readonly isValid: boolean;
  readonly error: string | null;
  readonly config?: GovernanceConfig;
}

/**
 * Validates raw string inputs for protocol governance parameters against
 * strict integer/finite bounds.
 */
export function validateGovernanceInput(
  inactivityHoursStr: string,
  fatigueMultiplierStr: string,
  dailyStepGoalStr: string
): GovernanceValidationResult {
  const trimmedHours = inactivityHoursStr.trim();
  const parsedHours = Number(trimmedHours);
  if (
    trimmedHours === "" ||
    !Number.isInteger(parsedHours) ||
    parsedHours < MIN_INACTIVITY_THRESHOLD_HOURS ||
    parsedHours > MAX_INACTIVITY_THRESHOLD_HOURS
  ) {
    return {
      isValid: false,
      error: `Inactivity threshold must be a whole number between ${MIN_INACTIVITY_THRESHOLD_HOURS} and ${MAX_INACTIVITY_THRESHOLD_HOURS} hours.`
    };
  }

  const trimmedMultiplier = fatigueMultiplierStr.trim();
  const parsedMultiplier = Number(trimmedMultiplier);
  if (
    trimmedMultiplier === "" ||
    !Number.isFinite(parsedMultiplier) ||
    parsedMultiplier < MIN_FATIGUE_SCALING_MULTIPLIER ||
    parsedMultiplier > MAX_FATIGUE_SCALING_MULTIPLIER
  ) {
    return {
      isValid: false,
      error: `Fatigue scaling multiplier must be between ${MIN_FATIGUE_SCALING_MULTIPLIER.toFixed(2)} and ${MAX_FATIGUE_SCALING_MULTIPLIER.toFixed(2)}.`
    };
  }

  const trimmedSteps = dailyStepGoalStr.trim();
  const parsedSteps = Number(trimmedSteps);
  if (
    trimmedSteps === "" ||
    !Number.isInteger(parsedSteps) ||
    parsedSteps < MIN_DAILY_STEP_GOAL ||
    parsedSteps > MAX_DAILY_STEP_GOAL
  ) {
    return {
      isValid: false,
      error: `Daily step goal must be a whole number between ${MIN_DAILY_STEP_GOAL} and ${MAX_DAILY_STEP_GOAL} steps.`
    };
  }

  const candidate: GovernanceConfig = {
    inactivityThresholdHours: parsedHours,
    fatigueScalingMultiplier: Number(parsedMultiplier.toFixed(4)),
    dailyStepGoal: parsedSteps
  };

  const parsed = GovernanceConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      isValid: false,
      error: parsed.error.issues[0]?.message ?? "Invalid governance parameters."
    };
  }

  return {
    isValid: true,
    error: null,
    config: parsed.data
  };
}

function buildSynchronousFallbackStatus(): L2InspectorStatus {
  const rewardGateAddress = getRewardGateAddress();
  const tokenAddress = getTokenAddress();
  const liveConfigured = isL2Configured();
  return {
    networkLabel: liveConfigured ? "Arbitrum Sepolia 421614" : "Local Fallback",
    chainId: liveConfigured ? 421614 : null,
    isLiveConfigured: liveConfigured,
    rewardGateAddress,
    tokenAddress,
    rewardGateExplorerUrl: getArbiscanAddressUrl(rewardGateAddress),
    tokenExplorerUrl: getArbiscanAddressUrl(tokenAddress),
    liveNonce: null,
    rpcReachable: false
  };
}

export interface AdminGovernanceModalProps {
  readonly visible: boolean;
  readonly userAddress: Address;
  readonly currentConfig: GovernanceConfig;
  readonly onSaveConfig: (config: GovernanceConfig) => Promise<void> | void;
  readonly onResetDefaults?: () => Promise<void> | void;
  readonly onClose: () => void;
  readonly initialInspectorStatus?: L2InspectorStatus | null;
  readonly loadInspectorStatus?: (
    userAddress: Address
  ) => Promise<L2InspectorStatus>;
}

export const AdminGovernanceModal: React.FC<AdminGovernanceModalProps> = ({
  visible,
  userAddress,
  currentConfig,
  onSaveConfig,
  onResetDefaults,
  onClose,
  initialInspectorStatus = null,
  loadInspectorStatus
}) => {
  const [hoursInput, setHoursInput] = useState<string>(
    String(currentConfig.inactivityThresholdHours)
  );
  const [multiplierInput, setMultiplierInput] = useState<string>(
    currentConfig.fatigueScalingMultiplier.toFixed(2)
  );
  const [stepGoalInput, setStepGoalInput] = useState<string>(
    String(currentConfig.dailyStepGoal)
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const [inspectorStatus, setInspectorStatus] = useState<L2InspectorStatus>(
    () => initialInspectorStatus ?? buildSynchronousFallbackStatus()
  );
  const [isRefreshingStatus, setIsRefreshingStatus] = useState<boolean>(false);

  useEffect(() => {
    setHoursInput(String(currentConfig.inactivityThresholdHours));
    setMultiplierInput(currentConfig.fatigueScalingMultiplier.toFixed(2));
    setStepGoalInput(String(currentConfig.dailyStepGoal));
  }, [currentConfig, visible]);

  useEffect(() => {
    if (visible) {
      setFormError(null);
      setSaveNotice(null);
    }
  }, [visible]);

  const refreshInspector = async (): Promise<void> => {
    setIsRefreshingStatus(true);
    try {
      const fetcher = loadInspectorStatus ?? fetchLiveL2InspectorStatus;
      const nextStatus = await fetcher(userAddress);
      setInspectorStatus(nextStatus);
    } catch {
      setInspectorStatus(buildSynchronousFallbackStatus());
    } finally {
      setIsRefreshingStatus(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    if (initialInspectorStatus) {
      setInspectorStatus(initialInspectorStatus);
      return;
    }
    void refreshInspector();
  }, [visible, userAddress, initialInspectorStatus]);

  const handleSave = async (): Promise<void> => {
    setSaveNotice(null);
    const validation = validateGovernanceInput(
      hoursInput,
      multiplierInput,
      stepGoalInput
    );
    if (!validation.isValid || !validation.config) {
      setFormError(validation.error);
      return;
    }

    setFormError(null);
    setIsSaving(true);
    try {
      await onSaveConfig(validation.config);
      setSaveNotice(
        `Saved parameters (${validation.config.inactivityThresholdHours}h gap, ${validation.config.fatigueScalingMultiplier.toFixed(2)}x scaling, ${validation.config.dailyStepGoal} steps).`
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to save governance config.";
      setFormError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    setFormError(null);
    setSaveNotice(null);
    setIsSaving(true);
    try {
      setHoursInput(String(DEFAULT_GOVERNANCE_CONFIG.inactivityThresholdHours));
      setMultiplierInput(
        DEFAULT_GOVERNANCE_CONFIG.fatigueScalingMultiplier.toFixed(2)
      );
      setStepGoalInput(String(DEFAULT_GOVERNANCE_CONFIG.dailyStepGoal));
      if (onResetDefaults) {
        await onResetDefaults();
      } else {
        await onSaveConfig(DEFAULT_GOVERNANCE_CONFIG);
      }
      setSaveNotice("Restored default protocol governance parameters.");
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to reset governance config.";
      setFormError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  if (!visible) {
    return null;
  }

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
              <View style={styles.headerTextCol}>
                <Text style={styles.tag}>ADMIN GOVERNANCE &amp; L2 INSPECTOR</Text>
                <Text style={styles.title}>Protocol Governance &amp; Contract Inspector</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close Governance Inspector"
                style={styles.closeIconBtn}
                onPress={onClose}
              >
                <Text style={styles.closeIconText}>✕</Text>
              </Pressable>
            </View>

            {/* Section 1: Governance Parameters */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Adaptive Rule Parameters</Text>
              <Text style={styles.sectionSub}>
                Encrypted locally on-device. Controls fatigue recovery thresholds and daily step proof eligibility.
              </Text>

              <Text style={styles.inputLabel}>
                Inactivity Threshold Hours ({MIN_INACTIVITY_THRESHOLD_HOURS}–{MAX_INACTIVITY_THRESHOLD_HOURS}h)
              </Text>
              <TextInput
                accessibilityLabel="Inactivity Threshold Hours Input"
                style={styles.textInput}
                value={hoursInput}
                onChangeText={setHoursInput}
                keyboardType="numeric"
                placeholder="48"
                placeholderTextColor="#64748B"
              />

              <Text style={styles.inputLabel}>
                Fatigue Scaling Multiplier ({MIN_FATIGUE_SCALING_MULTIPLIER.toFixed(2)}–{MAX_FATIGUE_SCALING_MULTIPLIER.toFixed(2)})
              </Text>
              <TextInput
                accessibilityLabel="Fatigue Scaling Multiplier Input"
                style={styles.textInput}
                value={multiplierInput}
                onChangeText={setMultiplierInput}
                keyboardType="numeric"
                placeholder="0.70"
                placeholderTextColor="#64748B"
              />

              <Text style={styles.inputLabel}>
                Daily Step Goal ({MIN_DAILY_STEP_GOAL}–{MAX_DAILY_STEP_GOAL} steps)
              </Text>
              <TextInput
                accessibilityLabel="Daily Step Goal Input"
                style={styles.textInput}
                value={stepGoalInput}
                onChangeText={setStepGoalInput}
                keyboardType="numeric"
                placeholder="5000"
                placeholderTextColor="#64748B"
              />

              {formError ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{formError}</Text>
                </View>
              ) : null}

              {saveNotice ? (
                <View style={styles.successBox}>
                  <Text style={styles.successText}>✓ {saveNotice}</Text>
                </View>
              ) : null}

              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Save Governance Parameters"
                  disabled={isSaving}
                  style={[styles.saveBtn, isSaving ? styles.btnDisabled : null]}
                  onPress={() => {
                    void handleSave();
                  }}
                >
                  <Text style={styles.saveBtnText}>
                    {isSaving ? "Saving..." : "Save Parameters"}
                  </Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Reset Governance Defaults"
                  disabled={isSaving}
                  style={[styles.resetBtn, isSaving ? styles.btnDisabled : null]}
                  onPress={() => {
                    void handleReset();
                  }}
                >
                  <Text style={styles.resetBtnText}>Reset Defaults</Text>
                </Pressable>
              </View>
            </View>

            {/* Section 2: On-Chain Contract & RPC Inspector */}
            <View style={styles.sectionCard}>
              <View style={styles.inspectorHeaderRow}>
                <Text style={styles.sectionTitle}>On-Chain L2 Inspector</Text>
                <View
                  style={[
                    styles.networkBadge,
                    inspectorStatus.isLiveConfigured
                      ? styles.networkBadgeLive
                      : styles.networkBadgeFallback
                  ]}
                >
                  <Text
                    style={[
                      styles.networkBadgeText,
                      inspectorStatus.isLiveConfigured
                        ? styles.networkBadgeTextLive
                        : styles.networkBadgeTextFallback
                    ]}
                  >
                    {inspectorStatus.networkLabel}
                  </Text>
                </View>
              </View>

              <View style={styles.inspectorBlock}>
                <Text style={styles.inspectorLabel}>Active Wallet Address</Text>
                <Text style={styles.monoValue}>{userAddress}</Text>
              </View>

              <View style={styles.inspectorBlock}>
                <Text style={styles.inspectorLabel}>Live Wallet Nonce</Text>
                <Text style={styles.nonceValue}>
                  {inspectorStatus.rpcReachable && inspectorStatus.liveNonce !== null
                    ? String(inspectorStatus.liveNonce)
                    : !inspectorStatus.isLiveConfigured
                      ? "Unavailable (Local Fallback)"
                      : "Unavailable (RPC Unreachable)"}
                </Text>
              </View>

              <View style={styles.inspectorBlock}>
                <Text style={styles.inspectorLabel}>DeHealthToken ($DHT) Contract</Text>
                <Text style={styles.monoValue}>
                  {inspectorStatus.tokenAddress ?? "Not Configured"}
                </Text>
                {inspectorStatus.tokenExplorerUrl ? (
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="View DeHealthToken on Arbiscan"
                    onPress={() => {
                      void Promise.resolve(
                        Linking.openURL(inspectorStatus.tokenExplorerUrl!)
                      ).catch(() => undefined);
                    }}
                    style={styles.explorerBtn}
                  >
                    <Text style={styles.explorerLinkText}>
                      View DeHealthToken on Arbiscan ↗
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.inspectorBlock}>
                <Text style={styles.inspectorLabel}>DeHealthRewardGate Contract</Text>
                <Text style={styles.monoValue}>
                  {inspectorStatus.rewardGateAddress ?? "Not Configured"}
                </Text>
                {inspectorStatus.rewardGateExplorerUrl ? (
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="View DeHealthRewardGate on Arbiscan"
                    onPress={() => {
                      void Promise.resolve(
                        Linking.openURL(inspectorStatus.rewardGateExplorerUrl!)
                      ).catch(() => undefined);
                    }}
                    style={styles.explorerBtn}
                  >
                    <Text style={styles.explorerLinkText}>
                      View DeHealthRewardGate on Arbiscan ↗
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh On-Chain Status"
                disabled={isRefreshingStatus}
                style={[
                  styles.refreshBtn,
                  isRefreshingStatus ? styles.btnDisabled : null
                ]}
                onPress={() => {
                  void refreshInspector();
                }}
              >
                <Text style={styles.refreshBtnText}>
                  {isRefreshingStatus
                    ? "Querying Arbitrum Sepolia..."
                    : "Refresh On-Chain Status"}
                </Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close Modal"
              style={styles.closeFooterBtn}
              onPress={onClose}
            >
              <Text style={styles.closeFooterBtnText}>Close</Text>
            </Pressable>
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
    maxWidth: 410,
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
  headerTextCol: {
    flex: 1,
    marginRight: 8
  },
  tag: {
    fontSize: 10,
    fontWeight: "800",
    color: "#38BDF8",
    letterSpacing: 0.6,
    marginBottom: 4
  },
  title: {
    fontSize: 18,
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
    fontWeight: "700",
    color: "#CBD5E1"
  },
  sectionCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    marginBottom: 14
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 4
  },
  sectionSub: {
    fontSize: 11,
    color: "#94A3B8",
    lineHeight: 16,
    marginBottom: 12
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#CBD5E1",
    marginBottom: 5
  },
  textInput: {
    backgroundColor: "#0B0F17",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 10
  },
  errorBox: {
    backgroundColor: "#2A1215",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#7F1D1D",
    padding: 10,
    marginBottom: 10
  },
  errorText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#FCA5A5"
  },
  successBox: {
    backgroundColor: "#052E16",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#10B981",
    padding: 10,
    marginBottom: 10
  },
  successText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#34D399"
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4
  },
  saveBtn: {
    flex: 1,
    backgroundColor: "#10B981",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center"
  },
  saveBtnText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#052E16"
  },
  resetBtn: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: "#1E293B",
    borderWidth: 1,
    borderColor: "#334155",
    alignItems: "center"
  },
  resetBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#E2E8F0"
  },
  btnDisabled: {
    opacity: 0.55
  },
  inspectorHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10
  },
  networkBadge: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1
  },
  networkBadgeLive: {
    backgroundColor: "#052E16",
    borderColor: "#10B981"
  },
  networkBadgeFallback: {
    backgroundColor: "#422006",
    borderColor: "#F59E0B"
  },
  networkBadgeText: {
    fontSize: 10,
    fontWeight: "800"
  },
  networkBadgeTextLive: {
    color: "#34D399"
  },
  networkBadgeTextFallback: {
    color: "#FBBF24"
  },
  inspectorBlock: {
    backgroundColor: "#0A101D",
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: "#1E293B",
    marginBottom: 8
  },
  inspectorLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#64748B",
    textTransform: "uppercase",
    marginBottom: 3
  },
  monoValue: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#38BDF8"
  },
  nonceValue: {
    fontSize: 13,
    fontWeight: "800",
    color: "#F8FAFC"
  },
  explorerBtn: {
    marginTop: 6
  },
  explorerLinkText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#38BDF8",
    textDecorationLine: "underline"
  },
  refreshBtn: {
    backgroundColor: "#1E293B",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#334155",
    marginTop: 4
  },
  refreshBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#E2E8F0"
  },
  closeFooterBtn: {
    backgroundColor: "#334155",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center"
  },
  closeFooterBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#F8FAFC"
  }
});
