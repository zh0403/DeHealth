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

import {
  DUAL_TRACK_FOOD_PRESETS,
  MicroCheckInScreen,
  MicroCheckInScreenProps
} from "../screens/MicroCheckInScreen";
import { generate14DayPlan } from "../services/adaptivePlanEngine";
import {
  ADAPTIVE_STORAGE_KEYS,
  AdaptiveStorage,
  appendEphemeralFoodLog,
  DailyEphemeralLogBuffer,
  formatLocalCalendarDateKey,
  getDailyEphemeralLogBuffer,
  getDailyProofSigned,
  getDailyProofSignedMap,
  makeDailyProofSignedKey,
  purgeDailyEphemeralLogBuffer,
  recordEphemeralExerciseTick,
  recordEphemeralStepLog,
  resetAdaptiveStorage,
  rolloverStaleDailyEphemeralLogBuffer,
  saveDailyEphemeralLogBuffer,
  saveDailyProofSigned,
  setAdaptiveStorage
} from "../storage/adaptiveStorage";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../storage/encryptedStorageAdapter";

class InMemoryStorageBackend implements KeyValueStorageBackend {
  private readonly store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  getRaw(key: string): string | undefined {
    return this.store.get(key);
  }

  setRaw(key: string, value: string): void {
    this.store.set(key, value);
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

function findByTestId(
  node: React.ReactNode,
  testID: string
): Record<string, unknown> | null {
  return findElement(node, (elProps) => elProps.testID === testID);
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

const TEST_PRIVATE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";
const TEST_GATE_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const TEST_SECRET = ("0x" + "cd".repeat(32)) as Bytes32;
const TEST_PROFILE: UserProfile = {
  age: 28,
  gender: "male",
  bodyFatPct: 16.0,
  muscleMassKg: 37.5
};

describe("Ephemeral Daily Buffer & Dual-Mode Check-In Suite", () => {
  let backend: InMemoryStorageBackend;
  let adapter: EncryptedStorageAdapter;
  let storage: AdaptiveStorage;
  let wallet: Wallet;
  let cycleId: string;
  let emptyDay: DailyPlan;

  beforeEach(() => {
    resetHarness();
    resetAdaptiveStorage();
    backend = new InMemoryStorageBackend();
    adapter = new EncryptedStorageAdapter("VaultPassphraseBuffer53!", backend);
    storage = new AdaptiveStorage(adapter);
    setAdaptiveStorage(storage);

    wallet = new Wallet(TEST_PRIVATE_KEY);
    const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
    cycleId = cycle.id;
    emptyDay = {
      ...cycle.dailyPlans[0]!,
      loggedCaloriesKcal: 0,
      loggedProteinGrams: 0,
      loggedCarbsGrams: 0,
      loggedFatGrams: 0,
      completed: false,
      exercises: cycle.dailyPlans[0]!.exercises.map((ex) => ({
        ...ex,
        completed: false
      }))
    };
  });

  afterEach(() => {
    resetHarness();
    resetAdaptiveStorage();
  });

  // ==========================================================================
  // 1. AdaptiveStorage DailyEphemeralLogBuffer Unit Tests
  // ==========================================================================
  describe("AdaptiveStorage DailyEphemeralLogBuffer", () => {
    it("formats local calendar date keys as YYYY-MM-DD and rejects non-finite timestamps", () => {
      const jan5Ms = new Date(2026, 0, 5, 23, 59, 0).getTime();
      expect(formatLocalCalendarDateKey(jan5Ms)).toBe("2026-01-05");

      const nov21Ms = new Date(2026, 10, 21, 9, 15, 0).getTime();
      expect(formatLocalCalendarDateKey(nov21Ms)).toBe("2026-11-21");

      expect(formatLocalCalendarDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(() => formatLocalCalendarDateKey(Number.NaN)).toThrow();
      expect(() => formatLocalCalendarDateKey(Number.POSITIVE_INFINITY)).toThrow();
    });

    it("validates schemas strictly on save and falls back to null on invalid stored payload", async () => {
      expect(await getDailyEphemeralLogBuffer()).toBeNull();

      const validBuffer: DailyEphemeralLogBuffer = {
        dateKey: "2026-11-21",
        cycleId,
        dayNumber: 1,
        foodLogs: [
          {
            id: "meal-1",
            presetId: "preset_chicken_breast",
            name: "Grilled Chicken Breast",
            grams: 150,
            caloriesKcal: 247.5,
            proteinGrams: 46.5,
            carbsGrams: 0,
            fatGrams: 5.4,
            loggedAtMs: 1_763_712_000_000
          }
        ],
        exerciseTicks: [
          {
            exerciseId: "ex-1",
            name: "Goblet Squat",
            completed: true,
            updatedAtMs: 1_763_712_100_000
          }
        ],
        stepLogs: [
          {
            id: "step-1",
            steps: 5250,
            source: "hardware",
            recordedAtMs: 1_763_712_200_000
          }
        ],
        updatedAtMs: 1_763_712_200_000
      };

      await saveDailyEphemeralLogBuffer(validBuffer);
      expect(await getDailyEphemeralLogBuffer()).toEqual(validBuffer);

      // Invalid dateKey, dayNumber, or empty cycleId fails Zod validation before encryption
      await expect(
        saveDailyEphemeralLogBuffer({
          ...validBuffer,
          dateKey: "2026/11/21"
        })
      ).rejects.toThrow();

      await expect(
        saveDailyEphemeralLogBuffer({
          ...validBuffer,
          dayNumber: 15
        })
      ).rejects.toThrow();

      await expect(
        saveDailyEphemeralLogBuffer({
          ...validBuffer,
          cycleId: "   "
        })
      ).rejects.toThrow();

      // Corrupt schema inside encrypted envelope returns null safely
      await adapter.setEncryptedItem(
        ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER,
        { dateKey: "invalid", dayNumber: 0 }
      );
      expect(await getDailyEphemeralLogBuffer()).toBeNull();
    });

    it("accumulates food, exercise ticks (upsert), and step logs incrementally and resets on new dateKey", async () => {
      const dateA = "2026-11-21";
      const dateB = "2026-11-22";

      await appendEphemeralFoodLog({
        dateKey: dateA,
        cycleId,
        dayNumber: 1,
        entry: {
          id: "m-1",
          presetId: "preset_chicken_breast",
          name: "Grilled Chicken Breast",
          grams: 200,
          caloriesKcal: 330,
          proteinGrams: 62,
          carbsGrams: 0,
          fatGrams: 7.2,
          loggedAtMs: 1_763_710_000_000
        }
      });

      await appendEphemeralFoodLog({
        dateKey: dateA,
        cycleId,
        dayNumber: 1,
        entry: {
          id: "m-2",
          presetId: "preset_white_rice",
          name: "Steamed White Rice",
          grams: 150,
          caloriesKcal: 195,
          proteinGrams: 4.1,
          carbsGrams: 42,
          fatGrams: 0.4,
          loggedAtMs: 1_763_710_500_000
        }
      });

      await recordEphemeralExerciseTick({
        dateKey: dateA,
        cycleId,
        dayNumber: 1,
        tick: {
          exerciseId: "ex-squat",
          name: "Goblet Squat",
          completed: true,
          updatedAtMs: 1_763_711_000_000
        }
      });

      // Upsert same exerciseId -> overwrites instead of duplicating
      await recordEphemeralExerciseTick({
        dateKey: dateA,
        cycleId,
        dayNumber: 1,
        tick: {
          exerciseId: "ex-squat",
          name: "Goblet Squat",
          completed: false,
          updatedAtMs: 1_763_711_500_000
        }
      });

      const afterSteps = await recordEphemeralStepLog({
        dateKey: dateA,
        cycleId,
        dayNumber: 1,
        entry: {
          id: "s-1",
          steps: 6420,
          source: "manual-fallback",
          recordedAtMs: 1_763_712_000_000
        }
      });

      expect(afterSteps.dateKey).toBe(dateA);
      expect(afterSteps.foodLogs).toHaveLength(2);
      expect(afterSteps.exerciseTicks).toHaveLength(1);
      expect(afterSteps.exerciseTicks[0]!.completed).toBe(false);
      expect(afterSteps.stepLogs).toHaveLength(1);
      expect(afterSteps.stepLogs[0]!.steps).toBe(6420);

      // Verify strict ciphertext opacity in raw storage backend
      const rawEnvelope = backend.getRaw(
        ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER
      );
      expect(rawEnvelope).toBeDefined();
      const parsedEnv = JSON.parse(rawEnvelope!) as Record<string, unknown>;
      expect(parsedEnv.v).toBe(1);
      expect(parsedEnv.ciphertext).toMatch(/^0x[0-9a-f]+$/);
      expect(parsedEnv.mac).toMatch(/^0x[0-9a-f]{64}$/);
      expect(rawEnvelope).not.toContain("Grilled Chicken Breast");
      expect(rawEnvelope).not.toContain("Steamed White Rice");
      expect(rawEnvelope).not.toContain("Goblet Squat");
      expect(rawEnvelope).not.toContain("foodLogs");
      expect(rawEnvelope).not.toContain("caloriesKcal");
      expect(rawEnvelope).not.toContain('"steps":6420');
      expect(rawEnvelope).not.toContain('"caloriesKcal":330');

      // Different dateKey resets cleanly to a fresh buffer
      const nextDayBuffer = await appendEphemeralFoodLog({
        dateKey: dateB,
        cycleId,
        dayNumber: 2,
        entry: {
          id: "m-3",
          presetId: "preset_oats",
          name: "Rolled Oats",
          grams: 100,
          caloriesKcal: 389,
          proteinGrams: 16.9,
          carbsGrams: 66.3,
          fatGrams: 6.9,
          loggedAtMs: 1_763_798_400_000
        }
      });
      expect(nextDayBuffer.dateKey).toBe(dateB);
      expect(nextDayBuffer.dayNumber).toBe(2);
      expect(nextDayBuffer.foodLogs).toHaveLength(1);
      expect(nextDayBuffer.exerciseTicks).toHaveLength(0);
      expect(nextDayBuffer.stepLogs).toHaveLength(0);
    });

    it("detects MAC tampering on DailyEphemeralLogBuffer", async () => {
      await recordEphemeralStepLog({
        dateKey: "2026-11-21",
        cycleId,
        dayNumber: 1,
        entry: {
          id: "s-tamper",
          steps: 3100,
          source: "hardware",
          recordedAtMs: 1_763_712_000_000
        }
      });

      const raw = backend.getRaw(
        ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER
      )!;
      const env = JSON.parse(raw) as {
        v: number;
        iv: string;
        ciphertext: string;
        mac: string;
      };
      const flipped =
        env.ciphertext.slice(0, -2) + (env.ciphertext.endsWith("00") ? "ff" : "00");
      backend.setRaw(
        ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER,
        JSON.stringify({ ...env, ciphertext: flipped })
      );

      await expect(getDailyEphemeralLogBuffer()).rejects.toThrow(
        "MAC verification failed"
      );
      await expect(
        rolloverStaleDailyEphemeralLogBuffer("2026-11-21")
      ).rejects.toThrow("MAC verification failed");
    });

    it("purgeDailyEphemeralLogBuffer removes raw logs while preserving proofSignedMap", async () => {
      await saveDailyProofSigned(cycleId, 0, true);
      await appendEphemeralFoodLog({
        dateKey: "2026-11-21",
        cycleId,
        dayNumber: 1,
        entry: {
          id: "m-purge",
          presetId: "preset_chicken_breast",
          name: "Grilled Chicken Breast",
          grams: 100,
          caloriesKcal: 165,
          proteinGrams: 31,
          carbsGrams: 0,
          fatGrams: 3.6,
          loggedAtMs: 1_763_712_000_000
        }
      });

      expect(await getDailyEphemeralLogBuffer()).not.toBeNull();
      await purgeDailyEphemeralLogBuffer();

      expect(await getDailyEphemeralLogBuffer()).toBeNull();
      expect(
        backend.getRaw(ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER)
      ).toBeUndefined();
      expect(await getDailyProofSigned(cycleId, 0)).toBe(true);
      expect(await getDailyProofSignedMap()).toEqual({
        [makeDailyProofSignedKey(cycleId, 0)]: true
      });
    });

    it("rolloverStaleDailyEphemeralLogBuffer retains same-day buffers and auto-purges prior-day buffers", async () => {
      expect(await rolloverStaleDailyEphemeralLogBuffer("2026-11-21")).toEqual({
        purged: false,
        activeBuffer: null
      });

      const saved = await recordEphemeralStepLog({
        dateKey: "2026-11-20",
        cycleId,
        dayNumber: 1,
        entry: {
          id: "s-prev",
          steps: 4500,
          source: "manual-fallback",
          recordedAtMs: 1_763_625_600_000
        }
      });

      const sameDay = await rolloverStaleDailyEphemeralLogBuffer("2026-11-20");
      expect(sameDay.purged).toBe(false);
      expect(sameDay.activeBuffer).toEqual(saved);

      const nextDay = await rolloverStaleDailyEphemeralLogBuffer("2026-11-21");
      expect(nextDay).toEqual({
        purged: true,
        activeBuffer: null
      });
      expect(await getDailyEphemeralLogBuffer()).toBeNull();
      expect(
        backend.getRaw(ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER)
      ).toBeUndefined();

      await expect(
        rolloverStaleDailyEphemeralLogBuffer("invalid-date")
      ).rejects.toThrow("YYYY-MM-DD");
    });
  });

  // ==========================================================================
  // 2. MicroCheckInScreen Dual-Mode Toggle & Quick Check (<60s)
  // ==========================================================================
  describe("MicroCheckInScreen Dual-Mode Toggle & Quick Check (<60s)", () => {
    it("defaults to Quick Check (<60s) mode, shows privacy notice, and switches cleanly to/from Detailed Log", () => {
      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 1,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: emptyDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        currentDateKey: "2026-11-21",
        initialStepCount: 0,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined)
      };

      let tree = renderWithHarness(MicroCheckInScreen, props);

      const quickTab = findByTestId(tree, "checkin-mode-quick");
      const detailedTab = findByTestId(tree, "checkin-mode-detailed");
      expect(quickTab?.accessibilityState).toEqual({ selected: true });
      expect(detailedTab?.accessibilityState).toEqual({ selected: false });

      expect(findByTestId(tree, "quick-checkin-panel")).not.toBeNull();
      expect(findByTestId(tree, "quick-workout-done-btn")).not.toBeNull();
      expect(findByTestId(tree, "quick-nutrition-done-btn")).not.toBeNull();
      expect(findByTestId(tree, "quick-step-goal-card")).not.toBeNull();
      expect(findByTestId(tree, "ephemeral-buffer-notice")).not.toBeNull();
      expect(hasText(tree, "11:59 PM daily settlement reminder")).toBe(true);

      expect(hasText(tree, "Calorie & Macro Calculator")).toBe(false);
      expect(hasText(tree, "Workout Checklist")).toBe(false);
      expect(hasText(tree, "Daily Step Counter")).toBe(false);

      // Switch to Detailed Log
      (detailedTab!.onPress as () => void)();
      tree = renderWithHarness(MicroCheckInScreen, props);

      expect(findByTestId(tree, "checkin-mode-quick")?.accessibilityState).toEqual({
        selected: false
      });
      expect(
        findByTestId(tree, "checkin-mode-detailed")?.accessibilityState
      ).toEqual({ selected: true });
      expect(findByTestId(tree, "quick-checkin-panel")).toBeNull();
      expect(hasText(tree, "Calorie & Macro Calculator")).toBe(true);
      expect(hasText(tree, "Workout Checklist")).toBe(true);
      expect(hasText(tree, "Daily Step Counter")).toBe(true);
      expect(findByLabel(tree, "Portion grams input")).not.toBeNull();
      expect(findByLabel(tree, "Manual step count input")).not.toBeNull();
      expect(hasText(tree, "11:59 PM daily settlement reminder")).toBe(true);

      // Switch back to Quick Check (<60s)
      (findByTestId(tree, "checkin-mode-quick")!.onPress as () => void)();
      tree = renderWithHarness(MicroCheckInScreen, props);
      expect(findByTestId(tree, "quick-checkin-panel")).not.toBeNull();
      expect(hasText(tree, "Calorie & Macro Calculator")).toBe(false);
      expect(hasText(tree, "Workout Checklist")).toBe(false);
    });

    it("Express Workout Done unlocks Daily Proof in 1 tap, writes encrypted ticks, and proof signing purges buffer while keeping proofSignedMap", async () => {
      const dispatched: SignedWorkoutClaimPayload[] = [];
      const onUpdateDailyPlan = vi.fn();

      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 3,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: emptyDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        currentDateKey: "2026-11-21",
        initialStepCount: 0,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        onUpdateDailyPlan,
        onDispatchSignedClaim: async (payload) => {
          dispatched.push(payload);
        }
      };

      let tree = renderWithHarness(MicroCheckInScreen, props);
      const lockedBtn = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(
            elProps.children as React.ReactNode,
            "Log a meal or finish 1 exercise to unlock"
          )
      );
      expect(lockedBtn?.disabled).toBe(true);

      // 1-tap Express Workout Done
      const workoutQuickBtn = findByTestId(tree, "quick-workout-done-btn");
      expect(workoutQuickBtn).not.toBeNull();
      (workoutQuickBtn!.onPress as () => void)();
      await flushMicrotasks(15);

      tree = renderWithHarness(MicroCheckInScreen, props);
      expect(onUpdateDailyPlan).toHaveBeenCalledTimes(1);
      const updatedPlan = onUpdateDailyPlan.mock.calls[0]?.[0] as DailyPlan;
      expect(updatedPlan.exercises.every((ex) => ex.completed)).toBe(true);

      const buffered = await getDailyEphemeralLogBuffer();
      expect(buffered).not.toBeNull();
      expect(buffered?.dateKey).toBe("2026-11-21");
      expect(buffered?.exerciseTicks).toHaveLength(emptyDay.exercises.length);
      expect(buffered?.exerciseTicks.every((t) => t.completed)).toBe(true);

      const signBtn = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Complete & Sign Daily Proof")
      );
      expect(signBtn?.disabled).toBe(false);

      // Sign & dispatch proof -> auto-purges DailyEphemeralLogBuffer, keeps proofSignedMap
      (signBtn!.onPress as () => void)();
      await vi.waitFor(() => {
        expect(dispatched).toHaveLength(1);
      });
      await flushMicrotasks(15);

      tree = renderWithHarness(MicroCheckInScreen, props);
      expect(await getDailyEphemeralLogBuffer()).toBeNull();
      expect(
        backend.getRaw(ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER)
      ).toBeUndefined();
      expect(await getDailyProofSigned(cycleId, 0)).toBe(true);
      expect(await getDailyProofSignedMap()).toEqual({
        [makeDailyProofSignedKey(cycleId, 0)]: true
      });
      expect(hasText(tree, "Daily Proof Signed & Claimed ✓")).toBe(true);
    });

    it("Express Nutrition Target Met unlocks Daily Proof in 1 tap and retains buffer if proof dispatch fails", async () => {
      const onDispatchSignedClaim = vi
        .fn()
        .mockRejectedValueOnce(new Error("RPC offline"));
      const onError = vi.fn();

      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 0,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: emptyDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        currentDateKey: "2026-11-21",
        initialStepCount: 0,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        onError,
        onDispatchSignedClaim
      };

      let tree = renderWithHarness(MicroCheckInScreen, props);
      const nutritionQuickBtn = findByTestId(tree, "quick-nutrition-done-btn");
      expect(nutritionQuickBtn).not.toBeNull();
      (nutritionQuickBtn!.onPress as () => void)();
      await flushMicrotasks(15);

      tree = renderWithHarness(MicroCheckInScreen, props);
      const bufferedAfterNutrition = await getDailyEphemeralLogBuffer();
      expect(bufferedAfterNutrition?.foodLogs).toHaveLength(1);
      expect(bufferedAfterNutrition?.foodLogs[0]?.presetId).toBe(
        DUAL_TRACK_FOOD_PRESETS[0]!.id
      );

      const signBtn = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Complete & Sign Daily Proof")
      );
      expect(signBtn?.disabled).toBe(false);

      // Failed dispatch must NOT purge ephemeral buffer
      (signBtn!.onPress as () => void)();
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });
      await flushMicrotasks(10);
      expect(await getDailyEphemeralLogBuffer()).not.toBeNull();
    });

    it("accumulates multi-session Detailed Log entries on same day, restores on remount, and purges on proof or next-day rollover", async () => {
      // Session 1: Detailed Log accumulation (food + exercise + manual steps)
      const session1Props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 2,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: emptyDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        currentDateKey: "2026-11-21",
        initialCheckInMode: "detailed",
        initialStepCount: 0,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined)
      };

      let tree = renderWithHarness(MicroCheckInScreen, session1Props);
      await flushMicrotasks(10);

      (findByLabel(tree, "Portion grams input")!.onChangeText as (v: string) => void)(
        "200"
      );
      tree = renderWithHarness(MicroCheckInScreen, session1Props);
      (findByLabel(tree, "Log Food Portion")!.onPress as () => void)();
      await flushMicrotasks(15);

      tree = renderWithHarness(MicroCheckInScreen, session1Props);
      const firstExercise = emptyDay.exercises[0]!;
      (
        findByLabel(tree, `Toggle Exercise ${firstExercise.name}`)!.onPress as () => void
      )();
      await flushMicrotasks(15);

      tree = renderWithHarness(MicroCheckInScreen, session1Props);
      (findByLabel(tree, "Manual step count input")!.onChangeText as (v: string) => void)(
        "4321"
      );
      tree = renderWithHarness(MicroCheckInScreen, session1Props);
      (findByLabel(tree, "Apply Manual Steps")!.onPress as () => void)();
      await flushMicrotasks(15);

      const persisted = await getDailyEphemeralLogBuffer();
      expect(persisted?.dateKey).toBe("2026-11-21");
      expect(persisted?.foodLogs).toHaveLength(1);
      expect(persisted?.foodLogs[0]?.grams).toBe(200);
      expect(persisted?.exerciseTicks).toHaveLength(1);
      expect(persisted?.exerciseTicks[0]?.completed).toBe(true);
      expect(persisted?.stepLogs).toHaveLength(1);
      expect(persisted?.stepLogs[0]?.steps).toBe(4321);

      const raw = backend.getRaw(ADAPTIVE_STORAGE_KEYS.DAILY_EPHEMERAL_LOG_BUFFER);
      expect(raw).toBeDefined();
      expect(raw).not.toContain("stepLogs");
      expect(raw).not.toContain('"steps":4321');
      expect(raw).not.toContain(firstExercise.name);

      // Session 2: Remount fresh component with same dateKey & unlogged dailyPlan
      resetHarness();
      const dispatched: SignedWorkoutClaimPayload[] = [];
      const session2Props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 2,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: emptyDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        currentDateKey: "2026-11-21",
        initialPedometerAvailable: false,
        onDispatchSignedClaim: async (payload) => {
          dispatched.push(payload);
        }
      };

      tree = renderWithHarness(MicroCheckInScreen, session2Props);
      await flushMicrotasks(15);
      tree = renderWithHarness(MicroCheckInScreen, session2Props);

      const notice = findByTestId(tree, "ephemeral-buffer-notice");
      expect(notice).not.toBeNull();
      expect(extractText(notice!.children as React.ReactNode)).toContain("1 meals");
      expect(extractText(notice!.children as React.ReactNode)).toContain("4,321 steps");
      expect(hasText(tree, `1/${emptyDay.exercises.length} done`)).toBe(true);

      // Sign Daily Proof -> clears buffer & resets ephemeral counts while keeping proofSignedMap
      const signBtn = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Complete & Sign Daily Proof")
      );
      expect(signBtn?.disabled).toBe(false);
      (signBtn!.onPress as () => void)();
      await vi.waitFor(() => {
        expect(dispatched).toHaveLength(1);
      });
      await flushMicrotasks(15);
      tree = renderWithHarness(MicroCheckInScreen, session2Props);

      expect(await getDailyEphemeralLogBuffer()).toBeNull();
      expect(await getDailyProofSigned(cycleId, 0)).toBe(true);
      expect(hasText(tree, "0 meals")).toBe(true);

      // Session 3: Prior-day unsigned logs auto-purge on midnight rollover
      await appendEphemeralFoodLog({
        dateKey: "2026-11-21",
        cycleId,
        dayNumber: 1,
        entry: {
          id: "stale-meal",
          presetId: DUAL_TRACK_FOOD_PRESETS[0]!.id,
          name: DUAL_TRACK_FOOD_PRESETS[0]!.name,
          grams: 100,
          caloriesKcal: 165,
          proteinGrams: 31,
          carbsGrams: 0,
          fatGrams: 3.6,
          loggedAtMs: 1_763_720_000_000
        }
      });

      resetHarness();
      const nextDayProps: MicroCheckInScreenProps = {
        ...session2Props,
        currentDateKey: "2026-11-22"
      };
      tree = renderWithHarness(MicroCheckInScreen, nextDayProps);
      await flushMicrotasks(15);
      tree = renderWithHarness(MicroCheckInScreen, nextDayProps);

      expect(await getDailyEphemeralLogBuffer()).toBeNull();
      expect(hasText(tree, "0 meals")).toBe(true);
      expect(hasText(tree, "Log a meal or finish 1 exercise to unlock")).toBe(true);
    });

    it("hydrates from matching initialEphemeralBuffer prop and ignores stale initialEphemeralBuffer", () => {
      const sameDayBuffer: DailyEphemeralLogBuffer = {
        dateKey: "2026-11-21",
        cycleId,
        dayNumber: 1,
        foodLogs: [
          {
            id: "buf-meal",
            presetId: DUAL_TRACK_FOOD_PRESETS[0]!.id,
            name: DUAL_TRACK_FOOD_PRESETS[0]!.name,
            grams: 150,
            caloriesKcal: 247.5,
            proteinGrams: 46.5,
            carbsGrams: 0,
            fatGrams: 5.4,
            loggedAtMs: 1_763_712_000_000
          }
        ],
        exerciseTicks: [
          {
            exerciseId: emptyDay.exercises[0]!.id,
            name: emptyDay.exercises[0]!.name,
            completed: true,
            updatedAtMs: 1_763_712_100_000
          }
        ],
        stepLogs: [
          {
            id: "buf-step",
            steps: 7777,
            source: "hardware",
            recordedAtMs: 1_763_712_200_000
          }
        ],
        updatedAtMs: 1_763_712_200_000
      };

      const treeSame = renderWithHarness(MicroCheckInScreen, {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 1,
        currentNonce: 0n,
        signer: wallet,
        dailyPlan: emptyDay,
        cycleId,
        currentDateKey: "2026-11-21",
        initialEphemeralBuffer: sameDayBuffer,
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined)
      });
      expect(hasText(treeSame, "1 meals")).toBe(true);
      expect(hasText(treeSame, "7,777 steps")).toBe(true);
      expect(hasText(treeSame, `1/${emptyDay.exercises.length} done`)).toBe(true);

      resetHarness();
      const treeStale = renderWithHarness(MicroCheckInScreen, {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 1,
        currentNonce: 0n,
        signer: wallet,
        dailyPlan: emptyDay,
        cycleId,
        currentDateKey: "2026-11-22",
        initialEphemeralBuffer: sameDayBuffer,
        initialPedometerAvailable: false,
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined)
      });
      expect(hasText(treeStale, "0 meals")).toBe(true);
      expect(hasText(treeStale, "0 / 5,000 steps")).toBe(true);
    });
  });
});
