import {
  AdaptivePlanCycle,
  AdaptivePlanCycleSchema,
  UserBiometrics,
  UserBiometricsSchema,
  WeightLogEntry,
  WeightLogEntrySchema
} from "@dehealth/shared";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "./encryptedStorageAdapter";

export const ADAPTIVE_STORAGE_KEYS = {
  USER_BIOMETRICS: "@dehealth/user_biometrics",
  ACTIVE_PLAN_CYCLE: "@dehealth/active_plan_cycle",
  WEIGHT_LOGS: "@dehealth/weight_logs",
  PLAN_HISTORY: "@dehealth/plan_history",
  DAILY_COMPLETION_STATE: "@dehealth/daily_completion_state"
} as const;

export const STORAGE_KEYS = ADAPTIVE_STORAGE_KEYS;

const DEFAULT_STORAGE_VAULT_KEY = "DeHealthLocalVaultSecretKey2026!";

/**
 * AdaptiveStorage provides typed, local-only encrypted persistence for all
 * biometric, fitness plan, weight log, and task completion records.
 *
 * 100% Data Sovereignty:
 * Zero raw biometrics leave the device. All data is encrypted via Keccak-256 counter-mode
 * keystream XOR and authenticated with HMAC-SHA256 tampering detection envelopes.
 */
export class AdaptiveStorage {
  private readonly adapter: EncryptedStorageAdapter;

  constructor(
    adapterOrPassphrase?: EncryptedStorageAdapter | string,
    backend?: KeyValueStorageBackend
  ) {
    if (adapterOrPassphrase instanceof EncryptedStorageAdapter) {
      this.adapter = adapterOrPassphrase;
    } else if (typeof adapterOrPassphrase === "string") {
      this.adapter = new EncryptedStorageAdapter(adapterOrPassphrase, backend);
    } else {
      this.adapter = new EncryptedStorageAdapter(DEFAULT_STORAGE_VAULT_KEY, backend);
    }
  }

  getAdapter(): EncryptedStorageAdapter {
    return this.adapter;
  }

  /**
   * Persists user biometrics after runtime Zod schema validation.
   */
  async saveUserBiometrics(biometrics: UserBiometrics): Promise<void> {
    const validated = UserBiometricsSchema.parse(biometrics);
    await this.adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS, validated);
  }

  /**
   * Retrieves encrypted user biometrics. Returns null if not found or if the payload
   * fails Zod validation. Tampering / MAC mismatch throws an error.
   */
  async getUserBiometrics(): Promise<UserBiometrics | null> {
    const raw = await this.adapter.getEncryptedItem<unknown>(
      ADAPTIVE_STORAGE_KEYS.USER_BIOMETRICS
    );
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = UserBiometricsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Persists active 14-day plan cycle.
   */
  async saveActivePlanCycle(cycle: AdaptivePlanCycle): Promise<void> {
    const validated = AdaptivePlanCycleSchema.parse(cycle);
    await this.adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.ACTIVE_PLAN_CYCLE, validated);
  }

  /**
   * Retrieves active plan cycle, returning null if empty or invalid.
   */
  async getActivePlanCycle(): Promise<AdaptivePlanCycle | null> {
    const raw = await this.adapter.getEncryptedItem<unknown>(
      ADAPTIVE_STORAGE_KEYS.ACTIVE_PLAN_CYCLE
    );
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = AdaptivePlanCycleSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Persists a single weight log entry. Upserts if an entry with the same ID exists,
   * sorts all entries chronologically by timestampMs ascending.
   */
  async saveWeightLog(entry: WeightLogEntry): Promise<void> {
    const validated = WeightLogEntrySchema.parse(entry);
    const existing = await this.getWeightLogs();

    const existingIndex = existing.findIndex((item) => item.id === validated.id);
    const updated = [...existing];
    if (existingIndex >= 0) {
      updated[existingIndex] = validated;
    } else {
      updated.push(validated);
    }

    updated.sort((a, b) => a.timestampMs - b.timestampMs);
    await this.adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.WEIGHT_LOGS, updated);
  }

  /**
   * Retrieves all weight logs sorted chronologically ascending. Returns [] if none exist.
   */
  async getWeightLogs(): Promise<WeightLogEntry[]> {
    const raw = await this.adapter.getEncryptedItem<unknown>(
      ADAPTIVE_STORAGE_KEYS.WEIGHT_LOGS
    );
    if (!Array.isArray(raw)) {
      return [];
    }

    const validEntries: WeightLogEntry[] = [];
    for (const item of raw) {
      const parsed = WeightLogEntrySchema.safeParse(item);
      if (parsed.success) {
        validEntries.push(parsed.data);
      }
    }

    return validEntries.sort((a, b) => a.timestampMs - b.timestampMs);
  }

  /**
   * Persists completion state for a given day and task name.
   */
  async saveDailyTaskCompletion(
    dayNumber: number,
    task: string,
    completed: boolean
  ): Promise<void> {
    const existing = await this.getDailyTaskCompletion();
    const compositeKey = `${dayNumber}_${task}`;
    const updated: Record<string, boolean> = {
      ...existing,
      [compositeKey]: completed
    };

    if (task.startsWith("day-") || task.includes("-")) {
      updated[task] = completed;
    }

    await this.adapter.setEncryptedItem(
      ADAPTIVE_STORAGE_KEYS.DAILY_COMPLETION_STATE,
      updated
    );
  }

  /**
   * Retrieves daily task completion records. Returns {} if none exist.
   */
  async getDailyTaskCompletion(): Promise<Record<string, boolean>> {
    const raw = await this.adapter.getEncryptedItem<unknown>(
      ADAPTIVE_STORAGE_KEYS.DAILY_COMPLETION_STATE
    );
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    return raw as Record<string, boolean>;
  }

  /**
   * Retrieves plan history of previous cycles.
   */
  async getPlanHistory(): Promise<AdaptivePlanCycle[]> {
    const raw = await this.adapter.getEncryptedItem<unknown>(
      ADAPTIVE_STORAGE_KEYS.PLAN_HISTORY
    );
    if (!Array.isArray(raw)) {
      return [];
    }

    const validHistory: AdaptivePlanCycle[] = [];
    for (const item of raw) {
      const parsed = AdaptivePlanCycleSchema.safeParse(item);
      if (parsed.success) {
        validHistory.push(parsed.data);
      }
    }
    return validHistory;
  }

  /**
   * Saves plan history array.
   */
  async savePlanHistory(history: AdaptivePlanCycle[]): Promise<void> {
    const validated = history.map((c) => AdaptivePlanCycleSchema.parse(c));
    await this.adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.PLAN_HISTORY, validated);
  }

  /**
   * Completely removes all adaptive storage keys, resetting local state.
   */
  async clearAllAdaptiveData(): Promise<void> {
    const allKeys = Object.values(ADAPTIVE_STORAGE_KEYS);
    for (const key of allKeys) {
      await this.adapter.removeEncryptedItem(key);
    }
  }
}

// Global default singleton instance
let defaultAdaptiveStorage: AdaptiveStorage = new AdaptiveStorage();

export function getAdaptiveStorage(): AdaptiveStorage {
  return defaultAdaptiveStorage;
}

export function setAdaptiveStorage(storage: AdaptiveStorage): void {
  defaultAdaptiveStorage = storage;
}

export function setAdaptiveStorageAdapter(adapter: EncryptedStorageAdapter): void {
  defaultAdaptiveStorage = new AdaptiveStorage(adapter);
}

// Standalone convenience functions bound to the global singleton
export async function saveUserBiometrics(biometrics: UserBiometrics): Promise<void> {
  return getAdaptiveStorage().saveUserBiometrics(biometrics);
}

export async function getUserBiometrics(): Promise<UserBiometrics | null> {
  return getAdaptiveStorage().getUserBiometrics();
}

export async function saveActivePlanCycle(cycle: AdaptivePlanCycle): Promise<void> {
  return getAdaptiveStorage().saveActivePlanCycle(cycle);
}

export async function getActivePlanCycle(): Promise<AdaptivePlanCycle | null> {
  return getAdaptiveStorage().getActivePlanCycle();
}

export async function saveWeightLog(entry: WeightLogEntry): Promise<void> {
  return getAdaptiveStorage().saveWeightLog(entry);
}

export async function getWeightLogs(): Promise<WeightLogEntry[]> {
  return getAdaptiveStorage().getWeightLogs();
}

export async function saveDailyTaskCompletion(
  dayNumber: number,
  task: string,
  completed: boolean
): Promise<void> {
  return getAdaptiveStorage().saveDailyTaskCompletion(dayNumber, task, completed);
}

export async function getDailyTaskCompletion(): Promise<Record<string, boolean>> {
  return getAdaptiveStorage().getDailyTaskCompletion();
}

export async function clearAllAdaptiveData(): Promise<void> {
  return getAdaptiveStorage().clearAllAdaptiveData();
}

export async function getPlanHistory(): Promise<AdaptivePlanCycle[]> {
  return getAdaptiveStorage().getPlanHistory();
}

export async function savePlanHistory(history: AdaptivePlanCycle[]): Promise<void> {
  return getAdaptiveStorage().savePlanHistory(history);
}
