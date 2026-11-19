import { Address } from "@dehealth/shared";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal hook harness: runs the component function directly so state,
 * effects and event handlers can be exercised without a DOM renderer.
 */
const harness = vi.hoisted(() => ({
  slots: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as { deps?: readonly unknown[] }[],
  pending: [] as (() => void)[],
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
  const useRef = <T,>(initial: T): { current: T } => {
    const i = harness.refIndex++;
    if (!(i in harness.refs)) {
      harness.refs[i] = { current: initial };
    }
    return harness.refs[i] as { current: T };
  };
  const useEffect = (fn: () => void, deps?: readonly unknown[]): void => {
    const i = harness.effectIndex++;
    const prev = harness.effects[i];
    const changed =
      !prev ||
      !deps ||
      !prev.deps ||
      deps.some((d, k) => !Object.is(d, prev.deps?.[k]));
    if (changed) {
      harness.effects[i] = { deps };
      harness.pending.push(() => {
        fn();
      });
    }
  };
  return {
    ...actual,
    default: { ...actual, useState, useRef, useEffect },
    useState,
    useRef,
    useEffect
  };
});

vi.mock("react-native", () => ({
  View: () => null,
  Text: () => null,
  Modal: () => null,
  Pressable: () => null,
  ScrollView: () => null,
  TextInput: () => null,
  Linking: { openURL: vi.fn().mockResolvedValue(true) },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles
  }
}));

import {
  AdminGovernanceModal,
  AdminGovernanceModalProps
} from "../components/AdminGovernanceModal";
import { L2InspectorStatus } from "../services/l2ContractService";
import {
  DEFAULT_GOVERNANCE_CONFIG,
  GOVERNANCE_PIN_STORAGE_KEY,
  setGovernancePin
} from "../storage/governanceStorage";
import { InMemoryKeyStore, SecureKeyStore } from "../storage/vaultKeyProvider";

const USER = "0x1111111111111111111111111111111111111111" as Address;

const STATUS: L2InspectorStatus = {
  rewardGateAddress: "0x2222222222222222222222222222222222222222" as Address,
  tokenAddress: "0x3333333333333333333333333333333333333333" as Address,
  rewardGateExplorerUrl: null,
  tokenExplorerUrl: null,
  mode: "simulated",
  rpcReachable: false,
  tokenBalance: null,
  lastProofHash: null
} as unknown as L2InspectorStatus;

let activeKeyStore: InMemoryKeyStore;

function baseProps(
  overrides: Partial<AdminGovernanceModalProps> = {}
): AdminGovernanceModalProps {
  return {
    visible: true,
    userAddress: USER,
    currentConfig: DEFAULT_GOVERNANCE_CONFIG,
    onSaveConfig: vi.fn().mockResolvedValue(undefined),
    onResetDefaults: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    initialInspectorStatus: STATUS,
    pinKeyStore: activeKeyStore,
    ...overrides
  } as AdminGovernanceModalProps;
}

function render(props: AdminGovernanceModalProps): React.ReactNode {
  harness.stateIndex = 0;
  harness.refIndex = 0;
  harness.effectIndex = 0;
  harness.pending = [];
  const tree = (AdminGovernanceModal as unknown as (
    p: AdminGovernanceModalProps
  ) => React.ReactNode)(props);
  const effects = harness.pending;
  harness.pending = [];
  for (const run of effects) {
    run();
  }
  if (harness.dirty) {
    harness.dirty = false;
    return render(props);
  }
  return tree;
}

async function flushMicrotasks(ticks = 25): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

async function renderSettled(
  props: AdminGovernanceModalProps
): Promise<React.ReactNode> {
  let tree = render(props);
  for (let i = 0; i < 4; i += 1) {
    await flushMicrotasks();
    if (!harness.dirty) {
      break;
    }
    harness.dirty = false;
    tree = render(props);
  }
  return tree;
}

function findByLabel(
  node: React.ReactNode,
  label: string
): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByLabel(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (props.accessibilityLabel === label) return props;
    return findByLabel(props.children as React.ReactNode, label);
  }
  return null;
}

function hasText(node: React.ReactNode, needle: string): boolean {
  if (typeof node === "string") return node.includes(needle);
  if (Array.isArray(node)) return node.some((c) => hasText(c, needle));
  if (React.isValidElement(node)) {
    return hasText(
      (node.props as { children?: React.ReactNode }).children,
      needle
    );
  }
  return false;
}

const CREATE_PIN_INPUT = "Create Governance PIN Input";
const CONFIRM_PIN_INPUT = "Confirm Governance PIN Input";
const SET_PIN_BTN = "Set Governance PIN Button";
const UNLOCK_INPUT = "Unlock Governance Controls";
const UNLOCK_BTN = "Unlock Governance Controls Button";
const SAVE_BTN = "Save Governance Parameters";
const RESET_BTN = "Reset Governance Defaults";

function press(tree: React.ReactNode, label: string): void {
  const el = findByLabel(tree, label);
  expect(el).not.toBeNull();
  (el!.onPress as () => void)();
}

function typeInput(
  tree: React.ReactNode,
  label: string,
  value: string
): void {
  const el = findByLabel(tree, label);
  expect(el).not.toBeNull();
  (el!.onChangeText as (v: string) => void)(value);
}

describe("AdminGovernanceModal PIN lock lifecycle", () => {
  const legacyHardcodedPin = "2026" + "04";

  beforeEach(() => {
    harness.slots = [];
    harness.refs = [];
    harness.effects = [];
    harness.pending = [];
    harness.dirty = false;
    activeKeyStore = new InMemoryKeyStore();
    delete process.env.EXPO_PUBLIC_GOVERNANCE_PIN;
  });

  it("starts in loading state synchronously and settles into first-open setup mode when no PIN is configured", async () => {
    const initialTree = render(baseProps());
    expect(hasText(initialTree, "Checking Governance PIN")).toBe(true);
    expect(findByLabel(initialTree, SAVE_BTN)).toBeNull();
    expect(findByLabel(initialTree, UNLOCK_BTN)).toBeNull();

    const settledTree = await renderSettled(baseProps());
    expect(findByLabel(settledTree, SET_PIN_BTN)).not.toBeNull();
    expect(findByLabel(settledTree, CREATE_PIN_INPUT)).not.toBeNull();
    expect(findByLabel(settledTree, CONFIRM_PIN_INPUT)).not.toBeNull();
    expect(findByLabel(settledTree, UNLOCK_BTN)).toBeNull();
    expect(findByLabel(settledTree, SAVE_BTN)).toBeNull();
    expect(findByLabel(settledTree, RESET_BTN)).toBeNull();
    expect(findByLabel(settledTree, "Daily Step Goal Input")).toBeNull();
  });

  it("rejects invalid or mismatched PINs during setup and keeps controls locked", async () => {
    let tree = await renderSettled(baseProps());

    typeInput(tree, CREATE_PIN_INPUT, "123");
    tree = render(baseProps());
    typeInput(tree, CONFIRM_PIN_INPUT, "123");
    tree = render(baseProps());
    press(tree, SET_PIN_BTN);
    tree = await renderSettled(baseProps());
    expect(findByLabel(tree, SAVE_BTN)).toBeNull();
    expect(hasText(tree, "4 to 8 digits")).toBe(true);

    typeInput(tree, CREATE_PIN_INPUT, "482910");
    tree = render(baseProps());
    typeInput(tree, CONFIRM_PIN_INPUT, "482911");
    tree = render(baseProps());
    press(tree, SET_PIN_BTN);
    tree = await renderSettled(baseProps());
    expect(findByLabel(tree, SAVE_BTN)).toBeNull();
    expect(hasText(tree, "do not match")).toBe(true);
  });

  it("creates and persists a 4-8 digit PIN in SecureKeyStore, unlocks immediately, and requires that PIN after reopening", async () => {
    let tree = await renderSettled(baseProps());
    typeInput(tree, CREATE_PIN_INPUT, "482910");
    tree = render(baseProps());
    typeInput(tree, CONFIRM_PIN_INPUT, "482910");
    tree = render(baseProps());
    press(tree, SET_PIN_BTN);
    tree = await renderSettled(baseProps());

    expect(findByLabel(tree, SAVE_BTN)).not.toBeNull();
    expect(findByLabel(tree, RESET_BTN)).not.toBeNull();
    expect(findByLabel(tree, SET_PIN_BTN)).toBeNull();
    expect(await activeKeyStore.getItem(GOVERNANCE_PIN_STORAGE_KEY)).toBe(
      "482910"
    );

    // Close and reopen: transitions to unlock mode (never setup again)
    tree = await renderSettled(baseProps({ visible: false }));
    tree = await renderSettled(baseProps({ visible: true }));
    expect(findByLabel(tree, SAVE_BTN)).toBeNull();
    expect(findByLabel(tree, SET_PIN_BTN)).toBeNull();
    expect(findByLabel(tree, UNLOCK_BTN)).not.toBeNull();

    // Rejects legacy hardcoded PIN and wrong PIN
    typeInput(tree, UNLOCK_INPUT, legacyHardcodedPin);
    tree = render(baseProps());
    press(tree, UNLOCK_BTN);
    tree = await renderSettled(baseProps());
    expect(findByLabel(tree, SAVE_BTN)).toBeNull();
    expect(hasText(tree, "Invalid governance PIN")).toBe(true);

    // Unlocks with the user-created PIN
    typeInput(tree, UNLOCK_INPUT, "482910");
    tree = render(baseProps());
    press(tree, UNLOCK_BTN);
    tree = await renderSettled(baseProps());
    expect(findByLabel(tree, SAVE_BTN)).not.toBeNull();
    expect(findByLabel(tree, RESET_BTN)).not.toBeNull();
  });

  it("honours EXPO_PUBLIC_GOVERNANCE_PIN override directly into unlock mode and rejects legacy/different stored PINs", async () => {
    await setGovernancePin("112233", activeKeyStore);
    process.env.EXPO_PUBLIC_GOVERNANCE_PIN = "424242";

    let tree = await renderSettled(baseProps());
    expect(findByLabel(tree, UNLOCK_BTN)).not.toBeNull();
    expect(findByLabel(tree, SET_PIN_BTN)).toBeNull();

    typeInput(tree, UNLOCK_INPUT, legacyHardcodedPin);
    tree = render(baseProps());
    press(tree, UNLOCK_BTN);
    tree = await renderSettled(baseProps());
    expect(findByLabel(tree, SAVE_BTN)).toBeNull();

    typeInput(tree, UNLOCK_INPUT, "112233");
    tree = render(baseProps());
    press(tree, UNLOCK_BTN);
    tree = await renderSettled(baseProps());
    expect(findByLabel(tree, SAVE_BTN)).toBeNull();

    typeInput(tree, UNLOCK_INPUT, "424242");
    tree = render(baseProps());
    press(tree, UNLOCK_BTN);
    tree = await renderSettled(baseProps());
    expect(findByLabel(tree, SAVE_BTN)).not.toBeNull();
  });

  it("saves only after unlock and rejects a 0.86 multiplier while accepting 0.85", async () => {
    await setGovernancePin("482910", activeKeyStore);
    const props = baseProps();

    let tree = await renderSettled(props);
    typeInput(tree, UNLOCK_INPUT, "482910");
    tree = render(props);
    press(tree, UNLOCK_BTN);
    tree = await renderSettled(props);

    typeInput(tree, "Fatigue Scaling Multiplier Input", "0.86");
    tree = render(props);
    press(tree, SAVE_BTN);
    tree = await renderSettled(props);
    expect(props.onSaveConfig).not.toHaveBeenCalled();

    typeInput(tree, "Fatigue Scaling Multiplier Input", "0.85");
    tree = render(props);
    press(tree, SAVE_BTN);
    await new Promise((r) => setTimeout(r, 0));
    expect(props.onSaveConfig).toHaveBeenCalledTimes(1);
  });

  it("ignores stale async PIN resolution if modal closes before SecureKeyStore responds", async () => {
    let resolveDeferred: ((val: string | null) => void) | null = null;
    const deferredStore: SecureKeyStore = {
      getItem: () =>
        new Promise<string | null>((resolve) => {
          resolveDeferred = resolve;
        }),
      setItem: async () => undefined
    };

    const propsOpen = baseProps({ pinKeyStore: deferredStore, visible: true });
    let tree = render(propsOpen);
    expect(hasText(tree, "Checking Governance PIN")).toBe(true);
    await flushMicrotasks();
    expect(resolveDeferred).not.toBeNull();

    // Close modal while getItem is still pending
    tree = render(baseProps({ pinKeyStore: deferredStore, visible: false }));
    expect(tree).toBeNull();
    harness.dirty = false;

    // Resolve stale read and confirm it does not trigger any state update
    resolveDeferred!("482910");
    await flushMicrotasks();
    expect(harness.dirty).toBe(false);
  });

  it("always renders the L2 inspector section in loading, setup, and unlock states", async () => {
    const loadingTree = render(baseProps());
    expect(hasText(loadingTree, "Inspector")).toBe(true);

    const setupTree = await renderSettled(baseProps());
    expect(hasText(setupTree, "Inspector")).toBe(true);

    await setGovernancePin("482910", activeKeyStore);
    const unlockTree = await renderSettled(baseProps());
    expect(hasText(unlockTree, "Inspector")).toBe(true);
  });
});
