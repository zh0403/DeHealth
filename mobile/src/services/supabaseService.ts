import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  AnonymizedFeedInsertSchema,
  AnonymizedFeedRecord,
  Bytes32,
  PeerCheerInsertSchema
} from "@dehealth/shared";
import { randomBytes } from "ethers";
import { z } from "zod";

export type AnonymizedFeedInsert = z.infer<typeof AnonymizedFeedInsertSchema>;
export type PeerCheerInsert = z.infer<typeof PeerCheerInsertSchema>;

export type ServiceMode = "live" | "local-fallback";

export interface FeedFetchResult {
  readonly items: readonly AnonymizedFeedRecord[];
  readonly cheerCounts: Readonly<Record<string, number>>;
  readonly mode: ServiceMode;
}

export interface PublishMilestoneResult {
  readonly data: AnonymizedFeedRecord;
  readonly mode: ServiceMode;
}

export interface SendCheerResult {
  readonly success: boolean;
  readonly mode: ServiceMode;
}

/**
 * Prohibited biometric keys list to strictly prevent data sovereignty violations.
 * Raw physiological metrics must never leave the device or be sent to any remote database.
 */
export const PROHIBITED_BIOMETRIC_KEYS = [
  "stepCount",
  "caloriesBurnedKcal",
  "avgHeartRateBpm",
  "maxHeartRateBpm",
  "restingHeartRateBpm",
  "vo2MaxMlKgMin",
  "weightKg",
  "heartRateVariabilityRmssd",
  "profileSnapshot",
  "biometrics",
  "rawBiometrics",
  "age",
  "gender",
  "heightCm",
  "currentWeightKg",
  "targetWeightKg",
  "activityLevel",
  "fitnessGoal",
  "dailyCalorieTarget",
  "dailyStepTarget",
  "sleepHours",
  "bodyFatPct",
  "muscleMassKg",
  "activeMinutes",
  "weeklyWorkoutFrequency",
  "goal",
  "loggedCaloriesKcal",
  "loggedProteinGrams",
  "loggedCarbsGrams",
  "loggedFatGrams",
  "targetCaloriesKcal",
  "targetProteinGrams",
  "targetCarbsGrams",
  "targetFatGrams",
  "baselineBiometrics",
  "dailyPlans",
  "exercises",
  "heartRate",
  "heartRateBpm",
  "caloriesKcal",
  "bmi"
] as const;

export const MAX_RECURSION_DEPTH = 20;

export class DataSovereigntyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataSovereigntyViolationError";
  }
}

function normalizeBiometricKey(key: string): string {
  return key.replace(/[\s_-]+/g, "").toLowerCase();
}

const NORMALIZED_PROHIBITED_BIOMETRIC_KEYS: ReadonlySet<string> = new Set(
  PROHIBITED_BIOMETRIC_KEYS.map((key) => normalizeBiometricKey(key))
);

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inspectForRawBiometrics(
  value: unknown,
  visited: WeakSet<object>,
  depth: number = 0
): void {
  if (!isObjectLike(value)) {
    return;
  }
  if (visited.has(value)) {
    return;
  }
  if (depth > MAX_RECURSION_DEPTH) {
    throw new DataSovereigntyViolationError(
      `Data sovereignty violation: payload nesting exceeds maximum depth of ${MAX_RECURSION_DEPTH}.`
    );
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      inspectForRawBiometrics(item, visited, depth + 1);
    }
    return;
  }

  if (value instanceof Set) {
    for (const item of value) {
      inspectForRawBiometrics(item, visited, depth + 1);
    }
    return;
  }

  if (value instanceof Map) {
    for (const [mapKey, mapValue] of value.entries()) {
      if (
        typeof mapKey === "string" &&
        mapValue !== undefined &&
        NORMALIZED_PROHIBITED_BIOMETRIC_KEYS.has(normalizeBiometricKey(mapKey))
      ) {
        throw new DataSovereigntyViolationError(
          `Data sovereignty violation: raw biometric key "${mapKey}" detected in feed payload. Zero raw biometrics may leave the device.`
        );
      }
      inspectForRawBiometrics(mapKey, visited, depth + 1);
      inspectForRawBiometrics(mapValue, visited, depth + 1);
    }
    return;
  }

  for (const [key, propValue] of Object.entries(value)) {
    if (
      propValue !== undefined &&
      NORMALIZED_PROHIBITED_BIOMETRIC_KEYS.has(normalizeBiometricKey(key))
    ) {
      throw new DataSovereigntyViolationError(
        `Data sovereignty violation: raw biometric key "${key}" detected in feed payload. Zero raw biometrics may leave the device.`
      );
    }
    inspectForRawBiometrics(propValue, visited, depth + 1);
  }
}

/**
 * Asserts that the incoming payload contains zero raw biometrics or profile data
 * at any nesting depth (objects, arrays, Sets, Maps) regardless of key casing or
 * snake/kebab formatting.
 * Throws DataSovereigntyViolationError if any raw biometrics are detected.
 */
export function assertZeroRawBiometrics(payload: unknown): void {
  inspectForRawBiometrics(payload, new WeakSet<object>());
}

/**
 * Generates an RFC-4122 v4 UUID using crypto.randomUUID or cryptographically secure random bytes.
 */
export function generateFallbackUuid(): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // Version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // Variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Default fallback feed items mirroring baseline demo items.
 */
export const DEFAULT_FALLBACK_FEED_ITEMS: readonly AnonymizedFeedRecord[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    user_pseudonym: "zephyr_runner",
    proof_hash:
      "0x8a3f2b1c9d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcd" as Bytes32,
    streak_count: 14,
    created_at: "2026-11-11T08:15:00Z"
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    user_pseudonym: "iron_pulse_42",
    proof_hash:
      "0x4c9e1d2a7b8f03456789abcdef0123456789abcdef0123456789abcdef012345" as Bytes32,
    streak_count: 7,
    created_at: "2026-11-11T06:40:00Z"
  }
];

export const DEFAULT_FALLBACK_CHEER_COUNTS: Readonly<Record<string, number>> = {
  "00000000-0000-4000-8000-000000000001": 12,
  "00000000-0000-4000-8000-000000000002": 5
};

// In-memory fallback state preserving UI responsiveness and real local progression
let localFeedItems: AnonymizedFeedRecord[] = [...DEFAULT_FALLBACK_FEED_ITEMS];
let localCheerCounts: Record<string, number> = { ...DEFAULT_FALLBACK_CHEER_COUNTS };

/**
 * Resets local in-memory feed store to defaults.
 */
export function resetLocalFeedStore(): void {
  localFeedItems = [...DEFAULT_FALLBACK_FEED_ITEMS];
  localCheerCounts = { ...DEFAULT_FALLBACK_CHEER_COUNTS };
}

/**
 * Seeds local in-memory feed store with custom records and cheer counts.
 */
export function seedLocalFeedStore(
  items: readonly AnonymizedFeedRecord[],
  cheerCounts?: Readonly<Record<string, number>>
): void {
  localFeedItems = [...items];
  localCheerCounts = cheerCounts ? { ...cheerCounts } : {};
}

/**
 * Gets local fallback feed items sliced to limit.
 */
export function getLocalFallbackFeedItems(limit?: number): AnonymizedFeedRecord[] {
  const count = typeof limit === "number" && limit > 0 ? limit : localFeedItems.length;
  return localFeedItems.slice(0, count);
}

/**
 * Gets local fallback cheer counts map.
 */
export function getLocalFallbackCheerCounts(): Record<string, number> {
  return { ...localCheerCounts };
}

/**
 * Records a validated feed item in local in-memory store.
 */
export function recordLocalFeedItem(item: AnonymizedFeedInsert): AnonymizedFeedRecord {
  const newRecord: AnonymizedFeedRecord = {
    id: generateFallbackUuid(),
    user_pseudonym: item.user_pseudonym,
    proof_hash: item.proof_hash as Bytes32,
    streak_count: item.streak_count,
    created_at: new Date().toISOString()
  };
  localFeedItems.unshift(newRecord);
  localCheerCounts[newRecord.id] = 0;
  return newRecord;
}

/**
 * Records a cheer for a feed item in local in-memory store.
 */
export function recordLocalCheer(feedId: string): void {
  const current = localCheerCounts[feedId] ?? 0;
  localCheerCounts[feedId] = current + 1;
}

// Supabase client instance management
let customClient: SupabaseClient | null | undefined = undefined;
let cachedClient: SupabaseClient | null = null;
let cachedUrl: string | undefined = undefined;
let cachedKey: string | undefined = undefined;

/**
 * Explicitly sets or clears a custom Supabase client (primarily for testing and mock injection).
 */
export function setSupabaseClient(client: SupabaseClient | null | undefined): void {
  customClient = client;
}

/**
 * Returns whether Supabase cloud service is configured with valid environment variables.
 */
export function isSupabaseConfigured(): boolean {
  return getSupabaseClient() !== null;
}

/**
 * Resolves or creates a Supabase client instance.
 * Returns null if EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY are missing or empty.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (customClient !== undefined) {
    return customClient;
  }

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) {
    cachedClient = null;
    cachedUrl = undefined;
    cachedKey = undefined;
    return null;
  }

  if (cachedClient && cachedUrl === url && cachedKey === anonKey) {
    return cachedClient;
  }

  try {
    cachedClient = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    cachedUrl = url;
    cachedKey = anonKey;
    return cachedClient;
  } catch {
    cachedClient = null;
    return null;
  }
}

/**
 * Fetches anonymized feed items ordered by created_at desc with joined peer_cheers counts.
 * Automatically falls back to local fallback store if Supabase is unconfigured or network is offline.
 */
export async function fetchAnonymizedFeed(
  limit: number = 20
): Promise<{
  items: AnonymizedFeedRecord[];
  cheerCounts: Record<string, number>;
  mode: ServiceMode;
}> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      items: getLocalFallbackFeedItems(limit),
      cheerCounts: getLocalFallbackCheerCounts(),
      mode: "local-fallback"
    };
  }

  try {
    const { data, error } = await client
      .from("anonymized_feed")
      .select("id, user_pseudonym, proof_hash, streak_count, created_at, peer_cheers(id)")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) {
      return {
        items: getLocalFallbackFeedItems(limit),
        cheerCounts: getLocalFallbackCheerCounts(),
        mode: "local-fallback"
      };
    }

    const items: AnonymizedFeedRecord[] = [];
    const cheerCounts: Record<string, number> = {};

    for (const row of data as Array<{
      id: string;
      user_pseudonym: string;
      proof_hash: string;
      streak_count: number;
      created_at: string;
      peer_cheers?: Array<{ id: string }> | null;
    }>) {
      items.push({
        id: row.id,
        user_pseudonym: row.user_pseudonym,
        proof_hash: row.proof_hash as Bytes32,
        streak_count: row.streak_count,
        created_at: row.created_at
      });
      cheerCounts[row.id] = Array.isArray(row.peer_cheers) ? row.peer_cheers.length : 0;
    }

    return {
      items,
      cheerCounts,
      mode: "live"
    };
  } catch {
    return {
      items: getLocalFallbackFeedItems(limit),
      cheerCounts: getLocalFallbackCheerCounts(),
      mode: "local-fallback"
    };
  }
}

/**
 * Publishes an anonymized proof milestone to Supabase anonymized_feed.
 * Validates with AnonymizedFeedInsertSchema and enforces zero raw biometric leakage.
 * Automatically falls back to local fallback store if Supabase is unconfigured or network is offline.
 */
export async function publishProofMilestone(
  payload: AnonymizedFeedInsert
): Promise<{
  data: AnonymizedFeedRecord;
  mode: ServiceMode;
}> {
  assertZeroRawBiometrics(payload);
  const validated = AnonymizedFeedInsertSchema.parse(payload);

  const client = getSupabaseClient();
  if (!client) {
    const localRecord = recordLocalFeedItem(validated);
    return {
      data: localRecord,
      mode: "local-fallback"
    };
  }

  try {
    const { data, error } = await client
      .from("anonymized_feed")
      .insert({
        user_pseudonym: validated.user_pseudonym,
        proof_hash: validated.proof_hash,
        streak_count: validated.streak_count
      })
      .select("id, user_pseudonym, proof_hash, streak_count, created_at")
      .single();

    if (error || !data) {
      const localRecord = recordLocalFeedItem(validated);
      return {
        data: localRecord,
        mode: "local-fallback"
      };
    }

    const liveRecord: AnonymizedFeedRecord = {
      id: data.id,
      user_pseudonym: data.user_pseudonym,
      proof_hash: data.proof_hash as Bytes32,
      streak_count: data.streak_count,
      created_at: data.created_at
    };

    // Keep local cache populated for offline continuity
    localFeedItems.unshift(liveRecord);
    localCheerCounts[liveRecord.id] = 0;

    return {
      data: liveRecord,
      mode: "live"
    };
  } catch {
    const localRecord = recordLocalFeedItem(validated);
    return {
      data: localRecord,
      mode: "local-fallback"
    };
  }
}

/**
 * Sends a peer cheer for a feed milestone in Supabase peer_cheers.
 * Validates with PeerCheerInsertSchema.
 * Automatically falls back to local fallback store if Supabase is unconfigured or network is offline.
 */
export async function sendPeerCheer(
  feedId: string,
  senderPseudonym: string
): Promise<{
  success: boolean;
  mode: ServiceMode;
}> {
  PeerCheerInsertSchema.parse({
    feed_id: feedId,
    sender_pseudonym: senderPseudonym
  });

  const client = getSupabaseClient();
  if (!client) {
    recordLocalCheer(feedId);
    return {
      success: true,
      mode: "local-fallback"
    };
  }

  try {
    const { error } = await client
      .from("peer_cheers")
      .insert({
        feed_id: feedId,
        sender_pseudonym: senderPseudonym
      })
      .select("id, feed_id, sender_pseudonym, created_at")
      .single();

    if (error) {
      recordLocalCheer(feedId);
      return {
        success: true,
        mode: "local-fallback"
      };
    }

    recordLocalCheer(feedId);
    return {
      success: true,
      mode: "live"
    };
  } catch {
    recordLocalCheer(feedId);
    return {
      success: true,
      mode: "local-fallback"
    };
  }
}
