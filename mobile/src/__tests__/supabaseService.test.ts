import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  AnonymizedFeedInsert,
  assertZeroRawBiometrics,
  DataSovereigntyViolationError,
  DEFAULT_FALLBACK_CHEER_COUNTS,
  DEFAULT_FALLBACK_FEED_ITEMS,
  DuplicateCheerError,
  FeedProofVerificationError,
  fetchAnonymizedFeed,
  fetchCheeredFeedIdsForUser,
  generateFallbackUuid,
  getCheeredFeedIdsForSender,
  getLocalFallbackCheerCounts,
  getLocalFallbackFeedItems,
  getSupabaseClient,
  getSupabaseAnonKey,
  hasLocalPeerCheered,
  isDuplicateCheerError,
  isSupabaseConfigured,
  MAX_RECURSION_DEPTH,
  normalizeSenderPseudonym,
  PROHIBITED_BIOMETRIC_KEYS,
  publishProofMilestone,
  resetFeedVerificationStateForTesting,
  resetLocalFeedStore,
  seedLocalFeedStore,
  sendPeerCheer,
  setSupabaseClient
} from "../services/supabaseService";
import { signWorkoutProof } from "../services/cryptoService";
import { DEMO_VERIFYING_CONTRACT, resetL2Config } from "../services/l2ContractService";
import {
  Address,
  AnonymizedFeedRecord,
  Bytes32,
  DUPLICATE_CHEER_ERROR_MESSAGE,
  POSTGRES_UNIQUE_VIOLATION_CODE,
  SignedWorkoutClaimPayload,
  WorkoutProof
} from "@dehealth/shared";
import { SupabaseClient } from "@supabase/supabase-js";
import { Signer, Wallet } from "ethers";

const VALID_BYTES32 =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Bytes32;
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

async function createSignedClaim(
  telemetryHash: Bytes32 = VALID_BYTES32,
  streakCount: number = 1,
  verifyingContract: Address = DEMO_VERIFYING_CONTRACT,
  signer: Signer & { readonly address: string } = Wallet.createRandom()
): Promise<SignedWorkoutClaimPayload> {
  const proof: WorkoutProof = {
    user: signer.address as Address,
    telemetryHash,
    streakCount: BigInt(streakCount),
    nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
  };
  return signWorkoutProof(signer, proof, verifyingContract);
}

describe("Milestone 2 R3: Supabase Service Unit Test Suite", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.EXPO_PUBLIC_REWARD_GATE_ADDRESS;
    resetL2Config();
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

    it("instantiates and caches client with strict PKCE and zero-session-persistence auth config (S2)", () => {
      process.env.EXPO_PUBLIC_SUPABASE_URL = "https://mock-project.supabase.co";
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "mock-anon-key-12345";

      const client = getSupabaseClient();
      expect(client).not.toBeNull();
      expect(isSupabaseConfigured()).toBe(true);

      const authInternals = client!.auth as unknown as {
        readonly flowType?: string;
        readonly persistSession?: boolean;
        readonly detectSessionInUrl?: boolean;
        readonly autoRefreshToken?: boolean;
      };
      expect(authInternals.flowType).toBe("pkce");
      expect(authInternals.persistSession).toBe(false);
      expect(authInternals.detectSessionInUrl).toBe(false);
      expect(authInternals.autoRefreshToken).toBe(false);

      // Verify cached client is reused on subsequent calls
      const clientAgain = getSupabaseClient();
      expect(clientAgain).toBe(client);
    });

    describe("Publishable key alignment", () => {
      it("resolves EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY and creates a client with it", () => {
        process.env.EXPO_PUBLIC_SUPABASE_URL = "https://mock-project.supabase.co";
        process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_mock_key_123";

        expect(getSupabaseAnonKey()).toBe("sb_publishable_mock_key_123");
        expect(isSupabaseConfigured()).toBe(true);
        expect(getSupabaseClient()).not.toBeNull();
      });

      it("falls back to the legacy EXPO_PUBLIC_SUPABASE_ANON_KEY when no publishable key is set", () => {
        process.env.EXPO_PUBLIC_SUPABASE_URL = "https://mock-project.supabase.co";
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon-key-456";

        expect(getSupabaseAnonKey()).toBe("legacy-anon-key-456");
        expect(isSupabaseConfigured()).toBe(true);
        expect(getSupabaseClient()).not.toBeNull();
      });

      it("prefers the publishable key when both variables are set", () => {
        process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_new";
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon-old";

        expect(getSupabaseAnonKey()).toBe("sb_publishable_new");
      });

      it("falls back to the legacy key when the publishable key is empty or whitespace", () => {
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon-key";

        for (const blank of ["", "   ", "\t\n"]) {
          process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = blank;
          expect(getSupabaseAnonKey()).toBe("legacy-anon-key");
        }
      });

      it("trims surrounding whitespace from either key", () => {
        process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "  sb_publishable_trim  ";
        expect(getSupabaseAnonKey()).toBe("sb_publishable_trim");

        delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "  legacy-trim  ";
        expect(getSupabaseAnonKey()).toBe("legacy-trim");
      });

      it("returns undefined and stays unconfigured when neither key is set", () => {
        process.env.EXPO_PUBLIC_SUPABASE_URL = "https://mock-project.supabase.co";

        expect(getSupabaseAnonKey()).toBeUndefined();
        expect(isSupabaseConfigured()).toBe(false);
        expect(getSupabaseClient()).toBeNull();
      });

      it("stays unconfigured when only a key is present and the URL is missing", () => {
        process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_only";

        expect(isSupabaseConfigured()).toBe(false);
        expect(getSupabaseClient()).toBeNull();
      });

      it("rebuilds the client when the resolved key changes", () => {
        process.env.EXPO_PUBLIC_SUPABASE_URL = "https://mock-project.supabase.co";
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "legacy-key";
        const first = getSupabaseClient();

        process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_switched";
        const second = getSupabaseClient();

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
      });
    });

    it("documents the publishable key (and the legacy fallback) in mobile/.env.example", () => {
      const example = readFileSync(resolvePath(__dirname, "../../.env.example"), "utf8");

      expect(example).toMatch(/^EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=/m);
      expect(example).toContain("EXPO_PUBLIC_SUPABASE_ANON_KEY");
      // The documented variable must be the one the client actually reads.
      expect(example).not.toMatch(/^EXPO_PUBLIC_SUPABASE_ANON_KEY=/m);
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
      const signedClaim = await createSignedClaim(VALID_BYTES32, 5);

      const result = await publishProofMilestone(payload, signedClaim);

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
      const signedClaim = await createSignedClaim(
        VALID_BYTES32,
        12,
        DEMO_VERIFYING_CONTRACT
      );

      const result = await publishProofMilestone(
        payload,
        signedClaim,
        DEMO_VERIFYING_CONTRACT
      );

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
      const signedClaim = await createSignedClaim(VALID_BYTES32, 8);

      const result = await publishProofMilestone(payload, signedClaim);

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
      const signedClaim = await createSignedClaim(VALID_BYTES32, 3);

      const result = await publishProofMilestone(payload, signedClaim);

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

      const signedClaim = await createSignedClaim(VALID_BYTES32, 1);

      await publishProofMilestone(
        {
          user_pseudonym: "clean_user",
          proof_hash: VALID_BYTES32,
          streak_count: 1
        },
        signedClaim,
        DEMO_VERIFYING_CONTRACT
      );

      expect(insertMock).toHaveBeenCalledWith({
        user_pseudonym: "clean_user",
        proof_hash: VALID_BYTES32,
        streak_count: 1
      });

      const callArg = insertMock.mock.calls[0]?.[0];
      expect(Object.keys(callArg)).toEqual(["user_pseudonym", "proof_hash", "streak_count"]);
    });

    it("detects biometric keys case-insensitively and in snake_case / kebab-case", () => {
      const variants: Array<Record<string, unknown>> = [
        { StepCount: 8000 },
        { WEIGHTKG: 72 },
        { BodyFatPct: 18 },
        { GOAL: "cut" },
        { step_count: 8000 },
        { avg_heart_rate_bpm: 130 },
        { "logged-calories-kcal": 1800 }
      ];

      for (const variant of variants) {
        expect(() =>
          assertZeroRawBiometrics({
            user_pseudonym: "athlete_one",
            proof_hash: VALID_BYTES32,
            streak_count: 4,
            ...variant
          })
        ).toThrow(DataSovereigntyViolationError);
      }
    });

    it("recursively rejects biometric keys nested inside objects, arrays, Sets, and Maps", () => {
      const nestedPayloads: unknown[] = [
        { meta: { stepCount: 5000 } },
        { deep: { level2: { Age: 29 } } },
        { items: [{ activeMinutes: 30 }] },
        [{ weight_kg: 71.5 }],
        { tags: ["ok", { nested: { loggedCaloriesKcal: 2100 } }] },
        { container: new Set([{ muscleMassKg: 35 }]) },
        { mapData: new Map<string, unknown>([["body_fat_pct", 16.5]]) },
        { mapNested: new Map<string, unknown>([["safe", { weeklyWorkoutFrequency: 4 }]]) }
      ];

      for (const payload of nestedPayloads) {
        expect(() => assertZeroRawBiometrics(payload)).toThrow(
          DataSovereigntyViolationError
        );
      }
    });

    it("handles circular object references without infinite recursion", () => {
      const cleanCircular: Record<string, unknown> = {
        user_pseudonym: "athlete_one",
        proof_hash: VALID_BYTES32,
        streak_count: 4
      };
      cleanCircular.self = cleanCircular;
      expect(() => assertZeroRawBiometrics(cleanCircular)).not.toThrow();

      const taintedCircular: Record<string, unknown> = {
        user_pseudonym: "athlete_one",
        nested: { heartRateBpm: 140 }
      };
      taintedCircular.self = taintedCircular;
      expect(() => assertZeroRawBiometrics(taintedCircular)).toThrow(
        DataSovereigntyViolationError
      );
    });

    it("rejects nested biometric payloads and unknown non-biometric extra fields in publishProofMilestone without network calls", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      await expect(
        publishProofMilestone({
          user_pseudonym: "tainted_nested",
          proof_hash: VALID_BYTES32,
          streak_count: 3,
          meta: { step_count: 4200 }
        } as unknown as AnonymizedFeedInsert)
      ).rejects.toThrow(DataSovereigntyViolationError);

      await expect(
        publishProofMilestone({
          user_pseudonym: "extra_field_user",
          proof_hash: VALID_BYTES32,
          streak_count: 3,
          unexpectedKey: "should-be-rejected-by-strict-schema"
        } as unknown as AnonymizedFeedInsert)
      ).rejects.toThrow();

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
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

  // ============================================================================
  // 8. Depth guard and EIP-712 feed anti-spam
  // ============================================================================
  describe("Depth limit and feed proof verification", () => {
    it("allows clean objects up to MAX_RECURSION_DEPTH (20) and clean primitives at depth 21", () => {
      expect(MAX_RECURSION_DEPTH).toBe(20);
      // Build a chain of 20 nested objects (depths 0..20) with a primitive leaf at depth 21
      let node: Record<string, unknown> = { label: "leaf_ok" };
      for (let i = 0; i < MAX_RECURSION_DEPTH; i += 1) {
        node = { child: node };
      }
      expect(() => assertZeroRawBiometrics(node)).not.toThrow();
    });

    it("throws DataSovereigntyViolationError (not RangeError) when nesting exceeds MAX_RECURSION_DEPTH", () => {
      let node21: Record<string, unknown> = { nested: { leaf: "ok" } };
      for (let i = 0; i < MAX_RECURSION_DEPTH; i += 1) {
        node21 = { child: node21 };
      }
      expect(() => assertZeroRawBiometrics(node21)).toThrow(
        DataSovereigntyViolationError
      );

      // 5,000-level deep payload fails closed with DataSovereigntyViolationError
      let deep5000: Record<string, unknown> = { leaf: "safe" };
      for (let i = 0; i < 5_000; i += 1) {
        deep5000 = { next: deep5000 };
      }
      expect(() => assertZeroRawBiometrics(deep5000)).toThrow(
        DataSovereigntyViolationError
      );
      expect(() => assertZeroRawBiometrics(deep5000)).toThrow(
        /maximum depth/i
      );
    });

    it("rejects publishProofMilestone with FeedProofVerificationError when signedClaim is missing and makes 0 Supabase calls", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      await expect(
        publishProofMilestone({
          user_pseudonym: "no_sig_user",
          proof_hash: VALID_BYTES32,
          streak_count: 4
        })
      ).rejects.toThrow(FeedProofVerificationError);

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("rejects publishProofMilestone with FeedProofVerificationError when signature is invalid or from wrong signer", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const validClaim = await createSignedClaim(VALID_BYTES32, 4);
      const forgedClaim: SignedWorkoutClaimPayload = {
        ...validClaim,
        signature: ("0x" + "ab".repeat(65)) as SignedWorkoutClaimPayload["signature"]
      };

      await expect(
        publishProofMilestone(
          {
            user_pseudonym: "forged_sig_user",
            proof_hash: VALID_BYTES32,
            streak_count: 4
          },
          forgedClaim,
          DEMO_VERIFYING_CONTRACT
        )
      ).rejects.toThrow(FeedProofVerificationError);

      // Claim signed for one address, but proof.user claims another address
      const attacker = Wallet.createRandom();
      const victim = Wallet.createRandom();
      const mismatchedUserClaim = await signWorkoutProof(
        attacker,
        {
          user: attacker.address as Address,
          telemetryHash: VALID_BYTES32,
          streakCount: 4n,
          nonce: 0n,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
        },
        DEMO_VERIFYING_CONTRACT
      );
      const spoofedClaim: SignedWorkoutClaimPayload = {
        proof: {
          ...mismatchedUserClaim.proof,
          user: victim.address as Address
        },
        signature: mismatchedUserClaim.signature
      };

      await expect(
        publishProofMilestone(
          {
            user_pseudonym: "spoofed_user",
            proof_hash: VALID_BYTES32,
            streak_count: 4
          },
          spoofedClaim,
          DEMO_VERIFYING_CONTRACT
        )
      ).rejects.toThrow(FeedProofVerificationError);

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("rejects publishProofMilestone with FeedProofVerificationError when verifyingContract does not match signature domain", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const signedForDemo = await createSignedClaim(
        VALID_BYTES32,
        6,
        DEMO_VERIFYING_CONTRACT
      );
      const otherContract = "0x2222222222222222222222222222222222222222" as Address;

      await expect(
        publishProofMilestone(
          {
            user_pseudonym: "wrong_domain_user",
            proof_hash: VALID_BYTES32,
            streak_count: 6
          },
          signedForDemo,
          otherContract
        )
      ).rejects.toThrow(FeedProofVerificationError);

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("rejects publishProofMilestone with FeedProofVerificationError when signedClaim.proof.telemetryHash mismatches payload.proof_hash", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const otherHash =
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Bytes32;
      const claimForOtherHash = await createSignedClaim(otherHash, 5);

      await expect(
        publishProofMilestone(
          {
            user_pseudonym: "hash_mismatch_user",
            proof_hash: VALID_BYTES32,
            streak_count: 5
          },
          claimForOtherHash,
          DEMO_VERIFYING_CONTRACT
        )
      ).rejects.toThrow(FeedProofVerificationError);

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("rejects publishProofMilestone with FeedProofVerificationError when signedClaim.proof.streakCount mismatches payload.streak_count and makes 0 Supabase calls", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const claimStreak1 = await createSignedClaim(VALID_BYTES32, 1);

      await expect(
        publishProofMilestone(
          {
            user_pseudonym: "spoof_streak_user",
            proof_hash: VALID_BYTES32,
            streak_count: 9999
          },
          claimStreak1,
          DEMO_VERIFYING_CONTRACT
        )
      ).rejects.toThrow(FeedProofVerificationError);

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("rejects publishProofMilestone with FeedProofVerificationError when signedClaim.proof.deadline is expired and makes 0 Supabase calls", async () => {
      const insertMock = vi.fn();
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const signer = Wallet.createRandom();
      const expiredClaim = await signWorkoutProof(
        signer,
        {
          user: signer.address as Address,
          telemetryHash: VALID_BYTES32,
          streakCount: 3n,
          nonce: 0n,
          deadline: BigInt(Math.floor(Date.now() / 1000) - 60)
        },
        DEMO_VERIFYING_CONTRACT
      );

      await expect(
        publishProofMilestone(
          {
            user_pseudonym: "expired_claim_user",
            proof_hash: VALID_BYTES32,
            streak_count: 3
          },
          expiredClaim,
          DEMO_VERIFYING_CONTRACT
        )
      ).rejects.toThrow(FeedProofVerificationError);

      expect(fromMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("rejects replayed (payload, signedClaim) or duplicate proof_hash with FeedProofVerificationError and makes 0 extra Supabase calls", async () => {
      const singleMock = vi.fn().mockResolvedValue({
        data: {
          id: "feed-uuid-first",
          user_pseudonym: "replay_tester",
          proof_hash: VALID_BYTES32,
          streak_count: 4,
          created_at: "2026-11-17T00:00:00Z"
        },
        error: null
      });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const signer = Wallet.createRandom();
      const signedClaim = await createSignedClaim(
        VALID_BYTES32,
        4,
        DEMO_VERIFYING_CONTRACT,
        signer
      );
      const payload: AnonymizedFeedInsert = {
        user_pseudonym: "replay_tester",
        proof_hash: VALID_BYTES32,
        streak_count: 4
      };

      // First publish succeeds
      const firstResult = await publishProofMilestone(
        payload,
        signedClaim,
        DEMO_VERIFYING_CONTRACT
      );
      expect(firstResult.mode).toBe("live");
      expect(insertMock).toHaveBeenCalledTimes(1);

      // Exact replay fails before calling Supabase
      await expect(
        publishProofMilestone(payload, signedClaim, DEMO_VERIFYING_CONTRACT)
      ).rejects.toThrow(FeedProofVerificationError);
      expect(insertMock).toHaveBeenCalledTimes(1);

      // Re-signing the same proof_hash with a fresh nonce also fails duplicate guard
      const resignedSameHash = await signWorkoutProof(
        signer,
        {
          user: signer.address as Address,
          telemetryHash: VALID_BYTES32,
          streakCount: 4n,
          nonce: 1n,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
        },
        DEMO_VERIFYING_CONTRACT
      );
      await expect(
        publishProofMilestone(payload, resignedSameHash, DEMO_VERIFYING_CONTRACT)
      ).rejects.toThrow(FeedProofVerificationError);
      expect(insertMock).toHaveBeenCalledTimes(1);

      // Resetting verification state and local feed store allows a clean subsequent test publish
      resetFeedVerificationStateForTesting();
      resetLocalFeedStore();
      const secondResult = await publishProofMilestone(
        payload,
        signedClaim,
        DEMO_VERIFYING_CONTRACT
      );
      expect(secondResult.mode).toBe("live");
      expect(insertMock).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // 9. Single Cheer per Post Deduplication & DuplicateCheerError
  // ============================================================================
  describe("Peer Cheer Deduplication & DuplicateCheerError", () => {
    const FEED_A = "00000000-0000-4000-8000-000000000001";
    const FEED_B = "00000000-0000-4000-8000-000000000002";

    it("throws DuplicateCheerError in fallback mode on repeat cheer without double-incrementing count", async () => {
      const initialCount = DEFAULT_FALLBACK_CHEER_COUNTS[FEED_A] ?? 0;

      const first = await sendPeerCheer(FEED_A, "athlete_alpha");
      expect(first).toEqual({ success: true, mode: "local-fallback" });
      expect(getLocalFallbackCheerCounts()[FEED_A]).toBe(initialCount + 1);
      expect(hasLocalPeerCheered(FEED_A, "athlete_alpha")).toBe(true);

      // Case-insensitive and trimmed duplicate is rejected before incrementing
      await expect(sendPeerCheer(FEED_A, "  ATHLETE_ALPHA  ")).rejects.toThrow(
        DuplicateCheerError
      );
      expect(getLocalFallbackCheerCounts()[FEED_A]).toBe(initialCount + 1);
    });

    it("allows different senders on the same post and same sender on different posts", async () => {
      const initialA = DEFAULT_FALLBACK_CHEER_COUNTS[FEED_A] ?? 0;
      const initialB = DEFAULT_FALLBACK_CHEER_COUNTS[FEED_B] ?? 0;

      await expect(sendPeerCheer(FEED_A, "sender_one")).resolves.toEqual({
        success: true,
        mode: "local-fallback"
      });
      await expect(sendPeerCheer(FEED_A, "sender_two")).resolves.toEqual({
        success: true,
        mode: "local-fallback"
      });
      await expect(sendPeerCheer(FEED_B, "sender_one")).resolves.toEqual({
        success: true,
        mode: "local-fallback"
      });

      const counts = getLocalFallbackCheerCounts();
      expect(counts[FEED_A]).toBe(initialA + 2);
      expect(counts[FEED_B]).toBe(initialB + 1);
      expect(getCheeredFeedIdsForSender("sender_one")).toEqual({
        [FEED_A]: true,
        [FEED_B]: true
      });
      expect(getCheeredFeedIdsForSender("sender_two")).toEqual({
        [FEED_A]: true
      });
    });

    it("throws DuplicateCheerError when live Supabase returns Postgres 23505 instead of falling back", async () => {
      const initialA = DEFAULT_FALLBACK_CHEER_COUNTS[FEED_A] ?? 0;
      const singleMock = vi.fn().mockResolvedValue({
        data: null,
        error: {
          code: POSTGRES_UNIQUE_VIOLATION_CODE,
          message:
            'duplicate key value violates unique constraint "peer_cheers_feed_id_sender_pseudonym_key"'
        }
      });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      let caught: unknown;
      try {
        await sendPeerCheer(FEED_A, "live_dup_user");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(DuplicateCheerError);
      expect(isDuplicateCheerError(caught)).toBe(true);
      expect((caught as DuplicateCheerError).message).toBe(
        DUPLICATE_CHEER_ERROR_MESSAGE
      );
      expect((caught as DuplicateCheerError).code).toBe(
        POSTGRES_UNIQUE_VIOLATION_CODE
      );
      expect((caught as DuplicateCheerError).feedId).toBe(FEED_A);
      expect((caught as DuplicateCheerError).senderPseudonym).toBe("live_dup_user");

      // Local cheer count must NOT increment on 23505, while local dedup state stays synced
      expect(getLocalFallbackCheerCounts()[FEED_A]).toBe(initialA);
      expect(hasLocalPeerCheered(FEED_A, "live_dup_user")).toBe(true);
      expect(getCheeredFeedIdsForSender("live_dup_user")).toEqual({
        [FEED_A]: true
      });

      // Subsequent attempt hits local dedup guard immediately with 0 extra Supabase calls
      await expect(sendPeerCheer(FEED_A, "live_dup_user")).rejects.toThrow(
        DuplicateCheerError
      );
      expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it("detects duplicate unique constraint error by message even when code is absent", async () => {
      const singleMock = vi.fn().mockResolvedValue({
        data: null,
        error: {
          message: "duplicate key value violates unique constraint"
        }
      });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      await expect(sendPeerCheer(FEED_B, "msg_dup_user")).rejects.toThrow(
        DuplicateCheerError
      );
      expect(hasLocalPeerCheered(FEED_B, "msg_dup_user")).toBe(true);
    });

    it("fetchCheeredFeedIdsForUser merges remote and local cheered posts and falls back gracefully on errors", async () => {
      // Blank sender returns {}
      expect(await fetchCheeredFeedIdsForUser("   ")).toEqual({});

      // Record one cheer locally first
      await sendPeerCheer(FEED_A, "hybrid_user");

      // Remote Supabase returns a second cheered feed_id for the same user
      const eqMock = vi.fn().mockResolvedValue({
        data: [{ feed_id: FEED_B }, { feed_id: "" }, { feed_id: null }],
        error: null
      });
      const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
      const fromMock = vi.fn().mockReturnValue({ select: selectMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const merged = await fetchCheeredFeedIdsForUser(" hybrid_user ");
      expect(fromMock).toHaveBeenCalledWith("peer_cheers");
      expect(selectMock).toHaveBeenCalledWith("feed_id");
      expect(eqMock).toHaveBeenCalledWith("sender_pseudonym", "hybrid_user");
      expect(merged).toEqual({
        [FEED_A]: true,
        [FEED_B]: true
      });
      expect(hasLocalPeerCheered(FEED_B, "hybrid_user")).toBe(true);

      // Network failure falls back cleanly to local dedup state
      const throwingSelect = vi.fn().mockImplementation(() => {
        throw new Error("Network down");
      });
      setSupabaseClient({
        from: vi.fn().mockReturnValue({ select: throwingSelect })
      } as unknown as SupabaseClient);

      const fallbackMap = await fetchCheeredFeedIdsForUser("hybrid_user");
      expect(fallbackMap).toEqual({
        [FEED_A]: true,
        [FEED_B]: true
      });
    });

    it("isDuplicateCheerError accurately identifies DuplicateCheerError and Postgres 23505 objects", () => {
      expect(isDuplicateCheerError(new DuplicateCheerError())).toBe(true);
      expect(isDuplicateCheerError({ name: "DuplicateCheerError" })).toBe(true);
      expect(
        isDuplicateCheerError({ code: POSTGRES_UNIQUE_VIOLATION_CODE })
      ).toBe(true);
      expect(isDuplicateCheerError({ code: 23505 })).toBe(true);

      expect(isDuplicateCheerError(null)).toBe(false);
      expect(isDuplicateCheerError(undefined)).toBe(false);
      expect(isDuplicateCheerError([])).toBe(false);
      expect(isDuplicateCheerError(new Error("other"))).toBe(false);
      expect(isDuplicateCheerError({ code: "42P01" })).toBe(false);

      expect(hasLocalPeerCheered("", "anyone")).toBe(false);
      expect(hasLocalPeerCheered(FEED_A, "   ")).toBe(false);
      expect(getCheeredFeedIdsForSender("   ")).toEqual({});

      resetFeedVerificationStateForTesting();
      expect(getCheeredFeedIdsForSender("hybrid_user")).toEqual({});
    });

    it("prevents concurrent double-tap sendPeerCheer with synchronous in-flight lock and only 1 insert (S1)", async () => {
      let resolveSingle!: (value: { data: unknown; error: null }) => void;
      const deferredSingle = new Promise<{ data: unknown; error: null }>((resolve) => {
        resolveSingle = resolve;
      });
      const singleMock = vi.fn().mockReturnValue(deferredSingle);
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const firstCall = sendPeerCheer(FEED_A, "alice");
      const secondCall = sendPeerCheer(FEED_A, "alice");

      // Second call must reject synchronously via in-flight lock without issuing a 2nd insert
      expect(insertMock).toHaveBeenCalledTimes(1);
      await expect(secondCall).rejects.toThrow(DuplicateCheerError);

      resolveSingle({
        data: {
          id: "cheer-concurrent-1",
          feed_id: FEED_A,
          sender_pseudonym: "alice",
          created_at: "2026-11-21T05:00:00Z"
        },
        error: null
      });

      const [firstSettled, secondSettled] = await Promise.allSettled([
        firstCall,
        secondCall
      ]);
      expect(firstSettled).toEqual({
        status: "fulfilled",
        value: { success: true, mode: "live" }
      });
      expect(secondSettled.status).toBe("rejected");
      if (secondSettled.status === "rejected") {
        expect(secondSettled.reason).toBeInstanceOf(DuplicateCheerError);
      }
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(hasLocalPeerCheered(FEED_A, "alice")).toBe(true);
    });

    it("clears inFlightCheerKeys on resetFeedVerificationStateForTesting and resetLocalFeedStore (S1)", async () => {
      let resolveFirst!: (value: { data: unknown; error: null }) => void;
      const deferredFirst = new Promise<{ data: unknown; error: null }>((resolve) => {
        resolveFirst = resolve;
      });
      const singleMock = vi
        .fn()
        .mockReturnValueOnce(deferredFirst)
        .mockResolvedValueOnce({
          data: {
            id: "cheer-after-reset",
            feed_id: FEED_A,
            sender_pseudonym: "reset_user",
            created_at: "2026-11-21T05:00:30Z"
          },
          error: null
        });
      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const pendingCall = sendPeerCheer(FEED_A, "reset_user");
      expect(insertMock).toHaveBeenCalledTimes(1);

      resetFeedVerificationStateForTesting();
      const afterReset = await sendPeerCheer(FEED_A, "reset_user");
      expect(afterReset).toEqual({ success: true, mode: "live" });
      expect(insertMock).toHaveBeenCalledTimes(2);

      // Cleanly settle the earlier pending promise so no open handles remain
      resolveFirst({
        data: {
          id: "cheer-stale",
          feed_id: FEED_A,
          sender_pseudonym: "reset_user",
          created_at: "2026-11-21T05:00:00Z"
        },
        error: null
      });
      await pendingCall;

      resetLocalFeedStore();
      expect(hasLocalPeerCheered(FEED_A, "reset_user")).toBe(false);
    });

    it("rolls back reservation on non-23505 server error or thrown network error so live retry succeeds (S1)", async () => {
      const singleMock = vi
        .fn()
        .mockResolvedValueOnce({
          data: null,
          error: { message: "503 Service Unavailable" }
        })
        .mockResolvedValueOnce({
          data: {
            id: "cheer-retry-server",
            feed_id: FEED_A,
            sender_pseudonym: "retry_server_user",
            created_at: "2026-11-21T05:01:00Z"
          },
          error: null
        })
        .mockRejectedValueOnce(new Error("Socket hang up"))
        .mockResolvedValueOnce({
          data: {
            id: "cheer-retry-throw",
            feed_id: FEED_B,
            sender_pseudonym: "retry_throw_user",
            created_at: "2026-11-21T05:02:00Z"
          },
          error: null
        });

      const selectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: selectMock });
      const fromMock = vi.fn().mockReturnValue({ insert: insertMock });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      // 1. Non-23505 server error falls back locally AND rolls back dedup reservation
      const failedServerResult = await sendPeerCheer(FEED_A, "retry_server_user");
      expect(failedServerResult).toEqual({ success: true, mode: "local-fallback" });
      expect(hasLocalPeerCheered(FEED_A, "retry_server_user")).toBe(false);
      expect(getCheeredFeedIdsForSender("retry_server_user")).toEqual({});

      // Subsequent live retry proceeds and succeeds
      const retriedServerResult = await sendPeerCheer(FEED_A, "retry_server_user");
      expect(retriedServerResult).toEqual({ success: true, mode: "live" });
      expect(hasLocalPeerCheered(FEED_A, "retry_server_user")).toBe(true);

      // 2. Thrown network error falls back locally AND rolls back dedup reservation
      const thrownResult = await sendPeerCheer(FEED_B, "retry_throw_user");
      expect(thrownResult).toEqual({ success: true, mode: "local-fallback" });
      expect(hasLocalPeerCheered(FEED_B, "retry_throw_user")).toBe(false);
      expect(getCheeredFeedIdsForSender("retry_throw_user")).toEqual({});

      // Subsequent live retry proceeds and succeeds
      const retriedThrowResult = await sendPeerCheer(FEED_B, "retry_throw_user");
      expect(retriedThrowResult).toEqual({ success: true, mode: "live" });
      expect(hasLocalPeerCheered(FEED_B, "retry_throw_user")).toBe(true);
      expect(insertMock).toHaveBeenCalledTimes(4);
    });

    it("normalizes sender pseudonym consistently across insert, dedup, and fetchCheeredFeedIdsForUser (C1)", async () => {
      expect(normalizeSenderPseudonym("  Iron_Supporter  ")).toBe("iron_supporter");

      const singleMock = vi.fn().mockResolvedValue({
        data: {
          id: "cheer-norm-1",
          feed_id: FEED_A,
          sender_pseudonym: "iron_supporter",
          created_at: "2026-11-21T05:03:00Z"
        },
        error: null
      });
      const insertSelectMock = vi.fn().mockReturnValue({ single: singleMock });
      const insertMock = vi.fn().mockReturnValue({ select: insertSelectMock });

      const eqMock = vi.fn().mockResolvedValue({
        data: [{ feed_id: FEED_B }],
        error: null
      });
      const querySelectMock = vi.fn().mockReturnValue({ eq: eqMock });

      const fromMock = vi.fn().mockReturnValue({
        insert: insertMock,
        select: querySelectMock
      });
      setSupabaseClient({ from: fromMock } as unknown as SupabaseClient);

      const liveResult = await sendPeerCheer(FEED_A, "  Iron_Supporter  ");
      expect(liveResult).toEqual({ success: true, mode: "live" });
      expect(insertMock).toHaveBeenCalledWith({
        feed_id: FEED_A,
        sender_pseudonym: "iron_supporter"
      });

      // Duplicate with uppercase rejects with DuplicateCheerError and normalized pseudonym
      let caught: unknown;
      try {
        await sendPeerCheer(FEED_A, "IRON_SUPPORTER");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DuplicateCheerError);
      expect((caught as DuplicateCheerError).senderPseudonym).toBe("iron_supporter");
      expect(insertMock).toHaveBeenCalledTimes(1);

      // Local lookup helpers match regardless of case or surrounding whitespace
      expect(hasLocalPeerCheered(FEED_A, "IRON_SUPPORTER")).toBe(true);
      expect(hasLocalPeerCheered(FEED_A, "  iron_supporter ")).toBe(true);
      expect(getCheeredFeedIdsForSender("  IRON_SUPPORTER ")).toEqual({
        [FEED_A]: true
      });

      // fetchCheeredFeedIdsForUser queries normalized lowercase pseudonym and merges entries
      const synced = await fetchCheeredFeedIdsForUser("  IRON_SUPPORTER ");
      expect(eqMock).toHaveBeenCalledWith("sender_pseudonym", "iron_supporter");
      expect(synced).toEqual({
        [FEED_A]: true,
        [FEED_B]: true
      });
      expect(hasLocalPeerCheered(FEED_B, "  iron_supporter ")).toBe(true);
      expect(hasLocalPeerCheered(FEED_B, "IRON_SUPPORTER")).toBe(true);
    });
  });
});
