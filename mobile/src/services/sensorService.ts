export type StepSource = "hardware" | "manual-fallback";
export type StepCountSource = StepSource;

export interface TodayStepCountResult {
  readonly steps: number;
  readonly source: StepSource;
}

export interface PedometerPermissionResponse {
  readonly status?: string;
  readonly granted?: boolean;
}

export interface PedometerAdapter {
  isAvailableAsync(): Promise<boolean>;
  getStepCountAsync(start: Date, end: Date): Promise<{ readonly steps: number }>;
  getPermissionsAsync?: () => Promise<PedometerPermissionResponse>;
  requestPermissionsAsync?: () => Promise<PedometerPermissionResponse>;
}

let customPedometerAdapter: PedometerAdapter | null | undefined = undefined;

/**
 * Injects a custom PedometerAdapter for deterministic unit testing (pass null
 * to simulate unavailable hardware or undefined to restore dynamic loading).
 */
export function setPedometerAdapterForTesting(
  adapter: PedometerAdapter | null | undefined
): void {
  customPedometerAdapter = adapter;
}

/**
 * Restores default dynamic `expo-sensors` loading behavior.
 */
export function resetPedometerAdapterForTesting(): void {
  customPedometerAdapter = undefined;
}

function isPedometerAdapterLike(candidate: unknown): candidate is PedometerAdapter {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    typeof record.isAvailableAsync === "function" &&
    typeof record.getStepCountAsync === "function"
  );
}

async function resolvePedometerAdapter(): Promise<PedometerAdapter | null> {
  if (customPedometerAdapter !== undefined) {
    return customPedometerAdapter;
  }

  try {
    const mod = (await import("expo-sensors")) as { Pedometer?: unknown };
    if (isPedometerAdapterLike(mod.Pedometer)) {
      return mod.Pedometer;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeFallbackSteps(fallbackSteps?: number): number {
  if (
    typeof fallbackSteps === "number" &&
    Number.isFinite(fallbackSteps) &&
    fallbackSteps > 0
  ) {
    return Math.round(fallbackSteps);
  }
  return 0;
}

function isPermissionGranted(
  response: PedometerPermissionResponse | null | undefined
): boolean {
  if (!response) {
    return false;
  }
  if (typeof response.granted === "boolean") {
    return response.granted;
  }
  return response.status === "granted";
}

/**
 * Safely checks whether hardware step counting (`Pedometer.isAvailableAsync`)
 * is supported and enabled in the current environment. Returns `false` on web,
 * Node, CI, or unsupported devices without throwing.
 */
export async function isPedometerAvailable(): Promise<boolean> {
  const adapter = await resolvePedometerAdapter();
  if (!adapter) {
    return false;
  }
  try {
    return Boolean(await adapter.isAvailableAsync());
  } catch {
    return false;
  }
}

/**
 * Fetches today's local step count (midnight local time through now) from the
 * device hardware pedometer when available and permitted, falling back cleanly
 * to `manual-fallback` on web, CI, permission denial, or sensor errors.
 *
 * Raw step counts remain strictly on-device.
 */
export async function getTodayStepCount(
  fallbackSteps: number = 0
): Promise<TodayStepCountResult> {
  const safeFallback = normalizeFallbackSteps(fallbackSteps);
  const adapter = await resolvePedometerAdapter();
  if (!adapter) {
    return { steps: safeFallback, source: "manual-fallback" };
  }

  try {
    const available = await adapter.isAvailableAsync();
    if (!available) {
      return { steps: safeFallback, source: "manual-fallback" };
    }

    if (typeof adapter.getPermissionsAsync === "function") {
      const currentPerm = await adapter.getPermissionsAsync();
      if (!isPermissionGranted(currentPerm)) {
        if (typeof adapter.requestPermissionsAsync !== "function") {
          return { steps: safeFallback, source: "manual-fallback" };
        }
        const requestedPerm = await adapter.requestPermissionsAsync();
        if (!isPermissionGranted(requestedPerm)) {
          return { steps: safeFallback, source: "manual-fallback" };
        }
      }
    } else if (typeof adapter.requestPermissionsAsync === "function") {
      const requestedPerm = await adapter.requestPermissionsAsync();
      if (!isPermissionGranted(requestedPerm)) {
        return { steps: safeFallback, source: "manual-fallback" };
      }
    }

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0
    );

    const reading = await adapter.getStepCountAsync(startOfToday, now);
    if (
      typeof reading?.steps !== "number" ||
      !Number.isFinite(reading.steps) ||
      reading.steps < 0
    ) {
      return { steps: safeFallback, source: "manual-fallback" };
    }

    const roundedSteps = Math.round(reading.steps);
    return {
      steps: roundedSteps === 0 ? 0 : roundedSteps,
      source: "hardware"
    };
  } catch {
    return { steps: safeFallback, source: "manual-fallback" };
  }
}
