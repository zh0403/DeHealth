import {
  Address,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32,
  Bytes32Schema,
  createDeHealthDomain,
  SignedWorkoutClaimPayload,
  SignedWorkoutClaimPayloadSchema,
  TelemetryData,
  TelemetryDataSchema,
  WORKOUT_PROOF_EIP712_TYPES,
  WorkoutProof,
  WorkoutProofSchema
} from "@dehealth/shared";
import {
  concat,
  getBytes,
  hexlify,
  keccak256,
  randomBytes,
  Signer,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData
} from "ethers";

export type TypedDataSigner = Signer;

function getMutableWorkoutProofTypes(): {
  WorkoutProof: Array<{ name: string; type: string }>;
} {
  return {
    WorkoutProof: WORKOUT_PROOF_EIP712_TYPES.WorkoutProof.map((field) => ({
      name: field.name,
      type: field.type
    }))
  };
}

export const TELEMETRY_COMMITMENT_DOMAIN = "dehealth.telemetry.commitment.v2";

export interface TelemetryCommitment {
  readonly telemetryHash: Bytes32;
  readonly salt: Bytes32;
}

/**
 * Generates a fresh 32-byte random salt for one telemetry commitment.
 */
export function generateTelemetrySalt(): Bytes32 {
  return hexlify(randomBytes(32)) as Bytes32;
}

function canonicalizeTelemetry(validated: TelemetryData): string {
  return JSON.stringify({
    timestampMs: validated.timestampMs,
    stepCount: validated.stepCount,
    activeMinutes: validated.activeMinutes,
    avgHeartRateBpm: Number(validated.avgHeartRateBpm.toFixed(2)),
    caloriesBurnedKcal: Number(validated.caloriesBurnedKcal.toFixed(2)),
    profileSnapshot: {
      age: validated.profileSnapshot.age,
      gender: validated.profileSnapshot.gender.toLowerCase(),
      bodyFatPct: Number(validated.profileSnapshot.bodyFatPct.toFixed(2)),
      muscleMassKg: Number(validated.profileSnapshot.muscleMassKg.toFixed(2))
    }
  });
}

function computeCommitment(validated: TelemetryData, salt: Bytes32): Bytes32 {
  // Fixed-length prefix + fixed-length salt + variable payload: no ambiguity
  // between where one field ends and the next begins.
  return keccak256(
    concat([
      toUtf8Bytes(TELEMETRY_COMMITMENT_DOMAIN),
      getBytes(salt),
      toUtf8Bytes(canonicalizeTelemetry(validated))
    ])
  ) as Bytes32;
}

/**
 * Produces a salted Keccak-256 commitment to canonical TelemetryData.
 *
 * Without a salt, the preimage space (a few bounded integers plus a known claim
 * time) is small enough to brute-force from a published hash. A per-claim random
 * 32-byte salt makes the digest infeasible to reverse or rainbow-table.
 *
 * The caller must store `salt` locally (encrypted) if it ever wants to reveal
 * and verify the commitment later. Pass an explicit `salt` only for
 * deterministic tests; production callers should let one be generated.
 */
export function hashTelemetry(
  metrics: TelemetryData,
  salt?: Bytes32
): TelemetryCommitment {
  const validated = TelemetryDataSchema.parse(metrics);
  const effectiveSalt = salt !== undefined ? Bytes32Schema.parse(salt) : generateTelemetrySalt();
  return {
    telemetryHash: computeCommitment(validated, effectiveSalt),
    salt: effectiveSalt
  };
}

/**
 * Verifies that `telemetryHash` is the commitment to `metrics` under `salt`.
 */
export function verifyTelemetryCommitment(
  metrics: TelemetryData,
  salt: Bytes32,
  telemetryHash: Bytes32
): boolean {
  try {
    const validated = TelemetryDataSchema.parse(metrics);
    const expected = computeCommitment(validated, Bytes32Schema.parse(salt));
    return expected.toLowerCase() === Bytes32Schema.parse(telemetryHash).toLowerCase();
  } catch {
    return false;
  }
}
/**
 * Computes the EIP-712 typed data digest for a WorkoutProof struct.
 */
export function computeWorkoutProofDigest(
  proof: WorkoutProof,
  verifyingContract: Address,
  chainId: number = ARBITRUM_SEPOLIA_CHAIN_ID
): Bytes32 {
  const validatedProof = WorkoutProofSchema.parse(proof);
  const domain = createDeHealthDomain(verifyingContract, chainId);
  const types = getMutableWorkoutProofTypes();

  return TypedDataEncoder.hash(domain, types, validatedProof) as Bytes32;
}

/**
 * Signs a WorkoutProof using EIP-712 typed data signing via ethers.js v6.
 */
export async function signWorkoutProof(
  signer: Signer,
  proof: WorkoutProof,
  verifyingContract: Address,
  chainId: number = ARBITRUM_SEPOLIA_CHAIN_ID
): Promise<SignedWorkoutClaimPayload> {
  const validatedProof = WorkoutProofSchema.parse(proof);
  const domain = createDeHealthDomain(verifyingContract, chainId);
  const types = getMutableWorkoutProofTypes();

  const rawSignature = await signer.signTypedData(
    domain,
    types,
    validatedProof as unknown as Record<string, unknown>
  );

  return SignedWorkoutClaimPayloadSchema.parse({
    proof: validatedProof,
    signature: rawSignature
  });
}

/**
 * Recovers the signer address from a SignedWorkoutClaimPayload and verifies
 * that it matches proof.user.
 */
export function verifyWorkoutProofSignature(
  payload: SignedWorkoutClaimPayload,
  verifyingContract: Address,
  chainId: number = ARBITRUM_SEPOLIA_CHAIN_ID
): boolean {
  try {
    const validated = SignedWorkoutClaimPayloadSchema.parse(payload);
    const domain = createDeHealthDomain(verifyingContract, chainId);
    const types = getMutableWorkoutProofTypes();

    const recovered = verifyTypedData(
      domain,
      types,
      validated.proof as unknown as Record<string, unknown>,
      validated.signature
    );

    return recovered.toLowerCase() === validated.proof.user.toLowerCase();
  } catch {
    return false;
  }
}
