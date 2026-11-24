import {
  Address,
  AnonymizedFeedRecord,
  Bytes32,
  DailyPlan,
  DEFAULT_BASELINE_BIOMETRICS,
  UserProfile
} from "@dehealth/shared";
import { Provider, Signer, Wallet, parseEther } from "ethers";
import vm from "node:vm";
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
  copyWalletAddressToClipboard,
  ErrorNoticeModal,
  ErrorNoticeModalProps,
  ErrorNoticePayload,
  toErrorNoticePayload
} from "../components/ErrorNoticeModal";
import { StreakFlameHeader } from "../components/StreakFlameHeader";
import {
  AnonymizedFeedScreen,
  AnonymizedFeedScreenProps
} from "../screens/AnonymizedFeedScreen";
import {
  MicroCheckInScreen,
  MicroCheckInScreenProps
} from "../screens/MicroCheckInScreen";
import { generate14DayPlan } from "../services/adaptivePlanEngine";
import {
  claimStreakReward,
  DEFAULT_INSUFFICIENT_GAS_MESSAGE,
  InsufficientGasError,
  MIN_FALLBACK_GAS_BALANCE_WEI,
  resetL2Config,
  setContractFactory,
  setL2Provider,
  setRewardGateAddress
} from "../services/l2ContractService";
import {
  resetClipboardAdapterForTesting,
  setClipboardAdapterForTesting
} from "../services/clipboardService";
import { resetPedometerAdapterForTesting } from "../services/sensorService";
import { resetAdaptiveStorage } from "../storage/adaptiveStorage";

const TEST_PRIVATE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";
const TEST_GATE_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const TEST_SECRET = ("0x" + "ab".repeat(32)) as Bytes32;

const TEST_PROFILE: UserProfile = {
  age: 28,
  gender: "male",
  bodyFatPct: 16.0,
  muscleMassKg: 37.5
};

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

describe("R1 (#6) ErrorNoticeModal, Gas Pre-Check UI & Async finally Guards", () => {
  let wallet: Wallet;
  let unlockedDay: DailyPlan;
  let cycleId: string;

  beforeEach(() => {
    resetHarness();
    resetL2Config();
    resetAdaptiveStorage();
    resetPedometerAdapterForTesting();
    resetClipboardAdapterForTesting();
    sensorMocks.isPedometerAvailable = null;
    sensorMocks.getTodayStepCount = null;
    wallet = new Wallet(TEST_PRIVATE_KEY);
    const cycle = generate14DayPlan(DEFAULT_BASELINE_BIOMETRICS, 1_700_000_000_000);
    cycleId = cycle.id;
    unlockedDay = {
      ...cycle.dailyPlans[0]!,
      completed: false,
      loggedCaloriesKcal: 450
    };
  });

  afterEach(() => {
    resetHarness();
    resetClipboardAdapterForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ============================================================================
  // 1. toErrorNoticePayload & copyWalletAddressToClipboard
  // ============================================================================
  describe("toErrorNoticePayload & copyWalletAddressToClipboard", () => {
    it("maps InsufficientGasError with signerAddress to actionable gas notice", () => {
      const err = new InsufficientGasError(DEFAULT_INSUFFICIENT_GAS_MESSAGE, {
        signerAddress: wallet.address as Address,
        balanceWei: 0n,
        requiredWei: MIN_FALLBACK_GAS_BALANCE_WEI
      });
      const payload = toErrorNoticePayload(err);
      expect(payload.title).toBe("Insufficient Arbitrum Sepolia Gas");
      expect(payload.message).toBe(DEFAULT_INSUFFICIENT_GAS_MESSAGE);
      expect(payload.isInsufficientGas).toBe(true);
      expect(payload.walletAddress).toBe(wallet.address);
    });

    it("falls back to walletAddress parameter when InsufficientGasError.signerAddress is omitted", () => {
      const err = new InsufficientGasError("Out of Sepolia ETH");
      const payload = toErrorNoticePayload(err, "Claim Error", wallet.address);
      expect(payload.title).toBe("Insufficient Arbitrum Sepolia Gas");
      expect(payload.message).toBe("Out of Sepolia ETH");
      expect(payload.isInsufficientGas).toBe(true);
      expect(payload.walletAddress).toBe(wallet.address);
    });

    it("maps generic Error, string, and unknown objects cleanly with isInsufficientGas: false", () => {
      const errPayload = toErrorNoticePayload(new Error("RPC timeout"), "Sync Failed");
      expect(errPayload).toEqual({
        title: "Sync Failed",
        message: "RPC timeout",
        isInsufficientGas: false,
        walletAddress: null
      });

      const strPayload = toErrorNoticePayload("  Network offline  ", "Feed Error");
      expect(strPayload.message).toBe("Network offline");
      expect(strPayload.isInsufficientGas).toBe(false);

      const unknownPayload = toErrorNoticePayload({ unexpected: true });
      expect(unknownPayload.title).toBe("Action Failed");
      expect(unknownPayload.message).toBe("An unexpected error occurred. Please try again.");
      expect(unknownPayload.isInsufficientGas).toBe(false);
    });

    it("handles cross-realm Error/InsufficientGasError and serialized error objects while rejecting arrays/primitives", () => {
      const crossRealmGasErr: unknown = vm.runInNewContext(
        'Object.assign(new Error("Cross realm gas err"), { name: "InsufficientGasError", signerAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" })'
      );
      const crossRealmGasPayload = toErrorNoticePayload(crossRealmGasErr);
      expect(crossRealmGasPayload).toEqual({
        title: "Insufficient Arbitrum Sepolia Gas",
        message: "Cross realm gas err",
        isInsufficientGas: true,
        walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
      });

      const serializedGasErr = {
        name: "InsufficientGasError",
        message: "Serialized gas err",
        signerAddress: "0x9999999999999999999999999999999999999999"
      };
      const serializedGasPayload = toErrorNoticePayload(serializedGasErr);
      expect(serializedGasPayload).toEqual({
        title: "Insufficient Arbitrum Sepolia Gas",
        message: "Serialized gas err",
        isInsufficientGas: true,
        walletAddress: "0x9999999999999999999999999999999999999999"
      });

      const blankSerializedGasPayload = toErrorNoticePayload(
        { name: "InsufficientGasError", message: "   ", signerAddress: "  " },
        "Ignored Title",
        wallet.address
      );
      expect(blankSerializedGasPayload).toEqual({
        title: "Insufficient Arbitrum Sepolia Gas",
        message: DEFAULT_INSUFFICIENT_GAS_MESSAGE,
        isInsufficientGas: true,
        walletAddress: wallet.address
      });

      const crossRealmGenericErr: unknown = vm.runInNewContext(
        'new Error("Cross realm generic error")'
      );
      expect(toErrorNoticePayload(crossRealmGenericErr, "Sync Failed")).toEqual({
        title: "Sync Failed",
        message: "Cross realm generic error",
        isInsufficientGas: false,
        walletAddress: null
      });

      for (const nonError of [{ unexpected: true }, {}, [], null, undefined, 42, true]) {
        expect(toErrorNoticePayload(nonError)).toEqual({
          title: "Action Failed",
          message: "An unexpected error occurred. Please try again.",
          isInsufficientGas: false,
          walletAddress: null
        });
      }
    });

    it("copyWalletAddressToClipboard writes via navigator.clipboard.writeText and handles failures gracefully", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });

      expect(await copyWalletAddressToClipboard(wallet.address)).toBe(true);
      expect(writeText).toHaveBeenCalledWith(wallet.address);

      expect(await copyWalletAddressToClipboard("   ")).toBe(false);

      writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
      expect(await copyWalletAddressToClipboard(wallet.address)).toBe(false);

      vi.stubGlobal("navigator", {});
      expect(await copyWalletAddressToClipboard(wallet.address)).toBe(false);
    });

    it("copyWalletAddressToClipboard invokes injected native ClipboardAdapter.setStringAsync and falls back to navigator.clipboard.writeText on rejection or absence", async () => {
      const setStringAsync = vi.fn().mockResolvedValue(true);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      setClipboardAdapterForTesting({ setStringAsync });

      expect(await copyWalletAddressToClipboard(`  ${wallet.address}  `)).toBe(true);
      expect(setStringAsync).toHaveBeenCalledWith(wallet.address);
      expect(writeText).not.toHaveBeenCalled();

      // Rejecting native adapter falls back cleanly to navigator.clipboard.writeText
      setStringAsync.mockRejectedValueOnce(new Error("Native clipboard error"));
      expect(await copyWalletAddressToClipboard(wallet.address)).toBe(true);
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(wallet.address);

      // Absent native adapter (null) also uses navigator.clipboard.writeText
      setClipboardAdapterForTesting(null);
      expect(await copyWalletAddressToClipboard(wallet.address)).toBe(true);
      expect(writeText).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // 2. ErrorNoticeModal Static Markup & Interactive Hook-Harness Tests
  // ============================================================================
  describe("ErrorNoticeModal rendering & 1-tap Copy Wallet Address", () => {
    it("returns empty markup when visible is false or notice is null", () => {
      const notice = toErrorNoticePayload(new Error("Boom"));
      expect(
        renderToStaticMarkup(
          React.createElement(ErrorNoticeModal, {
            visible: false,
            notice,
            onDismiss: vi.fn()
          })
        )
      ).toBe("");

      expect(
        renderToStaticMarkup(
          React.createElement(ErrorNoticeModal, {
            visible: true,
            notice: null,
            onDismiss: vi.fn()
          })
        )
      ).toBe("");
    });

    it("renders InsufficientGasError modal with wallet address, Copy Wallet Address button, and Dismiss button", () => {
      const gasNotice = toErrorNoticePayload(
        new InsufficientGasError(DEFAULT_INSUFFICIENT_GAS_MESSAGE, {
          signerAddress: wallet.address as Address
        })
      );

      const markup = renderToStaticMarkup(
        React.createElement(ErrorNoticeModal, {
          visible: true,
          notice: gasNotice,
          onDismiss: vi.fn()
        })
      );

      expect(markup).toContain("Insufficient Arbitrum Sepolia Gas");
      expect(markup).toContain(DEFAULT_INSUFFICIENT_GAS_MESSAGE);
      expect(markup).toContain(wallet.address);
      expect(markup).toContain("Copy Wallet Address");
      expect(markup).toContain("Dismiss");
    });

    it("omits Copy Wallet Address button for non-gas errors even if walletAddress is attached", () => {
      const genericNotice: ErrorNoticePayload = toErrorNoticePayload(
        new Error("Signature rejected by user"),
        "Proof Dispatch Error",
        wallet.address
      );

      const markup = renderToStaticMarkup(
        React.createElement(ErrorNoticeModal, {
          visible: true,
          notice: genericNotice,
          onDismiss: vi.fn()
        })
      );

      expect(markup).toContain("Proof Dispatch Error");
      expect(markup).toContain("Signature rejected by user");
      expect(markup).toContain("Dismiss");
      expect(markup).not.toContain("Copy Wallet Address");
    });

    it("copies wallet address in 1 tap, shows feedback, resets feedback on re-open, and falls back without clipboard", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      // Exercise the browser clipboard path deterministically instead of
      // racing a real dynamic import of the native module.
      setClipboardAdapterForTesting(null);

      const onCopyWalletAddress = vi.fn();
      const onDismiss = vi.fn();
      const gasNotice = toErrorNoticePayload(
        new InsufficientGasError(DEFAULT_INSUFFICIENT_GAS_MESSAGE, {
          signerAddress: wallet.address as Address
        })
      );

      const baseModalProps: ErrorNoticeModalProps = {
        visible: true,
        notice: gasNotice,
        onDismiss,
        onCopyWalletAddress
      };

      let tree = renderWithHarness(ErrorNoticeModal, baseModalProps);
      const copyBtn = findByLabel(tree, "Copy Wallet Address");
      expect(copyBtn).not.toBeNull();
      (copyBtn!.onPress as () => void)();
      await flushMicrotasks();

      tree = renderWithHarness(ErrorNoticeModal, baseModalProps);
      expect(writeText).toHaveBeenCalledWith(wallet.address);
      expect(onCopyWalletAddress).toHaveBeenCalledWith(wallet.address);
      expect(hasText(tree, "Wallet address copied to clipboard!")).toBe(true);

      // Toggling visible false -> true clears copyFeedback via useEffect
      tree = renderWithHarness(ErrorNoticeModal, {
        ...baseModalProps,
        visible: false
      });
      expect(tree).toBeNull();

      tree = renderWithHarness(ErrorNoticeModal, baseModalProps);
      expect(hasText(tree, "Wallet address copied to clipboard!")).toBe(false);

      // Missing clipboard degrades gracefully to manual copy guidance
      vi.stubGlobal("navigator", {});
      const noCallbackProps: ErrorNoticeModalProps = {
        visible: true,
        notice: gasNotice,
        onDismiss
      };
      tree = renderWithHarness(ErrorNoticeModal, noCallbackProps);
      const copyBtnFallback = findByLabel(tree, "Copy Wallet Address");
      (copyBtnFallback!.onPress as () => void)();
      await flushMicrotasks();

      tree = renderWithHarness(ErrorNoticeModal, noCallbackProps);
      expect(
        hasText(tree, "Wallet address selected. Copy via keyboard or long press.")
      ).toBe(true);

      const dismissBtn = findByLabel(tree, "Dismiss Error Notice");
      expect(dismissBtn).not.toBeNull();
      (dismissBtn!.onPress as () => void)();
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // 3. MicroCheckInScreen Async finally & onError Lifecycle
  // ============================================================================
  describe("MicroCheckInScreen async error handling & finally reset", () => {
    it("resets isSubmitting in finally, keeps isProofLocked false, and surfaces InsufficientGasError via onError", async () => {
      const mockProvider = {
        getBalance: vi.fn().mockResolvedValue(parseEther("0.00001"))
      } as unknown as Provider;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);
      const contractClaimMock = vi.fn();
      setContractFactory(() => ({ claimStreakReward: contractClaimMock }));

      const onError = vi.fn();
      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 2,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: unlockedDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        isProofSigned: false,
        initialStepCount: 1500,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        onError,
        onDispatchSignedClaim: async (signedPayload) => {
          await claimStreakReward(signedPayload, wallet);
        }
      };

      let tree = renderWithHarness(MicroCheckInScreen, props);
      const primaryBtnBefore = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Complete & Sign Daily Proof")
      );
      expect(primaryBtnBefore).not.toBeNull();
      expect(primaryBtnBefore!.disabled).toBe(false);

      // Trigger async sign + live claim (will fail in gas pre-check)
      (primaryBtnBefore!.onPress as () => void)();

      // Immediately after click (while pending): isSubmitting is true
      tree = renderWithHarness(MicroCheckInScreen, props);
      expect(hasText(tree, "Hashing & Signing EIP-712 Proof...")).toBe(true);

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });
      await flushMicrotasks();
      tree = renderWithHarness(MicroCheckInScreen, props);

      // Finally reset & unlocked state preserved
      expect(contractClaimMock).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(InsufficientGasError);

      const primaryBtnAfter = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Complete & Sign Daily Proof")
      );
      expect(primaryBtnAfter).not.toBeNull();
      expect(primaryBtnAfter!.disabled).toBe(false);
      expect(hasText(tree, "Daily Proof Signed & Claimed")).toBe(false);
      expect(hasText(tree, "Check-in failed:")).toBe(true);
    });

    it("resets isSubmitting and activeCardId on express 1-tap signing rejection without locking proof", async () => {
      const signDeferred = createDeferred<string>();
      const failingSigner = {
        getAddress: vi.fn().mockResolvedValue(wallet.address),
        signTypedData: vi.fn().mockReturnValue(signDeferred.promise)
      } as unknown as Signer;

      const onDispatchSignedClaim = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn();

      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 1,
        currentNonce: 0n,
        signer: failingSigner,
        userProfile: TEST_PROFILE,
        dailyPlan: unlockedDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        isProofSigned: false,
        initialStepCount: 1000,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        onDispatchSignedClaim,
        onError
      };

      let tree = renderWithHarness(MicroCheckInScreen, props);
      const expressCardBtn = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Cardio / Brisk Walk")
      );
      expect(expressCardBtn).not.toBeNull();
      (expressCardBtn!.onPress as () => void)();

      tree = renderWithHarness(MicroCheckInScreen, props);
      expect(hasText(tree, "Signing...")).toBe(true);

      await vi.waitFor(() => {
        expect(
          (failingSigner.signTypedData as ReturnType<typeof vi.fn>)
        ).toHaveBeenCalledTimes(1);
      });

      signDeferred.reject(new Error("User rejected EIP-712 signature"));
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });
      await flushMicrotasks();
      tree = renderWithHarness(MicroCheckInScreen, props);

      expect(onDispatchSignedClaim).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]?.[0] as Error).message).toContain(
        "User rejected EIP-712 signature"
      );
      expect(hasText(tree, "Signing...")).toBe(false);
      expect(hasText(tree, "1-Tap Sign →")).toBe(true);
      expect(hasText(tree, "Claimed ✓")).toBe(false);
    });

    it("fails closed with a disconnected-signer error when no signer is available", async () => {
      const onDispatchSignedClaim = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn();

      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 1,
        currentNonce: 0n,
        signer: null,
        userProfile: TEST_PROFILE,
        dailyPlan: unlockedDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        isProofSigned: false,
        initialStepCount: 1000,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        onDispatchSignedClaim,
        onError
      };

      let tree = renderWithHarness(MicroCheckInScreen, props);
      const expressCardBtn = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Cardio / Brisk Walk")
      );
      expect(expressCardBtn).not.toBeNull();
      (expressCardBtn!.onPress as () => void)();

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });
      await flushMicrotasks();
      tree = renderWithHarness(MicroCheckInScreen, props);

      expect((onError.mock.calls[0]?.[0] as Error).message).toContain(
        "Wallet signer is disconnected"
      );
      expect(onDispatchSignedClaim).not.toHaveBeenCalled();
      expect(hasText(tree, "Signing...")).toBe(false);
    });

    it("handles syncSteps rejection via try/catch/finally and suppresses stale updates after unmount", async () => {
      const availDeferred = createDeferred<boolean>();
      sensorMocks.isPedometerAvailable = () => availDeferred.promise;

      const onError = vi.fn();
      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 0,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: unlockedDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined),
        onError
      };

      let tree = renderWithHarness(MicroCheckInScreen, props);
      const statusBadgePending = findByLabel(tree, "Daily Step Counter Status");
      expect(statusBadgePending?.accessibilityState).toEqual({ busy: true });

      availDeferred.reject(new Error("Sensor permission crash"));
      await flushMicrotasks(10);
      tree = renderWithHarness(MicroCheckInScreen, props);

      const statusBadgeAfter = findByLabel(tree, "Daily Step Counter Status");
      expect(statusBadgeAfter?.accessibilityState).toEqual({ busy: false });
      expect(hasText(tree, "Manual Step Fallback")).toBe(true);
      expect(onError).toHaveBeenCalledTimes(1);

      // Unmount cancellation test: stale rejection after unmount must not invoke onError
      resetHarness();
      const delayedAvail = createDeferred<boolean>();
      sensorMocks.isPedometerAvailable = () => delayedAvail.promise;
      const onErrorUnmounted = vi.fn();
      renderWithHarness(MicroCheckInScreen, {
        ...props,
        onError: onErrorUnmounted
      });
      unmountHarness();
      delayedAvail.reject(new Error("Late sensor rejection"));
      await flushMicrotasks(10);
      expect(onErrorUnmounted).not.toHaveBeenCalled();
    });

    it("guards handleLogFoodPortion and handleToggleExercise with try/catch/finally while keeping preview storage non-fatal", async () => {
      const onError = vi.fn();
      const props: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 0,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: unlockedDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        initialStepCount: 0,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        initialCheckInMode: "detailed",
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined),
        onError
      };

      // AdaptiveStorage is uninitialized -> saveDailyTaskCompletion rejects internally, must remain non-fatal
      let tree = renderWithHarness(MicroCheckInScreen, props);
      const logBtn = findByLabel(tree, "Log Food Portion");
      expect(logBtn).not.toBeNull();
      expect(logBtn!.disabled).toBe(false);
      (logBtn!.onPress as () => void)();
      await flushMicrotasks(10);
      tree = renderWithHarness(MicroCheckInScreen, props);

      const logBtnAfter = findByLabel(tree, "Log Food Portion");
      expect(logBtnAfter!.disabled).toBe(false);
      expect(onError).not.toHaveBeenCalled();

      // If onUpdateDailyPlan throws, isUpdatingTask still resets in finally and onError is called
      const throwingProps: MicroCheckInScreenProps = {
        ...props,
        onUpdateDailyPlan: () => {
          throw new Error("Plan sync error");
        }
      };
      tree = renderWithHarness(MicroCheckInScreen, throwingProps);
      const firstExerciseName = unlockedDay.exercises[0]!.name;
      const exerciseBtn = findByLabel(tree, `Toggle Exercise ${firstExerciseName}`);
      expect(exerciseBtn).not.toBeNull();
      (exerciseBtn!.onPress as () => void)();
      await flushMicrotasks(10);
      tree = renderWithHarness(MicroCheckInScreen, throwingProps);

      const exerciseBtnAfter = findByLabel(
        tree,
        `Toggle Exercise ${firstExerciseName}`
      );
      expect(exerciseBtnAfter!.disabled).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("blocks same-frame (pre-re-render) rapid double-tap on proof signing, food logging, and exercise toggling while allowing retry after finally", async () => {
      // 1. Same-frame double-tap on handleSignAndDispatchProof (primary + express card)
      let dispatchDeferred = createDeferred<void>();
      const onDispatchSignedClaim = vi.fn().mockImplementation(() => dispatchDeferred.promise);
      const onError = vi.fn();

      const proofProps: MicroCheckInScreenProps = {
        userAddress: wallet.address as Address,
        verifyingContract: TEST_GATE_ADDRESS,
        currentStreak: 1,
        currentNonce: 0n,
        signer: wallet,
        userProfile: TEST_PROFILE,
        dailyPlan: unlockedDay,
        cycleId,
        vaultSecretHex: TEST_SECRET,
        isProofSigned: false,
        initialStepCount: 1500,
        initialStepSource: "manual-fallback",
        initialPedometerAvailable: false,
        initialCheckInMode: "detailed",
        onDispatchSignedClaim,
        onError
      };

      let tree = renderWithHarness(MicroCheckInScreen, proofProps);
      const primaryBtn = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Complete & Sign Daily Proof")
      );
      const expressCard = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Cardio / Brisk Walk")
      );
      expect(primaryBtn).not.toBeNull();
      expect(expressCard).not.toBeNull();

      // Invoke twice synchronously on the SAME render tree before React re-renders
      (primaryBtn!.onPress as () => void)();
      (primaryBtn!.onPress as () => void)();
      (expressCard!.onPress as () => void)();

      await vi.waitFor(() => {
        expect(onDispatchSignedClaim).toHaveBeenCalledTimes(1);
      });
      await flushMicrotasks(5);
      expect(onDispatchSignedClaim).toHaveBeenCalledTimes(1);

      // Reject first attempt -> finally unlocks isSubmittingRef so retry succeeds
      dispatchDeferred.reject(new Error("Transient RPC failure"));
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });
      await flushMicrotasks(10);

      dispatchDeferred = createDeferred<void>();
      tree = renderWithHarness(MicroCheckInScreen, proofProps);
      const primaryBtnRetry = findElement(
        tree,
        (elProps) =>
          elProps.accessibilityRole === "button" &&
          hasText(elProps.children as React.ReactNode, "Complete & Sign Daily Proof")
      );
      (primaryBtnRetry!.onPress as () => void)();
      await vi.waitFor(() => {
        expect(onDispatchSignedClaim).toHaveBeenCalledTimes(2);
      });
      dispatchDeferred.resolve(undefined);
      await flushMicrotasks(10);

      // 2. Same-frame double-tap on handleLogFoodPortion & handleToggleExercise + invalid input non-locking
      resetHarness();
      const onUpdateDailyPlan = vi.fn();
      const taskProps: MicroCheckInScreenProps = {
        ...proofProps,
        onDispatchSignedClaim: vi.fn().mockResolvedValue(undefined),
        onUpdateDailyPlan
      };

      tree = renderWithHarness(MicroCheckInScreen, taskProps);
      const gramsInput = findByLabel(tree, "Portion grams input");
      expect(gramsInput).not.toBeNull();
      (gramsInput!.onChangeText as (value: string) => void)("0");
      tree = renderWithHarness(MicroCheckInScreen, taskProps);

      // Invalid grams (<= 0) must show validation message WITHOUT locking isUpdatingTaskRef
      const logBtnInvalid = findByLabel(tree, "Log Food Portion");
      (logBtnInvalid!.onPress as () => void)();
      tree = renderWithHarness(MicroCheckInScreen, taskProps);
      expect(hasText(tree, "Please enter a valid portion weight in grams")).toBe(true);
      expect(onUpdateDailyPlan).not.toHaveBeenCalled();

      // Restore valid grams and double-tap synchronously on the same render tree
      (findByLabel(tree, "Portion grams input")!.onChangeText as (value: string) => void)(
        "150"
      );
      tree = renderWithHarness(MicroCheckInScreen, taskProps);
      const logBtnValid = findByLabel(tree, "Log Food Portion");
      (logBtnValid!.onPress as () => void)();
      (logBtnValid!.onPress as () => void)();
      expect(onUpdateDailyPlan).toHaveBeenCalledTimes(1);

      await flushMicrotasks(10);

      // After finally resets, same-frame double-tap on handleToggleExercise allows only 1 call
      tree = renderWithHarness(MicroCheckInScreen, taskProps);
      const firstExerciseName = unlockedDay.exercises[0]!.name;
      const exerciseBtn = findByLabel(tree, `Toggle Exercise ${firstExerciseName}`);
      (exerciseBtn!.onPress as () => void)();
      (exerciseBtn!.onPress as () => void)();
      expect(onUpdateDailyPlan).toHaveBeenCalledTimes(2);

      await flushMicrotasks(10);

      // Subsequent toggle after finally succeeds
      tree = renderWithHarness(MicroCheckInScreen, taskProps);
      const exerciseBtnAfter = findByLabel(tree, `Toggle Exercise ${firstExerciseName}`);
      (exerciseBtnAfter!.onPress as () => void)();
      expect(onUpdateDailyPlan).toHaveBeenCalledTimes(3);
      await flushMicrotasks(10);
    });
  });

  // ============================================================================
  // 4. AnonymizedFeedScreen Async Cheer Guard
  // ============================================================================
  describe("AnonymizedFeedScreen async cheer error/rollback/finally guard", () => {
    const sampleFeed: readonly AnonymizedFeedRecord[] = [
      {
        id: "feed-1",
        user_pseudonym: "iron_fox",
        streak_count: 7,
        proof_hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        created_at: new Date("2026-11-19T08:00:00Z").toISOString()
      }
    ];

    it("rolls back optimistic cheer on async rejection, invokes onError, and resets disabled in finally", async () => {
      const cheerDeferred = createDeferred<void>();
      const onCheer = vi.fn().mockReturnValue(cheerDeferred.promise);
      const onError = vi.fn();

      const props: AnonymizedFeedScreenProps = {
        items: sampleFeed,
        cheerCountsByFeedId: { "feed-1": 4 },
        onCheer,
        onError
      };

      let tree = renderWithHarness(AnonymizedFeedScreen, props);
      const cheerBtn = findByLabel(tree, "Cheer for @iron_fox");
      expect(cheerBtn).not.toBeNull();
      expect(cheerBtn!.disabled).toBe(false);
      expect(hasText(tree, "Cheer (4)")).toBe(true);

      // Press cheer -> optimistic Cheered ✓ + disabled=true while pending
      (cheerBtn!.onPress as () => void)();
      tree = renderWithHarness(AnonymizedFeedScreen, props);
      const cheerBtnPending = findByLabel(tree, "Cheer for @iron_fox");
      expect(cheerBtnPending!.disabled).toBe(true);
      expect(hasText(tree, "Cheered ✓ (4)")).toBe(true);

      // Reject async cheer -> rolls back, notifies onError, clears disabled in finally
      const cheerErr = new Error("Supabase RPC unavailable");
      cheerDeferred.reject(cheerErr);
      await flushMicrotasks(10);

      tree = renderWithHarness(AnonymizedFeedScreen, props);
      const cheerBtnAfter = findByLabel(tree, "Cheer for @iron_fox");
      expect(cheerBtnAfter!.disabled).toBe(false);
      expect(hasText(tree, "Cheer (4)")).toBe(true);
      expect(onError).toHaveBeenCalledWith(cheerErr);
    });

    it("keeps Cheered ✓ state and locks against duplicate cheers when resolving onCheer completes and handles missing onError safely", async () => {
      // Resolving async cheer
      const resolvingProps: AnonymizedFeedScreenProps = {
        items: sampleFeed,
        cheerCountsByFeedId: { "feed-1": 2 },
        onCheer: vi.fn().mockResolvedValue(undefined)
      };

      let tree = renderWithHarness(AnonymizedFeedScreen, resolvingProps);
      (findByLabel(tree, "Cheer for @iron_fox")!.onPress as () => void)();
      await flushMicrotasks(10);
      tree = renderWithHarness(AnonymizedFeedScreen, resolvingProps);
      expect(findByLabel(tree, "Cheer for @iron_fox")!.disabled).toBe(true);
      expect(hasText(tree, "Cheered ✓ (2)")).toBe(true);

      // Rejecting async cheer when onError is omitted must not cause unhandled rejection
      resetHarness();
      const noOnErrorProps: AnonymizedFeedScreenProps = {
        items: sampleFeed,
        cheerCountsByFeedId: { "feed-1": 1 },
        onCheer: vi.fn().mockRejectedValue(new Error("Silent cheer failure"))
      };
      tree = renderWithHarness(AnonymizedFeedScreen, noOnErrorProps);
      (findByLabel(tree, "Cheer for @iron_fox")!.onPress as () => void)();
      await flushMicrotasks(10);
      tree = renderWithHarness(AnonymizedFeedScreen, noOnErrorProps);
      expect(findByLabel(tree, "Cheer for @iron_fox")!.disabled).toBe(false);
      expect(hasText(tree, "Cheer (1)")).toBe(true);
    });

    it("blocks same-frame (pre-re-render) rapid double-tap per feedId while allowing independent feed cards concurrently and retry after finally", async () => {
      const twoItemFeed: readonly AnonymizedFeedRecord[] = [
        ...sampleFeed,
        {
          id: "feed-2",
          user_pseudonym: "swift_hawk",
          streak_count: 12,
          proof_hash:
            "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          created_at: new Date("2026-11-19T08:05:00Z").toISOString()
        }
      ];

      const deferredByFeed: Record<string, Deferred<void>> = {
        "feed-1": createDeferred<void>(),
        "feed-2": createDeferred<void>()
      };
      const onCheer = vi.fn((feedId: string) => deferredByFeed[feedId]!.promise);
      const onError = vi.fn();

      const props: AnonymizedFeedScreenProps = {
        items: twoItemFeed,
        cheerCountsByFeedId: { "feed-1": 4, "feed-2": 9 },
        onCheer,
        onError
      };

      let tree = renderWithHarness(AnonymizedFeedScreen, props);
      const feed1Btn = findByLabel(tree, "Cheer for @iron_fox");
      const feed2Btn = findByLabel(tree, "Cheer for @swift_hawk");
      expect(feed1Btn).not.toBeNull();
      expect(feed2Btn).not.toBeNull();

      // Same-frame rapid double-tap on feed-1 + concurrent tap on feed-2 before re-render
      (feed1Btn!.onPress as () => void)();
      (feed1Btn!.onPress as () => void)();
      (feed2Btn!.onPress as () => void)();

      expect(onCheer).toHaveBeenCalledTimes(2);
      expect(onCheer.mock.calls).toEqual([["feed-1"], ["feed-2"]]);

      // feed-1 rejects -> rolls back & unlocks in finally; feed-2 resolves -> stays Cheered ✓ & stays locked
      deferredByFeed["feed-1"]!.reject(new Error("Feed 1 cheer timeout"));
      deferredByFeed["feed-2"]!.resolve(undefined);
      await flushMicrotasks(10);

      tree = renderWithHarness(AnonymizedFeedScreen, props);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(findByLabel(tree, "Cheer for @iron_fox")!.disabled).toBe(false);
      expect(findByLabel(tree, "Cheer for @swift_hawk")!.disabled).toBe(true);
      expect(hasText(tree, "Cheer (4)")).toBe(true);
      expect(hasText(tree, "Cheered ✓ (9)")).toBe(true);

      // Retry feed-1 after finally reset succeeds
      deferredByFeed["feed-1"] = createDeferred<void>();
      (findByLabel(tree, "Cheer for @iron_fox")!.onPress as () => void)();
      expect(onCheer).toHaveBeenCalledTimes(3);
      expect(onCheer.mock.calls[2]).toEqual(["feed-1"]);
      deferredByFeed["feed-1"]!.resolve(undefined);
      await flushMicrotasks(10);
    });
  });

  // ============================================================================
  // 5. Global Top-Right Header Copy Pill (StreakFlameHeader)
  // ============================================================================
  describe("StreakFlameHeader top-right copy pill", () => {
    it("renders compact 1-tap copy pill with testID=header-wallet-copy-pill and toggles Copied ✓", async () => {
      const setStringAsync = vi.fn().mockResolvedValue(true);
      setClipboardAdapterForTesting({ setStringAsync });

      const headerProps = {
        userAddress: wallet.address as Address,
        streakCount: 3,
        tokenBalanceDht: "30.0",
        isFatigueScaled: false,
        fitnessTier: "Balanced"
      };

      let tree = renderWithHarness(StreakFlameHeader, headerProps);
      const pill = findElement(
        tree,
        (elProps) => elProps.testID === "header-wallet-copy-pill"
      );
      expect(pill).not.toBeNull();
      expect(hasText(tree, "Copy")).toBe(true);

      (pill!.onPress as () => void)();
      await flushMicrotasks();
      tree = renderWithHarness(StreakFlameHeader, headerProps);

      expect(setStringAsync).toHaveBeenCalledWith(wallet.address);
      expect(hasText(tree, "Copied ✓")).toBe(true);
    });
  });
});
