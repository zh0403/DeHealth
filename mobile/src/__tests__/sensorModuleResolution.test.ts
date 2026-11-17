import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises the production resolution path that setPedometerAdapterForTesting
 * bypasses: the dynamic `import("expo-sensors")` and the structural guard that
 * decides whether the module's `Pedometer` export is trusted.
 */
const expoSensorsMock = vi.hoisted(() => ({
  Pedometer: undefined as unknown
}));

vi.mock("expo-sensors", () => ({
  get Pedometer(): unknown {
    return expoSensorsMock.Pedometer;
  }
}));

import {
  getTodayStepCount,
  isPedometerAvailable,
  PedometerAdapter,
  resetPedometerAdapterForTesting
} from "../services/sensorService";

function makeAdapter(overrides: Partial<PedometerAdapter> = {}): PedometerAdapter {
  return {
    isAvailableAsync: vi.fn().mockResolvedValue(true),
    getStepCountAsync: vi.fn().mockResolvedValue({ steps: 6123 }),
    ...overrides
  };
}

describe("sensorService: real expo-sensors module resolution", () => {
  beforeEach(() => {
    resetPedometerAdapterForTesting();
    expoSensorsMock.Pedometer = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPedometerAdapterForTesting();
  });

  it("trusts and uses a well-formed Pedometer export from the module", async () => {
    const adapter = makeAdapter();
    expoSensorsMock.Pedometer = adapter;

    expect(await isPedometerAvailable()).toBe(true);
    expect(await getTodayStepCount(0)).toEqual({ steps: 6123, source: "hardware" });
    expect(adapter.getStepCountAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects a module whose Pedometer export is missing", async () => {
    expoSensorsMock.Pedometer = undefined;

    expect(await isPedometerAvailable()).toBe(false);
    expect(await getTodayStepCount(900)).toEqual({ steps: 900, source: "manual-fallback" });
  });

  it("rejects malformed Pedometer exports instead of calling them", async () => {
    const malformed: unknown[] = [
      null,
      "pedometer",
      42,
      {},
      { isAvailableAsync: () => true },
      { getStepCountAsync: () => ({ steps: 1 }) },
      { isAvailableAsync: "yes", getStepCountAsync: "no" }
    ];

    for (const candidate of malformed) {
      expoSensorsMock.Pedometer = candidate;
      expect(await isPedometerAvailable()).toBe(false);
      expect(await getTodayStepCount(250)).toEqual({
        steps: 250,
        source: "manual-fallback"
      });
    }
  });

  it("falls back when the resolved Pedometer reports the sensor as unavailable", async () => {
    const adapter = makeAdapter({ isAvailableAsync: vi.fn().mockResolvedValue(false) });
    expoSensorsMock.Pedometer = adapter;

    expect(await getTodayStepCount(777)).toEqual({ steps: 777, source: "manual-fallback" });
    expect(adapter.getStepCountAsync).not.toHaveBeenCalled();
  });

  it("treats a null or undefined permission response as not granted", async () => {
    for (const response of [null, undefined]) {
      const adapter = makeAdapter({
        getPermissionsAsync: vi.fn().mockResolvedValue(response),
        requestPermissionsAsync: vi.fn().mockResolvedValue(response)
      });
      expoSensorsMock.Pedometer = adapter;

      expect(await getTodayStepCount(31)).toEqual({ steps: 31, source: "manual-fallback" });
      expect(adapter.getStepCountAsync).not.toHaveBeenCalled();
    }
  });

  it("never reads steps when permission is missing and cannot be requested", async () => {
    const adapter = makeAdapter({
      getPermissionsAsync: vi.fn().mockResolvedValue({ granted: false })
    });
    expoSensorsMock.Pedometer = adapter;

    expect(await getTodayStepCount(12)).toEqual({ steps: 12, source: "manual-fallback" });
    expect(adapter.getStepCountAsync).not.toHaveBeenCalled();
  });

  it("falls back when the dynamic import of expo-sensors itself throws", async () => {
    vi.resetModules();
    vi.doMock("expo-sensors", () => {
      throw new Error("native module not linked");
    });
    const fresh = await import("../services/sensorService");
    fresh.resetPedometerAdapterForTesting();

    expect(await fresh.isPedometerAvailable()).toBe(false);
    expect(await fresh.getTodayStepCount(64)).toEqual({
      steps: 64,
      source: "manual-fallback"
    });

    vi.doUnmock("expo-sensors");
    vi.resetModules();
  });
});
