import {
  Address,
  ARBITRUM_SEPOLIA_CHAIN_ID,
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
  parseEther,
  Provider,
  Signer,
  toUtf8Bytes
} from "ethers";
import { verifyWorkoutProofSignature } from "./cryptoService";

export const ZERO_ADDRESS: Address =
  "0x0000000000000000000000000000000000000000" as Address;

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export function isZeroAddress(address: string): boolean {
  return address.trim().toLowerCase() === ZERO_ADDRESS;
}

function normalizeConfiguredAddress(
  address: string | null | undefined
): Address | null {
  if (!address) {
    return null;
  }
  const trimmed = address.trim();
  if (!EVM_ADDRESS_REGEX.test(trimmed) || isZeroAddress(trimmed)) {
    return null;
  }
  return trimmed as Address;
}

export const DEMO_VERIFYING_CONTRACT: Address =
  "0x1111111111111111111111111111111111111111" as Address;

export const ARBISCAN_SEPOLIA_BASE_URL = "https://sepolia.arbiscan.io/tx";
export const ARBISCAN_SEPOLIA_ADDRESS_BASE_URL =
  "https://sepolia.arbiscan.io/address";

/**
 * Returns a clickable Arbiscan Sepolia contract/address explorer URL when
 * given a valid non-zero EVM address, or null otherwise.
 */
export function getArbiscanAddressUrl(address: Address | null): string | null {
  const normalized = normalizeConfiguredAddress(address);
  return normalized ? `${ARBISCAN_SEPOLIA_ADDRESS_BASE_URL}/${normalized}` : null;
}

export interface L2InspectorStatus {
  readonly networkLabel: "Arbitrum Sepolia 421614" | "Local Fallback";
  readonly chainId: number | null;
  readonly isLiveConfigured: boolean;
  readonly rewardGateAddress: Address | null;
  readonly tokenAddress: Address | null;
  readonly rewardGateExplorerUrl: string | null;
  readonly tokenExplorerUrl: string | null;
  readonly liveNonce: bigint | null;
  readonly rpcReachable: boolean;
}

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
  readonly explorerUrl: string | null;
  readonly mode: L2ServiceMode;
}

export const MIN_FALLBACK_GAS_BALANCE_WEI: bigint = parseEther("0.0001");

export const DEFAULT_INSUFFICIENT_GAS_MESSAGE =
  "Insufficient Arbitrum Sepolia ETH for gas. Copy your wallet address and fund testnet ETH.";

export const DEFAULT_ARBITRUM_SEPOLIA_FALLBACK_RPC_URLS: readonly string[] =
  Object.freeze([
    "https://arbitrum-sepolia-rpc.publicnode.com",
    "https://arbitrum-sepolia.drpc.org",
    "https://sepolia-rollup.arbitrum.io/rpc"
  ]);

export const DEFAULT_RPC_RATE_LIMIT_MESSAGE =
  "Arbitrum Sepolia RPC rate limit reached (HTTP 429). Please retry in a moment or configure a dedicated EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL.";

export interface RpcRateLimitErrorDetails {
  readonly endpoint?: string;
  readonly attempts?: number;
}

export class RpcRateLimitError extends Error {
  readonly endpoint?: string;
  readonly attempts?: number;

  constructor(
    message: string = DEFAULT_RPC_RATE_LIMIT_MESSAGE,
    details?: RpcRateLimitErrorDetails
  ) {
    super(message);
    this.name = "RpcRateLimitError";
    Object.setPrototypeOf(this, new.target.prototype);
    if (details?.endpoint !== undefined) {
      this.endpoint = details.endpoint;
    }
    if (details?.attempts !== undefined) {
      this.attempts = details.attempts;
    }
  }
}

const RATE_LIMIT_MESSAGE_REGEX = /\b429\b|too many requests|rate[- ]?limit|throttl/i;
const MAX_RATE_LIMIT_INSPECT_DEPTH = 8;

/**
 * Inspects an unknown error and its nested `error`/`cause`/`info`/`response`
 * objects (cycle-safe, depth-bounded) to determine whether it represents an
 * HTTP 429 / RPC rate-limit / throttling failure.
 */
export function isRateLimitRpcError(error: unknown): boolean {
  const visited = new WeakSet<object>();

  const inspect = (value: unknown, depth: number): boolean => {
    if (value === null || value === undefined || depth > MAX_RATE_LIMIT_INSPECT_DEPTH) {
      return false;
    }
    if (value instanceof RpcRateLimitError) {
      return true;
    }
    if (typeof value === "string") {
      return RATE_LIMIT_MESSAGE_REGEX.test(value);
    }
    if (typeof value !== "object") {
      return false;
    }
    if (visited.has(value)) {
      return false;
    }
    visited.add(value);

    const record = value as Record<string, unknown>;
    if (record.name === "RpcRateLimitError") {
      return true;
    }
    if (record.status === 429 || record.statusCode === 429) {
      return true;
    }
    if (
      record.code === 429 ||
      record.code === -32005 ||
      record.code === "RATE_LIMITED"
    ) {
      return true;
    }
    if (
      record.responseStatus === 429 ||
      (typeof record.responseStatus === "string" &&
        record.responseStatus.includes("429"))
    ) {
      return true;
    }
    if (
      typeof record.message === "string" &&
      RATE_LIMIT_MESSAGE_REGEX.test(record.message)
    ) {
      return true;
    }
    if (
      typeof record.shortMessage === "string" &&
      RATE_LIMIT_MESSAGE_REGEX.test(record.shortMessage)
    ) {
      return true;
    }

    const nestedKeys = ["error", "cause", "info", "response"] as const;
    for (const key of nestedKeys) {
      if (key in record && inspect(record[key], depth + 1)) {
        return true;
      }
    }

    return false;
  };

  return inspect(error, 0);
}

export interface InsufficientGasErrorDetails {
  readonly signerAddress?: Address;
  readonly balanceWei?: bigint;
  readonly requiredWei?: bigint;
}

export class InsufficientGasError extends Error {
  readonly signerAddress?: Address;
  readonly balanceWei?: bigint;
  readonly requiredWei?: bigint;

  constructor(
    message: string = DEFAULT_INSUFFICIENT_GAS_MESSAGE,
    details?: InsufficientGasErrorDetails
  ) {
    super(message);
    this.name = "InsufficientGasError";
    Object.setPrototypeOf(this, new.target.prototype);
    if (details?.signerAddress !== undefined) {
      this.signerAddress = details.signerAddress;
    }
    if (details?.balanceWei !== undefined) {
      this.balanceWei = details.balanceWei;
    }
    if (details?.requiredWei !== undefined) {
      this.requiredWei = details.requiredWei;
    }
  }
}

export interface RewardGateProofArg {
  readonly user: Address;
  readonly telemetryHash: Bytes32;
  readonly streakCount: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface RewardGateClaimTxResponse {
  readonly hash: string;
  readonly wait: () => Promise<{ readonly hash?: string; readonly status?: number } | null>;
}

export interface RewardGateClaimMethod {
  (
    proof: RewardGateProofArg,
    signature: string
  ): Promise<RewardGateClaimTxResponse>;
  estimateGas?: (
    proof: RewardGateProofArg,
    signature: string
  ) => Promise<bigint>;
}

export interface RewardGateContractMethods {
  nonces(user: Address): Promise<bigint | number | string>;
  claimStreakReward: RewardGateClaimMethod;
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
let customFallbackRpcUrls: readonly string[] | undefined = undefined;
let customProviderFactory: ((rpcUrl: string) => Provider) | null = null;
let customRetryDelay: ((ms: number) => Promise<void>) | null = null;
let activeRpcIndex = 0;

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
 * Overrides fallback Arbitrum Sepolia RPC URLs for hermetic unit testing.
 */
export function setL2FallbackRpcUrlsForTesting(urls?: readonly string[]): void {
  customFallbackRpcUrls = urls;
}

/**
 * Injects a custom provider factory `(rpcUrl) => Provider` for hermetic testing.
 */
export function setL2ProviderFactoryForTesting(
  factory: ((rpcUrl: string) => Provider) | null
): void {
  customProviderFactory = factory;
}

/**
 * Injects a custom retry delay implementation for hermetic testing.
 */
export function setL2RetryDelayForTesting(
  delayFn: ((ms: number) => Promise<void>) | null
): void {
  customRetryDelay = delayFn;
}

/**
 * Resets custom provider and address injections back to environment defaults.
 */
export function resetL2Config(): void {
  customProvider = undefined;
  customGateAddress = undefined;
  customTokenAddress = undefined;
  customContractFactory = null;
  customFallbackRpcUrls = undefined;
  customProviderFactory = null;
  customRetryDelay = null;
  activeRpcIndex = 0;
}

/**
 * Returns the active DeHealthRewardGate address or null if unconfigured,
 * invalid, or equal to the zero placeholder address (0x000...0).
 */
export function getRewardGateAddress(): Address | null {
  if (customGateAddress !== undefined) {
    return normalizeConfiguredAddress(customGateAddress);
  }
  return normalizeConfiguredAddress(process.env.EXPO_PUBLIC_REWARD_GATE_ADDRESS);
}

/**
 * Returns the active DeHealthToken address or null if unconfigured,
 * invalid, or equal to the zero placeholder address (0x000...0).
 */
export function getTokenAddress(): Address | null {
  if (customTokenAddress !== undefined) {
    return normalizeConfiguredAddress(customTokenAddress);
  }
  return normalizeConfiguredAddress(process.env.EXPO_PUBLIC_DHT_TOKEN_ADDRESS);
}

/**
 * Returns the deduplicated ordered list of Arbitrum Sepolia RPC URLs
 * (`[primaryUrl, ...fallbackUrls]`) when `EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL`
 * is configured, or `[]` when unset/blank so offline/local-fallback mode remains intact.
 */
export function getL2RpcUrls(): readonly string[] {
  const primaryUrl = process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL?.trim();
  if (!primaryUrl) {
    return [];
  }

  const fallbacks =
    customFallbackRpcUrls ?? DEFAULT_ARBITRUM_SEPOLIA_FALLBACK_RPC_URLS;
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const candidate of [primaryUrl, ...fallbacks]) {
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      ordered.push(trimmed);
    }
  }

  return ordered;
}

function createProviderForUrl(rpcUrl: string): Provider | null {
  try {
    return customProviderFactory
      ? customProviderFactory(rpcUrl)
      : new JsonRpcProvider(rpcUrl);
  } catch {
    return null;
  }
}

/**
 * Resolves or creates an L2 provider instance.
 * Returns null if RPC URL is unconfigured or invalid.
 */
export function getL2Provider(): Provider | null {
  if (customProvider !== undefined) {
    return customProvider;
  }
  const rpcUrls = getL2RpcUrls();
  if (rpcUrls.length === 0) {
    return null;
  }
  const index =
    activeRpcIndex >= 0 && activeRpcIndex < rpcUrls.length ? activeRpcIndex : 0;
  const targetUrl = rpcUrls[index];
  return targetUrl ? createProviderForUrl(targetUrl) : null;
}

const RPC_MAX_RETRIES_PER_ENDPOINT = 2;
const RPC_BASE_DELAY_MS = 200;
const RPC_MAX_DELAY_MS = 1600;

function waitRetryDelay(ms: number): Promise<void> {
  if (customRetryDelay) {
    return customRetryDelay(ms);
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface RpcCandidate {
  readonly provider: Provider;
  readonly endpoint: string;
  readonly rpcIndex: number;
}

function resolveRpcCandidates(): readonly RpcCandidate[] {
  if (customProvider !== undefined) {
    return customProvider
      ? [{ provider: customProvider, endpoint: "custom-provider", rpcIndex: -1 }]
      : [];
  }

  const rpcUrls = getL2RpcUrls();
  if (rpcUrls.length === 0) {
    return [];
  }

  const startIdx =
    activeRpcIndex >= 0 && activeRpcIndex < rpcUrls.length ? activeRpcIndex : 0;
  const candidates: RpcCandidate[] = [];

  for (let offset = 0; offset < rpcUrls.length; offset++) {
    const idx = (startIdx + offset) % rpcUrls.length;
    const endpoint = rpcUrls[idx];
    if (!endpoint) {
      continue;
    }
    const provider = createProviderForUrl(endpoint);
    if (provider) {
      candidates.push({ provider, endpoint, rpcIndex: idx });
    }
  }

  return candidates;
}

/**
 * Executes an RPC operation with bounded exponential backoff on HTTP 429 /
 * rate-limit errors and automatic failover across configured Arbitrum Sepolia
 * fallback endpoints. Non-rate-limit errors are rethrown immediately.
 */
export async function executeWithRpcResilience<T>(
  operation: (provider: Provider, endpoint: string) => Promise<T>
): Promise<T> {
  const candidates = resolveRpcCandidates();
  if (candidates.length === 0) {
    throw new Error("No Arbitrum Sepolia RPC provider is configured.");
  }

  let totalAttempts = 0;
  let lastEndpoint = candidates[0]!.endpoint;
  let sawRateLimit = false;

  for (const candidate of candidates) {
    for (let attempt = 0; attempt <= RPC_MAX_RETRIES_PER_ENDPOINT; attempt++) {
      totalAttempts += 1;
      lastEndpoint = candidate.endpoint;
      try {
        const result = await operation(candidate.provider, candidate.endpoint);
        if (candidate.rpcIndex >= 0) {
          activeRpcIndex = candidate.rpcIndex;
        }
        return result;
      } catch (err: unknown) {
        if (!isRateLimitRpcError(err)) {
          throw err;
        }
        sawRateLimit = true;
        if (attempt < RPC_MAX_RETRIES_PER_ENDPOINT) {
          const delayMs = Math.min(
            RPC_MAX_DELAY_MS,
            RPC_BASE_DELAY_MS * 2 ** attempt
          );
          await waitRetryDelay(delayMs);
        }
      }
    }
  }

  if (sawRateLimit) {
    throw new RpcRateLimitError(DEFAULT_RPC_RATE_LIMIT_MESSAGE, {
      endpoint: lastEndpoint,
      attempts: totalAttempts
    });
  }

  throw new Error("All Arbitrum Sepolia RPC endpoints failed.");
}

async function waitForTxReceiptWithRetry(
  tx: RewardGateClaimTxResponse
): Promise<{ readonly hash?: string; readonly status?: number } | null> {
  let totalAttempts = 0;
  for (let attempt = 0; attempt <= RPC_MAX_RETRIES_PER_ENDPOINT; attempt++) {
    totalAttempts += 1;
    try {
      return await tx.wait();
    } catch (err: unknown) {
      if (!isRateLimitRpcError(err)) {
        throw err;
      }
      if (attempt < RPC_MAX_RETRIES_PER_ENDPOINT) {
        const delayMs = Math.min(
          RPC_MAX_DELAY_MS,
          RPC_BASE_DELAY_MS * 2 ** attempt
        );
        await waitRetryDelay(delayMs);
      } else {
        throw new RpcRateLimitError(DEFAULT_RPC_RATE_LIMIT_MESSAGE, {
          attempts: totalAttempts
        });
      }
    }
  }
  throw new RpcRateLimitError(DEFAULT_RPC_RATE_LIMIT_MESSAGE, {
    attempts: totalAttempts
  });
}

/**
 * Returns whether live Arbitrum Sepolia L2 contract connectivity is configured
 * with a non-zero contract address.
 */
export function isL2Configured(): boolean {
  const provider = getL2Provider();
  const gateAddress = getRewardGateAddress();
  return Boolean(provider && gateAddress && !isZeroAddress(gateAddress));
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
    const gateAddress = getRewardGateAddress();
    if (!gateAddress) {
      return fallback;
    }

    return await executeWithRpcResilience(async (provider) =>
      BigInt(String(await getRewardGateContract(gateAddress, provider).nonces(userAddress)))
    );
  } catch {
    return fallback;
  }
}

/**
 * Queries live Arbitrum Sepolia network/contract inspector status without
 * masking RPC failures as `0n`. Distinguishes `"Arbitrum Sepolia 421614"` vs
 * `"Local Fallback"`, exposes valid contract explorer URLs, and reports
 * `rpcReachable: false` + `liveNonce: null` when RPC is unconfigured or offline.
 */
export async function fetchLiveL2InspectorStatus(
  userAddress: Address
): Promise<L2InspectorStatus> {
  const provider = getL2Provider();
  const rewardGateAddress = getRewardGateAddress();
  const tokenAddress = getTokenAddress();
  const liveConfigured = Boolean(
    provider && rewardGateAddress && !isZeroAddress(rewardGateAddress)
  );
  const networkLabel = liveConfigured
    ? "Arbitrum Sepolia 421614"
    : "Local Fallback";
  const chainId = liveConfigured ? ARBITRUM_SEPOLIA_CHAIN_ID : null;
  const rewardGateExplorerUrl = getArbiscanAddressUrl(rewardGateAddress);
  const tokenExplorerUrl = getArbiscanAddressUrl(tokenAddress);

  let liveNonce: bigint | null = null;
  let rpcReachable = false;

  if (provider && rewardGateAddress) {
    try {
      const nonceResult = await executeWithRpcResilience(async (activeProvider) =>
        getRewardGateContract(rewardGateAddress, activeProvider).nonces(userAddress)
      );
      liveNonce = BigInt(String(nonceResult));
      rpcReachable = true;
    } catch {
      liveNonce = null;
      rpcReachable = false;
    }
  } else if (provider) {
    try {
      const txCount = await executeWithRpcResilience(async (activeProvider) =>
        activeProvider.getTransactionCount(userAddress)
      );
      liveNonce = BigInt(txCount);
      rpcReachable = true;
    } catch {
      liveNonce = null;
      rpcReachable = false;
    }
  }

  return {
    networkLabel,
    chainId,
    isLiveConfigured: liveConfigured,
    rewardGateAddress,
    tokenAddress,
    rewardGateExplorerUrl,
    tokenExplorerUrl,
    liveNonce,
    rpcReachable
  };
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
    const balanceResult = await executeWithRpcResilience(async (activeProvider) =>
      getTokenContract(tokenAddress, activeProvider).balanceOf(userAddress)
    );
    const balanceBigInt = BigInt(String(balanceResult));
    return formatEther(balanceBigInt);
  } catch {
    return fallback;
  }
}

/**
 * Formats an Arbitrum Sepolia native ETH balance (in wei) cleanly for UI display.
 */
export function formatNativeEthBalance(balanceWei: bigint): string {
  if (balanceWei <= 0n) {
    return "0.0000";
  }
  const etherStr = formatEther(balanceWei);
  const numeric = Number(etherStr);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0.0000";
  }
  return numeric >= 0.0001 ? numeric.toFixed(4) : numeric.toFixed(6);
}

/**
 * Fetches the live Arbitrum Sepolia native `$ETH` gas balance for `userAddress`
 * using `executeWithRpcResilience`. Falls back safely to `localBalance` or `"0.0000"`.
 */
export async function fetchNativeEthBalance(
  userAddress: Address,
  localBalance?: string
): Promise<string> {
  const fallback = localBalance ?? "0.0000";
  if (!getL2Provider()) {
    return fallback;
  }

  try {
    const balanceWei = await executeWithRpcResilience(async (activeProvider) => {
      if (typeof activeProvider.getBalance !== "function") {
        throw new Error("L2 provider does not support getBalance.");
      }
      return BigInt(await activeProvider.getBalance(userAddress));
    });
    return formatNativeEthBalance(balanceWei);
  } catch {
    return fallback;
  }
}

/**
 * Returns true when a formatted ETH balance string is below `minGasWei`
 * (defaults to `MIN_FALLBACK_GAS_BALANCE_WEI`, i.e. 0.0001 ETH).
 */
export function isLowGasEthBalance(
  ethBalance: string | null | undefined,
  minGasWei: bigint = MIN_FALLBACK_GAS_BALANCE_WEI
): boolean {
  if (ethBalance === null || ethBalance === undefined) {
    return false;
  }
  const trimmed = ethBalance.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    return parseEther(trimmed) < minGasWei;
  } catch {
    const numeric = Number(trimmed);
    const minNumeric = Number(formatEther(minGasWei));
    return Number.isFinite(numeric) && numeric < minNumeric;
  }
}

function isValidSigner(signer: Signer | null | undefined): signer is Signer {
  return (
    signer !== null &&
    signer !== undefined &&
    typeof signer.getAddress === "function" &&
    typeof signer.signTypedData === "function" &&
    typeof signer.sendTransaction === "function"
  );
}

/**
 * Claims a streak reward:
 * 1. Executes local EIP-712 verification first to ensure cryptographic fail-closed safety.
 * 2. If live Arbitrum Sepolia RPC and RewardGate address are configured, requires a valid signer
 *    (throwing an explicit Error if missing/invalid) and submits the on-chain transaction.
 * 3. If unconfigured, returns local EIP-712 verification and simulated receipt with explorerUrl: null.
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

  if (isL2Configured()) {
    if (!isValidSigner(signer)) {
      throw new Error(
        "L2 contract submission requires a valid signer when Arbitrum Sepolia is configured."
      );
    }

    const gateAddress = getRewardGateAddress()!;

    const proofStruct: RewardGateProofArg = {
      user: payload.proof.user,
      telemetryHash: payload.proof.telemetryHash,
      streakCount: payload.proof.streakCount,
      nonce: payload.proof.nonce,
      deadline: payload.proof.deadline
    };

    const tx = await executeWithRpcResilience(async (provider) => {
      let effectiveSigner = signer;
      if (isConnectableSigner(signer) && signer.provider !== provider) {
        effectiveSigner = signer.connect(provider);
      }

      const gateContract = getRewardGateContract(gateAddress, effectiveSigner);
      const signerAddress = (await effectiveSigner.getAddress()) as Address;
      const claimFn = gateContract.claimStreakReward;

      if (typeof provider.getBalance === "function") {
        const balanceWei = BigInt(await provider.getBalance(signerAddress));
        let requiredWei = MIN_FALLBACK_GAS_BALANCE_WEI;

        if (typeof claimFn.estimateGas === "function") {
          try {
            const estimatedGas = BigInt(
              await claimFn.estimateGas(proofStruct, payload.signature)
            );
            if (estimatedGas > 0n && typeof provider.getFeeData === "function") {
              const feeData = await provider.getFeeData();
              const maxFee = feeData?.maxFeePerGas;
              const legacyGasPrice = feeData?.gasPrice;
              const gasPrice =
                maxFee !== null && maxFee !== undefined && maxFee > 0n
                  ? maxFee
                  : (legacyGasPrice ?? 0n);
              const estimatedCostWei = estimatedGas * gasPrice;
              if (estimatedCostWei > requiredWei) {
                requiredWei = estimatedCostWei;
              }
            }
          } catch (estErr: unknown) {
            if (isRateLimitRpcError(estErr)) {
              throw estErr;
            }
            const estMsg =
              estErr instanceof Error ? estErr.message : String(estErr);
            const isInsufficientFunds =
              (typeof estErr === "object" &&
                estErr !== null &&
                "code" in estErr &&
                (estErr as { readonly code?: unknown }).code ===
                  "INSUFFICIENT_FUNDS") ||
              /insufficient\s+funds|not\s+enough\s+funds/i.test(estMsg);

            if (balanceWei < MIN_FALLBACK_GAS_BALANCE_WEI || isInsufficientFunds) {
              const details: InsufficientGasErrorDetails =
                balanceWei < MIN_FALLBACK_GAS_BALANCE_WEI
                  ? {
                      signerAddress,
                      balanceWei,
                      requiredWei: MIN_FALLBACK_GAS_BALANCE_WEI
                    }
                  : {
                      signerAddress,
                      balanceWei
                    };
              throw new InsufficientGasError(
                DEFAULT_INSUFFICIENT_GAS_MESSAGE,
                details
              );
            }
          }
        }

        if (balanceWei < requiredWei) {
          throw new InsufficientGasError(DEFAULT_INSUFFICIENT_GAS_MESSAGE, {
            signerAddress,
            balanceWei,
            requiredWei
          });
        }
      }

      return gateContract.claimStreakReward(proofStruct, payload.signature);
    });

    const receipt = await waitForTxReceiptWithRetry(tx);
    const txHash: string = receipt?.hash ?? tx.hash;

    return {
      txHash,
      explorerUrl: `${ARBISCAN_SEPOLIA_BASE_URL}/${txHash}`,
      mode: "live"
    };
  }

  // Unconfigured fallback mode: verified offline EIP-712 commitment + simulated receipt (no fake explorer URL)
  const simulatedHash = generateSimulatedTxHash(payload);
  return {
    txHash: simulatedHash,
    explorerUrl: null,
    mode: "local-fallback"
  };
}
