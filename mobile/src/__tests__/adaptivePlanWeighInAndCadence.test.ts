import {
  AdaptivePlanCycle,
  Address,
  Bytes32,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  ProposedPlanReview,
  UserBiometrics,
  WeightLogEntry
} from "@dehealth/shared";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface HarnessState {
  active: boolean;
  slots: unknown[];
  refs: { current: unknown }[];
  effects: { deps?: readonly unknown[]; cleanup?: (() => void) | void }[];
  pending: (() => void)[];
  stateIndex: number;
  refIndex: number;
  effectIndex: number;
  dirty: boolean;
}

const harness = vi.hoisted<HarnessState>(() => ({
  active: false,
  slots: [],
  refs: [],
  effects: [],
  pending: [],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  dirty: false
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  const useState = <T,>(
    initial: T | (() => T)
  ): [T, (next: T | ((prev: T) => T)) => void] => {
    if (!harness.active) {
      return actual.useState(initial);
    }
    const i = harness.stateIndex++;
    if (!(i in harness.slots)) {
      harness.slots[i] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    }
    const setter = (next: T | ((prev: T) => T)): void => {
      const prev = harness.slots[i] as T;
      const value =
        typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (!Object.is(prev, value)) {
        harness.slots[i] = value;
        harness.dirty = true;
      }
    };
    return [harness.slots[i] as T, setter];
  };

  const useEffect = (
    fn: () => void | (() => void),
    deps?: readonly unknown[]
  ): void => {
    if (!harness.active) {
      actual.useEffect(fn, deps);
      return;
    }
    const i = harness.effectIndex++;
    const prev = harness.effects[i];
    const changed =
      !prev ||
      !deps ||
      !prev.deps ||
      deps.some((d, k) => !Object.is(d, prev.deps?.[k]));
    if (changed) {
      harness.effects[i] = { deps, cleanup: prev?.cleanup };
      harness.pending.push(() => {
        if (typeof harness.effects[i]?.cleanup === "function") {
          harness.effects[i]!.cleanup!();
        }
        const cleanup = fn();
        harness.effects[i] = { deps, cleanup };
      });
    }
  };

  const useMemo = <T,>(factory: () => T, deps?: readonly unknown[]): T => {
    if (!harness.active) {
      return actual.useMemo(factory, deps ?? []);
    }
    return factory();
  };

  const useRef = <T,>(initialValue: T): { current: T } => {
    if (!harness.active) {
      return actual.useRef(initialValue);
    }
    const i = harness.refIndex++;
    if (!(i in harness.refs)) {
      harness.refs[i] = { current: initialValue };
    }
    return harness.refs[i] as { current: T };
  };

  return {
    ...actual,
    default: { ...actual, useState, useEffect, useMemo, useRef },
    useState,
    useEffect,
    useMemo,
    useRef
  };
});

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
      key === "secureTextEntry" ||
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
    props.visible === false
      ? null
      : React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  Pressable: (props: Record<string, unknown>) => {
    const resolvedChildren =
      typeof props.children === "function"
        ? (props.children as (state: { pressed: boolean }) => React.ReactNode)({
            pressed: false
          })
        : (props.children as React.ReactNode);
    return React.createElement("button", cleanProps(props), resolvedChildren);
  },
  ScrollView: (props: Record<string, unknown>) =>
    React.createElement("div", cleanProps(props), props.children as React.ReactNode),
  TextInput: (props: Record<string, unknown>) =>
    React.createElement("input", cleanProps(props)),
  Linking: {
    openURL: vi.fn().mockResolvedValue(true)
  },
  Platform: {
    OS: "ios",
    select: <T,>(obj: { readonly ios?: T; readonly default?: T }): T | undefined =>
      obj.ios ?? obj.default
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles
  }
}));

import {
  PlanReviewModal,
  PlanReviewModalProps
} from "../components/PlanReviewModal";
import {
  DashboardScreen,
  DashboardScreenProps
} from "../screens/DashboardScreen";
import {
  ADAPTIVE_MAX_DEFICIT_KCAL,
  ADAPTIVE_MAX_SURPLUS_KCAL,
  buildSevenDayCadence,
  CADENCE_WEEKDAY_LABELS,
  calculateBaselineTdee,
  calculateLiveStreak,
  calculateMacroSplit,
  clampAdaptiveCalories,
  computeRollingWeightAverage,
  CYCLE_LENGTH_DAYS,
  evaluateWeighInAdaptation,
  generate14DayPlan,
  isCycleBiWeeklyReviewDue,
  MS_PER_DAY,
  SAFE_CALORIE_FLOOR_KCAL
} from "../services/adaptivePlanEngine";
import { DailyTargetAssessment } from "../services/profileEngine";
import {
  ADAPTIVE_STORAGE_KEYS,
  AdaptiveStorage,
  getLastLogTimestampMs,
  makeDailyProofSignedKey,
  purgeAdaptiveStorageKeys,
  resetAdaptiveStorage,
  saveLastLogTimestampMs,
  setAdaptiveStorage
} from "../storage/adaptiveStorage";
import { KeyValueStorageBackend } from "../storage/encryptedStorageAdapter";

class MemoryBackend implements KeyValueStorageBackend {
  readonly items = new Map<string, string>();
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

function resetHarness(): void {
  for (const eff of harness.effects) {
    if (typeof eff?.cleanup === "function") {
      eff.cleanup();
    }
  }
  harness.active = false;
  harness.slots = [];
  harness.refs = [];
  harness.effects = [];
  harness.pending = [];
  harness.stateIndex = 0;
  harness.refIndex = 0;
  harness.effectIndex = 0;
  harness.dirty = false;
}

function renderWithHarness<P>(
  component: React.FC<P>,
  props: P
): React.ReactNode {
  harness.active = true;
  harness.stateIndex = 0;
  harness.refIndex = 0;
  harness.effectIndex = 0;
  harness.pending = [];
  const tree = component(props);
  const effects = harness.pending;
  harness.pending = [];
  for (const run of effects) {
    run();
  }
  if (harness.dirty) {
    harness.dirty = false;
    return renderWithHarness(component, props);
  }
  return tree;
}

function findElement(
  node: React.ReactNode,
  predicate: (elProps: Record<string, unknown>, elType: unknown) => boolean
): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (predicate(props, node.type)) {
      return props;
    }
    return findElement(props.children as React.ReactNode, predicate);
  }
  return null;
}

function findAllElements(
  node: React.ReactNode,
  predicate: (elProps: Record<string, unknown>, elType: unknown) => boolean,
  acc: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      findAllElements(child, predicate, acc);
    }
    return acc;
  }
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (predicate(props, node.type)) {
      acc.push(props);
    }
    findAllElements(props.children as React.ReactNode, predicate, acc);
  }
  return acc;
}

function findByLabel(
  node: React.ReactNode,
  label: string
): Record<string, unknown> | null {
  return findElement(node, (elProps) => elProps.accessibilityLabel === label);
}

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

function hasText(node: React.ReactNode, needle: string): boolean {
  return extractText(node).includes(needle);
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

const TEST_SECRET = ("0x" + "cd".repeat(32)) as Bytes32;
const TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const BASE_START_MS = Date.UTC(2026, 9, 5, 12, 0, 0); // Monday, 2026-10-05

const BASE_ASSESSMENT: DailyTargetAssessment = {
  fitnessTier: "balanced-conditioning",
  baselineSteps: 8000,
  adjustedSteps: 8000,
  baselineActiveMinutes: 35,
  adjustedActiveMinutes: 35,
  isFatigueScaled: false,
  hoursSinceLastLog: 12,
  scalingFactorApplied: 1.0
};

function makeWeightLog(
  id: string,
  timestampMs: number,
  weightKg: number,
  bodyFatPct?: number
): WeightLogEntry {
  return {
    id,
    timestampMs,
    weightKg,
    ...(bodyFatPct !== undefined ? { bodyFatPct } : {})
  };
}

describe("M2 R2+R3: Rolling Weigh-In Adaptation, Storage Timestamp & Live Cadence", () => {
  beforeEach(() => {
    resetHarness();
    resetAdaptiveStorage();
  });

  afterEach(() => {
    resetHarness();
    resetAdaptiveStorage();
    vi.restoreAllMocks();
  });

  // ============================================================================
  // 1. adaptivePlanEngine.ts — computeRollingWeightAverage
  // ============================================================================
  describe("computeRollingWeightAverage", () => {
    it("returns null for empty logs or when no logs fall inside the 7-day window", () => {
      expect(computeRollingWeightAverage([])).toBeNull();

      const oldLogs = [
        makeWeightLog("old-1", BASE_START_MS, 72.0),
        makeWeightLog("old-2", BASE_START_MS + MS_PER_DAY, 71.8)
      ];
      // Reference 10 days after old-2 -> outside [ref - 7d, ref]
      expect(
        computeRollingWeightAverage(oldLogs, BASE_START_MS + 11 * MS_PER_DAY)
      ).toBeNull();
    });

    it("sorts unsorted logs, enforces inclusive [ref - 7d, ref] bounds, and rounds to 2 decimals", () => {
      const refMs = BASE_START_MS + 10 * MS_PER_DAY;
      const logs: WeightLogEntry[] = [
        makeWeightLog("future", refMs + 1, 90.0),
        makeWeightLog("boundary-in", refMs - 7 * MS_PER_DAY, 70.0),
        makeWeightLog("mid", refMs - 3 * MS_PER_DAY, 69.51),
        makeWeightLog("too-old", refMs - 7 * MS_PER_DAY - 1, 80.0),
        makeWeightLog("today", refMs, 69.25)
      ];

      // Included: 70.0, 69.51, 69.25 => avg 69.58666... => 69.59
      expect(computeRollingWeightAverage(logs, refMs)).toBe(69.59);

      // Omitting referenceTimestampMs defaults to the latest chronological entry (future: 90.0)
      // Window becomes [refMs + 1 - 7d, refMs + 1] -> includes mid, today, future (70.0 excluded by 1ms)
      // (69.51 + 69.25 + 90.0) / 3 = 76.2533... => 76.25
      expect(computeRollingWeightAverage(logs)).toBe(76.25);
    });

    it("handles windowDays = 0, negative windowDays fallback to 7 days, and single-log arrays", () => {
      const refMs = BASE_START_MS + 5 * MS_PER_DAY;
      const logs: WeightLogEntry[] = [
        makeWeightLog("too-old", refMs - 7 * MS_PER_DAY - 1, 80.0),
        makeWeightLog("in-7d", refMs - 5 * MS_PER_DAY, 70.4),
        makeWeightLog("prev-ms", refMs - 1, 71.0),
        makeWeightLog("exact", refMs, 69.25),
        makeWeightLog("next-ms", refMs + 1, 72.0)
      ];

      // windowDays = 0 matches only entries with exact timestamp === refMs
      expect(computeRollingWeightAverage(logs, refMs, 0)).toBe(69.25);
      expect(
        computeRollingWeightAverage([makeWeightLog("prev", refMs - 1, 71.0)], refMs, 0)
      ).toBeNull();

      // Negative windowDays falls back to 7 days: includes in-7d (70.4), prev-ms (71.0), exact (69.25)
      // (70.4 + 71.0 + 69.25) / 3 = 70.21666... => 70.22
      expect(computeRollingWeightAverage(logs, refMs, -3)).toBe(70.22);

      // Single-log array
      const singleLog = makeWeightLog("single", refMs - 2 * MS_PER_DAY, 68.756);
      expect(computeRollingWeightAverage([singleLog])).toBe(68.76);
      expect(computeRollingWeightAverage([singleLog], refMs)).toBe(68.76);
      expect(computeRollingWeightAverage([singleLog], refMs + 10 * MS_PER_DAY)).toBeNull();
    });
  });

  // ============================================================================
  // 2. adaptivePlanEngine.ts — calculateBaselineTdee & clampAdaptiveCalories
  // ============================================================================
  describe("calculateBaselineTdee & clampAdaptiveCalories", () => {
    it("computes baseline TDEE matching biometrics and clamps strictly to [-500, +400] and >= 1200 floor", () => {
      const tdee = calculateBaselineTdee(DEFAULT_BASELINE_BIOMETRICS);
      expect(tdee).toBeGreaterThan(1700);
      expect(ADAPTIVE_MAX_DEFICIT_KCAL).toBe(500);
      expect(ADAPTIVE_MAX_SURPLUS_KCAL).toBe(400);
      expect(SAFE_CALORIE_FLOOR_KCAL).toBe(1200);

      expect(clampAdaptiveCalories(tdee - 900, tdee)).toBe(tdee - 500);
      expect(clampAdaptiveCalories(tdee + 900, tdee)).toBe(tdee + 400);
      expect(clampAdaptiveCalories(tdee - 150.4, tdee)).toBe(tdee - 150);

      // Low-TDEE edge case never drops below 1200 kcal floor
      const petiteBiometrics: UserBiometrics = {
        ...DEFAULT_BASELINE_BIOMETRICS,
        weightKg: 42,
        heightCm: 148,
        age: 62,
        gender: "female",
        bodyFatPct: undefined,
        weeklyWorkoutFrequency: 1,
        activityLevel: "sedentary"
      };
      const lowTdee = calculateBaselineTdee(petiteBiometrics);
      expect(lowTdee).toBeLessThan(1700);
      expect(clampAdaptiveCalories(800, lowTdee)).toBe(1200);
      expect(clampAdaptiveCalories(500, 1000)).toBe(1200);
      expect(clampAdaptiveCalories(1800, 1000)).toBe(1400);
      expect(clampAdaptiveCalories(Number.NaN, tdee)).toBe(tdee - 500);
    });
  });

  // ============================================================================
  // 3. adaptivePlanEngine.ts — evaluateWeighInAdaptation
  // ============================================================================
  describe("evaluateWeighInAdaptation", () => {
    it("smooths single-day spikes via 7-day rolling avg, respects TDEE bounds, and never mutates cycle or logs", () => {
      const fatLossBiometrics: UserBiometrics = {
        ...DEFAULT_BASELINE_BIOMETRICS,
        goal: "fat_loss"
      };
      const cycle = generate14DayPlan(fatLossBiometrics, BASE_START_MS);
      const originalCycleSnapshot = JSON.stringify(cycle);
      const day5Ms = BASE_START_MS + 5 * MS_PER_DAY;

      // Baseline weight is 70 kg; 4 steady logs around 69.5 + 1 sudden water spike to 74.0
      const logs: WeightLogEntry[] = [
        makeWeightLog("w1", BASE_START_MS + MS_PER_DAY, 69.5),
        makeWeightLog("w2", BASE_START_MS + 2 * MS_PER_DAY, 69.4),
        makeWeightLog("w3", BASE_START_MS + 3 * MS_PER_DAY, 69.5),
        makeWeightLog("w4", BASE_START_MS + 4 * MS_PER_DAY, 69.6),
        makeWeightLog("w5", day5Ms, 74.0)
      ];
      const originalLogsSnapshot = JSON.stringify(logs);

      const projection = evaluateWeighInAdaptation(cycle, logs, day5Ms);

      expect(projection.isMidCycleHold).toBe(true);
      expect(projection.latestWeightKg).toBe(74.0);
      // 7-day rolling avg = (69.5 + 69.4 + 69.5 + 69.6 + 74.0) / 5 = 70.40
      expect(projection.rollingAverageWeightKg).toBe(70.4);
      expect(projection.rollingWeightDeltaKg).toBe(0.4);
      expect(projection.windowLogCount).toBe(5);
      // Current cycle is fat_loss (baselineTdee - 500), so even with -100 nominal adjustment,
      // clampAdaptiveCalories enforces the -500 kcal max deficit relative to baselineTdee.
      expect(projection.projectedDailyCalories).toBe(
        Math.max(1200, projection.baselineTdee - 500)
      );
      expect(projection.projectedDailyCalories).toBeGreaterThanOrEqual(1200);
      expect(projection.summaryMessage).toContain("Mid-cycle guard active");

      // Strict non-mutation guarantee
      expect(JSON.stringify(cycle)).toBe(originalCycleSnapshot);
      expect(JSON.stringify(logs)).toBe(originalLogsSnapshot);
    });

    it("holds targets on empty logs or single zero-delta baseline weigh-in, and flags review ready at >= 14 days", () => {
      const bulkBiometrics: UserBiometrics = {
        ...DEFAULT_BASELINE_BIOMETRICS,
        goal: "muscle_gain"
      };
      const cycle = generate14DayPlan(bulkBiometrics, BASE_START_MS);
      const day2Ms = BASE_START_MS + 2 * MS_PER_DAY;
      const day14Ms = BASE_START_MS + CYCLE_LENGTH_DAYS * MS_PER_DAY;

      const emptyProj = evaluateWeighInAdaptation(cycle, [], day2Ms);
      expect(emptyProj.rollingAverageWeightKg).toBeNull();
      expect(emptyProj.projectedDailyCalories).toBe(cycle.targetDailyCalories);
      expect(emptyProj.calorieDeltaFromCurrent).toBe(0);
      expect(emptyProj.isMidCycleHold).toBe(true);

      const baselineOnlyProj = evaluateWeighInAdaptation(
        cycle,
        [makeWeightLog("w0", day2Ms, cycle.baselineBiometrics.weightKg)],
        day2Ms
      );
      expect(baselineOnlyProj.rollingWeightDeltaKg).toBe(0);
      expect(baselineOnlyProj.projectedDailyCalories).toBe(cycle.targetDailyCalories);
      expect(baselineOnlyProj.calorieDeltaFromCurrent).toBe(0);

      // Day 14 review ready with excessive weight gain (> +1.0 kg -> -100 kcal within bounds)
      const surplusLogs = [
        makeWeightLog("w10", day14Ms - 2 * MS_PER_DAY, 72.0),
        makeWeightLog("w11", day14Ms, 72.2)
      ];
      const dueProj = evaluateWeighInAdaptation(cycle, surplusLogs, day14Ms);
      expect(isCycleBiWeeklyReviewDue(cycle, day14Ms)).toBe(true);
      expect(dueProj.isMidCycleHold).toBe(false);
      expect(dueProj.projectedDailyCalories).toBeLessThanOrEqual(
        dueProj.baselineTdee + 400
      );
      expect(dueProj.projectedDailyCalories).toBe(cycle.targetDailyCalories - 100);
      expect(dueProj.summaryMessage).toContain("14-day review ready");
    });

    it("ignores future-only logs, matches projectedMacroSplit to projectedDailyCalories, and enforces 1200 kcal floor when baselineTdee < 1700", () => {
      const cutCycle = generate14DayPlan(
        { ...DEFAULT_BASELINE_BIOMETRICS, goal: "cut" },
        BASE_START_MS
      );
      const day3Ms = BASE_START_MS + 3 * MS_PER_DAY;
      const day14Ms = BASE_START_MS + CYCLE_LENGTH_DAYS * MS_PER_DAY;

      // Future-only logs (timestampMs > nowMs) -> latestWeightKg & rollingAverageWeightKg are null
      const futureLogs = [
        makeWeightLog("future-1", day3Ms + 1, 72.5),
        makeWeightLog("future-2", day3Ms + MS_PER_DAY, 73.0)
      ];
      const futureProj = evaluateWeighInAdaptation(cutCycle, futureLogs, day3Ms);
      expect(futureProj.latestWeightKg).toBeNull();
      expect(futureProj.rollingAverageWeightKg).toBeNull();
      expect(futureProj.windowLogCount).toBe(0);
      expect(futureProj.rollingWeightDeltaKg).toBe(0);
      expect(futureProj.projectedDailyCalories).toBe(cutCycle.targetDailyCalories);
      expect(futureProj.projectedMacroSplit).toEqual(
        calculateMacroSplit(futureProj.projectedDailyCalories, cutCycle.goal)
      );

      // Rapid fat loss (> 1.5 kg below baseline) triggers +150 kcal and matching projectedMacroSplit
      const rapidLossProj = evaluateWeighInAdaptation(
        cutCycle,
        [makeWeightLog("loss-1", day14Ms - MS_PER_DAY, 68.0)],
        day14Ms
      );
      expect(rapidLossProj.projectedDailyCalories).toBe(
        cutCycle.targetDailyCalories + 150
      );
      expect(rapidLossProj.projectedMacroSplit).toEqual(
        calculateMacroSplit(rapidLossProj.projectedDailyCalories, cutCycle.goal)
      );

      // Petite user with baselineTdee < 1700 always respects >= 1200 kcal floor even on stalled deficit
      const petiteBiometrics: UserBiometrics = {
        ...DEFAULT_BASELINE_BIOMETRICS,
        weightKg: 42,
        heightCm: 148,
        age: 62,
        gender: "female",
        bodyFatPct: undefined,
        weeklyWorkoutFrequency: 1,
        activityLevel: "sedentary",
        goal: "fat_loss"
      };
      const petiteCycle = generate14DayPlan(petiteBiometrics, BASE_START_MS);
      const petiteProj = evaluateWeighInAdaptation(
        petiteCycle,
        [makeWeightLog("stalled", day14Ms, 42.5)],
        day14Ms
      );
      expect(petiteProj.baselineTdee).toBeLessThan(1700);
      expect(petiteProj.projectedDailyCalories).toBeGreaterThanOrEqual(
        SAFE_CALORIE_FLOOR_KCAL
      );
      expect(petiteProj.projectedDailyCalories).toBe(SAFE_CALORIE_FLOOR_KCAL);
      expect(petiteProj.projectedMacroSplit).toEqual(
        calculateMacroSplit(petiteProj.projectedDailyCalories, petiteCycle.goal)
      );
    });
  });

  // ============================================================================
  // 4. adaptivePlanEngine.ts — buildSevenDayCadence & calculateLiveStreak
  // ============================================================================
  describe("buildSevenDayCadence & calculateLiveStreak", () => {
    it("aligns weekday labels to exact calendar dates across Week 1, Week 2, and >14 day clamp", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);
      const day2Ms = BASE_START_MS + 2 * MS_PER_DAY; // Day 3 (index 2, Wednesday)
      const signedKeyDay1 = makeDailyProofSignedKey(cycle.id, 0);
      const signedKeyDay3 = makeDailyProofSignedKey(cycle.id, 2);

      const week1Cycle: AdaptivePlanCycle = {
        ...cycle,
        dailyPlans: cycle.dailyPlans.map((p, idx) =>
          idx === 1 ? { ...p, completed: true } : p
        )
      };

      const week1 = buildSevenDayCadence(week1Cycle, day2Ms, {
        [signedKeyDay1]: true,
        [signedKeyDay3]: true
      });
      expect(week1).toHaveLength(7);
      expect(week1.map((d) => d.dayNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(week1.map((d) => d.weekdayLabel)).toEqual(
        week1.map((d) => {
          const idx = new Date(`${d.date}T00:00:00`).getDay();
          return CADENCE_WEEKDAY_LABELS[idx]!;
        })
      );
      expect(week1[0]!.weekdayLabel).toBe("Mon");
      expect(week1[2]!.isToday).toBe(true);
      expect(week1.filter((d) => d.isToday)).toHaveLength(1);
      expect(week1.map((d) => d.isCompleted)).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
        false
      ]);

      // Week 2 & >14 days clamp to days 8..14 with day 14 marked isToday
      const day20Ms = BASE_START_MS + 20 * MS_PER_DAY;
      const week2 = buildSevenDayCadence(cycle, day20Ms);
      expect(week2.map((d) => d.dayNumber)).toEqual([8, 9, 10, 11, 12, 13, 14]);
      expect(week2[6]!.isToday).toBe(true);
      expect(week2.filter((d) => d.isToday)).toHaveLength(1);
    });

    it("computes live streak accurately for null, day 0, unsigned today, gaps, and >14 days", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);

      expect(calculateLiveStreak(null, {}, BASE_START_MS)).toBe(0);
      expect(calculateLiveStreak(cycle, {}, BASE_START_MS - 1000)).toBe(0);

      // Day 0 unsigned -> 0; Day 0 signed -> 1
      expect(calculateLiveStreak(cycle, {}, BASE_START_MS)).toBe(0);
      expect(
        calculateLiveStreak(
          cycle,
          { [makeDailyProofSignedKey(cycle.id, 0)]: true },
          BASE_START_MS
        )
      ).toBe(1);

      // Day 3 (index 3) where days 0,1,2 are done and day 3 (today) is unsigned -> streak 3
      const day3Ms = BASE_START_MS + 3 * MS_PER_DAY;
      const map3 = {
        [makeDailyProofSignedKey(cycle.id, 0)]: true,
        [makeDailyProofSignedKey(cycle.id, 1)]: true,
        [makeDailyProofSignedKey(cycle.id, 2)]: true
      };
      expect(calculateLiveStreak(cycle, map3, day3Ms)).toBe(3);

      // Day 4 (index 4) when day 3 was missed -> streak resets to 0
      const day4Ms = BASE_START_MS + 4 * MS_PER_DAY;
      expect(calculateLiveStreak(cycle, map3, day4Ms)).toBe(0);

      // If day 4 is signed despite missing day 3 -> streak 1
      expect(
        calculateLiveStreak(
          cycle,
          { ...map3, [makeDailyProofSignedKey(cycle.id, 4)]: true },
          day4Ms
        )
      ).toBe(1);

      // Clamps at day index 13 (>14 days elapsed)
      const allCompletedCycle: AdaptivePlanCycle = {
        ...cycle,
        dailyPlans: cycle.dailyPlans.map((p) => ({ ...p, completed: true }))
      };
      expect(
        calculateLiveStreak(allCompletedCycle, {}, BASE_START_MS + 20 * MS_PER_DAY)
      ).toBe(14);
    });

    it("handles UTC-midnight boundary start dates and falls back safely on malformed plan.date", () => {
      const utcBoundaryStartMs = Date.UTC(2026, 9, 5, 23, 30, 0);
      const boundaryCycle = generate14DayPlan(
        DEFAULT_BASELINE_BIOMETRICS,
        utcBoundaryStartMs
      );
      const day2BoundaryMs = utcBoundaryStartMs + 2 * MS_PER_DAY;
      const cadence = buildSevenDayCadence(boundaryCycle, day2BoundaryMs);

      expect(cadence).toHaveLength(7);
      expect(cadence[0]!.date).toBe("2026-10-05");
      expect(cadence[0]!.weekdayLabel).toBe("Mon");
      expect(cadence.map((d) => d.weekdayLabel)).toEqual(
        cadence.map((d) => {
          const idx = new Date(`${d.date}T00:00:00`).getDay();
          return CADENCE_WEEKDAY_LABELS[idx]!;
        })
      );
      expect(cadence[2]!.isToday).toBe(true);

      const malformedCycle: AdaptivePlanCycle = {
        ...boundaryCycle,
        dailyPlans: boundaryCycle.dailyPlans.map((p, idx) =>
          idx === 0 ? { ...p, date: "not-a-valid-date" } : p
        )
      };
      const malformedCadence = buildSevenDayCadence(malformedCycle, utcBoundaryStartMs);
      expect(malformedCadence[0]!.weekdayLabel).toBe("Mon");
      expect(malformedCadence[0]!.isToday).toBe(true);
    });
  });

  // ============================================================================
  // 5. adaptiveStorage.ts — saveLastLogTimestampMs & getLastLogTimestampMs
  // ============================================================================
  describe("AdaptiveStorage lastLogTimestampMs persistence", () => {
    it("roundtrips valid timestamps, rejects non-finite/non-positive writes, handles corrupt reads, detects tampering, and purges cleanly", async () => {
      const backend = new MemoryBackend();
      const storage = new AdaptiveStorage(TEST_SECRET, backend);
      setAdaptiveStorage(storage);

      expect(await getLastLogTimestampMs()).toBeNull();

      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity, 0, -500]) {
        await expect(saveLastLogTimestampMs(bad)).rejects.toThrow(
          "lastLogTimestampMs must be a positive finite number"
        );
      }
      expect(backend.items.has(ADAPTIVE_STORAGE_KEYS.LAST_LOG_TIMESTAMP_MS)).toBe(
        false
      );

      await saveLastLogTimestampMs(1_700_000_000_000);
      expect(await getLastLogTimestampMs()).toBe(1_700_000_000_000);
      expect(backend.items.has(ADAPTIVE_STORAGE_KEYS.LAST_LOG_TIMESTAMP_MS)).toBe(
        true
      );

      // Corrupt non-number or <= 0 decrypted payloads gracefully return null
      const adapter = storage.getAdapter();
      for (const corrupt of ["1700000000000", {}, null, 0, -42]) {
        await adapter.setEncryptedItem(
          ADAPTIVE_STORAGE_KEYS.LAST_LOG_TIMESTAMP_MS,
          corrupt
        );
        expect(await storage.getLastLogTimestampMs()).toBeNull();
      }

      // Restore valid value then tamper ciphertext -> MAC verification must fail
      await storage.saveLastLogTimestampMs(1_700_000_123_456);
      const rawEnvelope = backend.items.get(
        ADAPTIVE_STORAGE_KEYS.LAST_LOG_TIMESTAMP_MS
      )!;
      const envelope = JSON.parse(rawEnvelope) as {
        v: number;
        iv: string;
        ciphertext: string;
        mac: string;
      };
      const flippedChar = envelope.ciphertext.startsWith("0") ? "1" : "0";
      backend.items.set(
        ADAPTIVE_STORAGE_KEYS.LAST_LOG_TIMESTAMP_MS,
        JSON.stringify({
          ...envelope,
          ciphertext: flippedChar + envelope.ciphertext.slice(1)
        })
      );
      await expect(storage.getLastLogTimestampMs()).rejects.toThrow(
        /tampering detected/i
      );

      // Clear & purge remove the key completely
      await storage.saveLastLogTimestampMs(1_700_000_123_456);
      await storage.clearAllAdaptiveData();
      expect(backend.items.has(ADAPTIVE_STORAGE_KEYS.LAST_LOG_TIMESTAMP_MS)).toBe(
        false
      );
      expect(await storage.getLastLogTimestampMs()).toBeNull();

      await storage.saveLastLogTimestampMs(1_700_000_999_999);
      await purgeAdaptiveStorageKeys(backend);
      expect(backend.items.has(ADAPTIVE_STORAGE_KEYS.LAST_LOG_TIMESTAMP_MS)).toBe(
        false
      );
    });
  });

  // ============================================================================
  // 6. DashboardScreen UI & Weigh-In Regression Tests
  // ============================================================================
  describe("DashboardScreen live cadence, non-mutating weigh-in & review gate", () => {
    it("renders live cadence weekdays with zero hardcoded flames on fresh state and resolves active today ring + proofSignedMap", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);
      const day2Ms = BASE_START_MS + 2 * MS_PER_DAY; // Day 3 (Wed)

      const freshMarkup = renderToStaticMarkup(
        React.createElement(DashboardScreen, {
          streakCount: 0,
          tokenBalanceDht: "0.0",
          lastProofHash: null,
          targetAssessment: BASE_ASSESSMENT,
          activeCycle: cycle,
          currentTimestampMs: day2Ms,
          userAddress: TEST_ADDRESS
        })
      );

      expect(freshMarkup).toContain("Day 3 of 14");
      expect(freshMarkup).toContain("0%");
      // Only Day 3 is active (not completed, no proof signed, 0 streak) -> no flames in cadence pills
      expect(freshMarkup).toContain("🔥 0 Days Active");
      const freshTree = renderWithHarness(DashboardScreen, {
        streakCount: 0,
        tokenBalanceDht: "0.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        currentTimestampMs: day2Ms,
        userAddress: TEST_ADDRESS
      });
      const freshPills = findAllElements(
        freshTree,
        (elProps) =>
          typeof elProps.accessibilityLabel === "string" &&
          elProps.accessibilityLabel.startsWith("Cadence ")
      );
      expect(freshPills).toHaveLength(7);
      for (const pill of freshPills) {
        expect(pill.accessibilityLabel).not.toContain("Completed");
        expect(hasText(pill.children as React.ReactNode, "🔥")).toBe(false);
      }
      // Minimal default weight should reflect cycle baseline (70 kg), never fake 69.6 kg
      expect(freshMarkup).not.toContain("69.6 kg");
      expect(freshMarkup).toContain("Mid-Cycle Guard");
      expect(freshMarkup).not.toContain("BI-WEEKLY CHECK-IN DUE");

      // Signing today's proof in proofSignedMap closes the habit ring & lights today's cadence flame
      const signedKeyToday = makeDailyProofSignedKey(cycle.id, 2);
      const signedTree = renderWithHarness(DashboardScreen, {
        streakCount: 1,
        tokenBalanceDht: "10.0",
        lastProofHash: ("0x" + "11".repeat(32)) as Bytes32,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        currentTimestampMs: day2Ms,
        proofSignedMap: { [signedKeyToday]: true },
        userAddress: TEST_ADDRESS
      });

      expect(hasText(signedTree, "Ring Closed")).toBe(true);
      expect(hasText(signedTree, "100%")).toBe(true);
      const todayPill = findByLabel(
        signedTree,
        `Cadence Wed ${cycle.dailyPlans[2]!.date} Today Completed`
      );
      expect(todayPill).not.toBeNull();
    });

    it("syncs modal inputs to chronologically latest weigh-in and logs new weigh-in without mutating active day targets or logged progress", async () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);
      const originalTargetCalories = cycle.targetDailyCalories;
      const day4Ms = BASE_START_MS + 4 * MS_PER_DAY;
      const todayPlanWithProgress: DailyPlan = {
        ...cycle.dailyPlans[4]!,
        loggedCaloriesKcal: 1120,
        loggedProteinGrams: 95,
        loggedCarbsGrams: 110,
        loggedFatGrams: 30,
        exercises: cycle.dailyPlans[4]!.exercises.map((ex, idx) =>
          idx === 0 ? { ...ex, completed: true } : ex
        )
      };

      // Deliberately pass weightLogs unsorted so latest chronological entry (68.8 at day3) is NOT tail
      const unsortedLogs: WeightLogEntry[] = [
        makeWeightLog("w-day3", BASE_START_MS + 3 * MS_PER_DAY, 68.8, 17.5),
        makeWeightLog("w-day1", BASE_START_MS + MS_PER_DAY, 69.9, 18.4)
      ];

      const loggedEntries: WeightLogEntry[] = [];
      const props: DashboardScreenProps = {
        streakCount: 3,
        tokenBalanceDht: "30.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        todayPlan: todayPlanWithProgress,
        weightLogs: unsortedLogs,
        currentTimestampMs: day4Ms,
        onLogWeightEntry: async (entry) => {
          loggedEntries.push(entry);
        },
        userAddress: TEST_ADDRESS
      };

      let tree = renderWithHarness(DashboardScreen, props);
      expect(hasText(tree, "Latest Weight68.8 kg")).toBe(true);

      // Mid-cycle review button is disabled
      const reviewBtn = findByLabel(tree, "14-Day Plan Review");
      expect(reviewBtn).not.toBeNull();
      expect(reviewBtn!.disabled).toBe(true);

      // Open Weight Modal -> inputs sync to chronologically latest (68.8 kg / 17.5%)
      const openModalBtn = findByLabel(tree, "Log Weight / Biometrics");
      expect(openModalBtn).not.toBeNull();
      (openModalBtn!.onPress as () => void)();

      tree = renderWithHarness(DashboardScreen, props);
      const weightInput = findByLabel(tree, "Body Weight Input");
      const bodyFatInput = findByLabel(tree, "Body Fat Input");
      expect(weightInput).not.toBeNull();
      expect(bodyFatInput).not.toBeNull();
      expect(weightInput!.value).toBe("68.8");
      expect(bodyFatInput!.value).toBe("17.5");

      // Enter a 1-day water-weight spike (73.5 kg) and save
      (weightInput!.onChangeText as (v: string) => void)("73.5");
      tree = renderWithHarness(DashboardScreen, props);

      const saveBtn = findByLabel(tree, "Save Weigh-In");
      expect(saveBtn).not.toBeNull();
      (saveBtn!.onPress as () => void)();
      await vi.waitFor(() => {
        expect(loggedEntries).toHaveLength(1);
      });
      await flushMicrotasks();

      tree = renderWithHarness(DashboardScreen, props);

      //Wait until async saveWeightLog fallback + state update settles
      await vi.waitFor(
        () => {
          tree = renderWithHarness(DashboardScreen, props);
          expect(hasText(tree, "today's targets & logged progress unchanged")).toBe(
            true
          );
        },
        { timeout: 5000 }
      );

      expect(loggedEntries).toHaveLength(1);
      expect(loggedEntries[0]!.weightKg).toBe(73.5);
      expect(loggedEntries[0]!.timestampMs).toBe(day4Ms);

      // Active cycle targets & todayPlan logged progress remain 100% untouched
      expect(cycle.targetDailyCalories).toBe(originalTargetCalories);
      expect(todayPlanWithProgress.targetCaloriesKcal).toBe(originalTargetCalories);
      expect(todayPlanWithProgress.loggedCaloriesKcal).toBe(1120);
      expect(todayPlanWithProgress.loggedProteinGrams).toBe(95);
      expect(todayPlanWithProgress.exercises[0]!.completed).toBe(true);
      expect(todayPlanWithProgress.completed).toBe(false);
    });

    it("enforces synchronous double-tap guard, surfaces errors via onError, and resets isSubmittingWeight in finally", async () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);
      const day2Ms = BASE_START_MS + 2 * MS_PER_DAY;
      const deferred = createDeferred<void>();
      const onLogWeightEntry = vi.fn().mockReturnValue(deferred.promise);
      const onError = vi.fn();

      const props: DashboardScreenProps = {
        streakCount: 1,
        tokenBalanceDht: "10.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        currentTimestampMs: day2Ms,
        onLogWeightEntry,
        onError,
        userAddress: TEST_ADDRESS
      };

      let tree = renderWithHarness(DashboardScreen, props);
      const openBtn = findByLabel(tree, "Log Weight / Biometrics");
      (openBtn!.onPress as () => void)();
      tree = renderWithHarness(DashboardScreen, props);

      const weightInput = findByLabel(tree, "Body Weight Input");
      (weightInput!.onChangeText as (v: string) => void)("69.2");
      tree = renderWithHarness(DashboardScreen, props);

      const saveBtn = findByLabel(tree, "Save Weigh-In");
      // Rapid synchronous double-tap before React re-renders
      (saveBtn!.onPress as () => void)();
      (saveBtn!.onPress as () => void)();

      expect(onLogWeightEntry).toHaveBeenCalledTimes(1);

      tree = renderWithHarness(DashboardScreen, props);
      const pendingSaveBtn = findByLabel(tree, "Save Weigh-In");
      expect(pendingSaveBtn!.disabled).toBe(true);
      expect(hasText(tree, "Saving...")).toBe(true);

      // Reject async save -> onError fires, modal stays open with error, finally resets disabled=false
      deferred.reject(new Error("Vault write failed"));
      await flushMicrotasks();

      tree = renderWithHarness(DashboardScreen, props);
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
        "Vault write failed"
      );
      expect(hasText(tree, "Vault write failed")).toBe(true);
      const recoveredSaveBtn = findByLabel(tree, "Save Weigh-In");
      expect(recoveredSaveBtn).not.toBeNull();
      expect(recoveredSaveBtn!.disabled).toBe(false);
    });

    it("enables 14-Day Plan Review only when reviewDue is true and gates PlanReviewModal mid-cycle", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);
      const day5Ms = BASE_START_MS + 5 * MS_PER_DAY;
      const day14Ms = BASE_START_MS + CYCLE_LENGTH_DAYS * MS_PER_DAY;

      // Mid-cycle: disabled=true and PlanReviewModal stays hidden
      const midTree = renderWithHarness(DashboardScreen, {
        streakCount: 4,
        tokenBalanceDht: "40.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        currentTimestampMs: day5Ms,
        userAddress: TEST_ADDRESS
      });
      const midBtn = findByLabel(midTree, "14-Day Plan Review");
      expect(midBtn!.disabled).toBe(true);
      const midModalEl = findElement(
        midTree,
        (_elProps, elType) => elType === PlanReviewModal
      );
      expect(midModalEl).not.toBeNull();
      expect(midModalEl!.visible).toBe(false);

      // Day 14: reviewDue=true -> button enabled, clicking opens PlanReviewModal
      resetHarness();
      const dueProps: DashboardScreenProps = {
        streakCount: 14,
        tokenBalanceDht: "140.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        currentTimestampMs: day14Ms,
        userAddress: TEST_ADDRESS
      };
      let dueTree = renderWithHarness(DashboardScreen, dueProps);
      const dueButtons = findAllElements(
        dueTree,
        (elProps) => elProps.accessibilityLabel === "14-Day Plan Review"
      );
      expect(dueButtons).toHaveLength(1);
      expect(dueButtons[0]!.disabled).toBe(false);

      (dueButtons[0]!.onPress as () => void)();
      dueTree = renderWithHarness(DashboardScreen, dueProps);
      const dueModalEl = findElement(
        dueTree,
        (_elProps, elType) => elType === PlanReviewModal
      );
      expect(dueModalEl).not.toBeNull();
      expect(dueModalEl!.visible).toBe(true);
      const modalMarkup = renderToStaticMarkup(
        React.createElement(
          PlanReviewModal,
          dueModalEl as unknown as PlanReviewModalProps
        )
      );
      expect(modalMarkup).toContain("Bi-Weekly Plan Review");
      expect(modalMarkup).toContain("Approve New Plan");
    });

    it("keeps reviewDue disabled mid-cycle even when a stale weigh-in is >= 14 days old", () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);
      const day2Ms = BASE_START_MS + 2 * MS_PER_DAY;
      const staleWeighInMs = BASE_START_MS - 20 * MS_PER_DAY; // 22 days before day2Ms

      const tree = renderWithHarness(DashboardScreen, {
        streakCount: 2,
        tokenBalanceDht: "20.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        weightLogs: [makeWeightLog("stale-prev-cycle", staleWeighInMs, 71.0)],
        currentTimestampMs: day2Ms,
        userAddress: TEST_ADDRESS
      });

      expect(hasText(tree, "Mid-Cycle Guard")).toBe(true);
      expect(hasText(tree, "BI-WEEKLY CHECK-IN DUE")).toBe(false);
      const reviewBtn = findByLabel(tree, "14-Day Plan Review");
      expect(reviewBtn).not.toBeNull();
      expect(reviewBtn!.disabled).toBe(true);

      const modalEl = findElement(
        tree,
        (_elProps, elType) => elType === PlanReviewModal
      );
      expect(modalEl).not.toBeNull();
      expect(modalEl!.visible).toBe(false);
    });

    it("passes TDEE-bounded 7-day rolling projection to Day-14 banner and PlanReviewModal", () => {
      const fatLossCycle = generate14DayPlan(
        { ...DEFAULT_BASELINE_BIOMETRICS, goal: "fat_loss" },
        BASE_START_MS
      );
      const day14Ms = BASE_START_MS + CYCLE_LENGTH_DAYS * MS_PER_DAY;
      // Stalled weight in last 7 days: legacy evaluateBiWeeklyReview would try -100 kcal below -500 TDEE deficit,
      // while bounded evaluateWeighInAdaptation clamps strictly to baselineTdee - 500.
      const logs: WeightLogEntry[] = [
        makeWeightLog("w-d0", BASE_START_MS, 70.0),
        makeWeightLog("w-d12", day14Ms - 2 * MS_PER_DAY, 70.2),
        makeWeightLog("w-d14", day14Ms, 70.4)
      ];
      const expectedProjection = evaluateWeighInAdaptation(fatLossCycle, logs, day14Ms);

      const dueProps: DashboardScreenProps = {
        streakCount: 14,
        tokenBalanceDht: "140.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: fatLossCycle,
        weightLogs: logs,
        adherencePct: 100,
        currentTimestampMs: day14Ms,
        userAddress: TEST_ADDRESS
      };

      let tree = renderWithHarness(DashboardScreen, dueProps);
      expect(
        hasText(
          tree,
          `Proposed: ${fatLossCycle.targetDailyCalories} → ${expectedProjection.projectedDailyCalories} kcal/day`
        )
      ).toBe(true);

      const reviewBtn = findByLabel(tree, "14-Day Plan Review");
      expect(reviewBtn!.disabled).toBe(false);
      (reviewBtn!.onPress as () => void)();

      tree = renderWithHarness(DashboardScreen, dueProps);
      const modalEl = findElement(
        tree,
        (_elProps, elType) => elType === PlanReviewModal
      );
      expect(modalEl).not.toBeNull();
      expect(modalEl!.visible).toBe(true);

      const review = modalEl!.review as ProposedPlanReview;
      expect(review.proposedDailyCalories).toBe(expectedProjection.projectedDailyCalories);
      expect(review.proposedDailyCalories).toBeGreaterThanOrEqual(
        Math.max(1200, expectedProjection.baselineTdee - 500)
      );
      expect(review.proposedDailyCalories).toBeLessThanOrEqual(
        Math.max(1200, expectedProjection.baselineTdee + 400)
      );
      expect(review.proposedMacroSplit).toEqual(expectedProjection.projectedMacroSplit);
      expect(review.calorieAdjustment).toBe(expectedProjection.calorieDeltaFromCurrent);
      expect(review.rollingAverageWeightKg).toBe(
        expectedProjection.rollingAverageWeightKg
      );
      expect(review.weightChangeKg).toBe(expectedProjection.rollingWeightDeltaKg);
      expect(review.rationale).toBe(expectedProjection.summaryMessage);
    });

    it("deduplicates repeated weigh-ins at identical nowMs without inflating rolling count", async () => {
      const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, BASE_START_MS);
      const day2Ms = BASE_START_MS + 2 * MS_PER_DAY;
      const savedEntries: WeightLogEntry[] = [];

      const props: DashboardScreenProps = {
        streakCount: 2,
        tokenBalanceDht: "20.0",
        lastProofHash: null,
        targetAssessment: BASE_ASSESSMENT,
        activeCycle: cycle,
        currentTimestampMs: day2Ms,
        onLogWeightEntry: async (entry) => {
          savedEntries.push(entry);
        },
        userAddress: TEST_ADDRESS
      };

      let tree = renderWithHarness(DashboardScreen, props);

      // First weigh-in at day2Ms: 71.0 kg
      (findByLabel(tree, "Log Weight / Biometrics")!.onPress as () => void)();
      tree = renderWithHarness(DashboardScreen, props);
      (findByLabel(tree, "Body Weight Input")!.onChangeText as (v: string) => void)("71.0");
      tree = renderWithHarness(DashboardScreen, props);
      (findByLabel(tree, "Save Weigh-In")!.onPress as () => void)();

      await vi.waitFor(
        () => {
          expect(savedEntries).toHaveLength(1);
        },
        { timeout: 5000 }
      );
      await vi.waitFor(
        () => {
          tree = renderWithHarness(DashboardScreen, props);
          expect(hasText(tree, "7-day rolling avg: 71 kg")).toBe(true);
        },
        { timeout: 5000 }
      );

      // Second weigh-in at identical day2Ms: 69.0 kg -> same id (`wlog_${day2Ms}`) must upsert, not average [71, 69] = 70
      (findByLabel(tree, "Log Weight / Biometrics")!.onPress as () => void)();
      tree = renderWithHarness(DashboardScreen, props);
      (findByLabel(tree, "Body Weight Input")!.onChangeText as (v: string) => void)("69.0");
      tree = renderWithHarness(DashboardScreen, props);
      (findByLabel(tree, "Save Weigh-In")!.onPress as () => void)();

      await vi.waitFor(
        () => {
          expect(savedEntries).toHaveLength(2);
        },
        { timeout: 5000 }
      );
      await vi.waitFor(
        () => {
          tree = renderWithHarness(DashboardScreen, props);
          expect(hasText(tree, "7-day rolling avg: 69 kg")).toBe(true);
        },
        { timeout: 5000 }
      );

      expect(savedEntries[0]!.id).toBe(savedEntries[1]!.id);
      expect(hasText(tree, "7-day rolling avg: 70 kg")).toBe(false);
      expect(hasText(tree, "Latest Weight69 kg")).toBe(true);
      expect(hasText(tree, "7-Day Rolling Avg69 kg")).toBe(true);
    });
  });
});
