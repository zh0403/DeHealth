import {
  Address,
  Bytes32,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  SignedWorkoutClaimPayload,
  UserProfile
} from "@dehealth/shared";
import { Wallet } from "ethers";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedPressable {
  readonly text: string;
  readonly disabled: boolean;
  readonly onPress?: () => void;
}

const capturedPressables: CapturedPressable[] = [];

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
    openURL: vi.fn().mockResolvedValue(true)
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles
  }
}));

import { DashboardScreen } from "../screens/DashboardScreen";
import {
  addFoodPortionToDailyPlan,
  buildDailyPlanTelemetry,
  DUAL_TRACK_FOOD_PRESETS,
  hasMinimumDailyProgress,
  MicroCheckInScreen,
  toggleExerciseInDailyPlan
} from "../screens/MicroCheckInScreen";
import { generate14DayPlan } from "../services/adaptivePlanEngine";
import {
  buildDailyCheckInCommitment,
  deriveDeterministicDailySalt,
  hashTelemetry
} from "../services/cryptoService";
import {
  AdaptiveStorage,
  getDailyProofSigned,
  getDailyTelemetryCommitment,
  resetAdaptiveStorage,
  setAdaptiveStorage
} from "../storage/adaptiveStorage";
import { KeyValueStorageBackend } from "../storage/encryptedStorageAdapter";

class MemoryStorageBackend implements KeyValueStorageBackend {
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

describe("Milestone 1 NEW-03, R1, R2, and R3 UI Integration", () => {
  const dummyUserAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
  const dummyContract = "0x1111111111111111111111111111111111111111" as Address;
  const dummySigner = Wallet.createRandom();
  const mockSecret = ("0x" + "ee".repeat(32)) as Bytes32;

  const mockProfile: UserProfile = {
    age: 27,
    gender: "male",
    bodyFatPct: 15.0,
    muscleMassKg: 38.0
  };

  const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
  const baseDay1 = cycle.dailyPlans[0]!;

  beforeEach(() => {
    capturedPressables.length = 0;
    resetAdaptiveStorage();
  });

  describe("R1 (P3-01 / NEW-03): Proof Gate Locks Only on isProofSigned, Not on plan.completed", () => {
    it("keeps 'Complete & Sign Daily Proof (+10 $DHT)' enabled when plan.completed === true and isProofSigned === false", () => {
      const completedChecklistDay: DailyPlan = {
        ...baseDay1,
        completed: true,
        loggedCaloriesKcal: 500
      };

      const element = React.createElement(MicroCheckInScreen, {
        userAddress: dummyUserAddress,
        verifyingContract: dummyContract,
        currentStreak: 1,
        currentNonce: 0n,
        signer: dummySigner,
        userProfile: mockProfile,
        dailyPlan: completedChecklistDay,
        cycleId: cycle.id,
        isProofSigned: false,
        onDispatchSignedClaim: vi.fn()
      });

      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("Complete &amp; Sign Daily Proof (+10 $DHT)");
      expect(markup).not.toContain("Daily Proof Signed &amp; Claimed ✓");

      const signBtn = capturedPressables.find((p) =>
        p.text.includes("Complete & Sign Daily Proof")
      );
      expect(signBtn).toBeDefined();
      expect(signBtn?.disabled).toBe(false);
    });

    it("locks and disables 'Complete & Sign Daily Proof' and express cards ONLY when isProofSigned === true", () => {
      const signedDay: DailyPlan = {
        ...baseDay1,
        completed: true,
        loggedCaloriesKcal: 500
      };

      const element = React.createElement(MicroCheckInScreen, {
        userAddress: dummyUserAddress,
        verifyingContract: dummyContract,
        currentStreak: 1,
        currentNonce: 0n,
        signer: dummySigner,
        userProfile: mockProfile,
        dailyPlan: signedDay,
        cycleId: cycle.id,
        isProofSigned: true,
        onDispatchSignedClaim: vi.fn()
      });

      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("Daily Proof Signed &amp; Claimed ✓");
      expect(markup).toContain("Claimed ✓");

      const signBtn = capturedPressables.find((p) =>
        p.text.includes("Daily Proof Signed & Claimed ✓")
      );
      expect(signBtn?.disabled).toBe(true);

      const claimedExpressCards = capturedPressables.filter((p) =>
        p.text.includes("Claimed ✓") && !p.text.includes("Daily Proof Signed")
      );
      expect(claimedExpressCards).toHaveLength(3);
      for (const card of claimedExpressCards) {
        expect(card.disabled).toBe(true);
      }
    });

    it("displays 'Log a meal or finish 1 exercise to unlock' when uncompleted and progress is unmet", () => {
      const uncompletedDay: DailyPlan = {
        ...baseDay1,
        completed: false,
        loggedCaloriesKcal: 0,
        exercises: baseDay1.exercises.map((ex) => ({ ...ex, completed: false }))
      };

      expect(hasMinimumDailyProgress(uncompletedDay)).toBe(false);

      const element = React.createElement(MicroCheckInScreen, {
        userAddress: dummyUserAddress,
        verifyingContract: dummyContract,
        currentStreak: 0,
        currentNonce: 0n,
        signer: dummySigner,
        userProfile: mockProfile,
        dailyPlan: uncompletedDay,
        onDispatchSignedClaim: vi.fn()
      });

      const markup = renderToStaticMarkup(element);
      expect(markup).toContain("Log a meal or finish 1 exercise to unlock");
    });

    it("primary user journey integration: log meal -> tick all exercises (plan.completed === true) -> Sign button enabled -> tap Sign -> locks with 'Daily Proof Signed & Claimed ✓'", async () => {
      const storage = new AdaptiveStorage(mockSecret, new MemoryStorageBackend());
      setAdaptiveStorage(storage);

      // 1. Log meal
      let dayPlan = addFoodPortionToDailyPlan(
        baseDay1,
        DUAL_TRACK_FOOD_PRESETS[0]!,
        150
      );
      // 2. Tick all exercises
      for (const ex of dayPlan.exercises) {
        dayPlan = toggleExerciseInDailyPlan(dayPlan, ex.id);
      }
      expect(dayPlan.completed).toBe(true);
      expect(await getDailyProofSigned(cycle.id, 0)).toBe(false);

      // 3. Render with plan.completed === true and isProofSigned === false -> Sign button enabled
      const dispatchedPayloads: SignedWorkoutClaimPayload[] = [];
      const onDispatchSignedClaim = vi.fn(
        async (payload: SignedWorkoutClaimPayload): Promise<void> => {
          dispatchedPayloads.push(payload);
        }
      );

      const initialMarkup = renderToStaticMarkup(
        React.createElement(MicroCheckInScreen, {
          userAddress: dummySigner.address as Address,
          verifyingContract: dummyContract,
          currentStreak: 0,
          currentNonce: 0n,
          signer: dummySigner,
          userProfile: mockProfile,
          dailyPlan: dayPlan,
          cycleId: cycle.id,
          vaultSecretHex: mockSecret,
          isProofSigned: false,
          onDispatchSignedClaim
        })
      );

      expect(initialMarkup).toContain("Complete &amp; Sign Daily Proof (+10 $DHT)");
      const signBtn = capturedPressables.find((p) =>
        p.text.includes("Complete & Sign Daily Proof")
      );
      expect(signBtn).toBeDefined();
      expect(signBtn?.disabled).toBe(false);

      // 4. Tap Sign -> dispatches claim and persists daily_proof_signed for (cycleId, dayIndex)
      signBtn?.onPress?.();
      await vi.waitFor(() => {
        expect(onDispatchSignedClaim).toHaveBeenCalledTimes(1);
      });
      expect(dispatchedPayloads).toHaveLength(1);

      await vi.waitFor(async () => {
        expect(await getDailyProofSigned(cycle.id, 0)).toBe(true);
      });
      const persistedSigned = await getDailyProofSigned(cycle.id, 0);
      expect(persistedSigned).toBe(true);

      // 5. Re-render with persisted isProofSigned === true -> Sign button locks
      capturedPressables.length = 0;
      const lockedMarkup = renderToStaticMarkup(
        React.createElement(MicroCheckInScreen, {
          userAddress: dummySigner.address as Address,
          verifyingContract: dummyContract,
          currentStreak: 1,
          currentNonce: 1n,
          signer: dummySigner,
          userProfile: mockProfile,
          dailyPlan: dayPlan,
          cycleId: cycle.id,
          vaultSecretHex: mockSecret,
          isProofSigned: persistedSigned,
          onDispatchSignedClaim
        })
      );

      expect(lockedMarkup).toContain("Daily Proof Signed &amp; Claimed ✓");
      const lockedSignBtn = capturedPressables.find((p) =>
        p.text.includes("Daily Proof Signed & Claimed ✓")
      );
      expect(lockedSignBtn?.disabled).toBe(true);
    });
  });

  describe("R2 (NEW-01): Deterministic Retries Across Advancing Timestamps", () => {
    it("produces identical telemetryHash across timestamps t1 and t1 + 5000ms for the same cycle/day", async () => {
      const storage = new AdaptiveStorage(mockSecret, new MemoryStorageBackend());
      setAdaptiveStorage(storage);

      const cycleId = "cycle_alpha_14";
      const dayIndex = 0;
      const t1 = 1_700_000_000_000;
      const t2 = t1 + 5_000;

      // Pure day-level check-in commitment builder (R2)
      const commitment1 = buildDailyCheckInCommitment({
        vaultSecretHex: mockSecret,
        cycleId,
        dayIndex,
        planDate: baseDay1.date,
        timestampMs: t1
      });
      const commitment2 = buildDailyCheckInCommitment({
        vaultSecretHex: mockSecret,
        cycleId,
        dayIndex,
        planDate: baseDay1.date,
        timestampMs: t2
      });

      expect(commitment1.telemetryHash).toBe(commitment2.telemetryHash);
      expect(commitment1.salt).toBe(commitment2.salt);

      // Plan telemetry helper also normalizes timestampMs to plan.date
      const food = DUAL_TRACK_FOOD_PRESETS[0]!;
      const planWithMeal = addFoodPortionToDailyPlan(baseDay1, food, 150);
      const planWithEx = toggleExerciseInDailyPlan(
        planWithMeal,
        planWithMeal.exercises[0]!.id
      );

      const salt1 = deriveDeterministicDailySalt(mockSecret, cycleId, dayIndex);
      const salt2 = deriveDeterministicDailySalt(mockSecret, cycleId, dayIndex);
      const telemetry1 = buildDailyPlanTelemetry(planWithEx, mockProfile, t1);
      const telemetry2 = buildDailyPlanTelemetry(planWithEx, mockProfile, t2);
      const h1 = hashTelemetry(telemetry1, salt1);
      const h2 = hashTelemetry(telemetry2, salt2);
      expect(h1.telemetryHash).toBe(h2.telemetryHash);

      // Persisted daily telemetry commitment cache returns identical hash
      await storage.saveDailyTelemetryCommitment(
        cycleId,
        dayIndex,
        commitment1.telemetryHash
      );
      expect(await getDailyTelemetryCommitment(cycleId, dayIndex)).toBe(
        commitment1.telemetryHash
      );
    });
  });

  describe("R3 (P3-02): Dashboard & MicroCheckIn Honest Fallback vs Live Explorer Links", () => {
    const baseAssessment = {
      fitnessTier: "balanced-conditioning" as const,
      baselineSteps: 8000,
      adjustedSteps: 8000,
      baselineActiveMinutes: 30,
      adjustedActiveMinutes: 30,
      isFatigueScaled: false,
      hoursSinceLastLog: 12,
      scalingFactorApplied: 1.0
    };

    it("renders the wallet section with userAddress and Arbitrum Sepolia badge", () => {
      const element = React.createElement(DashboardScreen, {
        streakCount: 5,
        tokenBalanceDht: "50.0",
        lastProofHash: null,
        targetAssessment: baseAssessment,
        userAddress: dummyUserAddress,
        onExportPrivateKey: vi.fn().mockResolvedValue("0x" + "11".repeat(32))
      });

      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("Embedded Mini Wallet");
      expect(markup).toContain("Arbitrum Sepolia");
      expect(markup).toContain(dummyUserAddress);
      expect(markup).toContain("Copy Address");
      expect(markup).toContain("Export Private Key");
    });

    it("renders clickable Arbiscan Sepolia link ONLY when lastClaimMode === 'live' and lastExplorerUrl !== null", () => {
      const explorerUrl = "https://sepolia.arbiscan.io/tx/0xabcdef1234567890";
      const element = React.createElement(DashboardScreen, {
        streakCount: 5,
        tokenBalanceDht: "50.0",
        lastProofHash: ("0x" + "aa".repeat(32)) as Bytes32,
        targetAssessment: baseAssessment,
        userAddress: dummyUserAddress,
        lastTxHash: "0xabcdef1234567890",
        lastExplorerUrl: explorerUrl,
        lastClaimMode: "live"
      });

      const markup = renderToStaticMarkup(element);
      expect(markup).toContain("Confirmed on Arbitrum Sepolia (L2)");
      expect(markup).toContain("View Last Transaction on Arbiscan Sepolia ↗");
    });

    it("renders Simulated Local Mint notice and suppresses Arbiscan links in local-fallback mode or when explorerUrl is null", () => {
      const fallbackMarkup = renderToStaticMarkup(
        React.createElement(DashboardScreen, {
          streakCount: 5,
          tokenBalanceDht: "50.0",
          lastProofHash: ("0x" + "aa".repeat(32)) as Bytes32,
          targetAssessment: baseAssessment,
          userAddress: dummyUserAddress,
          lastTxHash: "0x" + "bb".repeat(32),
          lastExplorerUrl: null,
          lastClaimMode: "local-fallback"
        })
      );

      expect(fallbackMarkup).toContain(
        "Simulated Local Mint (Demo Mode — Configure L2 .env for Live Arbitrum)"
      );
      expect(fallbackMarkup).not.toContain("View Last Transaction on Arbiscan Sepolia");
      expect(fallbackMarkup).not.toContain("Confirmed on Arbitrum Sepolia (L2)");

      // Defensive check: even if a URL string were passed in local-fallback or omitted mode, no link renders
      const defensiveFallbackMarkup = renderToStaticMarkup(
        React.createElement(DashboardScreen, {
          streakCount: 5,
          tokenBalanceDht: "50.0",
          lastProofHash: null,
          targetAssessment: baseAssessment,
          userAddress: dummyUserAddress,
          lastTxHash: "0x" + "bb".repeat(32),
          lastExplorerUrl: "https://sepolia.arbiscan.io/tx/0xfake",
          lastClaimMode: "local-fallback"
        })
      );
      expect(defensiveFallbackMarkup).toContain(
        "Simulated Local Mint (Demo Mode — Configure L2 .env for Live Arbitrum)"
      );
      expect(defensiveFallbackMarkup).not.toContain(
        "View Last Transaction on Arbiscan Sepolia"
      );

      // Live mode with null explorerUrl must also omit the link
      const liveNullUrlMarkup = renderToStaticMarkup(
        React.createElement(DashboardScreen, {
          streakCount: 5,
          tokenBalanceDht: "50.0",
          lastProofHash: null,
          targetAssessment: baseAssessment,
          userAddress: dummyUserAddress,
          lastExplorerUrl: null,
          lastClaimMode: "live"
        })
      );
      expect(liveNullUrlMarkup).not.toContain(
        "View Last Transaction on Arbiscan Sepolia"
      );
    });
  });
});
