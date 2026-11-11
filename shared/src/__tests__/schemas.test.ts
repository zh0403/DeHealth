import { describe, expect, it } from "vitest";
import {
  Address,
  AddressSchema,
  AnonymizedFeedInsertSchema,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32,
  Bytes32Schema,
  createDeHealthDomain,
  DEHEALTH_EIP712_DOMAIN_NAME,
  DEHEALTH_EIP712_VERSION,
  Eip712DomainSchema,
  HexSignature,
  HexSignatureSchema,
  PeerCheerInsertSchema,
  SignedWorkoutClaimPayloadSchema,
  TelemetryData,
  TelemetryDataSchema,
  Uint256Schema,
  UserProfile,
  UserProfileSchema,
  WORKOUT_PROOF_EIP712_TYPES,
  WorkoutProofSchema
} from "../index";

describe("Shared Domain Layer & Cryptographic Schemas", () => {
  const sampleValidAddress: Address = "0x1111222233334444555566667777888899990000";
  const sampleValidBytes32: Bytes32 =
    "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const sampleValidSignature: HexSignature =
    ("0x" +
      "ab".repeat(65)) as HexSignature;

  describe("EIP-712 Domain & Types", () => {
    it("exports standard domain constants and types definition", () => {
      expect(DEHEALTH_EIP712_DOMAIN_NAME).toBe("DeHealthProtocol");
      expect(DEHEALTH_EIP712_VERSION).toBe("1");
      expect(ARBITRUM_SEPOLIA_CHAIN_ID).toBe(421614);
      expect(WORKOUT_PROOF_EIP712_TYPES.WorkoutProof).toHaveLength(5);
      expect(WORKOUT_PROOF_EIP712_TYPES.WorkoutProof[0]?.name).toBe("user");
      expect(WORKOUT_PROOF_EIP712_TYPES.WorkoutProof[0]?.type).toBe("address");
      expect(WORKOUT_PROOF_EIP712_TYPES.WorkoutProof[1]?.name).toBe("telemetryHash");
      expect(WORKOUT_PROOF_EIP712_TYPES.WorkoutProof[2]?.name).toBe("streakCount");
      expect(WORKOUT_PROOF_EIP712_TYPES.WorkoutProof[3]?.name).toBe("nonce");
      expect(WORKOUT_PROOF_EIP712_TYPES.WorkoutProof[4]?.name).toBe("deadline");
    });

    it("creates domain with default Arbitrum Sepolia chain ID", () => {
      const domain = createDeHealthDomain(sampleValidAddress);
      expect(domain).toEqual({
        name: DEHEALTH_EIP712_DOMAIN_NAME,
        version: DEHEALTH_EIP712_VERSION,
        chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
        verifyingContract: sampleValidAddress
      });
    });

    it("creates domain with custom local chain ID (e.g. 31337)", () => {
      const domain = createDeHealthDomain(sampleValidAddress, 31337);
      expect(domain).toEqual({
        name: DEHEALTH_EIP712_DOMAIN_NAME,
        version: DEHEALTH_EIP712_VERSION,
        chainId: 31337,
        verifyingContract: sampleValidAddress
      });
    });

    it("validates Eip712DomainSchema with and without explicit chainId", () => {
      const parsedWithDefault = Eip712DomainSchema.parse({
        name: DEHEALTH_EIP712_DOMAIN_NAME,
        version: DEHEALTH_EIP712_VERSION,
        verifyingContract: sampleValidAddress
      });
      expect(parsedWithDefault.chainId).toBe(ARBITRUM_SEPOLIA_CHAIN_ID);

      const parsedExplicit = Eip712DomainSchema.parse({
        name: DEHEALTH_EIP712_DOMAIN_NAME,
        version: DEHEALTH_EIP712_VERSION,
        chainId: 31337,
        verifyingContract: sampleValidAddress
      });
      expect(parsedExplicit.chainId).toBe(31337);

      expect(() =>
        Eip712DomainSchema.parse({
          name: "InvalidProtocol",
          version: DEHEALTH_EIP712_VERSION,
          verifyingContract: sampleValidAddress
        })
      ).toThrow();

      expect(() =>
        Eip712DomainSchema.parse({
          name: DEHEALTH_EIP712_DOMAIN_NAME,
          version: "2",
          verifyingContract: sampleValidAddress
        })
      ).toThrow();
    });
  });

  describe("AddressSchema", () => {
    it("accepts valid EVM addresses (lowercase and checksummed)", () => {
      expect(AddressSchema.parse(sampleValidAddress)).toBe(sampleValidAddress);
      const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
      expect(AddressSchema.parse(checksummed)).toBe(checksummed);
    });

    it("rejects invalid addresses", () => {
      expect(() => AddressSchema.parse("0x123")).toThrow();
      expect(() => AddressSchema.parse("1111222233334444555566667777888899990000")).toThrow();
      expect(() => AddressSchema.parse("0xZZZZ222233334444555566667777888899990000")).toThrow();
      expect(() => AddressSchema.parse("0x" + "11".repeat(21))).toThrow();
      expect(() => AddressSchema.parse(null)).toThrow();
      expect(() => AddressSchema.parse(12345)).toThrow();
    });
  });

  describe("Bytes32Schema", () => {
    it("accepts valid 32-byte hex strings with 0x prefix", () => {
      expect(Bytes32Schema.parse(sampleValidBytes32)).toBe(sampleValidBytes32);
    });

    it("rejects invalid bytes32 strings", () => {
      expect(() => Bytes32Schema.parse("0x1234")).toThrow();
      expect(() => Bytes32Schema.parse(sampleValidBytes32.slice(2))).toThrow();
      expect(() => Bytes32Schema.parse(sampleValidBytes32 + "ff")).toThrow();
      expect(() => Bytes32Schema.parse("0x" + "G".repeat(64))).toThrow();
      expect(() => Bytes32Schema.parse(undefined)).toThrow();
    });
  });

  describe("HexSignatureSchema", () => {
    it("accepts valid 65-byte ECDSA hex signatures (130 hex chars with 0x prefix)", () => {
      expect(HexSignatureSchema.parse(sampleValidSignature)).toBe(sampleValidSignature);
    });

    it("rejects invalid hex signatures", () => {
      expect(() => HexSignatureSchema.parse("0x1234")).toThrow();
      expect(() => HexSignatureSchema.parse(sampleValidSignature.slice(2))).toThrow();
      expect(() => HexSignatureSchema.parse(sampleValidSignature + "00")).toThrow();
      expect(() => HexSignatureSchema.parse("0x" + "Z".repeat(130))).toThrow();
    });
  });

  describe("Uint256Schema", () => {
    const MAX_UINT256 = (1n << 256n) - 1n;

    it("accepts and transforms bigint values within [0, 2^256 - 1]", () => {
      expect(Uint256Schema.parse(0n)).toBe(0n);
      expect(Uint256Schema.parse(100n)).toBe(100n);
      expect(Uint256Schema.parse(MAX_UINT256)).toBe(MAX_UINT256);
    });

    it("accepts and transforms non-negative integer numbers to bigint", () => {
      expect(Uint256Schema.parse(0)).toBe(0n);
      expect(Uint256Schema.parse(42)).toBe(42n);
      expect(Uint256Schema.parse(1_000_000)).toBe(1_000_000n);
    });

    it("accepts and transforms decimal integer strings to bigint", () => {
      expect(Uint256Schema.parse("0")).toBe(0n);
      expect(Uint256Schema.parse("99999999999999999999")).toBe(99999999999999999999n);
      expect(Uint256Schema.parse(MAX_UINT256.toString())).toBe(MAX_UINT256);
    });

    it("rejects negative numbers, floats, and negative bigints", () => {
      expect(() => Uint256Schema.parse(-1)).toThrow();
      expect(() => Uint256Schema.parse(3.14)).toThrow();
      expect(() => Uint256Schema.parse(-1n)).toThrow();
    });

    it("rejects values exceeding uint256 max limit", () => {
      const overMax = MAX_UINT256 + 1n;
      expect(() => Uint256Schema.parse(overMax)).toThrow();
      expect(() => Uint256Schema.parse(overMax.toString())).toThrow();
    });

    it("rejects non-numeric strings and invalid types", () => {
      expect(() => Uint256Schema.parse("0x123")).toThrow();
      expect(() => Uint256Schema.parse("-50")).toThrow();
      expect(() => Uint256Schema.parse("abc")).toThrow();
      expect(() => Uint256Schema.parse(true)).toThrow();
      expect(() => Uint256Schema.parse({})).toThrow();
    });
  });

  describe("UserProfileSchema", () => {
    const validProfile: UserProfile = {
      age: 28,
      gender: "female",
      bodyFatPct: 21.5,
      muscleMassKg: 52.4
    };

    it("accepts valid UserProfile and trims gender string", () => {
      const result = UserProfileSchema.parse({
        ...validProfile,
        gender: "  female  "
      });
      expect(result.gender).toBe("female");
      expect(result.age).toBe(28);
    });

    it("validates age boundaries (13 to 120 integer)", () => {
      expect(UserProfileSchema.parse({ ...validProfile, age: 13 })).toBeDefined();
      expect(UserProfileSchema.parse({ ...validProfile, age: 120 })).toBeDefined();
      expect(() => UserProfileSchema.parse({ ...validProfile, age: 12 })).toThrow();
      expect(() => UserProfileSchema.parse({ ...validProfile, age: 121 })).toThrow();
      expect(() => UserProfileSchema.parse({ ...validProfile, age: 25.5 })).toThrow();
    });

    it("validates gender string constraints (1 to 32 chars non-empty)", () => {
      expect(UserProfileSchema.parse({ ...validProfile, gender: "non-binary" })).toBeDefined();
      expect(() => UserProfileSchema.parse({ ...validProfile, gender: "   " })).toThrow();
      expect(() => UserProfileSchema.parse({ ...validProfile, gender: "a".repeat(33) })).toThrow();
    });

    it("validates bodyFatPct boundaries (2 to 75)", () => {
      expect(UserProfileSchema.parse({ ...validProfile, bodyFatPct: 2 })).toBeDefined();
      expect(UserProfileSchema.parse({ ...validProfile, bodyFatPct: 75 })).toBeDefined();
      expect(() => UserProfileSchema.parse({ ...validProfile, bodyFatPct: 1.9 })).toThrow();
      expect(() => UserProfileSchema.parse({ ...validProfile, bodyFatPct: 75.1 })).toThrow();
    });

    it("validates muscleMassKg boundaries (10 to 150)", () => {
      expect(UserProfileSchema.parse({ ...validProfile, muscleMassKg: 10 })).toBeDefined();
      expect(UserProfileSchema.parse({ ...validProfile, muscleMassKg: 150 })).toBeDefined();
      expect(() => UserProfileSchema.parse({ ...validProfile, muscleMassKg: 9.9 })).toThrow();
      expect(() => UserProfileSchema.parse({ ...validProfile, muscleMassKg: 150.1 })).toThrow();
    });
  });

  describe("TelemetryDataSchema", () => {
    const validProfile: UserProfile = {
      age: 32,
      gender: "male",
      bodyFatPct: 18.0,
      muscleMassKg: 68.0
    };

    const validTelemetry: TelemetryData = {
      timestampMs: 1710000000000,
      stepCount: 10500,
      activeMinutes: 55,
      avgHeartRateBpm: 142.5,
      caloriesBurnedKcal: 620.0,
      profileSnapshot: validProfile
    };

    it("accepts valid TelemetryData", () => {
      const parsed = TelemetryDataSchema.parse(validTelemetry);
      expect(parsed.stepCount).toBe(10500);
      expect(parsed.profileSnapshot.age).toBe(32);
    });

    it("validates timestampMs positive integer", () => {
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, timestampMs: 0 })
      ).toThrow();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, timestampMs: -100 })
      ).toThrow();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, timestampMs: 1710000000000.5 })
      ).toThrow();
    });

    it("validates stepCount boundaries (0 to 200,000 integer)", () => {
      expect(TelemetryDataSchema.parse({ ...validTelemetry, stepCount: 0 })).toBeDefined();
      expect(TelemetryDataSchema.parse({ ...validTelemetry, stepCount: 200_000 })).toBeDefined();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, stepCount: -1 })
      ).toThrow();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, stepCount: 200_001 })
      ).toThrow();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, stepCount: 100.5 })
      ).toThrow();
    });

    it("validates activeMinutes boundaries (0 to 1,440 integer)", () => {
      expect(TelemetryDataSchema.parse({ ...validTelemetry, activeMinutes: 0 })).toBeDefined();
      expect(TelemetryDataSchema.parse({ ...validTelemetry, activeMinutes: 1_440 })).toBeDefined();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, activeMinutes: -1 })
      ).toThrow();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, activeMinutes: 1_441 })
      ).toThrow();
    });

    it("validates avgHeartRateBpm boundaries (30 to 240)", () => {
      expect(TelemetryDataSchema.parse({ ...validTelemetry, avgHeartRateBpm: 30 })).toBeDefined();
      expect(TelemetryDataSchema.parse({ ...validTelemetry, avgHeartRateBpm: 240 })).toBeDefined();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, avgHeartRateBpm: 29.9 })
      ).toThrow();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, avgHeartRateBpm: 240.1 })
      ).toThrow();
    });

    it("validates caloriesBurnedKcal boundaries (0 to 25,000)", () => {
      expect(TelemetryDataSchema.parse({ ...validTelemetry, caloriesBurnedKcal: 0 })).toBeDefined();
      expect(
        TelemetryDataSchema.parse({ ...validTelemetry, caloriesBurnedKcal: 25_000 })
      ).toBeDefined();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, caloriesBurnedKcal: -0.1 })
      ).toThrow();
      expect(() =>
        TelemetryDataSchema.parse({ ...validTelemetry, caloriesBurnedKcal: 25_000.1 })
      ).toThrow();
    });
  });

  describe("WorkoutProofSchema & SignedWorkoutClaimPayloadSchema", () => {
    it("parses valid WorkoutProof and transforms numeric/string values to bigint", () => {
      const rawProof = {
        user: sampleValidAddress,
        telemetryHash: sampleValidBytes32,
        streakCount: "7",
        nonce: 0,
        deadline: 1710000000n
      };

      const parsed = WorkoutProofSchema.parse(rawProof);
      expect(parsed.user).toBe(sampleValidAddress);
      expect(parsed.telemetryHash).toBe(sampleValidBytes32);
      expect(parsed.streakCount).toBe(7n);
      expect(parsed.nonce).toBe(0n);
      expect(parsed.deadline).toBe(1710000000n);
    });

    it("rejects invalid WorkoutProof fields", () => {
      expect(() =>
        WorkoutProofSchema.parse({
          user: "invalid-user",
          telemetryHash: sampleValidBytes32,
          streakCount: 1,
          nonce: 0,
          deadline: 1000
        })
      ).toThrow();

      expect(() =>
        WorkoutProofSchema.parse({
          user: sampleValidAddress,
          telemetryHash: "0xshort",
          streakCount: 1,
          nonce: 0,
          deadline: 1000
        })
      ).toThrow();
    });

    it("parses SignedWorkoutClaimPayloadSchema with valid proof and signature", () => {
      const rawPayload = {
        proof: {
          user: sampleValidAddress,
          telemetryHash: sampleValidBytes32,
          streakCount: 14,
          nonce: 2,
          deadline: "1720000000"
        },
        signature: sampleValidSignature
      };

      const parsed = SignedWorkoutClaimPayloadSchema.parse(rawPayload);
      expect(parsed.proof.streakCount).toBe(14n);
      expect(parsed.proof.deadline).toBe(1720000000n);
      expect(parsed.signature).toBe(sampleValidSignature);
    });

    it("rejects SignedWorkoutClaimPayloadSchema with invalid signature", () => {
      expect(() =>
        SignedWorkoutClaimPayloadSchema.parse({
          proof: {
            user: sampleValidAddress,
            telemetryHash: sampleValidBytes32,
            streakCount: 1,
            nonce: 0,
            deadline: 1000
          },
          signature: "0x1234"
        })
      ).toThrow();
    });
  });

  describe("AnonymizedFeedInsertSchema & PeerCheerInsertSchema", () => {
    it("validates valid AnonymizedFeedInsertSchema", () => {
      const validFeed = {
        user_pseudonym: "athlete_alpha-01",
        proof_hash: sampleValidBytes32,
        streak_count: 5
      };

      const parsed = AnonymizedFeedInsertSchema.parse(validFeed);
      expect(parsed.user_pseudonym).toBe("athlete_alpha-01");
      expect(parsed.proof_hash).toBe(sampleValidBytes32);
      expect(parsed.streak_count).toBe(5);
    });

    it("rejects invalid feed pseudonyms and bounds", () => {
      expect(() =>
        AnonymizedFeedInsertSchema.parse({
          user_pseudonym: "ab",
          proof_hash: sampleValidBytes32,
          streak_count: 5
        })
      ).toThrow();

      expect(() =>
        AnonymizedFeedInsertSchema.parse({
          user_pseudonym: "invalid name with spaces",
          proof_hash: sampleValidBytes32,
          streak_count: 5
        })
      ).toThrow();

      expect(() =>
        AnonymizedFeedInsertSchema.parse({
          user_pseudonym: "valid_name",
          proof_hash: sampleValidBytes32,
          streak_count: 0
        })
      ).toThrow();

      expect(() =>
        AnonymizedFeedInsertSchema.parse({
          user_pseudonym: "valid_name",
          proof_hash: sampleValidBytes32,
          streak_count: 10_001
        })
      ).toThrow();
    });

    it("validates valid PeerCheerInsertSchema with UUID", () => {
      const validCheer = {
        feed_id: "550e8400-e29b-41d4-a716-446655440000",
        sender_pseudonym: "cheerleader_99"
      };

      const parsed = PeerCheerInsertSchema.parse(validCheer);
      expect(parsed.feed_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(parsed.sender_pseudonym).toBe("cheerleader_99");
    });

    it("rejects invalid PeerCheerInsertSchema with non-UUID or invalid pseudonym", () => {
      expect(() =>
        PeerCheerInsertSchema.parse({
          feed_id: "non-uuid-string",
          sender_pseudonym: "cheerleader_99"
        })
      ).toThrow();

      expect(() =>
        PeerCheerInsertSchema.parse({
          feed_id: "550e8400-e29b-41d4-a716-446655440000",
          sender_pseudonym: "bad pseudonym!"
        })
      ).toThrow();
    });
  });
});
