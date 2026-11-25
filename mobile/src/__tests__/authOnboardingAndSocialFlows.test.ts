import {
  AdaptivePlanCycle,
  Address,
  AnonymizedFeedRecord,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  UserBiometrics,
  UserProfile
} from "@dehealth/shared";
import { Wallet } from "ethers";
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

const sensorMocks = vi.hoisted(() => ({
  isPedometerAvailable: null as (() => Promise<boolean>) | null,
  getTodayStepCount: null as
    | ((fallbackSteps?: number) => Promise<{
        readonly steps: number;
        readonly source: "hardware" | "manual-fallback";
      }>)
    | null
}));

vi.mock("../services/sensorService", async () => {
  const actual = await vi.importActual<typeof import("../services/sensorService")>(
    "../services/sensorService"
  );
  return {
    ...actual,
    isPedometerAvailable: async (): Promise<boolean> => {
      if (sensorMocks.isPedometerAvailable) {
        return sensorMocks.isPedometerAvailable();
      }
      return actual.isPedometerAvailable();
    },
    getTodayStepCount: async (fallbackSteps?: number) => {
      if (sensorMocks.getTodayStepCount) {
        return sensorMocks.getTodayStepCount(fallbackSteps);
      }
      return actual.getTodayStepCount(fallbackSteps);
    }
  };
});

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
    if (key === "testID" && typeof value === "string") {
      domProps["data-testid"] = value;
      continue;
    }
    if (
      key.startsWith("accessibility") ||
      key === "contentContainerStyle" ||
      key === "keyboardType" ||
      key === "keyboardShouldPersistTaps" ||
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
      key === "autoCapitalize" ||
      key === "autoCorrect" ||
      key === "editable" ||
      key === "onChangeText" ||
      key === "value" ||
      key === "data" ||
      key === "keyExtractor" ||
      key === "renderItem" ||
      key === "ListEmptyComponent"
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
  FlatList: (props: Record<string, unknown>) => {
    const data = Array.isArray(props.data) ? (props.data as readonly unknown[]) : [];
    const renderItem = props.renderItem as
      | ((info: { item: unknown; index: number }) => React.ReactNode)
      | undefined;
    const empty = props.ListEmptyComponent as React.ReactNode;
    if (data.length === 0) {
      return React.createElement("div", cleanProps(props), empty ?? null);
    }
    return React.createElement(
      "div",
      cleanProps(props),
      renderItem ? data.map((item, index) => renderItem({ item, index })) : null
    );
  },
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
  buildWeeklyWorkoutSplit,
  PlanPreviewModal
} from "../components/PlanPreviewModal";
import { StreakFlameHeader } from "../components/StreakFlameHeader";
import { generateQrMatrix } from "../utils/qrMatrix";
import { AnonymizedFeedScreen } from "../screens/AnonymizedFeedScreen";
import { LoginScreen } from "../screens/LoginScreen";
import {
  formatShortWalletAddress,
  MicroCheckInScreen
} from "../screens/MicroCheckInScreen";
import { OnboardingWizardScreen } from "../screens/OnboardingWizardScreen";
import { generate14DayPlan } from "../services/adaptivePlanEngine";
import {
  copyTextToClipboard,
  resetClipboardAdapterForTesting,
  setClipboardAdapterForTesting
} from "../services/clipboardService";
import { resetAdaptiveStorage } from "../storage/adaptiveStorage";

const TEST_PRIVATE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";
const TEST_GATE_ADDRESS =
  "0x2222222222222222222222222222222222222222" as Address;

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

function unmountHarness(): void {
  for (const eff of harness.effects) {
    if (typeof eff?.cleanup === "function") {
      eff.cleanup();
    }
  }
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

function expandFunctionNode(node: React.ReactElement): React.ReactNode {
  const fn = node.type as React.FC<Record<string, unknown>>;
  return fn(node.props as Record<string, unknown>);
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
    if (typeof node.type === "function") {
      return findElement(expandFunctionNode(node), predicate);
    }
    if (Array.isArray(props.data) && typeof props.renderItem === "function") {
      const renderItem = props.renderItem as (info: {
        item: unknown;
        index: number;
      }) => React.ReactNode;
      for (let i = 0; i < props.data.length; i++) {
        const rendered = renderItem({ item: props.data[i], index: i });
        const hit = findElement(rendered, predicate);
        if (hit) return hit;
      }
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
    if (typeof node.type === "function") {
      return extractText(expandFunctionNode(node));
    }
    const props = node.props as {
      children?: React.ReactNode;
      data?: readonly unknown[];
      renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    };
    if (Array.isArray(props.data) && typeof props.renderItem === "function") {
      if (props.data.length === 0 && props.ListEmptyComponent) {
        return extractText(props.ListEmptyComponent);
      }
      return props.data
        .map((item, index) => extractText(props.renderItem!({ item, index })))
        .join("");
    }
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

describe("UI, Clipboard, Login, Onboarding Preview & Single-Cheer Flows", () => {
  beforeEach(() => {
    resetHarness();
    resetAdaptiveStorage();
    resetClipboardAdapterForTesting();
    sensorMocks.isPedometerAvailable = null;
    sensorMocks.getTodayStepCount = null;
  });

  afterEach(() => {
    resetHarness();
    resetClipboardAdapterForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. clipboardService (expo-clipboard + web fallback)
  // ==========================================================================
  describe("clipboardService", () => {
    it("uses injected native ClipboardAdapter.setStringAsync and trims text", async () => {
      const setStringAsync = vi.fn().mockResolvedValue(true);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      setClipboardAdapterForTesting({ setStringAsync });

      expect(await copyTextToClipboard("  0xabc123  ")).toBe(true);
      expect(setStringAsync).toHaveBeenCalledTimes(1);
      expect(setStringAsync).toHaveBeenCalledWith("0xabc123");
      expect(writeText).not.toHaveBeenCalled();
    });

    it("falls through to navigator.clipboard.writeText when native adapter returns false, throws, or is null", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });

      // Returns false -> web fallback
      const falseAdapter = {
        setStringAsync: vi.fn().mockResolvedValue(false)
      };
      setClipboardAdapterForTesting(falseAdapter);
      expect(await copyTextToClipboard("hello")).toBe(true);
      expect(falseAdapter.setStringAsync).toHaveBeenCalledWith("hello");
      expect(writeText).toHaveBeenCalledWith("hello");

      // Rejects -> web fallback
      const throwingAdapter = {
        setStringAsync: vi.fn().mockRejectedValue(new Error("ExpoClipboard failed"))
      };
      setClipboardAdapterForTesting(throwingAdapter);
      expect(await copyTextToClipboard("world")).toBe(true);
      expect(writeText).toHaveBeenCalledWith("world");

      // Null -> skips native adapter straight to web fallback
      setClipboardAdapterForTesting(null);
      expect(await copyTextToClipboard("direct-web")).toBe(true);
      expect(writeText).toHaveBeenCalledWith("direct-web");
    });

    it("resetClipboardAdapterForTesting restores dynamic import fallback cleanly in Node/Vitest", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });

      setClipboardAdapterForTesting(null);
      resetClipboardAdapterForTesting();

      // Dynamic import of expo-clipboard catches unavailable native module in Node
      // and delegates cleanly to navigator.clipboard.writeText
      expect(await copyTextToClipboard("0xdeadbeef")).toBe(true);
      expect(writeText).toHaveBeenCalledWith("0xdeadbeef");
    });

    it("returns false for empty/whitespace text or when all clipboard transports fail", async () => {
      const setStringAsync = vi.fn().mockResolvedValue(true);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      setClipboardAdapterForTesting({ setStringAsync });

      expect(await copyTextToClipboard("")).toBe(false);
      expect(await copyTextToClipboard("   \n\t ")).toBe(false);
      expect(setStringAsync).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();

      setClipboardAdapterForTesting(null);
      writeText.mockRejectedValueOnce(new Error("Permission denied"));
      expect(await copyTextToClipboard("0x1234")).toBe(false);

      vi.stubGlobal("navigator", {});
      expect(await copyTextToClipboard("0x1234")).toBe(false);
    });
  });

  // ==========================================================================
  // 2. LoginScreen (3-Way Auth: Google/Local, MetaMask, WalletConnect; Zero PK Import)
  // ==========================================================================
  describe("LoginScreen", () => {
    it("renders Google/Local, MetaMask, WalletConnect options without manual private key import UI", () => {
      const existingAddr = "0x1234567890abcdef1234567890abcdef1234abcd" as Address;
      const fallbackMarkup = renderToStaticMarkup(
        React.createElement(LoginScreen, {
          onSignInWithGoogle: vi.fn(),
          onSignInWithMetaMask: vi.fn(),
          onSignInWithWalletConnect: vi.fn(),
          isSupabaseConfigured: false,
          isWalletConnectConfigured: false,
          existingWalletAddress: existingAddr
        })
      );

      expect(fallbackMarkup).toContain("DeHealth Protocol");
      expect(fallbackMarkup).toContain("100% On-Device Biometric Vault");
      expect(fallbackMarkup).toContain("Start Local Session");
      expect(fallbackMarkup).toContain("Sign in with MetaMask");
      expect(fallbackMarkup).toContain("WalletConnect");
      expect(fallbackMarkup).toContain("0x1234…abcd");
      expect(fallbackMarkup).not.toContain("Import Private Key");
      expect(fallbackMarkup).not.toContain("Import &amp; Continue");

      // Live Supabase + WalletConnect configured labels & zero address hidden
      const liveMarkup = renderToStaticMarkup(
        React.createElement(LoginScreen, {
          onSignInWithGoogle: vi.fn(),
          onSignInWithMetaMask: vi.fn(),
          onSignInWithWalletConnect: vi.fn(),
          isSupabaseConfigured: true,
          isWalletConnectConfigured: true,
          existingWalletAddress:
            "0x0000000000000000000000000000000000000000" as Address
        })
      );
      expect(liveMarkup).not.toContain("Local Wallet:");
      expect(liveMarkup).toContain("Sign in with Google");
      expect(liveMarkup).toContain("Sign in with MetaMask");
      expect(liveMarkup).toContain("WalletConnect");
      expect(liveMarkup).toContain(
        "WalletConnect v2 Project ID configured and ready."
      );
    });

    it("blocks double-taps, resets loading state in finally on error, and surfaces inline error + onError across Google/Local", async () => {
      const googleDeferred = createDeferred<void>();
      const onSignInWithGoogle = vi
        .fn()
        .mockImplementation(() => googleDeferred.promise);
      const onSignInWithMetaMask = vi.fn().mockResolvedValue(undefined);
      const onSignInWithWalletConnect = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn();

      const props = {
        onSignInWithGoogle,
        onSignInWithMetaMask,
        onSignInWithWalletConnect,
        isSupabaseConfigured: true,
        isWalletConnectConfigured: true,
        onError
      };

      let tree = renderWithHarness(LoginScreen, props);
      expect(findByTestId(tree, "toggle-import-key-button")).toBeNull();
      expect(findByTestId(tree, "import-private-key-input")).toBeNull();

      const googleBtn = findByTestId(tree, "login-google-button");
      expect(googleBtn).not.toBeNull();
      expect(googleBtn!.disabled).toBe(false);

      // Same-frame double tap dispatches only once
      (googleBtn!.onPress as () => void)();
      (googleBtn!.onPress as () => void)();
      expect(onSignInWithGoogle).toHaveBeenCalledTimes(1);

      tree = renderWithHarness(LoginScreen, props);
      expect(findByTestId(tree, "login-google-button")!.disabled).toBe(true);
      expect(findByTestId(tree, "login-metamask-button")!.disabled).toBe(true);
      expect(findByTestId(tree, "login-walletconnect-button")!.disabled).toBe(true);
      expect(hasText(tree, "Signing in with Google...")).toBe(true);

      const authErr = new Error("OAuth popup cancelled");
      googleDeferred.reject(authErr);
      await flushMicrotasks();

      tree = renderWithHarness(LoginScreen, props);
      expect(onError).toHaveBeenCalledWith(authErr);
      expect(findByTestId(tree, "login-google-button")!.disabled).toBe(false);
      expect(findByTestId(tree, "login-metamask-button")!.disabled).toBe(false);
      expect(findByTestId(tree, "login-walletconnect-button")!.disabled).toBe(false);
      expect(hasText(tree, "OAuth popup cancelled")).toBe(true);
    });

    it("connects via MetaMask and WalletConnect buttons and resets spinners on failure", async () => {
      const mmDeferred = createDeferred<void>();
      const wcErr = new Error("WalletConnect Project ID missing");
      const onSignInWithGoogle = vi.fn().mockResolvedValue(undefined);
      const onSignInWithMetaMask = vi.fn().mockImplementation(() => mmDeferred.promise);
      const onSignInWithWalletConnect = vi.fn().mockRejectedValue(wcErr);
      const onError = vi.fn();

      const props = {
        onSignInWithGoogle,
        onSignInWithMetaMask,
        onSignInWithWalletConnect,
        onError
      };

      let tree = renderWithHarness(LoginScreen, props);
      (findByTestId(tree, "login-metamask-button")!.onPress as () => void)();
      tree = renderWithHarness(LoginScreen, props);
      expect(hasText(tree, "Connecting MetaMask...")).toBe(true);
      expect(findByTestId(tree, "login-walletconnect-button")!.disabled).toBe(true);

      mmDeferred.resolve(undefined);
      await flushMicrotasks();
      expect(onSignInWithMetaMask).toHaveBeenCalledTimes(1);

      tree = renderWithHarness(LoginScreen, props);
      expect(findByTestId(tree, "login-walletconnect-button")!.disabled).toBe(false);

      (findByTestId(tree, "login-walletconnect-button")!.onPress as () => void)();
      await flushMicrotasks();
      tree = renderWithHarness(LoginScreen, props);
      expect(onSignInWithWalletConnect).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(wcErr);
      expect(hasText(tree, "WalletConnect Project ID missing")).toBe(true);
      expect(findByTestId(tree, "login-walletconnect-button")!.disabled).toBe(false);
    });
  });

  // ==========================================================================
  // 3. OnboardingWizardScreen + PlanPreviewModal
  // ==========================================================================
  describe("OnboardingWizardScreen & PlanPreviewModal", () => {
    it("buildWeeklyWorkoutSplit extracts Days 1-7 workout split and handles rest days cleanly", () => {
      const plan = generate14DayPlan(
        DEFAULT_BASELINE_BIOMETRICS,
        1_700_000_000_000,
        null
      );
      const split = buildWeeklyWorkoutSplit(plan);

      expect(split).toHaveLength(7);
      expect(split[0]?.dayNumber).toBe(1);
      expect(split[0]?.dayLabel).toBe("Day 1");
      expect(split[0]?.exerciseCount).toBe(4);
      expect(split[0]?.focusTitle).toBe("Chest, Back, Shoulders, Core");
      expect(split[0]?.exerciseSummary).toBe(
        "Push-ups, Dumbbell Rows (+2 more)"
      );
      expect(split[6]?.dayLabel).toBe("Day 7");

      // Empty exercises day falls back to Rest & Recovery
      const restPlan: AdaptivePlanCycle = {
        ...plan,
        dailyPlans: plan.dailyPlans.map((d, idx) =>
          idx === 2 ? { ...d, exercises: [] } : d
        )
      };
      const restSplit = buildWeeklyWorkoutSplit(restPlan);
      expect(restSplit[2]?.focusTitle).toBe("Rest & Recovery");
      expect(restSplit[2]?.exerciseCount).toBe(0);
      expect(restSplit[2]?.exerciseSummary).toBe("Active recovery & mobility");
    });

    it("completely removes 'Skip for Now' across Steps 1-3", () => {
      const props = {
        onOnboardingComplete: vi.fn()
      };

      let tree = renderWithHarness(OnboardingWizardScreen, props);
      expect(findByTestId(tree, "skip-button")).toBeNull();
      expect(hasText(tree, "Skip for Now")).toBe(false);
      expect(renderToStaticMarkup(tree as React.ReactElement)).not.toContain(
        "Skip for Now"
      );

      // Step 2
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      expect(findByTestId(tree, "skip-button")).toBeNull();
      expect(hasText(tree, "Skip for Now")).toBe(false);

      // Step 3
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      expect(findByTestId(tree, "skip-button")).toBeNull();
      expect(hasText(tree, "Skip for Now")).toBe(false);
    });

    it("opens PlanPreviewModal after Step 3 without saving, preserves edits on Adjust Goals, and persists on Approve & Start Plan", async () => {
      const saveUserBiometrics = vi.fn().mockResolvedValue(undefined);
      const saveActivePlanCycle = vi.fn().mockResolvedValue(undefined);
      const onOnboardingComplete = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn();

      const props = {
        onOnboardingComplete,
        onError,
        storage: {
          saveUserBiometrics,
          saveActivePlanCycle
        }
      };

      // Step 1: Select Cut goal
      let tree = renderWithHarness(OnboardingWizardScreen, props);
      (findByTestId(tree, "goal-cut")!.onPress as () => void)();
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      expect(hasText(tree, "Step 2 of 3")).toBe(true);

      // Step 2: Enter custom female biometrics
      (findByTestId(tree, "gender-female")!.onPress as () => void)();
      (findByTestId(tree, "input-age")!.onChangeText as (v: string) => void)(
        "31"
      );
      (findByTestId(tree, "input-weight")!.onChangeText as (v: string) => void)(
        "64"
      );
      (findByTestId(tree, "input-height")!.onChangeText as (v: string) => void)(
        "168"
      );
      (
        findByTestId(tree, "input-bodyfat")!.onChangeText as (
          v: string
        ) => void
      )("21");
      tree = renderWithHarness(OnboardingWizardScreen, props);

      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      expect(hasText(tree, "Step 3 of 3")).toBe(true);

      // Step 3: Select 4d/wk frequency and click Complete & Generate Plan
      (findByTestId(tree, "frequency-option-4")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);

      // PlanPreviewModal is visible with calories, macros, and Days 1-7 workout split
      expect(hasText(tree, "Your Adaptive Plan Preview")).toBe(true);
      expect(hasText(tree, "INITIAL 14-DAY BLUEPRINT PREVIEW")).toBe(true);
      expect(hasText(tree, "kcal/day")).toBe(true);
      expect(hasText(tree, "Daily Macronutrient Targets")).toBe(true);
      expect(hasText(tree, "Weekly Workout Split (Days 1–7)")).toBe(true);
      expect(hasText(tree, "Day 1")).toBe(true);
      expect(hasText(tree, "Day 7")).toBe(true);
      expect(hasText(tree, "Goal: cut • 31 yrs • 64 kg • 4 d/wk")).toBe(true);

      // Nothing persisted until user explicitly clicks Approve & Start Plan
      expect(saveUserBiometrics).not.toHaveBeenCalled();
      expect(saveActivePlanCycle).not.toHaveBeenCalled();
      expect(onOnboardingComplete).not.toHaveBeenCalled();

      // Click Adjust Goals -> hides modal, keeps all entered biometrics, allows updates
      const adjustBtn = findByTestId(tree, "adjust-goals-button");
      expect(adjustBtn).not.toBeNull();
      (adjustBtn!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);

      expect(hasText(tree, "Your Adaptive Plan Preview")).toBe(false);
      expect(hasText(tree, "Step 1 of 3")).toBe(true);

      // Change goal to bulk and advance to Step 2 -> verify custom inputs are preserved
      (findByTestId(tree, "goal-bulk")!.onPress as () => void)();
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);

      expect(findByTestId(tree, "input-age")!.value).toBe("31");
      expect(findByTestId(tree, "input-weight")!.value).toBe("64");
      expect(findByTestId(tree, "input-height")!.value).toBe("168");
      expect(findByTestId(tree, "input-bodyfat")!.value).toBe("21");

      // Update weight to 66 and advance to Step 3 -> preview updates
      (findByTestId(tree, "input-weight")!.onChangeText as (v: string) => void)(
        "66"
      );
      tree = renderWithHarness(OnboardingWizardScreen, props);
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);

      expect(hasText(tree, "Your Adaptive Plan Preview")).toBe(true);
      expect(hasText(tree, "Goal: bulk • 31 yrs • 66 kg • 4 d/wk")).toBe(true);

      // Approve & Start Plan -> persists biometrics & Cycle 1 and calls onOnboardingComplete
      const approveBtn = findByTestId(tree, "approve-start-plan-button");
      expect(approveBtn).not.toBeNull();
      (approveBtn!.onPress as () => void)();
      // Same-frame double-tap blocked
      (approveBtn!.onPress as () => void)();
      await flushMicrotasks();

      expect(saveUserBiometrics).toHaveBeenCalledTimes(1);
      expect(saveActivePlanCycle).toHaveBeenCalledTimes(1);
      expect(onOnboardingComplete).toHaveBeenCalledTimes(1);

      const savedBio = saveUserBiometrics.mock.calls[0]?.[0] as UserBiometrics;
      const savedCycle = saveActivePlanCycle.mock.calls[0]?.[0] as AdaptivePlanCycle;
      expect(savedBio.goal).toBe("bulk");
      expect(savedBio.gender).toBe("female");
      expect(savedBio.age).toBe(31);
      expect(savedBio.weightKg).toBe(66);
      expect(savedBio.weeklyWorkoutFrequency).toBe(4);
      expect(savedCycle.cycleNumber).toBe(1);
      expect(savedCycle.dailyPlans).toHaveLength(14);
      expect(onOnboardingComplete).toHaveBeenCalledWith(savedBio, savedCycle);

      tree = renderWithHarness(OnboardingWizardScreen, props);
      expect(hasText(tree, "Your Adaptive Plan Preview")).toBe(false);
    });

    it("PlanPreviewModal returns null when hidden or missing data and OnboardingWizardScreen handles persistence failure without losing state", async () => {
      const samplePlan = generate14DayPlan(
        DEFAULT_BASELINE_BIOMETRICS,
        1_700_000_000_000,
        null
      );
      expect(
        renderToStaticMarkup(
          React.createElement(PlanPreviewModal, {
            visible: false,
            biometrics: DEFAULT_BASELINE_BIOMETRICS,
            plan: samplePlan,
            onApproveAndStart: vi.fn(),
            onAdjustGoals: vi.fn()
          })
        )
      ).toBe("");
      expect(
        renderToStaticMarkup(
          React.createElement(PlanPreviewModal, {
            visible: true,
            biometrics: null,
            plan: null,
            onApproveAndStart: vi.fn(),
            onAdjustGoals: vi.fn()
          })
        )
      ).toBe("");

      const saveUserBiometrics = vi
        .fn()
        .mockRejectedValueOnce(new Error("Vault locked"))
        .mockResolvedValueOnce(undefined);
      const saveActivePlanCycle = vi.fn().mockResolvedValue(undefined);
      const onOnboardingComplete = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn();

      const props = {
        onOnboardingComplete,
        onError,
        storage: { saveUserBiometrics, saveActivePlanCycle }
      };

      let tree = renderWithHarness(OnboardingWizardScreen, props);
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);
      (findByTestId(tree, "next-button")!.onPress as () => void)();
      tree = renderWithHarness(OnboardingWizardScreen, props);

      (findByTestId(tree, "approve-start-plan-button")!.onPress as () => void)();
      await flushMicrotasks();

      tree = renderWithHarness(OnboardingWizardScreen, props);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(hasText(tree, "Vault locked")).toBe(true);
      // Modal stays open and retry succeeds after finally reset
      expect(hasText(tree, "Your Adaptive Plan Preview")).toBe(true);
      expect(
        findByTestId(tree, "approve-start-plan-button")!.disabled
      ).toBe(false);

      (findByTestId(tree, "approve-start-plan-button")!.onPress as () => void)();
      await flushMicrotasks();
      expect(onOnboardingComplete).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 4. StreakFlameHeader 1-tap copyable wallet pill (global top-right header)
  // ==========================================================================
  describe("StreakFlameHeader 1-tap copyable wallet pill", () => {
    const sampleAddress =
      "0x1234567890abcdef1234567890abcdef1234abcd" as Address;
    const sampleProfile: UserProfile = {
      age: 28,
      gender: "male",
      bodyFatPct: 16.0,
      muscleMassKg: 37.5
    };
    const sampleCycle = generate14DayPlan(
      DEFAULT_BASELINE_BIOMETRICS,
      1_700_000_000_000
    );
    const sampleDay: DailyPlan = sampleCycle.dailyPlans[0]!;

    it("formatShortWalletAddress shortens EVM addresses and preserves short strings", () => {
      expect(formatShortWalletAddress(`  ${sampleAddress}  `)).toBe(
        "0x1234…abcd"
      );
      expect(formatShortWalletAddress("0x1234")).toBe("0x1234");
    });

    it("renders top-right header copy pill, copies full userAddress in 1 tap, shows Copied ✓, removes duplicate check-in pill, and handles unavailable clipboard gracefully", async () => {
      const setStringAsync = vi.fn().mockResolvedValue(true);
      setClipboardAdapterForTesting({ setStringAsync });
      const onCopyWalletAddress = vi.fn();
      const wallet = new Wallet(TEST_PRIVATE_KEY);

      const headerProps = {
        userAddress: sampleAddress,
        streakCount: 4,
        tokenBalanceDht: "40.0",
        isFatigueScaled: false,
        fitnessTier: "Balanced",
        onCopyWalletAddress
      };

      let tree = renderWithHarness(StreakFlameHeader, headerProps);
      const copyPill = findByTestId(tree, "header-wallet-copy-pill");
      expect(copyPill).not.toBeNull();
      expect(copyPill!.accessibilityLabel).toBe("Copy Wallet Address");
      expect(hasText(tree, "0x1234…abcd")).toBe(true);
      expect(hasText(tree, "Copy")).toBe(true);

      (copyPill!.onPress as () => void)();
      await flushMicrotasks();
      tree = renderWithHarness(StreakFlameHeader, headerProps);

      expect(setStringAsync).toHaveBeenCalledWith(sampleAddress);
      expect(onCopyWalletAddress).toHaveBeenCalledWith(sampleAddress);
      expect(hasText(tree, "Copied ✓")).toBe(true);

      // Clean unmount clears copy timer cleanly
      unmountHarness();

      // Unavailable clipboard clears Copied state gracefully without throwing
      resetHarness();
      setClipboardAdapterForTesting(null);
      vi.stubGlobal("navigator", {});
      const noCallbackProps = {
        ...headerProps,
        onCopyWalletAddress: undefined
      };
      tree = renderWithHarness(StreakFlameHeader, noCallbackProps);
      (
        findByTestId(tree, "header-wallet-copy-pill")!.onPress as () => void
      )();
      await flushMicrotasks();
      tree = renderWithHarness(StreakFlameHeader, noCallbackProps);
      expect(hasText(tree, "Copied ✓")).toBe(false);

      // Verify redundant duplicate copy pill is gone from MicroCheckInScreen
      resetHarness();
      const checkInTree = renderWithHarness(MicroCheckInScreen, {
        userAddress: sampleAddress,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 1,
        currentNonce: 0n,
        signer: wallet,
        userProfile: sampleProfile,
        dailyPlan: sampleDay,
        cycleId: sampleCycle.id,
        initialStepCount: 0,
        initialStepSource: "manual-fallback" as const,
        initialPedometerAvailable: false,
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined)
      });
      expect(findByTestId(checkInTree, "checkin-wallet-copy-pill")).toBeNull();
    });

    it("clears the copied timer on unmount and never schedules one after unmount", async () => {
      vi.useFakeTimers();
      try {
        const flush = async (): Promise<void> => {
          for (let i = 0; i < 20; i++) {
            await Promise.resolve();
          }
        };
        const headerProps = {
          userAddress: sampleAddress,
          streakCount: 1,
          tokenBalanceDht: "10.0",
          isFatigueScaled: false,
          fitnessTier: "Balanced"
        };

        // 1. Copy completes, the Copied timer is armed, unmount clears it
        setClipboardAdapterForTesting({
          setStringAsync: vi.fn().mockResolvedValue(true)
        });
        resetHarness();
        let tree = renderWithHarness(StreakFlameHeader, headerProps);
        (findByTestId(tree, "header-wallet-copy-pill")!.onPress as () => void)();
        await flush();
        tree = renderWithHarness(StreakFlameHeader, headerProps);
        expect(hasText(tree, "Copied ✓")).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        unmountHarness();
        expect(vi.getTimerCount()).toBe(0);

        // 2. Unmount while the clipboard write is still pending: no timer afterwards
        let finishWrite!: (ok: boolean) => void;
        setClipboardAdapterForTesting({
          setStringAsync: vi.fn().mockImplementation(
            () =>
              new Promise<boolean>((resolve) => {
                finishWrite = resolve;
              })
          )
        });
        resetHarness();
        tree = renderWithHarness(StreakFlameHeader, headerProps);
        (findByTestId(tree, "header-wallet-copy-pill")!.onPress as () => void)();
        await flush();
        unmountHarness();
        finishWrite(true);
        await flush();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ==========================================================================
  // 5. AnonymizedFeedScreen single-cheer lock & DuplicateCheerError handling
  // ==========================================================================
  describe("AnonymizedFeedScreen single-cheer lock", () => {
    const feedItems: readonly AnonymizedFeedRecord[] = [
      {
        id: "feed-alpha",
        user_pseudonym: "iron_fox",
        streak_count: 9,
        proof_hash:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        created_at: new Date("2026-11-19T08:00:00Z").toISOString()
      },
      {
        id: "feed-beta",
        user_pseudonym: "swift_hawk",
        streak_count: 15,
        proof_hash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        created_at: new Date("2026-11-19T09:00:00Z").toISOString()
      }
    ];

    it("pre-locks items present in cheeredFeedIds as disabled 'Cheered ✓'", () => {
      const onCheer = vi.fn();
      const tree = renderWithHarness(AnonymizedFeedScreen, {
        items: feedItems,
        cheerCountsByFeedId: { "feed-alpha": 3, "feed-beta": 7 },
        cheeredFeedIds: { "feed-alpha": true },
        onCheer
      });

      const alphaBtn = findByLabel(tree, "Cheer for @iron_fox");
      const betaBtn = findByLabel(tree, "Cheer for @swift_hawk");

      expect(alphaBtn!.disabled).toBe(true);
      expect(alphaBtn!.accessibilityState).toEqual({ disabled: true });
      expect(hasText(tree, "Cheered ✓ (3)")).toBe(true);

      expect(betaBtn!.disabled).toBe(false);
      expect(hasText(tree, "Cheer (7)")).toBe(true);

      // Even direct invocation of onPress on a pre-cheered card is a no-op
      (alphaBtn!.onPress as () => void)();
      expect(onCheer).not.toHaveBeenCalled();
    });

    it("locks button as 'Cheered ✓' after 1 successful cheer and blocks second tap", async () => {
      const onCheer = vi.fn().mockResolvedValue(undefined);
      const props = {
        items: feedItems,
        cheerCountsByFeedId: { "feed-alpha": 5, "feed-beta": 2 },
        onCheer
      };

      let tree = renderWithHarness(AnonymizedFeedScreen, props);
      const btn = findByLabel(tree, "Cheer for @iron_fox");
      (btn!.onPress as () => void)();
      // Immediate second call before re-render is blocked by cheeredRef
      (btn!.onPress as () => void)();
      await flushMicrotasks();

      tree = renderWithHarness(AnonymizedFeedScreen, props);
      const lockedBtn = findByLabel(tree, "Cheer for @iron_fox");
      expect(onCheer).toHaveBeenCalledTimes(1);
      expect(lockedBtn!.disabled).toBe(true);
      expect(hasText(tree, "Cheered ✓ (5)")).toBe(true);

      // Subsequent press after re-render remains blocked
      (lockedBtn!.onPress as () => void)();
      await flushMicrotasks();
      expect(onCheer).toHaveBeenCalledTimes(1);
    });

    it("keeps 'Cheered ✓' locked when onCheer rejects with DuplicateCheerError or Postgres 23505", async () => {
      const dupErr = Object.assign(new Error("Already cheered"), {
        name: "DuplicateCheerError"
      });
      const pgDupErr = Object.assign(new Error("duplicate key value"), {
        code: "23505"
      });
      const onCheer = vi
        .fn()
        .mockRejectedValueOnce(dupErr)
        .mockRejectedValueOnce(pgDupErr);
      const onError = vi.fn();

      const props = {
        items: feedItems,
        cheerCountsByFeedId: { "feed-alpha": 4, "feed-beta": 8 },
        onCheer,
        onError
      };

      let tree = renderWithHarness(AnonymizedFeedScreen, props);
      (findByLabel(tree, "Cheer for @iron_fox")!.onPress as () => void)();
      (findByLabel(tree, "Cheer for @swift_hawk")!.onPress as () => void)();
      await flushMicrotasks();

      tree = renderWithHarness(AnonymizedFeedScreen, props);
      expect(onError).toHaveBeenCalledWith(dupErr);
      expect(onError).toHaveBeenCalledWith(pgDupErr);
      expect(findByLabel(tree, "Cheer for @iron_fox")!.disabled).toBe(true);
      expect(findByLabel(tree, "Cheer for @swift_hawk")!.disabled).toBe(true);
      expect(hasText(tree, "Cheered ✓ (4)")).toBe(true);
      expect(hasText(tree, "Cheered ✓ (8)")).toBe(true);
    });
  });

  // ==========================================================================
  // 6. WalletConnect QR Matrix & LoginScreen WalletConnectQrModal integration
  // ==========================================================================
  describe("WalletConnect QR Matrix & LoginScreen WalletConnectQrModal", () => {
    const sampleWcUri =
      "wc:7f6e5d4c3b2a109876543210fedcba9876543210@2?relay-protocol=irn&symKey=0123456789abcdef0123456789abcdef";

    it("generateQrMatrix produces a deterministic valid square boolean module grid for a realistic WalletConnect URI", () => {
      const m1 = generateQrMatrix(sampleWcUri);
      const m2 = generateQrMatrix(sampleWcUri);

      expect(m1).toEqual(m2);
      expect(m1.version).toBeGreaterThanOrEqual(1);
      expect(m1.version).toBeLessThanOrEqual(12);
      expect(m1.size).toBe(m1.version * 4 + 17);
      expect(m1.modules).toHaveLength(m1.size);
      for (const row of m1.modules) {
        expect(row).toHaveLength(m1.size);
        for (const cell of row) {
          expect(typeof cell).toBe("boolean");
        }
      }
      // Top-left 7x7 finder pattern outer ring is dark
      expect(m1.modules[0]?.[0]).toBe(true);
      expect(m1.modules[0]?.[6]).toBe(true);
      expect(m1.modules[6]?.[0]).toBe(true);
    });

    it("LoginScreen opens WalletConnectQrModal with matrix & URI, copies URI, and triggers onCancelWalletConnect on close", async () => {
      const setStringAsync = vi.fn().mockResolvedValue(true);
      setClipboardAdapterForTesting({ setStringAsync });

      let resolveWcSignIn!: () => void;
      const onSignInWithWalletConnect = vi.fn(
        (onDisplayUri?: (uri: string) => void) => {
          onDisplayUri?.(sampleWcUri);
          return new Promise<void>((resolve) => {
            resolveWcSignIn = resolve;
          });
        }
      );
      const onCancelWalletConnect = vi.fn(() => {
        resolveWcSignIn();
      });

      const props = {
        onSignInWithGoogle: vi.fn(),
        onSignInWithMetaMask: vi.fn(),
        onSignInWithWalletConnect,
        isWalletConnectConfigured: true,
        onCancelWalletConnect
      };

      let tree = renderWithHarness(LoginScreen, props);
      expect(findByTestId(tree, "wc-qr-modal")).toBeNull();

      // Trigger WalletConnect sign-in -> emits display_uri -> renders QR modal
      const wcBtn = findByTestId(tree, "login-walletconnect-button");
      expect(wcBtn).not.toBeNull();
      (wcBtn!.onPress as () => void)();
      await flushMicrotasks();

      tree = renderWithHarness(LoginScreen, props);
      expect(findByTestId(tree, "wc-qr-modal")).not.toBeNull();
      expect(findByTestId(tree, "wc-qr-matrix")).not.toBeNull();
      const uriTextNode = findByTestId(tree, "wc-pairing-uri-text");
      expect(uriTextNode).not.toBeNull();
      expect(uriTextNode!.children).toBe(sampleWcUri);
      expect(hasText(tree, sampleWcUri)).toBe(true);

      // Copy URI button copies exact pairing URI
      const copyBtn = findByTestId(tree, "wc-copy-uri-button");
      expect(copyBtn).not.toBeNull();
      (copyBtn!.onPress as () => void)();
      await flushMicrotasks();

      expect(setStringAsync).toHaveBeenCalledWith(sampleWcUri);

      // Close button cancels pairing and hides modal
      const closeBtn = findByTestId(tree, "wc-qr-close-button");
      expect(closeBtn).not.toBeNull();
      (closeBtn!.onPress as () => void)();
      await flushMicrotasks();

      expect(onCancelWalletConnect).toHaveBeenCalledTimes(1);
      tree = renderWithHarness(LoginScreen, props);
      expect(findByTestId(tree, "wc-qr-modal")).toBeNull();
    });
  });
});
