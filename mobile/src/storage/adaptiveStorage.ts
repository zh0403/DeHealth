import {
  AdaptivePlanCycle,
  AdaptivePlanCycleSchema,
  Bytes32,
  Bytes32Schema,
  UserBiometrics,
  UserBiometricsSchema,
  WeightLogEntry,
  WeightLogEntrySchema
} from "@dehealth/shared";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "./encryptedStorageAdapter";
import {
  createPlatformKeyStore,
  provisionVaultSecret,
  SecureKeyStore,
  VaultKeyUnavailableError
} from "./vaultKeyProvider";

export const ADAPTIVE_STORAGE_KEYS = {
  USER_BIOMETRICS: "@dehealth/user_biometrics",
  ACTIVE_PLAN_CYCLE: "@dehealth/active_plan_cycle",
  WEIGHT_LOGS: "@dehealth/weight_logs",
  PLAN_HISTORY: "@dehealth/plan_history",
  DAILY_COMPLETION_STATE: "@dehealth/daily_completion_state",
  TELEMETRY_SALTS: "@dehealth/telemetry_salts"
} as const;

export const STORAGE_KEYS = ADAPTIVE_STORAGE_KEYS;

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

  /**
   * A vault secret is mandatory. There is deliberately no default: the secret
   * must come from `initializeAdaptiveStorage()` (per-install key) or be
   * supplied explicitly by the caller.
   */
  constructor(
    adapterOrPassphrase: EncryptedStorageAdapter | string,
    backend?: KeyValueStorageBackend
  ) {
    if (adapterOrPassphrase instanceof EncryptedStorageAdapter) {
      this.adapter = adapterOrPassphrase;
    } else if (typeof adapterOrPassphrase === "string") {
      this.adapter = new EncryptedStorageAdapter(adapterOrPassphrase, backend);
    } else {
      throw new VaultKeyUnavailableError(
        "AdaptiveStorage requires a provisioned vault secret."
      );
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
   * Stores the per-claim salt for a published telemetry commitment so the owner
   * can later reveal and verify it. The salt never leaves encrypted storage.
   */
  async saveTelemetrySalt(telemetryHash: Bytes32, salt: Bytes32): Promise<void> {
    const hash = Bytes32Schema.parse(telemetryHash).toLowerCase();
    const validatedSalt = Bytes32Schema.parse(salt);
    const existing = await this.readTelemetrySalts();
    await this.adapter.setEncryptedItem(ADAPTIVE_STORAGE_KEYS.TELEMETRY_SALTS, {
      ...existing,
      [hash]: validatedSalt
    });
  }

  /**
   * Returns the salt recorded for a telemetry commitment, or null if unknown.
   */
  async getTelemetrySalt(telemetryHash: Bytes32): Promise<Bytes32 | null> {
    const hash = Bytes32Schema.parse(telemetryHash).toLowerCase();
    const salts = await this.readTelemetrySalts();
    return salts[hash] ?? null;
  }

  private async readTelemetrySalts(): Promise<Record<string, Bytes32>> {
    const raw = await this.adapter.getEncryptedItem<unknown>(
      ADAPTIVE_STORAGE_KEYS.TELEMETRY_SALTS
    );
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    const result: Record<string, Bytes32> = {};
    for (const [key, value] of Object.entries(raw)) {
      const parsed = Bytes32Schema.safeParse(value);
      if (parsed.success) {
        result[key] = parsed.data;
      }
    }
    return result;
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

// ---------------------------------------------------------------------------
// Process-wide storage instance.
//
// There is no default instance. It exists only after a per-install vault secret
// has been provisioned (or an instance is injected explicitly). Every
// convenience function below awaits provisioning, so no code path can read or
// write the vault with a missing or source-embedded key.
// ---------------------------------------------------------------------------
let defaultAdaptiveStorage: AdaptiveStorage | null = null;
let initializationPromise: Promise<AdaptiveStorage> | null = null;

/**
 * Provisions the per-install vault secret (generating it on first launch) and
 * opens the process-wide AdaptiveStorage. Idempotent and safe to call
 * concurrently. Rejects, and stays uninitialized, if no valid secret exists.
 */
export function initializeAdaptiveStorage(
  keyStore?: SecureKeyStore,
  backend?: KeyValueStorageBackend
): Promise<AdaptiveStorage> {
  if (defaultAdaptiveStorage) {
    return Promise.resolve(defaultAdaptiveStorage);
  }
  if (initializationPromise) {
    return initializationPromise;
  }

  const pending = (async (): Promise<AdaptiveStorage> => {
    const store = keyStore ?? (await createPlatformKeyStore());
    const secret = await provisionVaultSecret(store);
    const storage = new AdaptiveStorage(secret, backend);
    defaultAdaptiveStorage = storage;
    return storage;
  })();

  initializationPromise = pending;
  pending.catch(() => {
    if (initializationPromise === pending) {
      initializationPromise = null;
    }
  });
  return pending;
}

/**
 * Synchronous accessor. Throws unless storage has been initialized.
 */
export function getAdaptiveStorage(): AdaptiveStorage {
  if (!defaultAdaptiveStorage) {
    throw new VaultKeyUnavailableError(
      "AdaptiveStorage is not initialized; call initializeAdaptiveStorage() first."
    );
  }
  return defaultAdaptiveStorage;
}

export function setAdaptiveStorage(storage: AdaptiveStorage): void {
  defaultAdaptiveStorage = storage;
  initializationPromise = null;
}

export function setAdaptiveStorageAdapter(adapter: EncryptedStorageAdapter): void {
  setAdaptiveStorage(new AdaptiveStorage(adapter));
}

/**
 * Drops the process-wide instance so the next use must provision a secret again.
 */
export function resetAdaptiveStorage(): void {
  defaultAdaptiveStorage = null;
  initializationPromise = null;
}

async function resolveStorage(): Promise<AdaptiveStorage> {
  return defaultAdaptiveStorage ?? initializeAdaptiveStorage();
}

// Standalone convenience functions bound to the process-wide instance
export async function saveUserBiometrics(biometrics: UserBiometrics): Promise<void> {
  return (await resolveStorage()).saveUserBiometrics(biometrics);
}

export async function getUserBiometrics(): Promise<UserBiometrics | null> {
  return (await resolveStorage()).getUserBiometrics();
}

export async function saveActivePlanCycle(cycle: AdaptivePlanCycle): Promise<void> {
  return (await resolveStorage()).saveActivePlanCycle(cycle);
}

export async function getActivePlanCycle(): Promise<AdaptivePlanCycle | null> {
  return (await resolveStorage()).getActivePlanCycle();
}

export async function saveWeightLog(entry: WeightLogEntry): Promise<void> {
  return (await resolveStorage()).saveWeightLog(entry);
}

export async function getWeightLogs(): Promise<WeightLogEntry[]> {
  return (await resolveStorage()).getWeightLogs();
}

export async function saveDailyTaskCompletion(
  dayNumber: number,
  task: string,
  completed: boolean
): Promise<void> {
  return (await resolveStorage()).saveDailyTaskCompletion(dayNumber, task, completed);
}

export async function getDailyTaskCompletion(): Promise<Record<string, boolean>> {
  return (await resolveStorage()).getDailyTaskCompletion();
}

export async function clearAllAdaptiveData(): Promise<void> {
  return (await resolveStorage()).clearAllAdaptiveData();
}

export async function getPlanHistory(): Promise<AdaptivePlanCycle[]> {
  return (await resolveStorage()).getPlanHistory();
}

export async function savePlanHistory(history: AdaptivePlanCycle[]): Promise<void> {
  return (await resolveStorage()).savePlanHistory(history);
}

export async function saveTelemetrySalt(
  telemetryHash: Bytes32,
  salt: Bytes32
): Promise<void> {
  return (await resolveStorage()).saveTelemetrySalt(telemetryHash, salt);
}

export async function getTelemetrySalt(telemetryHash: Bytes32): Promise<Bytes32 | null> {
  return (await resolveStorage()).getTelemetrySalt(telemetryHash);
}