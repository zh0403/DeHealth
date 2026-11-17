import {
  Address,
  Bytes32,
  SignedWorkoutClaimPayload
} from "@dehealth/shared";
import {
  concat,
  Contract,
  ContractRunner,
  formatEther,
  getBytes,
  JsonRpcProvider,
  keccak256,
  Provider,
  Signer,
  toUtf8Bytes
} from "ethers";
import { verifyWorkoutProofSignature } from "./cryptoService";

export const DEMO_VERIFYING_CONTRACT: Address =
  "0x1111111111111111111111111111111111111111" as Address;

export const ARBISCAN_SEPOLIA_BASE_URL = "https://sepolia.arbiscan.io/tx";

export const DEHEALTH_REWARD_GATE_ABI = [
  "function nonces(address user) view returns (uint256)",
  "function claimStreakReward((address user, bytes32 telemetryHash, uint256 streakCount, uint256 nonce, uint256 deadline) proof, bytes signature) external",
  "function hashWorkoutProof((address user, bytes32 telemetryHash, uint256 streakCount, uint256 nonce, uint256 deadline) proof) view returns (bytes32)",
  "event StreakRewardClaimed(address indexed user, bytes32 indexed telemetryHash, uint256 streakCount, uint256 nonce, uint256 rewardAmount, bytes32 digest)"
] as const;

export const DEHEALTH_TOKEN_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
] as const;

export type L2ServiceMode = "live" | "local-fallback";

export interface ClaimStreakRewardResult {
  readonly txHash: string;
  readonly explorerUrl: string;
  readonly mode: L2ServiceMode;
}

export interface RewardGateContractMethods {
  nonces(user: Address): Promise<bigint | number | string>;
  claimStreakReward(
    proof: {
      user: Address;
      telemetryHash: Bytes32;
      streakCount: bigint;
      nonce: bigint;
      deadline: bigint;
    },
    signature: string
  ): Promise<{
    readonly hash: string;
    readonly wait: () => Promise<{ readonly hash?: string; readonly status?: number } | null>;
  }>;
}

export interface TokenContractMethods {
  balanceOf(user: Address): Promise<bigint | number | string>;
}

interface ConnectableSigner extends Signer {
  connect(provider: Provider): Signer;
}

function isConnectableSigner(signer: Signer): signer is ConnectableSigner {
  return (
    "connect" in signer &&
    typeof (signer as unknown as Record<string, unknown>).connect === "function"
  );
}

// Configurable state for runtime environments and hermetic unit test mocking
let customProvider: Provider | null | undefined = undefined;
let customGateAddress: Address | null | undefined = undefined;
let customTokenAddress: Address | null | undefined = undefined;
let customContractFactory:
  | ((address: string, abi: readonly string[], runner?: ContractRunner | null) => unknown)
  | null = null;

/**
 * Injects a custom Provider (used for mocking during unit testing).
 */
export function setL2Provider(provider: Provider | null | undefined): void {
  customProvider = provider;
}

/**
 * Injects a custom DeHealthRewardGate contract address.
 */
export function setRewardGateAddress(address: Address | null | undefined): void {
  customGateAddress = address;
}

/**
 * Injects a custom DeHealthToken ($DHT) contract address.
 */
export function setTokenAddress(address: Address | null | undefined): void {
  customTokenAddress = address;
}

/**
 * Injects a custom Contract factory for hermetic testing.
 */
export function setContractFactory(
  factory:
    | ((address: string, abi: readonly string[], runner?: ContractRunner | null) => unknown)
    | null
): void {
  customContractFactory = factory;
}

/**
 * Resets custom provider and address injections back to environment defaults.
 */
export function resetL2Config(): void {
  customProvider = undefined;
  customGateAddress = undefined;
  customTokenAddress = undefined;
  customContractFactory = null;
}

/**
 * Returns the active DeHealthRewardGate address or null if unconfigured.
 */
export function getRewardGateAddress(): Address | null {
  if (customGateAddress !== undefined) {
    return customGateAddress;
  }
  const addr = process.env.EXPO_PUBLIC_REWARD_GATE_ADDRESS?.trim();
  return addr && addr.length > 0 ? (addr as Address) : null;
}

/**
 * Returns the active DeHealthToken address or null if unconfigured.
 */
export function getTokenAddress(): Address | null {
  if (customTokenAddress !== undefined) {
    return customTokenAddress;
  }
  const addr = process.env.EXPO_PUBLIC_DHT_TOKEN_ADDRESS?.trim();
  return addr && addr.length > 0 ? (addr as Address) : null;
}

/**
 * Resolves or creates an L2 provider instance.
 * Returns null if RPC URL is unconfigured or invalid.
 */
export function getL2Provider(): Provider | null {
  if (customProvider !== undefined) {
    return customProvider;
  }
  const rpcUrl = process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL?.trim();
  if (!rpcUrl) {
    return null;
  }
  try {
    return new JsonRpcProvider(rpcUrl);
  } catch {
    return null;
  }
}

/**
 * Returns whether live Arbitrum Sepolia L2 contract connectivity is configured.
 */
export function isL2Configured(): boolean {
  const provider = getL2Provider();
  const gateAddress = getRewardGateAddress();
  return Boolean(provider && gateAddress);
}

/**
 * Instantiates or resolves a typed RewardGate contract interface.
 */
export function getRewardGateContract(
  gateAddress: Address,
  runner: ContractRunner
): RewardGateContractMethods {
  if (customContractFactory) {
    return customContractFactory(
      gateAddress,
      DEHEALTH_REWARD_GATE_ABI,
      runner
    ) as unknown as RewardGateContractMethods;
  }
  return new Contract(gateAddress, DEHEALTH_REWARD_GATE_ABI, runner) as unknown as RewardGateContractMethods;
}

/**
 * Instantiates or resolves a typed DeHealthToken contract interface.
 */
export function getTokenContract(
  tokenAddress: Address,
  runner: ContractRunner
): TokenContractMethods {
  if (customContractFactory) {
    return customContractFactory(
      tokenAddress,
      DEHEALTH_TOKEN_ABI,
      runner
    ) as unknown as TokenContractMethods;
  }
  return new Contract(tokenAddress, DEHEALTH_TOKEN_ABI, runner) as unknown as TokenContractMethods;
}

/**
 * Generates a deterministic simulated transaction hash for fallback mode from the proof.
 */
export function generateSimulatedTxHash(payload: SignedWorkoutClaimPayload): string {
  const seed = concat([
    toUtf8Bytes("simulated_l2_claim:"),
    getBytes(payload.proof.telemetryHash),
    toUtf8Bytes(payload.signature)
  ]);
  return keccak256(seed);
}

/**
 * Fetches the live on-chain nonce for the given user address from DeHealthRewardGate.
 * Falls back safely to localNonce if unconfigured or network is unreachable.
 */
export async function fetchOnChainNonce(
  userAddress: Address,
  localNonce?: bigint
): Promise<bigint> {
  const fallback = localNonce ?? 0n;
  if (!isL2Configured()) {
    return fallback;
  }

  try {
    const provider = getL2Provider();
    const gateAddress = getRewardGateAddress();
    if (!provider || !gateAddress) {
      return fallback;
    }

    const gateContract = getRewardGateContract(gateAddress, provider);
    const nonceResult = await gateContract.nonces(userAddress);
    return BigInt(String(nonceResult));
  } catch {
    return fallback;
  }
}

/**
 * Fetches the live on-chain $DHT token balance for the given user address.
 * Falls back safely to localBalance if unconfigured or network is unreachable.
 */
export async function fetchTokenBalance(
  userAddress: Address,
  localBalance?: string
): Promise<string> {
  const fallback = localBalance ?? "0.0";
  const provider = getL2Provider();
  const tokenAddress = getTokenAddress();

  if (!provider || !tokenAddress) {
    return fallback;
  }

  try {
    const tokenContract = getTokenContract(tokenAddress, provider);
    const balanceResult = await tokenContract.balanceOf(userAddress);
    const balanceBigInt = BigInt(String(balanceResult));
    return formatEther(balanceBigInt);
  } catch {
    return fallback;
  }
}

/**
 * Claims a streak reward:
 * 1. Executes local EIP-712 verification first to ensure cryptographic fail-closed safety.
 * 2. If live Arbitrum Sepolia RPC and RewardGate address are configured, submits on-chain transaction.
 * 3. If unconfigured, cleanly returns local EIP-712 verification and simulated receipt with Arbiscan link.
 */
export async function claimStreakReward(
  payload: SignedWorkoutClaimPayload,
  signer?: Signer
): Promise<ClaimStreakRewardResult> {
  const verifyingContract = getRewardGateAddress() || DEMO_VERIFYING_CONTRACT;
  const isSignatureValid = verifyWorkoutProofSignature(payload, verifyingContract);

  if (!isSignatureValid) {
    throw new Error(
      "Local EIP-712 signature verification failed: invalid signature or unauthorized signer"
    );
  }

  if (isL2Configured() && signer) {
    try {
      const gateAddress = getRewardGateAddress()!;
      const provider = getL2Provider();

      let effectiveSigner = signer;
      if (provider && isConnectableSigner(signer)) {
        if (signer.provider !== provider) {
          effectiveSigner = signer.connect(provider);
        }
      }

      const gateContract = getRewardGateContract(gateAddress, effectiveSigner);

      const proofStruct = {
        user: payload.proof.user,
        telemetryHash: payload.proof.telemetryHash,
        streakCount: payload.proof.streakCount,
        nonce: payload.proof.nonce,
        deadline: payload.proof.deadline
      };

      const tx = await gateContract.claimStreakReward(
        proofStruct,
        payload.signature
      );

      const receipt = await tx.wait();
      const txHash: string = receipt?.hash ?? tx.hash;

      return {
        txHash,
        explorerUrl: `${ARBISCAN_SEPOLIA_BASE_URL}/${txHash}`,
        mode: "live"
      };
    } catch (err: unknown) {
      // Re-throw genuine on-chain errors (e.g. SignatureReplay, InvalidNonce) to fail closed
      throw err;
    }
  }

  // Unconfigured fallback mode: verified offline EIP-712 commitment + simulated receipt
  const simulatedHash = generateSimulatedTxHash(payload);
  return {
    txHash: simulatedHash,
    explorerUrl: `${ARBISCAN_SEPOLIA_BASE_URL}/${simulatedHash}`,
    mode: "local-fallback"
  };
}
