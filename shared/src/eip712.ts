export type Address = `0x${string}`;
export type Bytes32 = `0x${string}`;
export type HexSignature = `0x${string}`;

export const DEHEALTH_EIP712_DOMAIN_NAME = "DeHealthProtocol" as const;
export const DEHEALTH_EIP712_VERSION = "1" as const;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614 as const;

export interface DeHealthEip712Domain {
  readonly name: typeof DEHEALTH_EIP712_DOMAIN_NAME;
  readonly version: typeof DEHEALTH_EIP712_VERSION;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface Eip712FieldDefinition {
  readonly name: string;
  readonly type: string;
}

export const WORKOUT_PROOF_EIP712_TYPES: {
  readonly WorkoutProof: readonly Eip712FieldDefinition[];
} = {
  WorkoutProof: [
    { name: "user", type: "address" },
    { name: "telemetryHash", type: "bytes32" },
    { name: "streakCount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

export interface WorkoutProof {
  readonly user: Address;
  readonly telemetryHash: Bytes32;
  readonly streakCount: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface SignedWorkoutClaimPayload {
  readonly proof: WorkoutProof;
  readonly signature: HexSignature;
}

export function createDeHealthDomain(
  verifyingContract: Address,
  chainId: number = ARBITRUM_SEPOLIA_CHAIN_ID
): DeHealthEip712Domain {
  return {
    name: DEHEALTH_EIP712_DOMAIN_NAME,
    version: DEHEALTH_EIP712_VERSION,
    chainId,
    verifyingContract
  };
}
