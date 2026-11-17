import { Address, Bytes32, SignedWorkoutClaimPayload, WorkoutProof } from "@dehealth/shared";
import { Signer, Wallet, parseEther } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signWorkoutProof } from "../services/cryptoService";
import {
  ARBISCAN_SEPOLIA_BASE_URL,
  claimStreakReward,
  DEMO_VERIFYING_CONTRACT,
  fetchOnChainNonce,
  fetchTokenBalance,
  generateSimulatedTxHash,
  getL2Provider,
  getRewardGateAddress,
  getTokenAddress,
  isL2Configured,
  resetL2Config,
  setContractFactory,
  setL2Provider,
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
});
