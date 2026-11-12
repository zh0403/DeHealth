import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LEVELS,
  ActivityLevel,
  AdaptivePlanCycle,
  AdaptivePlanCycleSchema,
  Address,
  AddressSchema,
  AnonymizedFeedInsertSchema,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32,
  Bytes32Schema,
  createDeHealthDomain,
  DailyPlan,
  DailyPlanSchema,
  DEFAULT_BASELINE_BIOMETRICS,
  DEHEALTH_EIP712_DOMAIN_NAME,
  DEHEALTH_EIP712_VERSION,
  Eip712DomainSchema,
  FITNESS_GOALS,
  FitnessGoal,
  FitnessGoalSchema,
  FoodPresetItem,
  FoodPresetItemSchema,
  GENDER_TYPES,
  GenderType,
  HexSignature,
  HexSignatureSchema,
  MacroSplit,
  MacroSplitSchema,
  PeerCheerInsertSchema,
  PLAN_CYCLE_STATUSES,
  PLAN_REVIEW_STATUSES,
  PlanCycleStatus,
  PlanCycleStatusSchema,
  PlanReviewStatus,
  PlanReviewStatusSchema,
  ProposedPlanReview,
  ProposedPlanReviewSchema,
  SignedWorkoutClaimPayloadSchema,
  STANDARD_FOOD_PRESETS,
  TelemetryData,
  TelemetryDataSchema,
  Uint256Schema,
  UserBiometrics,
  UserBiometricsSchema,
  UserProfile,
  UserProfileSchema,
  WeightLogEntry,
  WeightLogEntrySchema,
  WORKOUT_PROOF_EIP712_TYPES,
  WorkoutExerciseItem,
  WorkoutExerciseItemSchema,
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

  // ==========================================================================
  // Phase 2.0 Adaptive Fitness & Nutrition Schemas Test Suite
  // ==========================================================================

  describe("FitnessGoalSchema & Constants", () => {
    it("exports all 6 supported fitness goals", () => {
      expect(FITNESS_GOALS).toEqual([
        "cut",
        "maintain",
        "bulk",
        "fat_loss",
        "maintenance",
        "muscle_gain"
      ]);
    });

    it("accepts each valid FitnessGoal variant", () => {
      for (const goal of FITNESS_GOALS) {
        expect(FitnessGoalSchema.parse(goal)).toBe(goal);
      }
    });

    it("rejects invalid fitness goal values", () => {
      expect(() => FitnessGoalSchema.parse("shred")).toThrow();
      expect(() => FitnessGoalSchema.parse("")).toThrow();
      expect(() => FitnessGoalSchema.parse("CUT")).toThrow();
      expect(() => FitnessGoalSchema.parse(null)).toThrow();
      expect(() => FitnessGoalSchema.parse(123)).toThrow();
    });
  });

  describe("Gender & Activity Level Constants", () => {
    it("exports gender types and activity levels correctly", () => {
      expect(GENDER_TYPES).toEqual(["male", "female", "other"]);
      expect(ACTIVITY_LEVELS).toEqual([
        "sedentary",
        "light",
        "moderate",
        "heavy",
        "very_active"
      ]);
    });
  });

  describe("UserBiometricsSchema & Default Baseline", () => {
    const validBiometrics: UserBiometrics = {
      age: 28,
      gender: "male",
      weightKg: 70.0,
      heightCm: 175.0,
      bodyFatPct: 18.5,
      weeklyWorkoutFrequency: 3,
      goal: "maintain",
      activityLevel: "moderate",
      updatedAtMs: 1710000000000
    };

    it("validates DEFAULT_BASELINE_BIOMETRICS successfully", () => {
      const parsed = UserBiometricsSchema.parse(DEFAULT_BASELINE_BIOMETRICS);
      expect(parsed).toEqual(DEFAULT_BASELINE_BIOMETRICS);
      expect(parsed.age).toBe(28);
      expect(parsed.gender).toBe("male");
      expect(parsed.weightKg).toBe(70.0);
      expect(parsed.heightCm).toBe(175.0);
      expect(parsed.bodyFatPct).toBe(18.5);
      expect(parsed.weeklyWorkoutFrequency).toBe(3);
      expect(parsed.goal).toBe("maintain");
      expect(parsed.activityLevel).toBe("moderate");
    });

    it("enforces Object.freeze immutability on DEFAULT_BASELINE_BIOMETRICS", () => {
      expect(Object.isFrozen(DEFAULT_BASELINE_BIOMETRICS)).toBe(true);
      expect(() => {
        (DEFAULT_BASELINE_BIOMETRICS as unknown as { age: number }).age = 50;
      }).toThrow();
    });

    it("rejects Infinity and -Infinity on biometric numeric fields", () => {
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, weightKg: Infinity })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, weightKg: -Infinity })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, heightCm: Infinity })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, heightCm: -Infinity })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, bodyFatPct: Infinity })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, bodyFatPct: -Infinity })).toThrow();
    });

    it("accepts biometrics with optional fields omitted", () => {
      const minimal: UserBiometrics = {
        age: 30,
        gender: "female",
        weightKg: 62.5,
        heightCm: 168.0,
        weeklyWorkoutFrequency: 4,
        goal: "fat_loss"
      };
      const parsed = UserBiometricsSchema.parse(minimal);
      expect(parsed.bodyFatPct).toBeUndefined();
      expect(parsed.activityLevel).toBeUndefined();
      expect(parsed.updatedAtMs).toBeUndefined();
    });

    it("validates age boundaries (13 to 120 integer)", () => {
      expect(UserBiometricsSchema.parse({ ...validBiometrics, age: 13 })).toBeDefined();
      expect(UserBiometricsSchema.parse({ ...validBiometrics, age: 120 })).toBeDefined();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, age: 12 })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, age: 121 })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, age: 25.5 })).toThrow();
    });

    it("validates gender enum values", () => {
      expect(UserBiometricsSchema.parse({ ...validBiometrics, gender: "female" })).toBeDefined();
      expect(UserBiometricsSchema.parse({ ...validBiometrics, gender: "other" })).toBeDefined();
      expect(() =>
        UserBiometricsSchema.parse({ ...validBiometrics, gender: "invalid" as GenderType })
      ).toThrow();
    });

    it("validates weightKg boundaries (30 to 300)", () => {
      expect(UserBiometricsSchema.parse({ ...validBiometrics, weightKg: 30 })).toBeDefined();
      expect(UserBiometricsSchema.parse({ ...validBiometrics, weightKg: 300 })).toBeDefined();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, weightKg: 29.9 })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, weightKg: 300.1 })).toThrow();
    });

    it("validates heightCm boundaries (100 to 250)", () => {
      expect(UserBiometricsSchema.parse({ ...validBiometrics, heightCm: 100 })).toBeDefined();
      expect(UserBiometricsSchema.parse({ ...validBiometrics, heightCm: 250 })).toBeDefined();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, heightCm: 99.9 })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, heightCm: 250.1 })).toThrow();
    });

    it("validates bodyFatPct boundaries (2 to 75)", () => {
      expect(UserBiometricsSchema.parse({ ...validBiometrics, bodyFatPct: 2 })).toBeDefined();
      expect(UserBiometricsSchema.parse({ ...validBiometrics, bodyFatPct: 75 })).toBeDefined();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, bodyFatPct: 1.9 })).toThrow();
      expect(() => UserBiometricsSchema.parse({ ...validBiometrics, bodyFatPct: 75.1 })).toThrow();
    });

    it("validates weeklyWorkoutFrequency boundaries (1 to 7 integer)", () => {
      expect(UserBiometricsSchema.parse({ ...validBiometrics, weeklyWorkoutFrequency: 1 })).toBeDefined();
      expect(UserBiometricsSchema.parse({ ...validBiometrics, weeklyWorkoutFrequency: 7 })).toBeDefined();
      expect(() =>
        UserBiometricsSchema.parse({ ...validBiometrics, weeklyWorkoutFrequency: 0 })
      ).toThrow();
      expect(() =>
        UserBiometricsSchema.parse({ ...validBiometrics, weeklyWorkoutFrequency: 8 })
      ).toThrow();
      expect(() =>
        UserBiometricsSchema.parse({ ...validBiometrics, weeklyWorkoutFrequency: 3.5 })
      ).toThrow();
    });

    it("validates activityLevel optional enum", () => {
      for (const level of ACTIVITY_LEVELS) {
        expect(
          UserBiometricsSchema.parse({ ...validBiometrics, activityLevel: level })
        ).toBeDefined();
      }
      expect(() =>
        UserBiometricsSchema.parse({
          ...validBiometrics,
          activityLevel: "super_active" as ActivityLevel
        })
      ).toThrow();
    });

    it("validates updatedAtMs positive integer", () => {
      expect(
        UserBiometricsSchema.parse({ ...validBiometrics, updatedAtMs: 1 })
      ).toBeDefined();
      expect(() =>
        UserBiometricsSchema.parse({ ...validBiometrics, updatedAtMs: 0 })
      ).toThrow();
      expect(() =>
        UserBiometricsSchema.parse({ ...validBiometrics, updatedAtMs: -100 })
      ).toThrow();
      expect(() =>
        UserBiometricsSchema.parse({ ...validBiometrics, updatedAtMs: 12345.67 })
      ).toThrow();
    });
  });

  describe("WeightLogEntrySchema", () => {
    const validEntry: WeightLogEntry = {
      id: "weight_log_001",
      timestampMs: 1710000000000,
      weightKg: 72.4,
      bodyFatPct: 17.8,
      note: "Morning weigh-in before hydration"
    };

    it("accepts valid WeightLogEntry and trims note", () => {
      const parsed = WeightLogEntrySchema.parse({
        ...validEntry,
        note: "  Morning weigh-in before hydration  "
      });
      expect(parsed.note).toBe("Morning weigh-in before hydration");
      expect(parsed.weightKg).toBe(72.4);
    });

    it("accepts entry without optional bodyFatPct and note", () => {
      const minimal = {
        id: "weight_log_002",
        timestampMs: 1710000000000,
        weightKg: 68.0
      };
      const parsed = WeightLogEntrySchema.parse(minimal);
      expect(parsed.bodyFatPct).toBeUndefined();
      expect(parsed.note).toBeUndefined();
    });

    it("rejects empty id string", () => {
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, id: "" })).toThrow();
    });

    it("validates timestampMs positive integer", () => {
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, timestampMs: 0 })).toThrow();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, timestampMs: -10 })).toThrow();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, timestampMs: 1710000000000.5 })).toThrow();
    });

    it("validates weightKg boundaries (30 to 300)", () => {
      expect(WeightLogEntrySchema.parse({ ...validEntry, weightKg: 30 })).toBeDefined();
      expect(WeightLogEntrySchema.parse({ ...validEntry, weightKg: 300 })).toBeDefined();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, weightKg: 29.9 })).toThrow();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, weightKg: 300.1 })).toThrow();
    });

    it("validates bodyFatPct boundaries (2 to 75)", () => {
      expect(WeightLogEntrySchema.parse({ ...validEntry, bodyFatPct: 2 })).toBeDefined();
      expect(WeightLogEntrySchema.parse({ ...validEntry, bodyFatPct: 75 })).toBeDefined();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, bodyFatPct: 1.9 })).toThrow();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, bodyFatPct: 75.1 })).toThrow();
    });

    it("validates note length (max 500 characters)", () => {
      expect(WeightLogEntrySchema.parse({ ...validEntry, note: "a".repeat(500) })).toBeDefined();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, note: "a".repeat(501) })).toThrow();
    });

    it("rejects Infinity and -Infinity on weightKg and bodyFatPct", () => {
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, weightKg: Infinity })).toThrow();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, weightKg: -Infinity })).toThrow();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, bodyFatPct: Infinity })).toThrow();
      expect(() => WeightLogEntrySchema.parse({ ...validEntry, bodyFatPct: -Infinity })).toThrow();
    });
  });

  describe("WorkoutExerciseItemSchema", () => {
    const validExercise: WorkoutExerciseItem = {
      id: "ex_squat_01",
      name: "Barbell Back Squat",
      category: "legs",
      sets: 4,
      reps: 8,
      durationMinutes: 15,
      completed: false,
      scaledForFatigue: false
    };

    it("accepts valid WorkoutExerciseItem and trims name/category", () => {
      const parsed = WorkoutExerciseItemSchema.parse({
        ...validExercise,
        name: "  Barbell Back Squat  ",
        category: "  legs  "
      });
      expect(parsed.name).toBe("Barbell Back Squat");
      expect(parsed.category).toBe("legs");
      expect(parsed.completed).toBe(false);
    });

    it("accepts exercise with optional fields omitted", () => {
      const minimal: WorkoutExerciseItem = {
        id: "ex_plank_01",
        name: "Forearm Plank",
        category: "core",
        sets: 3,
        completed: true
      };
      const parsed = WorkoutExerciseItemSchema.parse(minimal);
      expect(parsed.reps).toBeUndefined();
      expect(parsed.durationMinutes).toBeUndefined();
      expect(parsed.scaledForFatigue).toBeUndefined();
      expect(parsed.completed).toBe(true);
    });

    it("rejects empty id, name, or category", () => {
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, id: "" })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, name: "   " })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, category: "   " })).toThrow();
    });

    it("validates name and category max lengths", () => {
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, name: "a".repeat(100) })).toBeDefined();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, name: "a".repeat(101) })).toThrow();
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, category: "b".repeat(50) })).toBeDefined();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, category: "b".repeat(51) })).toThrow();
    });

    it("validates sets boundaries (1 to 20 integer)", () => {
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, sets: 1 })).toBeDefined();
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, sets: 20 })).toBeDefined();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, sets: 0 })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, sets: 21 })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, sets: 3.5 })).toThrow();
    });

    it("validates reps boundaries (1 to 200 integer)", () => {
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, reps: 1 })).toBeDefined();
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, reps: 200 })).toBeDefined();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, reps: 0 })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, reps: 201 })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, reps: 10.5 })).toThrow();
    });

    it("validates durationMinutes boundaries (0 to 300)", () => {
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, durationMinutes: 0 })).toBeDefined();
      expect(WorkoutExerciseItemSchema.parse({ ...validExercise, durationMinutes: 300 })).toBeDefined();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, durationMinutes: -0.1 })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, durationMinutes: 300.1 })).toThrow();
    });

    it("rejects Infinity and -Infinity on durationMinutes", () => {
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, durationMinutes: Infinity })).toThrow();
      expect(() => WorkoutExerciseItemSchema.parse({ ...validExercise, durationMinutes: -Infinity })).toThrow();
    });
  });

  describe("FoodPresetItemSchema & Standard Presets", () => {
    it("validates all STANDARD_FOOD_PRESETS successfully", () => {
      expect(STANDARD_FOOD_PRESETS).toHaveLength(6);
      for (const preset of STANDARD_FOOD_PRESETS) {
        const parsed = FoodPresetItemSchema.parse(preset);
        expect(parsed.id).toBe(preset.id);
        expect(parsed.caloriesKcal).toBeGreaterThan(0);
      }
    });

    it("enforces Object.freeze immutability on STANDARD_FOOD_PRESETS and items", () => {
      expect(Object.isFrozen(STANDARD_FOOD_PRESETS)).toBe(true);
      for (const preset of STANDARD_FOOD_PRESETS) {
        expect(Object.isFrozen(preset)).toBe(true);
        expect(() => {
          (preset as unknown as { caloriesKcal: number }).caloriesKcal = 999;
        }).toThrow();
      }
      expect(() => {
        (STANDARD_FOOD_PRESETS as unknown as FoodPresetItem[]).push({} as FoodPresetItem);
      }).toThrow();
    });

    it("rejects Infinity, -Infinity, and values exceeding maximum bounds", () => {
      const base: FoodPresetItem = {
        id: "preset_01",
        name: "Item",
        servingSizeGrams: 100,
        caloriesKcal: 100,
        proteinGrams: 10,
        carbsGrams: 10,
        fatGrams: 2
      };
      expect(() => FoodPresetItemSchema.parse({ ...base, servingSizeGrams: Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, servingSizeGrams: -Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, servingSizeGrams: 50_000.1 })).toThrow();
      expect(FoodPresetItemSchema.parse({ ...base, servingSizeGrams: 50_000 })).toBeDefined();

      expect(() => FoodPresetItemSchema.parse({ ...base, caloriesKcal: Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, caloriesKcal: -Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, proteinGrams: Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, proteinGrams: -Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, carbsGrams: Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, carbsGrams: -Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, fatGrams: Infinity })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, fatGrams: -Infinity })).toThrow();
    });

    it("validates valid FoodPresetItem and trims text fields", () => {
      const validItem: FoodPresetItem = {
        id: "preset_salmon",
        name: "  Atlantic Salmon  ",
        servingSizeGrams: 100,
        caloriesKcal: 208,
        proteinGrams: 20,
        carbsGrams: 0,
        fatGrams: 13,
        category: "  seafood  "
      };
      const parsed = FoodPresetItemSchema.parse(validItem);
      expect(parsed.name).toBe("Atlantic Salmon");
      expect(parsed.category).toBe("seafood");
    });

    it("accepts preset without optional category", () => {
      const noCategory: FoodPresetItem = {
        id: "preset_apple",
        name: "Honeycrisp Apple",
        servingSizeGrams: 150,
        caloriesKcal: 78,
        proteinGrams: 0.5,
        carbsGrams: 20.5,
        fatGrams: 0.3
      };
      const parsed = FoodPresetItemSchema.parse(noCategory);
      expect(parsed.category).toBeUndefined();
    });

    it("rejects empty id, empty name, or invalid servingSizeGrams", () => {
      const base: FoodPresetItem = {
        id: "preset_01",
        name: "Item",
        servingSizeGrams: 100,
        caloriesKcal: 100,
        proteinGrams: 10,
        carbsGrams: 10,
        fatGrams: 2
      };
      expect(() => FoodPresetItemSchema.parse({ ...base, id: "" })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, name: "   " })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, servingSizeGrams: 0 })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, servingSizeGrams: -10 })).toThrow();
    });

    it("validates caloriesKcal boundaries (0 to 2000)", () => {
      const base: FoodPresetItem = {
        id: "preset_01",
        name: "Item",
        servingSizeGrams: 100,
        caloriesKcal: 0,
        proteinGrams: 0,
        carbsGrams: 0,
        fatGrams: 0
      };
      expect(FoodPresetItemSchema.parse({ ...base, caloriesKcal: 0 })).toBeDefined();
      expect(FoodPresetItemSchema.parse({ ...base, caloriesKcal: 2000 })).toBeDefined();
      expect(() => FoodPresetItemSchema.parse({ ...base, caloriesKcal: -1 })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, caloriesKcal: 2000.1 })).toThrow();
    });

    it("validates macro boundaries (0 to 200g)", () => {
      const base: FoodPresetItem = {
        id: "preset_01",
        name: "Item",
        servingSizeGrams: 100,
        caloriesKcal: 100,
        proteinGrams: 0,
        carbsGrams: 0,
        fatGrams: 0
      };
      expect(FoodPresetItemSchema.parse({ ...base, proteinGrams: 200 })).toBeDefined();
      expect(FoodPresetItemSchema.parse({ ...base, carbsGrams: 200 })).toBeDefined();
      expect(FoodPresetItemSchema.parse({ ...base, fatGrams: 200 })).toBeDefined();
      expect(() => FoodPresetItemSchema.parse({ ...base, proteinGrams: -0.1 })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, proteinGrams: 200.1 })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, carbsGrams: -0.1 })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, carbsGrams: 200.1 })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, fatGrams: -0.1 })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, fatGrams: 200.1 })).toThrow();
    });

    it("validates name and category max lengths", () => {
      const base: FoodPresetItem = {
        id: "preset_01",
        name: "a".repeat(100),
        servingSizeGrams: 100,
        caloriesKcal: 100,
        proteinGrams: 10,
        carbsGrams: 10,
        fatGrams: 2,
        category: "b".repeat(50)
      };
      expect(FoodPresetItemSchema.parse(base)).toBeDefined();
      expect(() => FoodPresetItemSchema.parse({ ...base, name: "a".repeat(101) })).toThrow();
      expect(() => FoodPresetItemSchema.parse({ ...base, category: "b".repeat(51) })).toThrow();
    });
  });

  describe("DailyPlanSchema", () => {
    const sampleExercise: WorkoutExerciseItem = {
      id: "ex_pushup",
      name: "Standard Push-Up",
      category: "chest",
      sets: 3,
      reps: 15,
      completed: false
    };

    const validDailyPlan: DailyPlan = {
      dayNumber: 1,
      date: "2026-11-12",
      targetCaloriesKcal: 2100,
      targetProteinGrams: 160,
      targetCarbsGrams: 220,
      targetFatGrams: 60,
      loggedCaloriesKcal: 0,
      loggedProteinGrams: 0,
      loggedCarbsGrams: 0,
      loggedFatGrams: 0,
      exercises: [sampleExercise],
      isFatigueScaled: false,
      completed: false
    };

    it("accepts valid DailyPlan", () => {
      const parsed = DailyPlanSchema.parse(validDailyPlan);
      expect(parsed.dayNumber).toBe(1);
      expect(parsed.targetCaloriesKcal).toBe(2100);
      expect(parsed.exercises).toHaveLength(1);
    });

    it("validates dayNumber boundaries (1 to 14 integer)", () => {
      expect(DailyPlanSchema.parse({ ...validDailyPlan, dayNumber: 1 })).toBeDefined();
      expect(DailyPlanSchema.parse({ ...validDailyPlan, dayNumber: 14 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, dayNumber: 0 })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, dayNumber: 15 })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, dayNumber: 2.5 })).toThrow();
    });

    it("validates date non-empty string", () => {
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, date: "" })).toThrow();
    });

    it("strictly enforces safe calorie floor (>= 1200 kcal/day)", () => {
      expect(DailyPlanSchema.parse({ ...validDailyPlan, targetCaloriesKcal: 1200 })).toBeDefined();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, targetCaloriesKcal: 1199.9 })
      ).toThrow();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, targetCaloriesKcal: 800 })
      ).toThrow();
    });

    it("validates target and logged macros are non-negative", () => {
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, targetProteinGrams: -1 })
      ).toThrow();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, targetCarbsGrams: -1 })
      ).toThrow();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, targetFatGrams: -1 })
      ).toThrow();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, loggedCaloriesKcal: -1 })
      ).toThrow();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, loggedProteinGrams: -1 })
      ).toThrow();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, loggedCarbsGrams: -1 })
      ).toThrow();
      expect(() =>
        DailyPlanSchema.parse({ ...validDailyPlan, loggedFatGrams: -1 })
      ).toThrow();
    });

    it("rejects invalid exercise item within exercises array", () => {
      expect(() =>
        DailyPlanSchema.parse({
          ...validDailyPlan,
          exercises: [{ ...sampleExercise, sets: 0 }]
        })
      ).toThrow();
    });

    it("rejects Infinity and -Infinity on daily plan targets and logged metrics", () => {
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetCaloriesKcal: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetCaloriesKcal: -Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetProteinGrams: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetProteinGrams: -Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetCarbsGrams: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetCarbsGrams: -Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetFatGrams: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetFatGrams: -Infinity })).toThrow();

      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedCaloriesKcal: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedCaloriesKcal: -Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedProteinGrams: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedProteinGrams: -Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedCarbsGrams: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedCarbsGrams: -Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedFatGrams: Infinity })).toThrow();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedFatGrams: -Infinity })).toThrow();
    });

    it("enforces upper boundaries on target and logged daily plan metrics", () => {
      expect(DailyPlanSchema.parse({ ...validDailyPlan, targetCaloriesKcal: 20_000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetCaloriesKcal: 20_000.1 })).toThrow();

      expect(DailyPlanSchema.parse({ ...validDailyPlan, targetProteinGrams: 1000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetProteinGrams: 1000.1 })).toThrow();

      expect(DailyPlanSchema.parse({ ...validDailyPlan, targetCarbsGrams: 2000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetCarbsGrams: 2000.1 })).toThrow();

      expect(DailyPlanSchema.parse({ ...validDailyPlan, targetFatGrams: 1000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, targetFatGrams: 1000.1 })).toThrow();

      expect(DailyPlanSchema.parse({ ...validDailyPlan, loggedCaloriesKcal: 25_000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedCaloriesKcal: 25_000.1 })).toThrow();

      expect(DailyPlanSchema.parse({ ...validDailyPlan, loggedProteinGrams: 1000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedProteinGrams: 1000.1 })).toThrow();

      expect(DailyPlanSchema.parse({ ...validDailyPlan, loggedCarbsGrams: 2000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedCarbsGrams: 2000.1 })).toThrow();

      expect(DailyPlanSchema.parse({ ...validDailyPlan, loggedFatGrams: 1000 })).toBeDefined();
      expect(() => DailyPlanSchema.parse({ ...validDailyPlan, loggedFatGrams: 1000.1 })).toThrow();
    });
  });

  describe("PlanCycleStatusSchema & AdaptivePlanCycleSchema", () => {
    it("exports plan cycle statuses correctly", () => {
      expect(PLAN_CYCLE_STATUSES).toEqual(["active", "completed", "reviewed"]);
      for (const status of PLAN_CYCLE_STATUSES) {
        expect(PlanCycleStatusSchema.parse(status)).toBe(status);
      }
      expect(() => PlanCycleStatusSchema.parse("archived")).toThrow();
    });

    const createSampleDailyPlan = (dayNum: number): DailyPlan => ({
      dayNumber: dayNum,
      date: `2026-11-${String(dayNum).padStart(2, "0")}`,
      targetCaloriesKcal: 2000,
      targetProteinGrams: 150,
      targetCarbsGrams: 200,
      targetFatGrams: 60,
      loggedCaloriesKcal: 0,
      loggedProteinGrams: 0,
      loggedCarbsGrams: 0,
      loggedFatGrams: 0,
      exercises: [
        {
          id: `ex_${dayNum}`,
          name: "Push-Ups",
          category: "chest",
          sets: 3,
          reps: 10,
          completed: false
        }
      ],
      isFatigueScaled: false,
      completed: false
    });

    const create14DayCycle = (): AdaptivePlanCycle => ({
      id: "cycle_alpha_01",
      cycleNumber: 1,
      startDateMs: 1710000000000,
      endDateMs: 1711209600000,
      goal: "cut",
      baselineBiometrics: DEFAULT_BASELINE_BIOMETRICS,
      targetDailyCalories: 1950,
      targetDailyProteinGrams: 160,
      targetDailyCarbsGrams: 190,
      targetDailyFatGrams: 55,
      dailyPlans: Array.from({ length: 14 }, (_, i) => createSampleDailyPlan(i + 1)),
      status: "active"
    });

    it("accepts valid AdaptivePlanCycle with exactly 14 daily plans", () => {
      const cycle = create14DayCycle();
      const parsed = AdaptivePlanCycleSchema.parse(cycle);
      expect(parsed.id).toBe("cycle_alpha_01");
      expect(parsed.dailyPlans).toHaveLength(14);
      expect(parsed.targetDailyCalories).toBe(1950);
      expect(parsed.status).toBe("active");
    });

    it("rejects AdaptivePlanCycle if dailyPlans does not have exactly 14 items", () => {
      const cycle13 = {
        ...create14DayCycle(),
        dailyPlans: Array.from({ length: 13 }, (_, i) => createSampleDailyPlan(i + 1))
      };
      expect(() => AdaptivePlanCycleSchema.parse(cycle13)).toThrow();

      const cycle15 = {
        ...create14DayCycle(),
        dailyPlans: Array.from({ length: 15 }, (_, i) => createSampleDailyPlan(i + 1))
      };
      expect(() => AdaptivePlanCycleSchema.parse(cycle15)).toThrow();

      const cycleEmpty = {
        ...create14DayCycle(),
        dailyPlans: []
      };
      expect(() => AdaptivePlanCycleSchema.parse(cycleEmpty)).toThrow();
    });

    it("strictly enforces safe calorie floor (>= 1200 kcal/day) on targetDailyCalories", () => {
      const cycle = create14DayCycle();
      expect(
        AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCalories: 1200 })
      ).toBeDefined();
      expect(() =>
        AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCalories: 1199.9 })
      ).toThrow();
      expect(() =>
        AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCalories: 1000 })
      ).toThrow();
    });

    it("validates cycleNumber >= 1 integer and positive start/end dates", () => {
      const cycle = create14DayCycle();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, cycleNumber: 0 })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, cycleNumber: -1 })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, cycleNumber: 1.5 })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, startDateMs: 0 })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, endDateMs: -100 })).toThrow();
    });

    it("validates non-negative target daily macros", () => {
      const cycle = create14DayCycle();
      expect(() =>
        AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyProteinGrams: -1 })
      ).toThrow();
      expect(() =>
        AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCarbsGrams: -1 })
      ).toThrow();
      expect(() =>
        AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyFatGrams: -1 })
      ).toThrow();
    });

    it("rejects empty id string", () => {
      const cycle = create14DayCycle();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, id: "" })).toThrow();
    });

    it("rejects Infinity and -Infinity on cycle target daily metrics", () => {
      const cycle = create14DayCycle();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCalories: Infinity })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCalories: -Infinity })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyProteinGrams: Infinity })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyProteinGrams: -Infinity })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCarbsGrams: Infinity })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCarbsGrams: -Infinity })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyFatGrams: Infinity })).toThrow();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyFatGrams: -Infinity })).toThrow();
    });

    it("enforces upper boundaries on targetDailyCalories and macros", () => {
      const cycle = create14DayCycle();
      expect(AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCalories: 20_000 })).toBeDefined();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCalories: 20_000.1 })).toThrow();

      expect(AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyProteinGrams: 1000 })).toBeDefined();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyProteinGrams: 1000.1 })).toThrow();

      expect(AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCarbsGrams: 2000 })).toBeDefined();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyCarbsGrams: 2000.1 })).toThrow();

      expect(AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyFatGrams: 1000 })).toBeDefined();
      expect(() => AdaptivePlanCycleSchema.parse({ ...cycle, targetDailyFatGrams: 1000.1 })).toThrow();
    });
  });

  describe("MacroSplitSchema & PlanReviewStatusSchema", () => {
    it("validates valid MacroSplit and rejects negative macros", () => {
      const validSplit: MacroSplit = {
        proteinGrams: 160,
        carbsGrams: 200,
        fatGrams: 60
      };
      const parsed = MacroSplitSchema.parse(validSplit);
      expect(parsed.proteinGrams).toBe(160);

      expect(() => MacroSplitSchema.parse({ ...validSplit, proteinGrams: -1 })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, carbsGrams: -1 })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, fatGrams: -1 })).toThrow();
    });

    it("rejects Infinity, -Infinity, and values exceeding maximum bounds on MacroSplit", () => {
      const validSplit: MacroSplit = {
        proteinGrams: 160,
        carbsGrams: 200,
        fatGrams: 60
      };
      expect(() => MacroSplitSchema.parse({ ...validSplit, proteinGrams: Infinity })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, proteinGrams: -Infinity })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, proteinGrams: 1000.1 })).toThrow();
      expect(MacroSplitSchema.parse({ ...validSplit, proteinGrams: 1000 })).toBeDefined();

      expect(() => MacroSplitSchema.parse({ ...validSplit, carbsGrams: Infinity })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, carbsGrams: -Infinity })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, carbsGrams: 2000.1 })).toThrow();
      expect(MacroSplitSchema.parse({ ...validSplit, carbsGrams: 2000 })).toBeDefined();

      expect(() => MacroSplitSchema.parse({ ...validSplit, fatGrams: Infinity })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, fatGrams: -Infinity })).toThrow();
      expect(() => MacroSplitSchema.parse({ ...validSplit, fatGrams: 1000.1 })).toThrow();
      expect(MacroSplitSchema.parse({ ...validSplit, fatGrams: 1000 })).toBeDefined();
    });

    it("exports plan review statuses correctly", () => {
      expect(PLAN_REVIEW_STATUSES).toEqual(["pending", "approved", "rejected"]);
      for (const status of PLAN_REVIEW_STATUSES) {
        expect(PlanReviewStatusSchema.parse(status)).toBe(status);
      }
      expect(() => PlanReviewStatusSchema.parse("postponed")).toThrow();
    });
  });

  describe("ProposedPlanReviewSchema", () => {
    const validReview: ProposedPlanReview = {
      cycleId: "cycle_alpha_01",
      reviewDateMs: 1711209600000,
      adherencePct: 85.5,
      startingWeightKg: 72.0,
      currentWeightKg: 71.2,
      weightChangeKg: -0.8,
      rollingAverageWeightKg: 71.4,
      currentDailyCalories: 2100,
      proposedDailyCalories: 2000,
      calorieAdjustment: -100,
      currentMacroSplit: {
        proteinGrams: 160,
        carbsGrams: 220,
        fatGrams: 60
      },
      proposedMacroSplit: {
        proteinGrams: 160,
        carbsGrams: 195,
        fatGrams: 60
      },
      rationale: "Weight loss pace on track. Minor deficit adjustment to sustain fat loss.",
      status: "pending"
    };

    it("accepts valid ProposedPlanReview and trims rationale", () => {
      const parsed = ProposedPlanReviewSchema.parse({
        ...validReview,
        rationale: "  Weight loss pace on track. Minor deficit adjustment to sustain fat loss.  "
      });
      expect(parsed.rationale).toBe(
        "Weight loss pace on track. Minor deficit adjustment to sustain fat loss."
      );
      expect(parsed.weightChangeKg).toBe(-0.8);
      expect(parsed.calorieAdjustment).toBe(-100);
      expect(parsed.status).toBe("pending");
    });

    it("allows positive and negative weight changes and calorie adjustments", () => {
      const bulkReview: ProposedPlanReview = {
        ...validReview,
        weightChangeKg: 1.2,
        calorieAdjustment: 150,
        proposedDailyCalories: 2250,
        status: "approved"
      };
      const parsed = ProposedPlanReviewSchema.parse(bulkReview);
      expect(parsed.weightChangeKg).toBe(1.2);
      expect(parsed.calorieAdjustment).toBe(150);
      expect(parsed.proposedDailyCalories).toBe(2250);
      expect(parsed.status).toBe("approved");
    });

    it("rejects empty cycleId or empty rationale", () => {
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, cycleId: "" })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, rationale: "   " })).toThrow();
    });

    it("validates reviewDateMs positive integer", () => {
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, reviewDateMs: 0 })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, reviewDateMs: -100 })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, reviewDateMs: 123.45 })).toThrow();
    });

    it("validates adherencePct boundaries (0 to 100)", () => {
      expect(ProposedPlanReviewSchema.parse({ ...validReview, adherencePct: 0 })).toBeDefined();
      expect(ProposedPlanReviewSchema.parse({ ...validReview, adherencePct: 100 })).toBeDefined();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, adherencePct: -0.1 })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, adherencePct: 100.1 })).toThrow();
    });

    it("validates weight boundaries (30 to 300) for starting, current, and rollingAverage", () => {
      expect(() =>
        ProposedPlanReviewSchema.parse({ ...validReview, startingWeightKg: 29.9 })
      ).toThrow();
      expect(() =>
        ProposedPlanReviewSchema.parse({ ...validReview, startingWeightKg: 300.1 })
      ).toThrow();
      expect(() =>
        ProposedPlanReviewSchema.parse({ ...validReview, currentWeightKg: 29.9 })
      ).toThrow();
      expect(() =>
        ProposedPlanReviewSchema.parse({ ...validReview, currentWeightKg: 300.1 })
      ).toThrow();
      expect(() =>
        ProposedPlanReviewSchema.parse({ ...validReview, rollingAverageWeightKg: 29.9 })
      ).toThrow();
      expect(() =>
        ProposedPlanReviewSchema.parse({ ...validReview, rollingAverageWeightKg: 300.1 })
      ).toThrow();
    });

    it("strictly enforces safe calorie floor (>= 1200 kcal/day) on currentDailyCalories and proposedDailyCalories", () => {
      expect(
        ProposedPlanReviewSchema.parse({
          ...validReview,
          currentDailyCalories: 1200,
          proposedDailyCalories: 1200
        })
      ).toBeDefined();
      expect(() =>
        ProposedPlanReviewSchema.parse({
          ...validReview,
          currentDailyCalories: 1199.9
        })
      ).toThrow();
      expect(() =>
        ProposedPlanReviewSchema.parse({
          ...validReview,
          proposedDailyCalories: 1199.9
        })
      ).toThrow();
    });

    it("rejects invalid review status", () => {
      expect(() =>
        ProposedPlanReviewSchema.parse({
          ...validReview,
          status: "unknown" as PlanReviewStatus
        })
      ).toThrow();
    });

    it("rejects invalid macro split inside review", () => {
      expect(() =>
        ProposedPlanReviewSchema.parse({
          ...validReview,
          currentMacroSplit: { proteinGrams: -10, carbsGrams: 100, fatGrams: 50 }
        })
      ).toThrow();
      expect(() =>
        ProposedPlanReviewSchema.parse({
          ...validReview,
          proposedMacroSplit: { proteinGrams: 100, carbsGrams: -10, fatGrams: 50 }
        })
      ).toThrow();
    });

    it("rejects Infinity and -Infinity on numeric review metrics", () => {
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, adherencePct: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, adherencePct: -Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, startingWeightKg: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, startingWeightKg: -Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, currentWeightKg: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, currentWeightKg: -Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, weightChangeKg: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, weightChangeKg: -Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, rollingAverageWeightKg: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, rollingAverageWeightKg: -Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, currentDailyCalories: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, currentDailyCalories: -Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, proposedDailyCalories: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, proposedDailyCalories: -Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, calorieAdjustment: Infinity })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, calorieAdjustment: -Infinity })).toThrow();
    });

    it("enforces realistic boundaries on weightChangeKg, calorieAdjustment, and calories", () => {
      expect(ProposedPlanReviewSchema.parse({ ...validReview, weightChangeKg: -100 })).toBeDefined();
      expect(ProposedPlanReviewSchema.parse({ ...validReview, weightChangeKg: 100 })).toBeDefined();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, weightChangeKg: -100.1 })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, weightChangeKg: 100.1 })).toThrow();

      expect(ProposedPlanReviewSchema.parse({ ...validReview, calorieAdjustment: -5000 })).toBeDefined();
      expect(ProposedPlanReviewSchema.parse({ ...validReview, calorieAdjustment: 5000 })).toBeDefined();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, calorieAdjustment: -5000.1 })).toThrow();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, calorieAdjustment: 5000.1 })).toThrow();

      expect(ProposedPlanReviewSchema.parse({ ...validReview, currentDailyCalories: 20_000 })).toBeDefined();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, currentDailyCalories: 20_000.1 })).toThrow();
      expect(ProposedPlanReviewSchema.parse({ ...validReview, proposedDailyCalories: 20_000 })).toBeDefined();
      expect(() => ProposedPlanReviewSchema.parse({ ...validReview, proposedDailyCalories: 20_000.1 })).toThrow();
    });
  });

  describe("Empirical Challenger 2 Probes & Robustness Verification", () => {
    it("cleanly rejects Challenger 2 verbatim Infinity probes with safeParse returning false", () => {
      const dailyPlanResult = DailyPlanSchema.safeParse({
        dayNumber: 1,
        date: "2026-11-12",
        targetCaloriesKcal: Infinity,
        targetProteinGrams: 100,
        targetCarbsGrams: 100,
        targetFatGrams: 50,
        loggedCaloriesKcal: 0,
        loggedProteinGrams: 0,
        loggedCarbsGrams: 0,
        loggedFatGrams: 0,
        exercises: [],
        isFatigueScaled: false,
        completed: false
      });
      expect(dailyPlanResult.success).toBe(false);

      const foodPresetResult = FoodPresetItemSchema.safeParse({
        id: "f1",
        name: "Chicken",
        servingSizeGrams: Infinity,
        caloriesKcal: 165,
        proteinGrams: 31,
        carbsGrams: 0,
        fatGrams: 3.6
      });
      expect(foodPresetResult.success).toBe(false);

      const reviewResult = ProposedPlanReviewSchema.safeParse({
        cycleId: "c1",
        reviewDateMs: 1000,
        adherencePct: 90,
        startingWeightKg: 70,
        currentWeightKg: 68,
        weightChangeKg: Infinity,
        rollingAverageWeightKg: 69,
        currentDailyCalories: 2000,
        proposedDailyCalories: 1900,
        calorieAdjustment: -100,
        currentMacroSplit: { proteinGrams: 150, carbsGrams: 200, fatGrams: 60 },
        proposedMacroSplit: { proteinGrams: 150, carbsGrams: 200, fatGrams: 60 },
        rationale: "Good progress",
        status: "pending"
      });
      expect(reviewResult.success).toBe(false);
    });
  });
});
