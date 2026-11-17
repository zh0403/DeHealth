import {
  Address,
  DEFAULT_BASELINE_BIOMETRICS,
  SignedWorkoutClaimPayload
} from "@dehealth/shared";
import { Provider, Wallet } from "ethers";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedPressable {
  readonly text: string;
  readonly accessibilityLabel?: string;
  readonly disabled: boolean;
  readonly onPress?: () => void;
}

const { capturedPressables, openUrlMock } = vi.hoisted(() => ({
  capturedPressables: [] as CapturedPressable[],
  openUrlMock: vi.fn().mockResolvedValue(true)
}));

function extractText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props.children);
  }
  return "";
}

function cleanProps(props: Record<string, unknown>): Record<string, unknown> {
  const domProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (
      key.startsWith("accessibility") ||
      key === "contentContainerStyle" ||
      key === "keyboardType" ||
      key === "placeholderTextColor" ||
      key === "numberOfLines" ||
      key === "ellipsizeMode" ||
      key === "style" ||
      key === "visible" ||
      key === "animationType" ||
      key === "transparent" ||
      key === "onRequestClose" ||
      key === "selectable" ||
      key === "value"
    ) {
      continue;
    }
    domProps[key] = value;
  }
  return domProps;
}

vi.mock("react-native", () => ({
  View: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  Text: (props: Record<string, unknown>) =>
    React.createElement("span", cleanProps(props), props.children as React.ReactNode),
  Modal: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  Pressable: (props: Record<string, unknown>) => {
    const resolvedChildren =
      typeof props.children === "function"
        ? (props.children as (state: { pressed: boolean }) => React.ReactNode)({
            pressed: false
          })
        : (props.children as React.ReactNode);
    capturedPressables.push({
      text: extractText(resolvedChildren),
      accessibilityLabel: props.accessibilityLabel as string | undefined,
      disabled: Boolean(props.disabled),
      onPress: props.onPress as (() => void) | undefined
    });
    return React.createElement("button", cleanProps(props), resolvedChildren);
  },
  ScrollView: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  TextInput: (props: Record<string, unknown>) =>
    React.createElement("input", cleanProps(props)),
  Linking: {
    openURL: openUrlMock
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles
  }
}));

import {
  AdminGovernanceModal,
  validateGovernanceInput
} from "../components/AdminGovernanceModal";
import { DashboardScreen } from "../screens/DashboardScreen";
import {
  hasMinimumDailyProgress,
  MicroCheckInScreen
} from "../screens/MicroCheckInScreen";
import { generate14DayPlan } from "../services/adaptivePlanEngine";
import {
  ARBISCAN_SEPOLIA_ADDRESS_BASE_URL,
  DEMO_VERIFYING_CONTRACT,
  fetchLiveL2InspectorStatus,
  getArbiscanAddressUrl,
  L2InspectorStatus,
  resetL2Config,
  setContractFactory,
  setL2Provider,
  setRewardGateAddress,
  setTokenAddress,
  ZERO_ADDRESS
} from "../services/l2ContractService";
import {
  AdaptiveStorage,
  resetAdaptiveStorage,
  setAdaptiveStorage
} from "../storage/adaptiveStorage";
import { KeyValueStorageBackend } from "../storage/encryptedStorageAdapter";
import { DEFAULT_GOVERNANCE_CONFIG } from "../storage/governanceStorage";

class MemoryBackend implements KeyValueStorageBackend {
  private readonly items = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.items.delete(key);
  }
}

describe("Governance UI and L2 inspector integration", () => {
  const userAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
  const gateAddress = "0x2222222222222222222222222222222222222222" as Address;
  const tokenAddress = "0x3333333333333333333333333333333333333333" as Address;

  beforeEach(() => {
    capturedPressables.length = 0;
    openUrlMock.mockReset().mockResolvedValue(true);
    resetL2Config();
    resetAdaptiveStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetL2Config();
  });

  describe("validateGovernanceInput", () => {
    it("accepts valid bounds and rejects out-of-range values", () => {
      const valid = validateGovernanceInput("72", "0.85", "8000");
      expect(valid.isValid).toBe(true);
      expect(valid.config).toEqual({
        inactivityThresholdHours: 72,
        fatigueScalingMultiplier: 0.85,
        dailyStepGoal: 8000
      });

      expect(validateGovernanceInput("12", "0.70", "5000").isValid).toBe(false);
      expect(validateGovernanceInput("48", "0.40", "5000").isValid).toBe(false);
      expect(validateGovernanceInput("48", "0.70", "500").isValid).toBe(false);
      expect(validateGovernanceInput("48.5", "0.70", "5000").isValid).toBe(false);
    });
  });

  describe("L2 Inspector Helpers (l2ContractService.ts)", () => {
    it("builds Arbiscan /address URLs only for valid non-zero addresses", () => {
      expect(getArbiscanAddressUrl(null)).toBeNull();
      expect(getArbiscanAddressUrl(ZERO_ADDRESS)).toBeNull();
      expect(getArbiscanAddressUrl(gateAddress)).toBe(
        `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${gateAddress}`
      );
    });

    it("reports Local Fallback with null nonce when unconfigured", async () => {
      const status = await fetchLiveL2InspectorStatus(userAddress);
      expect(status.networkLabel).toBe("Local Fallback");
      expect(status.isLiveConfigured).toBe(false);
      expect(status.liveNonce).toBeNull();
      expect(status.rpcReachable).toBe(false);
      expect(status.rewardGateExplorerUrl).toBeNull();
    });

    it("reports Arbitrum Sepolia 421614, live nonce, and Arbiscan URLs when RPC is reachable", async () => {
      setL2Provider({} as unknown as Provider);
      setRewardGateAddress(gateAddress);
      setTokenAddress(tokenAddress);
      setContractFactory(() => ({
        nonces: vi.fn().mockResolvedValue(9n)
      }));

      const status = await fetchLiveL2InspectorStatus(userAddress);
      expect(status.networkLabel).toBe("Arbitrum Sepolia 421614");
      expect(status.chainId).toBe(421614);
      expect(status.isLiveConfigured).toBe(true);
      expect(status.liveNonce).toBe(9n);
      expect(status.rpcReachable).toBe(true);
      expect(status.rewardGateExplorerUrl).toBe(
        `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${gateAddress}`
      );
      expect(status.tokenExplorerUrl).toBe(
        `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${tokenAddress}`
      );
    });

    it("reports rpcReachable: false and liveNonce: null (never masking as 0n) when RPC fails", async () => {
      setL2Provider({} as unknown as Provider);
      setRewardGateAddress(gateAddress);
      setContractFactory(() => ({
        nonces: vi.fn().mockRejectedValue(new Error("RPC timeout"))
      }));

      const status = await fetchLiveL2InspectorStatus(userAddress);
      expect(status.isLiveConfigured).toBe(true);
      expect(status.rpcReachable).toBe(false);
      expect(status.liveNonce).toBeNull();
    });
  });

  describe("AdminGovernanceModal & DashboardScreen Launcher", () => {
    const baseAssessment = {
      fitnessTier: "balanced-conditioning" as const,
      baselineSteps: 8000,
      adjustedSteps: 8000,
      baselineActiveMinutes: 35,
      adjustedActiveMinutes: 35,
      isFatigueScaled: false,
      hoursSinceLastLog: 12,
      scalingFactorApplied: 1.0
    };

    it("renders Governance & Contract Inspector launcher button on DashboardScreen", () => {
      const markup = renderToStaticMarkup(
        React.createElement(DashboardScreen, {
          streakCount: 4,
          tokenBalanceDht: "40.0",
          lastProofHash: null,
          targetAssessment: baseAssessment,
          userAddress
        })
      );

      expect(markup).toContain("Governance &amp; Contract Inspector");
      const btn = capturedPressables.find(
        (p) => p.accessibilityLabel === "Governance & Contract Inspector"
      );
      expect(btn).toBeDefined();
    });

    it("renders dynamic Fatigue Guard badge percentage matching custom scalingFactorApplied", () => {
      const customFatigueMarkup = renderToStaticMarkup(
        React.createElement(DashboardScreen, {
          streakCount: 4,
          tokenBalanceDht: "40.0",
          lastProofHash: null,
          targetAssessment: {
            ...baseAssessment,
            adjustedSteps: 4000,
            adjustedActiveMinutes: 18,
            isFatigueScaled: true,
            hoursSinceLastLog: 30,
            scalingFactorApplied: 0.5
          },
          governanceConfig: {
            ...DEFAULT_GOVERNANCE_CONFIG,
            inactivityThresholdHours: 24,
            fatigueScalingMultiplier: 0.5
          },
          userAddress
        })
      );

      expect(customFatigueMarkup).toContain("-50% Fatigue Guard");
      expect(customFatigueMarkup).not.toContain("-30% Fatigue Guard");
      expect(customFatigueMarkup).toContain("-50% fatigue scaling applied");
    });

    it("displays Local Fallback status without fake Arbiscan links when unconfigured", () => {
      const fallbackStatus: L2InspectorStatus = {
        networkLabel: "Local Fallback",
        chainId: null,
        isLiveConfigured: false,
        rewardGateAddress: null,
        tokenAddress: null,
        rewardGateExplorerUrl: null,
        tokenExplorerUrl: null,
        liveNonce: null,
        rpcReachable: false
      };

      const markup = renderToStaticMarkup(
        React.createElement(AdminGovernanceModal, {
          visible: true,
          userAddress,
          currentConfig: DEFAULT_GOVERNANCE_CONFIG,
          onSaveConfig: vi.fn(),
          onClose: vi.fn(),
          initialInspectorStatus: fallbackStatus
        })
      );

      expect(markup).toContain("Local Fallback");
      expect(markup).toContain("Unavailable (Local Fallback)");
      expect(markup).toContain("Not Configured");
      expect(markup).not.toContain("View DeHealthRewardGate on Arbiscan");
      expect(markup).not.toContain("View DeHealthToken on Arbiscan");
    });

    it("displays Arbitrum Sepolia 421614, live nonce, and clickable Arbiscan links when configured", async () => {
      const liveStatus: L2InspectorStatus = {
        networkLabel: "Arbitrum Sepolia 421614",
        chainId: 421614,
        isLiveConfigured: true,
        rewardGateAddress: gateAddress,
        tokenAddress,
        rewardGateExplorerUrl: `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${gateAddress}`,
        tokenExplorerUrl: `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${tokenAddress}`,
        liveNonce: 7n,
        rpcReachable: true
      };

      const onSaveConfig = vi.fn();
      const onResetDefaults = vi.fn();

      const markup = renderToStaticMarkup(
        React.createElement(AdminGovernanceModal, {
          visible: true,
          userAddress,
          currentConfig: DEFAULT_GOVERNANCE_CONFIG,
          onSaveConfig,
          onResetDefaults,
          onClose: vi.fn(),
          initialInspectorStatus: liveStatus
        })
      );

      expect(markup).toContain("Arbitrum Sepolia 421614");
      expect(markup).toContain(gateAddress);
      expect(markup).toContain(tokenAddress);
      expect(markup).toContain(">7<");
      expect(markup).toContain("View DeHealthToken on Arbiscan ↗");
      expect(markup).toContain("View DeHealthRewardGate on Arbiscan ↗");

      const gateLink = capturedPressables.find(
        (p) => p.accessibilityLabel === "View DeHealthRewardGate on Arbiscan"
      );
      gateLink?.onPress?.();
      expect(openUrlMock).toHaveBeenCalledWith(
        `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${gateAddress}`
      );

      const saveBtn = capturedPressables.find(
        (p) => p.accessibilityLabel === "Save Governance Parameters"
      );
      saveBtn?.onPress?.();
      await vi.waitFor(() => {
        expect(onSaveConfig).toHaveBeenCalledWith(DEFAULT_GOVERNANCE_CONFIG);
      });

      const resetBtn = capturedPressables.find(
        (p) => p.accessibilityLabel === "Reset Governance Defaults"
      );
      resetBtn?.onPress?.();
      await vi.waitFor(() => {
        expect(onResetDefaults).toHaveBeenCalledTimes(1);
      });
    });

    it("displays Unavailable (RPC Unreachable) when configured live but RPC fails", () => {
      const unreachableStatus: L2InspectorStatus = {
        networkLabel: "Arbitrum Sepolia 421614",
        chainId: 421614,
        isLiveConfigured: true,
        rewardGateAddress: gateAddress,
        tokenAddress: null,
        rewardGateExplorerUrl: `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${gateAddress}`,
        tokenExplorerUrl: null,
        liveNonce: null,
        rpcReachable: false
      };

      const markup = renderToStaticMarkup(
        React.createElement(AdminGovernanceModal, {
          visible: true,
          userAddress,
          currentConfig: DEFAULT_GOVERNANCE_CONFIG,
          onSaveConfig: vi.fn(),
          onClose: vi.fn(),
          initialInspectorStatus: unreachableStatus
        })
      );

      expect(markup).toContain("Unavailable (RPC Unreachable)");
    });
  });

  describe("MicroCheckInScreen Step Goal, Manual Fallback & Data Sovereignty", () => {
    const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
    const emptyPlan = {
      ...cycle.dailyPlans[0]!,
      loggedCaloriesKcal: 0,
      exercises: cycle.dailyPlans[0]!.exercises.map((ex) => ({
        ...ex,
        completed: false
      }))
    };

    it("counts stepCount >= dailyStepGoal toward hasMinimumDailyProgress while preserving 1-arg default", () => {
      expect(hasMinimumDailyProgress(emptyPlan)).toBe(false);
      expect(hasMinimumDailyProgress(emptyPlan, 4999)).toBe(false);
      expect(hasMinimumDailyProgress(emptyPlan, 5000)).toBe(true);
      expect(hasMinimumDailyProgress(emptyPlan, 8000, 10_000)).toBe(false);
      expect(hasMinimumDailyProgress(emptyPlan, 10_000, 10_000)).toBe(true);
    });

    it("unlocks proof signing when step goal is met and dispatches zero raw step counts in SignedWorkoutClaimPayload", async () => {
      const secret = ("0x" + "dd".repeat(32)) as `0x${string}`;
      setAdaptiveStorage(new AdaptiveStorage(secret, new MemoryBackend()));
      const signer = Wallet.createRandom();
      const dispatched: SignedWorkoutClaimPayload[] = [];

      const markup = renderToStaticMarkup(
        React.createElement(MicroCheckInScreen, {
          userAddress: signer.address as Address,
          verifyingContract: DEMO_VERIFYING_CONTRACT,
          currentStreak: 2,
          currentNonce: 0n,
          signer,
          dailyPlan: emptyPlan,
          cycleId: cycle.id,
          vaultSecretHex: secret,
          dailyStepGoal: 6000,
          initialStepCount: 6500,
          initialStepSource: "manual-fallback",
          initialPedometerAvailable: false,
          onDispatchSignedClaim: async (payload) => {
            dispatched.push(payload);
          }
        })
      );

      expect(markup).toContain("Manual Step Fallback");
      expect(markup).toContain("6,500 / 6,000 steps");
      expect(markup).toContain("Complete &amp; Sign Daily Proof (+10 $DHT)");

      const signBtn = capturedPressables.find((p) =>
        p.text.includes("Complete & Sign Daily Proof")
      );
      expect(signBtn?.disabled).toBe(false);
      signBtn?.onPress?.();

      await vi.waitFor(() => {
        expect(dispatched).toHaveLength(1);
      });

      // Strict sovereignty: SignedWorkoutClaimPayload contains only EIP-712 proof + signature, zero raw steps
      const sentKeys = Object.keys(dispatched[0]!.proof);
      expect(sentKeys).toEqual([
        "user",
        "telemetryHash",
        "streakCount",
        "nonce",
        "deadline"
      ]);
      expect(JSON.stringify(dispatched[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("6500");
    });

    it("applies custom governance fatigue parameters in MicroCheckInScreen", () => {
      const signer = Wallet.createRandom();
      const now = 1_700_000_000_000 + 30 * 60 * 60 * 1000;
      const lastLog = now - 30 * 60 * 60 * 1000;

      const markup = renderToStaticMarkup(
        React.createElement(MicroCheckInScreen, {
          userAddress: signer.address as Address,
          verifyingContract: DEMO_VERIFYING_CONTRACT,
          currentStreak: 1,
          currentNonce: 0n,
          signer,
          dailyPlan: emptyPlan,
          lastLogTimestampMs: lastLog,
          inactivityThresholdHours: 24,
          fatigueScalingMultiplier: 0.5,
          onDispatchSignedClaim: vi.fn()
        })
      );

      expect(markup).toContain("Recovery Mode (-50% Volume)");
      expect(markup).toContain("-50% Fatigue Scaled");
    });
  });
});
