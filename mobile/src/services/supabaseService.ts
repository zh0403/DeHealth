import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  Address,
  AnonymizedFeedInsertSchema,
  AnonymizedFeedRecord,
  Bytes32,
  DUPLICATE_CHEER_ERROR_MESSAGE,
  makePeerCheerDedupKey,
  PeerCheerInsertSchema,
  POSTGRES_UNIQUE_VIOLATION_CODE,
  SignedWorkoutClaimPayload
} from "@dehealth/shared";
import { randomBytes } from "ethers";
import { z } from "zod";
import { verifyWorkoutProofSignature } from "./cryptoService";
import { DEMO_VERIFYING_CONTRACT, getRewardGateAddress } from "./l2ContractService";

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

export class FeedProofVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedProofVerificationError";
  }
}

export class DuplicateCheerError extends Error {
  readonly code: string;
  readonly feedId: string;
  readonly senderPseudonym: string;

  constructor(
    message: string = DUPLICATE_CHEER_ERROR_MESSAGE,
    feedId: string = "",
    senderPseudonym: string = ""
  ) {
    super(message);
    this.name = "DuplicateCheerError";
    this.code = POSTGRES_UNIQUE_VIOLATION_CODE;
    this.feedId = feedId;
    this.senderPseudonym = senderPseudonym;
  }
}

export function isDuplicateCheerError(error: unknown): boolean {
  if (error instanceof DuplicateCheerError) {
    return true;
  }
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return (
    candidate.name === "DuplicateCheerError" ||
    String(candidate.code ?? "") === POSTGRES_UNIQUE_VIOLATION_CODE
  );
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
const seenVerifiedClaimKeys = new Set<string>();
const seenVerifiedProofHashes = new Set<string>();
const cheeredPairKeys = new Set<string>();
const cheeredFeedIdsBySender = new Map<string, Set<string>>();
const inFlightCheerKeys = new Set<string>();

/**
 * Clears in-memory replay/duplicate verification state for verified feed proofs
 * and peer cheer deduplication tracking.
 */
export function resetFeedVerificationStateForTesting(): void {
  seenVerifiedClaimKeys.clear();
  seenVerifiedProofHashes.clear();
  cheeredPairKeys.clear();
  cheeredFeedIdsBySender.clear();
  inFlightCheerKeys.clear();
}

/**
 * Resets local in-memory feed store and proof replay tracking to defaults.
 */
export function resetLocalFeedStore(): void {
  localFeedItems = [...DEFAULT_FALLBACK_FEED_ITEMS];
  localCheerCounts = { ...DEFAULT_FALLBACK_CHEER_COUNTS };
  resetFeedVerificationStateForTesting();
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

/**
 * Normalizes a sender pseudonym by trimming whitespace and lowercasing so
 * deduplication, local tracking, and Supabase queries share a canonical form.
 */
export function normalizeSenderPseudonym(senderPseudonym: string): string {
  return senderPseudonym.trim().toLowerCase();
}

function recordLocalCheeredPair(feedId: string, senderPseudonym: string): void {
  const trimmedFeedId = feedId.trim();
  const normalizedSender = normalizeSenderPseudonym(senderPseudonym);
  if (!trimmedFeedId || !normalizedSender) {
    return;
  }
  cheeredPairKeys.add(makePeerCheerDedupKey(trimmedFeedId, normalizedSender));

  let feedIds = cheeredFeedIdsBySender.get(normalizedSender);
  if (!feedIds) {
    feedIds = new Set<string>();
    cheeredFeedIdsBySender.set(normalizedSender, feedIds);
  }
  feedIds.add(trimmedFeedId);
}

/**
 * Returns whether `senderPseudonym` has already cheered `feedId` locally or
 * synced from Supabase during this session.
 */
export function hasLocalPeerCheered(
  feedId: string,
  senderPseudonym: string
): boolean {
  const trimmedFeedId = feedId.trim();
  const normalizedSender = normalizeSenderPseudonym(senderPseudonym);
  if (!trimmedFeedId || !normalizedSender) {
    return false;
  }
  return cheeredPairKeys.has(makePeerCheerDedupKey(trimmedFeedId, normalizedSender));
}

/**
 * Returns a map of `feedId -> true` for all posts cheered by `senderPseudonym`
 * tracked in local deduplication state.
 */
export function getCheeredFeedIdsForSender(
  senderPseudonym: string
): Record<string, boolean> {
  const normalizedSender = normalizeSenderPseudonym(senderPseudonym);
  if (!normalizedSender) {
    return {};
  }
  const feedIds = cheeredFeedIdsBySender.get(normalizedSender);
  if (!feedIds) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const feedId of feedIds) {
    result[feedId] = true;
  }
  return result;
}

/**
 * Fetches cheered feed IDs for `senderPseudonym` from Supabase `peer_cheers` when
 * configured, merges them into local deduplication state, and returns the combined
 * `feedId -> true` map. Gracefully falls back to local state on network errors.
 */
export async function fetchCheeredFeedIdsForUser(
  senderPseudonym: string
): Promise<Record<string, boolean>> {
  const normalizedSender = normalizeSenderPseudonym(senderPseudonym);
  if (!normalizedSender) {
    return {};
  }

  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client
        .from("peer_cheers")
        .select("feed_id")
        .eq("sender_pseudonym", normalizedSender);

      if (!error && Array.isArray(data)) {
        for (const row of data as Array<{ readonly feed_id?: unknown }>) {
          if (typeof row?.feed_id === "string" && row.feed_id.trim().length > 0) {
            recordLocalCheeredPair(row.feed_id, normalizedSender);
          }
        }
      }
    } catch {
      // Gracefully fall back to locally tracked cheers when offline or network fails
    }
  }

  return getCheeredFeedIdsForSender(normalizedSender);
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
 * Resolves the Supabase client key from the environment.
 *
 * `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` takes precedence. The legacy
 * `EXPO_PUBLIC_SUPABASE_ANON_KEY` is used only when the publishable key is
 * missing, empty or whitespace, so existing setups keep working.
 * Returns undefined when neither is set.
 */
export function getSupabaseAnonKey(): string | undefined {
  const publishable = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (publishable) {
    return publishable;
  }
  const legacy = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return legacy ? legacy : undefined;
}

/**
 * Resolves or creates a Supabase client instance.
 * Returns null if EXPO_PUBLIC_SUPABASE_URL or a client key
 * (EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, or the legacy EXPO_PUBLIC_SUPABASE_ANON_KEY)
 * is missing or empty.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (customClient !== undefined) {
    return customClient;
  }

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = getSupabaseAnonKey();

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
 * Validates with AnonymizedFeedInsertSchema, enforces zero raw biometric leakage,
 * and requires a valid EIP-712 SignedWorkoutClaimPayload matching `payload.proof_hash`
 * before writing to Supabase or the local store.
 * Automatically falls back to local fallback store if Supabase is unconfigured or network is offline.
 */
export async function publishProofMilestone(
  payload: AnonymizedFeedInsert,
  signedClaim?: SignedWorkoutClaimPayload,
  verifyingContract?: Address
): Promise<PublishMilestoneResult> {
  assertZeroRawBiometrics(payload);
  const validated = AnonymizedFeedInsertSchema.parse(payload);

  if (!signedClaim) {
    throw new FeedProofVerificationError(
      "Missing EIP-712 SignedWorkoutClaimPayload: cryptographic workout proof is required before publishing to the community feed."
    );
  }

  const effectiveVerifyingContract =
    verifyingContract ?? getRewardGateAddress() ?? DEMO_VERIFYING_CONTRACT;

  if (!verifyWorkoutProofSignature(signedClaim, effectiveVerifyingContract)) {
    throw new FeedProofVerificationError(
      "Invalid EIP-712 workout proof signature: feed milestone publish rejected."
    );
  }

  if (
    signedClaim.proof.telemetryHash.toLowerCase() !==
    validated.proof_hash.toLowerCase()
  ) {
    throw new FeedProofVerificationError(
      "EIP-712 proof telemetryHash mismatch: signed claim does not match payload proof_hash."
    );
  }

  if (signedClaim.proof.streakCount !== BigInt(validated.streak_count)) {
    throw new FeedProofVerificationError(
      "EIP-712 proof streakCount mismatch: signed claim streakCount does not match payload streak_count."
    );
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (signedClaim.proof.deadline < nowSec) {
    throw new FeedProofVerificationError(
      "EIP-712 workout proof expired: signed claim deadline is in the past."
    );
  }

  const normalizedProofHash = validated.proof_hash.toLowerCase();
  const claimReplayKey = `${signedClaim.proof.telemetryHash.toLowerCase()}:${signedClaim.signature.toLowerCase()}`;
  if (
    seenVerifiedClaimKeys.has(claimReplayKey) ||
    seenVerifiedProofHashes.has(normalizedProofHash) ||
    localFeedItems.some(
      (item) => item.proof_hash.toLowerCase() === normalizedProofHash
    )
  ) {
    throw new FeedProofVerificationError(
      "EIP-712 workout proof replay detected: signed claim or proof_hash has already been published."
    );
  }

  seenVerifiedClaimKeys.add(claimReplayKey);
  seenVerifiedProofHashes.add(normalizedProofHash);

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

function isPostgresUniqueViolation(err: {
  readonly code?: unknown;
  readonly message?: unknown;
}): boolean {
  return (
    String(err.code ?? "") === POSTGRES_UNIQUE_VIOLATION_CODE ||
    (typeof err.message === "string" &&
      err.message
        .toLowerCase()
        .includes("duplicate key value violates unique constraint"))
  );
}

/**
 * Sends a peer cheer for a feed milestone in Supabase peer_cheers.
 * Validates with PeerCheerInsertSchema and enforces one cheer per
 * `(feed_id, sender_pseudonym)` pair.
 * Automatically falls back to local fallback store if Supabase is unconfigured or network is offline.
 */
export async function sendPeerCheer(
  feedId: string,
  senderPseudonym: string
): Promise<{
  success: boolean;
  mode: ServiceMode;
}> {
  const validated = PeerCheerInsertSchema.parse({
    feed_id: feedId,
    sender_pseudonym: senderPseudonym
  });
  const normalizedSender = normalizeSenderPseudonym(validated.sender_pseudonym);

  const dedupKey = makePeerCheerDedupKey(
    validated.feed_id,
    normalizedSender
  );
  if (cheeredPairKeys.has(dedupKey) || inFlightCheerKeys.has(dedupKey)) {
    throw new DuplicateCheerError(
      DUPLICATE_CHEER_ERROR_MESSAGE,
      validated.feed_id,
      normalizedSender
    );
  }
  inFlightCheerKeys.add(dedupKey);

  try {
    const client = getSupabaseClient();
    if (!client) {
      recordLocalCheeredPair(validated.feed_id, normalizedSender);
      recordLocalCheer(validated.feed_id);
      return {
        success: true,
        mode: "local-fallback"
      };
    }

    const { error } = await client
      .from("peer_cheers")
      .insert({
        feed_id: validated.feed_id,
        sender_pseudonym: normalizedSender
      })
      .select("id, feed_id, sender_pseudonym, created_at")
      .single();

    if (error) {
      if (isPostgresUniqueViolation(error)) {
        recordLocalCheeredPair(validated.feed_id, normalizedSender);
        throw new DuplicateCheerError(
          DUPLICATE_CHEER_ERROR_MESSAGE,
          validated.feed_id,
          normalizedSender
        );
      }
      recordLocalCheer(validated.feed_id);
      return {
        success: true,
        mode: "local-fallback"
      };
    }

    recordLocalCheeredPair(validated.feed_id, normalizedSender);
    recordLocalCheer(validated.feed_id);
    return {
      success: true,
      mode: "live"
    };
  } catch (err) {
    if (isDuplicateCheerError(err)) {
      throw err;
    }
    recordLocalCheer(validated.feed_id);
    return {
      success: true,
      mode: "local-fallback"
    };
  } finally {
    inFlightCheerKeys.delete(dedupKey);
  }
}
