import {
  Address,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  UserProfile
} from "@dehealth/shared";
import { Wallet } from "ethers";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
  Pressable: (props: Record<string, unknown>) =>
    React.createElement(
      "button",
      cleanProps(props),
      typeof props.children === "function"
        ? (props.children as Function)({ pressed: false })
        : (props.children as React.ReactNode)
    ),
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
  deriveDeterministicDailySalt,
  hashTelemetry
} from "../services/cryptoService";

describe("Milestone 1 NEW-03 & R2 UI Integration", () => {
  const dummyUserAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
  const dummyContract = "0x1111111111111111111111111111111111111111" as Address;
  const dummySigner = Wallet.createRandom();

  const mockProfile: UserProfile = {
    age: 27,
    gender: "male",
    bodyFatPct: 15.0,
    muscleMassKg: 38.0
  };

  const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
  const baseDay1 = cycle.dailyPlans[0]!;

  describe("NEW-03: Proof Gate and Express Cards Lock on Completed Day", () => {
    it("locks and disables 'Complete & Sign Daily Proof' and shows 'Daily Proof Signed & Claimed ✓' when completed === true", () => {
      const completedDay: DailyPlan = {
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
        dailyPlan: completedDay,
        onDispatchSignedClaim: vi.fn()
      });

      const markup = renderToStaticMarkup(element);

      // Verify button label indicates completed & claimed
      expect(markup).toContain("Daily Proof Signed &amp; Claimed ✓");

      // Verify express cards display 'Claimed ✓'
      expect(markup).toContain("Claimed ✓");

      // Verify button has disabled attribute
      expect(markup).toContain("disabled");
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

    it("displays 'Complete & Sign Daily Proof (+10 $DHT)' when uncompleted and minimum progress is met", () => {
      const progressedDay: DailyPlan = {
        ...baseDay1,
        completed: false,
        loggedCaloriesKcal: 350
      };

      expect(hasMinimumDailyProgress(progressedDay)).toBe(true);

      const element = React.createElement(MicroCheckInScreen, {
        userAddress: dummyUserAddress,
        verifyingContract: dummyContract,
        currentStreak: 0,
        currentNonce: 0n,
        signer: dummySigner,
        userProfile: mockProfile,
        dailyPlan: progressedDay,
        onDispatchSignedClaim: vi.fn()
      });

      const markup = renderToStaticMarkup(element);
      expect(markup).toContain("Complete &amp; Sign Daily Proof (+10 $DHT)");
    });
  });

  describe("NEW-01 Deterministic Retries via Screen Helper Functions", () => {
    it("guarantees identical telemetryHash for the same day and plan metrics", () => {
      const mockSecret = "0x" + "ee".repeat(32);
      const cycleId = "cycle_alpha_14";
      const dayIndex = 0;

      const salt1 = deriveDeterministicDailySalt(mockSecret, cycleId, dayIndex);
      const salt2 = deriveDeterministicDailySalt(mockSecret, cycleId, dayIndex);

      const food = DUAL_TRACK_FOOD_PRESETS[0]!;
      const planWithMeal = addFoodPortionToDailyPlan(baseDay1, food, 150);
      const planWithEx = toggleExerciseInDailyPlan(planWithMeal, planWithMeal.exercises[0]!.id);

      const telemetry1 = buildDailyPlanTelemetry(planWithEx, mockProfile, 1_700_000_000_000);
      const telemetry2 = buildDailyPlanTelemetry(planWithEx, mockProfile, 1_700_000_000_000);

      const hash1 = hashTelemetry(telemetry1, salt1);
      const hash2 = hashTelemetry(telemetry2, salt2);

      expect(hash1.telemetryHash).toBe(hash2.telemetryHash);
      expect(hash1.salt).toBe(hash2.salt);
    });
  });

  describe("R2 Dashboard UI: Embedded Testnet Wallet Display & Export", () => {
    it("renders the wallet section with userAddress and Arbitrum Sepolia badge", () => {
      const element = React.createElement(DashboardScreen, {
        streakCount: 5,
        tokenBalanceDht: "50.0",
        lastProofHash: null,
        targetAssessment: {
          fitnessTier: "Intermediate Conditioning",
          baselineSteps: 8000,
          adjustedSteps: 8000,
          baselineActiveMinutes: 30,
          adjustedActiveMinutes: 30,
          isFatigueScaled: false
        },
        userAddress: dummyUserAddress,
        onExportPrivateKey: vi.fn().mockResolvedValue("0x" + "11".repeat(32))
      });

      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("Embedded Testnet Wallet");
      expect(markup).toContain("Arbitrum Sepolia");
      expect(markup).toContain(dummyUserAddress);
      expect(markup).toContain("Copy Address");
      expect(markup).toContain("Export Private Key");
    });

    it("renders Arbiscan Sepolia link when lastExplorerUrl is provided", () => {
      const explorerUrl = "https://sepolia.arbiscan.io/tx/0xabcdef1234567890";
      const element = React.createElement(DashboardScreen, {
        streakCount: 5,
        tokenBalanceDht: "50.0",
        lastProofHash: null,
        targetAssessment: {
          fitnessTier: "Intermediate Conditioning",
          baselineSteps: 8000,
          adjustedSteps: 8000,
          baselineActiveMinutes: 30,
          adjustedActiveMinutes: 30,
          isFatigueScaled: false
        },
        userAddress: dummyUserAddress,
        lastExplorerUrl: explorerUrl
      });

      const markup = renderToStaticMarkup(element);
      expect(markup).toContain("View Last Transaction on Arbiscan Sepolia ↗");
    });
  });
});
