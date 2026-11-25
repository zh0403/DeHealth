import { Address, Bytes32, SignedWorkoutClaimPayload, WorkoutProof } from "@dehealth/shared";
import { Provider, Signer, Wallet, parseEther } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEip1193Signer } from "../services/authService";
import { signWorkoutProof } from "../services/cryptoService";
import {
  ARBISCAN_SEPOLIA_BASE_URL,
  claimStreakReward,
  DEFAULT_ARBITRUM_SEPOLIA_FALLBACK_RPC_URLS,
  DEFAULT_INSUFFICIENT_GAS_MESSAGE,
  DEFAULT_RPC_RATE_LIMIT_MESSAGE,
  DEMO_VERIFYING_CONTRACT,
  executeWithRpcResilience,
  fetchLiveL2InspectorStatus,
  fetchNativeEthBalance,
  fetchOnChainNonce,
  fetchTokenBalance,
  formatNativeEthBalance,
  generateSimulatedTxHash,
  getL2Provider,
  getL2RpcUrls,
  getRewardGateAddress,
  getTokenAddress,
  InsufficientGasError,
  isL2Configured,
  isLowGasEthBalance,
  MIN_FALLBACK_GAS_BALANCE_WEI,
  resetL2Config,
  RpcRateLimitError,
  setContractFactory,
  setL2FallbackRpcUrlsForTesting,
  setL2Provider,
  setL2ProviderFactoryForTesting,
  setL2RetryDelayForTesting,
  setRewardGateAddress,
  setTokenAddress,
  ZERO_ADDRESS
} from "../services/l2ContractService";

const TEST_PRIVATE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";
const TEST_PRIVATE_KEY_2 =
  "0x9876543210987654321098765432109876543210987654321098765432109876";

const TEST_GATE_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const TEST_TOKEN_ADDRESS = "0x3333333333333333333333333333333333333333" as Address;

describe("Milestone 3 R4: L2 Contract Service Unit Test Suite", () => {
  const originalEnv = process.env;
  let testWallet: Wallet;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL;
    delete process.env.EXPO_PUBLIC_REWARD_GATE_ADDRESS;
    delete process.env.EXPO_PUBLIC_DHT_TOKEN_ADDRESS;
    resetL2Config();
    testWallet = new Wallet(TEST_PRIVATE_KEY);
  });

  // ============================================================================
  // 1. Configuration & Resolution
  // ============================================================================
  describe("Configuration & Resolution", () => {
    it("reports unconfigured when environment variables are missing", () => {
      expect(isL2Configured()).toBe(false);
      expect(getL2Provider()).toBeNull();
      expect(getRewardGateAddress()).toBeNull();
      expect(getTokenAddress()).toBeNull();
    });

    it("resolves addresses and provider when environment variables are present", () => {
      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL =
        "https://sepolia-rollup.arbitrum.io/rpc";
      process.env.EXPO_PUBLIC_REWARD_GATE_ADDRESS = TEST_GATE_ADDRESS;
      process.env.EXPO_PUBLIC_DHT_TOKEN_ADDRESS = TEST_TOKEN_ADDRESS;

      expect(isL2Configured()).toBe(true);
      expect(getRewardGateAddress()).toBe(TEST_GATE_ADDRESS);
      expect(getTokenAddress()).toBe(TEST_TOKEN_ADDRESS);
      expect(getL2Provider()).not.toBeNull();
    });

    it("allows custom overrides and resetL2Config cleans them", () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);
      setTokenAddress(TEST_TOKEN_ADDRESS);

      expect(isL2Configured()).toBe(true);
      expect(getRewardGateAddress()).toBe(TEST_GATE_ADDRESS);
      expect(getTokenAddress()).toBe(TEST_TOKEN_ADDRESS);

      resetL2Config();
      expect(isL2Configured()).toBe(false);
      expect(getRewardGateAddress()).toBeNull();
      expect(getTokenAddress()).toBeNull();
    });

    it("rejects zero/placeholder addresses (0x000...0) and invalid addresses in getters and isL2Configured (P3-07)", () => {
      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL =
        "https://sepolia-rollup.arbitrum.io/rpc";
      process.env.EXPO_PUBLIC_REWARD_GATE_ADDRESS = ZERO_ADDRESS;
      process.env.EXPO_PUBLIC_DHT_TOKEN_ADDRESS = ZERO_ADDRESS;

      expect(getRewardGateAddress()).toBeNull();
      expect(getTokenAddress()).toBeNull();
      expect(isL2Configured()).toBe(false);

      // Even via programmatic setter, zero address must be rejected
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setRewardGateAddress(ZERO_ADDRESS);
      setTokenAddress("not-an-address" as Address);

      expect(getRewardGateAddress()).toBeNull();
      expect(getTokenAddress()).toBeNull();
      expect(isL2Configured()).toBe(false);
    });
  });

  // ============================================================================
  // 2. On-Chain Nonce Queries
  // ============================================================================
  describe("fetchOnChainNonce", () => {
    it("returns localNonce fallback when unconfigured", async () => {
      const nonce = await fetchOnChainNonce(testWallet.address as Address, 5n);
      expect(nonce).toBe(5n);
    });

    it("returns 0n fallback when localNonce is undefined and unconfigured", async () => {
      const nonce = await fetchOnChainNonce(testWallet.address as Address);
      expect(nonce).toBe(0n);
    });

    it("queries on-chain nonces when configured", async () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const noncesMock = vi.fn().mockResolvedValue(42n);
      setContractFactory(() => ({
        nonces: noncesMock
      }));

      const nonce = await fetchOnChainNonce(testWallet.address as Address, 0n);
      expect(nonce).toBe(42n);
      expect(noncesMock).toHaveBeenCalledWith(testWallet.address);
    });

    it("gracefully falls back to localNonce when on-chain query throws", async () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      setContractFactory(() => ({
        nonces: vi.fn().mockRejectedValue(new Error("Network connection timed out"))
      }));

      const nonce = await fetchOnChainNonce(testWallet.address as Address, 7n);
      expect(nonce).toBe(7n);
    });
  });

  // ============================================================================
  // 3. Token Balance Queries
  // ============================================================================
  describe("fetchTokenBalance", () => {
    it("returns localBalance fallback when unconfigured", async () => {
      const balance = await fetchTokenBalance(testWallet.address as Address, "25.0");
      expect(balance).toBe("25.0");
    });

    it("returns '0.0' when localBalance is undefined and unconfigured", async () => {
      const balance = await fetchTokenBalance(testWallet.address as Address);
      expect(balance).toBe("0.0");
    });

    it("queries on-chain balanceOf and formats as ether string", async () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setTokenAddress(TEST_TOKEN_ADDRESS);

      const balanceOfMock = vi.fn().mockResolvedValue(parseEther("70.5"));
      setContractFactory(() => ({
        balanceOf: balanceOfMock
      }));

      const balance = await fetchTokenBalance(testWallet.address as Address);
      expect(balance).toBe("70.5");
      expect(balanceOfMock).toHaveBeenCalledWith(testWallet.address);
    });

    it("gracefully falls back to localBalance when on-chain query throws", async () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setTokenAddress(TEST_TOKEN_ADDRESS);

      setContractFactory(() => ({
        balanceOf: vi.fn().mockRejectedValue(new Error("RPC node offline"))
      }));

      const balance = await fetchTokenBalance(testWallet.address as Address, "100.0");
      expect(balance).toBe("100.0");
    });
  });

  // ============================================================================
  // 4. Simulated Tx Hash Generation
  // ============================================================================
  describe("generateSimulatedTxHash", () => {
    it("generates deterministic 32-byte hex hash from payload", async () => {
      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as Bytes32,
        streakCount: 3n,
        nonce: 0n,
        deadline: 9999999999n
      };
      const signed = await signWorkoutProof(testWallet, proof, DEMO_VERIFYING_CONTRACT);

      const hash1 = generateSimulatedTxHash(signed);
      const hash2 = generateSimulatedTxHash(signed);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  // ============================================================================
  // 5. claimStreakReward: Fallback Mode
  // ============================================================================
  describe("claimStreakReward - Unconfigured Fallback Mode", () => {
    it("successfully verifies valid signature and returns simulated receipt", async () => {
      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Bytes32,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      const payload = await signWorkoutProof(
        testWallet,
        proof,
        DEMO_VERIFYING_CONTRACT
      );

      const result = await claimStreakReward(payload);
      expect(result.mode).toBe("local-fallback");
      expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.explorerUrl).toBeNull();
    });

    it("falls back cleanly with explorerUrl: null when env holds placeholder 0x000...0 addresses", async () => {
      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL =
        "https://sepolia-rollup.arbitrum.io/rpc";
      process.env.EXPO_PUBLIC_REWARD_GATE_ADDRESS = ZERO_ADDRESS;

      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Bytes32,
        streakCount: 2n,
        nonce: 1n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };
      const payload = await signWorkoutProof(
        testWallet,
        proof,
        DEMO_VERIFYING_CONTRACT
      );

      const result = await claimStreakReward(payload);
      expect(result.mode).toBe("local-fallback");
      expect(result.explorerUrl).toBeNull();
    });
  });

  // ============================================================================
  // 6. claimStreakReward: Live Mode
  // ============================================================================
  describe("claimStreakReward - Live Mode", () => {
    it("dispatches claim to contract, awaits receipt, and returns live mode result", async () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Bytes32,
        streakCount: 5n,
        nonce: 2n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      const payload = await signWorkoutProof(testWallet, proof, TEST_GATE_ADDRESS);

      const mockTxHash =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const claimMock = vi.fn().mockResolvedValue({
        hash: mockTxHash,
        wait: vi.fn().mockResolvedValue({ hash: mockTxHash, status: 1 })
      });

      setContractFactory(() => ({
        claimStreakReward: claimMock
      }));

      const result = await claimStreakReward(payload, testWallet);
      expect(result.mode).toBe("live");
      expect(result.txHash).toBe(mockTxHash);
      expect(result.explorerUrl).toBe(`${ARBISCAN_SEPOLIA_BASE_URL}/${mockTxHash}`);
      expect(claimMock).toHaveBeenCalled();
    });

    it("re-throws contract revert errors on-chain in live mode to fail closed", async () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Bytes32,
        streakCount: 2n,
        nonce: 1n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      const payload = await signWorkoutProof(testWallet, proof, TEST_GATE_ADDRESS);

      setContractFactory(() => ({
        claimStreakReward: vi.fn().mockRejectedValue(
          new Error("execution reverted: SignatureReplay")
        )
      }));

      await expect(claimStreakReward(payload, testWallet)).rejects.toThrow(
        "SignatureReplay"
      );
    });

    it("throws an explicit error when L2 is configured without a valid signer instead of silently simulating (P3-02)", async () => {
      const mockProvider = {} as unknown as ReturnType<typeof getL2Provider>;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Bytes32,
        streakCount: 3n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      const payload = await signWorkoutProof(testWallet, proof, TEST_GATE_ADDRESS);

      await expect(claimStreakReward(payload)).rejects.toThrow(
        "L2 contract submission requires a valid signer when Arbitrum Sepolia is configured."
      );
      await expect(
        claimStreakReward(payload, {} as unknown as Signer)
      ).rejects.toThrow(
        "L2 contract submission requires a valid signer when Arbitrum Sepolia is configured."
      );
      const signOnlySigner = {
        getAddress: async () => testWallet.address,
        signTypedData: async () => "0x"
      } as unknown as Signer;
      await expect(claimStreakReward(payload, signOnlySigner)).rejects.toThrow(
        "L2 contract submission requires a valid signer when Arbitrum Sepolia is configured."
      );
    });
  });

  // ============================================================================
  // 7. Cryptographic Fail-Closed Security (Invalid Signatures)
  // ============================================================================
  describe("Cryptographic Fail-Closed Rejection", () => {
    it("rejects forged signature where user does not match signer", async () => {
      const attackerWallet = new Wallet(TEST_PRIVATE_KEY_2);
      const proof: WorkoutProof = {
        user: testWallet.address as Address, // User is victim
        telemetryHash:
          "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Bytes32,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      // Attacker signs for victim
      const payload = await signWorkoutProof(
        attackerWallet,
        proof,
        DEMO_VERIFYING_CONTRACT
      );

      await expect(claimStreakReward(payload)).rejects.toThrow(
        "Local EIP-712 signature verification failed"
      );
    });

    it("rejects tampered telemetryHash after signature generation", async () => {
      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Bytes32,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      const payload = await signWorkoutProof(
        testWallet,
        proof,
        DEMO_VERIFYING_CONTRACT
      );

      // Tamper with telemetryHash
      const tamperedPayload: SignedWorkoutClaimPayload = {
        proof: {
          ...payload.proof,
          telemetryHash:
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Bytes32
        },
        signature: payload.signature
      };

      await expect(claimStreakReward(tamperedPayload)).rejects.toThrow(
        "Local EIP-712 signature verification failed"
      );
    });

    it("rejects tampered streak count after signature generation", async () => {
      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0x1212121212121212121212121212121212121212121212121212121212121212" as Bytes32,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };

      const payload = await signWorkoutProof(
        testWallet,
        proof,
        DEMO_VERIFYING_CONTRACT
      );

      // Tamper with streakCount
      const tamperedPayload: SignedWorkoutClaimPayload = {
        proof: {
          ...payload.proof,
          streakCount: 99n
        },
        signature: payload.signature
      };

      await expect(claimStreakReward(tamperedPayload)).rejects.toThrow(
        "Local EIP-712 signature verification failed"
      );
    });
  });

  // ============================================================================
  // 8. claimStreakReward: Gas & Balance Pre-Check (R1 / #6)
  // ============================================================================
  describe("claimStreakReward - Gas & Balance Pre-Check", () => {
    async function makeLiveSignedPayload(nonce = 4n): Promise<SignedWorkoutClaimPayload> {
      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0x2424242424242424242424242424242424242424242424242424242424242424" as Bytes32,
        streakCount: 6n,
        nonce,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };
      return signWorkoutProof(testWallet, proof, TEST_GATE_ADDRESS);
    }

    it("rejects with InsufficientGasError before broadcast when balance is 0 ETH or < 0.0001 ETH", async () => {
      expect(MIN_FALLBACK_GAS_BALANCE_WEI).toBe(parseEther("0.0001"));

      for (const lowBalance of [0n, parseEther("0.00009")]) {
        const mockProvider = {
          getBalance: vi.fn().mockResolvedValue(lowBalance)
        } as unknown as Provider;
        setL2Provider(mockProvider);
        setRewardGateAddress(TEST_GATE_ADDRESS);

        const claimMock = vi.fn();
        setContractFactory(() => ({
          claimStreakReward: claimMock
        }));

        const payload = await makeLiveSignedPayload(10n);

        let caught: unknown;
        try {
          await claimStreakReward(payload, testWallet);
        } catch (err: unknown) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(InsufficientGasError);
        const gasErr = caught as InsufficientGasError;
        expect(gasErr.name).toBe("InsufficientGasError");
        expect(gasErr.message).toBe(DEFAULT_INSUFFICIENT_GAS_MESSAGE);
        expect(gasErr.signerAddress).toBe(testWallet.address);
        expect(gasErr.balanceWei).toBe(lowBalance);
        expect(gasErr.requiredWei).toBe(MIN_FALLBACK_GAS_BALANCE_WEI);
        expect(claimMock).not.toHaveBeenCalled();
      }
    });

    it("rejects with InsufficientGasError when balance >= 0.0001 ETH but < estimateGas * maxFeePerGas", async () => {
      const balanceWei = parseEther("0.00015");
      const mockProvider = {
        getBalance: vi.fn().mockResolvedValue(balanceWei),
        getFeeData: vi.fn().mockResolvedValue({
          maxFeePerGas: 1_000_000_000n,
          gasPrice: 500_000_000n
        })
      } as unknown as Provider;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const claimFn = Object.assign(vi.fn(), {
        estimateGas: vi.fn().mockResolvedValue(200_000n)
      });
      setContractFactory(() => ({
        claimStreakReward: claimFn
      }));

      const payload = await makeLiveSignedPayload(11n);

      let caught: unknown;
      try {
        await claimStreakReward(payload, testWallet);
      } catch (err: unknown) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(InsufficientGasError);
      const gasErr = caught as InsufficientGasError;
      expect(gasErr.signerAddress).toBe(testWallet.address);
      expect(gasErr.balanceWei).toBe(balanceWei);
      expect(gasErr.requiredWei).toBe(parseEther("0.0002"));
      expect(claimFn).not.toHaveBeenCalled();
    });

    it("uses legacy gasPrice when maxFeePerGas is null and rejects if balance < estimateGas * gasPrice", async () => {
      const balanceWei = parseEther("0.00012");
      const mockProvider = {
        getBalance: vi.fn().mockResolvedValue(balanceWei),
        getFeeData: vi.fn().mockResolvedValue({
          maxFeePerGas: null,
          gasPrice: 1_000_000_000n
        })
      } as unknown as Provider;
      setL2Provider(mockProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const claimFn = Object.assign(vi.fn(), {
        estimateGas: vi.fn().mockResolvedValue(180_000n)
      });
      setContractFactory(() => ({
        claimStreakReward: claimFn
      }));

      const payload = await makeLiveSignedPayload(12n);

      let caught: unknown;
      try {
        await claimStreakReward(payload, testWallet);
      } catch (err: unknown) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(InsufficientGasError);
      const gasErr = caught as InsufficientGasError;
      expect(gasErr.balanceWei).toBe(balanceWei);
      expect(gasErr.requiredWei).toBe(parseEther("0.00018"));
      expect(claimFn).not.toHaveBeenCalled();
    });

    it("passes at exact 0.0001 ETH boundary both with affordable estimateGas and without estimateGas", async () => {
      const mockTxHash =
        "0x9999999999999999999999999999999999999999999999999999999999999999";

      // Case 1: With estimateGas returning cost <= 0.0001 ETH
      const providerWithEstimate = {
        getBalance: vi.fn().mockResolvedValue(MIN_FALLBACK_GAS_BALANCE_WEI),
        getFeeData: vi.fn().mockResolvedValue({
          maxFeePerGas: 500_000_000n,
          gasPrice: 500_000_000n
        })
      } as unknown as Provider;
      setL2Provider(providerWithEstimate);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const claimWithEstimate = Object.assign(
        vi.fn().mockResolvedValue({
          hash: mockTxHash,
          wait: vi.fn().mockResolvedValue({ hash: mockTxHash, status: 1 })
        }),
        {
          estimateGas: vi.fn().mockResolvedValue(100_000n) // 0.00005 ETH
        }
      );
      setContractFactory(() => ({
        claimStreakReward: claimWithEstimate
      }));

      const payload1 = await makeLiveSignedPayload(13n);
      const result1 = await claimStreakReward(payload1, testWallet);
      expect(result1.mode).toBe("live");
      expect(result1.txHash).toBe(mockTxHash);
      expect(result1.explorerUrl).toBe(`${ARBISCAN_SEPOLIA_BASE_URL}/${mockTxHash}`);
      expect(claimWithEstimate).toHaveBeenCalledTimes(1);

      // Case 2: Without estimateGas at exact 0.0001 ETH
      const providerFallbackOnly = {
        getBalance: vi.fn().mockResolvedValue(MIN_FALLBACK_GAS_BALANCE_WEI)
      } as unknown as Provider;
      setL2Provider(providerFallbackOnly);

      const plainClaimMock = vi.fn().mockResolvedValue({
        hash: mockTxHash,
        wait: vi.fn().mockResolvedValue({ hash: mockTxHash, status: 1 })
      });
      setContractFactory(() => ({
        claimStreakReward: plainClaimMock
      }));

      const payload2 = await makeLiveSignedPayload(14n);
      const result2 = await claimStreakReward(payload2, testWallet);
      expect(result2.mode).toBe("live");
      expect(plainClaimMock).toHaveBeenCalledTimes(1);
    });

    it("handles estimateGas failures: rejects low balance or INSUFFICIENT_FUNDS, falls back on transient RPC error, and preserves contract reverts", async () => {
      const mockTxHash =
        "0xabababababababababababababababababababababababababababababababab";

      // Subcase A: low balance (< 0.0001 ETH) + generic estimateGas timeout -> InsufficientGasError
      setL2Provider({
        getBalance: vi.fn().mockResolvedValue(parseEther("0.00005"))
      } as unknown as Provider);
      setRewardGateAddress(TEST_GATE_ADDRESS);
      const claimLow = Object.assign(vi.fn(), {
        estimateGas: vi.fn().mockRejectedValue(new Error("RPC estimateGas timeout"))
      });
      setContractFactory(() => ({ claimStreakReward: claimLow }));
      await expect(
        claimStreakReward(await makeLiveSignedPayload(15n), testWallet)
      ).rejects.toBeInstanceOf(InsufficientGasError);
      expect(claimLow).not.toHaveBeenCalled();

      // Subcase B: sufficient balance (>= 0.0001 ETH) + generic estimateGas error -> fallback passes
      setL2Provider({
        getBalance: vi.fn().mockResolvedValue(parseEther("0.0001"))
      } as unknown as Provider);
      const claimFallback = Object.assign(
        vi.fn().mockResolvedValue({
          hash: mockTxHash,
          wait: vi.fn().mockResolvedValue({ hash: mockTxHash, status: 1 })
        }),
        {
          estimateGas: vi.fn().mockRejectedValue(new Error("RPC estimateGas unsupported"))
        }
      );
      setContractFactory(() => ({ claimStreakReward: claimFallback }));
      const resB = await claimStreakReward(await makeLiveSignedPayload(16n), testWallet);
      expect(resB.mode).toBe("live");
      expect(claimFallback).toHaveBeenCalledTimes(1);

      // Subcase C: sufficient balance (>= 0.0001 ETH) + estimateGas insufficient funds -> InsufficientGasError
      setL2Provider({
        getBalance: vi.fn().mockResolvedValue(parseEther("0.0002"))
      } as unknown as Provider);
      const claimInsufficientMsg = Object.assign(vi.fn(), {
        estimateGas: vi
          .fn()
          .mockRejectedValue(new Error("insufficient funds for gas * price + value"))
      });
      setContractFactory(() => ({ claimStreakReward: claimInsufficientMsg }));
      let errC: unknown;
      try {
        await claimStreakReward(await makeLiveSignedPayload(17n), testWallet);
      } catch (err: unknown) {
        errC = err;
      }
      expect(errC).toBeInstanceOf(InsufficientGasError);
      expect((errC as InsufficientGasError).requiredWei).toBeUndefined();
      expect(claimInsufficientMsg).not.toHaveBeenCalled();

      // Subcase D: balance = 1 ETH + estimateGas contract revert -> surfaces genuine revert
      setL2Provider({
        getBalance: vi.fn().mockResolvedValue(parseEther("1.0"))
      } as unknown as Provider);
      const revertErr = new Error("execution reverted: SignatureReplay");
      const claimRevert = Object.assign(vi.fn().mockRejectedValue(revertErr), {
        estimateGas: vi.fn().mockRejectedValue(revertErr)
      });
      setContractFactory(() => ({ claimStreakReward: claimRevert }));
      await expect(
        claimStreakReward(await makeLiveSignedPayload(18n), testWallet)
      ).rejects.toThrow("SignatureReplay");
    });

    it("bypasses gas check in local-fallback mode and remains compatible with {} mock providers", async () => {
      // local-fallback mode (unconfigured)
      resetL2Config();
      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0x3434343434343434343434343434343434343434343434343434343434343434" as Bytes32,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };
      const fallbackPayload = await signWorkoutProof(
        testWallet,
        proof,
        DEMO_VERIFYING_CONTRACT
      );
      const fallbackRes = await claimStreakReward(fallbackPayload, testWallet);
      expect(fallbackRes.mode).toBe("local-fallback");
      expect(fallbackRes.explorerUrl).toBeNull();

      // {} mock provider without getBalance or estimateGas
      setL2Provider({} as unknown as Provider);
      setRewardGateAddress(TEST_GATE_ADDRESS);
      const mockTxHash =
        "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
      const claimMock = vi.fn().mockResolvedValue({
        hash: mockTxHash,
        wait: vi.fn().mockResolvedValue({ hash: mockTxHash, status: 1 })
      });
      setContractFactory(() => ({ claimStreakReward: claimMock }));
      const liveRes = await claimStreakReward(
        await makeLiveSignedPayload(19n),
        testWallet
      );
      expect(liveRes.mode).toBe("live");
      expect(claimMock).toHaveBeenCalledTimes(1);
    });

    it("submits live claimStreakReward through real ethers Contract using an external EIP-1193 signer eth_sendTransaction", async () => {
      const externalWallet = new Wallet(TEST_PRIVATE_KEY);
      const expectedTxHash =
        "0xfeed1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
      const sentRpcPayloads: Array<{
        readonly method: string;
        readonly params?: readonly unknown[];
      }> = [];

      const eip1193Signer = createEip1193Signer(
        externalWallet.address as Address,
        {
          request: async ({ method, params }) => {
            if (method === "eth_signTypedData_v4") {
              const jsonPayload = params?.[1];
              if (typeof jsonPayload !== "string") {
                throw new Error("Missing typed data payload");
              }
              const parsed = JSON.parse(jsonPayload) as {
                readonly domain: Record<string, unknown>;
                readonly types: Record<string, Array<{ name: string; type: string }>>;
                readonly message: Record<string, unknown>;
              };
              const typesWithoutDomain: Record<
                string,
                Array<{ name: string; type: string }>
              > = {};
              for (const [key, fields] of Object.entries(parsed.types)) {
                if (key !== "EIP712Domain") {
                  typesWithoutDomain[key] = fields;
                }
              }
              return externalWallet.signTypedData(
                parsed.domain,
                typesWithoutDomain,
                parsed.message
              );
            }
            if (method === "eth_sendTransaction") {
              sentRpcPayloads.push({ method, params });
              return expectedTxHash;
            }
            throw new Error(`Unsupported RPC method: ${method}`);
          }
        }
      );

      const proof: WorkoutProof = {
        user: externalWallet.address as Address,
        telemetryHash:
          "0xabababababababababababababababababababababababababababababababab" as Bytes32,
        streakCount: 6n,
        nonce: 3n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };
      const signedPayload = await signWorkoutProof(
        eip1193Signer,
        proof,
        TEST_GATE_ADDRESS
      );

      const waitForTransactionMock = vi.fn().mockResolvedValue({
        hash: expectedTxHash,
        status: 1
      });
      const getTransactionReceiptMock = vi.fn().mockResolvedValue({
        to: TEST_GATE_ADDRESS,
        from: externalWallet.address,
        contractAddress: null,
        hash: expectedTxHash,
        index: 0,
        blockHash: "0x" + "11".repeat(32),
        blockNumber: 12345,
        logsBloom: "0x" + "00".repeat(256),
        gasUsed: 85_000n,
        cumulativeGasUsed: 85_000n,
        blobGasUsed: null,
        gasPrice: 150_000_000n,
        blobGasPrice: null,
        type: 2,
        status: 1,
        root: null,
        logs: []
      });
      const rpcProvider = {
        getNetwork: vi.fn().mockResolvedValue({ chainId: 421614n }),
        getBalance: vi.fn().mockResolvedValue(10_000_000_000_000_000n),
        estimateGas: vi.fn().mockResolvedValue(90_000n),
        getFeeData: vi.fn().mockResolvedValue({
          maxFeePerGas: 150_000_000n,
          maxPriorityFeePerGas: 10_000_000n,
          gasPrice: 150_000_000n
        }),
        getTransactionReceipt: getTransactionReceiptMock,
        waitForTransaction: waitForTransactionMock,
        resolveName: vi.fn().mockResolvedValue(null)
      } as unknown as Provider;

      setL2Provider(rpcProvider);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const res = await claimStreakReward(signedPayload, eip1193Signer);
      expect(res.mode).toBe("live");
      expect(res.txHash).toBe(expectedTxHash);
      expect(res.explorerUrl).toBe(`${ARBISCAN_SEPOLIA_BASE_URL}/${expectedTxHash}`);
      expect(sentRpcPayloads).toHaveLength(1);
      expect(sentRpcPayloads[0]?.method).toBe("eth_sendTransaction");
      const firstParam = (sentRpcPayloads[0]?.params?.[0] ?? {}) as Record<
        string,
        unknown
      >;
      expect(String(firstParam.from).toLowerCase()).toBe(
        externalWallet.address.toLowerCase()
      );
      expect(String(firstParam.to).toLowerCase()).toBe(
        TEST_GATE_ADDRESS.toLowerCase()
      );
      expect(typeof firstParam.data).toBe("string");
      expect(String(firstParam.data)).toMatch(/^0x/);
      expect(getTransactionReceiptMock).toHaveBeenCalledWith(expectedTxHash);
    });
  });

  // ============================================================================
  // 7. RPC Resilience: Backoff Retry & Multi-RPC Failover
  // ============================================================================
  describe("RPC Resilience: Backoff Retry & Multi-RPC Failover", () => {
    it("retries with exponential backoff (200ms, 400ms) on HTTP 429 and recovers on retry", async () => {
      const recordedDelays: number[] = [];
      setL2RetryDelayForTesting(async (ms: number) => {
        recordedDelays.push(ms);
      });

      const primaryUrl = "https://primary.rpc.example";
      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL = primaryUrl;
      setL2FallbackRpcUrlsForTesting([]);
      setL2ProviderFactoryForTesting((rpcUrl) => ({ rpcUrl } as unknown as Provider));
      setRewardGateAddress(TEST_GATE_ADDRESS);

      let callCount = 0;
      setContractFactory(() => ({
        nonces: vi.fn().mockImplementation(async () => {
          callCount += 1;
          if (callCount <= 2) {
            throw { status: 429, message: "429 Too Many Requests" };
          }
          return 11n;
        })
      }));

      const nonce = await fetchOnChainNonce(testWallet.address as Address, 0n);
      expect(nonce).toBe(11n);
      expect(callCount).toBe(3);
      expect(recordedDelays).toEqual([200, 400]);
    });

    it("fails over from primary RPC to DEFAULT_ARBITRUM_SEPOLIA_FALLBACK_RPC_URLS and sticks to the healthy endpoint", async () => {
      const recordedDelays: number[] = [];
      setL2RetryDelayForTesting(async (ms: number) => {
        recordedDelays.push(ms);
      });

      const primaryUrl = "https://primary-throttled.rpc.example";
      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL = primaryUrl;

      const rpcUrls = getL2RpcUrls();
      expect(rpcUrls[0]).toBe(primaryUrl);
      expect(rpcUrls.slice(1)).toEqual([...DEFAULT_ARBITRUM_SEPOLIA_FALLBACK_RPC_URLS]);
      expect(rpcUrls.some((url) => url.includes("publicnode"))).toBe(true);
      expect(rpcUrls.some((url) => url.includes("drpc"))).toBe(true);
      expect(rpcUrls.some((url) => url.includes("sepolia-rollup.arbitrum.io/rpc"))).toBe(true);

      const endpointCalls: string[] = [];
      setL2ProviderFactoryForTesting(
        (rpcUrl) =>
          ({
            rpcUrl,
            getTransactionCount: vi.fn().mockImplementation(async () => {
              endpointCalls.push(rpcUrl);
              if (rpcUrl === primaryUrl) {
                throw new Error("HTTP 429 Too Many Requests");
              }
              return 9;
            })
          }) as unknown as Provider
      );

      // First call: primary fails 3 times (initial + 2 retries), then fails over to publicnode
      const firstStatus = await fetchLiveL2InspectorStatus(
        testWallet.address as Address
      );
      expect(firstStatus.rpcReachable).toBe(true);
      expect(firstStatus.liveNonce).toBe(9n);
      expect(endpointCalls).toEqual([
        primaryUrl,
        primaryUrl,
        primaryUrl,
        DEFAULT_ARBITRUM_SEPOLIA_FALLBACK_RPC_URLS[0]
      ]);
      expect(recordedDelays).toEqual([200, 400]);

      // Second call: sticky activeRpcIndex starts directly on publicnode
      endpointCalls.length = 0;
      const secondStatus = await fetchLiveL2InspectorStatus(
        testWallet.address as Address
      );
      expect(secondStatus.rpcReachable).toBe(true);
      expect(secondStatus.liveNonce).toBe(9n);
      expect(endpointCalls).toEqual([
        DEFAULT_ARBITRUM_SEPOLIA_FALLBACK_RPC_URLS[0]
      ]);
    });

    it("throws RpcRateLimitError when all endpoints exhaust retries, and fails immediately on non-429 or InsufficientGasError", async () => {
      const recordedDelays: number[] = [];
      setL2RetryDelayForTesting(async (ms: number) => {
        recordedDelays.push(ms);
      });

      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL = "https://primary.rpc.example";
      setL2FallbackRpcUrlsForTesting(["https://fallback.rpc.example"]);
      setL2ProviderFactoryForTesting((rpcUrl) => ({ rpcUrl } as unknown as Provider));

      let attempts = 0;
      let caughtError: unknown = null;
      try {
        await executeWithRpcResilience(async () => {
          attempts += 1;
          throw { status: 429 };
        });
      } catch (err: unknown) {
        caughtError = err;
      }
      expect(caughtError).toBeInstanceOf(RpcRateLimitError);
      expect((caughtError as RpcRateLimitError).message).toBe(
        DEFAULT_RPC_RATE_LIMIT_MESSAGE
      );
      expect(attempts).toBe(6); // 2 endpoints * (1 initial + 2 retries)
      expect(recordedDelays).toEqual([200, 400, 200, 400]);

      // Non-429 error fails immediately without retrying
      recordedDelays.length = 0;
      let non429Attempts = 0;
      await expect(
        executeWithRpcResilience(async () => {
          non429Attempts += 1;
          throw new Error("execution reverted");
        })
      ).rejects.toThrow("execution reverted");
      expect(non429Attempts).toBe(1);
      expect(recordedDelays).toEqual([]);

      // InsufficientGasError fails immediately without retrying
      let gasAttempts = 0;
      await expect(
        executeWithRpcResilience(async () => {
          gasAttempts += 1;
          throw new InsufficientGasError(DEFAULT_INSUFFICIENT_GAS_MESSAGE, {
            signerAddress: testWallet.address as Address,
            balanceWei: 0n,
            requiredWei: MIN_FALLBACK_GAS_BALANCE_WEI
          });
        })
      ).rejects.toThrowError(InsufficientGasError);
      expect(gasAttempts).toBe(1);
      expect(recordedDelays).toEqual([]);
    });

    it("claimStreakReward retries tx.wait() on 429 without re-invoking gateContract.claimStreakReward, and retries 429 during estimateGas", async () => {
      const recordedDelays: number[] = [];
      setL2RetryDelayForTesting(async (ms: number) => {
        recordedDelays.push(ms);
      });

      const primaryUrl = "https://primary-claim.rpc.example";
      const fallbackUrl = "https://fallback-claim.rpc.example";
      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL = primaryUrl;
      setL2FallbackRpcUrlsForTesting([fallbackUrl]);
      setRewardGateAddress(TEST_GATE_ADDRESS);

      const mockTxHash =
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      let waitCalls = 0;
      const waitMock = vi.fn().mockImplementation(async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          throw {
            info: { responseStatus: "429 Too Many Requests" },
            message: "429 Too Many Requests"
          };
        }
        return { hash: mockTxHash, status: 1 };
      });

      const claimMock = vi.fn().mockResolvedValue({
        hash: mockTxHash,
        wait: waitMock
      }) as unknown as {
        (...args: unknown[]): Promise<{ hash: string; wait: typeof waitMock }>;
        estimateGas: ReturnType<typeof vi.fn>;
      };

      let estimateCalls = 0;
      claimMock.estimateGas = vi.fn().mockImplementation(async () => {
        estimateCalls += 1;
        if (estimateCalls === 1) {
          throw { status: 429, message: "429 Too Many Requests" };
        }
        return 100_000n;
      });

      setL2ProviderFactoryForTesting(
        (rpcUrl) =>
          ({
            rpcUrl,
            getBalance: vi.fn().mockResolvedValue(parseEther("0.05")),
            getFeeData: vi.fn().mockResolvedValue({
              maxFeePerGas: 100_000_000n,
              gasPrice: 100_000_000n
            })
          }) as unknown as Provider
      );
      setContractFactory(() => ({
        claimStreakReward: claimMock
      }));

      const proof: WorkoutProof = {
        user: testWallet.address as Address,
        telemetryHash:
          "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Bytes32,
        streakCount: 7n,
        nonce: 4n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      };
      const payload = await signWorkoutProof(testWallet, proof, TEST_GATE_ADDRESS);

      const result = await claimStreakReward(payload, testWallet);
      expect(result.mode).toBe("live");
      expect(result.txHash).toBe(mockTxHash);
      expect(result.explorerUrl).toBe(`${ARBISCAN_SEPOLIA_BASE_URL}/${mockTxHash}`);
      expect(estimateCalls).toBe(2);
      expect(claimMock).toHaveBeenCalledTimes(1);
      expect(waitMock).toHaveBeenCalledTimes(2);
      expect(recordedDelays).toEqual([200, 200]);
    });

    it("fetchNativeEthBalance formats live ETH balances with RPC 429 failover and evaluates low-gas thresholds", async () => {
      const testWallet = new Wallet(TEST_PRIVATE_KEY);
      expect(formatNativeEthBalance(0n)).toBe("0.0000");
      expect(formatNativeEthBalance(parseEther("0.01234"))).toBe("0.0123");
      expect(formatNativeEthBalance(parseEther("0.000025"))).toBe("0.000025");

      expect(isLowGasEthBalance("0.00005")).toBe(true);
      expect(isLowGasEthBalance("0.0000")).toBe(true);
      expect(isLowGasEthBalance("0.0001")).toBe(false);
      expect(isLowGasEthBalance("0.0250")).toBe(false);
      expect(isLowGasEthBalance(null)).toBe(false);

      // Unconfigured provider falls back cleanly
      expect(
        await fetchNativeEthBalance(testWallet.address as Address, "0.0000")
      ).toBe("0.0000");

      setL2RetryDelayForTesting(async () => undefined);
      const primaryUrl = "https://primary-eth.rpc.example";
      const fallbackUrl = "https://fallback-eth.rpc.example";
      process.env.EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL = primaryUrl;
      setL2FallbackRpcUrlsForTesting([fallbackUrl]);

      setL2ProviderFactoryForTesting((rpcUrl) => ({
        getBalance: vi.fn().mockImplementation(async () => {
          if (rpcUrl === primaryUrl) {
            throw { status: 429, message: "Too Many Requests" };
          }
          return parseEther("0.0425");
        })
      }) as unknown as Provider);

      const liveEth = await fetchNativeEthBalance(testWallet.address as Address);
      expect(liveEth).toBe("0.0425");
    });
  });
});
