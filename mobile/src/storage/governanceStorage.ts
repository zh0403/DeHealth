import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
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

export const GOVERNANCE_STORAGE_KEY = "@dehealth/governance_config";

export const MIN_INACTIVITY_THRESHOLD_HOURS = 24;
export const MAX_INACTIVITY_THRESHOLD_HOURS = 168;
export const DEFAULT_INACTIVITY_THRESHOLD_HOURS = 48;

export const MIN_FATIGUE_SCALING_MULTIPLIER = 0.5;
export const MAX_FATIGUE_SCALING_MULTIPLIER = 0.95;
export const DEFAULT_FATIGUE_SCALING_MULTIPLIER = 0.7;

export const MIN_DAILY_STEP_GOAL = 1000;
export const MAX_DAILY_STEP_GOAL = 30_000;
export const DEFAULT_DAILY_STEP_GOAL = 5000;

export interface GovernanceConfig {
  readonly inactivityThresholdHours: number;
  readonly fatigueScalingMultiplier: number;
  readonly dailyStepGoal: number;
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = Object.freeze({
  inactivityThresholdHours: DEFAULT_INACTIVITY_THRESHOLD_HOURS,
  fatigueScalingMultiplier: DEFAULT_FATIGUE_SCALING_MULTIPLIER,
  dailyStepGoal: DEFAULT_DAILY_STEP_GOAL
});

export const GovernanceConfigSchema: z.ZodType<GovernanceConfig> = z.object({
  inactivityThresholdHours: z
    .number()
    .int("Inactivity threshold must be a whole number of hours (24-168).")
    .min(
      MIN_INACTIVITY_THRESHOLD_HOURS,
      "Inactivity threshold must be at least 24 hours."
    )
    .max(
      MAX_INACTIVITY_THRESHOLD_HOURS,
      "Inactivity threshold cannot exceed 168 hours."
    ),
  fatigueScalingMultiplier: z
    .number()
    .finite("Fatigue scaling multiplier must be a finite number.")
    .min(
      MIN_FATIGUE_SCALING_MULTIPLIER,
      "Fatigue scaling multiplier must be at least 0.50."
    )
    .max(
      MAX_FATIGUE_SCALING_MULTIPLIER,
      "Fatigue scaling multiplier cannot exceed 0.95."
    ),
  dailyStepGoal: z
    .number()
    .int("Daily step goal must be a whole number (1000-30000).")
    .min(MIN_DAILY_STEP_GOAL, "Daily step goal must be at least 1,000 steps.")
    .max(MAX_DAILY_STEP_GOAL, "Daily step goal cannot exceed 30,000 steps.")
});

/**
 * GovernanceStorage provides encrypted, schema-validated local persistence
 * for configurable DeHealth adaptive protocol thresholds.
 */
export class GovernanceStorage {
  private readonly adapter: EncryptedStorageAdapter;

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
        "GovernanceStorage requires a provisioned vault secret."
      );
    }
  }

  getAdapter(): EncryptedStorageAdapter {
    return this.adapter;
  }

  /**
   * Retrieves the persisted GovernanceConfig. Returns DEFAULT_GOVERNANCE_CONFIG
   * when unset or when payload fails Zod schema validation; MAC tampering throws.
   */
  async getGovernanceConfig(): Promise<GovernanceConfig> {
    const raw = await this.adapter.getEncryptedItem<unknown>(GOVERNANCE_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return DEFAULT_GOVERNANCE_CONFIG;
    }
    const parsed = GovernanceConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_GOVERNANCE_CONFIG;
  }

  /**
   * Validates and persists GovernanceConfig in encrypted local storage.
   */
  async saveGovernanceConfig(config: GovernanceConfig): Promise<GovernanceConfig> {
    const validated = GovernanceConfigSchema.parse(config);
    await this.adapter.setEncryptedItem(GOVERNANCE_STORAGE_KEY, validated);
    return validated;
  }

  /**
   * Resets persisted governance parameters back to defaults.
   */
  async resetGovernanceConfig(): Promise<GovernanceConfig> {
    await this.adapter.removeEncryptedItem(GOVERNANCE_STORAGE_KEY);
    return DEFAULT_GOVERNANCE_CONFIG;
  }
}

let defaultGovernanceStorage: GovernanceStorage | null = null;
let governanceInitPromise: Promise<GovernanceStorage> | null = null;

/**
 * Initializes the process-wide GovernanceStorage using the device's vault key.
 */
export function initializeGovernanceStorage(
  keyStore?: SecureKeyStore,
  backend?: KeyValueStorageBackend
): Promise<GovernanceStorage> {
  if (defaultGovernanceStorage) {
    return Promise.resolve(defaultGovernanceStorage);
  }
  if (governanceInitPromise) {
    return governanceInitPromise;
  }

  const pending = (async (): Promise<GovernanceStorage> => {
    const store = keyStore ?? (await createPlatformKeyStore());
    const secret = await provisionVaultSecret(store);
    const storage = new GovernanceStorage(secret, backend);
    defaultGovernanceStorage = storage;
    return storage;
  })();

  governanceInitPromise = pending;
  pending.catch(() => {
    if (governanceInitPromise === pending) {
      governanceInitPromise = null;
    }
  });
  return pending;
}

export function getGovernanceStorage(): GovernanceStorage {
  if (!defaultGovernanceStorage) {
    throw new VaultKeyUnavailableError(
      "GovernanceStorage is not initialized; call initializeGovernanceStorage() first."
    );
  }
  return defaultGovernanceStorage;
}

export function setGovernanceStorage(storage: GovernanceStorage): void {
  defaultGovernanceStorage = storage;
  governanceInitPromise = null;
}

export function setGovernanceStorageAdapter(adapter: EncryptedStorageAdapter): void {
  setGovernanceStorage(new GovernanceStorage(adapter));
}

export function resetGovernanceStorage(): void {
  defaultGovernanceStorage = null;
  governanceInitPromise = null;
}

async function resolveGovernanceStorage(): Promise<GovernanceStorage> {
  return defaultGovernanceStorage ?? initializeGovernanceStorage();
}

export async function getGovernanceConfig(): Promise<GovernanceConfig> {
  return (await resolveGovernanceStorage()).getGovernanceConfig();
}

export async function saveGovernanceConfig(
  config: GovernanceConfig
): Promise<GovernanceConfig> {
  return (await resolveGovernanceStorage()).saveGovernanceConfig(config);
}

export async function resetGovernanceConfig(): Promise<GovernanceConfig> {
  return (await resolveGovernanceStorage()).resetGovernanceConfig();
}

/**
 * Removes the raw governance storage key from the underlying backend without
 * requiring a valid vault key (used during vault reset recovery).
 */
export async function purgeGovernanceStorageKey(
  backend?: KeyValueStorageBackend
): Promise<void> {
  const targetBackend =
    backend ?? (AsyncStorage as unknown as KeyValueStorageBackend);
  await targetBackend.removeItem(GOVERNANCE_STORAGE_KEY);
  resetGovernanceStorage();
}
