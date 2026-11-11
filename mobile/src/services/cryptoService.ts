import {
  Address,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32,
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
  keccak256,
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

/**
 * Produces a deterministic canonical JSON representation of TelemetryData
 * and hashes it using real Keccak-256.
 */
export function hashTelemetry(metrics: TelemetryData): Bytes32 {
  const validated = TelemetryDataSchema.parse(metrics);
  const canonicalPayload = JSON.stringify({
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

  return keccak256(toUtf8Bytes(canonicalPayload)) as Bytes32;
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
