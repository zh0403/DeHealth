import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnonymizedFeedInsert,
  AnonymizedFeedRecord,
  assertZeroRawBiometrics,
  DataSovereigntyViolationError,
  DEFAULT_FALLBACK_CHEER_COUNTS,
  DEFAULT_FALLBACK_FEED_ITEMS,
  fetchAnonymizedFeed,
  generateFallbackUuid,
  getLocalFallbackCheerCounts,
  getLocalFallbackFeedItems,
  getSupabaseClient,
  isSupabaseConfigured,
  PROHIBITED_BIOMETRIC_KEYS,
  publishProofMilestone,
  resetLocalFeedStore,
  seedLocalFeedStore,
  sendPeerCheer,
  setSupabaseClient
} from "../services/supabaseService";
import { Bytes32 } from "@dehealth/shared";
import { SupabaseClient } from "@supabase/supabase-js";

const VALID_BYTES32 =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Bytes32;
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("Milestone 2 R3: Supabase Service Unit Test Suite", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    setSupabaseClient(undefined);
    resetLocalFeedStore();
  });

  // ============================================================================
  // 1. Environment & Client Resolution
  // ============================================================================
  describe("Client Resolution & Configuration Status", () => {
    it("reports unconfigured when environment variables are missing", () => {
      delete process.env.EXPO_PUBLIC_SUPABASE_URL;
      delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      expect(isSupabaseConfigured()).toBe(false);
      expect(getSupabaseClient()).toBeNull();
    });

    it("reports unconfigured when environment variables are empty strings or whitespace", () => {
      process.env.EXPO_PUBLIC_SUPABASE_URL = "   ";
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "";
      expect(isSupabaseConfigured()).toBe(false);
      expect(getSupabaseClient()).toBeNull();
    });

    it("instantiates and caches client when valid environment variables are present", () => {
      process.env.EXPO_PUBLIC_SUPABASE_URL = "https://mock-project.supabase.co";
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "mock-anon-key-12345";

      const client = getSupabaseClient();
      expect(client).not.toBeNull();
      expect(isSupabaseConfigured()).toBe(true);

      // Verify cached client is reused on subsequent calls
      const clientAgain = getSupabaseClient();
      expect(clientAgain).toBe(client);
    });

    it("handles createClient failure gracefully and returns null", () => {
      // Supabase createClient throws if URL does not start with http:// or https://
      process.env.EXPO_PUBLIC_SUPABASE_URL = "invalid-url-scheme";
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "mock-key";

      expect(getSupabaseClient()).toBeNull();
      expect(isSupabaseConfigured()).toBe(false);
    });

    it("allows explicit custom mock client injection via setSupabaseClient", () => {
      const mockClient = {} as unknown as SupabaseClient;
      setSupabaseClient(mockClient);
      expect(isSupabaseConfigured()).toBe(true);
      expect(getSupabaseClient()).toBe(mockClient);

      setSupabaseClient(null);
      expect(isSupabaseConfigured()).toBe(false);
      expect(getSupabaseClient()).toBeNull();
    });
  });

  // ============================================================================
  // 2. Unconfigured Local Fallback Mode
  // ============================================================================
  describe("Unconfigured Fallback Mode (Offline / Missing Env Vars)", () => {
    it("fetchAnonymizedFeed returns default local items and cheer counts in fallback mode", async () => {
      const result = await fetchAnonymizedFeed();

      expect(result.mode).toBe("local-fallback");
      expect(result.items.length).toBe(DEFAULT_FALLBACK_FEED_ITEMS.length);
      expect(result.items[0]?.user_pseudonym).toBe("zephyr_runner");
      expect(result.cheerCounts["00000000-0000-4000-8000-000000000001"]).toBe(12);
    });

    it("fetchAnonymizedFeed respects custom limit in fallback mode", async () => {
      const result = await fetchAnonymizedFeed(1);

      expect(result.mode).toBe("local-fallback");
      expect(result.items.length).toBe(1);
      expect(result.items[0]?.id).toBe("00000000-0000-4000-8000-000000000001");
    });

    it("publishProofMilestone records item in local store and returns fallback record", async () => {
      const payload: AnonymizedFeedInsert = {
        user_pseudonym: "fallback_warrior",
        proof_hash: VALID_BYTES32,
        streak_count: 5
      };

      const result = await publishProofMilestone(payload);

      expect(result.mode).toBe("local-fallback");
      expect(result.data.user_pseudonym).toBe("fallback_warrior");
      expect(result.data.proof_hash).toBe(VALID_BYTES32);
      expect(result.data.streak_count).toBe(5);
      expect(result.data.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      // Verify that subsequent fetch reflects the published milestone in fallback mode
      const feed = await fetchAnonymizedFeed();
      expect(feed.items[0]?.user_pseudonym).toBe("fallback_warrior");
      expect(feed.cheerCounts[result.data.id]).toBe(0);
    });

    it("sendPeerCheer increments local cheer count in fallback mode", async () => {
      const feedId = "00000000-0000-4000-8000-000000000001";
      const initialCheers = DEFAULT_FALLBACK_CHEER_COUNTS[feedId] ?? 0;

      const result = await sendPeerCheer(feedId, "cheer_squad_01");
      expect(result.mode).toBe("local-fallback");
      expect(result.success).toBe(true);

      const feed = await fetchAnonymizedFeed();
      expect(feed.cheerCounts[feedId]).toBe(initialCheers + 1);
    });

    it("sendPeerCheer initializes cheer count for a newly created feed item in fallback mode", async () => {
      const newFeedId = "11111111-2222-4333-8444-555555555555";
      const result = await sendPeerCheer(newFeedId, "cheer_friend");
      expect(result.mode).toBe("local-fallback");
      expect(result.success).toBe(true);

      const counts = getLocalFallbackCheerCounts();
      expect(counts[newFeedId]).toBe(1);
    });
  });

  // ============================================================================
  // 3. Configured Live Client Mode with Mocks
  // ============================================================================
  describe("Configured Live Client Mode", () => {
    it("fetchAnonymizedFeed queries anonymized_feed and aggregates peer cheers in live mode", async () => {
      const mockRows = [
        {
          id: "feed-uuid-1",
          user_pseudonym: "live_runner",
          proof_hash: VALID_BYTES32,
          streak_count: 21,
          created_at: "2026-11-16T12:00:00Z",
          peer_cheers: [{ id: "cheer-1" }, { id: "cheer-2" }, { id: "cheer-3" }]
        },
        {
          id: "feed-uuid-2",
          user_pseudonym: "live_cyclist",
          proof_hash: VALID_BYTES32,
          streak_count: 10,
          created_at: "2026-11-16T11:00:00Z",
          peer_cheers: []
        }
      ];

      const limitMock = vi.fn().mockResolvedValue({ data: mockRows, error: null });
      const orderMock = vi.fn().mockReturnValue({ limit: limitMock });
      const selectMock = vi.fn().mockReturnValue({ order: orderMock });
      const fromMock = vi.fn().mockReturnValue({ select: selectMock });

      const mockClient = { from: fromMock } as unknown as SupabaseClient;
      setSupabaseClient(mockClient);

      const result = await fetchAnonymizedFeed(15);

      expect(fromMock).toHaveBeenCalledWith("anonymized_feed");
      expect(selectMock).toHaveBeenCalledWith(
        "id, user_pseudonym, proof_hash, streak_count, created_at, peer_cheers(id)"
      );
      expect(orderMock).toHaveBeenCalledWith("created_at", { ascending: false });
      expect(limitMock).toHaveBeenCalledWith(15);

      expect(result.mode).toBe("live");
      expect(result.items.length).toBe(2);
      expect(result.items[0]?.user_pseudonym).toBe("live_runner");
      expect(result.items[0]?.proof_hash).toBe(VALID_BYTES32);
      expect(result.cheerCounts["feed-uuid-1"]).toBe(3);
      expect(result.cheerCounts["feed-uuid-2"]).toBe(0);
    });

    it("publishProofMilestone inserts sanitized milestone into anonymized_feed in live mode", async () => {
      const insertedRow = {
        id: "feed-inserted-uuid",
        user_pseudonym: "stellar_lifter",
        proof_hash: VALID_BYTES32,
        streak_count: 12,
        created_at: "2026-11-16T15:30:00Z"
      };

      const singleMock = vi.fn().mockResolvedValue({ data: insertedRow, error: null });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      const mockClient = { from: fromMock } as unknown as SupabaseClient;
      setSupabaseClient(mockClient);

      const payload: AnonymizedFeedInsert = {
        user_pseudonym: "stellar_lifter",
        proof_hash: VALID_BYTES32,
        streak_count: 12
      };

      const result = await publishProofMilestone(payload);

      expect(fromMock).toHaveBeenCalledWith("anonymized_feed");
      expect(insertMock).toHaveBeenCalledWith({
        user_pseudonym: "stellar_lifter",
        proof_hash: VALID_BYTES32,
        streak_count: 12
      });
      expect(selectMock).toHaveBeenCalledWith(
        "id, user_pseudonym, proof_hash, streak_count, created_at"
      );

      expect(result.mode).toBe("live");
      expect(result.data.id).toBe("feed-inserted-uuid");
      expect(result.data.user_pseudonym).toBe("stellar_lifter");
      expect(result.data.streak_count).toBe(12);
    });

    it("sendPeerCheer inserts cheer record into peer_cheers in live mode", async () => {
      const cheerRow = {
        id: "cheer-uuid-42",
        feed_id: VALID_UUID,
        sender_pseudonym: "iron_supporter",
        created_at: "2026-11-16T16:00:00Z"
      };

      const singleMock = vi.fn().mockResolvedValue({ data: cheerRow, error: null });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      const mockClient = { from: fromMock } as unknown as SupabaseClient;
      setSupabaseClient(mockClient);

      const result = await sendPeerCheer(VALID_UUID, "iron_supporter");

      expect(fromMock).toHaveBeenCalledWith("peer_cheers");
      expect(insertMock).toHaveBeenCalledWith({
        feed_id: VALID_UUID,
        sender_pseudonym: "iron_supporter"
      });

      expect(result.mode).toBe("live");
      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // 4. Network Error Handling and Graceful Fallback
  // ============================================================================
  describe("Network Error Handling and Transparent Fallback", () => {
    it("fetchAnonymizedFeed gracefully falls back when Supabase returns error object", async () => {
      const limitMock = vi.fn().mockResolvedValue({
        data: null,
        error: { message: "503 Service Unavailable" }
      });
      const orderMock = vi.fn().mockReturnValue({ limit: limitMock });
      const selectMock = vi.fn().mockReturnValue({ order: orderMock });
      const fromMock = vi.fn().mockReturnValue({ select: selectMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const result = await fetchAnonymizedFeed();

      expect(result.mode).toBe("local-fallback");
      expect(result.items.length).toBe(DEFAULT_FALLBACK_FEED_ITEMS.length);
      expect(result.items[0]?.user_pseudonym).toBe("zephyr_runner");
    });

    it("fetchAnonymizedFeed gracefully falls back when network throws an exception", async () => {
      const selectMock = vi.fn().mockImplementation(() => {
        throw new Error("Failed to fetch: Network offline");
      });
      const fromMock = vi.fn().mockReturnValue({ select: selectMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const result = await fetchAnonymizedFeed();

      expect(result.mode).toBe("local-fallback");
      expect(result.items.length).toBe(DEFAULT_FALLBACK_FEED_ITEMS.length);
    });

    it("publishProofMilestone falls back to local storage when remote insert returns error", async () => {
      const singleMock = vi.fn().mockResolvedValue({
        data: null,
        error: { message: "connection refused" }
      });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const payload: AnonymizedFeedInsert = {
        user_pseudonym: "offline_survivor",
        proof_hash: VALID_BYTES32,
        streak_count: 8
      };

      const result = await publishProofMilestone(payload);

      expect(result.mode).toBe("local-fallback");
      expect(result.data.user_pseudonym).toBe("offline_survivor");
      expect(result.data.streak_count).toBe(8);

      // Verify local persistence
      const feed = await fetchAnonymizedFeed();
      expect(feed.items[0]?.user_pseudonym).toBe("offline_survivor");
    });

    it("publishProofMilestone falls back to local storage when remote insert throws exception", async () => {
      const insertMock = vi.fn().mockImplementation(() => {
        throw new Error("Socket closed unexpectedly");
      });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const payload: AnonymizedFeedInsert = {
        user_pseudonym: "socket_drop_hero",
        proof_hash: VALID_BYTES32,
        streak_count: 3
      };

      const result = await publishProofMilestone(payload);

      expect(result.mode).toBe("local-fallback");
      expect(result.data.user_pseudonym).toBe("socket_drop_hero");
    });

    it("sendPeerCheer falls back to local cheer recording when remote insert fails", async () => {
      const singleMock = vi.fn().mockResolvedValue({
        data: null,
        error: { message: "table locks exceeded" }
      });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const feedId = "00000000-0000-4000-8000-000000000001";
      const initialCheers = DEFAULT_FALLBACK_CHEER_COUNTS[feedId] ?? 0;

      const result = await sendPeerCheer(feedId, "cheer_offline");

      expect(result.mode).toBe("local-fallback");
      expect(result.success).toBe(true);

      const counts = getLocalFallbackCheerCounts();
      expect(counts[feedId]).toBe(initialCheers + 1);
    });

    it("sendPeerCheer falls back to local cheer recording when remote insert throws exception", async () => {
      const insertMock = vi.fn().mockImplementation(() => {
        throw new Error("Timeout waiting for gateway");
      });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const feedId = "00000000-0000-4000-8000-000000000002";
      const initialCheers = DEFAULT_FALLBACK_CHEER_COUNTS[feedId] ?? 0;

      const result = await sendPeerCheer(feedId, "cheer_offline_2");

      expect(result.mode).toBe("local-fallback");
      expect(result.success).toBe(true);

      const counts = getLocalFallbackCheerCounts();
      expect(counts[feedId]).toBe(initialCheers + 1);
    });
  });

  // ============================================================================
  // 5. Schema Validation & Inbound Payload Rejection
  // ============================================================================
  describe("Schema Validation & Rejection of Malformed Payloads", () => {
    it("rejects publishProofMilestone with pseudonym less than 3 characters", async () => {
      await expect(
        publishProofMilestone({
          user_pseudonym: "ab",
          proof_hash: VALID_BYTES32,
          streak_count: 5
        })
      ).rejects.toThrow();
    });

    it("rejects publishProofMilestone with pseudonym exceeding 64 characters", async () => {
      await expect(
        publishProofMilestone({
          user_pseudonym: "a".repeat(65),
          proof_hash: VALID_BYTES32,
          streak_count: 5
        })
      ).rejects.toThrow();
    });

    it("rejects publishProofMilestone with invalid pseudonym characters (spaces, punctuation)", async () => {
      await expect(
        publishProofMilestone({
          user_pseudonym: "athlete with spaces",
          proof_hash: VALID_BYTES32,
          streak_count: 5
        })
      ).rejects.toThrow();

      await expect(
        publishProofMilestone({
          user_pseudonym: "athlete@evil.com",
          proof_hash: VALID_BYTES32,
          streak_count: 5
        })
      ).rejects.toThrow();
    });

    it("rejects publishProofMilestone with invalid proof hash format", async () => {
      await expect(
        publishProofMilestone({
          user_pseudonym: "valid_name",
          proof_hash: "0x1234" as Bytes32, // Too short
          streak_count: 5
        })
      ).rejects.toThrow();

      await expect(
        publishProofMilestone({
          user_pseudonym: "valid_name",
          proof_hash: "not-a-hex-string" as Bytes32,
          streak_count: 5
        })
      ).rejects.toThrow();
    });

    it("rejects publishProofMilestone with invalid streak count (<= 0 or > 10000 or non-integer)", async () => {
      await expect(
        publishProofMilestone({
          user_pseudonym: "valid_name",
          proof_hash: VALID_BYTES32,
          streak_count: 0
        })
      ).rejects.toThrow();

      await expect(
        publishProofMilestone({
          user_pseudonym: "valid_name",
          proof_hash: VALID_BYTES32,
          streak_count: 10_001
        })
      ).rejects.toThrow();

      await expect(
        publishProofMilestone({
          user_pseudonym: "valid_name",
          proof_hash: VALID_BYTES32,
          streak_count: 3.5
        })
      ).rejects.toThrow();
    });

    it("rejects sendPeerCheer with non-UUID feedId", async () => {
      await expect(sendPeerCheer("not-a-uuid", "cheer_user")).rejects.toThrow();
      await expect(sendPeerCheer("123456", "cheer_user")).rejects.toThrow();
    });

    it("rejects sendPeerCheer with invalid sender_pseudonym", async () => {
      await expect(sendPeerCheer(VALID_UUID, "ab")).rejects.toThrow();
      await expect(sendPeerCheer(VALID_UUID, "bad sender with spaces")).rejects.toThrow();
      await expect(sendPeerCheer(VALID_UUID, "bad!sender#")).rejects.toThrow();
    });
  });

  // ============================================================================
  // 6. Data Sovereignty Preservation (Zero Raw Biometrics)
  // ============================================================================
  describe("Data Sovereignty Preservation & Zero Raw Biometric Leakage", () => {
    it.each(PROHIBITED_BIOMETRIC_KEYS)(
      "assertZeroRawBiometrics throws DataSovereigntyViolationError when %s is present",
      (biometricKey) => {
        const taintedPayload = {
          user_pseudonym: "athlete_one",
          proof_hash: VALID_BYTES32,
          streak_count: 4,
          [biometricKey]: 1234
        };

        expect(() => assertZeroRawBiometrics(taintedPayload)).toThrow(
          DataSovereigntyViolationError
        );
        expect(() => assertZeroRawBiometrics(taintedPayload)).toThrow(
          `Data sovereignty violation: raw biometric key "${biometricKey}" detected in feed payload.`
        );
      }
    );

    it("assertZeroRawBiometrics succeeds on clean payload with strictly authorized fields", () => {
      const cleanPayload = {
        user_pseudonym: "athlete_one",
        proof_hash: VALID_BYTES32,
        streak_count: 4
      };

      expect(() => assertZeroRawBiometrics(cleanPayload)).not.toThrow();
    });

    it("publishProofMilestone immediately rejects payloads with raw biometrics without calling network", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const taintedPayload = {
        user_pseudonym: "tainted_user",
        proof_hash: VALID_BYTES32,
        streak_count: 7,
        avgHeartRateBpm: 145,
        stepCount: 10500,
        caloriesBurnedKcal: 650
      };

      await expect(
        publishProofMilestone(taintedPayload as unknown as AnonymizedFeedInsert)
      ).rejects.toThrow(DataSovereigntyViolationError);

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("ensures live Supabase insert receives ONLY strictly authorized schema fields", async () => {
      const singleMock = vi.fn().mockResolvedValue({
        data: {
          id: "feed-uuid-clean",
          user_pseudonym: "clean_user",
          proof_hash: VALID_BYTES32,
          streak_count: 1,
          created_at: "2026-11-16T18:00:00Z"
        },
        error: null
      });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      await publishProofMilestone({
        user_pseudonym: "clean_user",
        proof_hash: VALID_BYTES32,
        streak_count: 1
      });

      expect(insertMock).toHaveBeenCalledWith({
        user_pseudonym: "clean_user",
        proof_hash: VALID_BYTES32,
        streak_count: 1
      });

      const callArg = insertMock.mock.calls[0]?.[0];
      expect(Object.keys(callArg)).toEqual(["user_pseudonym", "proof_hash", "streak_count"]);
    });
  });

  // ============================================================================
  // 7. Store Management and Utilities
  // ============================================================================
  describe("Local Feed Store Utilities", () => {
    it("generateFallbackUuid produces valid RFC-4122 v4 UUID", () => {
      const uuid = generateFallbackUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it("generateFallbackUuid uses randomBytes fallback when crypto.randomUUID is absent", () => {
      const originalRandomUUID = globalThis.crypto?.randomUUID;
      try {
        // Temporarily delete or stub randomUUID
        if (globalThis.crypto) {
          Object.defineProperty(globalThis.crypto, "randomUUID", {
            value: undefined,
            configurable: true
          });
        }
        const uuid = generateFallbackUuid();
        expect(uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
      } finally {
        if (globalThis.crypto && originalRandomUUID) {
          Object.defineProperty(globalThis.crypto, "randomUUID", {
            value: originalRandomUUID,
            configurable: true
          });
        }
      }
    });

    it("seedLocalFeedStore replaces in-memory items and cheers", () => {
      const customItem: AnonymizedFeedRecord = {
        id: "custom-id-1",
        user_pseudonym: "custom_user",
        proof_hash: VALID_BYTES32,
        streak_count: 99,
        created_at: "2026-11-16T00:00:00Z"
      };

      seedLocalFeedStore([customItem], { "custom-id-1": 42 });

      const items = getLocalFallbackFeedItems();
      expect(items.length).toBe(1);
      expect(items[0]?.id).toBe("custom-id-1");

      const cheers = getLocalFallbackCheerCounts();
      expect(cheers["custom-id-1"]).toBe(42);

      resetLocalFeedStore();
      expect(getLocalFallbackFeedItems().length).toBe(DEFAULT_FALLBACK_FEED_ITEMS.length);
    });
  });
});
