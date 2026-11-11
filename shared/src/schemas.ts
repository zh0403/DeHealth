import { z } from "zod";
import {
  Address,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32,
  DEHEALTH_EIP712_DOMAIN_NAME,
  DEHEALTH_EIP712_VERSION,
  DeHealthEip712Domain,
  HexSignature,
  SignedWorkoutClaimPayload,
  WorkoutProof
} from "./eip712";
import { TelemetryData, UserProfile } from "./profile";

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_REGEX = /^0x[a-fA-F0-9]{64}$/;
const SIGNATURE_REGEX = /^0x[a-fA-F0-9]{130}$/;
const DECIMAL_UINT_REGEX = /^\d+$/;
const MAX_UINT256 = (1n << 256n) - 1n;

export const AddressSchema: z.ZodEffects<z.ZodString, Address, string> = z
  .string()
  .regex(ADDRESS_REGEX, "Invalid EVM address format (expected 0x followed by 40 hex chars)")
  .transform((val) => val as Address);

export const Bytes32Schema: z.ZodEffects<z.ZodString, Bytes32, string> = z
  .string()
  .regex(BYTES32_REGEX, "Invalid bytes32 format (expected 0x followed by 64 hex chars)")
  .transform((val) => val as Bytes32);

export const HexSignatureSchema: z.ZodEffects<z.ZodString, HexSignature, string> = z
  .string()
  .regex(SIGNATURE_REGEX, "Invalid 65-byte ECDSA hex signature")
  .transform((val) => val as HexSignature);

export const Uint256Schema = z
  .union([
    z.bigint(),
    z.number().int().nonnegative(),
    z.string().regex(DECIMAL_UINT_REGEX, "Expected non-negative integer string")
  ])
  .transform((val, ctx) => {
    const converted = BigInt(val);
    if (converted < 0n || converted > MAX_UINT256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Value out of uint256 bounds"
      });
      return z.NEVER;
    }
    return converted;
  });

export const UserProfileSchema: z.ZodType<UserProfile> = z.object({
  age: z.number().int().min(13).max(120),
  gender: z.string().trim().min(1).max(32),
  bodyFatPct: z.number().min(2).max(75),
  muscleMassKg: z.number().min(10).max(150)
});

export const TelemetryDataSchema: z.ZodType<TelemetryData> = z.object({
  timestampMs: z.number().int().positive(),
  stepCount: z.number().int().min(0).max(200_000),
  activeMinutes: z.number().int().min(0).max(1_440),
  avgHeartRateBpm: z.number().min(30).max(240),
  caloriesBurnedKcal: z.number().min(0).max(25_000),
  profileSnapshot: UserProfileSchema
});

export const Eip712DomainSchema: z.ZodType<
  DeHealthEip712Domain,
  z.ZodTypeDef,
  {
    name: typeof DEHEALTH_EIP712_DOMAIN_NAME;
    version: typeof DEHEALTH_EIP712_VERSION;
    chainId?: number;
    verifyingContract: string;
  }
> = z.object({
  name: z.literal(DEHEALTH_EIP712_DOMAIN_NAME),
  version: z.literal(DEHEALTH_EIP712_VERSION),
  chainId: z.number().int().positive().default(ARBITRUM_SEPOLIA_CHAIN_ID),
  verifyingContract: AddressSchema
});

export const WorkoutProofSchema: z.ZodType<
  WorkoutProof,
  z.ZodTypeDef,
  {
    user: string;
    telemetryHash: string;
    streakCount: bigint | number | string;
    nonce: bigint | number | string;
    deadline: bigint | number | string;
  }
> = z.object({
  user: AddressSchema,
  telemetryHash: Bytes32Schema,
  streakCount: Uint256Schema,
  nonce: Uint256Schema,
  deadline: Uint256Schema
});

export const SignedWorkoutClaimPayloadSchema: z.ZodType<
  SignedWorkoutClaimPayload,
  z.ZodTypeDef,
  {
    proof: {
      user: string;
      telemetryHash: string;
      streakCount: bigint | number | string;
      nonce: bigint | number | string;
      deadline: bigint | number | string;
    };
    signature: string;
  }
> = z.object({
  proof: WorkoutProofSchema,
  signature: HexSignatureSchema
});

export const AnonymizedFeedInsertSchema = z.object({
  user_pseudonym: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "Pseudonym must be alphanumeric with underscores or hyphens"),
  proof_hash: Bytes32Schema,
  streak_count: z.number().int().min(1).max(10_000)
});

export const PeerCheerInsertSchema = z.object({
  feed_id: z.string().uuid(),
  sender_pseudonym: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "Pseudonym must be alphanumeric with underscores or hyphens")
});
