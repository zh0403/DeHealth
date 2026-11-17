import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTodayStepCount,
  isPedometerAvailable,
  PedometerAdapter,
  resetPedometerAdapterForTesting,
  setPedometerAdapterForTesting
} from "../services/sensorService";

describe("Mobile Sensor & Pedometer Telemetry Service", () => {
  beforeEach(() => {
    resetPedometerAdapterForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPedometerAdapterForTesting();
  });

  it("returns false for isPedometerAvailable and manual-fallback when adapter is null (web/CI)", async () => {
    setPedometerAdapterForTesting(null);

    expect(await isPedometerAvailable()).toBe(false);
    expect(await getTodayStepCount()).toEqual({
      steps: 0,
      source: "manual-fallback"
    });
    expect(await getTodayStepCount(4200)).toEqual({
      steps: 4200,
      source: "manual-fallback"
    });
  });

  it("falls back safely in Node/CI when default expo-sensors has no native hardware pedometer", async () => {
    expect(await isPedometerAvailable()).toBe(false);
    const result = await getTodayStepCount(1250);
    expect(result).toEqual({ steps: 1250, source: "manual-fallback" });
  });

  it("queries today's steps from midnight to now when hardware pedometer is available and permitted", async () => {
    let capturedStart: Date | null = null;
    let capturedEnd: Date | null = null;

    const adapter: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      getPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted", granted: true }),
      getStepCountAsync: vi.fn(async (start: Date, end: Date) => {
        capturedStart = start;
        capturedEnd = end;
        return { steps: 6432.6 };
      })
    };

    setPedometerAdapterForTesting(adapter);

    expect(await isPedometerAvailable()).toBe(true);
    const result = await getTodayStepCount(100);
    expect(result).toEqual({ steps: 6433, source: "hardware" });

    expect(capturedStart).not.toBeNull();
    expect(capturedEnd).not.toBeNull();
    expect(capturedStart!.getHours()).toBe(0);
    expect(capturedStart!.getMinutes()).toBe(0);
    expect(capturedStart!.getSeconds()).toBe(0);
    expect(capturedEnd!.getTime()).toBeGreaterThanOrEqual(capturedStart!.getTime());
  });

  it("requests permission when initially undetermined and succeeds if user grants", async () => {
    const requestPermissionsAsync = vi
      .fn()
      .mockResolvedValue({ status: "granted", granted: true });
    const adapter: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      getPermissionsAsync: vi.fn().mockResolvedValue({ status: "undetermined", granted: false }),
      requestPermissionsAsync,
      getStepCountAsync: vi.fn().mockResolvedValue({ steps: 5100 })
    };

    setPedometerAdapterForTesting(adapter);

    const result = await getTodayStepCount(0);
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ steps: 5100, source: "hardware" });
  });

  it("falls back to manual-fallback when permissions are denied", async () => {
    const adapter: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      getPermissionsAsync: vi.fn().mockResolvedValue({ status: "denied", granted: false }),
      requestPermissionsAsync: vi.fn().mockResolvedValue({ status: "denied", granted: false }),
      getStepCountAsync: vi.fn().mockResolvedValue({ steps: 9000 })
    };

    setPedometerAdapterForTesting(adapter);

    const result = await getTodayStepCount(2500);
    expect(result).toEqual({ steps: 2500, source: "manual-fallback" });
    expect(adapter.getStepCountAsync).not.toHaveBeenCalled();
  });

  it("falls back cleanly when isAvailableAsync or getStepCountAsync throws or returns invalid numbers", async () => {
    const throwingAdapter: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockRejectedValue(new Error("CoreMotion unavailable")),
      getStepCountAsync: vi.fn()
    };
    setPedometerAdapterForTesting(throwingAdapter);
    expect(await isPedometerAvailable()).toBe(false);
    expect(await getTodayStepCount(-100)).toEqual({
      steps: 0,
      source: "manual-fallback"
    });

    const invalidReadingAdapter: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      getStepCountAsync: vi.fn().mockResolvedValue({ steps: -15 })
    };
    setPedometerAdapterForTesting(invalidReadingAdapter);
    expect(await getTodayStepCount(3000)).toEqual({
      steps: 3000,
      source: "manual-fallback"
    });
  });

  it("handles adapters with only requestPermissionsAsync, missing requestPermissionsAsync, status-only responses, and getStepCountAsync errors", async () => {
    // 1. Only requestPermissionsAsync (granted via status string)
    const requestOnlyGranted: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      requestPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
      getStepCountAsync: vi.fn().mockResolvedValue({ steps: 4200 })
    };
    setPedometerAdapterForTesting(requestOnlyGranted);
    expect(await getTodayStepCount(0)).toEqual({ steps: 4200, source: "hardware" });

    // 2. Only requestPermissionsAsync (denied)
    const requestOnlyDenied: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      requestPermissionsAsync: vi.fn().mockResolvedValue({ status: "denied" }),
      getStepCountAsync: vi.fn().mockResolvedValue({ steps: 4200 })
    };
    setPedometerAdapterForTesting(requestOnlyDenied);
    expect(await getTodayStepCount(1111)).toEqual({ steps: 1111, source: "manual-fallback" });

    // 3. getPermissionsAsync denied and no requestPermissionsAsync
    const noRequestFn: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      getPermissionsAsync: vi.fn().mockResolvedValue({ status: "denied" }),
      getStepCountAsync: vi.fn().mockResolvedValue({ steps: 4200 })
    };
    setPedometerAdapterForTesting(noRequestFn);
    expect(await getTodayStepCount(2222)).toEqual({ steps: 2222, source: "manual-fallback" });

    // 4. getStepCountAsync throws
    const stepThrow: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      getStepCountAsync: vi.fn().mockRejectedValue(new Error("Sensor read failed"))
    };
    setPedometerAdapterForTesting(stepThrow);
    expect(await getTodayStepCount(3333)).toEqual({ steps: 3333, source: "manual-fallback" });
  });

  it("normalizes -0 hardware step readings to +0", async () => {
    const negZeroAdapter: PedometerAdapter = {
      isAvailableAsync: vi.fn().mockResolvedValue(true),
      getStepCountAsync: vi.fn().mockResolvedValue({ steps: -0 })
    };
    setPedometerAdapterForTesting(negZeroAdapter);

    const result = await getTodayStepCount(100);
    expect(result.source).toBe("hardware");
    expect(Object.is(result.steps, -0)).toBe(false);
    expect(Object.is(result.steps, 0)).toBe(true);
  });
});
